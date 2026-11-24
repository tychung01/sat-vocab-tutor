// Tests for SAT Reading's question checks, review handling, and batch assembly.
// Run from functions/:  node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planItems, checkShortDraft, checkSetDraft, applyShortReview, applySetReview, finishSet, assembleBatch, useReserve,
  overlap, numbers, quoteFound, BLANK, SET_TYPES, BATCH_SIZE, SHORT_PER_BATCH, SETS_PER_BATCH,
} from "../reading-content.js";
import { bookParagraphs, excerpt, cleanPlos } from "../reading-sources.js";
import { afterWrite, afterReview, checkNewChoices, costDollars } from "../reading.js";

const SOURCE = "Coral reefs cover less than one percent of the ocean floor, yet they support about 25 percent of marine species. "
  + "When water temperatures rise by 1.5 degrees, corals expel the algae that feed them and turn white, a process called bleaching. "
  + "Some reefs recover within a decade, but repeated bleaching leaves little time for recovery. "
  + "Researchers at several sites found that reefs with more fish grazing on seaweed recovered faster than reefs with fewer fish. "
  + "They argue that protecting grazing fish may help reefs survive warmer seas, although others doubt that local protection can offset global warming.";
const source = { key: "plos:x", origin: "plos", title: "Reefs", author: "A", year: "2024", url: "https://doi.org/x", license: "CC BY 4.0", publisher: "PLOS ONE", text: SOURCE };
const passage = "Coral reefs cover less than one percent of the ocean floor, yet they support about 25 percent of marine species. When water temperatures rise by 1.5 degrees, corals expel the algae that feed them and turn white, a process called bleaching. Some reefs recover within a decade, but repeated bleaching leaves little time for recovery.";
const choices = ["Reefs are fragile but can recover.", "Reefs cover most of the ocean.", "Algae harm corals.", "Fish cause bleaching."];
const draft = (extra = {}) => ({
  fits: true, why_not: "", title: "Reefs", intro: "", passage, passage2: "", notes: [], table_title: "", table_columns: [], table_rows: [],
  question: "Which choice best states the main idea of the text?", choices, answer: 0, difficulty: "Medium", ...extra,
});
const item = (extra = {}) => ({ id: "s001", kind: "short", type: "central_idea", subject: "Science", difficulty: "Medium", state: "review", attempts: 0, reviews: 0, source, draft: draft(), ...extra });

test("a batch plan has enough SAT-style questions and ACT-style sets", () => {
  const items = planItems();
  assert.ok(items.filter((i) => i.kind === "short").length >= SHORT_PER_BATCH);
  assert.ok(items.filter((i) => i.kind === "set").length >= SETS_PER_BATCH);
  assert.equal(SHORT_PER_BATCH + SETS_PER_BATCH * 9, BATCH_SIZE);
  // Data questions only come from science and social science.
  for (const i of items.filter((x) => x.type === "evidence_table")) assert.ok(["Science", "Social science"].includes(i.subject));
});

test("checks: a good main idea question passes", () => {
  assert.equal(checkShortDraft(item(), draft()), null);
});

test("checks: choices", () => {
  assert.match(checkShortDraft(item(), draft({ choices: choices.slice(0, 3) })), /exactly 4/);
  assert.match(checkShortDraft(item(), draft({ choices: [...choices.slice(0, 3), choices[0]] })), /same/);
  assert.match(checkShortDraft(item(), draft({ answer: 4 })), /0-3/);
  assert.match(checkShortDraft(item(), draft({ choices: ["A) one", "B) two", "C) three", "D) four"] })), /letter/);
});

test("checks: the passage must be an excerpt of the right length", () => {
  assert.match(checkShortDraft(item(), draft({ passage: "Reefs are nice. ".repeat(4) })), /25-150/);
  const invented = "Scientists have long wondered why some ocean animals glow in the dark, and new work suggests the light helps them find mates in the deep sea, where little sunlight reaches and colors are hard to see at all.";
  assert.match(checkShortDraft(item(), draft({ passage: invented })), /excerpt/);
});

test("checks: inference passages end with the blank", () => {
  const it = item({ type: "inference" });
  assert.match(checkShortDraft(it, draft()), /end with/);
  assert.equal(checkShortDraft(it, draft({ passage: `${passage} This suggests that ${BLANK}.` })), null);
});

test("checks: tables only use numbers from the source", () => {
  const it = item({ type: "evidence_table" });
  const good = draft({ table_title: "Reefs", table_columns: ["Measure", "Value"], table_rows: [["Warming (degrees)", "1.5"], ["Species (%)", "25"]] });
  assert.equal(checkShortDraft(it, good), null);
  assert.match(checkShortDraft(it, { ...good, table_rows: [["Warming (degrees)", "1.5"], ["Species (%)", "40"]] }), /isn't in the source/);
  // Saved rows ({ cells }) check the same way.
  assert.equal(checkShortDraft(it, { ...good, table_rows: good.table_rows.map((cells) => ({ cells })) }), null);
});

test("checks: underlined sentences", () => {
  const it = item({ type: "structure_purpose" });
  const underlined = passage.replace("Some reefs recover within a decade, but repeated bleaching leaves little time for recovery.", "{{Some reefs recover within a decade, but repeated bleaching leaves little time for recovery.}}");
  assert.equal(checkShortDraft(it, draft({ passage: underlined, question: "Which choice best describes the function of the underlined sentence in the text as a whole?" })), null);
  assert.match(checkShortDraft(it, draft({ question: "What does the underlined sentence do?" })), /none is marked/);
  assert.match(checkShortDraft(item(), draft({ passage: underlined })), /only structure/);
});

test("checks: rhetorical synthesis notes", () => {
  const it = item({ type: "rhetorical_synthesis" });
  const notes = ["Coral reefs cover less than one percent of the ocean floor.", "They support about 25 percent of marine species.", "Warming of 1.5 degrees can cause bleaching.", "Reefs with more grazing fish recovered faster."];
  assert.equal(checkShortDraft(it, draft({ passage: "", notes })), null);
  assert.match(checkShortDraft(it, draft({ passage: "", notes: notes.slice(0, 3) })), /4-6 notes/);
});

test("helpers", () => {
  assert.ok(overlap(passage, SOURCE) > 0.95);
  assert.deepEqual(numbers("1,250 people and 3.5% in 2024"), ["1250", "3.5", "2024"]);
  assert.ok(quoteFound("“corals expel the algae that feed them”", passage));
  assert.ok(quoteFound("Coral reefs cover ... marine species", passage));
  assert.ok(!quoteFound("corals eat the algae", passage));
});

const review = (extra = {}) => ({ answer: 0, proof_quote: "Some reefs recover within a decade", problems: [], verdict: "approve", revised_question: "", revised_choices: [], revised_answer: -1, explanation: "Because.", notes: "Good.", ...extra });

test("review: approve with the same answer", () => {
  const out = applyShortReview(item(), review());
  assert.equal(out.state, "approved");
  assert.equal(out.evidence, "Some reefs recover within a decade");
});

test("review: approve with a different answer sends it back to the writer", () => {
  const out = applyShortReview(item(), review({ answer: 2 }));
  assert.equal(out.state, "write");
  assert.match(out.problem, /Algae harm corals/);
});

test("review: revise and reject", () => {
  const fixed = ["Reefs can bounce back unless bleaching repeats.", "Reefs cover most of the ocean.", "Algae harm corals.", "Fish cause bleaching."];
  const revised = applyShortReview(item(), review({ verdict: "revise", revised_choices: fixed, revised_answer: 0 }));
  assert.equal(revised.state, "review");
  assert.deepEqual(revised.draft.choices, fixed);
  const bad = applyShortReview(item(), review({ verdict: "revise", revised_choices: fixed.slice(0, 2), revised_answer: 0 }));
  assert.equal(bad.state, "write");
  assert.equal(applyShortReview(item(), review({ verdict: "reject", problems: ["unclear"] })).state, "source");
});

// ---------- sets ----------

const longText = Array.from({ length: 7 }, (_, p) => Array.from({ length: 5 }, (_, s) => `Paragraph ${p + 1} sentence ${s + 1} tells about the old farm and the long winter that the family spent there together.`).join(" ")).join("\n\n");
const setSource = { ...source, key: "gutenberg:1:1", origin: "gutenberg", text: longText };
const setQuestions = () => SET_TYPES.map((type, i) => ({ type, question: `Question ${i + 1}?`, choices: [`a${i}`, `b${i}`, `c${i}`, `d${i}`], answer: i % 4, difficulty: "Medium" }));
const setDraft = () => ({ fits: true, why_not: "", title: "Farm", intro: "LITERARY NARRATIVE: This passage is adapted from a novel.", paragraphs: longText.split("\n\n"), questions: setQuestions() });
const setItem = (extra = {}) => ({ id: "a1", kind: "set", subject: "Literature", types: SET_TYPES, state: "review", attempts: 0, reviews: 0, source: setSource, draft: setDraft(), qstate: SET_TYPES.map(() => "review"), explanations: [], evidence: [], ...extra });

test("checks: a set", () => {
  assert.equal(checkSetDraft(setItem(), setDraft()), null);
  assert.match(checkSetDraft(setItem(), { ...setDraft(), questions: setQuestions().slice(0, 8) }), /9 questions/);
  assert.match(checkSetDraft(setItem(), { ...setDraft(), intro: "This passage is adapted from a novel." }), /passage kind/);
});

test("review: a set with one rejected and one revised question", () => {
  const questions = setQuestions().map((q, i) => ({ number: i + 1, answer: q.answer, proof_quote: "the old farm", problems: [], verdict: "approve", revised_question: "", revised_choices: [], revised_answer: -1, explanation: `E${i}` }));
  questions[1] = { ...questions[1], verdict: "reject", problems: ["two answers work"] };
  questions[2] = { ...questions[2], verdict: "revise", revised_choices: ["w", "x", "y", "z"], revised_answer: 1 };
  const out = applySetReview(setItem(), { passage_ok: true, passage_problems: [], questions, notes: "ok" });
  assert.equal(out.state, "write");
  assert.deepEqual(out.replace, [1]);
  assert.equal(out.qstate[0], "approved");
  assert.equal(out.qstate[2], "review");
  assert.deepEqual(out.draft.questions[2].choices, ["w", "x", "y", "z"]);
  // Out of review rounds, a set keeps its approved questions if there are enough.
  const finished = finishSet({ ...setItem(), ...out, qstate: out.qstate.map((s, i) => (i < 7 ? "approved" : "review")) });
  assert.equal(finished.state, "approved");
  assert.equal(finished.draft.questions.length, 7);
});

test("assembling a batch of 150", () => {
  const shorts = Array.from({ length: 105 }, (_, k) => ({ ...item({ id: `s${k}`, state: "approved" }), explanation: "E", evidence: "" }));
  const sets = Array.from({ length: 7 }, (_, k) => ({ ...setItem({ id: `a${k}`, state: "approved" }), explanations: SET_TYPES.map(() => "E"), evidence: [] }));
  const { batch, leftover } = assembleBatch(3, [...shorts, ...sets]);
  // 9 short questions and 1 set weren't needed; they're kept for the next batch.
  assert.equal(leftover.length, 10);
  assert.equal(batch.questions.length, 150);
  assert.equal(Object.keys(batch.sets).length, 6);
  assert.equal(batch.questions.filter((q) => q.style === "ACT").length, 54);
  assert.equal(batch.questions[0].id, "b3-001");
  // A set's questions stay together and in order.
  const firstSet = Object.keys(batch.sets)[0];
  const positions = batch.questions.map((q, i) => (q.set === firstSet ? i : -1)).filter((i) => i >= 0);
  assert.equal(positions.at(-1) - positions[0], 8);
  // Missing short questions are made up with the extra set.
  const { batch: fewer } = assembleBatch(4, [...shorts.slice(0, 80), ...sets]);
  assert.equal(Object.keys(fewer.sets).length, 7);
  assert.equal(fewer.questions.length, 80 + 63);
});

test("pipeline: a writer's answer that passes goes to review", () => {
  const it = item({ state: "write", draft: null });
  const out = afterWrite(it, "short", { ok: true, stop: "end_turn", text: JSON.stringify(draft()) });
  assert.equal(out.state, "review");
  const bad = afterWrite(it, "short", { ok: true, stop: "end_turn", text: JSON.stringify(draft({ answer: 7 })) });
  assert.equal(bad.state, "write");
  assert.equal(afterWrite(it, "short", { ok: true, stop: "end_turn", text: JSON.stringify(draft({ fits: false, why_not: "no" })) }).state, "source");
  assert.equal(afterWrite(it, "short", { ok: true, stop: "end_turn", text: "not json" }).state, "write");
  assert.equal(afterWrite({ ...it, attempts: 3 }, "short", { ok: true, stop: "end_turn", text: "not json" }).state, "failed");
  // Table rows are saved as { cells }.
  const table = afterWrite(item({ type: "evidence_table" }), "short", { ok: true, stop: "end_turn", text: JSON.stringify(draft({ table_title: "T", table_columns: ["A", "B"], table_rows: [["x", "1.5"], ["y", "25"]] })) });
  assert.deepEqual(table.draft.table_rows, [{ cells: ["x", "1.5"] }, { cells: ["y", "25"] }]);
});

test("pipeline: a review", () => {
  assert.equal(afterReview(item(), "shortReview", { ok: true, stop: "end_turn", text: JSON.stringify(review()) }).state, "approved");
  assert.equal(afterReview({ ...item(), reviews: 2 }, "shortReview", { ok: false, error: "x" }).state, "failed");
});

test("new choices for a missed question", () => {
  const q = { choices, correct: 0 };
  assert.equal(checkNewChoices(q, { correct_choice: "Reefs can recover if given time.", wrong_choices: ["One", "Two", "Three"], explanation: "E" }), null);
  assert.match(checkNewChoices(q, { correct_choice: "X", wrong_choices: ["Algae harm corals.", "Two", "Three"], explanation: "E" }), /old choices/);
  assert.match(checkNewChoices(q, { correct_choice: "X", wrong_choices: ["Two", "Two", "Three"], explanation: "E" }), /same/);
});

test("sources: Gutenberg text and PLOS clean-up", () => {
  const raw = "Header\n*** START OF THE PROJECT GUTENBERG EBOOK 1 ***\nCHAPTER I\n\n" + Array.from({ length: 60 }, (_, i) => `This is paragraph ${i} of the novel, and it goes on for a while with\nseveral wrapped lines of _ordinary_ prose.`).join("\n\n") + "\n*** END OF THE PROJECT GUTENBERG EBOOK 1 ***\nLicense";
  const paragraphs = bookParagraphs(raw);
  assert.equal(paragraphs.length, 61);
  assert.ok(!paragraphs.join(" ").includes("License"));
  assert.ok(paragraphs[1].includes("ordinary prose"));
  const found = excerpt(paragraphs, 40, 120);
  assert.ok(found && found.text.split(/\s+/).length >= 40);
  assert.equal(cleanPlos("Data remain scarce [1,2].Previous work [3–5] found (Fig 2) more."), "Data remain scarce.\n\nPrevious work found more.");
  assert.equal(cleanPlos("seen in acorn ants, [12]. Models exist [e. g. 17],."), "seen in acorn ants. Models exist.");
  assert.ok(costDollars({ input: 1e6, output: 1e6 }) === 12);
});

test("a new batch starts with questions kept from earlier ones", () => {
  const planned = planItems();
  const kept = [
    { ...item({ id: "s050", type: "inference", state: "approved" }), explanation: "E", reserveId: "b1-s050" },
    { ...setItem({ id: "a7", state: "approved" }), reserveId: "b1-a7" },
  ];
  const { items, usedReserve } = useReserve(planned, kept);
  assert.deepEqual(usedReserve, ["b1-s050", "b1-a7"]);
  const used = items.filter((i) => i.fromReserve);
  assert.equal(used.length, 2);
  assert.equal(used.find((i) => i.kind === "short").type, "inference");
  assert.ok(used.every((i) => i.state === "approved"));
  // Their ids are the plan's, so they don't collide.
  assert.equal(new Set(items.map((i) => i.id)).size, items.length);
  assert.equal(items.length, planned.length);
});

test("checks: a quotation question's passage is a claim, and its choices are quotations", () => {
  const it = item({ type: "evidence_text" });
  const claim = "In the study, the researchers suggest that local protection of grazing fish could help coral reefs recover from repeated bleaching events in the warming seas of today.";
  const quotes = ["\u201CSome reefs recover within a decade\u201D", "\u201Ccorals expel the algae that feed them\u201D", "\u201Creefs with more fish grazing on seaweed recovered faster\u201D", "\u201Cthey support about 25 percent of marine species\u201D"];
  const q = { passage: claim, question: "Which quotation from the study most effectively illustrates the claim?", choices: quotes };
  assert.equal(checkShortDraft(it, draft(q)), null);
  assert.match(checkShortDraft(it, draft({ ...q, choices: [...quotes.slice(0, 3), "\u201Cfish eat coral\u201D"] })), /word for word/);
});
