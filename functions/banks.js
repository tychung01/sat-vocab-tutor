// backfillBanks: a one-time copy of content written before the shared banks
// existed into them. The owner runs it once after deploying; running it again
// adds nothing new.
//
// - SAT Transitions: each student's current Claude-written question per word goes
//   into /transitionbank/{word}, and is marked seen for that student.
// - SAT Reading: each student's new answer choices go into
//   /readingchoicebank/{question id}, marked seen for that student.
// - SAT Word Study: the words teachers saved for the class (/classwords) and for
//   single students (/wordlists) go into /wordbank/{word} as teacher versions.

import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { bankDocId, seenIds } from "./transitions.js";
import { seenSets } from "./reading.js";

// Keep in sync with OWNER_EMAILS in index.js.
const OWNER_EMAILS = ["tychung01@gmail.com"];

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const squash = (text) => String(text || "").toLowerCase().replace(/\s+/g, " ").trim();

// A saved word entry (classwords or a word list) in the word bank's shape.
export function wordBankContent(saved) {
  const sat = saved.sat || {};
  return {
    part_of_speech: saved.part_of_speech || "", definition: saved.definition || "", passage: saved.examples?.[0] || "",
    form: sat.form || "", wrong_words: sat.wrong_words || [], meaning: sat.meaning || "", wrong_meanings: sat.wrong_meanings || [],
  };
}

async function backfillTransitions(db) {
  const students = await db.collection("transitionquestions").get();
  // Questions by word, with who has them.
  const byWord = {};
  for (const doc of students.docs) {
    for (const [word, stored] of Object.entries(doc.get("words") || {})) {
      if (stored?.question) (byWord[word] ||= []).push({ uid: doc.id, stored });
    }
  }
  let added = 0;
  for (const [word, entries] of Object.entries(byWord)) {
    const bankRef = db.doc(`transitionbank/${bankDocId(word)}`);
    const questions = [...((await bankRef.get()).get("questions") || [])];
    const idFor = {};
    for (const { uid, stored } of entries) {
      const q = stored.question;
      let found = questions.find((b) => b.id === q.id || squash(b.passage) === squash(q.passage));
      if (!found) {
        const prefix = q.id.replace(/-\d+$/, "");
        found = { ...q, id: `${prefix}-g${questions.length + 1}`, at: Date.now() };
        questions.push(found);
        added++;
      }
      idFor[uid] = { found, stored };
    }
    await bankRef.set({ word, questions, updated: FieldValue.serverTimestamp() }, { merge: true });
    for (const [uid, { found, stored }] of Object.entries(idFor)) {
      const seen = seenIds(stored);
      if (!seen.includes(found.id)) {
        await db.doc(`transitionquestions/${uid}`).set({ words: { [word]: { seen: [...seen, found.id] } } }, { merge: true });
      }
    }
  }
  return added;
}

async function backfillReading(db) {
  const students = await db.collection("readingchoices").get();
  let added = 0;
  for (const doc of students.docs) {
    for (const [qid, shown] of Object.entries(doc.get("q") || {})) {
      if (!shown?.choices) continue;
      const poolRef = db.doc(`readingchoicebank/${qid}`);
      const sets = [...((await poolRef.get()).get("sets") || [])];
      let found = sets.find((set) => set.id === shown.setId || same(set.choices, shown.choices));
      if (!found) {
        found = { id: `${qid}-c${sets.length + 1}`, choices: shown.choices, correct: shown.correct, explanation: shown.explanation || "", at: shown.at || Date.now() };
        sets.push(found);
        await poolRef.set({ qid, sets, updated: FieldValue.serverTimestamp() }, { merge: true });
        added++;
      }
      const seen = seenSets(shown);
      if (shown.setId !== found.id || !seen.includes(found.id)) {
        await doc.ref.set({ q: { [qid]: { setId: found.id, seen: [...new Set([...seen, found.id])] } } }, { merge: true });
      }
    }
  }
  return added;
}

async function backfillWords(db) {
  const [classWords, wordLists] = await Promise.all([db.collection("classwords").get(), db.collection("wordlists").get()]);
  const saved = [
    ...classWords.docs.map((d) => d.data()),
    ...wordLists.docs.flatMap((d) => Object.values(d.get("added") || {})),
  ].filter((w) => w?.word);
  let added = 0;
  for (const entry of saved) {
    const ref = db.doc(`wordbank/${entry.word}`);
    const versions = (await ref.get()).get("versions") || [];
    const content = wordBankContent(entry);
    if (versions.some((v) => same(v.content, content))) continue;
    await ref.set({
      word: entry.word,
      versions: FieldValue.arrayUnion({ source: "teacher", content, at: Date.parse(entry.added || "") || Date.now(), by: entry.addedBy || "" }),
      updated: FieldValue.serverTimestamp(),
    }, { merge: true });
    added++;
  }
  return added;
}

export const backfillBanks = onCall({ timeoutSeconds: 540 }, async (request) => {
  const email = request.auth?.token?.email?.toLowerCase();
  if (!email || request.auth.token.email_verified !== true || !OWNER_EMAILS.includes(email)) {
    throw new HttpsError("permission-denied", "Only the app's owner can do this.");
  }
  const db = getFirestore();
  const transitions = await backfillTransitions(db);
  const reading = await backfillReading(db);
  const words = await backfillWords(db);
  return { transitions, reading, words };
});
