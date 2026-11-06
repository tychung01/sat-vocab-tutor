// Tests for firestore.rules. Needs Java (for the Firestore emulator). Run from tests/:
//   npm install
//   npm test
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { doc, getDoc, getDocs, setDoc, deleteDoc, collection, serverTimestamp } from "firebase/firestore";

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
];

let failed = 0;
for (const [name, fn] of cases) {
  try { await fn(); console.log("PASS", name); }
  catch (e) { failed++; console.log("FAIL", name, "-", e.message.split("\n")[0]); }
}
await env.cleanup();
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
