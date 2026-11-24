// Tests for SAT Math's question checks, batch planning, and the Math Tutor's results.
// Run from functions/:  node --test test/math.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SKILLS, BATCH_SIZE, planSlots, fillFromPool, assembleIds, toQuestion, checkQuestion, answersMatch,
} from "../math-content.js";
import { afterWrite, afterCheck, leftInBatch } from "../math.js";

const blank = {
  stem: "If \\(3x + 5 = 20\\), what is the value of \\(x\\)?", solution: "Subtract 5, then divide by 3: \\(x = 5\\).", difficulty: "Easy",
  choices: ["5", "15", "25/3", "3"], answer: 0, grid_answer: "",
  table_title: "", table_columns: [], table_rows: [], figure_kind: "none", figure_title: "",
  x_min: 0, x_max: 0, y_min: 0, y_max: 0, x_label: "", y_label: "", graph_functions: [], points: [],
  fit_line: false, fit_slope: 0, fit_intercept: 0, segments: [], circles: [], not_to_scale: false,
};
const mc = { skill: "linear_eq_one", style: "SAT", format: "mc", difficulty: "Easy" };
const grid = { ...mc, format: "grid" };

test("a batch plan has 150 questions over every skill, plus spares", () => {
  const slots = planSlots();
  assert.equal(SKILLS.reduce((n, s) => n + s.n, 0), BATCH_SIZE);
  assert.equal(slots.filter((s) => !s.spare).length, BATCH_SIZE);
  for (const s of SKILLS) assert.equal(slots.filter((x) => x.skill === s.id && !x.spare).length, s.n);
  assert.ok(slots.filter((s) => s.format === "grid").every((s) => s.style === "SAT"));
  assert.equal(new Set(slots.map((s) => s.id)).size, slots.length);
});

test("checks: a good multiple-choice and fill-in question", () => {
  assert.equal(checkQuestion(toQuestion(mc, blank)), null);
  const g = toQuestion(grid, { ...blank, choices: [], answer: -1, grid_answer: "5" });
  assert.equal(checkQuestion(g), null);
  assert.equal(g.gridAnswer, "5");
});

test("checks: choices, fill-in answers, and math", () => {
  assert.match(checkQuestion(toQuestion(mc, { ...blank, choices: ["5", "5", "3", "1"] })), /same/);
  assert.match(checkQuestion(toQuestion(mc, { ...blank, answer: 4 })), /0-3/);
  assert.match(checkQuestion(toQuestion(grid, { ...blank, choices: [], grid_answer: "123456" })), /5 characters/);
  assert.match(checkQuestion(toQuestion(grid, { ...blank, choices: [], grid_answer: "x = 5" })), /number/);
  assert.match(checkQuestion(toQuestion(mc, { ...blank, stem: "If \\(3x + 5 = 20, what is x?" })), /closed/);
});

test("checks: figures", () => {
  const graph = { ...blank, figure_kind: "graph", x_min: -5, x_max: 5, y_min: -10, y_max: 10, graph_functions: [{ expr: "x^2 - 4", label: "f" }] };
  assert.equal(checkQuestion(toQuestion(mc, graph)), null);
  assert.match(checkQuestion(toQuestion(mc, { ...graph, graph_functions: [{ expr: "x^^2", label: "" }] })), /graph expression/);
  assert.match(checkQuestion(toQuestion(mc, { ...graph, x_max: -6 })), /axis/);
  const shape = { ...blank, figure_kind: "shape", points: [{ x: 0, y: 0, label: "A" }, { x: 4, y: 0, label: "B" }], segments: [{ from: "A", to: "C", label: "" }] };
  assert.match(checkQuestion(toQuestion(mc, shape)), /vertex/);
  const table = toQuestion(mc, { ...blank, table_title: "T", table_columns: ["a", "b"], table_rows: [["1", "2"]] });
  assert.deepEqual(table.table.rows, [{ cells: ["1", "2"] }]);
});

test("the Math Tutor's cold answer must match", () => {
  const q = toQuestion(mc, blank);
  assert.ok(answersMatch(q, { answer: 0, grid_answer: "" }));
  assert.ok(!answersMatch(q, { answer: 2, grid_answer: "" }));
  const g = toQuestion(grid, { ...blank, choices: [], answer: -1, grid_answer: "2/3" });
  assert.ok(answersMatch(g, { answer: -1, grid_answer: ".6666" }));
  assert.ok(answersMatch(g, { answer: -1, grid_answer: "4/6" }));
  assert.ok(!answersMatch(g, { answer: -1, grid_answer: "0.6" }));
});

test("pipeline: write, then check", () => {
  const item = { id: "q001", ...mc, state: "write", attempts: 0, problem: "" };
  const written = afterWrite(item, { ok: true, stop: "end_turn", text: JSON.stringify(blank) });
  assert.equal(written.state, "check");
  const bad = afterWrite(item, { ok: true, stop: "end_turn", text: JSON.stringify({ ...blank, answer: 9 }) });
  assert.equal(bad.state, "write");
  const checking = { ...item, ...written };
  const check = (extra) => ({ answer: 0, grid_answer: "", work: "", problems: [], verdict: "approve", notes: "Fine.", ...extra });
  assert.equal(afterCheck(checking, { ok: true, stop: "end_turn", text: JSON.stringify(check()) }).state, "approved");
  const wrong = afterCheck(checking, { ok: true, stop: "end_turn", text: JSON.stringify(check({ answer: 1 })) });
  assert.equal(wrong.state, "write");
  assert.match(wrong.problem, /without the key gave "15"/);
  assert.equal(afterCheck(checking, { ok: true, stop: "pause_turn", text: "" }).state, "check");
  assert.equal(afterCheck({ ...checking, checks: 2 }, { ok: false, error: "x" }).state, "failed");
});

test("a batch starts from unused pool questions, then spares fill gaps", () => {
  const slots = planSlots();
  const pool = [
    { id: "t-1", skill: "linear_systems", style: "SAT", format: "mc", difficulty: "Hard" },
    { id: "t-2", skill: "matrices", style: "ACT", format: "mc", difficulty: "Easy" },
  ];
  const filled = fillFromPool(slots, pool);
  assert.equal(filled.filter((s) => s.poolId).length, 2);
  assert.equal(filled.find((s) => s.poolId === "t-1").skill, "linear_systems");
  // Every main slot approved: 150 questions, no spares.
  const all = filled.map((s, i) => ({ ...s, state: "approved", poolId: s.poolId || `p${i}` }));
  assert.equal(assembleIds(all).length, BATCH_SIZE);
  assert.ok(!assembleIds(all).some((id) => all.find((s) => s.poolId === id).spare));
  // Two main slots failed: spares take their place.
  const failed = all.map((s, i) => (i < 2 ? { ...s, state: "failed" } : s));
  const ids = assembleIds(failed);
  assert.equal(ids.length, BATCH_SIZE);
  assert.equal(ids.filter((id) => failed.find((s) => s.poolId === id).spare).length, 2);
});

test("questions left in a batch", () => {
  const batch = { questions: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }], pulled: { d: {} } };
  assert.equal(leftInBatch(batch, { a: { ok: true }, b: { ok: false, cleared: true } }), 1);
});
