import express from 'express';
import crypto from 'crypto';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import nodemailer from 'nodemailer';
import { google } from 'googleapis';
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

// ── Shared Mail Transporter ──
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER || 'ommurkar34@gmail.com',
    pass: process.env.EMAIL_PASS,
  },
  tls: {
    rejectUnauthorized: false
  }
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', 1);

// ── SECURITY FIX: Restrict CORS to known origins instead of wildcard ──
const allowedOrigins = [
  'http://localhost:5173',  // Vite dev server
  'http://localhost:4173',  // Vite preview
  'https://nextsolvespms.onrender.com', // Live frontend (solves)
  'https://nextslovespms.onrender.com', // Live frontend (sloves)
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
    return res.status(503).json({ error: 'Service temporarily unavailable.' });
  }

  const emailClean = email.trim().toLowerCase();

  try {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 5 * 60 * 1000;
    otpStore.set(emailClean, { otp, expiresAt, attempts: 0 });

    // 1. Authenticate with Google OAuth2
    const oauth2Client = new google.auth.OAuth2(
      process.env.OAUTH_CLIENTID,
      process.env.OAUTH_CLIENT_SECRET,
      "https://developers.google.com/oauthplayground"
    );

    oauth2Client.setCredentials({
      refresh_token: process.env.OAUTH_REFRESH_TOKEN
    });

    // 2. Initialize the Gmail API client
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // 3. Construct the email raw string (RFC 2822 format)
    const subject = 'Your Practical Management System Activation Code';
    const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;
    const messageParts = [
      `From: "PMS Activation" <ommurkar34@gmail.com>`,
      `To: ${emailClean}`,
      'Content-Type: text/html; charset=utf-8',
      'MIME-Version: 1.0',
      `Subject: ${utf8Subject}`,
      '',
      `<div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px; border: 1px solid #e0e0e0;">`,
      `  <h2 style="color: #4F46E5;">PMS Account Activation</h2>`,
      `  <p>Use the following One-Time Password (OTP) to complete your registration. This code is valid for 5 minutes.</p>`,
      `  <div style="background-color: #F3F4F6; padding: 15px; font-size: 24px; font-weight: bold; letter-spacing: 4px; text-align: center; color: #1F2937; margin: 20px 0;">`,
      `    ${otp}`,
      `  </div>`,
      `</div>`
    ];
    const message = messageParts.join('\r\n');

    // 4. Encode the message to base64url format
    const encodedMessage = Buffer.from(message)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    // 5. Send via HTTPS POST request (Bypasses Render's SMTP Firewall)
    await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedMessage,
      },
    });

    console.log(`📧 OTP sent successfully via HTTPS to ${emailClean}`);
    res.json({ message: 'OTP sent successfully' });
    
  } catch (error) {
    console.error('🔥 Gmail API Error:', error);
    res.status(500).json({ error: 'Failed to send OTP email via HTTPS API.' });
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
    // Exact error message required by specification
    return res.status(400).json({ error: 'Expired OTP, please request a new one.' });
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

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/product-keys/:id — called by Super Admin dashboard trash icon
// ─────────────────────────────────────────────────────────────────────────────
app.delete('/api/product-keys/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'Missing key document ID' });
    await adminDb.collection('product_keys').doc(id).delete();
    console.log(`Key deleted: ${id}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Key deletion error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/product-keys/validate-and-send-otp
// Combines key validation + OTP dispatch into a single round-trip for speed.
// Called by the new AdminActivation.jsx Step 1.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/product-keys/validate-and-send-otp', otpSendLimiter, async (req, res) => {
  const { productKey, adminEmail } = req.body;
  if (!productKey || !adminEmail) {
    return res.status(400).json({ error: 'Missing productKey or adminEmail' });
  }

  try {
    // 1. Validate the key (same logic as /api/product-keys/validate)
    const snapshot = await adminDb.collection('product_keys')
      .where('productKey', '==', productKey)
      .where('isActivated', '==', false)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.status(404).json({ error: 'Invalid key' });
    }

    const keyDoc = snapshot.docs[0];
    const data = keyDoc.data();

    // 2. Verify submitted email is the PRIMARY admin email only.
    //    Secondary email is NOT permitted to activate a product key.
    const emailLower = adminEmail.trim().toLowerCase();
    if (data.adminEmail?.toLowerCase() !== emailLower) {
      // Detect if they tried the secondary email so we can return a specific notice
      if (data.secondaryEmail?.toLowerCase() === emailLower) {
        return res.status(400).json({ error: 'SECONDARY_EMAIL_BLOCKED' });
      }
      return res.status(400).json({ error: 'Email does not match the registered key' });
    }

    // 3. Generate and store OTP (60-second window)
    if (otpStore.size >= MAX_OTP_STORE_SIZE) {
      return res.status(503).json({ error: 'Service temporarily unavailable.' });
    }
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    // OTP is valid for 60 seconds (1 minute)
    const expiresAt = Date.now() + 60 * 1000;
    otpStore.set(emailLower, { otp, expiresAt, attempts: 0 });

    // 4. Send OTP via NodeMailer
    const htmlContent = `
      <div style="font-family:Arial,sans-serif;padding:20px;max-width:600px;border:1px solid #e0e0e0;border-radius:8px">
        <h2 style="color:#8b0000">PMS Account Activation</h2>
        <p>Your one-time activation code is valid for <strong>60 seconds</strong>:</p>
        <div style="background:#1a0a2e;color:#fbbf24;padding:20px;font-size:28px;font-weight:bold;letter-spacing:8px;text-align:center;border-radius:8px;margin:20px 0">${otp}</div>
        <p style="font-size:12px;color:#888">If you didn't request this, please ignore this email.</p>
      </div>
    `;

    await transporter.sendMail({
      from: `"PMS Activation" <${process.env.EMAIL_USER || 'ommurkar34@gmail.com'}>`,
      to: emailLower,
      subject: 'Your PMS Activation Code',
      html: htmlContent,
    });
    console.log(`📧 Batched OTP sent to ${emailLower}`);

    // 5. Return key metadata (so frontend doesn't need a second call)
    res.json({
      success: true,
      docId: keyDoc.id,
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
    console.error('validate-and-send-otp error:', err.message);
    res.status(500).json({ error: 'Verification failed. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/send-activation-email
// Sends a "Thank You" confirmation email with the activation key after success.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/send-activation-email', async (req, res) => {
  const { email, collegeName, productKey } = req.body;
  if (!email || !collegeName || !productKey) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Sanitize college name to prevent HTML injection
  const safeCollegeName = String(collegeName)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;').substring(0, 200);
  const safeKey = String(productKey).replace(/[^A-Z0-9\-]/g, '').substring(0, 60);

  try {
    const htmlContent = `
      <div style="font-family:Arial,sans-serif;padding:32px;max-width:620px;border:1px solid #e0e0e0;border-radius:12px">
        <div style="text-align:center;margin-bottom:24px">
          <div style="font-size:48px">✅</div>
          <h1 style="color:#1a0a2e;font-size:22px;margin:12px 0 4px">Your Key Has Been Activated!</h1>
          <p style="color:#666;font-size:14px">Welcome to the Practical Management System</p>
        </div>
        <hr style="border:none;border-top:1px solid #eee;margin:20px 0"/>
        <p style="color:#333;font-size:15px">Dear <strong>${safeCollegeName}</strong> Admin,</p>
        <p style="color:#555;font-size:14px;line-height:1.7">
          Thank you for activating your Practical Management System account. Your institution is now fully set up and ready to manage practical examinations seamlessly.
        </p>
        <div style="background:#f9f4ff;border:1px solid #8b000033;border-radius:8px;padding:16px 20px;margin:24px 0">
          <p style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px;margin:0 0 6px">Your Validation Key</p>
          <div style="font-family:monospace;font-size:20px;font-weight:bold;color:#8b0000;letter-spacing:3px">${safeKey}</div>
          <p style="font-size:11px;color:#aaa;margin:8px 0 0">Keep this key safe. You may need it for future support requests.</p>
        </div>
        <p style="color:#555;font-size:14px;line-height:1.7">If you need any help, please contact your system administrator.</p>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
        <p style="color:#999;font-size:12px;text-align:center">Practical Management System &mdash; Built for Educators</p>
      </div>
    `;

    await transporter.sendMail({
      from: `"PMS Team" <${process.env.EMAIL_USER || 'ommurkar34@gmail.com'}>`,
      to: email.trim().toLowerCase(),
      subject: 'Welcome to PMS — Your Key Has Been Activated!',
      html: htmlContent,
    });
    console.log(`📧 Activation success email sent to ${email}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Activation email error:', err.message);
    // Non-fatal — activation already succeeded; don't fail the request
    res.status(500).json({ error: 'Email send failed, but activation succeeded.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SECONDARY ADMIN CREDENTIAL MANAGEMENT
// 4-step HMAC-JWT gated flow:
//   Step 1: verify-primary-password  → issues flowToken
//   Step 2: send-otp                 → sends OTP to secondaryEmail
//   Step 3: verify-otp               → issues setPasswordToken
//   Step 4: set-password             → creates/updates Firebase Auth + Firestore
// Each token is short-lived and encodes which step was completed.
// The frontend CANNOT skip any step — the backend token chain enforces sequence.
// ─────────────────────────────────────────────────────────────────────────────

const FLOW_JWT_SECRET = process.env.FLOW_JWT_SECRET || crypto.randomBytes(32).toString('hex');

// ── Minimal stateless JWT helpers (HMAC-SHA256, no external lib) ──
const signFlowToken = (payload, expiresInMs) => {
  const exp = Date.now() + expiresInMs;
  const data = JSON.stringify({ ...payload, exp });
  const sig = crypto.createHmac('sha256', FLOW_JWT_SECRET).update(data).digest('hex');
  return Buffer.from(JSON.stringify({ data, sig })).toString('base64url');
};

const verifyFlowToken = (token) => {
  try {
    const { data, sig } = JSON.parse(Buffer.from(token, 'base64url').toString());
    const expectedSig = crypto.createHmac('sha256', FLOW_JWT_SECRET).update(data).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expectedSig, 'hex'))) {
      throw new Error('Invalid token signature');
    }
    const payload = JSON.parse(data);
    if (Date.now() > payload.exp) throw new Error('Token expired');
    return payload;
  } catch (err) {
    throw new Error('Invalid or expired token: ' + err.message);
  }
};

// ── Rate limiter for secondary admin endpoints (5 req / 15 min per IP) ──
const secondaryAdminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait before retrying.' },
});

// ── Helper: Verify Firebase password via Identity Toolkit REST API ──
// Firebase Admin SDK does not expose a verifyPassword method, so we use
// the public sign-in REST endpoint — the same one the client SDK calls.
const verifyFirebasePassword = async (email, password) => {
  const apiKey = process.env.VITE_API_KEY;
  if (!apiKey) throw new Error('Server configuration error: missing API key.');

  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: false }),
  });
  const json = await resp.json();
  if (!resp.ok) {
    const code = json?.error?.message || 'INVALID_CREDENTIAL';
    if (code.includes('INVALID_PASSWORD') || code.includes('INVALID_LOGIN_CREDENTIALS') || code.includes('INVALID_CREDENTIAL')) {
      throw new Error('auth/invalid-credential');
    }
    throw new Error(code);
  }
  return json; // contains localId (uid)
};

// ── STEP 1: Verify Primary Admin password ──────────────────────────────────
app.post('/api/secondary-admin/verify-primary-password', secondaryAdminLimiter, async (req, res) => {
  const { primaryEmail, primaryPassword } = req.body;
  if (!primaryEmail || !primaryPassword) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    // 1a. Verify password via Firebase Identity Toolkit
    const firebaseResp = await verifyFirebasePassword(primaryEmail.trim().toLowerCase(), primaryPassword);
    const uid = firebaseResp.localId;

    // 1b. Confirm this user is actually a primary admin in Firestore
    const adminDoc = await adminDb.collection('admin_users').doc(uid).get();
    if (!adminDoc.exists || adminDoc.data().role !== 'admin') {
      return res.status(403).json({ error: 'Access denied. User is not a registered admin.' });
    }

    const tenantId = adminDoc.data().tenantId;
    if (!tenantId) {
      return res.status(400).json({ error: 'Admin account has no associated institution.' });
    }

    // 1c. Issue flowToken — 5 minute TTL
    const flowToken = signFlowToken(
      { step: 'password_verified', tenantId, primaryEmail: primaryEmail.trim().toLowerCase(), uid },
      5 * 60 * 1000
    );

    console.log(`[SecondaryAdmin] Step 1 passed for ${primaryEmail}`);
    res.json({ success: true, flowToken });

  } catch (err) {
    if (err.message === 'auth/invalid-credential') {
      return res.status(401).json({ error: 'Invalid password. Access denied.' });
    }
    console.error('[SecondaryAdmin] Step 1 error:', err.message);
    res.status(500).json({ error: 'Verification failed. Please try again.' });
  }
});

// ── STEP 2: Send OTP to Secondary Admin's email ────────────────────────────
app.post('/api/secondary-admin/send-otp', secondaryAdminLimiter, async (req, res) => {
  const { flowToken } = req.body;
  if (!flowToken) return res.status(400).json({ error: 'Missing flow token.' });

  try {
    const payload = verifyFlowToken(flowToken);
    if (payload.step !== 'password_verified') {
      return res.status(400).json({ error: 'Invalid flow state. Please restart.' });
    }

    const { tenantId } = payload;

    // 2a. Fetch secondaryEmail from product_keys for this tenant
    const keysSnap = await adminDb.collection('product_keys')
      .where('tenantId', '==', tenantId)
      .limit(1)
      .get();

    if (keysSnap.empty) {
      return res.status(404).json({ error: 'No product key found for this institution.' });
    }

    const keyData = keysSnap.docs[0].data();
    const secondaryEmail = keyData.secondaryEmail?.trim().toLowerCase();

    if (!secondaryEmail) {
      return res.status(404).json({
        error: 'No secondary admin email is registered for this institution. Please contact the system founder to register one.',
      });
    }

    // 2b. Generate OTP and store it (60 second window)
    if (otpStore.size >= MAX_OTP_STORE_SIZE) {
      return res.status(503).json({ error: 'Service temporarily unavailable.' });
    }
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 60 * 1000;
    const otpKey = `secondary_admin_otp:${tenantId}`;
    otpStore.set(otpKey, { otp, expiresAt, attempts: 0 });

    // 2c. Send OTP to secondary admin email
    const htmlContent = `
      <div style="font-family:Arial,sans-serif;padding:28px;max-width:580px;border:1px solid #e0e0e0;border-radius:10px">
        <h2 style="color:#1a0a2e">PMS Secondary Admin Password Setup</h2>
        <p>The Primary Admin of your institution is setting up a password for your account.</p>
        <p>Share the following one-time code with them to confirm you consent to this action:</p>
        <div style="background:#1a0a2e;color:#fbbf24;padding:20px;font-size:32px;font-weight:bold;letter-spacing:10px;text-align:center;border-radius:8px;margin:20px 0">${otp}</div>
        <p style="color:#e53e3e;font-weight:600">⚠ This code expires in <strong>60 seconds</strong>.</p>
        <p style="font-size:12px;color:#888">If you did not request this, please ignore this email and contact your system founder immediately.</p>
      </div>
    `;

    await transporter.sendMail({
      from: `"PMS System" <${process.env.EMAIL_USER || 'ommurkar34@gmail.com'}>`,
      to: secondaryEmail,
      subject: 'PMS: Secondary Admin Password Setup OTP',
      html: htmlContent,
    });

    console.log(`[SecondaryAdmin] Step 2: OTP sent to ${secondaryEmail} for tenant ${tenantId}`);

    // 2d. Issue new flowToken encoding step 2 completion (carries otpKey so step 3 can look it up)
    const otpSentToken = signFlowToken(
      { step: 'otp_sent', tenantId, otpKey, secondaryEmail, primaryEmail: payload.primaryEmail },
      2 * 60 * 1000 // 2 min window (generous given 60s OTP)
    );

    // Mask secondary email for privacy (show only partial)
    const parts = secondaryEmail.split('@');
    const masked = parts[0].slice(0, 3) + '***@' + parts[1];

    res.json({ success: true, otpSentToken, maskedEmail: masked });

  } catch (err) {
    console.error('[SecondaryAdmin] Step 2 error:', err.message);
    res.status(400).json({ error: err.message || 'Failed to send OTP.' });
  }
});

// ── STEP 3: Verify OTP ────────────────────────────────────────────────────
app.post('/api/secondary-admin/verify-otp', secondaryAdminLimiter, async (req, res) => {
  const { otpSentToken, otp } = req.body;
  if (!otpSentToken || !otp) {
    return res.status(400).json({ error: 'Missing token or OTP.' });
  }

  try {
    const payload = verifyFlowToken(otpSentToken);
    if (payload.step !== 'otp_sent') {
      return res.status(400).json({ error: 'Invalid flow state. Please restart.' });
    }

    const { otpKey, tenantId, secondaryEmail, primaryEmail } = payload;

    // 3a. Validate OTP from store
    const record = otpStore.get(otpKey);
    if (!record) {
      return res.status(400).json({ error: 'OTP has expired or was already used. Please restart.' });
    }
    if (Date.now() > record.expiresAt) {
      otpStore.delete(otpKey);
      return res.status(400).json({ error: 'OTP expired. Please restart the flow.' });
    }
    if (record.attempts >= 5) {
      otpStore.delete(otpKey);
      return res.status(429).json({ error: 'Too many incorrect attempts. Please restart.' });
    }
    if (record.otp !== otp.trim()) {
      record.attempts += 1;
      return res.status(400).json({
        error: `Incorrect OTP. ${5 - record.attempts} attempt(s) remaining.`,
      });
    }

    // 3b. OTP correct — consume it
    otpStore.delete(otpKey);

    // 3c. Issue setPasswordToken — 5 minute TTL
    const setPasswordToken = signFlowToken(
      { step: 'otp_verified', tenantId, secondaryEmail, primaryEmail },
      5 * 60 * 1000
    );

    console.log(`[SecondaryAdmin] Step 3: OTP verified for tenant ${tenantId}`);
    res.json({ success: true, setPasswordToken });

  } catch (err) {
    console.error('[SecondaryAdmin] Step 3 error:', err.message);
    res.status(400).json({ error: err.message || 'OTP verification failed.' });
  }
});

// ── STEP 4: Set Secondary Admin Password ───────────────────────────────────
app.post('/api/secondary-admin/set-password', secondaryAdminLimiter, async (req, res) => {
  const { setPasswordToken, newPassword } = req.body;
  if (!setPasswordToken || !newPassword) {
    return res.status(400).json({ error: 'Missing token or password.' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  try {
    const payload = verifyFlowToken(setPasswordToken);
    if (payload.step !== 'otp_verified') {
      return res.status(400).json({ error: 'Invalid flow state. Please restart.' });
    }

    const { tenantId, secondaryEmail } = payload;
    const adminAuth = (await import('firebase-admin/auth')).getAuth();

    // 4a. Create or update Firebase Auth account for secondaryEmail
    let uid;
    try {
      const existingUser = await adminAuth.getUserByEmail(secondaryEmail);
      uid = existingUser.uid;
      // Update password for existing account
      await adminAuth.updateUser(uid, { password: newPassword });
      console.log(`[SecondaryAdmin] Updated auth password for existing user: ${secondaryEmail}`);
    } catch (notFoundErr) {
      if (notFoundErr.code === 'auth/user-not-found') {
        // Create brand-new Firebase Auth account
        const newUser = await adminAuth.createUser({
          email: secondaryEmail,
          password: newPassword,
          emailVerified: true,
        });
        uid = newUser.uid;
        console.log(`[SecondaryAdmin] Created new auth account for: ${secondaryEmail}`);
      } else {
        throw notFoundErr;
      }
    }

    // 4b. Upsert admin_users/{uid} with role:'admin' so AdminLogin.jsx accepts them
    await adminDb.collection('admin_users').doc(uid).set({
      email: secondaryEmail,
      role: 'admin',
      tenantId,
      isSecondaryAdmin: true,
      passwordSetAt: (await import('firebase-admin/firestore')).FieldValue.serverTimestamp(),
    }, { merge: true });

    console.log(`[SecondaryAdmin] Step 4 complete. Secondary admin provisioned: ${secondaryEmail} (uid: ${uid}) for tenant: ${tenantId}`);
    res.json({ success: true });

  } catch (err) {
    console.error('[SecondaryAdmin] Step 4 error:', err.message);
    res.status(500).json({ error: 'Failed to set password: ' + err.message });
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