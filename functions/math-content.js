// SAT Math: the skills a batch covers, the Math Tutor's prompts, the shapes it
// answers in, and the checks every question passes before students see it. Plain
// logic with no network or database, so it can be tested on its own
// (test/math.test.mjs). See math.js for how batches and twin questions are written.

import { z } from "zod";
import { compile, parseNumber, gridMatches, fitsGrid } from "./math-expr.js";

export const BATCH_SIZE = 150;
// Questions written beyond the 150, in case some don't pass the check.
export const EXTRA = 15;

// The digital SAT's Math domains and skills (College Board's published test
// specifications), with how many of the 150 each gets, plus ACT topics the SAT
// doesn't test. SAT questions are about a quarter fill-in (no choices).
export const SKILLS = [
  // Algebra (36)
  { id: "linear_eq_one", area: "Algebra", label: "Linear equations in one variable", n: 8 },
  { id: "linear_functions", area: "Algebra", label: "Linear functions", n: 8 },
  { id: "linear_eq_two", area: "Algebra", label: "Linear equations in two variables", n: 6 },
  { id: "linear_systems", area: "Algebra", label: "Systems of two linear equations", n: 8 },
  { id: "linear_inequalities", area: "Algebra", label: "Linear inequalities", n: 6 },
  // Advanced Math (36)
  { id: "equivalent_expressions", area: "Advanced Math", label: "Equivalent expressions", n: 10 },
  { id: "nonlinear_equations", area: "Advanced Math", label: "Nonlinear equations and systems", n: 12 },
  { id: "nonlinear_functions", area: "Advanced Math", label: "Nonlinear functions", n: 14 },
  // Problem-Solving and Data Analysis (24)
  { id: "ratios_rates", area: "Problem-Solving and Data Analysis", label: "Ratios, rates, proportions, and units", n: 4 },
  { id: "percentages", area: "Problem-Solving and Data Analysis", label: "Percentages", n: 4 },
  { id: "one_var_data", area: "Problem-Solving and Data Analysis", label: "One-variable data", n: 4 },
  { id: "two_var_data", area: "Problem-Solving and Data Analysis", label: "Two-variable data and scatterplots", n: 4 },
  { id: "probability", area: "Problem-Solving and Data Analysis", label: "Probability and conditional probability", n: 4 },
  { id: "sample_inference", area: "Problem-Solving and Data Analysis", label: "Inference from samples and margin of error", n: 2 },
  { id: "statistical_claims", area: "Problem-Solving and Data Analysis", label: "Evaluating statistical claims", n: 2 },
  // Geometry and Trigonometry (24)
  { id: "area_volume", area: "Geometry and Trigonometry", label: "Area and volume", n: 6 },
  { id: "lines_angles_triangles", area: "Geometry and Trigonometry", label: "Lines, angles, and triangles", n: 6 },
  { id: "right_triangles_trig", area: "Geometry and Trigonometry", label: "Right triangles and trigonometry", n: 6 },
  { id: "circles", area: "Geometry and Trigonometry", label: "Circles", n: 6 },
  // ACT topics beyond the SAT (30)
  { id: "matrices", area: "ACT topics", label: "Matrices", n: 3, act: true },
  { id: "complex_numbers", area: "ACT topics", label: "Complex numbers", n: 4, act: true },
  { id: "logarithms", area: "ACT topics", label: "Logarithms", n: 4, act: true },
  { id: "sequences", area: "ACT topics", label: "Arithmetic and geometric sequences", n: 4, act: true },
  { id: "counting", area: "ACT topics", label: "Counting, permutations, and combinations", n: 4, act: true },
  { id: "conics", area: "ACT topics", label: "Conic sections", n: 3, act: true },
  { id: "unit_circle", area: "ACT topics", label: "Unit circle and trigonometric functions", n: 4, act: true },
  { id: "vectors", area: "ACT topics", label: "Vectors", n: 2, act: true },
  { id: "function_composition", area: "ACT topics", label: "Composite and inverse functions", n: 2, act: true },
];
export const SKILL_BY_ID = Object.fromEntries(SKILLS.map((s) => [s.id, s]));
export const AREAS = [...new Set(SKILLS.map((s) => s.area))];
export const DIFFICULTIES = ["Easy", "Medium", "Hard"];

// ---------- what the Math Tutor answers with ----------

const point = z.object({ x: z.number(), y: z.number(), label: z.string().describe('A label, or ""') });

export const MathQuestion = z.object({
  stem: z.string().describe("The question, with math in \\( \\) for inline and \\[ \\] for display LaTeX"),
  choices: z.array(z.string()).describe("Exactly 4 choices for multiple choice, without letters; empty for fill-in"),
  answer: z.number().int().describe("Index (0-3) of the right choice; -1 for fill-in"),
  grid_answer: z.string().describe('For fill-in: the answer as a number a student would enter, like "3/4", "-2.5", or "12"; "" for multiple choice'),
  solution: z.string().describe("A worked solution for students, 2-6 short steps, with math in \\( \\)"),
  difficulty: z.enum(["Easy", "Medium", "Hard"]),
  table_title: z.string().describe('A table\'s title, or ""'),
  table_columns: z.array(z.string()),
  table_rows: z.array(z.array(z.string())),
  figure_kind: z.enum(["none", "graph", "scatter", "shape"]),
  figure_title: z.string(),
  x_min: z.number(), x_max: z.number(), y_min: z.number(), y_max: z.number(),
  x_label: z.string(), y_label: z.string(),
  graph_functions: z.array(z.object({ expr: z.string().describe('In x, like "2*x^2 - 3*x + 1"'), label: z.string() })),
  points: z.array(point).describe("Points to mark on a graph, the data of a scatterplot, or a shape's vertices (label = the vertex name)"),
  fit_line: z.boolean().describe("Scatterplot: draw a line of best fit"),
  fit_slope: z.number(), fit_intercept: z.number(),
  segments: z.array(z.object({ from: z.string(), to: z.string(), label: z.string() })).describe("Shape: sides between named vertices, with a length label or \"\""),
  circles: z.array(z.object({ center: z.string(), radius: z.number(), label: z.string() })).describe("Shape: circles centered at a named vertex"),
  not_to_scale: z.boolean(),
});

export const MathCheck = z.object({
  answer: z.number().int().describe("Your own answer: the index (0-3) of the right choice, or -1 for fill-in"),
  grid_answer: z.string().describe('Your own answer for fill-in, as a number; "" for multiple choice'),
  work: z.string().describe("Your solution, briefly"),
  problems: z.array(z.string()).describe("Problems with the question; empty if none"),
  verdict: z.enum(["approve", "reject"]),
  notes: z.string().describe("One or two sentences for teachers on the question's quality"),
});

// ---------- prompts ----------

export const TUTOR_SYSTEM = `You are the Math Tutor: an experienced SAT and ACT math teacher who writes original practice questions for a study app for high school students, and checks them.

When you write a question:
- It tests exactly the skill asked for, at the difficulty asked for, in the style of the real tests (College Board's digital SAT Math and the ACT math test): clear, concise, realistic contexts, no tricks.
- It is original. Don't copy or closely paraphrase real test questions.
- Exactly one answer is correct. For multiple choice, the 3 wrong choices come from real mistakes (a sign error, a skipped step, solving for the wrong quantity), are the same kind of thing as the answer, and aren't obviously wrong.
- Fill-in questions have a single numerical answer a student can type: up to 5 characters (6 with a minus sign), as a fraction like 3/4 or a decimal. Don't ask for units in the answer.
- Write math in LaTeX inside \\( \\) (inline) or \\[ \\] (display). Write money as "$12" in plain text, never inside math.
- Use a table, graph, scatterplot, or shape only when the question needs it, and make it match the text exactly. Graph expressions are in x with * for multiplication and ^ for powers (for example "2*x^2 - 3*x + 1"). Shapes are given by named vertices with coordinates; mark "not to scale" if the picture isn't exact. Leave figure fields you don't use empty, 0, or false.
- The solution is a short worked explanation a student can follow: 2-6 steps, ending with the answer.

When you check a question, you are not told the answer. Solve it yourself from scratch, using code to check any arithmetic, then report your answer and any problems: more than one defensible answer, no correct choice, a figure or table that doesn't match the text, a question off its skill or difficulty, unclear wording, or anything unfair. Approve only a question that is correct, clear, and test-like.`;

export function writePrompt(item, problem = "") {
  const skill = SKILL_BY_ID[item.skill];
  return [
    `Write one ${item.style === "ACT" ? "ACT" : "SAT"}-style math question.`,
    `Area: ${skill.area}. Skill: ${skill.label}.`,
    `Difficulty: ${item.difficulty}.`,
    item.format === "grid" ? "Format: fill-in (student-produced response): no choices; give grid_answer." : "Format: multiple choice with 4 choices.",
    problem ? `An earlier attempt was rejected: ${problem}. Fix that.` : "",
  ].filter(Boolean).join("\n");
}

// A new question on the same skill as one a student missed.
export function twinPrompt(q, problem = "") {
  return [
    `A student missed this question. Write a new question that tests the same idea, at the same difficulty and in the same format, with different numbers and a different context, so the student has to work it out again.`,
    `Skill: ${SKILL_BY_ID[q.skill]?.label || q.skill}. Style: ${q.style}. Difficulty: ${q.difficulty}. Format: ${q.format === "grid" ? "fill-in" : "multiple choice with 4 choices"}.`,
    `The question they missed:\n${studentView(q)}`,
    problem ? `An earlier attempt was rejected: ${problem}. Fix that.` : "",
  ].filter(Boolean).join("\n\n");
}

export const checkPrompt = (q) => `Check this ${q.style}-style math question (skill: ${SKILL_BY_ID[q.skill]?.label || q.skill}, difficulty: ${q.difficulty}). Solve it yourself first.\n\n${studentView(q)}`;

// A question as a student sees it, as text.
export function studentView(q) {
  const parts = [q.stem];
  if (q.table) parts.push(`Table: ${q.table.title}\n${q.table.columns.join(" | ")}\n${q.table.rows.map((r) => rowCells(r).join(" | ")).join("\n")}`);
  if (q.figure) parts.push(`Figure (${q.figure.kind}): ${JSON.stringify(q.figure)}`);
  if (q.format === "mc") parts.push(q.choices.map((c, i) => `${"ABCD"[i]}) ${c}`).join("\n"));
  else parts.push("(Fill-in: the student types a number.)");
  return parts.join("\n\n");
}

// ---------- turning the Math Tutor's answer into a question ----------

export const rowCells = (row) => (Array.isArray(row) ? row : row?.cells || []);

// The figure as the app draws it, or null.
function figureOf(d) {
  if (d.figure_kind === "none") return null;
  const base = { kind: d.figure_kind, title: d.figure_title || "", notToScale: Boolean(d.not_to_scale) };
  if (d.figure_kind === "shape") {
    return { ...base, points: d.points, segments: d.segments, circles: d.circles };
  }
  return {
    ...base, xMin: d.x_min, xMax: d.x_max, yMin: d.y_min, yMax: d.y_max, xLabel: d.x_label, yLabel: d.y_label,
    functions: d.figure_kind === "graph" ? d.graph_functions : [], points: d.points,
    fit: d.figure_kind === "scatter" && d.fit_line ? { slope: d.fit_slope, intercept: d.fit_intercept } : null,
  };
}

// The question in the shape the app and the pool use (Firestore can't hold
// arrays of arrays, so table rows are { cells }).
export function toQuestion(item, d) {
  return {
    skill: item.skill, area: SKILL_BY_ID[item.skill].area, style: item.style, format: item.format,
    difficulty: d.difficulty, stem: d.stem.trim(),
    choices: item.format === "mc" ? d.choices.map((c) => String(c).trim()) : [],
    answer: item.format === "mc" ? d.answer : -1,
    gridAnswer: item.format === "grid" ? String(d.grid_answer).trim() : "",
    solution: d.solution.trim(),
    table: d.table_columns.length ? { title: d.table_title, columns: d.table_columns, rows: d.table_rows.map((r) => ({ cells: rowCells(r) })) } : null,
    figure: figureOf(d),
  };
}

// ---------- checks ----------

// \( \) and \[ \] must pair up, and "$" must not be used as a math delimiter.
function mathProblem(text) {
  const s = String(text);
  const count = (re) => (s.match(re) || []).length;
  if (count(/\\\(/g) !== count(/\\\)/g) || count(/\\\[/g) !== count(/\\\]/g)) return "a \\( \\) or \\[ \\] isn't closed";
  if (/\$[^$\s][^$]*\$/.test(s) && /\$[^$]*\\[a-z]+/i.test(s)) return 'use \\( \\) for math, not "$"';
  return null;
}

// Returns null if a question is usable, or what's wrong with it.
export function checkQuestion(q) {
  if (!q.stem || q.stem.length < 10) return "the question is missing";
  for (const text of [q.stem, q.solution, ...q.choices]) {
    const problem = mathProblem(text);
    if (problem) return problem;
  }
  if (!q.solution) return "the solution is missing";
  if (q.format === "mc") {
    if (q.choices.length !== 4) return "there must be exactly 4 choices";
    if (q.choices.some((c) => !c)) return "a choice is empty";
    if (new Set(q.choices.map((c) => c.replace(/\s+/g, "").toLowerCase())).size !== 4) return "two choices are the same";
    if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer > 3) return "the answer must be 0-3";
    if (q.choices.some((c) => /^\(?[A-DFGHJ][).:]\s/.test(c))) return "choices must not start with a letter";
  } else {
    if (q.choices.length) return "a fill-in question has no choices";
    if (!fitsGrid(q.gridAnswer)) return `the fill-in answer "${q.gridAnswer}" must be a number of up to 5 characters (6 with a minus sign)`;
  }
  if (q.table) {
    const cols = q.table.columns.length;
    if (cols < 1 || q.table.rows.length < 1 || q.table.rows.some((r) => rowCells(r).length !== cols)) return "each table row needs one cell per column";
  }
  const f = q.figure;
  if (f && f.kind !== "shape") {
    if (!(f.xMax > f.xMin && f.yMax > f.yMin)) return "the graph's axis ranges are wrong";
    if (f.kind === "graph" && !f.functions.length && !f.points.length) return "the graph has nothing to draw";
    for (const fn of f.functions || []) {
      try {
        const g = compile(fn.expr);
        const samples = Array.from({ length: 21 }, (_, i) => g(f.xMin + ((f.xMax - f.xMin) * i) / 20));
        if (!samples.some(Number.isFinite)) return `the graph of "${fn.expr}" has no points in range`;
      } catch (err) {
        return `graph expression: ${err.message}`;
      }
    }
    if (f.kind === "scatter" && f.points.length < 3) return "a scatterplot needs at least 3 points";
  }
  if (f && f.kind === "shape") {
    const names = new Set(f.points.map((p) => p.label));
    if (f.points.length < 2) return "a shape needs at least 2 named points";
    if ([...f.segments.flatMap((s) => [s.from, s.to]), ...f.circles.map((c) => c.center)].some((n) => !names.has(n))) return "a shape refers to a vertex that isn't in points";
  }
  return null;
}

// Whether the Math Tutor's cold answer matches the key.
export function answersMatch(q, check) {
  if (q.format === "mc") return check.answer === q.answer;
  return gridMatches(check.grid_answer, q.gridAnswer) || Math.abs(parseNumber(check.grid_answer) - parseNumber(q.gridAnswer)) < 1e-9;
}

// ---------- planning and assembling a batch ----------

// The 150 slots of a batch (plus EXTRA spares): skill, style, format, difficulty.
export function planSlots() {
  const slots = [];
  for (const skill of SKILLS) {
    for (let k = 0; k < skill.n; k++) {
      const style = skill.act ? "ACT" : "SAT";
      // About a quarter of SAT questions are fill-in.
      const format = style === "SAT" && k % 4 === 3 ? "grid" : "mc";
      slots.push({ skill: skill.id, style, format, difficulty: DIFFICULTIES[k % 3] });
    }
  }
  // Spares spread over the skills with the most questions.
  const big = [...SKILLS].sort((a, b) => b.n - a.n);
  for (let k = 0; k < EXTRA; k++) {
    const skill = big[k % big.length];
    slots.push({ skill: skill.id, style: skill.act ? "ACT" : "SAT", format: "mc", difficulty: DIFFICULTIES[(k + 1) % 3], spare: true });
  }
  return slots.map((s, i) => ({ ...s, id: `q${String(i + 1).padStart(3, "0")}` }));
}

// Fills slots with unused pool questions of the same skill (same format and
// difficulty when possible). Returns the slots, some now { poolId, state: "approved", question }.
export function fillFromPool(slots, pool) {
  const left = [...pool];
  return slots.map((slot) => {
    const score = (q) => (q.format === slot.format ? 2 : 0) + (q.difficulty === slot.difficulty ? 1 : 0);
    const matches = left.filter((q) => q.skill === slot.skill && (q.style === slot.style || !slot.style)).sort((a, b) => score(b) - score(a));
    const pick = matches[0];
    if (!pick) return { ...slot, state: "write", attempts: 0, problem: "" };
    left.splice(left.indexOf(pick), 1);
    return { ...slot, format: pick.format, state: "approved", poolId: pick.id, question: pick, attempts: 0, problem: "" };
  });
}

// The batch: up to BATCH_SIZE approved questions, spares only where a slot of
// the same skill failed, in a random order. Returns the question ids in order.
export function assembleIds(items, random = Math.random) {
  const approved = items.filter((i) => i.state === "approved" && i.poolId);
  const main = approved.filter((i) => !i.spare);
  const missing = {};
  for (const i of items.filter((x) => !x.spare && x.state !== "approved")) missing[i.skill] = (missing[i.skill] || 0) + 1;
  const spares = approved.filter((i) => i.spare);
  const used = [...main];
  // Spares fill in first for their own skill, then for any.
  for (const s of spares) if (missing[s.skill] > 0 && used.length < BATCH_SIZE) { used.push(s); missing[s.skill]--; }
  for (const s of spares) if (!used.includes(s) && used.length < BATCH_SIZE) used.push(s);
  const ids = used.slice(0, BATCH_SIZE).map((i) => i.poolId);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids;
}
