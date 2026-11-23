// SAT Transitions: a new practice question for a transition word, written by
// Claude Opus 5.5.
//
// In Practice, a word is mastered after 3 correct answers. Each word starts with
// its question from the app's question bank; every time the student answers a
// word's question correctly (and the word isn't mastered yet), the app calls
// newTransitionQuestion in the background and the next time the word comes up
// the student sees the new question. A wrong answer keeps the question.
//
// The question is saved in /transitionquestions/{uid}:
//   { words: { [transition]: { question, made, forRight, at } }, day, today }
// question is { id, transition, relationship, passage, choices, correct,
// explanation, difficulty, rarity }, the shape the app uses. forRight is the
// student's rightAt (time of the latest correct answer) the question was made
// for, so each correct answer gets at most one new question. The browser can
// read the document but only this function writes it.
//
// The word list and question bank are copies of SAT Transitions'
// public/data/*.json, in transitions-data/. After changing them there, copy them
// again:  cp "../../SAT Transitions/public/data/"*.json transitions-data/

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { readFileSync } from "node:fs";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { z } from "zod";
import { anthropicKey } from "./secrets.js";

export const MASTERED_AT = 3;
// At most this many new questions a day for each student (UTC days).
export const DAILY_LIMIT = 60;
const BLANK = "______";
const emulator = process.env.FUNCTIONS_EMULATOR === "true";

function readTable(name) {
  const file = JSON.parse(readFileSync(new URL(`./transitions-data/${name}.json`, import.meta.url), "utf8"));
  return file.rows.map((row) => Object.fromEntries(file.fields.map((f, i) => [f, row[i]])));
}

// A choice as the word list writes it: "However," -> "however".
export const baseForm = (choice) => String(choice).trim().replace(/[,.;:]+$/, "").trim().toLowerCase();

const relationshipMeaning = Object.fromEntries(readTable("relationships").map((r) => [r.relationship, r.meaning]));
const TRANSITIONS = readTable("transitions");
const byName = Object.fromEntries(TRANSITIONS.map((t) => [t.transition, t]));
// Each word's question in the bank, the one whose answer is that word.
const bankQuestion = Object.fromEntries(readTable("questions").map((q) => {
  const choices = [q.A, q.B, q.C, q.D];
  return [baseForm(choices["ABCD".indexOf(q.answer)]), { ...q, choices }];
}));

// Checks Claude's question for a word and returns it in the app's shape, or
// throws an Error saying what's wrong.
export function checkQuestion(word, content) {
  const t = byName[word];
  const passage = String(content.passage || "").trim().replace(/_{3,}/g, BLANK);
  if (passage.split(BLANK).length !== 2) throw new Error("the passage needs exactly one blank");
  if (baseForm(content.answer) !== word) throw new Error(`the answer must be "${word}"`);
  const wrong = (content.wrong_choices || []).map((c) => String(c).trim());
  if (wrong.length !== 3) throw new Error("there must be 3 wrong choices");
  const seen = new Set([word]);
  for (const choice of wrong) {
    const other = byName[baseForm(choice)];
    if (!other) throw new Error(`"${choice}" isn't in the word list`);
    if (seen.has(other.transition)) throw new Error(`"${choice}" is repeated or is the answer`);
    seen.add(other.transition);
  }
  const explanation = String(content.explanation || "").trim();
  if (!explanation) throw new Error("the explanation is missing");
  return {
    transition: word,
    relationship: t.relationship,
    passage,
    choices: [String(content.answer).trim(), ...wrong],
    correct: 0,
    explanation,
    difficulty: t.difficulty,
    rarity: t.rarity,
  };
}

const QuestionContent = z.object({
  passage: z.string().describe(`The passage, with ${BLANK} where the transition goes`),
  answer: z.string().describe("The transition word, exactly as it fills the blank"),
  wrong_choices: z.array(z.string()).describe("3 wrong choices from the allowed list, each exactly as it would fill the blank"),
  explanation: z.string().describe("Why the answer is right and the other choices aren't, 1-3 sentences"),
});

const SYSTEM = `You write practice questions for an SAT study app, in the style of the SAT Reading and Writing section's transition questions: the student picks the transition that most logically connects the ideas in a short passage.

Given a transition word and an example question, write a new question whose correct answer is that word:
- passage: an original passage of 2-3 sentences (about 30-70 words) on an SAT-like topic (science, history, social science, the arts, or literature), with ${BLANK} exactly once, where the transition goes. The ideas around the blank must make the word's relationship clear, so a careful reader can work out the answer. Use a different topic from the example and from any earlier passages listed. Don't attribute invented findings or quotes to real people.
- answer: the word exactly as it fills the blank: capitalized if it starts a sentence, followed by a comma if the sentence needs one (for example "However," or "for example,").
- wrong_choices: 3 wrong choices, each taken from the allowed list and written the same way the answer is in that blank. Each must clearly not fit the logic of the passage, while still being a tempting choice. Usually that means a different relationship from the answer; for relationships like time order, attitude, or condition, a word of the same relationship with the wrong meaning (for example "Previously," where "Afterward," is right) is fine, as long as only one choice works.
- explanation: 1-3 sentences for a high school student on why the answer fits the relationship between the ideas and why the other choices don't.`;

function prompt(word, earlier) {
  const t = byName[word];
  const sample = bankQuestion[word];
  const allowed = TRANSITIONS.filter((o) => o.transition !== word)
    .map((o) => `${o.transition} (${o.relationship})`).join("; ");
  return [
    `Transition: ${word}`,
    `Relationship: ${t.relationship}: ${relationshipMeaning[t.relationship] || ""}`,
    `What it does: ${t.meaning}`,
    `Difficulty: ${t.difficulty}`,
    sample ? `Example question:\nPassage: ${sample.passage}\nChoices: ${sample.choices.join(" / ")}\nAnswer: ${sample.choices["ABCD".indexOf(sample.answer)]}\nExplanation: ${sample.explanation}` : "",
    earlier.length ? `Earlier passages for this word (use a different topic):\n${earlier.map((p) => `- ${p}`).join("\n")}` : "",
    `Allowed wrong choices: ${allowed}`,
  ].filter(Boolean).join("\n\n");
}

// Asks Claude for a question, trying again once if it doesn't pass checkQuestion.
async function writeQuestion(word, earlier) {
  const client = new Anthropic({ apiKey: anthropicKey.value() });
  let problem = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await client.beta.messages.parse({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      // Claude Opus 5.5 declines some requests; "default" re-runs a declined one on another model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: betaZodOutputFormat(QuestionContent) },
      system: SYSTEM,
      messages: [{
        role: "user",
        content: prompt(word, earlier) + (problem ? `\n\nA previous attempt was rejected because ${problem}. Fix that.` : ""),
      }],
    });
    if (response.stop_reason === "refusal" || !response.parsed_output) {
      problem = "no question came back";
      console.error("No usable question", word, response.stop_reason, response._request_id);
      continue;
    }
    try {
      return checkQuestion(word, response.parsed_output);
    } catch (err) {
      problem = err.message;
      console.warn("Rejected question", word, problem, response._request_id);
    }
  }
  throw new Error(`no usable question: ${problem}`);
}

// In the emulator: the bank question with a marked passage, so testing costs nothing.
function placeholderQuestion(word, made) {
  const { passage, choices, answer, explanation, relationship, difficulty, rarity } = bankQuestion[word];
  const correct = "ABCD".indexOf(answer);
  return { transition: word, relationship, passage: `[Test question ${made}] ${passage}`, choices, correct, explanation, difficulty, rarity };
}

const utcDay = (now) => new Date(now).toISOString().slice(0, 10);

export const newTransitionQuestion = onCall({ secrets: [anthropicKey], timeoutSeconds: 300 }, async (request) => {
  const uid = request.auth?.uid;
  const email = request.auth?.token?.email?.toLowerCase();
  if (!uid || !email || request.auth.token.email_verified !== true) {
    throw new HttpsError("unauthenticated", "Sign in to practice.");
  }
  const word = baseForm(request.data?.transition);
  if (!byName[word]) throw new HttpsError("invalid-argument", "That isn't a transition in the app.");

  const db = getFirestore();
  // The same students the Firestore rules let save progress: opened the app, not blocked.
  const [visited, blocked, progress] = await Promise.all([
    db.doc(`transitionusers/${uid}`).get(),
    db.doc(`blocked/${email}`).get(),
    db.doc(`transitionprogress/${uid}`).get(),
  ]);
  if (!visited.exists || blocked.exists) throw new HttpsError("permission-denied", "You don't have access to SAT Transitions.");
  const record = progress.get("words")?.[word];
  if (!record || !(record.correct >= 1 && record.correct < MASTERED_AT) || !record.rightAt) {
    throw new HttpsError("failed-precondition", "A new question comes after a correct answer, until the word is mastered.");
  }

  // Reserve today's slot, once for each correct answer.
  const ref = db.doc(`transitionquestions/${uid}`);
  const reserved = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const stored = snap.get("words")?.[word];
    if (stored?.forRight === record.rightAt) return null;
    const today = utcDay(Date.now());
    const used = snap.get("day") === today ? snap.get("today") || 0 : 0;
    if (used >= DAILY_LIMIT) {
      throw new HttpsError("resource-exhausted", "That's enough new questions for today. Keep practicing with the ones you have.");
    }
    tx.set(ref, { day: today, today: used + 1 }, { merge: true });
    return { made: (stored?.made || 0) + 1, earlier: stored?.earlier || [] };
  });
  if (!reserved) {
    const stored = (await ref.get()).get("words")?.[word];
    return { question: stored?.question || null };
  }

  let question;
  try {
    question = emulator ? placeholderQuestion(word, reserved.made) : await writeQuestion(word, reserved.earlier);
  } catch (err) {
    console.error("Couldn't write a question", word, err);
    throw new HttpsError("unavailable", "Couldn't write a new question right now.");
  }
  const id = `${bankQuestion[word]?.id || word}-${reserved.made}`;
  question = { id, ...question };
  await ref.set({
    words: {
      [word]: {
        question,
        made: reserved.made,
        forRight: record.rightAt,
        at: FieldValue.serverTimestamp(),
        // Recent passages, so Claude picks a new topic each time.
        earlier: [...reserved.earlier, question.passage].slice(-4),
      },
    },
  }, { merge: true });
  return { question };
});
