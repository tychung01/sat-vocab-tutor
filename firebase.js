// Shared Firebase setup for the study app and the teacher dashboard.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, addDoc, deleteDoc, collection, getDocs, query, orderBy, limit,
  serverTimestamp, increment, deleteField,
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

function localDay(date) {
  return date.toLocaleDateString("en-CA"); // YYYY-MM-DD in the student's time zone
}

// Record a visit once per browser session: update the user's profile, add a login
// entry, and count consecutive days with a visit. Returns that day streak.
export async function recordLogin(user) {
  const ref = doc(db, "users", user.uid);
  const existing = await getDoc(ref);
  const data = existing.exists() ? existing.data() : {};
  const key = `satvocab.session.${user.uid}`;
  try {
    if (sessionStorage.getItem(key)) return data.loginStreak || 1;
    sessionStorage.setItem(key, "1");
  } catch {
    // Without sessionStorage every page load counts as a visit.
  }
  const today = localDay(new Date());
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const loginStreak = data.lastLoginDay === today ? data.loginStreak || 1
    : data.lastLoginDay === localDay(yesterday) ? (data.loginStreak || 0) + 1
    : 1;
  await setDoc(ref, {
    loginStreak,
    lastLoginDay: today,
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
  return loginStreak;
}

// Progress is one document per student: { words: { [word]: { streak, correct, wrong, last } },
// studied: [words from finished flashcard sets since the last review quiz],
// required: the quiz the student must pass before the next set, { mode, words } or null }.
export async function loadProgress(uid) {
  const snap = await getDoc(doc(db, "progress", uid));
  const data = snap.exists() ? snap.data() : {};
  return { words: data.words || {}, studied: data.studied || [], required: data.required || null };
}

export function saveStudyState(uid, { studied, required }) {
  return setDoc(doc(db, "progress", uid), { studied, required, updated: serverTimestamp() }, { merge: true });
}

export function saveWordProgress(uid, word, record) {
  return setDoc(doc(db, "progress", uid), {
    words: { [word]: record },
    updated: serverTimestamp(),
  }, { merge: true });
}

// Each student's word list changes are one document, which only teachers can write:
// { added: { [word]: entry }, removed: { [word]: true } } (removed holds database words).
function wordListFrom(data = {}) {
  return { added: data.added || {}, removed: data.removed || {} };
}

export async function loadWordList(uid) {
  const snap = await getDoc(doc(db, "wordlists", uid));
  return wordListFrom(snap.exists() ? snap.data() : {});
}

function saveWordList(uid, changes) {
  return setDoc(doc(db, "wordlists", uid), { ...changes, updated: serverTimestamp() }, { merge: true });
}

export function addStudentWord(uid, entry) {
  return saveWordList(uid, { added: { [entry.word]: entry }, removed: { [entry.word]: deleteField() } });
}

// A database word is hidden for the student; a teacher-added word is deleted.
export function removeStudentWord(uid, word, inDatabase) {
  return saveWordList(uid, inDatabase
    ? { added: { [word]: deleteField() }, removed: { [word]: true } }
    : { added: { [word]: deleteField() } });
}

export function restoreStudentWord(uid, word) {
  return saveWordList(uid, { removed: { [word]: deleteField() } });
}

// Words a teacher added for every student: one document per word, whose ID is the word.
// Every signed-in user can read them; only teachers can change them.
export async function loadClassWords() {
  const snap = await getDocs(collection(db, "classwords"));
  return snap.docs.map((d) => d.data());
}

export function addClassWord(entry) {
  return setDoc(doc(db, "classwords", entry.word), entry);
}

export function removeClassWord(word) {
  return deleteDoc(doc(db, "classwords", word));
}

// Teacher dashboard reads.
export async function listStudents() {
  const [users, progress, wordLists] = await Promise.all([
    getDocs(collection(db, "users")),
    getDocs(collection(db, "progress")),
    getDocs(collection(db, "wordlists")),
  ]);
  const progressById = Object.fromEntries(progress.docs.map((d) => [d.id, d.data().words || {}]));
  const listsById = Object.fromEntries(wordLists.docs.map((d) => [d.id, d.data()]));
  return users.docs.map((d) => ({
    uid: d.id, ...d.data(), words: progressById[d.id] || {}, wordList: wordListFrom(listsById[d.id]),
  }));
}

export async function recentLogins(uid, count = 10) {
  const snap = await getDocs(query(collection(db, "users", uid, "logins"), orderBy("at", "desc"), limit(count)));
  return snap.docs.map((d) => d.data());
}
