// Reminder emails for students who haven't studied lately.
//
// remindInactive runs every evening at 8 pm Eastern. It emails each signed-in
// student whose last visit was more than REMIND_AFTER_DAYS days ago, every
// evening until they come back. Teachers, students whose access was removed,
// and students a teacher turned reminders off for (/reminderoff/{uid}) are
// skipped. Emails go through Gmail from SENDER using the GMAIL_APP_PASSWORD
// secret (see FIREBASE-SETUP.md).
//
// sendTestReminder lets a teacher send the reminder to themselves, to check the
// Gmail setup without waiting for 8 pm.

import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import nodemailer from "nodemailer";

const gmailPassword = defineSecret("GMAIL_APP_PASSWORD");
export const SENDER = "tychung01@gmail.com";
// Keep in sync with OWNER_EMAILS in index.js.
const OWNER_EMAILS = ["tychung01@gmail.com"];
const APP_URL = "https://satwords.web.app/";
export const REMIND_AFTER_DAYS = 2;
const DAY = 24 * 60 * 60 * 1000;

// The students to remind, from plain data so it can be tested without Firestore.
// users: [{ uid, email, name, lastLogin (ms) }]; skip: Sets of lowercased emails
// (teachers, blocked) and of uids (reminders off). Returns [{ ...user, days }].
export function whoToRemind(users, now, { teachers, blocked, off }) {
  return users.flatMap((u) => {
    const email = (u.email || "").toLowerCase();
    if (!email || !u.lastLogin) return [];
    if (teachers.has(email) || blocked.has(email) || off.has(u.uid)) return [];
    const days = Math.floor((now - u.lastLogin) / DAY);
    return days >= REMIND_AFTER_DAYS ? [{ ...u, days }] : [];
  });
}

export function reminderMessage({ name, days }) {
  const first = (name || "").trim().split(/\s+/)[0];
  return {
    subject: "Your SAT words are waiting",
    text: `Hi${first ? ` ${first}` : ""},\n\n`
      + `It's been ${days} days since you last studied in SAT Word Study. A set of 10 flashcards and a quick quiz only takes a few minutes, and it starts a new study streak.\n\n`
      + `Pick up where you left off: ${APP_URL}\n\n`
      + `You'll get this reminder each evening until you're back. To stop these emails, ask your teacher.\n\n`
      + `SAT Word Master`,
  };
}

function mailer() {
  return nodemailer.createTransport({ service: "gmail", auth: { user: SENDER, pass: gmailPassword.value() } });
}

async function send(transport, to, message) {
  await transport.sendMail({ from: `"SAT Word Master" <${SENDER}>`, to, ...message });
}

export const remindInactive = onSchedule(
  { schedule: "0 20 * * *", timeZone: "America/New_York", secrets: [gmailPassword], timeoutSeconds: 300 },
  async () => {
    const db = getFirestore();
    const [users, teachers, blocked, off] = await Promise.all([
      db.collection("users").get(),
      db.collection("teachers").get(),
      db.collection("blocked").get(),
      db.collection("reminderoff").get(),
    ]);
    const due = whoToRemind(
      users.docs.map((d) => ({ uid: d.id, email: d.get("email"), name: d.get("name"), lastLogin: d.get("lastLogin")?.toMillis() })),
      Date.now(),
      {
        teachers: new Set([...OWNER_EMAILS, ...teachers.docs.map((d) => d.id)]),
        blocked: new Set(blocked.docs.map((d) => d.id)),
        off: new Set(off.docs.map((d) => d.id)),
      },
    );
    const transport = mailer();
    let sent = 0;
    for (const student of due) {
      try {
        await send(transport, student.email, reminderMessage(student));
        await db.doc(`users/${student.uid}`).update({ lastReminder: FieldValue.serverTimestamp() });
        sent++;
      } catch (err) {
        console.error("Reminder failed", student.uid, err.message);
      }
    }
    console.log(`Reminders: ${sent} sent of ${due.length} due, ${users.size} students checked`);
  },
);

export const sendTestReminder = onCall({ secrets: [gmailPassword] }, async (request) => {
  const email = request.auth?.token?.email?.toLowerCase();
  const verified = request.auth?.token?.email_verified === true;
  const teacher = verified && (OWNER_EMAILS.includes(email) || (await getFirestore().doc(`teachers/${email}`).get()).exists);
  if (!teacher) throw new HttpsError("permission-denied", "Only teachers can send a test reminder.");
  try {
    await send(mailer(), email, reminderMessage({ name: request.auth.token.name, days: 3 }));
  } catch (err) {
    console.error("Test reminder failed", err.message);
    throw new HttpsError("failed-precondition", `Gmail didn't accept the message: ${err.message}`);
  }
  return { sentTo: email };
});
