// Firebase settings for the study app, from the Firebase console:
// Project settings → General → Your apps → Web app → SDK setup and configuration.
// These values are safe to publish; access is controlled by firestore.rules.
// See FIREBASE-SETUP.md for the full steps.
// The app's addresses: satwords.web.app, and the project's default address, where
// home-screen apps installed before 2026-11-13 still point. Google sign-in finishes
// on the address the app is open on, since browsers block it across sites. Each
// address must be in Authentication's authorized domains and in the OAuth client's
// redirect URIs (https://<address>/__/auth/handler); see FIREBASE-SETUP.md.
const APP_HOSTS = ["satwords.web.app", "sat-word-study-bfabd.firebaseapp.com"];

export const firebaseConfig = {
  apiKey: "AIzaSyAVw5ET8oavigkJDiHLAThZV9rlV6GgdBc",
  authDomain: APP_HOSTS.includes(location.hostname) ? location.hostname : APP_HOSTS[0],
  projectId: "sat-word-study-bfabd",
  storageBucket: "sat-word-study-bfabd.firebasestorage.app",
  messagingSenderId: "74196131281",
  appId: "1:74196131281:web:6a39371cebd2c8e1ead4f0",
};

// The app owner: always a teacher, and the only account that can add or remove
// teachers in the dashboard. Keep this in sync with isAppOwner() in firestore.rules.
export const OWNER_EMAILS = ["tychung01@gmail.com"];
