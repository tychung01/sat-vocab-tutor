// Shared Firebase setup for the study app and the teacher dashboard.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, addDoc, deleteDoc, collection, getDocs, query, orderBy, limit,
  serverTimestamp, increment,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, OWNER_EMAILS } from "./firebase-config.js";

export const configured = Boolean(firebaseConfig);
const app = configured ? initializeApp(firebaseConfig) : null;
export const auth = app && getAuth(app);
export const db = app && getFirestore(app);

// A word is learned after this many correct quiz answers in a row.
export const LEARNED_STREAK = 3;

// Each student practices at most this many words at a time. The database keeps
// growing; newer words join a student's practice list as they learn older ones.
export const PRACTICE_LIMIT = 1200;

// The owner can add and remove teachers; everyone in /teachers can use the dashboard.
export function isOwner(user) {
  return Boolean(user && user.emailVerified && OWNER_EMAILS.includes(user.email.toLowerCase()));
}

export async function isTeacher(user) {
  if (!user || !user.emailVerified) return false;
  if (isOwner(user)) return true;
  try {
    // Firestore rules only let teachers read /teachers, so a non-teacher gets an error here.
    return (await getDoc(doc(db, "teachers", user.email.toLowerCase()))).exists();
  } catch {
    return false;
  }
}

export async function listTeachers() {
  const snap = await getDocs(collection(db, "teachers"));
  return snap.docs.map((d) => d.data());
}

export function addTeacher(email, addedBy) {
  const id = email.trim().toLowerCase();
  return setDoc(doc(db, "teachers", id), { email: id, addedBy, addedAt: serverTimestamp() });
}

export function removeTeacher(email) {
  return deleteDoc(doc(db, "teachers", email));
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
