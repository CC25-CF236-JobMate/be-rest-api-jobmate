const functions = require("firebase-functions");
const admin     = require("firebase-admin");
// Import FieldValue from the modular Firestore SDK
const { FieldValue } = require("firebase-admin/firestore");
const express   = require("express");
const cors      = require("cors");// pastikan path benar
const { Storage } = require("@google-cloud/storage");
const storage = new Storage();
const bucket = storage.bucket("gs://capstone-jobseeker-dd654.firebasestorage.app");
const multer = require("multer");


admin.initializeApp({
    credential: admin.credential.applicationDefault()
});

const db = admin.firestore();
const app = express();
// Agar kita bisa terima JSON body
app.use(cors({ origin: true }));
app.use(express.json());


const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // Maksimal 5MB
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg'];
    if (!allowedTypes.includes(file.mimetype)) {
      return cb(new Error('Only JPG, JPEG, and PNG images are allowed.'));
    }
    cb(null, true);
  }
});

const authenticate = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).send("Unauthorized: No token provided");
    }

    const idToken = authHeader.split("Bearer ")[1];

    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        req.user = decodedToken;
        next();
    } catch (error) {
        return res.status(401).send("Unauthorized: Invalid token");
    }
};
// Semua route di bawah ini harus authenticated
app.use(authenticate);

/**
 * GET /profile
 * Mengambil data profile user yang sedang login
 */
app.get("/profile", async (req, res) => {
  try {
    const uid = req.user.uid;
    // Akses sub-koleksi 'user_personal/info' untuk mendapatkan data pengguna
    const snap = await db.collection("users").doc(uid).collection("user_personal").doc("info").get();
    
    if (!snap.exists) {
      return res.status(404).json({ error: "Profile not found" });
    }

    // Kirim data profil
    res.json({ uid, ...snap.data() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

app.patch("/profile", async (req, res) => {
  try {
    const uid = req.user.uid;
    const data = {};

    // Handle regular fields
    ["fullName", "phoneNumber", "city", "linkedin", "github", "instagram", "portfolioSite"].forEach((field) => {
      if (req.body[field] !== undefined) {
        data[field] = req.body[field];
      }
    });

    // Handle base64 photo if exists (save as photoUrl)
    if (req.body.photoUrl) {
      // Validate base64 image format
      const matches = req.body.photoUrl.match(/^data:image\/([a-zA-Z]+);base64,(.+)$/);
      if (!matches || matches.length !== 3) {
        return res.status(400).json({ error: "Invalid base64 image format" });
      }

      const imageType = matches[1]; // jpeg, png, etc.
      const base64Data = matches[2]; // data after prefix
      const imageBuffer = Buffer.from(base64Data, "base64");

      // Validate file size (max 5MB)
      if (imageBuffer.length > 5 * 1024 * 1024) {
        return res.status(400).json({ error: "Image too large (max 5MB)" });
      }

      const fileName = `profile-photos/${uid}-${Date.now()}.${imageType}`;
      const file = bucket.file(fileName);

      // Upload to Firebase Storage
      await file.save(imageBuffer, {
        metadata: {
          contentType: `image/${imageType}`,
        },
        public: true,
      });

      // Get public URL
      const publicUrl = `https://storage.googleapis.com/${bucket.name}/${encodeURIComponent(fileName)}`;
      data.photoUrl = publicUrl;

      // Delete old photo if exists
      const userDoc = await db
        .collection("users")
        .doc(uid)
        .collection("user_personal")
        .doc("info")
        .get();

      if (userDoc.exists && userDoc.data().photoUrl) {
        try {
          const oldPhotoUrl = userDoc.data().photoUrl;
          const oldFilePath = decodeURIComponent(oldPhotoUrl.split("/o/")[1].split("?")[0]);
          await bucket.file(oldFilePath).delete();
        } catch (err) {
          console.error("Error deleting old photo:", err);
          // Don't stop process if delete fails
        }
      }
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    // Update subcollection user_personal/info
    await db.collection("users").doc(uid).collection("user_personal").doc("info").update(data);

    res.json({
      message: "Profile updated successfully",
      updatedFields: Object.keys(data),
      photoUrl: data.photoUrl || null,
    });
  } catch (err) {
    console.error("Error updating profile:", err);
    res.status(500).json({
      error: "Failed to update profile",
      details: err.message,
    });
  }
});


app.post("/education", async (req, res) => {
  try {
    const uid = req.user.uid;
    const { level, institution, major, startDate, endDate, gpa } = req.body;

    // Validasi input wajib
    if (!level || !institution || !major || !startDate) {
      return res.status(400).json({ error: "Missing required fields (level, institution, major, startDate)" });
    }

    // Validasi format date (YYYY-MM-DD)
    const isValidStartDate = /^\d{4}-\d{2}-\d{2}$/.test(startDate);
    if (!isValidStartDate) {
      return res.status(400).json({ error: "Invalid startDate format. Use YYYY-MM-DD" });
    }

    const isValidEndDate = endDate ? /^\d{4}-\d{2}-\d{2}$/.test(endDate) : true;
    if (endDate && !isValidEndDate) {
      return res.status(400).json({ error: "Invalid endDate format. Use YYYY-MM-DD" });
    }

    // Data pendidikan yang akan disimpan
    const educationData = {
      level,
      institution,
      major,
      startDate,  // Menyimpan sebagai string
      endDate,    // Menyimpan sebagai string (null jika belum selesai)
      gpa: gpa || null,
      createdAt: FieldValue.serverTimestamp(),  // Tetap simpan createdAt dengan server timestamp
    };

    // Tambah data pendidikan ke sub-koleksi education
    const educationRef = db.collection("users").doc(uid).collection("education");
    const newDoc = await educationRef.add(educationData);

    // Response sukses
    res.status(201).json({
      id: newDoc.id,
      message: "Education added successfully",
      education: educationData,
    });

  } catch (err) {
    console.error("Error adding education:", err);
    res.status(500).json({ error: "Failed to add education", details: err.message });
  }
});

app.patch("/education/:id", async (req, res) => {
  try {
    const uid = req.user.uid;
    const { level, institution, major, startDate, endDate, gpa } = req.body;
    const educationId = req.params.id;

    // Fetch the document from the Firestore collection
    const educationRef = db.collection("users").doc(uid).collection("education").doc(educationId);
    const educationDoc = await educationRef.get();

    if (!educationDoc.exists) {
      return res.status(404).json({ error: "Education document not found" });
    }

    // Prepare data to update
    const updateData = {};
    if (level) updateData.level = level;
    if (institution) updateData.institution = institution;
    if (major) updateData.major = major;
    if (startDate) updateData.startDate = startDate;
    if (endDate) updateData.endDate = endDate;
    if (gpa) updateData.gpa = gpa;

    updateData.updatedAt = FieldValue.serverTimestamp(); // Add updated timestamp

    // Update the document in Firestore
    await educationRef.update(updateData);

    res.status(200).json({
      message: "Education updated successfully",
      updatedFields: updateData
    });
  } catch (err) {
    console.error("Error updating education:", err);
    res.status(500).json({ error: "Failed to update education", details: err.message });
  }
});

app.get("/education", async (req, res) => {
  try {
    const uid = req.user.uid;

    const educationRef = db.collection("users").doc(uid).collection("education");
    const snapshot = await educationRef.orderBy("startDate", "desc").get();

    if (snapshot.empty) {
      return res.status(200).json({ education: [] }); // Jika tidak ada data pendidikan
    }

    // Mapping data ke array
    const educationList = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.status(200).json({ education: educationList });

  } catch (err) {
    console.error("Error getting education:", err);
    res.status(500).json({ error: "Failed to get education", details: err.message });
  }
});


app.post("/experience", async (req, res) => {
  try {
    const uid = req.user.uid;
    const { position, company, description, employmentType, startDate, endDate } = req.body;

    // Validasi input wajib
    if (!position || !company || !description || !employmentType || !startDate) {
      return res.status(400).json({ error: "Missing required fields (position, company, description, employmentType, startDate)" });
    }

    // Validasi jenis pekerjaan
    const validEmploymentTypes = ['full-time', 'part-time', 'freelance', 'internship'];
    if (!validEmploymentTypes.includes(employmentType)) {
      return res.status(400).json({ error: "Invalid employmentType. Valid options are: full-time, part-time, freelance, internship" });
    }

    // Pastikan startDate dan endDate memiliki format yang benar
    const isValidStartDate = /^\d{4}-\d{2}-\d{2}$/.test(startDate);
    if (!isValidStartDate) {
      return res.status(400).json({ error: "Invalid startDate format. Use YYYY-MM-DD" });
    }

    const isValidEndDate = endDate ? /^\d{4}-\d{2}-\d{2}$/.test(endDate) : true;
    if (endDate && !isValidEndDate) {
      return res.status(400).json({ error: "Invalid endDate format. Use YYYY-MM-DD" });
    }

    // Data pengalaman yang akan disimpan
    const experienceData = {
      position,
      company,
      description,
      employmentType,
      startDate,  // Menyimpan sebagai string
      endDate,    // Menyimpan sebagai string (null jika belum selesai)
      createdAt: FieldValue.serverTimestamp(),  // Tetap simpan createdAt dengan server timestamp
    };

    // Tambah data pengalaman ke sub-koleksi experience
    const experienceRef = db.collection("users").doc(uid).collection("experience");
    const newDoc = await experienceRef.add(experienceData);

    // Response sukses
    res.status(201).json({
      id: newDoc.id,
      message: "Experience added successfully",
      experience: experienceData,
    });

  } catch (err) {
    console.error("Error adding experience:", err);
    res.status(500).json({ error: "Failed to add experience", details: err.message });
  }
});

app.patch("/experience/:id", async (req, res) => {
  try {
    const uid = req.user.uid;
    const { position, company, description, employmentType, startDate, endDate } = req.body;
    const experienceId = req.params.id;

    // Fetch the document from the Firestore collection
    const experienceRef = db.collection("users").doc(uid).collection("experience").doc(experienceId);
    const experienceDoc = await experienceRef.get();

    if (!experienceDoc.exists) {
      return res.status(404).json({ error: "Experience document not found" });
    }

    // Prepare data to update
    const updateData = {};
    if (position) updateData.position = position;
    if (company) updateData.company = company;
    if (description) updateData.description = description;
    if (employmentType) updateData.employmentType = employmentType;
    if (startDate) updateData.startDate = startDate;
    if (endDate) updateData.endDate = endDate;

    updateData.updatedAt = FieldValue.serverTimestamp(); // Add updated timestamp

    // Update the document in Firestore
    await experienceRef.update(updateData);

    res.status(200).json({
      message: "Experience updated successfully",
      updatedFields: updateData
    });
  } catch (err) {
    console.error("Error updating experience:", err);
    res.status(500).json({ error: "Failed to update experience", details: err.message });
  }
});

app.get("/experience", async (req, res) => {
  try {
    const uid = req.user.uid;

    const experienceRef = db.collection("users").doc(uid).collection("experience");
    const snapshot = await experienceRef.orderBy("startDate", "desc").get();

    if (snapshot.empty) {
      return res.status(200).json({ experience: [] });
    }

    const experienceList = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.status(200).json({ experience: experienceList });

  } catch (err) {
    console.error("Error getting experience:", err);
    res.status(500).json({ error: "Failed to get experience", details: err.message });
  }
});

app.get("/skills", async (req, res) => {
  try {
    const uid = req.user.uid;
    const userRef = db.collection("users").doc(uid);

    const hardSkillsSnap = await userRef.collection("hard-skills").get();
    const hardSkills = hardSkillsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    const softSkillsSnap = await userRef.collection("soft-skills").get();
    const softSkills = softSkillsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    res.status(200).json({ hardSkills, softSkills });
  } catch (err) {
    console.error("Error getting skills:", err);
    res.status(500).json({ error: "Failed to get skills", details: err.message });
  }
});

// POST /skills - tambahkan skill baru (bisa banyak sekaligus)
app.post("/skills", async (req, res) => {
  try {
    const uid = req.user.uid;
    const { hardSkills, softSkills } = req.body;

    if ((!hardSkills || !Array.isArray(hardSkills)) && (!softSkills || !Array.isArray(softSkills))) {
      return res.status(400).json({ error: "At least one of hardSkills or softSkills must be a non-empty array" });
    }

    const userRef = db.collection("users").doc(uid);

    if (hardSkills && Array.isArray(hardSkills)) {
      const hardSkillsCol = userRef.collection("hard-skills");
      const addHardPromises = hardSkills.map(skill => {
        if (!skill.name || !skill.level) {
          throw new Error("Each hard skill must have a name and level");
        }
        return hardSkillsCol.add({ name: skill.name, level: skill.level });
      });
      await Promise.all(addHardPromises);
    }

    if (softSkills && Array.isArray(softSkills)) {
      const softSkillsCol = userRef.collection("soft-skills");
      const addSoftPromises = softSkills.map(skill => {
        if (!skill.name || !skill.level) {
          throw new Error("Each soft skill must have a name and level");
        }
        return softSkillsCol.add({ name: skill.name, level: skill.level });
      });
      await Promise.all(addSoftPromises);
    }

    res.status(201).json({ message: "Skills added successfully" });
  } catch (err) {
    console.error("Error adding skills:", err);
    res.status(500).json({ error: "Failed to add skills", details: err.message });
  }
});

// PATCH /skills - update skill yang sudah ada berdasarkan id
app.patch("/skills", async (req, res) => {
  try {
    const uid = req.user.uid;
    const { hardSkills, softSkills } = req.body;

    if (!hardSkills && !softSkills) {
      return res.status(400).json({ error: "At least one of hardSkills or softSkills must be provided" });
    }

    const userRef = db.collection("users").doc(uid);

    if (hardSkills && Array.isArray(hardSkills)) {
      for (const skill of hardSkills) {
        const { id, name, level } = skill;
        if (!id || !name || !level) {
          return res.status(400).json({ error: "Each hard skill must have id, name, and level" });
        }
        await userRef.collection("hard-skills").doc(id).update({
          name,
          level,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    }

    if (softSkills && Array.isArray(softSkills)) {
      for (const skill of softSkills) {
        const { id, name, level } = skill;
        if (!id || !name || !level) {
          return res.status(400).json({ error: "Each soft skill must have id, name, and level" });
        }
        await userRef.collection("soft-skills").doc(id).update({
          name,
          level,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    }

    res.status(200).json({ message: "Skills updated successfully" });
  } catch (err) {
    console.error("Error updating skills:", err);
    res.status(500).json({ error: "Failed to update skills", details: err.message });
  }
});

app.post("/portfolio", async (req, res) => {
  try {
    const uid = req.user.uid;
    const { title, description, projectUrl, technologies } = req.body;

    // Validasi input wajib
    if (!title || !description || !projectUrl || !Array.isArray(technologies)) {
      return res.status(400).json({ error: "Missing required fields (title, description, projectUrl, technologies)" });
    }

    // Data portfolio yang akan disimpan
    const portfolioData = {
      title,
      description,
      projectUrl,
      technologies,
      createdAt: FieldValue.serverTimestamp(),
    };

    // Gunakan title sebagai document ID
    const portfolioRef = db.collection("users").doc(uid).collection("portfolio");
    const docRef = portfolioRef.doc(title);  // Use title as document ID
    await docRef.set(portfolioData);  // Save data

    // Response sukses
    res.status(201).json({
      id: title,  // Return title as ID
      message: "Portfolio added successfully",
      portfolio: portfolioData,
    });

  } catch (err) {
    console.error("Error adding portfolio:", err);
    res.status(500).json({ error: "Failed to add portfolio", details: err.message });
  }
});

app.patch("/portfolio", async (req, res) => {
  try {
    const uid = req.user.uid;
    const { title, description, projectUrl, technologies } = req.body;

    // Validating if title is provided as it is the document ID
    if (!title) {
      return res.status(400).json({ error: "Missing title to identify the portfolio document" });
    }

    // Fetch the portfolio document
    const portfolioRef = db.collection("users").doc(uid).collection("portfolio").doc(title);
    const portfolioDoc = await portfolioRef.get();

    if (!portfolioDoc.exists) {
      return res.status(404).json({ error: "Portfolio document not found" });
    }

    // Prepare update data
    const updateData = {};
    if (description) updateData.description = description;
    if (projectUrl) updateData.projectUrl = projectUrl;
    if (technologies && Array.isArray(technologies)) updateData.technologies = technologies;

    updateData.updatedAt = FieldValue.serverTimestamp();  // Add update timestamp

    // Update the portfolio document
    await portfolioRef.update(updateData);

    res.status(200).json({
      message: "Portfolio updated successfully",
      updatedFields: updateData,
    });

  } catch (err) {
    console.error("Error updating portfolio:", err);
    res.status(500).json({ error: "Failed to update portfolio", details: err.message });
  }
});

app.get("/portfolio", async (req, res) => {
  try {
    const uid = req.user.uid;

    const portfolioRef = db.collection("users").doc(uid).collection("portfolio");
    const snapshot = await portfolioRef.get();

    if (snapshot.empty) {
      return res.status(200).json({ portfolio: [] });
    }

    // Mapping setiap dokumen ke objek dengan id (title) dan data
    const portfolioList = snapshot.docs.map(doc => ({
      id: doc.id,     // Karena kamu pakai title sebagai document ID
      ...doc.data(),
    }));

    res.status(200).json({ portfolio: portfolioList });

  } catch (err) {
    console.error("Error getting portfolio:", err);
    res.status(500).json({ error: "Failed to get portfolio", details: err.message });
  }
});

app.post("/preferences", async (req, res) => {
  try {
    const uid = req.user.uid;
    const { jobCategories, locations, salaryExpectation, jobTypes } = req.body;

    // Validasi input
    if (!Array.isArray(jobCategories) || !Array.isArray(locations) || !Array.isArray(jobTypes)) {
      return res.status(400).json({ error: "jobCategories, locations, and jobTypes must be arrays" });
    }

    // Memastikan jobTypes memiliki nilai yang valid
    const validJobTypes = ["Remote", "On-site", "Hybrid"];
    for (const jobType of jobTypes) {
      if (!validJobTypes.includes(jobType)) {
        return res.status(400).json({ error: `Invalid jobType value. Valid options are: ${validJobTypes.join(', ')}` });
      }
    }

    // Data preferences yang akan disimpan
    const preferencesData = {
      jobCategories,
      locations,
      salaryExpectation,
      jobTypes,
      createdAt: FieldValue.serverTimestamp(),
    };

    // Menyimpan ke sub-koleksi preferences
    const preferencesRef = db.collection("users").doc(uid).collection("preferences");
    const newDoc = await preferencesRef.add(preferencesData);

    // Response sukses
    res.status(201).json({
      id: newDoc.id,
      message: "Preferences added successfully",
      preferences: preferencesData,
    });

  } catch (err) {
    console.error("Error adding preferences:", err);
    res.status(500).json({ error: "Failed to add preferences", details: err.message });
  }
});

app.patch("/preferences", async (req, res) => {
  try {
    const uid = req.user.uid;
    const { jobCategories, locations, salaryExpectation, jobTypes } = req.body;

    // Fetch the existing preferences document
    const preferencesRef = db.collection("users").doc(uid).collection("preferences");
    const preferencesDoc = await preferencesRef.get();

    if (preferencesDoc.empty) {
      return res.status(404).json({ error: "Preferences document not found" });
    }

    // Prepare update data
    const updateData = {};

    if (jobCategories && Array.isArray(jobCategories)) updateData.jobCategories = jobCategories;
    if (locations && Array.isArray(locations)) updateData.locations = locations;
    if (salaryExpectation) updateData.salaryExpectation = salaryExpectation;
    if (jobTypes && Array.isArray(jobTypes)) updateData.jobTypes = jobTypes;

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    updateData.updatedAt = FieldValue.serverTimestamp();  // Update timestamp

    // Update preferences document
    await preferencesRef.doc("user-preferences").update(updateData);

    res.status(200).json({
      message: "Preferences updated successfully",
      updatedFields: updateData
    });

  } catch (err) {
    console.error("Error updating preferences:", err);
    res.status(500).json({ error: "Failed to update preferences", details: err.message });
  }
});

app.get("/preferences", async (req, res) => {
  try {
    const uid = req.user.uid;
    const preferencesRef = db.collection("users").doc(uid).collection("preferences").doc("user-preferences");
    const doc = await preferencesRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Preferences not found" });
    }

    res.status(200).json({ preferences: doc.data() });

  } catch (err) {
    console.error("Error getting preferences:", err);
    res.status(500).json({ error: "Failed to get preferences", details: err.message });
  }
});



app.post('/upload-document', async (req, res) => {
  try {
    const uid = req.user.uid;
    const base64String = req.body.file;
    const type = req.body.type; // e.g., "CV", "Certificate", etc.

    if (!base64String || !type) {
      return res.status(400).json({ error: "File and type are required" });
    }

    // Decode the Base64 string
    const buffer = Buffer.from(base64String, 'base64');

    const fileName = `documents/${uid}-${Date.now()}.pdf`; // Assuming PDF for simplicity
    const bucketFile = bucket.file(fileName);

    // Upload to Firebase Storage
    await bucketFile.save(buffer, {
      metadata: {
        contentType: 'application/pdf' // Adjust content type as needed
      },
      public: true // Make it publicly accessible
    });

    // Get the public URL
    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${encodeURIComponent(fileName)}`;

    // Save the document details in Firestore
    const documentData = {
      type,
      fileUrl: publicUrl,
      uploadedAt: FieldValue.serverTimestamp() // Use server timestamp
    };

    const documentRef = db.collection("users").doc(uid).collection("documents").doc();
    await documentRef.set(documentData);

    res.json({
      message: "Document uploaded successfully",
      documentId: documentRef.id,
      fileUrl: publicUrl
    });
  } catch (err) {
    console.error("Error uploading document:", err);
    res.status(500).json({ error: "Failed to upload document", details: err.message });
  }
});

app.patch('/upload-document', async (req, res) => {
  try {
    const uid = req.user.uid;
    const { documentId, base64String, type } = req.body;

    if (!documentId || !base64String || !type) {
      return res.status(400).json({ error: "documentId, file and type are required" });
    }

    // Decode the Base64 string
    const buffer = Buffer.from(base64String, 'base64');

    const fileName = `documents/${uid}-${Date.now()}.pdf`; // Assuming PDF for simplicity
    const bucketFile = bucket.file(fileName);

    // Upload to Firebase Storage
    await bucketFile.save(buffer, {
      metadata: {
        contentType: 'application/pdf' // Adjust content type as needed
      },
      public: true // Make it publicly accessible
    });

    // Get the public URL
    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${encodeURIComponent(fileName)}`;

    // Update the document details in Firestore
    const documentRef = db.collection("users").doc(uid).collection("documents").doc(documentId);
    const documentSnap = await documentRef.get();

    if (!documentSnap.exists) {
      return res.status(404).json({ error: "Document not found" });
    }

    const updateData = {
      type,
      fileUrl: publicUrl,
      updatedAt: FieldValue.serverTimestamp() // Use server timestamp
    };

    // Update the document in Firestore
    await documentRef.update(updateData);

    res.json({
      message: "Document updated successfully",
      documentId: documentRef.id,
      fileUrl: publicUrl
    });

  } catch (err) {
    console.error("Error updating document:", err);
    res.status(500).json({ error: "Failed to update document", details: err.message });
  }
});

app.get("/upload-document", async (req, res) => {
  try {
    const uid = req.user.uid;

    const documentsRef = db.collection("users").doc(uid).collection("documents");
    const snapshot = await documentsRef.orderBy("uploadedAt", "desc").get();

    if (snapshot.empty) {
      return res.status(200).json({ documents: [] });
    }

    const documents = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.status(200).json({ documents });

  } catch (err) {
    console.error("Error getting documents:", err);
    res.status(500).json({ error: "Failed to get documents", details: err.message });
  }
});

// Deploy sebagai one-off Cloud Function
exports.app = functions.https.onRequest(app);
