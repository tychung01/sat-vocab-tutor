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

// The app owner: always a teacher, and the only account that can add or remove
// teachers in the dashboard. Keep this in sync with isAppOwner() in firestore.rules.
export const OWNER_EMAILS = ["tychung01@gmail.com"];
