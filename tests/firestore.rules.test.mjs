// Tests for firestore.rules. Needs Java (for the Firestore emulator). Run from tests/:
//   npm install
//   npm test
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { doc, getDoc, getDocs, setDoc, deleteDoc, collection, serverTimestamp, deleteField, writeBatch } from "firebase/firestore";

const env = await initializeTestEnvironment({
  projectId: "demo-sat",
  // emulators:exec sets FIRESTORE_EMULATOR_HOST, which tells this where the emulator is.
  firestore: { rules: readFileSync(fileURLToPath(new URL("../firestore.rules", import.meta.url)), "utf8") },
});
const as = (uid, email, verified = true) =>
  env.authenticatedContext(uid, { email, email_verified: verified }).firestore();
const owner = as("owner", "tychung01@gmail.com");
const teacher = as("t1", "teacher@example.com");
const student = as("s1", "student@example.com");
const stranger = as("s3", "stranger@example.com");
const unverifiedOwner = as("owner2", "tychung01@gmail.com", false);
const anon = env.unauthenticatedContext().firestore();

await env.withSecurityRulesDisabled(async (c) => {
  const db = c.firestore();
  await setDoc(doc(db, "teachers/teacher@example.com"), { email: "teacher@example.com", addedBy: "tychung01@gmail.com" });
  await setDoc(doc(db, "invites/student@example.com"), { email: "student@example.com", invitedBy: "teacher@example.com" });
  await setDoc(doc(db, "users/s2"), { name: "Other" });
  await setDoc(doc(db, "progress/s2"), { learned: 1 });
  await setDoc(doc(db, "users/s2/logins/a"), { at: 1 });
  // A student who signed in, then had their access removed.
  await setDoc(doc(db, "invites/gone@example.com"), { email: "gone@example.com", invitedBy: "teacher@example.com" });
  await setDoc(doc(db, "users/s4"), { name: "Gone" });
  await setDoc(doc(db, "progress/s4"), { learned: 1 });
  await setDoc(doc(db, "wordlists/s4"), { added: {} });
  await setDoc(doc(db, "blocked/gone@example.com"), { email: "gone@example.com", blockedBy: "teacher@example.com" });
  // Two signed-in students for the profile tests.
  await setDoc(doc(db, "users/p1"), { name: "P1" });
  await setDoc(doc(db, "users/p2"), { name: "P2" });
  // SAT Transitions: an invited student who hasn't used the word app, and a
  // transitions student whose access was removed.
  await setDoc(doc(db, "invites/tr@example.com"), { email: "tr@example.com", invitedBy: "teacher@example.com" });
  await setDoc(doc(db, "transitionusers/tb"), { name: "TB" });
  await setDoc(doc(db, "transitionprogress/tb"), { answers: {} });
  await setDoc(doc(db, "transitionquestions/tr"), { words: {}, day: "2026-11-23", today: 0 });
  await setDoc(doc(db, "transitionquestions/tb"), { words: {}, day: "2026-11-23", today: 0 });
  await setDoc(doc(db, "blocked/tb@example.com"), { email: "tb@example.com", blockedBy: "teacher@example.com" });
  // SAT Reading: an invited student, a reading student whose access was removed,
  // a published batch, a batch being written, and new choices for a student.
  await setDoc(doc(db, "invites/rd@example.com"), { email: "rd@example.com", invitedBy: "teacher@example.com" });
  await setDoc(doc(db, "readingusers/rb"), { name: "RB" });
  await setDoc(doc(db, "blocked/rb@example.com"), { email: "rb@example.com", blockedBy: "teacher@example.com" });
  await setDoc(doc(db, "readingbatches/1"), { number: 1, questions: [{ id: "b1-001" }], sets: {}, pulled: {} });
  await setDoc(doc(db, "readingjobs/2"), { number: 2, status: "active" });
  await setDoc(doc(db, "readingjobs/2/items/s001"), { state: "write" });
  await setDoc(doc(db, "readingchoices/rd"), { q: {}, day: "2026-11-24", today: 0 });
  await setDoc(doc(db, "readingmeta/sources"), { used: {} });
  // SAT Math: an invited student, a published batch, a batch being written, a pool question.
  await setDoc(doc(db, "invites/ma@example.com"), { email: "ma@example.com", invitedBy: "teacher@example.com" });
  await setDoc(doc(db, "mathbatches/1"), { number: 1, questions: [{ id: "b1-q001" }], pulled: {} });
  await setDoc(doc(db, "mathjobs/2"), { number: 2, status: "active" });
  await setDoc(doc(db, "mathjobs/2/items/q001"), { state: "write" });
  await setDoc(doc(db, "mathpool/b1-q001"), { id: "b1-q001", skill: "linear_systems", pulled: false, inBatch: 1 });
  await setDoc(doc(db, "mathextra/ma"), { q: {} });
});
const p1 = as("p1", "p1@example.com");
const p2 = as("p2", "p2@example.com");
const profile = (username, extra = {}) => ({ username, photo: "avatar:owl", setStreak: 0, lastSetDay: "", learned: 0, ...extra });
// Claims a user name and creates the profile in one batch, as the app does.
const claim = (db, uid, username, extra = {}) => {
  const b = writeBatch(db);
  b.set(doc(db, "usernames", username.toLowerCase()), { uid });
  b.set(doc(db, "profiles", uid), profile(username, extra));
  return b.commit();
};
const jpeg = (chars) => "data:image/jpeg;base64," + "A".repeat(chars);
const gone = as("s4", "gone@example.com");
const goneMixedCase = as("s4", "Gone@Example.com");
const block = (db, email, extra = {}) =>
  setDoc(doc(db, "blocked", email), { email, blockedBy: "teacher@example.com", blockedAt: serverTimestamp(), ...extra });

const tr = as("tr", "tr@example.com");
const tb = as("tb", "tb@example.com");
const rd = as("rd", "rd@example.com");
const ma = as("ma", "ma@example.com");
const rb = as("rb", "rb@example.com");
const rProgress = () => ({ batch: 1, answers: { "b1-001": { ok: true, t: "inference", sub: "Science", tries: [{ s: 41.2, ok: true, at: 1, p: 2 }] } }, round: null, rounds: [], updated: serverTimestamp() });
const tProgress = () => ({ answers: { "TR-001": { right: 1, wrong: 0, last: "right", ts: 1 } }, cards: { "however,": { status: "known", ts: 1 } }, updated: serverTimestamp() });
const tStats = () => ({ streak: 1, lastDay: "2026-11-16", mastered: 1, updated: serverTimestamp() });

const add = (db, email, extra = {}) =>
  setDoc(doc(db, "teachers", email), { email, addedBy: "x", addedAt: serverTimestamp(), ...extra });

const editList = (db, uid, changes) =>
  setDoc(doc(db, "wordlists", uid), { ...changes, updated: serverTimestamp() }, { merge: true });
const entry = (word) => ({ word, definition: "A test word.", sources: ["Added by your teacher"] });

const cases = [
  ["owner adds a teacher", () => assertSucceeds(add(owner, "new@example.com"))],
  ["owner removes a teacher", () => assertSucceeds(deleteDoc(doc(owner, "teachers/new@example.com")))],
  ["owner can't add uppercase ID", () => assertFails(add(owner, "Mixed@Example.com"))],
  ["owner can't add mismatched email field", () => assertFails(setDoc(doc(owner, "teachers/a@example.com"), { email: "b@example.com", addedBy: "x", addedAt: serverTimestamp() }))],
  ["owner can't add extra fields", () => assertFails(add(owner, "c@example.com", { role: "admin" }))],
  ["unverified owner email can't add", () => assertFails(add(unverifiedOwner, "d@example.com"))],
  ["teacher can't add a teacher", () => assertFails(add(teacher, "e@example.com"))],
  ["teacher can't remove a teacher", () => assertFails(deleteDoc(doc(teacher, "teachers/teacher@example.com")))],
  ["student can't add self as teacher", () => assertFails(add(student, "student@example.com"))],
  ["teacher lists teachers", () => assertSucceeds(getDocs(collection(teacher, "teachers")))],
  ["owner lists teachers", () => assertSucceeds(getDocs(collection(owner, "teachers")))],
  ["student can't list teachers", () => assertFails(getDocs(collection(student, "teachers")))],
  ["student can't read own teacher doc", () => assertFails(getDoc(doc(student, "teachers/student@example.com")))],
  ["teacher reads another student's user doc", () => assertSucceeds(getDoc(doc(teacher, "users/s2")))],
  ["teacher reads another student's progress", () => assertSucceeds(getDoc(doc(teacher, "progress/s2")))],
  ["teacher reads another student's logins", () => assertSucceeds(getDocs(collection(teacher, "users/s2/logins")))],
  ["owner reads another student's progress", () => assertSucceeds(getDoc(doc(owner, "progress/s2")))],
  ["teacher can't write a student's progress", () => assertFails(setDoc(doc(teacher, "progress/s2"), { learned: 99 }))],
  ["student can't save progress before signing in", () => assertFails(setDoc(doc(student, "progress/s1"), { learned: 2 }))],
  ["invited student writes own user doc + login", () => assertSucceeds(setDoc(doc(student, "users/s1"), { name: "S" }).then(() => setDoc(doc(student, "users/s1/logins/x"), { at: 1 })))],
  ["student reads/writes own progress", () => assertSucceeds(setDoc(doc(student, "progress/s1"), { learned: 2 }).then(() => getDoc(doc(student, "progress/s1"))))],
  ["uninvited student can't create a user doc", () => assertFails(setDoc(doc(stranger, "users/s3"), { name: "X" }))],
  ["uninvited student can't add a login", () => assertFails(setDoc(doc(stranger, "users/s3/logins/x"), { at: 1 }))],
  ["uninvited student can't save progress", () => assertFails(setDoc(doc(stranger, "progress/s3"), { learned: 1 }))],
  ["student who signed in before keeps access", () => assertSucceeds(setDoc(doc(as("s2", "other@example.com"), "progress/s2"), { learned: 3 }))],
  ["student can't read another student", () => assertFails(getDoc(doc(student, "progress/s2")))],
  ["anonymous can't read anything", () => assertFails(getDoc(doc(anon, "progress/s2")))],
  // Teacher docs can only be created, so the dashboard checks the list before adding.
  ["owner can't overwrite an existing teacher", () => assertFails(add(owner, "teacher@example.com"))],
  ["teacher adds a word for a student", () => assertSucceeds(editList(teacher, "s1", { added: { zephyr: entry("zephyr"), quixotic: entry("quixotic") } }))],
  ["teacher removes a database word for a student", () => assertSucceeds(editList(teacher, "s1", { removed: { abandon: true } }))],
  ["teacher deletes an added word", async () => {
    await assertSucceeds(editList(teacher, "s1", { added: { zephyr: deleteField() } }));
    const added = (await getDoc(doc(teacher, "wordlists/s1"))).data().added;
    if ("zephyr" in added || !("quixotic" in added)) throw new Error(`unexpected added words: ${Object.keys(added)}`);
  }],
  ["owner edits a student's word list", () => assertSucceeds(editList(owner, "s2", { removed: { abandon: true } }))],
  ["teacher can't add other fields to a word list", () => assertFails(editList(teacher, "s1", { note: "x" }))],
  ["student reads own word list", () => assertSucceeds(getDoc(doc(student, "wordlists/s1")))],
  ["student can't change own word list", () => assertFails(editList(student, "s1", { added: { easy: entry("easy") } }))],
  ["student can't read another student's word list", () => assertFails(getDoc(doc(student, "wordlists/s2")))],
  ["teacher lists word lists", () => assertSucceeds(getDocs(collection(teacher, "wordlists")))],
  ["anonymous can't read a word list", () => assertFails(getDoc(doc(anon, "wordlists/s1")))],
  ["teacher adds a word for all students", () => assertSucceeds(setDoc(doc(teacher, "classwords/zephyr"), entry("zephyr")))],
  ["owner adds a word for all students", () => assertSucceeds(setDoc(doc(owner, "classwords/quixotic"), entry("quixotic")))],
  ["teacher can't add a class word under another ID", () => assertFails(setDoc(doc(teacher, "classwords/other"), entry("zephyr")))],
  ["student reads words for all students", () => assertSucceeds(getDocs(collection(student, "classwords")))],
  ["student can't add a word for all students", () => assertFails(setDoc(doc(student, "classwords/easy"), entry("easy")))],
  ["student can't remove a word for all students", () => assertFails(deleteDoc(doc(student, "classwords/zephyr")))],
  ["teacher removes a word for all students", () => assertSucceeds(deleteDoc(doc(teacher, "classwords/zephyr")))],
  ["anonymous can't read words for all students", () => assertFails(getDocs(collection(anon, "classwords")))],
  ["teacher invites a student", () => assertSucceeds(setDoc(doc(teacher, "invites/new@example.com"), { email: "new@example.com", invitedBy: "teacher@example.com", invitedAt: serverTimestamp() }))],
  ["teacher can't invite under a mismatched ID", () => assertFails(setDoc(doc(teacher, "invites/a@example.com"), { email: "b@example.com", invitedBy: "x" }))],
  ["teacher can't invite an uppercase ID", () => assertFails(setDoc(doc(teacher, "invites/New@Example.com"), { email: "New@Example.com", invitedBy: "x" }))],
  ["teacher lists invites", () => assertSucceeds(getDocs(collection(teacher, "invites")))],
  ["student can't list invites", () => assertFails(getDocs(collection(student, "invites")))],
  ["student can't invite themselves", () => assertFails(setDoc(doc(stranger, "invites/stranger@example.com"), { email: "stranger@example.com", invitedBy: "x" }))],
  ["teacher removes an invite", () => assertSucceeds(deleteDoc(doc(teacher, "invites/new@example.com")))],
  ["teacher can use the study app without an invite", () => assertSucceeds(setDoc(doc(teacher, "users/t1"), { name: "T" }))],
  ["teacher removes a database word for all students", () => assertSucceeds(setDoc(doc(teacher, "hiddenwords/abandon"), { word: "abandon", removedBy: "teacher@example.com", removedAt: serverTimestamp() }))],
  ["teacher can't hide a word under another ID", () => assertFails(setDoc(doc(teacher, "hiddenwords/abate"), { word: "abandon", removedBy: "x" }))],
  ["teacher can't add extra fields to a hidden word", () => assertFails(setDoc(doc(teacher, "hiddenwords/abate"), { word: "abate", removedBy: "x", note: "y" }))],
  ["student reads hidden words", () => assertSucceeds(getDocs(collection(student, "hiddenwords")))],
  ["student can't hide a word", () => assertFails(setDoc(doc(student, "hiddenwords/abate"), { word: "abate", removedBy: "x" }))],
  ["student can't restore a hidden word", () => assertFails(deleteDoc(doc(student, "hiddenwords/abandon")))],
  ["anonymous can't read hidden words", () => assertFails(getDocs(collection(anon, "hiddenwords")))],
  ["teacher restores a hidden word", () => assertSucceeds(deleteDoc(doc(teacher, "hiddenwords/abandon")))],
  ["mixed-case owner email adds a teacher", () => assertSucceeds(add(as("owner3", "TYChung01@Gmail.com"), "mixed@example.com"))],
  ["mixed-case teacher email reads students", () => assertSucceeds(getDoc(doc(as("t2", "Teacher@Example.com"), "progress/s2")))],
  ["blocked student can't read own user doc", () => assertFails(getDoc(doc(gone, "users/s4")))],
  ["blocked student can't update own user doc", () => assertFails(setDoc(doc(gone, "users/s4"), { name: "G" }, { merge: true }))],
  ["blocked student can't add a login", () => assertFails(setDoc(doc(gone, "users/s4/logins/x"), { at: 1 }))],
  ["blocked student can't read own progress", () => assertFails(getDoc(doc(gone, "progress/s4")))],
  ["blocked student can't save progress", () => assertFails(setDoc(doc(gone, "progress/s4"), { learned: 2 }))],
  ["blocked student can't read own word list", () => assertFails(getDoc(doc(gone, "wordlists/s4")))],
  ["blocked student with a mixed-case email is still blocked", () => assertFails(getDoc(doc(goneMixedCase, "progress/s4")))],
  ["teacher still reads a blocked student's progress", () => assertSucceeds(getDoc(doc(teacher, "progress/s4")))],
  ["teacher lists blocked students", () => assertSucceeds(getDocs(collection(teacher, "blocked")))],
  ["student can't list blocked students", () => assertFails(getDocs(collection(student, "blocked")))],
  ["student can't unblock themselves", () => assertFails(deleteDoc(doc(gone, "blocked/gone@example.com")))],
  ["student can't block another student", () => assertFails(block(student, "other@example.com"))],
  ["teacher can't block under an uppercase ID", () => assertFails(block(teacher, "Other@Example.com"))],
  ["teacher can't block with extra fields", () => assertFails(block(teacher, "other@example.com", { note: "x" }))],
  ["teacher blocks a student who signed in before invites", () => assertSucceeds(block(teacher, "other@example.com"))],
  ["that student is shut out", () => assertFails(setDoc(doc(as("s2", "other@example.com"), "progress/s2"), { learned: 4 }))],
  ["teacher restores access", () => assertSucceeds(deleteDoc(doc(teacher, "blocked/gone@example.com")))],
  ["student creates a profile with a user name", () => assertSucceeds(claim(p1, "p1", "Word_Wiz"))],
  ["another student can't take that name in another case", () => assertFails(claim(p2, "p2", "word_wiz"))],
  ["student can't make a profile without claiming its name", () => assertFails(setDoc(doc(p2, "profiles/p2"), profile("Lone")))],
  ["student can't claim a name for another profile", () => assertFails(setDoc(doc(p2, "usernames/spare"), { uid: "p2" }))],
  ["student can't claim a name for someone else", () => assertFails(claim(p2, "p1", "Imposter"))],
  ["student can't use a name with spaces", () => assertFails(claim(p2, "p2", "bad name"))],
  ["student can't use a two-letter name", () => assertFails(claim(p2, "p2", "ab"))],
  ["student with an uploaded photo creates a profile", () => assertSucceeds(claim(p2, "p2", "Quiz_Ace", { photo: jpeg(20000) }))],
  ["student can't add a second name later", () => assertFails(setDoc(doc(p2, "usernames/second"), { uid: "p2" }))],
  ["student changes their picture and stats", () => assertSucceeds(setDoc(doc(p1, "profiles/p1"), { photo: "avatar:fox", setStreak: 3, lastSetDay: "2026-11-13", learned: 12 }, { merge: true }))],
  ["student can't change their own user name", () => assertFails(setDoc(doc(p1, "profiles/p1"), { username: "New_Name" }, { merge: true }))],
  ["student can't use a picture from another site", () => assertFails(setDoc(doc(p1, "profiles/p1"), { photo: "https://example.com/a.png" }, { merge: true }))],
  ["student can't save a PNG data URL", () => assertFails(setDoc(doc(p1, "profiles/p1"), { photo: "data:image/png;base64,AAAA" }, { merge: true }))],
  ["student can't save a picture over 40,000 characters", () => assertFails(setDoc(doc(p1, "profiles/p1"), { photo: jpeg(40000) }, { merge: true }))],
  ["student can't add other fields", () => assertFails(setDoc(doc(p1, "profiles/p1"), { email: "x" }, { merge: true }))],
  ["student can't save a fractional count", () => assertFails(setDoc(doc(p1, "profiles/p1"), { learned: 1.5 }, { merge: true }))],
  ["student can't change another student's profile", () => assertFails(setDoc(doc(p2, "profiles/p1"), { learned: 0 }, { merge: true }))],
  ["student reads the leaderboard", () => assertSucceeds(getDocs(collection(p2, "profiles")))],
  ["blocked student can't read the leaderboard", () => assertFails(getDocs(collection(as("s2", "other@example.com"), "profiles")))],
  ["anonymous can't read the leaderboard", () => assertFails(getDocs(collection(anon, "profiles")))],
  ["student can't free a user name", () => assertFails(deleteDoc(doc(p1, "usernames/word_wiz")))],
  ["teacher renames a student", async () => {
    const b = writeBatch(teacher);
    b.delete(doc(teacher, "usernames/word_wiz"));
    b.set(doc(teacher, "usernames/vocab_star"), { uid: "p1" });
    b.set(doc(teacher, "profiles/p1"), { username: "Vocab_Star" }, { merge: true });
    await assertSucceeds(b.commit());
  }],
  ["the old name is free for someone else", () => assertSucceeds(getDoc(doc(p2, "usernames/word_wiz")).then((d) => { if (d.exists()) throw new Error("still taken"); }))],
  ["teacher can't rename to a name that's taken", async () => {
    const b = writeBatch(teacher);
    b.set(doc(teacher, "usernames/quiz_ace"), { uid: "p1" });
    b.set(doc(teacher, "profiles/p1"), { username: "Quiz_Ace" }, { merge: true });
    await assertFails(b.commit());
  }],
  ["teacher removes a student's picture", () => assertSucceeds(setDoc(doc(teacher, "profiles/p2"), { photo: "" }, { merge: true }))],
  ["teacher turns reminders off for a student", () => assertSucceeds(setDoc(doc(teacher, "reminderoff/s1"), { by: "teacher@example.com", at: serverTimestamp() }))],
  ["teacher can't add other fields to a reminder switch", () => assertFails(setDoc(doc(teacher, "reminderoff/s2"), { by: "x", note: "y" }))],
  ["teacher lists who has reminders off", () => assertSucceeds(getDocs(collection(teacher, "reminderoff")))],
  ["student can't turn their own reminders off", () => assertFails(setDoc(doc(student, "reminderoff/s1"), { by: "student@example.com" }))],
  ["student can't see who has reminders off", () => assertFails(getDocs(collection(student, "reminderoff")))],
  ["student can't turn reminders back on", () => assertFails(deleteDoc(doc(student, "reminderoff/s1")))],
  ["teacher turns reminders back on", () => assertSucceeds(deleteDoc(doc(teacher, "reminderoff/s1")))],
  ["restored student reads and saves progress again", () => assertSucceeds(setDoc(doc(gone, "progress/s4"), { learned: 2 }).then(() => getDoc(doc(gone, "progress/s4"))))],
  // SAT Transitions
  ["transitions: student can't save progress before visiting", () => assertFails(setDoc(doc(tr, "transitionprogress/tr"), tProgress()))],
  ["transitions: uninvited student can't record a visit", () => assertFails(setDoc(doc(stranger, "transitionusers/s3"), { name: "X" }))],
  ["transitions: invited student records a visit", () => assertSucceeds(setDoc(doc(tr, "transitionusers/tr"), { name: "TR" }).then(() => setDoc(doc(tr, "transitionusers/tr/visits/x"), { at: 1 })))],
  ["transitions: word-app student from before invites records a visit", () => assertSucceeds(setDoc(doc(as("s2", "other2@example.com"), "transitionusers/s2"), { name: "Other" }))],
  ["transitions: teacher records a visit without an invite", () => assertSucceeds(setDoc(doc(teacher, "transitionusers/t1"), { name: "T" }))],
  ["transitions: student saves and reads own progress", () => assertSucceeds(setDoc(doc(tr, "transitionprogress/tr"), tProgress()).then(() => getDoc(doc(tr, "transitionprogress/tr"))))],
  ["transitions: student saves one answer", () => assertSucceeds(setDoc(doc(tr, "transitionprogress/tr"), { answers: { "TR-002": { right: 0, wrong: 1, last: "wrong", ts: 2 } }, updated: serverTimestamp() }, { merge: true }))],
  ["transitions: student saves one word", () => assertSucceeds(setDoc(doc(tr, "transitionprogress/tr"), { words: { "however": { correct: 1, wrong: 0, last: "right", ts: 3, rightAt: 3 } }, updated: serverTimestamp() }, { merge: true }))],
  ["transitions: student reads own Claude questions", () => assertSucceeds(getDoc(doc(tr, "transitionquestions/tr")))],
  ["transitions: student can't write Claude questions", () => assertFails(setDoc(doc(tr, "transitionquestions/tr"), { today: 0 }))],
  ["transitions: student can't read another student's Claude questions", () => assertFails(getDoc(doc(student, "transitionquestions/tr")))],
  ["transitions: teacher reads a student's Claude questions", () => assertSucceeds(getDoc(doc(teacher, "transitionquestions/tr")))],
  ["transitions: teacher can't write Claude questions", () => assertFails(setDoc(doc(teacher, "transitionquestions/tr"), { today: 0 }))],
  ["transitions: blocked student can't read own Claude questions", () => assertFails(getDoc(doc(tb, "transitionquestions/tb")))],
  ["transitions: student can't add other fields to progress", () => assertFails(setDoc(doc(tr, "transitionprogress/tr"), { note: "x" }, { merge: true }))],
  ["transitions: student can't read another student's progress", () => assertFails(getDoc(doc(student, "transitionprogress/tr")))],
  ["transitions: student can't write another student's progress", () => assertFails(setDoc(doc(student, "transitionprogress/tr"), tProgress()))],
  ["transitions: teacher reads a student's progress and visits", () => assertSucceeds(getDoc(doc(teacher, "transitionprogress/tr")).then(() => getDocs(collection(teacher, "transitionusers/tr/visits"))))],
  ["transitions: teacher can't write a student's progress", () => assertFails(setDoc(doc(teacher, "transitionprogress/tr"), tProgress()))],
  ["transitions: student saves leaderboard stats", () => assertSucceeds(setDoc(doc(tr, "transitionstats/tr"), tStats()))],
  ["transitions: student updates one stat", () => assertSucceeds(setDoc(doc(tr, "transitionstats/tr"), { mastered: 5 }, { merge: true }))],
  ["transitions: student can't save a fractional stat", () => assertFails(setDoc(doc(tr, "transitionstats/tr"), { mastered: 1.5 }, { merge: true }))],
  ["transitions: student can't add other fields to stats", () => assertFails(setDoc(doc(tr, "transitionstats/tr"), { email: "x" }, { merge: true }))],
  ["transitions: stats can't be created without every field", () => assertFails(setDoc(doc(teacher, "transitionstats/t1"), { mastered: 1 }))],
  ["transitions: student can't change another student's stats", () => assertFails(setDoc(doc(student, "transitionstats/tr"), tStats()))],
  ["transitions: another student reads the leaderboard", () => assertSucceeds(getDocs(collection(p1, "transitionstats")))],
  ["transitions: anonymous can't read the leaderboard", () => assertFails(getDocs(collection(anon, "transitionstats")))],
  ["transitions: transitions-only student creates a profile", () => assertSucceeds(claim(tr, "tr", "Transition_Pro"))],
  ["transitions: student who never opened either app can't create a profile", () => assertFails(claim(as("nv", "student@example.com"), "nv", "Nobody_Yet"))],
  ["transitions: blocked student can't read own progress", () => assertFails(getDoc(doc(tb, "transitionprogress/tb")))],
  ["transitions: blocked student can't save progress", () => assertFails(setDoc(doc(tb, "transitionprogress/tb"), tProgress()))],
  ["transitions: blocked student can't record a visit", () => assertFails(setDoc(doc(tb, "transitionusers/tb"), { name: "TB" }, { merge: true }))],
  ["transitions: blocked student can't read the leaderboard", () => assertFails(getDocs(collection(tb, "transitionstats")))],
  ["transitions: teacher lists every student's records", () => assertSucceeds(Promise.all(["transitionusers", "transitionprogress", "transitionstats"].map((c) => getDocs(collection(teacher, c)))))],
  ["transitions: teacher deletes a student's stats", () => assertSucceeds(deleteDoc(doc(teacher, "transitionstats/tr")))],
  ["transitions: student can't delete own stats", () => assertFails(deleteDoc(doc(p1, "transitionstats/p1")))],
  // SAT Reading.
  ["reading: student can't read batches before opening the app", () => assertFails(getDoc(doc(rd, "readingbatches/1")))],
  ["reading: student can't save progress before opening the app", () => assertFails(setDoc(doc(rd, "readingprogress/rd"), rProgress()))],
  ["reading: invited student records a visit", () => assertSucceeds(setDoc(doc(rd, "readingusers/rd"), { name: "RD", email: "rd@example.com" }))],
  ["reading: student records a visit entry", () => assertSucceeds(setDoc(doc(rd, "readingusers/rd/visits/v1"), { at: serverTimestamp() }))],
  ["reading: uninvited student can't record a visit", () => assertFails(setDoc(doc(stranger, "readingusers/s3"), { name: "S3" }))],
  ["reading: transitions student can open SAT Reading", () => assertSucceeds(setDoc(doc(tr, "readingusers/tr"), { name: "TR" }))],
  ["reading: student saves progress", () => assertSucceeds(setDoc(doc(rd, "readingprogress/rd"), rProgress()))],
  ["reading: student saves one answer", () => assertSucceeds(setDoc(doc(rd, "readingprogress/rd"), { answers: { "b1-002": { ok: false, tries: [{ s: 70, ok: false, at: 2, p: 0 }] } }, updated: serverTimestamp() }, { merge: true }))],
  ["reading: student can't add other fields to progress", () => assertFails(setDoc(doc(rd, "readingprogress/rd"), { score: 100 }, { merge: true }))],
  ["reading: student can't save another student's progress", () => assertFails(setDoc(doc(student, "readingprogress/rd"), rProgress()))],
  ["reading: student reads a batch", () => assertSucceeds(getDoc(doc(rd, "readingbatches/1")))],
  ["reading: student can't write a batch", () => assertFails(setDoc(doc(rd, "readingbatches/1"), { pulled: { "b1-001": true } }, { merge: true }))],
  ["reading: student can't create a batch", () => assertFails(setDoc(doc(rd, "readingbatches/9"), { number: 9, questions: [] }))],
  ["reading: teacher pulls a question", () => assertSucceeds(setDoc(doc(teacher, "readingbatches/1"), { pulled: { "b1-001": { by: "teacher@example.com", at: 1 } } }, { merge: true }))],
  ["reading: teacher can't change a batch's questions", () => assertFails(setDoc(doc(teacher, "readingbatches/1"), { questions: [] }, { merge: true }))],
  ["reading: student sees the next batch's status", () => assertSucceeds(getDoc(doc(rd, "readingjobs/2")))],
  ["reading: student can't read the next batch's items", () => assertFails(getDoc(doc(rd, "readingjobs/2/items/s001")))],
  ["reading: teacher reads the next batch's items", () => assertSucceeds(getDocs(collection(teacher, "readingjobs/2/items")))],
  ["reading: student can't start a batch", () => assertFails(setDoc(doc(rd, "readingjobs/3"), { number: 3, status: "active" }))],
  ["reading: student reads own new choices", () => assertSucceeds(getDoc(doc(rd, "readingchoices/rd")))],
  ["reading: student can't write new choices", () => assertFails(setDoc(doc(rd, "readingchoices/rd"), { q: {} }))],
  ["reading: student can't read another student's new choices", () => assertFails(getDoc(doc(tr, "readingchoices/rd")))],
  ["reading: teacher reads a student's new choices", () => assertSucceeds(getDoc(doc(teacher, "readingchoices/rd")))],
  ["reading: student can't read source records", () => assertFails(getDoc(doc(rd, "readingmeta/sources")))],
  ["reading: teacher lists every student's records", () => assertSucceeds(Promise.all(["readingusers", "readingprogress", "readingchoices"].map((c) => getDocs(collection(teacher, c)))))],
  ["reading: blocked student can't read batches", () => assertFails(getDoc(doc(rb, "readingbatches/1")))],
  ["reading: blocked student can't save progress", () => assertFails(setDoc(doc(rb, "readingprogress/rb"), rProgress()))],
  ["reading: blocked student can't record a visit", () => assertFails(setDoc(doc(rb, "readingusers/rb"), { name: "RB" }, { merge: true }))],
  // Shared banks of generated content.
  ["banks: teacher reads the transitions question bank", () => assertSucceeds(getDoc(doc(teacher, "transitionbank/however")))],
  ["banks: student can't read the transitions question bank", () => assertFails(getDoc(doc(tr, "transitionbank/however")))],
  ["banks: teacher can't write the transitions question bank", () => assertFails(setDoc(doc(teacher, "transitionbank/however"), { questions: [] }))],
  ["banks: teacher reads the reading choice pool", () => assertSucceeds(getDoc(doc(teacher, "readingchoicebank/b1-001")))],
  ["banks: student can't read the reading choice pool", () => assertFails(getDoc(doc(rd, "readingchoicebank/b1-001")))],
  ["banks: student can't write the reading choice pool", () => assertFails(setDoc(doc(rd, "readingchoicebank/b1-001"), { sets: [] }))],
  ["banks: teacher reads the reading reserve", () => assertSucceeds(getDocs(collection(teacher, "readingreserve")))],
  ["banks: student can't read the reading reserve", () => assertFails(getDocs(collection(rd, "readingreserve")))],
  ["banks: teacher adds a word version", () => assertSucceeds(setDoc(doc(teacher, "wordbank/laconic"), { word: "laconic", versions: [{ source: "teacher", content: {}, at: 1, by: "teacher@example.com" }], updated: serverTimestamp() }, { merge: true }))],
  ["banks: teacher reads the word bank", () => assertSucceeds(getDoc(doc(teacher, "wordbank/laconic")))],
  ["banks: teacher can't add other fields to the word bank", () => assertFails(setDoc(doc(teacher, "wordbank/laconic"), { note: "x" }, { merge: true }))],
  ["banks: student can't read the word bank", () => assertFails(getDoc(doc(student, "wordbank/laconic")))],
  ["banks: student can't write the word bank", () => assertFails(setDoc(doc(student, "wordbank/terse"), { word: "terse", versions: [] }))],
  // SAT Math.
  ["math: student can't read batches before opening the app", () => assertFails(getDoc(doc(ma, "mathbatches/1")))],
  ["math: invited student records a visit", () => assertSucceeds(setDoc(doc(ma, "mathusers/ma"), { name: "MA" }))],
  ["math: student records a visit entry", () => assertSucceeds(setDoc(doc(ma, "mathusers/ma/visits/v1"), { at: serverTimestamp() }))],
  ["math: uninvited student can't record a visit", () => assertFails(setDoc(doc(stranger, "mathusers/s3"), { name: "S3" }))],
  ["math: reading student can open SAT Math", () => assertSucceeds(setDoc(doc(rd, "mathusers/rd"), { name: "RD" }))],
  ["math: student saves progress", () => assertSucceeds(setDoc(doc(ma, "mathprogress/ma"), { batch: 1, answers: { "b1-q001": { ok: true, sk: "linear_systems", b: 1, tries: [{ s: 40, ok: true, at: 1, p: 0 }] } }, round: null, rounds: [], sinceQuiz: ["b1-q001"], quiz: null, quizzes: [], updated: serverTimestamp() }))],
  ["math: student can't add other fields to progress", () => assertFails(setDoc(doc(ma, "mathprogress/ma"), { score: 1 }, { merge: true }))],
  ["math: student can't save another student's progress", () => assertFails(setDoc(doc(rd, "mathprogress/ma"), { batch: 1 }))],
  ["math: student reads a batch", () => assertSucceeds(getDoc(doc(ma, "mathbatches/1")))],
  ["math: student can't write a batch", () => assertFails(setDoc(doc(ma, "mathbatches/1"), { pulled: { x: 1 } }, { merge: true }))],
  ["math: teacher pulls a batch question", () => assertSucceeds(setDoc(doc(teacher, "mathbatches/1"), { pulled: { "b1-q001": { by: "t", at: 1 } } }, { merge: true }))],
  ["math: teacher can't change a batch's questions", () => assertFails(setDoc(doc(teacher, "mathbatches/1"), { questions: [] }, { merge: true }))],
  ["math: student sees the next batch's status", () => assertSucceeds(getDoc(doc(ma, "mathjobs/2")))],
  ["math: student can't read a job's items", () => assertFails(getDoc(doc(ma, "mathjobs/2/items/q001")))],
  ["math: teacher reads a job's items", () => assertSucceeds(getDocs(collection(teacher, "mathjobs/2/items")))],
  ["math: student reads own twin questions", () => assertSucceeds(getDoc(doc(ma, "mathextra/ma")))],
  ["math: student can't write twin questions", () => assertFails(setDoc(doc(ma, "mathextra/ma"), { q: {} }))],
  ["math: student can't read another student's twin questions", () => assertFails(getDoc(doc(rd, "mathextra/ma")))],
  ["math: student can't read the pool", () => assertFails(getDoc(doc(ma, "mathpool/b1-q001")))],
  ["math: teacher reads the pool", () => assertSucceeds(getDocs(collection(teacher, "mathpool")))],
  ["math: teacher pulls a pool question", () => assertSucceeds(setDoc(doc(teacher, "mathpool/b1-q001"), { pulled: true }, { merge: true }))],
  ["math: teacher can't rewrite a pool question", () => assertFails(setDoc(doc(teacher, "mathpool/b1-q001"), { skill: "x" }, { merge: true }))],
  ["math: teacher lists every student's records", () => assertSucceeds(Promise.all(["mathusers", "mathprogress", "mathextra"].map((c) => getDocs(collection(teacher, c)))))],
  // Sign-in codes: only the Cloud Functions (Admin SDK) use them.
  ["codes: student can't read their sign-in code", () => assertFails(getDoc(doc(student, "signincodes/student@example.com")))],
  ["codes: teacher can't list sign-in codes", () => assertFails(getDocs(collection(owner, "signincodes")))],
  ["codes: anonymous can't write a sign-in code", () => assertFails(setDoc(doc(anon, "signincodes/student@example.com"), { hash: "x" }))],
];

let failed = 0;
for (const [name, fn] of cases) {
  try { await fn(); console.log("PASS", name); }
  catch (e) { failed++; console.log("FAIL", name, "-", e.message.split("\n")[0]); }
}
await env.cleanup();
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
