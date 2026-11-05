// Firebase settings for the study app, from the Firebase console:
// Project settings → General → Your apps → Web app → SDK setup and configuration.
// These values are safe to publish; access is controlled by firestore.rules.
// See FIREBASE-SETUP.md for the full steps.
export const firebaseConfig = {
  apiKey: "AIzaSyAVw5ET8oavigkJDiHLAThZV9rlV6GgdBc",
  authDomain: "sat-word-study-bfabd.firebaseapp.com",
  projectId: "sat-word-study-bfabd",
  storageBucket: "sat-word-study-bfabd.firebasestorage.app",
  messagingSenderId: "74196131281",
  appId: "1:74196131281:web:6a39371cebd2c8e1ead4f0",
};

// Accounts that can open the teacher dashboard (admin.html).
// Keep this in sync with isAdmin() in firestore.rules.
export const ADMIN_EMAILS = ["tychung01@gmail.com"];
