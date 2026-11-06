// Tests for firestore.rules. Needs Java (for the Firestore emulator). Run from tests/:
//   npm install
//   npm test
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { doc, getDoc, getDocs, setDoc, deleteDoc, collection, serverTimestamp, deleteField } from "firebase/firestore";

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
const unverifiedOwner = as("owner2", "tychung01@gmail.com", false);
const anon = env.unauthenticatedContext().firestore();

await env.withSecurityRulesDisabled(async (c) => {
  const db = c.firestore();
  await setDoc(doc(db, "teachers/teacher@example.com"), { email: "teacher@example.com", addedBy: "tychung01@gmail.com" });
  await setDoc(doc(db, "users/s2"), { name: "Other" });
  await setDoc(doc(db, "progress/s2"), { learned: 1 });
  await setDoc(doc(db, "users/s2/logins/a"), { at: 1 });
});

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
  ["student reads/writes own progress", () => assertSucceeds(setDoc(doc(student, "progress/s1"), { learned: 2 }).then(() => getDoc(doc(student, "progress/s1"))))],
  ["student writes own user doc + login", () => assertSucceeds(setDoc(doc(student, "users/s1"), { name: "S" }).then(() => setDoc(doc(student, "users/s1/logins/x"), { at: 1 })))],
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
];

let failed = 0;
for (const [name, fn] of cases) {
  try { await fn(); console.log("PASS", name); }
  catch (e) { failed++; console.log("FAIL", name, "-", e.message.split("\n")[0]); }
}
await env.cleanup();
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
