
import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage'; // 1. Import Storage

// const firebaseConfig = {
//   apiKey: "AIzaSyBaO721WavYj0xnGVhg6x1ciqStbj_uUi0",
//   authDomain: "pms-om-jagruti-7bfbd.firebaseapp.com",
//   projectId: "pms-om-jagruti-7bfbd",
//   storageBucket: "pms-om-jagruti-7bfbd.firebasestorage.app",
//   messagingSenderId: "495010276674",
//   appId: "1:495010276674:web:3ec32c5ddb9285c88714db",
//   measurementId: "G-LB7PBHVJS4"
// };

const firebaseConfig = {
  apiKey: import.meta.env.VITE_API_KEY,
  authDomain: import.meta.env.VITE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_APP_ID,
  measurementId: import.meta.env.VITE_MEASUREMENT_ID
};

// Initialize Firebase
let app;
let auth;
let db;
let storage; // 2. Define storage variable
let googleProvider;

try {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  storage = getStorage(app); // 3. Initialize Storage
  googleProvider = new GoogleAuthProvider();
} catch (error) {
  console.error('Firebase initialization error:', error);
}

// 4. Export storage
export { auth, db, storage, googleProvider, firebaseConfig };
export default app;