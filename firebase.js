// Shared Firebase setup for the study app and the teacher dashboard.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, addDoc, deleteDoc, collection, getDocs, query, orderBy, limit,
  serverTimestamp, increment, deleteField, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
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

// Whether this account can use the teacher dashboard: the owner, or anyone listed
// in /teachers. Resolves false for signed-out or unverified accounts, never rejects.
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

// The teachers the owner added, one document per email (lowercased). Only
// teachers can read the list, and only the owner can add or remove from it.
export async function listTeachers() {
  const snap = await getDocs(collection(db, "teachers"));
  return snap.docs.map((d) => d.data());
}

export function addTeacher(email, addedBy) {
  const id = email.trim().toLowerCase();
  return setDoc(doc(db, "teachers", id), { email: id, addedBy, addedAt: serverTimestamp() });
}

// email is the document ID, already lowercased.
export function removeTeacher(email) {
  return deleteDoc(doc(db, "teachers", email));
}

// Calls callback(user) now and on every sign-in or sign-out, with null when
// nobody is signed in. Returns a function that stops watching.
export function watchUser(callback) {
  return onAuthStateChanged(auth, callback);
}

// Opened from the iPhone home screen rather than in a browser tab.
const homeScreenApp = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

// Sign in with Google in a pop-up. Rejects with the Firebase error code if that
// fails, except in the home-screen app, which falls back to a full-page redirect.
export function signIn() {
  const provider = new GoogleAuthProvider();
  return signInWithPopup(auth, provider).catch((err) => {
    // The home-screen app can't always open a pop-up; sign in on a full page instead.
    // The page reloads signed in, and watchUser picks up the account.
    const popupFailed = ["auth/popup-blocked", "auth/operation-not-supported-in-this-environment"].includes(err.code);
    if (homeScreenApp && popupFailed) return signInWithRedirect(auth, provider);
    throw err;
  });
}

// Sign out on this device; watchUser then reports null.
export function signOutUser() {
  return signOut(auth);
}

export function localDay(date) {
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
    if (existing.exists() && sessionStorage.getItem(key)) return data.loginStreak || 1;
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
  try {
    sessionStorage.setItem(key, "1");
  } catch {
    // Counted again on the next page load.
  }
  return loginStreak;
}

// Students a teacher invited, one document per email (lowercased). Only invited
// students (and students who signed in before invites) can use the study app.
export async function listInvites() {
  const snap = await getDocs(collection(db, "invites"));
  return snap.docs.map((d) => d.data());
}

export function addInvite(email, invitedBy) {
  const id = email.trim().toLowerCase();
  return setDoc(doc(db, "invites", id), { email: id, invitedBy, invitedAt: serverTimestamp() });
}

// Stops a student who hasn't signed in yet. A student who already signed in
// keeps access; take it away with blockStudent instead.
export function removeInvite(email) {
  return deleteDoc(doc(db, "invites", email));
}

// Students whose access a teacher took away, one document per email (lowercased).
// The rules shut them out of their records until the document is deleted.
export async function listBlocked() {
  const snap = await getDocs(collection(db, "blocked"));
  return snap.docs.map((d) => d.data());
}

// Takes a student's access away from the next time they open the app. Their
// progress is kept.
export function blockStudent(email, blockedBy) {
  const id = email.trim().toLowerCase();
  return setDoc(doc(db, "blocked", id), { email: id, blockedBy, blockedAt: serverTimestamp() });
}

// Gives a blocked student their access back, with their progress as it was.
export function unblockStudent(email) {
  return deleteDoc(doc(db, "blocked", email));
}

// Each student's public profile, shown to other students on the leaderboard:
// { username, photo, setStreak (days in a row they finished a flashcard set),
//   lastSetDay (YYYY-MM-DD), learned (words learned), updated }.
// /usernames/{lowercased name} holds { uid } so no two students share a name.
export async function loadProfile(uid) {
  const snap = await getDoc(doc(db, "profiles", uid));
  return snap.exists() ? snap.data() : null;
}

export async function isUsernameTaken(username) {
  return (await getDoc(doc(db, "usernames", username.toLowerCase()))).exists();
}

// Claims the user name and creates the profile together. Rejects with
// permission-denied if someone else took the name first.
export function createProfile(uid, profile) {
  const batch = writeBatch(db);
  batch.set(doc(db, "usernames", profile.username.toLowerCase()), { uid });
  batch.set(doc(db, "profiles", uid), { ...profile, updated: serverTimestamp() });
  return batch.commit();
}

// Students change their picture and stats this way; the user name stays.
export function saveProfile(uid, changes) {
  return setDoc(doc(db, "profiles", uid), { ...changes, updated: serverTimestamp() }, { merge: true });
}

// Every profile, for the leaderboard.
export async function listProfiles() {
  const snap = await getDocs(collection(db, "profiles"));
  return snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
}

// Teachers only: give a student a new user name, freeing the old one.
export function renameStudent(uid, oldName, newName) {
  const batch = writeBatch(db);
  if (oldName.toLowerCase() !== newName.toLowerCase()) {
    batch.delete(doc(db, "usernames", oldName.toLowerCase()));
    batch.set(doc(db, "usernames", newName.toLowerCase()), { uid });
  }
  batch.set(doc(db, "profiles", uid), { username: newName, updated: serverTimestamp() }, { merge: true });
  return batch.commit();
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

// Database words a teacher took off every student's list: one document per word.
export async function loadHiddenWords() {
  const snap = await getDocs(collection(db, "hiddenwords"));
  return snap.docs.map((d) => d.data());
}

export function hideWord(word, removedBy) {
  return setDoc(doc(db, "hiddenwords", word), { word, removedBy, removedAt: serverTimestamp() });
}

export function unhideWord(word) {
  return deleteDoc(doc(db, "hiddenwords", word));
}

// Claude writes a new word's part of speech, definition, example passage, and quiz
// choices (the writeWord Cloud Function; only teachers can call it).
export async function writeWordContent(word, definition = "") {
  const result = await httpsCallable(getFunctions(app), "writeWord")({ word, definition });
  return result.data;
}

// Teacher dashboard reads.
export async function listStudents() {
  const [users, progress, wordLists, profiles] = await Promise.all([
    getDocs(collection(db, "users")),
    getDocs(collection(db, "progress")),
    getDocs(collection(db, "wordlists")),
    getDocs(collection(db, "profiles")),
  ]);
  const progressById = Object.fromEntries(progress.docs.map((d) => [d.id, d.data().words || {}]));
  const listsById = Object.fromEntries(wordLists.docs.map((d) => [d.id, d.data()]));
  const profilesById = Object.fromEntries(profiles.docs.map((d) => [d.id, d.data()]));
  return users.docs.map((d) => ({
    uid: d.id, ...d.data(), words: progressById[d.id] || {}, wordList: wordListFrom(listsById[d.id]),
    profile: profilesById[d.id] || null,
  }));
}

export async function recentLogins(uid, count = 10) {
  const snap = await getDocs(query(collection(db, "users", uid, "logins"), orderBy("at", "desc"), limit(count)));
  return snap.docs.map((d) => d.data());
}
