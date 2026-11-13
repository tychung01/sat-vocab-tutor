// Cloud Functions for the teacher dashboard.
//
// writeWord: when a teacher adds a word, Claude writes everything the add-word
// dialog needs (part of speech, definition, an SAT-style example passage, and
// the quiz answer choices) so the teacher only has to check it. Only teachers
// can call it. The Anthropic API key is the ANTHROPIC_API_KEY secret
// (see FIREBASE-SETUP.md).
//
// remindInactive and sendTestReminder (reminders.js): evening reminder emails
// for students who haven't studied in more than 2 days.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { z } from "zod";

initializeApp();

export { remindInactive, sendTestReminder } from "./reminders.js";
const anthropicKey = defineSecret("ANTHROPIC_API_KEY");

// Keep in sync with OWNER_EMAILS in firebase-config.js and isAppOwner() in firestore.rules.
const OWNER_EMAILS = ["tychung01@gmail.com"];

// Whether the caller (the callable request's auth, with its verified ID token)
// is the owner or listed in /teachers. This is what keeps students from using
// the Anthropic API key, so it checks the token, never anything the caller sends.
async function isTeacher(auth) {
  const email = auth?.token?.email?.toLowerCase();
  if (!email || auth.token.email_verified !== true) return false;
  if (OWNER_EMAILS.includes(email)) return true;
  return (await getFirestore().doc(`teachers/${email}`).get()).exists;
}

const WordContent = z.object({
  part_of_speech: z.string().describe('Lowercase, e.g. "adjective"'),
  definition: z.string().describe("The definition of the sense the passage uses, one sentence"),
  passage: z.string().describe("The original SAT-style passage that uses the word once"),
  form: z.string().describe("The word exactly as it appears in the passage"),
  wrong_words: z.array(z.string()).describe("3 wrong choices for the fill-in-the-blank question"),
  meaning: z.string().describe("What the word means in the passage, as a short answer choice"),
  wrong_meanings: z.array(z.string()).describe("3 wrong choices for the most-nearly-means question"),
});

const SYSTEM = `You write vocabulary content for an SAT study app, in the style of the SAT's Words in Context questions.

Given a word, write:
- part_of_speech: the part of speech of the sense you use, lowercase.
- definition: a clear one-sentence definition of that sense, for a high school student.
- passage: an original passage of 2-3 sentences (about 30-70 words) on an SAT-like topic (science, history, social science, the arts, or literature) that uses the word exactly once, in the sense the SAT most often tests, with context clues that let a careful reader work out the meaning. The word must not be the first word of a sentence. Don't attribute invented findings or quotes to real people.
- form: the word exactly as it appears in the passage (for example "abandoned").
- wrong_words: 3 tempting wrong choices for a fill-in-the-blank question, each in the same grammatical form as \`form\` so it fits the sentence grammatically, but doesn't fit the meaning the context requires. None may be a synonym of the word.
- meaning: what the word means in the passage, as a short answer choice (1-6 words, first letter capitalized) in a form that could replace the word in the sentence.
- wrong_meanings: 3 wrong answer choices in the same style and form. Good traps are other senses of the word or plausible misreadings of the context.

If a definition from a dictionary is given, use the sense it describes unless the SAT more often tests another one.`;

export const writeWord = onCall({ secrets: [anthropicKey], timeoutSeconds: 120 }, async (request) => {
  if (!(await isTeacher(request.auth))) {
    throw new HttpsError("permission-denied", "Only teachers can add words.");
  }
  const word = String(request.data?.word || "").trim().toLowerCase();
  if (!/^[a-z]([a-z' -]*[a-z])?$/.test(word) || word.length > 60) {
    throw new HttpsError("invalid-argument", "Send a single word or phrase using letters only.");
  }
  const hint = String(request.data?.definition || "").slice(0, 500);

  const client = new Anthropic({ apiKey: anthropicKey.value() });
  let response;
  try {
    response = await client.beta.messages.parse({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      // Claude Opus 5.5 declines some requests; "default" re-runs a declined one on another model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: betaZodOutputFormat(WordContent) },
      system: SYSTEM,
      messages: [{
        role: "user",
        content: `Word: ${word}` + (hint ? `\nDictionary definition: ${hint}` : ""),
      }],
    });
  } catch (err) {
    console.error("Claude request failed", err);
    throw new HttpsError("unavailable", "Couldn't reach Claude. Please try again.");
  }
  if (response.stop_reason === "refusal" || !response.parsed_output) {
    console.error("No usable content", response.stop_reason, response._request_id);
    throw new HttpsError("internal", "Claude didn't write content for this word.");
  }
  return response.parsed_output;
});
