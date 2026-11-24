// SAT Reading (satreading.web.app, its own repo): writing and reviewing the
// shared batches of 150 questions, and new answer choices for missed questions.
//
// Batches. All students share batch 1, 2, 3, ... (/readingbatches/{n}). When a
// student gets within NEXT_AT questions of finishing the newest batch, the app
// calls prepareReadingBatch, which starts the next one (/readingjobs/{n}). A
// job's items (/readingjobs/{n}/items/{id}) are the 105 SAT-style questions and
// 7 ACT-style sets it tries to write, a few more than the 96 and 6 it needs.
// A job goes in rounds, each sent to Claude's Message Batches API (half price).
// Before each round, items that need one get a source passage (reading-sources.js).
// In each round, the writer (Claude Opus 5.5) writes the items that need writing,
// which code then checks, and the Reviewer (Claude Opus 5.5 as an English
// professor) reviews the items written in the round before: it answers each
// question without the key and approves, revises, or rejects it. Rejected items
// get a new source or are written again; revised ones are reviewed again. After MAX_ROUNDS rounds, or once every item is approved or
// failed, the approved items become the batch. advanceReadingJobs moves jobs
// along every 5 minutes; a new job starts right away (onReadingJobCreated).
//
// Approved questions a batch doesn't use go to /readingreserve and are used
// first in the next batch.
//
// Missed questions. rewriteReadingChoices gives a student who just missed a
// question a new set of answer choices (the passage and question stay). Every set
// is kept in a shared pool, /readingchoicebank/{question id}; the student gets a
// set they haven't seen, and only when none is left does the Reviewer write a new
// one (checking it by answering cold) and add it to the pool. The student's
// current set is in /readingchoices/{uid}.
//
// In the emulator a stand-in for Claude writes simple questions from the real
// sources, so the whole pipeline runs without cost. Set READING_REAL_CLAUDE=1 to
// use Claude there.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import {
  ShortDraft, SetDraft, SetReplacement, ShortReview, SetReview, NewChoices, ColdAnswer,
  WRITER_SYSTEM, REVIEWER_SYSTEM, ACT_KINDS, SET_SIZE, BATCH_SIZE,
  shortWriterPrompt, setWriterPrompt, setReplacementPrompt, shortReviewPrompt, setReviewPrompt,
  newChoicesPrompt, coldAnswerPrompt, checkShortDraft, checkSetDraft, checkSetQuestions,
  applyShortReview, applySetReview, finishSet, assembleBatch, useReserve, planItems, numbers, normalize, storeDraft, BLANK,
} from "./reading-content.js";
import { findSource } from "./reading-sources.js";
import { anthropicKey } from "./secrets.js";

const MODEL = "claude-opus-5-5";
// Start the next batch when a student has this many questions or fewer left.
export const NEXT_AT = 20;
// Rounds per batch (each round writes some items and reviews others), tries per
// item, and reviews per item.
const MAX_ROUNDS = 7;
const MAX_ATTEMPTS = 4;
const MAX_REVIEWS = 3;
// A batch with fewer approved questions than this isn't published.
const MIN_PUBLISH = 100;
// New answer choices per student per UTC day.
export const DAILY_REWRITES = 100;
// Keep in sync with OWNER_EMAILS in index.js.
const OWNER_EMAILS = ["tychung01@gmail.com"];

const emulator = process.env.FUNCTIONS_EMULATOR === "true";
const fakeClaude = emulator && process.env.READING_REAL_CLAUDE !== "1";

// ---------- access ----------

async function isTeacher(db, auth) {
  const email = auth?.token?.email?.toLowerCase();
  if (!email || auth.token.email_verified !== true) return false;
  if (OWNER_EMAILS.includes(email)) return true;
  return (await db.doc(`teachers/${email}`).get()).exists;
}

// The same people the Firestore rules let study: opened SAT Reading, not blocked.
async function requireStudent(db, request) {
  const uid = request.auth?.uid;
  const email = request.auth?.token?.email?.toLowerCase();
  if (!uid || !email || request.auth.token.email_verified !== true) throw new HttpsError("unauthenticated", "Sign in to practice.");
  const [visited, blocked, teacher] = await Promise.all([
    db.doc(`readingusers/${uid}`).get(),
    db.doc(`blocked/${email}`).get(),
    isTeacher(db, request.auth),
  ]);
  if (!teacher && (!visited.exists || blocked.exists)) throw new HttpsError("permission-denied", "You don't have access to SAT Reading.");
  return { uid, teacher };
}

// ---------- Claude ----------

function format(schema) {
  const f = zodOutputFormat(schema);
  return { format: { type: f.type, schema: f.schema }, parse: f.parse };
}
const REVIEW_KINDS = new Set(["shortReview", "setReview"]);
const FORMATS = {
  short: format(ShortDraft), set: format(SetDraft), replace: format(SetReplacement),
  shortReview: format(ShortReview), setReview: format(SetReview),
};

// The Message Batches request for an item in a phase ("write" or "review").
function buildRequest(item, phase, round) {
  let system = WRITER_SYSTEM;
  let effort = "medium";
  let content;
  let kind;
  let maxTokens = 16000;
  if (phase === "write") {
    if (item.kind === "short") [kind, content] = ["short", shortWriterPrompt(item, item.problem)];
    else if (item.replace?.length && item.draft) [kind, content, maxTokens] = ["replace", setReplacementPrompt(item), 24000];
    else [kind, content, maxTokens] = ["set", setWriterPrompt(item, item.problem), 32000];
  } else {
    system = REVIEWER_SYSTEM;
    effort = "high";
    if (item.kind === "short") [kind, content] = ["shortReview", shortReviewPrompt(item)];
    else [kind, content, maxTokens] = ["setReview", setReviewPrompt(item), 32000];
  }
  return {
    custom_id: `${item.id}-${phase}-${round}`,
    kind,
    params: {
      model: MODEL,
      max_tokens: maxTokens,
      // The same long instructions open every request, so they can be read from the cache.
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content }],
      output_config: { effort, format: FORMATS[kind].format },
    },
  };
}

function realBatches() {
  const client = new Anthropic({ apiKey: anthropicKey.value() });
  return {
    async create(requests) {
      const batch = await client.messages.batches.create({ requests: requests.map(({ custom_id, params }) => ({ custom_id, params })) });
      return batch.id;
    },
    async status(id) {
      return (await client.messages.batches.retrieve(id)).processing_status;
    },
    async results(id) {
      const out = [];
      for await (const r of await client.messages.batches.results(id)) {
        if (r.result.type === "succeeded") {
          const m = r.result.message;
          out.push({ id: r.custom_id, ok: true, stop: m.stop_reason, text: m.content.filter((b) => b.type === "text").map((b) => b.text).join(""), usage: m.usage });
        } else {
          out.push({ id: r.custom_id, ok: false, error: r.result.type === "errored" ? r.result.error?.error?.message || "error" : r.result.type });
        }
      }
      return out;
    },
  };
}

// ---------- the emulator's stand-in for Claude ----------

const sentences = (text) => String(text).replace(/\s+/g, " ").match(/[^.!?]+[.!?]+["'”’]?/g) || [String(text)];
function firstWords(text, max) {
  const out = [];
  let words = 0;
  for (const s of sentences(text)) {
    const n = s.trim().split(/\s+/).length;
    if (words && words + n > max) break;
    out.push(s.trim());
    words += n;
  }
  return out.join(" ");
}
const fakeChoices = (label) => [`${label}: the reading the passage supports`, `${label}: a reading that goes too far`, `${label}: a detail mistaken for the point`, `${label}: the opposite of what it says`];

// A full answer saying the source doesn't fit, as Claude's answer format requires.
const unfit = (whyNot) => ({
  fits: false, why_not: whyNot, title: "", intro: "", passage: "", passage2: "", notes: [], table_title: "", table_columns: [], table_rows: [],
  question: "", choices: [], answer: 0, difficulty: "Medium", paragraphs: [], questions: [],
});

function fakeShort(item) {
  const text = item.source.text;
  let passage = firstWords(text, 90);
  let passage2 = "";
  let notes = [];
  let question = "Which choice best states the main idea of the text?";
  let table = { title: "", columns: [], rows: [] };
  if (item.type === "inference") {
    passage = `${firstWords(text, 70)} This suggests that ${BLANK}.`;
    question = "Which choice most logically completes the text?";
  } else if (item.type === "words_in_context") {
    const word = (passage.match(/\b[a-z]{7,}\b/) || ["important"])[0];
    question = `As used in the text, what does the word "${word}" most nearly mean?`;
  } else if (item.type === "cross_text") {
    const all = sentences(text);
    passage = firstWords(all.slice(0, Math.ceil(all.length / 2)).join(" "), 70);
    passage2 = firstWords(all.slice(Math.ceil(all.length / 2)).join(" "), 70);
    if (passage2.split(" ").length < 25) passage2 = firstWords(text, 60);
    question = "Based on the texts, how would the author of Text 2 most likely respond to Text 1?";
  } else if (item.type === "rhetorical_synthesis") {
    notes = sentences(text).slice(0, 5).map((s) => s.trim()).filter((s) => s.split(" ").length < 40).slice(0, 5);
    while (notes.length < 4) notes.push(`The text is titled ${item.source.title.replace(/\d/g, "")}.`);
    passage = "";
    question = "The student wants to introduce the topic. Which choice most effectively uses relevant information from the notes to accomplish this goal?";
  } else if (item.type === "evidence_table") {
    const found = [...new Set(numbers(text))].slice(0, 4);
    if (found.length < 2) return unfit("no numbers in the source");
    table = { title: "Figures from the study", columns: ["Measure", "Value"], rows: found.map((n, i) => [`Measure ${"ABCD"[i]}`, n]) };
    question = "Which choice most effectively uses data from the table to support the claim?";
  } else if (item.type === "structure_purpose") {
    const s = sentences(passage);
    if (s.length > 1) {
      passage = [s[0], `{{${s[1].trim()}}}`, ...s.slice(2)].join(" ");
      question = "Which choice best describes the function of the underlined sentence in the text as a whole?";
    } else question = "Which choice best states the main purpose of the text?";
  } else if (item.type === "evidence_text") {
    question = "Which finding, if true, would most directly support the claim in the text?";
  }
  return {
    fits: true, why_not: "", title: item.source.title.split(" ").slice(0, 4).join(" "), intro: "",
    passage, passage2, notes, table_title: table.title, table_columns: table.columns, table_rows: table.rows,
    question: `[Test] ${question}`, choices: fakeChoices(item.type), answer: Math.floor(Math.random() * 4), difficulty: item.difficulty,
  };
}

function fakeSetQuestions(types, offset = 0) {
  return types.map((type, i) => ({ type, question: `[Test] Question ${offset + i + 1} (${type}): which choice is best supported by the passage?`, choices: fakeChoices(`Q${offset + i + 1}`), answer: (offset + i) % 4, difficulty: "Medium" }));
}

function fakeSet(item) {
  const all = sentences(item.source.text);
  const paragraphs = [];
  let words = 0;
  let current = [];
  for (const s of all) {
    if (words >= 620) break;
    current.push(s.trim());
    words += s.trim().split(/\s+/).length;
    if (current.length === 4) { paragraphs.push(current.join(" ")); current = []; }
  }
  if (current.length) paragraphs.push(current.join(" "));
  if (paragraphs.length < 5) return unfit("too short");
  return {
    fits: true, why_not: "", title: item.source.title.split(" ").slice(0, 4).join(" "),
    intro: `${ACT_KINDS[item.subject]}: This passage is adapted from ${item.source.title} by ${item.source.author} (${item.source.year}).`,
    paragraphs: paragraphs.slice(0, 9), questions: fakeSetQuestions(item.types),
  };
}

// Approves most questions; asks for a fix to some and rejects a few, so every path runs.
function fakeReview(item) {
  const proof = (text) => firstWords(text, 12).split(" ").slice(0, 6).join(" ");
  if (item.kind === "short") {
    const d = item.draft;
    const text = d.passage || d.notes[0];
    const base = { answer: d.answer, proof_quote: proof(text), problems: [], revised_question: "", revised_choices: [], revised_answer: -1, explanation: `[Test] The text says "${proof(text)}", which supports choice ${"ABCD"[d.answer]}.`, notes: "[Test] Review by the emulator." };
    if (item.id.endsWith("7") && item.reviews === 0) return { ...base, verdict: "revise", problems: ["[Test] reword the question"], revised_question: `${d.question} (revised)`, revised_choices: d.choices.map((c) => `${c} (revised)`), revised_answer: d.answer };
    if (item.id.endsWith("3") && item.attempts === 0) return { ...base, verdict: "reject", problems: ["[Test] rejected to try a new source"] };
    return { ...base, verdict: "approve" };
  }
  const text = item.draft.paragraphs.join(" ");
  return {
    passage_ok: true, passage_problems: [], notes: "[Test] Set review by the emulator.",
    questions: item.draft.questions.map((q, i) => ({ q, i })).filter(({ i }) => item.qstate[i] !== "approved").map(({ q, i }) => ({
      number: i + 1, answer: q.answer, proof_quote: proof(text), problems: [],
      verdict: i === 1 && item.reviews === 0 ? "reject" : "approve",
      revised_question: "", revised_choices: [], revised_answer: -1, explanation: `[Test] Paragraph 1 supports choice ${q.answer + 1}.`,
    })),
  };
}

function fakeAnswer(req, item) {
  if (req.kind === "short") return fakeShort(item);
  if (req.kind === "set") return fakeSet(item);
  if (req.kind === "replace") return { questions: fakeSetQuestions(item.replace.map((i) => item.draft.questions[i].type), 100) };
  return fakeReview(item);
}

function fakeBatches(db) {
  return {
    async create(requests, items) {
      const results = requests.map((req) => {
        const item = items[req.custom_id.split("-")[0]];
        return { id: req.custom_id, ok: true, stop: "end_turn", text: JSON.stringify(fakeAnswer(req, item)), usage: { input_tokens: 1000, output_tokens: 500 } };
      });
      const ref = db.collection("readingfake").doc();
      await ref.set({ results });
      return `fake_${ref.id}`;
    },
    status: async () => "ended",
    async results(id) {
      return (await db.doc(`readingfake/${id.slice(5)}`).get()).get("results") || [];
    },
  };
}

// ---------- moving a job along ----------

const jobRef = (db, number) => db.doc(`readingjobs/${number}`);

function log(job, message) {
  console.log(`Reading batch ${job.number}: ${message}`);
  return [...(job.log || []), { at: Date.now(), message }].slice(-30);
}

// The item after a writer's answer. `res` is { ok, stop, text } or { ok: false, error }.
export function afterWrite(item, kind, res) {
  const retry = (problem) => ({ attempts: item.attempts + 1, problem, state: item.attempts + 1 >= MAX_ATTEMPTS ? "failed" : "write" });
  const newSource = (problem) => ({ attempts: item.attempts + 1, problem: "", lastProblem: problem, state: item.attempts + 1 >= MAX_ATTEMPTS ? "failed" : "source", draft: null, replace: [] });
  if (!res.ok) return { ...retry(`the request failed (${res.error})`), problem: item.problem };
  if (res.stop === "refusal") return newSource("Claude declined this source");
  let parsed;
  try {
    parsed = FORMATS[kind].parse(res.text);
  } catch (err) {
    return retry(res.stop === "max_tokens" ? "the answer was cut off; keep it shorter" : "the answer didn't match the required format");
  }
  if (kind === "replace") {
    const questions = item.draft.questions.map((q) => ({ ...q }));
    if (parsed.questions.length !== item.replace.length) return retry(`write exactly ${item.replace.length} questions`);
    item.replace.forEach((slot, k) => { questions[slot] = parsed.questions[k]; });
    const problem = checkSetQuestions(questions, item.types);
    if (problem) return retry(problem);
    const qstate = item.qstate.map((s, i) => (item.replace.includes(i) ? "review" : s));
    return { state: "review", draft: { ...item.draft, questions }, qstate, replace: [], problem: "" };
  }
  if (!parsed.fits) return newSource(parsed.why_not || "the source didn't fit");
  const problem = kind === "short" ? checkShortDraft(item, parsed) : checkSetDraft(item, parsed);
  if (problem) return retry(problem);
  const set = kind === "set" ? { qstate: parsed.questions.map(() => "review"), explanations: [], evidence: [], replace: [] } : {};
  return { state: "review", draft: storeDraft(parsed), problem: "", ...set };
}

export function afterReview(item, kind, res) {
  if (!res.ok || res.stop === "refusal") return { reviews: item.reviews + 1, state: item.reviews + 1 >= MAX_REVIEWS ? "failed" : "review" };
  let parsed;
  try {
    parsed = FORMATS[kind].parse(res.text);
  } catch {
    return { reviews: item.reviews + 1, state: item.reviews + 1 >= MAX_REVIEWS ? "failed" : "review" };
  }
  if (item.kind === "short") {
    const changes = applyShortReview(item, parsed);
    if (changes.state === "review") changes.reviews = item.reviews + 1;
    if (changes.state === "review" && changes.reviews >= MAX_REVIEWS) changes.state = "failed";
    if (["write", "source"].includes(changes.state) && (changes.attempts ?? item.attempts) >= MAX_ATTEMPTS) changes.state = "failed";
    if (changes.state === "source") changes.draft = null;
    return changes;
  }
  const changes = applySetReview(item, parsed);
  if (changes.state === "source") return (changes.attempts >= MAX_ATTEMPTS) ? { ...changes, state: "failed" } : { ...changes, draft: null, qstate: [], replace: [] };
  if (changes.state !== "approved" && changes.reviews >= MAX_REVIEWS) return { ...changes, ...finishSet({ ...item, ...changes }) };
  return changes;
}

async function mapLimit(list, limit, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) await fn(list[next++]);
  }));
}

function addUsage(total, usage) {
  if (!usage) return total;
  return {
    input: (total.input || 0) + (usage.input_tokens || 0),
    output: (total.output || 0) + (usage.output_tokens || 0),
    cacheRead: (total.cacheRead || 0) + (usage.cache_read_input_tokens || 0),
    cacheWrite: (total.cacheWrite || 0) + (usage.cache_creation_input_tokens || 0),
  };
}

// Batch prices for Claude Opus 5.5 (half of $4 / $20 per million tokens).
export function costDollars(u = {}) {
  return ((u.input || 0) * 2 + (u.output || 0) * 10 + (u.cacheRead || 0) * 0.1 + (u.cacheWrite || 0) * 2.5) / 1e6;
}

function countStates(items) {
  const counts = {};
  for (const item of Object.values(items)) counts[item.state] = (counts[item.state] || 0) + 1;
  return counts;
}

// One step of a job: collect results of the request batch it's waiting for, find
// sources, send the next round, or put the batch together.
async function step(db, ref, job, claude) {
  const snap = await ref.collection("items").get();
  const items = Object.fromEntries(snap.docs.map((d) => [d.id, d.data()]));
  const save = async (changed) => {
    const writes = db.batch();
    for (const id of changed) writes.set(ref.collection("items").doc(id), items[id]);
    if (changed.length) await writes.commit();
  };
  const update = {};

  // 1. Results of the round in progress.
  if (job.claudeBatch) {
    const status = await claude.status(job.claudeBatch);
    if (status !== "ended") return;
    const results = await claude.results(job.claudeBatch);
    let usage = job.usage || {};
    const changed = [];
    for (const res of results) {
      const id = res.id.split("-")[0];
      const item = items[id];
      const kind = job.kinds?.[res.id];
      if (!item || !kind) continue;
      usage = addUsage(usage, res.usage);
      const changes = REVIEW_KINDS.has(kind) ? afterReview(item, kind, res) : afterWrite(item, kind, res);
      items[id] = { ...item, ...changes };
      changed.push(id);
    }
    // Requests with no result (the batch was canceled or expired) are sent again.
    await save(changed);
    Object.assign(update, { claudeBatch: null, kinds: {}, usage });
    job = { ...job, ...update, log: log(job, `round ${job.round} done: ${JSON.stringify(countStates(items))}`) };
    update.log = job.log;
  }

  // 2. Sources for items that need one.
  const needSource = Object.values(items).filter((i) => i.state === "source");
  if (needSource.length) {
    const meta = await db.doc("readingmeta/sources").get();
    const used = new Set([...Object.keys(meta.get("used") || {}), ...Object.values(items).map((i) => i.source?.key).filter(Boolean)]);
    await mapLimit(needSource, 6, async (item) => {
      let source = null;
      try {
        source = await findSource(item, used);
      } catch (err) {
        console.warn("Source search failed", item.id, err.message);
      }
      items[item.id] = source
        ? { ...item, source, state: "write", problem: "", draft: null }
        : { ...item, attempts: item.attempts + 1, state: item.attempts + 1 >= MAX_ATTEMPTS ? "failed" : "source" };
    });
    await save(needSource.map((i) => i.id));
  }

  // 3. The next round: items to write and items to review go in the same request batch.
  const all = Object.values(items);
  const round = job.round || 0;
  const list = round < MAX_ROUNDS ? all.filter((i) => i.state === "write" || i.state === "review") : [];
  if (!list.length && all.some((i) => i.state === "source") && round < MAX_ROUNDS) {
    // Sources weren't found this time; try again on the next step.
    update.counts = countStates(items);
    await ref.update(update);
    return;
  }
  if (list.length) {
    const number = round + 1;
    const requests = list.map((item) => buildRequest(item, item.state === "write" ? "write" : "review", number));
    const id = await claude.create(requests, items);
    const writing = list.filter((i) => i.state === "write").length;
    Object.assign(update, {
      claudeBatch: id, round: number, kinds: Object.fromEntries(requests.map((r) => [r.custom_id, r.kind])),
      phase: writing ? "write" : "review", counts: countStates(items),
      log: log({ ...job, ...update }, `round ${number}: sent ${writing} to the writer and ${list.length - writing} to the Reviewer`),
    });
    await ref.update(update);
    return;
  }

  // 4. Done: items left unfinished fail, and the approved ones become the batch.
  const unfinished = all.filter((i) => !["approved", "failed"].includes(i.state));
  for (const item of unfinished) items[item.id] = item.kind === "set" && item.draft ? { ...item, ...finishSet(item) } : { ...item, state: "failed" };
  await save(unfinished.map((i) => i.id));
  const { batch, leftover } = assembleBatch(job.number, Object.values(items));
  const counts = countStates(items);
  if (batch.questions.length < MIN_PUBLISH) {
    await ref.update({ ...update, status: "failed", counts, log: log({ ...job, ...update }, `only ${batch.questions.length} questions passed; not published`) });
    return;
  }
  const usedKeys = Object.fromEntries(Object.values(items).filter((i) => i.state === "approved" && i.source).map((i) => [i.source.key, job.number]));
  await db.doc(`readingbatches/${job.number}`).set({ ...batch, createdAt: FieldValue.serverTimestamp(), pulled: {} });
  await db.doc("readingmeta/sources").set({ used: usedKeys }, { merge: true });
  // Approved questions this batch didn't need wait in the reserve for the next one.
  if (leftover.length) {
    const writes = db.batch();
    for (const id of leftover) {
      writes.set(db.doc(`readingreserve/b${job.number}-${id}`), { ...items[id], fromBatch: job.number, keptAt: Date.now() });
    }
    await writes.commit();
  }
  await ref.update({
    ...update, status: "done", counts, finishedAt: FieldValue.serverTimestamp(),
    log: log({ ...job, ...update }, `published ${batch.questions.length} questions (${Object.keys(batch.sets).length} ACT-style sets); ${leftover.length} kept for the next batch`),
  });
}

// Runs one step of a job, unless another run is already working on it.
export async function advanceJob(number) {
  const db = getFirestore();
  const ref = jobRef(db, number);
  const job = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get("status") !== "active" || (snap.get("busyUntil") || 0) > Date.now()) return null;
    tx.update(ref, { busyUntil: Date.now() + 9 * 60 * 1000 });
    return snap.data();
  });
  if (!job) return;
  try {
    await step(db, ref, job, fakeClaude ? fakeBatches(db) : realBatches());
  } catch (err) {
    console.error(`Reading batch ${number} step failed`, err);
    await ref.update({ lastError: String(err.message || err).slice(0, 500), log: log(job, `error: ${String(err.message || err).slice(0, 200)}`) });
  } finally {
    await ref.update({ busyUntil: 0 });
  }
}

// Creates job `number` with its items, unless it exists. Returns whether it did.
async function createJob(db, number, startedBy) {
  const ref = jobRef(db, number);
  // Approved questions earlier batches didn't use come first.
  const reserveSnap = await db.collection("readingreserve").get();
  const { items, usedReserve } = useReserve(planItems(), reserveSnap.docs.map((d) => ({ ...d.data(), reserveId: d.id })));
  const created = await db.runTransaction(async (tx) => {
    if ((await tx.get(ref)).exists) return false;
    tx.set(ref, {
      number, status: "items", round: 0, claudeBatch: null, kinds: {}, usage: {},
      startedBy, createdAt: FieldValue.serverTimestamp(), busyUntil: 0, log: [{ at: Date.now(), message: "started" }],
      counts: countStates(Object.fromEntries(items.map((i) => [i.id, i]))),
    });
    return true;
  });
  if (!created) return false;
  const writes = db.batch();
  for (const item of items) writes.set(ref.collection("items").doc(item.id), item);
  for (const id of usedReserve) writes.delete(db.doc(`readingreserve/${id}`));
  await writes.commit();
  if (usedReserve.length) await ref.update({ log: [{ at: Date.now(), message: `started with ${usedReserve.length} questions kept from earlier batches` }] });
  // The trigger below starts it once every item is saved.
  await ref.update({ status: "active" });
  return true;
}

async function latestBatch(db) {
  const snap = await db.collection("readingbatches").orderBy("number", "desc").limit(1).get();
  return snap.empty ? null : snap.docs[0];
}

// ---------- functions ----------

const PIPELINE = { secrets: [anthropicKey], timeoutSeconds: 540, memory: "1GiB" };

export const onReadingJobCreated = onDocumentCreated({ document: "readingjobs/{number}", ...PIPELINE }, async (event) => {
  const number = Number(event.params.number);
  // createJob marks the job active after saving its items.
  for (let i = 0; i < 20; i++) {
    const snap = await getFirestore().doc(`readingjobs/${number}`).get();
    if (snap.get("status") === "active") break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  await advanceJob(number);
});

export const advanceReadingJobs = onSchedule({ schedule: "every 5 minutes", ...PIPELINE }, async () => {
  const snap = await getFirestore().collection("readingjobs").where("status", "==", "active").get();
  for (const doc of snap.docs) await advanceJob(doc.get("number"));
});

// Called by the app after each round: starts the next batch when this student is
// within NEXT_AT questions of finishing the newest one (or batch 1 if there's none).
export const prepareReadingBatch = onCall({ timeoutSeconds: 60 }, async (request) => {
  const db = getFirestore();
  const { uid, teacher } = await requireStudent(db, request);
  const latest = await latestBatch(db);
  const latestNumber = latest ? latest.get("number") : 0;
  const next = latestNumber + 1;
  const job = await jobRef(db, next).get();
  if (job.exists) {
    // A teacher can try a failed batch again.
    if (job.get("status") === "failed" && teacher && request.data?.retry) {
      const items = await job.ref.collection("items").get();
      const writes = db.batch();
      for (const d of items.docs) {
        if (d.get("state") === "failed") writes.update(d.ref, { state: "source", attempts: 0, reviews: 0, problem: "", draft: null, replace: [] });
      }
      await writes.commit();
      await job.ref.update({ status: "active", round: 0, claudeBatch: null, busyUntil: 0 });
      await advanceJob(next);
    }
    return { latest: latestNumber, next, status: (await job.ref.get()).get("status") };
  }
  let start = !latest;
  if (latest) {
    const progress = await db.doc(`readingprogress/${uid}`).get();
    const answers = progress.get("answers") || {};
    const pulled = latest.get("pulled") || {};
    const left = latest.get("questions").filter((q) => !pulled[q.id] && !answers[q.id]?.ok).length;
    start = left <= NEXT_AT;
  }
  if (!start) return { latest: latestNumber, next, status: "not-yet" };
  await createJob(db, next, uid);
  return { latest: latestNumber, next, status: "active" };
});

// Teachers: move every unfinished batch along now instead of waiting for the next check.
export const checkReadingBatches = onCall({ ...PIPELINE }, async (request) => {
  const db = getFirestore();
  if (!(await isTeacher(db, request.auth))) throw new HttpsError("permission-denied", "Only teachers can do this.");
  const snap = await db.collection("readingjobs").where("status", "==", "active").get();
  for (const doc of snap.docs) await advanceJob(doc.get("number"));
  return { checked: snap.size };
});

// ---------- new choices for a missed question ----------

const utcDay = (now) => new Date(now).toISOString().slice(0, 10);

async function askClaude(schema, system, content, effort) {
  const client = new Anthropic({ apiKey: anthropicKey.value() });
  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    // Claude Opus 5.5 declines some requests; "default" re-runs a declined one on another model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort, format: zodOutputFormat(schema) },
    system,
    messages: [{ role: "user", content }],
  });
  if (response.stop_reason === "refusal" || !response.parsed_output) throw new Error(`no answer (${response.stop_reason})`);
  return response.parsed_output;
}

const shuffle = (list) => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// Checks new choices: 4 distinct ones, none a copy of an old choice. Returns a problem or null.
export function checkNewChoices(question, made) {
  const choices = [made.correct_choice, ...made.wrong_choices].map((c) => String(c).trim());
  if (made.wrong_choices.length !== 3) return "there must be 3 wrong choices";
  if (choices.some((c) => !c || c.length > 400)) return "a choice is empty or too long";
  if (new Set(choices.map(normalize)).size !== 4) return "two choices are the same";
  const old = new Set(question.choices.map(normalize));
  if (choices.slice(1).some((c) => old.has(normalize(c)))) return "a wrong choice is one of the old choices";
  if (!made.explanation.trim()) return "the explanation is missing";
  return null;
}

async function writeNewChoices(question, set, picked) {
  if (fakeClaude) {
    const wrong = question.choices.filter((_, i) => i !== question.correct).map((c) => `${c} (new)`);
    return { choices: [`${question.choices[question.correct]} (reworded)`, ...wrong], correct: 0, explanation: `[Test] New choices. ${question.explanation}` };
  }
  let problem = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const made = await askClaude(NewChoices, REVIEWER_SYSTEM, newChoicesPrompt(question, set, picked) + (problem ? `\n\nAn earlier attempt was rejected: ${problem}. Fix that.` : ""), "medium");
    problem = checkNewChoices(question, made);
    if (problem) continue;
    // The Reviewer answers the new version cold; it must pick the right answer.
    const choices = shuffle([made.correct_choice, ...made.wrong_choices].map((c) => c.trim()));
    const correct = choices.indexOf(made.correct_choice.trim());
    // A quick check, so it runs at low effort to keep the cost of each missed question down.
    const cold = await askClaude(ColdAnswer, REVIEWER_SYSTEM, coldAnswerPrompt(question, set, choices), "low");
    if (cold.answer === correct) return { choices, correct, explanation: made.explanation };
    problem = `answering without the key, the Reviewer picked "${choices[cold.answer] ?? cold.answer}" (${cold.reasoning})`;
  }
  throw new Error(`no usable choices: ${problem}`);
}

export const rewriteReadingChoices = onCall({ secrets: [anthropicKey], timeoutSeconds: 300 }, async (request) => {
  const db = getFirestore();
  const { uid } = await requireStudent(db, request);
  const qid = String(request.data?.qid || "");
  const match = qid.match(/^b(\d+)-\d{3}$/);
  if (!match) throw new HttpsError("invalid-argument", "That isn't a question in the app.");
  const [batch, progress] = await Promise.all([db.doc(`readingbatches/${match[1]}`).get(), db.doc(`readingprogress/${uid}`).get()]);
  const question = batch.exists ? batch.get("questions").find((q) => q.id === qid) : null;
  if (!question) throw new HttpsError("not-found", "That question isn't in the app.");
  const record = progress.get("answers")?.[qid];
  const tries = record?.tries || [];
  if (!tries.length || record.ok || tries.at(-1).ok) throw new HttpsError("failed-precondition", "New choices come after a missed question.");

  const ref = db.doc(`readingchoices/${uid}`);
  const poolRef = db.doc(`readingchoicebank/${qid}`);
  const forTry = tries.length;
  const [mine, pool] = await Promise.all([ref.get(), poolRef.get()]);
  const shown = mine.get("q")?.[qid];
  if (shown?.forTry === forTry) return { choices: shown };

  // A set from the pool this student hasn't seen: no need to ask the Reviewer.
  const seen = seenSets(shown);
  const unseen = (pool.get("sets") || []).filter((set) => !seen.includes(set.id));
  if (unseen.length) {
    const pick = unseen[Math.floor(Math.random() * unseen.length)];
    const saved = { choices: pick.choices, correct: pick.correct, explanation: pick.explanation, setId: pick.id, seen: [...seen, pick.id], forTry, at: Date.now(), reused: true };
    await ref.set({ q: { [qid]: saved } }, { merge: true });
    return { choices: saved };
  }

  // The Reviewer writes a new set: reserve today's slot, once for each missed try.
  const reserved = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.get("q")?.[qid]?.forTry === forTry) return false;
    const today = utcDay(Date.now());
    const used = snap.get("day") === today ? snap.get("today") || 0 : 0;
    if (used >= DAILY_REWRITES) throw new HttpsError("resource-exhausted", "That's enough new choices for today.");
    tx.set(ref, { day: today, today: used + 1 }, { merge: true });
    return true;
  });
  if (!reserved) return { choices: (await ref.get()).get("q")[qid] };

  const set = question.set ? batch.get("sets")[question.set] : null;
  // The choice the student picked, as they saw it.
  const picked = String(tries.at(-1).c ?? "") || (shown?.choices || question.choices)[tries.at(-1).p] || "";
  let made;
  try {
    made = await writeNewChoices(shown ? { ...question, choices: shown.choices, correct: shown.correct } : question, set, picked);
  } catch (err) {
    console.error("Couldn't write new choices", qid, err);
    throw new HttpsError("unavailable", "Couldn't write new choices right now.");
  }
  // Kept in the pool for other students who miss this question.
  const setId = await db.runTransaction(async (tx) => {
    const sets = (await tx.get(poolRef)).get("sets") || [];
    const id = `${qid}-c${sets.length + 1}`;
    tx.set(poolRef, { qid, sets: [...sets, { id, ...made, at: Date.now() }], updated: FieldValue.serverTimestamp() }, { merge: true });
    return id;
  });
  const saved = { ...made, setId, seen: [...seen, setId], forTry, at: Date.now() };
  await ref.set({ q: { [qid]: saved } }, { merge: true });
  return { choices: saved };
});

// The pool sets a student has been given for a question (their current one included).
export function seenSets(shown) {
  return [...new Set([...(shown?.seen || []), shown?.setId].filter(Boolean))];
}

export { BATCH_SIZE, SET_SIZE };
