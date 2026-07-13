import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit'; // SECURITY FIX E-1, H-1
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

dotenv.config();

// ── Firebase Admin SDK (bypasses all Firestore security rules) ──
if (getApps().length === 0) {
  initializeApp({
    credential: cert({
      projectId: process.env.VITE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}
const adminDb = getFirestore();


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', 1);

// ── SECURITY FIX: Restrict CORS to known origins instead of wildcard ──
const allowedOrigins = [
  'http://localhost:5173',  // Vite dev server
  'http://localhost:4173',  // Vite preview
  'https://nextsolvespms.onrender.com', // Live frontend
  process.env.ALLOWED_ORIGIN, // Production origin from .env
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like Postman or Render health checks)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS: Origin not allowed'));
    }
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'x-folder-path'],
  credentials: true
}));
app.use(express.json());

// ── SECURITY FIX D-2: Restrict all uploads to a safe base directory ──
const UPLOAD_BASE = path.resolve(__dirname, 'uploads');

// 1. Upload Logic
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      const teacherPath = req.headers['x-folder-path'];
      if (!teacherPath) return cb(new Error('Missing x-folder-path header'));

      // ── SECURITY FIX D-2 ──
      // Strip any directory traversal from the path by using only the basename.
      // Then join it with the safe UPLOAD_BASE to prevent writing outside ./uploads/
      const safeSegment = path.basename(decodeURIComponent(teacherPath).replace(/[\"']/g, '').trim());
      const safePath = path.join(UPLOAD_BASE, safeSegment);

      // Double-check the resolved path is still inside UPLOAD_BASE
      if (!safePath.startsWith(UPLOAD_BASE)) {
        return cb(new Error('[Security] Path traversal attempt blocked'));
      }

      await fs.ensureDir(safePath);
      console.log(`📂 Saving to: ${safePath}`);
      cb(null, safePath);
    } catch (err) {
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, safeName);
  }
});

const upload = multer({ storage: storage });

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  console.log(`✅ Uploaded: ${req.file.filename}`);
  // Return only filename, not the full server path (avoid path disclosure)
  res.json({ message: 'Success', filename: req.file.filename });
});

// ── SECURITY FIX D-1: Restrict /api/preview to the uploads directory only ──
app.get('/api/preview', (req, res) => {
  const filePath = req.query.path;

  if (!filePath) {
    return res.status(400).send('No file path provided.');
  }

  // Resolve the requested path and verify it's within UPLOAD_BASE
  const resolvedPath = path.resolve(filePath);
  if (!resolvedPath.startsWith(UPLOAD_BASE)) {
    console.warn(`[Security] Path traversal attempt on /api/preview: "${filePath}" from ${req.ip}`);
    return res.status(403).send('Access denied.');
  }

  if (!fs.existsSync(resolvedPath)) {
    return res.status(404).send('File not found on server.');
  }

  res.sendFile(resolvedPath);
});

// 3. OTP VERIFICATION ENDPOINTS
// In-memory store for OTPs: { email: { otp, expiresAt, attempts } }
const otpStore = new Map();

// ── SECURITY FIX E-2: Evict expired entries every 60 seconds ──
const MAX_OTP_STORE_SIZE = 10000;
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of otpStore.entries()) {
    if (now > val.expiresAt) otpStore.delete(key);
  }
}, 60 * 1000);

// ── SECURITY FIX E-1: Rate limit OTP send (3 per minute per IP) ──
const otpSendLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many OTP requests. Please wait a minute before trying again.' },
});

// ── SECURITY FIX H-1: Rate limit OTP verify (10 per 15 minutes per IP) ──
const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verification attempts. Please try again later.' },
});

// ── SECURITY FIX H-1: Rate limit reminder emails (1 per 5 minutes per IP) ──
const reminderLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many reminder requests. Please wait before retrying.' },
});

app.post('/api/send-otp', otpSendLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  // ── SECURITY FIX E-2: Guard against memory exhaustion ──
  if (otpStore.size >= MAX_OTP_STORE_SIZE) {
    return res.status(503).json({ error: 'Service temporarily unavailable. Please try again shortly.' });
  }

  const emailClean = email.trim().toLowerCase();

  try {
    const otp = Math.floor(100000 + Math.random() * 900000).toString(); // 6 digit OTP
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes validity

    otpStore.set(emailClean, { otp, expiresAt, attempts: 0 }); // SECURITY: track attempts

    if (!process.env.EMAIL_PASS) {
      console.log('\n' + '='.repeat(50));
      console.log('⚠️  EMAIL_PASS not set in .env');
      console.log(`📧  Mock Email sent to: ${email}`);
      console.log(`🔑  YOUR OTP CODE IS: ${otp}`);
      console.log('='.repeat(50) + '\n');
      return res.json({ message: 'OTP sent successfully (Check server console)' });
    }

    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true, // true for port 465
      auth: {
        user: process.env.EMAIL_USER || 'ommurkar34@gmail.com',
        pass: process.env.EMAIL_PASS, // App Password
      },
    });

    const mailOptions = {
      from: `"PMS Activation" <${process.env.EMAIL_USER || 'ommurkar34@gmail.com'}>`,
      to: email,
      subject: 'Your Practical Management System Activation Code',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px; border: 1px solid #ddd; border-radius: 8px;">
          <h2 style="color: #2b6cb0;">Activation Required</h2>
          <p>Hello,</p>
          <p>Please use the following 6-digit code to complete your PMS College Admin registration:</p>
          <div style="background-color: #f7fafc; padding: 16px; text-align: center; font-size: 24px; font-weight: bold; letter-spacing: 4px; color: #2d3748; border-radius: 8px; margin: 20px 0;">
            ${otp}
          </div>
          <p style="color: #718096; font-size: 14px;">This code will expire in 5 minutes. Do not share this code with anyone.</p>
        </div>
      `,
    };

    await transporter.sendMail(mailOptions);
    console.log(`📧 OTP sent to ${email}`);
    res.json({ message: 'OTP sent successfully' });
  } catch (error) {
    console.error('🔥 Error sending email:', error);
    res.status(500).json({ error: 'Failed to send OTP email. Make sure App Password is set in .env' });
  }
});

// ── SECURITY FIX H-1: Reminder email with sanitized template variable ──
app.post('/api/send-reminder', reminderLimiter, async (req, res) => {
  const { email, collegeName, daysLeft } = req.body;
  if (!email || !collegeName || daysLeft === undefined) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Sanitize collegeName to prevent HTML injection in the email body
  const safeCollegeName = String(collegeName)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .substring(0, 200); // Hard cap on length

  try {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true, // true for port 465
      auth: {
        user: process.env.EMAIL_USER || 'ommurkar34@gmail.com',
        pass: process.env.EMAIL_PASS,
      },
    });

    const mailOptions = {
      from: `"PMS Alerts" <${process.env.EMAIL_USER || 'ommurkar34@gmail.com'}>`,
      to: email,
      subject: 'Urgent: PMS Subscription Expiring Soon',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px; border: 1px solid #ddd; border-radius: 8px;">
          <h2 style="color: #e53e3e;">Subscription Expiring Soon</h2>
          <p>Hello ${safeCollegeName} Admin,</p>
          <p>This is a friendly reminder that your Practical Management System subscription is going to end in <strong>${parseInt(daysLeft, 10)} days</strong>.</p>
          <p>Please contact the system founder to renew your subscription and avoid any service interruptions.</p>
          <br/>
          <p style="color: #718096; font-size: 14px;">Regards,<br/>PMS Team</p>
        </div>
      `,
    };

    await transporter.sendMail(mailOptions);
    console.log(`📧 Expiration reminder sent to ${email}`);
    res.json({ message: 'Reminder sent successfully' });
  } catch (error) {
    console.error('🔥 Error sending reminder email:', error);
    res.status(500).json({ error: 'Failed to send reminder email.' });
  }
});

// ── SECURITY FIX E-1: OTP verify with rate limit + attempt counter ──
app.post('/api/verify-otp', otpVerifyLimiter, (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: 'Email and OTP are required' });

  const emailClean = email.trim().toLowerCase();
  const otpClean = otp.trim();

  const record = otpStore.get(emailClean);

  if (!record) {
    return res.status(400).json({ error: 'No OTP requested for this email' });
  }

  if (Date.now() > record.expiresAt) {
    otpStore.delete(emailClean);
    return res.status(400).json({ error: 'OTP has expired. Please request a new one.' });
  }

  // ── SECURITY FIX E-1: Invalidate after 5 failed attempts ──
  if (record.attempts >= 5) {
    otpStore.delete(emailClean);
    return res.status(429).json({ error: 'OTP invalidated after too many failed attempts. Please request a new one.' });
  }

  if (record.otp !== otpClean) {
    record.attempts += 1;
    return res.status(400).json({ error: `Invalid OTP code. ${5 - record.attempts} attempts remaining.` });
  }

  // OTP verified successfully, clear it from memory
  otpStore.delete(emailClean);
  res.json({ message: 'OTP verified successfully' });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN SDK: Product Key Endpoints
// These use Firebase Admin SDK which bypasses ALL Firestore security rules.
// Key generation from the Super Admin dashboard calls these APIs directly.
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/product-keys/create — called by KeyGenerator.jsx
app.post('/api/product-keys/create', async (req, res) => {
  try {
    const keyData = req.body;
    if (!keyData || !keyData.productKey) {
      return res.status(400).json({ error: 'Missing key data' });
    }
    const docRef = adminDb.collection('product_keys').doc();
    await docRef.set({
      ...keyData,
      createdAt: FieldValue.serverTimestamp(),
    });
    console.log(`Key created: ${keyData.productKey} (doc: ${docRef.id})`);
    res.json({ success: true, docId: docRef.id, productKey: keyData.productKey });
  } catch (err) {
    console.error('Key creation error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/product-keys — list all keys for Super Admin dashboard
app.get('/api/product-keys', async (req, res) => {
  try {
    const snapshot = await adminDb.collection('product_keys')
      .orderBy('createdAt', 'desc')
      .get();
    const keys = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ keys });
  } catch (err) {
    console.error('Key listing error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/product-keys/validate?key=PMS-XXXX — validate key for activation page
app.get('/api/product-keys/validate', async (req, res) => {
  try {
    const { key } = req.query;
    if (!key) return res.status(400).json({ error: 'Missing key parameter' });
    const snapshot = await adminDb.collection('product_keys')
      .where('productKey', '==', key)
      .where('isActivated', '==', false)
      .limit(1)
      .get();
    if (snapshot.empty) {
      return res.status(404).json({ error: 'Invalid or already-activated product key.' });
    }
    const doc = snapshot.docs[0];
    const data = doc.data();
    res.json({
      docId: doc.id,
      adminEmail: data.adminEmail,
      secondaryEmail: data.secondaryEmail || null,
      adminPhone: data.adminPhone,
      tenantId: data.tenantId,
      collegeName: data.collegeName,
      collegeCode: data.collegeCode,
      facultyLimit: data.facultyLimit,
      validUntil: data.validUntil,
      facultyEmails: data.facultyEmails || [],
    });
  } catch (err) {
    console.error('Key validation error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/product-keys/activate — burn key and provision tenant
app.post('/api/product-keys/activate', async (req, res) => {
  try {
    const { docId, uid, email, tenantId, collegeName, collegeCode, facultyLimit, validUntil, facultyEmails } = req.body;
    if (!docId || !uid || !tenantId) return res.status(400).json({ error: 'Missing required fields' });

    const keyRef = adminDb.collection('product_keys').doc(docId);
    const adminUserRef = adminDb.collection('admin_users').doc(uid);
    const settingsRef = adminDb.collection('colleges').doc(tenantId).collection('config').doc('settings');

    await adminDb.runTransaction(async (transaction) => {
      const freshKey = await transaction.get(keyRef);
      if (!freshKey.exists) throw new Error('Product key not found.');
      if (freshKey.data().isActivated) throw new Error('Key already activated.');

      transaction.update(keyRef, {
        isActivated: true,
        activatedAt: FieldValue.serverTimestamp(),
      });
      transaction.set(adminUserRef, {
        tenantId, email, role: 'admin',
        createdAt: FieldValue.serverTimestamp(),
      });
      transaction.set(settingsRef, {
        collegeName, collegeCode,
        facultyLimit: parseInt(facultyLimit, 10),
        validUntil, // keep the ISO string for frontend backward compatibility
        subscriptionExpiry: new Date(validUntil), // Firestore Timestamp for security rules
        facultyEmails: facultyEmails || [],
        provisionedAt: FieldValue.serverTimestamp(),
      });
    });

    console.log(`Key activated: ${docId} -> tenant: ${tenantId}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Activation error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Error Handler
app.use((err, req, res, next) => {
  console.error('Server Error:', err.message);
  res.status(500).json({ error: err.message });
});


const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});