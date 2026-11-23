// Sign-in with a 6-digit code sent by email, for students whose email isn't a
// Google account (iCloud, a school address).
//
// sendSignInCode emails a code to an address that may use the app: invited,
// a teacher, or a student who already signed in, and not blocked. Only a salted
// hash of the code is kept, in /signincodes/{email}, which the rules keep away
// from every browser. A code works for CODE_MINUTES minutes and MAX_TRIES tries.
//
// verifySignInCode checks the code and returns a Firebase custom token for the
// account with that email (created if there is none, so a student who also uses
// Google sign-in with the same address gets the same account and progress). The
// account's email is marked verified, which is what the Firestore rules check.
//
// Making custom tokens needs the functions' service account to have the
// "Service Account Token Creator" role (see FIREBASE-SETUP.md).

import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { gmailPassword, mailer, send } from "./reminders.js";

// Keep in sync with OWNER_EMAILS in index.js.
const OWNER_EMAILS = ["tychung01@gmail.com"];
export const CODE_MINUTES = 10;
export const MAX_TRIES = 5;
// At most one code a minute and SENDS_PER_HOUR an hour for each address.
export const RESEND_SECONDS = 60;
export const SENDS_PER_HOUR = 5;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const emulator = process.env.FUNCTIONS_EMULATOR === "true";

export function normalizeEmail(value) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(email) && email.length <= 254 ? email : null;
}

const hashCode = (salt, code) => createHash("sha256").update(`${salt}:${code}`).digest("hex");

// Whether another code can go to this address now, from its earlier sends (ms).
// Returns null when it can, or the error message when it can't.
export function sendBlockedReason(sends, now) {
  const recent = sends.filter((t) => now - t < HOUR);
  if (recent.some((t) => now - t < RESEND_SECONDS * 1000)) return "A code was just sent. Wait a minute before asking for another.";
  if (recent.length >= SENDS_PER_HOUR) return "Too many codes were sent to this address. Try again in an hour.";
  return null;
}

// Checks a typed code against the stored one. Returns "ok", "expired", "tries",
// or "wrong" (the caller then counts a try).
export function checkCode(stored, code, now) {
  if (!stored?.hash || !(stored.expires > now)) return "expired";
  if ((stored.tries || 0) >= MAX_TRIES) return "tries";
  const typed = Buffer.from(hashCode(stored.salt, code), "hex");
  return timingSafeEqual(typed, Buffer.from(stored.hash, "hex")) ? "ok" : "wrong";
}

// The app the code is for, from the app's request; SAT Word Study if unknown.
const APP_NAMES = { words: "SAT Word Study", transitions: "SAT Transitions" };
export const appName = (app) => APP_NAMES[app] || APP_NAMES.words;

export function codeMessage(code, app) {
  return {
    subject: `${code} is your ${appName(app)} code`,
    text: `Your sign-in code for ${appName(app)} is:\n\n${code}\n\n`
      + `Type it in the app to sign in. It works for ${CODE_MINUTES} minutes.\n\n`
      + `If you didn't ask for this code, you can ignore this email.\n\n`
      + `SAT Word Master`,
  };
}

// Whether this address may use the apps: the same people the Firestore rules let in.
async function mayStudy(db, email) {
  if ((await db.doc(`blocked/${email}`).get()).exists) return false;
  if (OWNER_EMAILS.includes(email)) return true;
  const [invite, teacher, user] = await Promise.all([
    db.doc(`invites/${email}`).get(),
    db.doc(`teachers/${email}`).get(),
    db.collection("users").where("email", "==", email).limit(1).get(),
  ]);
  if (invite.exists || teacher.exists) return true;
  // Students who signed in before invites keep access. users.email keeps the
  // case Google gave it, so also look it up through Auth.
  if (!user.empty) return true;
  try {
    const { uid } = await getAuth().getUserByEmail(email);
    const [words, transitions] = await Promise.all([db.doc(`users/${uid}`).get(), db.doc(`transitionusers/${uid}`).get()]);
    return words.exists || transitions.exists;
  } catch {
    return false;
  }
}

export const sendSignInCode = onCall({ secrets: [gmailPassword] }, async (request) => {
  const email = normalizeEmail(request.data?.email);
  if (!email) throw new HttpsError("invalid-argument", "Type a full email address, like name@icloud.com.");
  const db = getFirestore();
  if (!(await mayStudy(db, email))) {
    throw new HttpsError("permission-denied", `${email} doesn't have access to ${appName(request.data?.app)}. Ask your teacher to invite this email address.`);
  }
  const code = String(randomInt(0, 1000000)).padStart(6, "0");
  const salt = randomBytes(16).toString("hex");
  const ref = db.doc(`signincodes/${email}`);
  await db.runTransaction(async (tx) => {
    const now = Date.now();
    const sends = ((await tx.get(ref)).get("sends") || []).filter((t) => now - t < HOUR);
    const reason = sendBlockedReason(sends, now);
    if (reason) throw new HttpsError("resource-exhausted", reason);
    tx.set(ref, { hash: hashCode(salt, code), salt, expires: now + CODE_MINUTES * MINUTE, tries: 0, sends: [...sends, now] });
  });
  if (emulator) {
    console.log(`Sign-in code for ${email}: ${code}`);
    return { sentTo: email };
  }
  try {
    await send(mailer(), email, codeMessage(code, request.data?.app));
  } catch (err) {
    console.error("Sign-in code email failed", err.message);
    await ref.update({ hash: null });
    throw new HttpsError("unavailable", "The email couldn't be sent. Please try again, or sign in with Google.");
  }
  return { sentTo: email };
});

export const verifySignInCode = onCall(async (request) => {
  const email = normalizeEmail(request.data?.email);
  const code = String(request.data?.code ?? "").replace(/\D/g, "");
  if (!email || code.length !== 6) throw new HttpsError("invalid-argument", "Type the 6-digit code from the email.");
  const db = getFirestore();
  const ref = db.doc(`signincodes/${email}`);
  const result = await db.runTransaction(async (tx) => {
    const stored = (await tx.get(ref)).data();
    const outcome = checkCode(stored, code, Date.now());
    if (outcome === "wrong") tx.update(ref, { tries: (stored.tries || 0) + 1 });
    // A code works once; the send times stay, for the limit on new codes.
    if (outcome === "ok") tx.update(ref, { hash: null, salt: null });
    return outcome;
  });
  if (result === "expired") throw new HttpsError("deadline-exceeded", "That code has expired. Ask for a new one.");
  if (result === "tries") throw new HttpsError("resource-exhausted", "Too many wrong tries. Ask for a new code.");
  if (result === "wrong") throw new HttpsError("invalid-argument", "That code isn't right. Check the email and try again.");

  const auth = getAuth();
  let user;
  try {
    user = await auth.getUserByEmail(email);
    if (!user.emailVerified) user = await auth.updateUser(user.uid, { emailVerified: true });
  } catch (err) {
    if (err.code !== "auth/user-not-found") throw err;
    user = await auth.createUser({ email, emailVerified: true });
  }
  return { token: await auth.createCustomToken(user.uid) };
});
