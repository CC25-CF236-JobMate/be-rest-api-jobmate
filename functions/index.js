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

app.put("/profile", async (req, res) => {
  try {
    const uid = req.user.uid;
    const data = {};

    // Handle regular fields
    ["fullname", "phoneNumber", "city"].forEach((field) => {
      if (req.body[field] !== undefined) {
        data[field] = req.body[field];
      }
    });

    // Handle base64 photo if exists (simpan sebagai photoUrl)
    if (req.body.photoUrl) {
      // Validasi format base64 image
      const matches = req.body.photoUrl.match(/^data:image\/([a-zA-Z]+);base64,(.+)$/);
      if (!matches || matches.length !== 3) {
        return res.status(400).json({ error: "Invalid base64 image format" });
      }

      const imageType = matches[1]; // jpeg, png, etc.
      const base64Data = matches[2]; // data setelah prefix
      const imageBuffer = Buffer.from(base64Data, 'base64');

      // Validasi ukuran file (max 5MB)
      if (imageBuffer.length > 5 * 1024 * 1024) {
        return res.status(400).json({ error: "Image too large (max 5MB)" });
      }

      const fileName = `profile-photos/${uid}-${Date.now()}.${imageType}`;
      const file = bucket.file(fileName);

      // Upload ke Firebase Storage
      await file.save(imageBuffer, {
        metadata: {
          contentType: `image/${imageType}`
        },
        public: true // Jika ingin langsung bisa diakses
      });

      // Dapatkan URL publik
      const publicUrl = `https://storage.googleapis.com/${bucket.name}/${encodeURIComponent(fileName)}`;
      data.photoUrl = publicUrl;

      // Hapus foto lama jika ada
      const userDoc = await db.collection("users").doc(uid).collection("user_personal").doc("info").get();
      if (userDoc.exists && userDoc.data().photoUrl) {
        try {
          const oldPhotoUrl = userDoc.data().photoUrl;
          const oldFilePath = decodeURIComponent(
            oldPhotoUrl.split("/o/")[1].split("?")[0]
          );
          await bucket.file(oldFilePath).delete();
        } catch (err) {
          console.error("Error deleting old photo:", err);
          // Tidak menghentikan proses jika gagal hapus foto lama
        }
      }
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    // Update sub-koleksi user_personal/info
    await db.collection("users").doc(uid).collection("user_personal").doc("info").update(data);
    res.json({ 
      message: "Profile updated successfully",
      updatedFields: Object.keys(data),
      photoUrl: data.photoUrl || null
    });

  } catch (err) {
    console.error("Error updating profile:", err);
    res.status(500).json({ 
      error: "Failed to update profile",
      details: err.message 
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

app.post("/skills", async (req, res) => {
  try {
    const uid = req.user.uid;
    const { hardSkills, softSkills } = req.body;

    if (!hardSkills && !softSkills) {
      return res.status(400).json({ error: "At least one of hardSkills or softSkills must be provided" });
    }

    // Create a new skill document under the 'skills' sub-collection
    const skillsRef = db.collection("users").doc(uid).collection("skills");

    // If hardSkills is provided, add them
    if (hardSkills && Array.isArray(hardSkills)) {
      const hardSkillsDocRef = skillsRef.doc("hard-skills");
      for (const skill of hardSkills) {
        const { name, level } = skill;
        if (!name || !level) {
          return res.status(400).json({ error: "Each hard skill must have a name and level" });
        }
        await hardSkillsDocRef.collection("hard-skills").add({
          name,
          level,
        });
      }
    }

    // If softSkills is provided, add them
    if (softSkills && Array.isArray(softSkills)) {
      const softSkillsDocRef = skillsRef.doc("soft-skills");
      for (const skill of softSkills) {
        const { name, level } = skill;
        if (!name || !level) {
          return res.status(400).json({ error: "Each soft skill must have a name and level" });
        }
        await softSkillsDocRef.collection("soft-skills").add({
          name,
          level,
        });
      }
    }

    res.status(201).json({ message: "Skills added successfully" });

  } catch (err) {
    console.error("Error adding skills:", err);
    res.status(500).json({ error: "Failed to add skills", details: err.message });
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

app.post('/uploadDocument', async (req, res) => {
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

// Deploy sebagai one-off Cloud Function
exports.app = functions.https.onRequest(app);
