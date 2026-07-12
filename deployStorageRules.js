import { initializeApp, cert } from 'firebase-admin/app';
import { getSecurityRules } from 'firebase-admin/security-rules';
import dotenv from 'dotenv';

dotenv.config();

const serviceAccount = {
  projectId: process.env.VITE_PROJECT_ID,
  privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
};

const app = initializeApp({
  credential: cert(serviceAccount),
  storageBucket: process.env.VITE_STORAGE_BUCKET
});

const rulesSource = `
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if true;
    }
  }
}
`;

async function deployRules() {
  try {
    console.log('Deploying Storage rules...');
    
    // Release to the default bucket
    await getSecurityRules(app).releaseStorageRulesetFromSource(rulesSource);
    
    console.log('✅ Storage rules deployed successfully!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error deploying rules:');
    console.error(err);
    process.exit(1);
  }
}

deployRules();
