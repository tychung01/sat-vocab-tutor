// Firebase settings for the study app. Fill these in from the Firebase console:
// Project settings → General → Your apps → Web app → SDK setup and configuration.
// These values are safe to publish; access is controlled by firestore.rules.
// See FIREBASE-SETUP.md for the full steps.
export const firebaseConfig = null;
// Example:
// export const firebaseConfig = {
//   apiKey: "…",
//   authDomain: "your-project.firebaseapp.com",
//   projectId: "your-project",
//   appId: "…",
// };

// Accounts that can open the teacher dashboard (admin.html).
// Keep this in sync with isAdmin() in firestore.rules.
export const ADMIN_EMAILS = ["tychung01@gmail.com"];
