// SAT Math (satmath.web.app, its own repo): the Math Tutor writes and checks
// every question, and every question it writes is kept in one shared pool,
// /mathpool/{id}, that all students' batches are built from.
//
// Batches. All students share batch 1, 2, 3, ... (/mathbatches/{n}): 150 questions
// over the SAT Math skills and ACT topics (math-content.js). When a student gets
// within NEXT_AT questions of finishing the newest batch, the app calls
// prepareMathBatch, which starts the next one (/mathjobs/{n}). Its slots are filled
// first from pool questions no batch has used yet (twins and fresh questions
// written for students, spares); the Math Tutor writes the rest through Claude's
// Message Batches API (half price), in rounds. In each round it writes questions,
// code checks them, and it checks the ones written before: it solves each again
// from scratch without the key, with Claude's code tool for the arithmetic. A
// question passes when its answer matches and the Math Tutor approves it; it then
// goes into the pool. advanceMathJobs moves jobs along every 5 minutes.
//
// Missed questions. mathTwin gives a student a "twin" of a question they missed:
// a question on the same skill they haven't seen, from the pool, or one the Math
// Tutor writes (and checks) right away and adds to the pool. mathFresh gives a
// student moving to a new batch one fresh question for each skill they missed in
// the batch before. Both are saved per student in /mathextra/{uid}.
//
// In the emulator a stand-in for the Math Tutor writes simple questions, so
// everything runs without cost. Set MATH_REAL_CLAUDE=1 to use Claude there.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import {
  MathQuestion, MathCheck, TUTOR_SYSTEM, SKILL_BY_ID, BATCH_SIZE, writePrompt, twinPrompt, checkPrompt,
  toQuestion, checkQuestion, answersMatch, planSlots, fillFromPool, assembleIds,
} from "./math-content.js";
import { anthropicKey } from "./secrets.js";

const MODEL = "claude-opus-5-5";
// Start the next batch when a student has this many questions or fewer left.
export const NEXT_AT = 20;
const MAX_ROUNDS = 7;
const MAX_ATTEMPTS = 4;
const MAX_CHECKS = 3;
// A batch with fewer questions than this isn't published.
const MIN_PUBLISH = 120;
// Questions the Math Tutor writes for one student in a UTC day (twins and fresh ones).
export const DAILY_WRITES = 80;
// Keep in sync with OWNER_EMAILS in index.js.
const OWNER_EMAILS = ["tychung01@gmail.com"];
const CODE_TOOL = { type: "code_execution_20260120", name: "code_execution" };

const emulator = process.env.FUNCTIONS_EMULATOR === "true";
const fakeClaude = emulator && process.env.MATH_REAL_CLAUDE !== "1";

// ---------- access ----------

async function isTeacher(db, auth) {
  const email = auth?.token?.email?.toLowerCase();
  if (!email || auth.token.email_verified !== true) return false;
  if (OWNER_EMAILS.includes(email)) return true;
  return (await db.doc(`teachers/${email}`).get()).exists;
}

async function requireStudent(db, request) {
  const uid = request.auth?.uid;
  const email = request.auth?.token?.email?.toLowerCase();
  if (!uid || !email || request.auth.token.email_verified !== true) throw new HttpsError("unauthenticated", "Sign in to practice.");
  const [visited, blocked, teacher] = await Promise.all([
    db.doc(`mathusers/${uid}`).get(), db.doc(`blocked/${email}`).get(), isTeacher(db, request.auth),
  ]);
  if (!teacher && (!visited.exists || blocked.exists)) throw new HttpsError("permission-denied", "You don't have access to SAT Math.");
  return { uid, teacher };
}

// ---------- the Math Tutor through the Message Batches API ----------

const fmt = (schema) => {
  const f = zodOutputFormat(schema);
  return { format: { type: f.type, schema: f.schema }, parse: f.parse };
};
const FORMATS = { write: fmt(MathQuestion), check: fmt(MathCheck) };

function buildRequest(item, round, useTool) {
  const write = item.state === "write";
  const params = {
    model: MODEL,
    max_tokens: write ? 16000 : 24000,
    system: [{ type: "text", text: TUTOR_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: write ? writePrompt(item, item.problem) : checkPrompt(item.question) }],
    output_config: { effort: write ? "medium" : "high", format: FORMATS[write ? "write" : "check"].format },
  };
  // The check solves the question with code for the arithmetic.
  if (!write && useTool) params.tools = [CODE_TOOL];
  return { custom_id: `${item.id}-${write ? "write" : "check"}-${round}`, kind: write ? "write" : "check", params };
}

function realBatches() {
  const client = new Anthropic({ apiKey: anthropicKey.value() });
  return {
    async create(requests) {
      return (await client.messages.batches.create({ requests: requests.map(({ custom_id, params }) => ({ custom_id, params })) })).id;
    },
    status: async (id) => (await client.messages.batches.retrieve(id)).processing_status,
    async results(id) {
      const out = [];
      for await (const r of await client.messages.batches.results(id)) {
        if (r.result.type === "succeeded") {
          const m = r.result.message;
          // With the code tool there are several text blocks; the answer is the last.
          const texts = m.content.filter((b) => b.type === "text");
          out.push({ id: r.custom_id, ok: true, stop: m.stop_reason, text: texts.at(-1)?.text || "", usage: m.usage });
        } else {
          out.push({ id: r.custom_id, ok: false, error: r.result.type === "errored" ? r.result.error?.error?.message || "error" : r.result.type });
        }
      }
      return out;
    },
  };
}

// ---------- the emulator's stand-in for the Math Tutor ----------

function fakeQuestion(meta, n) {
  const a = 2 + (n % 7);
  const b = a * 3 + (n % 5);
  const answer = b - a;
  const base = {
    stem: `[Test ${meta.skill}] If \\(x + ${a} = ${b}\\), what is the value of \\(x\\)?`,
    solution: `Subtract ${a} from both sides: \\(x = ${b} - ${a} = ${answer}\\).`,
    difficulty: meta.difficulty || "Medium",
    table_title: "", table_columns: [], table_rows: [], figure_kind: "none", figure_title: "",
    x_min: 0, x_max: 0, y_min: 0, y_max: 0, x_label: "", y_label: "", graph_functions: [], points: [],
    fit_line: false, fit_slope: 0, fit_intercept: 0, segments: [], circles: [], not_to_scale: false,
  };
  if (meta.skill === "nonlinear_functions") {
    Object.assign(base, { figure_kind: "graph", figure_title: "", x_min: -5, x_max: 5, y_min: -10, y_max: 10, graph_functions: [{ expr: `x^2 - ${a}`, label: "y = f(x)" }] });
  } else if (meta.skill === "two_var_data") {
    Object.assign(base, { figure_kind: "scatter", x_min: 0, x_max: 10, y_min: 0, y_max: 20, x_label: "Hours", y_label: "Score", points: [1, 3, 5, 7, 9].map((x) => ({ x, y: 2 * x + 1, label: "" })), fit_line: true, fit_slope: 2, fit_intercept: 1 });
  } else if (meta.skill === "lines_angles_triangles") {
    Object.assign(base, { figure_kind: "shape", points: [{ x: 0, y: 0, label: "A" }, { x: 4, y: 0, label: "B" }, { x: 0, y: 3, label: "C" }], segments: [{ from: "A", to: "B", label: "4" }, { from: "B", to: "C", label: "" }, { from: "C", to: "A", label: "3" }], circles: [], not_to_scale: true });
  } else if (meta.skill === "percentages") {
    Object.assign(base, { table_title: "Test data", table_columns: ["Item", "Value"], table_rows: [["a", String(a)], ["b", String(b)]] });
  }
  if (meta.format === "grid") return { ...base, choices: [], answer: -1, grid_answer: String(answer) };
  const choices = [answer, answer + 1, answer - 1, answer + 2].map(String);
  const k = n % 4;
  [choices[0], choices[k]] = [choices[k], choices[0]];
  return { ...base, choices, answer: k, grid_answer: "" };
}

function fakeCheck(q, reject) {
  return {
    answer: q.format === "mc" ? q.answer : -1, grid_answer: q.format === "grid" ? q.gridAnswer : "",
    work: "[Test] Solved by the emulator.", problems: reject ? ["[Test] rejected to exercise a rewrite"] : [],
    verdict: reject ? "reject" : "approve", notes: "[Test] Checked by the emulator.",
  };
}

let fakeCount = 0;
function fakeBatches(db) {
  return {
    async create(requests, items) {
      const results = requests.map((req) => {
        const item = items[req.custom_id.split("-")[0]];
        const text = req.kind === "write"
          ? fakeQuestion(item, ++fakeCount)
          : fakeCheck(item.question, item.id.endsWith("7") && item.attempts === 0);
        return { id: req.custom_id, ok: true, stop: "end_turn", text: JSON.stringify(text), usage: { input_tokens: 1500, output_tokens: 800 } };
      });
      const ref = db.collection("mathfake").doc();
      await ref.set({ results });
      return `fake_${ref.id}`;
    },
    status: async () => "ended",
    results: async (id) => (await db.doc(`mathfake/${id.slice(5)}`).get()).get("results") || [],
  };
}

// ---------- moving a batch along ----------

const jobRef = (db, n) => db.doc(`mathjobs/${n}`);

function log(job, message) {
  console.log(`Math batch ${job.number}: ${message}`);
  return [...(job.log || []), { at: Date.now(), message }].slice(-30);
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

// The item after the Math Tutor wrote it: checked by code, then waiting for its check.
export function afterWrite(item, res) {
  const retry = (problem) => ({ attempts: item.attempts + 1, problem, state: item.attempts + 1 >= MAX_ATTEMPTS ? "failed" : "write" });
  if (!res.ok) return { ...retry(`the request failed (${res.error})`), problem: item.problem };
  if (res.stop === "refusal") return retry("the request was declined; write a different question");
  let d;
  try {
    d = FORMATS.write.parse(res.text);
  } catch {
    return retry(res.stop === "max_tokens" ? "the answer was cut off; keep it shorter" : "the answer didn't match the required format");
  }
  const question = toQuestion(item, d);
  const problem = checkQuestion(question);
  if (problem) return retry(problem);
  return { state: "check", question, problem: "", checks: 0 };
}

// The item after the Math Tutor checked it without the key.
export function afterCheck(item, res) {
  const again = () => ({ checks: (item.checks || 0) + 1, state: (item.checks || 0) + 1 >= MAX_CHECKS ? "failed" : "check" });
  if (!res.ok || res.stop === "pause_turn" || res.stop === "refusal") return again();
  let c;
  try {
    c = FORMATS.check.parse(res.text);
  } catch {
    return again();
  }
  const q = item.question;
  const match = answersMatch(q, c);
  if (c.verdict === "approve" && match) return { state: "approved", notes: c.notes };
  const shown = q.format === "mc" ? `"${q.choices[c.answer] ?? c.answer}"` : `"${c.grid_answer}"`;
  const problem = [
    match ? "" : `solving it without the key gave ${shown}, not the intended answer`,
    ...c.problems,
  ].filter(Boolean).join("; ");
  return { state: item.attempts + 1 >= MAX_ATTEMPTS ? "failed" : "write", attempts: item.attempts + 1, problem: problem || "the check rejected it", question: null };
}

function countStates(items) {
  const counts = {};
  for (const item of Object.values(items)) counts[item.state] = (counts[item.state] || 0) + 1;
  return counts;
}

// A pool question: the question with its id, skill, origin, and what's been done with it.
const poolEntry = (id, question, origin, extra = {}) => ({ id, ...question, origin, inBatch: null, pulled: false, createdAt: Date.now(), ...extra });

async function step(db, ref, job, claude) {
  const snap = await ref.collection("items").get();
  const items = Object.fromEntries(snap.docs.map((d) => [d.id, d.data()]));
  const update = {};
  const changed = new Set();

  // 1. Results of the round in progress.
  if (job.claudeBatch) {
    if ((await claude.status(job.claudeBatch)) !== "ended") return;
    let usage = job.usage || {};
    for (const res of await claude.results(job.claudeBatch)) {
      const id = res.id.split("-")[0];
      const kind = job.kinds?.[res.id];
      if (!items[id] || !kind) continue;
      usage = addUsage(usage, res.usage);
      const changes = kind === "write" ? afterWrite(items[id], res) : afterCheck(items[id], res);
      items[id] = { ...items[id], ...changes };
      // Every approved question goes into the pool right away.
      if (changes.state === "approved") {
        const poolId = `b${job.number}-${id}`;
        const entry = poolEntry(poolId, items[id].question, "batch", { notes: changes.notes || "" });
        await db.doc(`mathpool/${poolId}`).set(entry);
        items[id].poolId = poolId;
        items[id].question = entry;
      }
      changed.add(id);
    }
    Object.assign(update, { claudeBatch: null, kinds: {}, usage });
    update.log = log(job, `round ${job.round} done: ${JSON.stringify(countStates(items))}`);
    job = { ...job, ...update };
  }
  if (changed.size) {
    const writes = db.batch();
    for (const id of changed) writes.set(ref.collection("items").doc(id), items[id]);
    await writes.commit();
  }

  // 2. The next round: questions to write and questions to check go together.
  const round = job.round || 0;
  const list = round < MAX_ROUNDS ? Object.values(items).filter((i) => i.state === "write" || i.state === "check") : [];
  if (list.length) {
    const number = round + 1;
    const makeRequests = (useTool) => list.map((item) => buildRequest(item, number, useTool));
    let requests = makeRequests(!job.noCodeTool);
    let id;
    try {
      id = await claude.create(requests, items);
    } catch (err) {
      // If the code tool can't be used in a batch, check without it.
      if (job.noCodeTool || !/tool|code_execution/i.test(String(err.message))) throw err;
      console.warn("Batch with the code tool was refused; checking without it", err.message);
      update.noCodeTool = true;
      requests = makeRequests(false);
      id = await claude.create(requests, items);
    }
    const writing = list.filter((i) => i.state === "write").length;
    Object.assign(update, {
      claudeBatch: id, round: number, kinds: Object.fromEntries(requests.map((r) => [r.custom_id, r.kind])),
      counts: countStates(items),
      log: log({ ...job, ...update }, `round ${number}: ${writing} to write and ${list.length - writing} to check`),
    });
    await ref.update(update);
    return;
  }

  // 3. Done: put the batch together from the approved questions.
  const ids = assembleIds(Object.values(items));
  const counts = countStates(items);
  if (ids.length < MIN_PUBLISH) {
    await ref.update({ ...update, status: "failed", counts, log: log({ ...job, ...update }, `only ${ids.length} questions passed; not published`) });
    return;
  }
  const byPool = Object.fromEntries(Object.values(items).filter((i) => i.poolId).map((i) => [i.poolId, i.question]));
  const questions = ids.map((id) => ({ ...byPool[id], id }));
  await db.doc(`mathbatches/${job.number}`).set({ number: job.number, questions, pulled: {}, createdAt: FieldValue.serverTimestamp() });
  const writes = db.batch();
  for (const id of ids) writes.update(db.doc(`mathpool/${id}`), { inBatch: job.number });
  await writes.commit();
  const reused = Object.values(items).filter((i) => i.fromPool && ids.includes(i.poolId)).length;
  await ref.update({
    ...update, status: "done", counts, finishedAt: FieldValue.serverTimestamp(),
    log: log({ ...job, ...update }, `published ${questions.length} questions (${reused} from the pool)`),
  });
}

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
    console.error(`Math batch ${number} step failed`, err);
    await ref.update({ lastError: String(err.message || err).slice(0, 500), log: log(job, `error: ${String(err.message || err).slice(0, 200)}`) });
  } finally {
    await ref.update({ busyUntil: 0 });
  }
}

// Unused, unpulled pool questions (no batch has them yet).
async function unusedPool(db) {
  const snap = await db.collection("mathpool").where("inBatch", "==", null).get();
  return snap.docs.map((d) => d.data()).filter((q) => !q.pulled);
}

async function createJob(db, number, startedBy) {
  const ref = jobRef(db, number);
  const slots = fillFromPool(planSlots(), await unusedPool(db)).map((s) => (s.poolId ? { ...s, fromPool: true } : s));
  const created = await db.runTransaction(async (tx) => {
    if ((await tx.get(ref)).exists) return false;
    const fromPool = slots.filter((s) => s.fromPool).length;
    tx.set(ref, {
      number, status: "items", round: 0, claudeBatch: null, kinds: {}, usage: {}, startedBy,
      createdAt: FieldValue.serverTimestamp(), busyUntil: 0, counts: countStates(Object.fromEntries(slots.map((s) => [s.id, s]))),
      log: [{ at: Date.now(), message: `started; ${fromPool} questions from the pool, ${slots.length - fromPool} to write` }],
    });
    return true;
  });
  if (!created) return false;
  const writes = db.batch();
  for (const s of slots) writes.set(ref.collection("items").doc(s.id), { ...s, checks: 0 });
  await writes.commit();
  await ref.update({ status: "active" });
  return true;
}

// ---------- functions: batches ----------

const PIPELINE = { secrets: [anthropicKey], timeoutSeconds: 540, memory: "1GiB" };

export const onMathJobCreated = onDocumentCreated({ document: "mathjobs/{number}", ...PIPELINE }, async (event) => {
  const number = Number(event.params.number);
  for (let i = 0; i < 20; i++) {
    if ((await getFirestore().doc(`mathjobs/${number}`).get()).get("status") === "active") break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  await advanceJob(number);
});

export const advanceMathJobs = onSchedule({ schedule: "every 5 minutes", ...PIPELINE }, async () => {
  const snap = await getFirestore().collection("mathjobs").where("status", "==", "active").get();
  for (const doc of snap.docs) await advanceJob(doc.get("number"));
});

// A student's questions left in a batch: not answered correctly and not cleared by a twin.
export function leftInBatch(batch, answers) {
  const pulled = batch.pulled || {};
  return batch.questions.filter((q) => !pulled[q.id] && !answers[q.id]?.ok && !answers[q.id]?.cleared).length;
}

export const prepareMathBatch = onCall({ timeoutSeconds: 60 }, async (request) => {
  const db = getFirestore();
  const { uid, teacher } = await requireStudent(db, request);
  const latestSnap = await db.collection("mathbatches").orderBy("number", "desc").limit(1).get();
  const latest = latestSnap.empty ? null : latestSnap.docs[0];
  const latestNumber = latest ? latest.get("number") : 0;
  const next = latestNumber + 1;
  const job = await jobRef(db, next).get();
  if (job.exists) {
    if (job.get("status") === "failed" && teacher && request.data?.retry) {
      const items = await job.ref.collection("items").get();
      const writes = db.batch();
      for (const d of items.docs) if (d.get("state") === "failed") writes.update(d.ref, { state: "write", attempts: 0, checks: 0, problem: "", question: null });
      await writes.commit();
      await job.ref.update({ status: "active", round: 0, claudeBatch: null, busyUntil: 0 });
      await advanceJob(next);
    }
    return { latest: latestNumber, next, status: (await job.ref.get()).get("status") };
  }
  let start = !latest;
  if (latest) {
    const answers = (await db.doc(`mathprogress/${uid}`).get()).get("answers") || {};
    start = leftInBatch(latest.data(), answers) <= NEXT_AT;
  }
  if (!start) return { latest: latestNumber, next, status: "not-yet" };
  await createJob(db, next, uid);
  return { latest: latestNumber, next, status: "active" };
});

export const checkMathBatches = onCall({ ...PIPELINE }, async (request) => {
  const db = getFirestore();
  if (!(await isTeacher(db, request.auth))) throw new HttpsError("permission-denied", "Only teachers can do this.");
  const snap = await db.collection("mathjobs").where("status", "==", "active").get();
  for (const doc of snap.docs) await advanceJob(doc.get("number"));
  return { checked: snap.size };
});

// ---------- writing one question right away (twins and fresh questions) ----------

async function ask(schema, content, effort) {
  const client = new Anthropic({ apiKey: anthropicKey.value() });
  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    // Claude Opus 5.5 declines some requests; "default" re-runs a declined one on another model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort, format: zodOutputFormat(schema) },
    system: TUTOR_SYSTEM,
    messages: [{ role: "user", content }],
  });
  if (response.stop_reason === "refusal" || !response.parsed_output) throw new Error(`no answer (${response.stop_reason})`);
  return response.parsed_output;
}

// Writes a question for meta ({ skill, style, format, difficulty }) and checks it.
// `prompt(problem)` is the request. Returns the question with the check's notes.
async function writeChecked(meta, prompt) {
  if (fakeClaude) return { ...toQuestion(meta, fakeQuestion(meta, ++fakeCount)), notes: "[Test] Written by the emulator." };
  let problem = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const d = await ask(MathQuestion, prompt(problem), "medium");
    const question = toQuestion(meta, d);
    problem = checkQuestion(question);
    if (problem) continue;
    const check = await ask(MathCheck, checkPrompt(question), "high");
    if (check.verdict === "approve" && answersMatch(question, check)) return { ...question, notes: check.notes };
    problem = [answersMatch(question, check) ? "" : "solving it without the key gave a different answer", ...check.problems].filter(Boolean).join("; ") || "the check rejected it";
  }
  throw new Error(`no usable question: ${problem}`);
}

const utcDay = (now) => new Date(now).toISOString().slice(0, 10);

// Reserves `count` of today's writes for this student, or throws if there aren't enough.
async function reserveWrites(db, ref, count) {
  if (!count) return;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const today = utcDay(Date.now());
    const used = snap.get("day") === today ? snap.get("today") || 0 : 0;
    if (used + count > DAILY_WRITES) throw new HttpsError("resource-exhausted", "That's enough new questions for today.");
    tx.set(ref, { day: today, today: used + count }, { merge: true });
  });
}

// Pool questions on a skill this student hasn't seen, not in `exclude`.
async function unseenFromPool(db, skill, seen, exclude) {
  const snap = await db.collection("mathpool").where("skill", "==", skill).limit(300).get();
  return snap.docs.map((d) => d.data()).filter((q) => !q.pulled && !seen.has(q.id) && !exclude.has(q.id));
}

const pick = (list) => list[Math.floor(Math.random() * list.length)];

// What a student has seen: everything they answered and every extra question they were given.
function seenBy(progress, extra) {
  return new Set([...Object.keys(progress.get("answers") || {}), ...Object.keys(extra.get("q") || {})]);
}

async function findQuestion(db, qid, uid) {
  const pooled = await db.doc(`mathpool/${qid}`).get();
  if (pooled.exists) return pooled.data();
  const extra = (await db.doc(`mathextra/${uid}`).get()).get("q")?.[qid];
  return extra || null;
}

// A twin for a question the student just missed.
export const mathTwin = onCall({ secrets: [anthropicKey], timeoutSeconds: 300 }, async (request) => {
  const db = getFirestore();
  const { uid } = await requireStudent(db, request);
  const qid = String(request.data?.qid || "");
  const ref = db.doc(`mathextra/${uid}`);
  const [progress, extra] = await Promise.all([db.doc(`mathprogress/${uid}`).get(), ref.get()]);
  const record = progress.get("answers")?.[qid];
  const tries = (record?.tries || []).filter((t) => !t.qz);
  if (!tries.length || record.ok || tries.at(-1).ok) throw new HttpsError("failed-precondition", "A twin question comes after a missed question.");
  // Already given: the same twin.
  const existing = extra.get("twinOf")?.[qid];
  if (existing) return { question: extra.get("q")[existing], root: extra.get("root")?.[existing] };
  const missed = await findQuestion(db, qid, uid);
  if (!missed) throw new HttpsError("not-found", "That question isn't in the app.");
  const root = extra.get("root")?.[qid] || qid;
  const batchNumber = progress.get("batch") || 1;
  const batch = await db.doc(`mathbatches/${batchNumber}`).get();
  const inBatch = new Set((batch.get("questions") || []).map((q) => q.id));

  let twin;
  const unseen = await unseenFromPool(db, missed.skill, seenBy(progress, extra), inBatch);
  const sameFormat = unseen.filter((q) => q.format === missed.format);
  if (unseen.length) {
    twin = pick(sameFormat.length ? sameFormat : unseen);
  } else {
    await reserveWrites(db, ref, 1);
    const meta = { skill: missed.skill, style: missed.style, format: missed.format, difficulty: missed.difficulty };
    let written;
    try {
      written = await writeChecked(meta, (problem) => twinPrompt(missed, problem));
    } catch (err) {
      console.error("Couldn't write a twin", qid, err);
      throw new HttpsError("unavailable", "Couldn't write a new question right now.");
    }
    const id = db.collection("mathpool").doc().id;
    twin = poolEntry(`t-${id}`, written, "twin", { twinOf: qid });
    await db.doc(`mathpool/${twin.id}`).set(twin);
  }
  await ref.set({ q: { [twin.id]: twin }, twinOf: { [qid]: twin.id }, root: { [twin.id]: root } }, { merge: true });
  return { question: twin, root };
});

// One fresh question for each skill the student missed in the batch before this one.
export const mathFresh = onCall({ secrets: [anthropicKey], timeoutSeconds: 540 }, async (request) => {
  const db = getFirestore();
  const { uid } = await requireStudent(db, request);
  const batchNumber = Number(request.data?.batch);
  const ref = db.doc(`mathextra/${uid}`);
  const [progress, extra, batch] = await Promise.all([db.doc(`mathprogress/${uid}`).get(), ref.get(), db.doc(`mathbatches/${batchNumber}`).get()]);
  if (!batch.exists || (progress.get("batch") || 1) !== batchNumber || batchNumber < 2) {
    throw new HttpsError("failed-precondition", "Fresh questions come when you start a new batch.");
  }
  const given = extra.get("freshFor")?.[batchNumber];
  if (given) return { ids: given };
  // Skills missed (a wrong answer outside a quiz) while working on the batch before.
  const skills = [...new Set(Object.values(progress.get("answers") || {})
    .filter((a) => a.b === batchNumber - 1 && (a.tries || []).some((t) => !t.ok && !t.qz)).map((a) => a.sk).filter((s) => SKILL_BY_ID[s]))];
  const seen = seenBy(progress, extra);
  const inBatch = new Set(batch.get("questions").map((q) => q.id));
  const chosen = [];
  const toWrite = [];
  for (const skill of skills) {
    const unseen = await unseenFromPool(db, skill, seen, inBatch);
    const q = unseen.length ? pick(unseen) : null;
    if (q) {
      chosen.push(q);
      seen.add(q.id);
    } else toWrite.push(skill);
  }
  if (toWrite.length) {
    await reserveWrites(db, ref, toWrite.length);
    const written = await Promise.all(toWrite.map(async (skill) => {
      const s = SKILL_BY_ID[skill];
      const meta = { skill, style: s.act ? "ACT" : "SAT", format: "mc", difficulty: "Medium" };
      try {
        const q = await writeChecked(meta, (problem) => writePrompt(meta, problem));
        const entry = poolEntry(`f-${db.collection("mathpool").doc().id}`, q, "fresh");
        await db.doc(`mathpool/${entry.id}`).set(entry);
        return entry;
      } catch (err) {
        console.error("Couldn't write a fresh question", skill, err);
        return null;
      }
    }));
    chosen.push(...written.filter(Boolean));
  }
  const ids = chosen.map((q) => q.id);
  await ref.set({ q: Object.fromEntries(chosen.map((q) => [q.id, { ...q, fresh: batchNumber }])), freshFor: { [batchNumber]: ids } }, { merge: true });
  return { ids };
});

export { BATCH_SIZE };
