// Shared Firebase setup for the study app and the teacher dashboard.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, addDoc, collection, getDocs, query, orderBy, limit,
  serverTimestamp, increment,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, ADMIN_EMAILS } from "./firebase-config.js";

export const configured = Boolean(firebaseConfig);
const app = configured ? initializeApp(firebaseConfig) : null;
export const auth = app && getAuth(app);
export const db = app && getFirestore(app);

// A word is learned after this many correct quiz answers in a row.
export const LEARNED_STREAK = 3;

export function isAdmin(user) {
  return Boolean(user && user.emailVerified && ADMIN_EMAILS.includes(user.email));
}

export function watchUser(callback) {
  return onAuthStateChanged(auth, callback);
}

export function signIn() {
  return signInWithPopup(auth, new GoogleAuthProvider());
}

export function signOutUser() {
  return signOut(auth);
}

// Record a visit once per browser session: update the user's profile and add a login entry.
export async function recordLogin(user) {
  const key = `satvocab.session.${user.uid}`;
  try {
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, "1");
  } catch {
    // Without sessionStorage every page load counts as a visit.
  }
  const ref = doc(db, "users", user.uid);
  const existing = await getDoc(ref);
  await setDoc(ref, {
    name: user.displayName || "",
    email: user.email || "",
    photo: user.photoURL || "",
    lastLogin: serverTimestamp(),
    loginCount: increment(1),
    ...(existing.exists() ? {} : { firstLogin: serverTimestamp() }),
  }, { merge: true });
  await addDoc(collection(db, "users", user.uid, "logins"), {
    at: serverTimestamp(),
    device: navigator.userAgent.slice(0, 200),
  });
}

// Progress is one document per student: { words: { [word]: { streak, correct, wrong, last } } }.
export async function loadProgress(uid) {
  const snap = await getDoc(doc(db, "progress", uid));
  return snap.exists() ? snap.data().words || {} : {};
}

export function saveWordProgress(uid, word, record) {
  return setDoc(doc(db, "progress", uid), {
    words: { [word]: record },
    updated: serverTimestamp(),
  }, { merge: true });
}

// Teacher dashboard reads.
export async function listStudents() {
  const [users, progress] = await Promise.all([
    getDocs(collection(db, "users")),
    getDocs(collection(db, "progress")),
  ]);
  const progressById = Object.fromEntries(progress.docs.map((d) => [d.id, d.data().words || {}]));
  return users.docs.map((d) => ({ uid: d.id, ...d.data(), words: progressById[d.id] || {} }));
}

export async function recentLogins(uid, count = 10) {
  const snap = await getDocs(query(collection(db, "users", uid, "logins"), orderBy("at", "desc"), limit(count)));
  return snap.docs.map((d) => d.data());
}
