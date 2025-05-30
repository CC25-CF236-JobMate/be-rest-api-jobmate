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

function cleanDescription(description) {
  return description.replace(/[^a-zA-Z0-9\s]/g, "").toLowerCase();
}

// POST /jobs - Tambah beberapa lowongan pekerjaan sekaligus
app.post("/jobs", async (req, res) => {
  try {
    const jobs = req.body;

    if (!Array.isArray(jobs) || jobs.length === 0) {
      return res.status(400).json({ error: "Request must contain an array of jobs" });
    }

    const jobRef = db.collection("jobs");

    const jobPromises = jobs.map(async (job) => {
      const {
        jobTitle,
        jobDescription,
        companyName,
        location,
        category,
        jobType,
        skillsRequired,
        salaryMin,
        salaryMax,
        salaryCurrency,
        isActive,
      } = job;

      if (
        !jobTitle ||
        !jobDescription ||
        !companyName ||
        !location ||
        !category ||
        !jobType ||
        !skillsRequired
      ) {
        throw new Error(
          "Missing required fields (jobTitle, jobDescription, companyName, location, category, jobType, skillsRequired)"
        );
      }

      const jobData = {
        jobTitle,
        jobDescription,
        cleanedDescription: cleanDescription(jobDescription),
        companyName,
        location,
        category,
        jobType,
        skillsRequired: Array.isArray(skillsRequired) ? skillsRequired : [],
        salary: {
          min: salaryMin || 0,
          max: salaryMax || 0,
          currency: salaryCurrency || "IDR",
        },
        postedAt: FieldValue.serverTimestamp(),
        isActive: isActive !== undefined ? isActive : true,
      };

      return jobRef.add(jobData);
    });

    await Promise.all(jobPromises);

    res.status(201).json({
      message: "Jobs added successfully",
    });
  } catch (err) {
    console.error("Error adding jobs:", err);
    res.status(500).json({ error: "Failed to add jobs", details: err.message });
  }
});

// GET /jobs - Ambil daftar pekerjaan dengan filter kategori dan gaji
app.get("/jobs", async (req, res) => {
  try {
    const { category, location, minSalary, maxSalary, limit = 20, lastDocId } = req.query;
    let query = db.collection("jobs").where("isActive", "==", true);

    if (category) {
      query = query.where("category", "==", category);
    }
    if (location) {
      query = query.where("location", "==", location);
    }
    if (minSalary) {
      query = query.where("salary.min", ">=", Number(minSalary));
    }
    if (maxSalary) {
      query = query.where("salary.max", "<=", Number(maxSalary));
    }

    query = query.orderBy("postedAt", "desc").limit(parseInt(limit));

    if (lastDocId) {
      const lastDoc = await db.collection("jobs").doc(lastDocId).get();
      if (lastDoc.exists) {
        query = query.startAfter(lastDoc);
      }
    }

    const snapshot = await query.get();

    const jobs = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.status(200).json({ jobs });
  } catch (err) {
    console.error("Error getting jobs:", err);
    res.status(500).json({ error: "Failed to get jobs", details: err.message });
  }
});

// GET /jobs/:id - Detail pekerjaan berdasarkan jobId
app.get("/jobs/:id", async (req, res) => {
  try {
    const jobId = req.params.id;
    const jobDoc = await db.collection("jobs").doc(jobId).get();

    if (!jobDoc.exists) {
      return res.status(404).json({ error: "Job not found" });
    }

    res.status(200).json({ id: jobDoc.id, ...jobDoc.data() });
  } catch (err) {
    console.error("Error getting job details:", err);
    res.status(500).json({ error: "Failed to get job details", details: err.message });
  }
});

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

app.delete("/profile/photo", async (req, res) => {
  try {
    const uid = req.user.uid;

    // Ambil dokumen profil user
    const userDocRef = db.collection("users").doc(uid).collection("user_personal").doc("info");
    const userDoc = await userDocRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: "Profile not found" });
    }

    const photoUrl = userDoc.data().photoUrl;
    if (!photoUrl) {
      return res.status(400).json({ error: "No profile photo to delete" });
    }

    // Extract file path dari URL Firebase Storage
    // Contoh URL: https://storage.googleapis.com/{bucket.name}/profile-photos/uid-timestamp.jpg
    // File path yang dihapus adalah "profile-photos/uid-timestamp.jpg"
    const filePath = decodeURIComponent(photoUrl.split(`https://storage.googleapis.com/${bucket.name}/`)[1]);

    // Hapus file dari Firebase Storage
    await bucket.file(filePath).delete();

    // Hapus field photoUrl di Firestore (set ke null atau hapus)
    await userDocRef.update({ photoUrl: null });

    res.json({ message: "Profile photo deleted successfully" });
  } catch (err) {
    console.error("Error deleting profile photo:", err);
    res.status(500).json({ error: "Failed to delete profile photo" });
  }
});

app.post("/education", async (req, res) => {
  try {
    const uid = req.user.uid; // Asumsikan req.user.uid sudah ada dari middleware otentikasi
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

    if (endDate) { // endDate bersifat opsional
        const isValidEndDate = /^\d{4}-\d{2}-\d{2}$/.test(endDate);
        if (!isValidEndDate) {
          return res.status(400).json({ error: "Invalid endDate format. Use YYYY-MM-DD" });
        }

        // Validasi endDate tidak boleh sebelum startDate
        const startDt = new Date(startDate);
        const endDt = new Date(endDate);
        if (endDt < startDt) {
          return res.status(400).json({ error: "endDate cannot be earlier than startDate" });
        }
    }

    // Data pendidikan yang akan disimpan
    const educationData = {
      level,
      institution,
      major,
      startDate,  // Menyimpan sebagai string
      endDate: endDate || null,   // Menyimpan sebagai string (null jika belum selesai atau tidak diisi)
      gpa: gpa || null,
      createdAt: FieldValue.serverTimestamp(),
    };

    // Tambah data pendidikan ke sub-koleksi education
    const educationRef = db.collection("users").doc(uid).collection("education");
    const newDoc = await educationRef.add(educationData);

    // Response sukses
    res.status(201).json({
      id: newDoc.id,
      message: "Education added successfully",
      education: { ...educationData, createdAt: new Date().toISOString() }, // Memberikan perkiraan createdAt
    });

  } catch (err) {
    console.error("Error adding education:", err);
    res.status(500).json({ error: "Failed to add education", details: err.message });
  }
});

app.patch("/education/:id", async (req, res) => {
  try {
    const uid = req.user.uid; // Asumsikan req.user.uid sudah ada
    const { level, institution, major, startDate, endDate, gpa } = req.body;
    const educationId = req.params.id;

    const educationRef = db.collection("users").doc(uid).collection("education").doc(educationId);
    const educationDoc = await educationRef.get();

    if (!educationDoc.exists) {
      return res.status(404).json({ error: "Education document not found" });
    }

    const existingData = educationDoc.data();
    const updateData = {};

    let effectiveStartDate = existingData.startDate;
    let effectiveEndDate = existingData.endDate; // Bisa null

    if (startDate !== undefined) {
      if (typeof startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
        return res.status(400).json({ error: "Invalid startDate format. Use YYYY-MM-DD" });
      }
      updateData.startDate = startDate;
      effectiveStartDate = startDate;
    }

    if (endDate !== undefined) { // endDate bisa di-set menjadi null
      if (endDate !== null && (typeof endDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(endDate))) {
        return res.status(400).json({ error: "Invalid endDate format. Use YYYY-MM-DD or null" });
      }
      updateData.endDate = endDate; // Bisa jadi null
      effectiveEndDate = endDate;
    }
    
    // Validasi endDate tidak boleh sebelum startDate hanya jika keduanya ada (endDate bukan null)
    if (effectiveStartDate && effectiveEndDate) {
      const startDt = new Date(effectiveStartDate);
      const endDt = new Date(effectiveEndDate);
      if (endDt < startDt) {
        return res.status(400).json({ error: "endDate cannot be earlier than startDate" });
      }
    } else if (effectiveEndDate === null && !effectiveStartDate) {
        // Jika endDate null (misal karena dihapus) dan startDate juga tidak ada (tidak mungkin terjadi jika data awal valid)
        // atau jika startDate dihapus tapi endDate masih ada. Ini skenario yang perlu dipertimbangkan lebih lanjut
        // Untuk saat ini, asumsikan startDate selalu ada jika endDate ada, kecuali endDate di-set null
    }


    if (level !== undefined) updateData.level = level;
    if (institution !== undefined) updateData.institution = institution;
    if (major !== undefined) updateData.major = major;
    if (gpa !== undefined) updateData.gpa = gpa; // gpa bisa di-set null

    if (Object.keys(updateData).length === 0) {
      return res.status(200).json({ message: "No fields to update", education: existingData });
    }

    updateData.updatedAt = FieldValue.serverTimestamp();

    await educationRef.update(updateData);

    res.status(200).json({
      message: "Education updated successfully",
      updatedFields: updateData, // Tidak termasuk updatedAt
      education: { ...existingData, ...updateData, updatedAt: new Date().toISOString() } // Memberikan perkiraan updatedAt
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

app.delete("/education/:id", async (req, res) => {
  try {
    const uid = req.user.uid;
    const educationId = req.params.id;

    const educationRef = db.collection("users").doc(uid).collection("education").doc(educationId);
    const educationDoc = await educationRef.get();

    if (!educationDoc.exists) {
      return res.status(404).json({ error: "Education document not found" });
    }

    // Hapus dokumen pendidikan
    await educationRef.delete();

    res.status(200).json({ message: "Education deleted successfully" });
  } catch (err) {
    console.error("Error deleting education:", err);
    res.status(500).json({ error: "Failed to delete education", details: err.message });
  }
});


app.post("/experience", async (req, res) => {
  try {
    const uid = req.user.uid; // Asumsikan req.user.uid sudah ada
    const { position, company, description, employmentType, startDate, endDate } = req.body;

    // Validasi input wajib
    if (!position || !company || !description || !employmentType || !startDate) {
      return res.status(400).json({ error: "Missing required fields (position, company, description, employmentType, startDate)" });
    }

    // Validasi jenis pekerjaan
    const validEmploymentTypes = ['full-time', 'part-time', 'freelance', 'internship'];
    if (!validEmploymentTypes.includes(employmentType.toLowerCase())) {
      return res.status(400).json({ error: "Invalid employmentType. Valid options are: full-time, part-time, freelance, internship" });
    }

    // Validasi format date (YYYY-MM-DD)
    const isValidStartDate = /^\d{4}-\d{2}-\d{2}$/.test(startDate);
    if (!isValidStartDate) {
      return res.status(400).json({ error: "Invalid startDate format. Use YYYY-MM-DD" });
    }

    if (endDate) { // endDate bersifat opsional
        const isValidEndDate = /^\d{4}-\d{2}-\d{2}$/.test(endDate);
        if (!isValidEndDate) {
          return res.status(400).json({ error: "Invalid endDate format. Use YYYY-MM-DD" });
        }
        // Validasi endDate tidak boleh sebelum startDate
        const startDt = new Date(startDate);
        const endDt = new Date(endDate);
        if (endDt < startDt) {
          return res.status(400).json({ error: "endDate cannot be earlier than startDate" });
        }
    }

    // Data pengalaman yang akan disimpan
    const experienceData = {
      position,
      company,
      description,
      employmentType: employmentType.toLowerCase(),
      startDate,  // Menyimpan sebagai string
      endDate: endDate || null,   // Menyimpan sebagai string (null jika belum selesai atau tidak diisi)
      createdAt: FieldValue.serverTimestamp(),
    };

    const experienceRef = db.collection("users").doc(uid).collection("experience");
    const newDoc = await experienceRef.add(experienceData);

    res.status(201).json({
      id: newDoc.id,
      message: "Experience added successfully",
      experience: { ...experienceData, createdAt: new Date().toISOString() }, // Memberikan perkiraan createdAt
    });

  } catch (err) {
    console.error("Error adding experience:", err);
    res.status(500).json({ error: "Failed to add experience", details: err.message });
  }
});

app.patch("/experience/:id", async (req, res) => {
  try {
    const uid = req.user.uid; // Asumsikan req.user.uid sudah ada
    const { position, company, description, employmentType, startDate, endDate } = req.body;
    const experienceId = req.params.id;

    const experienceRef = db.collection("users").doc(uid).collection("experience").doc(experienceId);
    const experienceDoc = await experienceRef.get();

    if (!experienceDoc.exists) {
      return res.status(404).json({ error: "Experience document not found" });
    }

    const existingData = experienceDoc.data();
    const updateData = {};

    let effectiveStartDate = existingData.startDate;
    let effectiveEndDate = existingData.endDate; // Bisa null

    if (startDate !== undefined) {
      if (typeof startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
        return res.status(400).json({ error: "Invalid startDate format. Use YYYY-MM-DD" });
      }
      updateData.startDate = startDate;
      effectiveStartDate = startDate;
    }

    if (endDate !== undefined) { // endDate bisa di-set menjadi null
      if (endDate !== null && (typeof endDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(endDate))) {
        return res.status(400).json({ error: "Invalid endDate format. Use YYYY-MM-DD or null" });
      }
      updateData.endDate = endDate; // Bisa jadi null
      effectiveEndDate = endDate;
    }

    // Validasi endDate tidak boleh sebelum startDate hanya jika keduanya ada (endDate bukan null)
    if (effectiveStartDate && effectiveEndDate) {
      const startDt = new Date(effectiveStartDate);
      const endDt = new Date(effectiveEndDate);
      if (endDt < startDt) {
        return res.status(400).json({ error: "endDate cannot be earlier than startDate" });
      }
    }

    if (position !== undefined) updateData.position = position;
    if (company !== undefined) updateData.company = company;
    if (description !== undefined) updateData.description = description;
    if (employmentType !== undefined) {
      const validEmploymentTypes = ['full-time', 'part-time', 'freelance', 'internship'];
      if (!validEmploymentTypes.includes(employmentType.toLowerCase())) {
        return res.status(400).json({ error: "Invalid employmentType. Valid options are: full-time, part-time, freelance, internship" });
      }
      updateData.employmentType = employmentType.toLowerCase();
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(200).json({ message: "No fields to update", experience: existingData });
    }

    updateData.updatedAt = FieldValue.serverTimestamp();

    await experienceRef.update(updateData);

    res.status(200).json({
      message: "Experience updated successfully",
      updatedFields: updateData, // Tidak termasuk updatedAt
      experience: { ...existingData, ...updateData, updatedAt: new Date().toISOString() } // Memberikan perkiraan updatedAt
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

app.delete("/experience/:id", async (req, res) => {
  try {
    const uid = req.user.uid;
    const experienceId = req.params.id;

    const experienceRef = db.collection("users").doc(uid).collection("experience").doc(experienceId);
    const experienceDoc = await experienceRef.get();

    if (!experienceDoc.exists) {
      return res.status(404).json({ error: "Experience document not found" });
    }

    // Hapus dokumen experience
    await experienceRef.delete();

    res.status(200).json({ message: "Experience deleted successfully" });
  } catch (err) {
    console.error("Error deleting experience:", err);
    res.status(500).json({ error: "Failed to delete experience", details: err.message });
  }
});


app.get("/hard-skills", async (req, res) => {
  try {
    const uid = req.user.uid; // Assuming user is authenticated and uid is available
    const userRef = db.collection("users").doc(uid);
    const hardSkillsSnap = await userRef.collection("hard-skills").get();
    const hardSkills = hardSkillsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.status(200).json(hardSkills);
  } catch (err) {
    console.error("Error getting hard skills:", err);
    res.status(500).json({ error: "Failed to get hard skills", details: err.message });
  }
});

// POST /hard-skills - tambahkan hard skill baru (bisa banyak sekaligus)
app.post("/hard-skills", async (req, res) => {
  try {
    const uid = req.user.uid;
    const skills = req.body; // Expecting an array of hard skills

    if (!Array.isArray(skills) || skills.length === 0) {
      return res.status(400).json({ error: "Request body must be a non-empty array of hard skills" });
    }

    const userRef = db.collection("users").doc(uid);
    const hardSkillsCol = userRef.collection("hard-skills");
    const batch = db.batch();
    const addedSkills = [];

    for (const skill of skills) {
      if (!skill.name || !skill.level) {
        // If one skill is invalid, we might choose to stop or skip. Here, we stop.
        return res.status(400).json({ error: "Each hard skill must have a name and level" });
      }
      const newSkillRef = hardSkillsCol.doc(); // Auto-generate ID
      batch.set(newSkillRef, { 
        name: skill.name, 
        level: skill.level,
        createdAt: FieldValue.serverTimestamp() // Optional: add createdAt
      });
      addedSkills.push({ id: newSkillRef.id, name: skill.name, level: skill.level });
    }

    await batch.commit();
    res.status(201).json({ message: "Hard skills added successfully", addedSkills });
  } catch (err) {
    console.error("Error adding hard skills:", err);
    res.status(500).json({ error: "Failed to add hard skills", details: err.message });
  }
});

// PATCH /hard-skills - update hard skill yang sudah ada berdasarkan id (bisa banyak sekaligus)
app.patch("/hard-skills", async (req, res) => {
  try {
    const uid = req.user.uid;
    const skillsToUpdate = req.body; // Expecting an array of hard skills with id

    if (!Array.isArray(skillsToUpdate) || skillsToUpdate.length === 0) {
      return res.status(400).json({ error: "Request body must be a non-empty array of hard skills to update" });
    }

    const userRef = db.collection("users").doc(uid);
    const hardSkillsCol = userRef.collection("hard-skills");
    const batch = db.batch();

    for (const skill of skillsToUpdate) {
      if (!skill.id || !skill.name || !skill.level) {
        return res.status(400).json({ error: "Each hard skill to update must have an id, name, and level" });
      }
      const skillRef = hardSkillsCol.doc(skill.id);
      batch.update(skillRef, {
        name: skill.name,
        level: skill.level,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    await batch.commit();
    res.status(200).json({ message: "Hard skills updated successfully" });
  } catch (err) {
    console.error("Error updating hard skills:", err);
    // Check for specific errors, e.g., document not found, if Firestore provides them
    if (err.code === 5) { // Firestore 'NOT_FOUND' error code
        return res.status(404).json({ error: "One or more hard skills not found", details: err.message });
    }
    res.status(500).json({ error: "Failed to update hard skills", details: err.message });
  }
});

// DELETE /hard-skills - hapus hard skill berdasarkan id (bisa banyak sekaligus)
app.delete("/hard-skills", async (req, res) => {
  try {
    const uid = req.user.uid;
    const { skillIds } = req.body; // Expecting an object with an array of skill IDs

    if (!skillIds || !Array.isArray(skillIds) || skillIds.length === 0) {
      return res.status(400).json({ error: "Request body must contain a non-empty array of hard skill IDs (skillIds)" });
    }

    const userRef = db.collection("users").doc(uid);
    const hardSkillsCol = userRef.collection("hard-skills");
    const batch = db.batch();

    skillIds.forEach(id => {
      if (typeof id !== 'string' || id.trim() === '') {
        // We can choose to throw an error or just log and skip.
        // For now, let's be strict.
        throw new Error(`Invalid skill ID: ${id}. All IDs must be non-empty strings.`);
      }
      const skillRef = hardSkillsCol.doc(id);
      batch.delete(skillRef);
    });

    await batch.commit();
    res.status(200).json({ message: "Hard skills deleted successfully" });
  } catch (err) {
    console.error("Error deleting hard skills:", err);
    res.status(500).json({ error: "Failed to delete hard skills", details: err.message });
  }
});


// --- Soft Skills Endpoints ---

// GET /soft-skills - dapatkan semua soft skill pengguna
app.get("/soft-skills", async (req, res) => {
  try {
    const uid = req.user.uid;
    const userRef = db.collection("users").doc(uid);
    const softSkillsSnap = await userRef.collection("soft-skills").get();
    const softSkills = softSkillsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.status(200).json(softSkills);
  } catch (err) {
    console.error("Error getting soft skills:", err);
    res.status(500).json({ error: "Failed to get soft skills", details: err.message });
  }
});

// POST /soft-skills - tambahkan soft skill baru (bisa banyak sekaligus)
app.post("/soft-skills", async (req, res) => {
  try {
    const uid = req.user.uid;
    const skills = req.body; // Expecting an array of soft skills

    if (!Array.isArray(skills) || skills.length === 0) {
      return res.status(400).json({ error: "Request body must be a non-empty array of soft skills" });
    }

    const userRef = db.collection("users").doc(uid);
    const softSkillsCol = userRef.collection("soft-skills");
    const batch = db.batch();
    const addedSkills = [];

    for (const skill of skills) {
      if (!skill.name || !skill.level) {
        return res.status(400).json({ error: "Each soft skill must have a name and level" });
      }
      const newSkillRef = softSkillsCol.doc(); // Auto-generate ID
      batch.set(newSkillRef, { 
        name: skill.name, 
        level: skill.level,
        createdAt: FieldValue.serverTimestamp() // Optional: add createdAt
      });
      addedSkills.push({ id: newSkillRef.id, name: skill.name, level: skill.level });
    }

    await batch.commit();
    res.status(201).json({ message: "Soft skills added successfully", addedSkills });
  } catch (err) {
    console.error("Error adding soft skills:", err);
    res.status(500).json({ error: "Failed to add soft skills", details: err.message });
  }
});

// PATCH /soft-skills - update soft skill yang sudah ada berdasarkan id (bisa banyak sekaligus)
app.patch("/soft-skills", async (req, res) => {
  try {
    const uid = req.user.uid;
    const skillsToUpdate = req.body; // Expecting an array of soft skills with id

    if (!Array.isArray(skillsToUpdate) || skillsToUpdate.length === 0) {
      return res.status(400).json({ error: "Request body must be a non-empty array of soft skills to update" });
    }

    const userRef = db.collection("users").doc(uid);
    const softSkillsCol = userRef.collection("soft-skills");
    const batch = db.batch();

    for (const skill of skillsToUpdate) {
      if (!skill.id || !skill.name || !skill.level) {
        return res.status(400).json({ error: "Each soft skill to update must have an id, name, and level" });
      }
      const skillRef = softSkillsCol.doc(skill.id);
      batch.update(skillRef, {
        name: skill.name,
        level: skill.level,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    await batch.commit();
    res.status(200).json({ message: "Soft skills updated successfully" });
  } catch (err) {
    console.error("Error updating soft skills:", err);
     if (err.code === 5) { // Firestore 'NOT_FOUND' error code
        return res.status(404).json({ error: "One or more soft skills not found", details: err.message });
    }
    res.status(500).json({ error: "Failed to update soft skills", details: err.message });
  }
});

// DELETE /soft-skills - hapus soft skill berdasarkan id (bisa banyak sekaligus)
app.delete("/soft-skills", async (req, res) => {
  try {
    const uid = req.user.uid;
    const { skillIds } = req.body; // Expecting an object with an array of skill IDs

    if (!skillIds || !Array.isArray(skillIds) || skillIds.length === 0) {
      return res.status(400).json({ error: "Request body must contain a non-empty array of soft skill IDs (skillIds)" });
    }

    const userRef = db.collection("users").doc(uid);
    const softSkillsCol = userRef.collection("soft-skills");
    const batch = db.batch();

    skillIds.forEach(id => {
       if (typeof id !== 'string' || id.trim() === '') {
        throw new Error(`Invalid skill ID: ${id}. All IDs must be non-empty strings.`);
      }
      const skillRef = softSkillsCol.doc(id);
      batch.delete(skillRef);
    });

    await batch.commit();
    res.status(200).json({ message: "Soft skills deleted successfully" });
  } catch (err) {
    console.error("Error deleting soft skills:", err);
    res.status(500).json({ error: "Failed to delete soft skills", details: err.message });
  }
});

app.post("/portfolio", async (req, res) => {
  try {
    const uid = req.user.uid;
    const { title, description, projectUrl, technologies } = req.body;

    if (!title) {
      return res.status(400).json({ error: "Missing title for the project" });
    }

    const portfolioRef = db.collection("users").doc(uid).collection("portfolio");
    
    const newProject = {
      title,
      description: description || "",
      projectUrl: projectUrl || "",
      technologies: Array.isArray(technologies) ? technologies : [],
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };

    const newDoc = await portfolioRef.add(newProject);

    res.status(201).json({
      id: newDoc.id,
      message: "Portfolio project added successfully",
      project: newProject,
    });
  } catch (err) {
    console.error("Error adding portfolio project:", err);
    res.status(500).json({ error: "Failed to add portfolio project", details: err.message });
  }
});

// PATCH /portfolio/:id - update project berdasarkan document ID
app.patch("/portfolio/:id", async (req, res) => {
  try {
    const uid = req.user.uid;
    const projectId = req.params.id;
    const { title, description, projectUrl, technologies } = req.body;

    const projectRef = db.collection("users").doc(uid).collection("portfolio").doc(projectId);
    const projectDoc = await projectRef.get();

    if (!projectDoc.exists) {
      return res.status(404).json({ error: "Portfolio project not found" });
    }

    const updateData = {};
    if (title !== undefined) updateData.title = title;
    if (description !== undefined) updateData.description = description;
    if (projectUrl !== undefined) updateData.projectUrl = projectUrl;
    if (technologies !== undefined && Array.isArray(technologies)) updateData.technologies = technologies;
    updateData.updatedAt = FieldValue.serverTimestamp();

    await projectRef.update(updateData);

    res.status(200).json({
      message: "Portfolio project updated successfully",
      updatedFields: updateData,
    });
  } catch (err) {
    console.error("Error updating portfolio project:", err);
    res.status(500).json({ error: "Failed to update portfolio project", details: err.message });
  }
});

// GET /portfolio - ambil semua project portfolio user
app.get("/portfolio", async (req, res) => {
  try {
    const uid = req.user.uid;
    const portfolioRef = db.collection("users").doc(uid).collection("portfolio");
    const snapshot = await portfolioRef.orderBy("createdAt", "desc").get();

    if (snapshot.empty) {
      return res.status(200).json({ projects: [] });
    }

    const projects = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.status(200).json({ projects });
  } catch (err) {
    console.error("Error getting portfolio projects:", err);
    res.status(500).json({ error: "Failed to get portfolio projects", details: err.message });
  }
});

// DELETE /portfolio/:id - hapus project portfolio berdasarkan document ID
app.delete("/portfolio/:id", async (req, res) => {
  try {
    const uid = req.user.uid;
    const projectId = req.params.id;

    const projectRef = db.collection("users").doc(uid).collection("portfolio").doc(projectId);
    const projectDoc = await projectRef.get();

    if (!projectDoc.exists) {
      return res.status(404).json({ error: "Portfolio project not found" });
    }

    await projectRef.delete();

    res.status(200).json({ message: "Portfolio project deleted successfully" });
  } catch (err) {
    console.error("Error deleting portfolio project:", err);
    res.status(500).json({ error: "Failed to delete portfolio project", details: err.message });
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

    const validJobTypes = ["Remote", "On-site", "Hybrid"];
    for (const jobType of jobTypes) {
      if (!validJobTypes.includes(jobType)) {
        return res.status(400).json({ error: `Invalid jobType value. Valid options are: ${validJobTypes.join(", ")}` });
      }
    }

    const preferencesData = {
      jobCategories,
      locations,
      salaryExpectation,
      jobTypes,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };

    const preferencesRef = db.collection("users").doc(uid).collection("preferences").doc("default");
    await preferencesRef.set(preferencesData);

    res.status(201).json({
      id: "default",
      message: "Preferences added/updated successfully",
      preferences: preferencesData,
    });

  } catch (err) {
    console.error("Error adding preferences:", err);
    res.status(500).json({ error: "Failed to add preferences", details: err.message });
  }
});

// GET /preferences - ambil preferences user
app.get("/preferences", async (req, res) => {
  try {
    const uid = req.user.uid;
    const doc = await db.collection("users").doc(uid).collection("preferences").doc("default").get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Preferences not found" });
    }

    res.json({ id: doc.id, preferences: doc.data() });

  } catch (err) {
    console.error("Error getting preferences:", err);
    res.status(500).json({ error: "Failed to get preferences", details: err.message });
  }
});

// PATCH /preferences - update preferences user
app.patch("/preferences", async (req, res) => {
  try {
    const uid = req.user.uid;
    const { jobCategories, locations, salaryExpectation, jobTypes } = req.body;

    // Validasi input
    if (!Array.isArray(jobCategories) || !Array.isArray(locations) || !Array.isArray(jobTypes)) {
      return res.status(400).json({ error: "jobCategories, locations, and jobTypes must be arrays" });
    }

    const validJobTypes = ["Remote", "On-site", "Hybrid"];
    for (const jobType of jobTypes) {
      if (!validJobTypes.includes(jobType)) {
        return res.status(400).json({ error: `Invalid jobType value. Valid options are: ${validJobTypes.join(", ")}` });
      }
    }

    const preferencesRef = db.collection("users").doc(uid).collection("preferences").doc("default");
    const doc = await preferencesRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Preferences not found" });
    }

    await preferencesRef.update({
      jobCategories,
      locations,
      salaryExpectation,
      jobTypes,
      updatedAt: FieldValue.serverTimestamp(),
    });

    res.json({ message: "Preferences updated successfully" });

  } catch (err) {
    console.error("Error updating preferences:", err);
    res.status(500).json({ error: "Failed to update preferences", details: err.message });
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

app.delete("/upload-document/:documentId", async (req, res) => {
  try {
    const uid = req.user.uid;
    const documentId = req.params.documentId;

    const documentRef = db.collection("users").doc(uid).collection("documents").doc(documentId);
    const documentSnap = await documentRef.get();

    if (!documentSnap.exists) {
      return res.status(404).json({ error: "Document not found" });
    }

    const fileUrl = documentSnap.data().fileUrl;
    if (fileUrl) {
      try {
        // Extract file path from public URL
        // URL format: https://storage.googleapis.com/{bucket.name}/documents/uid-timestamp.pdf
        const filePath = decodeURIComponent(fileUrl.split(`https://storage.googleapis.com/${bucket.name}/`)[1]);
        await bucket.file(filePath).delete();
      } catch (err) {
        console.error("Error deleting file from storage:", err);
        // Don't block delete if storage delete fails
      }
    }

    // Delete document reference from Firestore
    await documentRef.delete();

    res.status(200).json({ message: "Document deleted successfully" });
  } catch (err) {
    console.error("Error deleting document:", err);
    res.status(500).json({ error: "Failed to delete document", details: err.message });
  }
});



app.get("/profile-resume", async (req, res) => {
  try {
    const uid = req.user.uid;

    // Ambil informasi dasar user (personal info)
    const userDoc = await db.collection("users").doc(uid).collection("user_personal").doc("info").get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: "User profile not found" });
    }

    const userData = userDoc.data();
    
    // Ambil data pendidikan
    const educationSnapshot = await db.collection("users").doc(uid).collection("education").get();
    const education = educationSnapshot.docs.map(doc => doc.data());

    // Ambil data pengalaman kerja
    const experienceSnapshot = await db.collection("users").doc(uid).collection("experience").get();
    const experience = experienceSnapshot.docs.map(doc => doc.data());

    // Ambil data hard skills
    const hardSkillsSnapshot = await db.collection("users").doc(uid).collection("hard-skills").get();
    const hardSkills = hardSkillsSnapshot.docs.map(doc => doc.data());

    // Ambil data soft skills
    const softSkillsSnapshot = await db.collection("users").doc(uid).collection("soft-skills").get();
    const softSkills = softSkillsSnapshot.docs.map(doc => doc.data());

    // Ambil data portofolio
    const portfolioSnapshot = await db.collection("users").doc(uid).collection("portfolio").get();
    const portfolio = portfolioSnapshot.docs.map(doc => doc.data());

    // Data yang akan dikembalikan
    const profileData = {
      fullName: userData.fullName || null,
      phoneNumber: userData.phoneNumber || null,
      city: userData.city || null,
      linkedin: userData.linkedin || null,
      github: userData.github || null,
      instagram: userData.instagram || null,
      portfolioSite: userData.portfolioSite || null,
      photoUrl: userData.photoUrl || null, // Foto profil

      education,
      experience,
      hardSkills,
      softSkills,
      portfolio,
    };

    res.status(200).json(profileData);
  } catch (err) {
    console.error("Error fetching profile:", err);
    res.status(500).json({
      error: "Failed to fetch profile",
      details: err.message,
    });
  }
});

app.post("/bookmarks", async (req, res) => {
  try {
    const userId = req.user.uid;
    const { jobId } = req.body;

    if (!jobId) {
      return res.status(400).json({ error: "Missing jobId" });
    }

    const bookmarksRef = db.collection("users").doc(userId).collection("bookmarks");

    const bookmarkData = {
      jobId,
      bookmarkedAt: FieldValue.serverTimestamp(),
    };

    const docRef = await bookmarksRef.add(bookmarkData);

    res.status(201).json({
      id: docRef.id,
      message: "Bookmark added successfully",
      bookmark: bookmarkData,
    });
  } catch (err) {
    console.error("Error adding bookmark:", err);
    res.status(500).json({ error: "Failed to add bookmark", details: err.message });
  }
});

app.get("/bookmarks", async (req, res) => {
  try {
    const userId = req.user.uid;

    const bookmarksSnap = await db.collection("users")
      .doc(userId)
      .collection("bookmarks")
      .orderBy("bookmarkedAt", "desc")
      .get();

    const bookmarks = bookmarksSnap.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.status(200).json({ bookmarks });
  } catch (err) {
    console.error("Error getting bookmarks:", err);
    res.status(500).json({ error: "Failed to get bookmarks", details: err.message });
  }
});

app.delete("/bookmarks/:id", async (req, res) => {
  try {
    const userId = req.user.uid;
    const bookmarkId = req.params.id;

    const docRef = db.collection("users").doc(userId).collection("bookmarks").doc(bookmarkId);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Bookmark not found" });
    }

    await docRef.delete();

    res.status(200).json({ message: "Bookmark deleted successfully" });
  } catch (err) {
    console.error("Error deleting bookmark:", err);
    res.status(500).json({ error: "Failed to delete bookmark", details: err.message });
  }
});

app.delete("/bookmarked/:jobId", async (req, res) => {
  try {
    const userId = req.user.uid; // Get the user ID from the authenticated user
    const jobId = req.params.jobId; // Get the job ID from the URL params

    // Reference to the user's bookmarks collection in Firestore
    const bookmarksRef = db.collection("users").doc(userId).collection("bookmarks");

    // Find the bookmark document based on the jobId
    const snapshot = await bookmarksRef.where("jobId", "==", jobId).get();

    // If no bookmark is found for the jobId
    if (snapshot.empty) {
      return res.status(404).json({ error: "Bookmark not found" });
    }

    // Delete each bookmark found for the specified jobId
    snapshot.forEach(async (doc) => {
      await doc.ref.delete();
    });

    res.status(200).json({ message: "Bookmark(s) deleted successfully" });
  } catch (err) {
    console.error("Error deleting bookmark:", err);
    res.status(500).json({ error: "Failed to delete bookmark", details: err.message });
  }
});

app.post("/applications", async (req, res) => {
  try {
    const userId = req.user.uid;
    const {
      jobId,
      resumeFile, // Base64 encoded file string
      coverLetter = "",
      notes = ""
    } = req.body;

    if (!jobId) {
      return res.status(400).json({ error: "Missing jobId" });
    }

    if (!resumeFile) {
      return res.status(400).json({ error: "Resume file is required" });
    }

    // Check if the user has already applied for this job
    const existingApplication = await db.collection("users")
      .doc(userId)
      .collection("applications")
      .where("jobId", "==", jobId)
      .get();

    if (!existingApplication.empty) {
      return res.status(400).json({ error: "You have already applied for this job." });
    }

    // Decode the base64 string for the resume
    const buffer = Buffer.from(resumeFile, 'base64');
    
    // Create a unique file name for the resume
    const fileName = `resumes/${userId}-${Date.now()}.pdf`; // Assuming PDF format
    const bucketFile = bucket.file(fileName);

    // Upload the resume file to Firebase Storage
    await bucketFile.save(buffer, {
      metadata: {
        contentType: 'application/pdf', // Assuming it's a PDF
      },
      public: true, // Make the file publicly accessible
    });

    // Get the public URL of the uploaded file
    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${encodeURIComponent(fileName)}`;

    // Prepare the application data
    const applicationData = {
      jobId,
      appliedAt: FieldValue.serverTimestamp(),
      status: "pending", // Default status
      resumeUrl: publicUrl, // Store the public URL of the resume
      coverLetter,
      notes,
    };

    // Save the application data in Firestore
    const applicationsRef = db.collection("users").doc(userId).collection("applications");
    const docRef = await applicationsRef.add(applicationData);

    res.status(201).json({
      id: docRef.id,
      message: "Application submitted successfully",
      application: applicationData,
    });
  } catch (err) {
    console.error("Error submitting application:", err);
    res.status(500).json({ error: "Failed to submit application", details: err.message });
  }
});



app.get("/applications", async (req, res) => {
  try {
    const userId = req.user.uid;

    const applicationsSnap = await db.collection("users")
      .doc(userId)
      .collection("applications")
      .orderBy("appliedAt", "desc")
      .get();

    const applications = applicationsSnap.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.status(200).json({ applications });
  } catch (err) {
    console.error("Error getting applications:", err);
    res.status(500).json({ error: "Failed to get applications", details: err.message });
  }
});

// Endpoint DELETE /applications/:applicationId
app.delete("/applications/:applicationId", async (req, res) => {
  try {
    const userId = req.user.uid; // Asumsikan req.user.uid sudah ada
    const { applicationId } = req.params;

    if (!applicationId) {
      return res.status(400).json({ error: "Missing applicationId" });
    }

    const applicationRef = db.collection("users").doc(userId).collection("applications").doc(applicationId);
    const applicationDoc = await applicationRef.get();

    if (!applicationDoc.exists) {
      return res.status(404).json({ error: "Application not found" });
    }

    const applicationData = applicationDoc.data();
    const resumeFileName = applicationData.resumeFileName; // Mengambil nama file dari Firestore

    // Hapus file resume dari Firebase Storage jika resumeFileName ada
    if (resumeFileName) {
      const bucketFile = bucket.file(resumeFileName); // resumeFileName sudah termasuk path seperti 'resumes/...'
      try {
        await bucketFile.delete();
        console.log(`Successfully deleted ${resumeFileName} from storage.`);
      } catch (storageError) {
        // Log error jika file tidak ditemukan atau ada masalah lain, tapi lanjutkan proses penghapusan dokumen Firestore
        console.error(`Failed to delete ${resumeFileName} from storage:`, storageError.message);
        if (storageError.code === 404 || storageError.message.includes("No such object")) {
            console.warn(`File ${resumeFileName} not found in storage, but proceeding to delete Firestore record.`);
        } else {
            // Untuk error lain, Anda mungkin ingin mengembalikan error atau menanganinya secara berbeda
            // return res.status(500).json({ error: "Failed to delete resume file from storage", details: storageError.message });
        }
      }
    } else {
        console.warn(`No resumeFileName found for application ${applicationId}. Skipping storage deletion.`);
    }

    // Hapus dokumen lamaran dari Firestore
    await applicationRef.delete();

    res.status(200).json({ message: "Application cancelled and data deleted successfully", id: applicationId });

  } catch (err) {
    console.error("Error cancelling application:", err);
    res.status(500).json({ error: "Failed to cancel application", details: err.message });
  }
});

// Deploy sebagai one-off Cloud Function
exports.app = functions.https.onRequest(app);
