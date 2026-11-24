// SAT Reading: question types, the prompts for the question writer and the
// Reviewer, the shapes Claude answers in, and the checks every question passes
// before students see it. Everything here is plain logic with no network or
// database, so it can be tested on its own (test/reading.test.mjs).
//
// A batch is 150 questions: SAT-style questions, each on its own short passage,
// and ACT-style sets of 9 questions on one long passage. See reading.js for how
// a batch is written and reviewed.

import { z } from "zod";

export const BLANK = "______";
export const BATCH_SIZE = 150;
export const SET_SIZE = 9;
// Questions in each batch: 6 ACT-style sets of 9 (54) and 96 SAT-style questions.
export const SETS_PER_BATCH = 6;
export const SHORT_PER_BATCH = BATCH_SIZE - SETS_PER_BATCH * SET_SIZE;
// Extra items written in case some don't pass review.
export const EXTRA_SHORT = 9;
export const EXTRA_SETS = 1;

export const SUBJECTS = ["Science", "Social science", "History", "Literature", "Humanities"];

// The digital SAT's Reading and Writing question types (the transition questions
// have their own app). `subjects` are the subjects whose passages suit the type.
export const SAT_TYPES = [
  {
    id: "central_idea", label: "Main idea", subjects: SUBJECTS,
    how: 'Ask for the main idea: "Which choice best states the main idea of the text?" Wrong choices: a detail mistaken for the main idea, a claim broader or narrower than the text, or one that misreads the author\'s view.',
  },
  {
    id: "detail", label: "Detail", subjects: SUBJECTS,
    how: 'Ask about something the text states directly, for example "According to the text, why did ...?" or "Based on the text, what is true about ...?" Wrong choices: details that are in the text but don\'t answer the question, or that distort what it says.',
  },
  {
    id: "inference", label: "Inference", subjects: SUBJECTS,
    how: `End the passage with ${BLANK} where its final claim should be (the passage's last sentence ends with the blank and a period), and ask "Which choice most logically completes the text?" The answer is the conclusion the passage's reasoning supports; wrong choices go too far, reverse the logic, or don't follow from the evidence.`,
  },
  {
    id: "evidence_text", label: "Command of evidence", subjects: SUBJECTS,
    how: 'State a claim in the passage (or about a literary work) and ask which choice best supports it. For literature or historical documents: "Which quotation from [the work] most effectively illustrates the claim?", with four quotations taken word for word from the source text (only one illustrates the claim). For science or social science: "Which finding, if true, would most directly support the [researchers\'] hypothesis?" (or weaken), with four hypothetical findings.',
  },
  {
    id: "evidence_table", label: "Evidence from data", subjects: ["Science", "Social science"],
    how: "Make a small table (2-5 columns, 2-6 rows) using only numbers that appear in the source text, and a short passage making a claim about them. Ask \"Which choice most effectively uses data from the table to complete the text/support the claim?\" (the passage may end with the blank). Wrong choices: true data that doesn't support the claim, or misreadings of the table. Every number in the table must appear in the source text.",
  },
  {
    id: "words_in_context", label: "Words in context", subjects: SUBJECTS,
    how: `Either replace one precise word or short phrase of the passage with ${BLANK} and ask "Which choice completes the text with the most logical and precise word or phrase?", or ask "As used in the text, what does the word \\"X\\" most nearly mean?" for a word X in the passage, quoted exactly. The answer must be the only choice that fits the context; wrong choices are real meanings or words that don't fit here.`,
  },
  {
    id: "structure_purpose", label: "Text structure and purpose", subjects: SUBJECTS,
    how: 'Ask "Which choice best states the main purpose of the text?", "Which choice best describes the overall structure of the text?", or, by putting one sentence between {{ and }} so it shows underlined, "Which choice best describes the function of the underlined sentence in the text as a whole?"',
  },
  {
    id: "cross_text", label: "Cross-text connections", subjects: ["Science", "Social science", "History", "Humanities"],
    how: 'Use two short texts (passage = Text 1, passage2 = Text 2) that take different positions on one topic, both drawn from the source (which must discuss two views). Ask, for example, "Based on the texts, how would the author of Text 2 most likely respond to the [claim] in Text 1?" Each text is 25-150 words.',
  },
  {
    id: "rhetorical_synthesis", label: "Rhetorical synthesis", subjects: ["Science", "Social science", "History", "Humanities"],
    how: 'Leave passage empty and write 4-6 notes (bullet facts from the source, each one sentence) a student took while researching the topic. Ask "The student wants to [goal, e.g. emphasize a difference / introduce the study to an audience unfamiliar with it]. Which choice most effectively uses relevant information from the notes to accomplish this goal?" Each choice is one sentence that only uses facts from the notes; only one does what the goal asks.',
  },
];
export const TYPE_BY_ID = Object.fromEntries(SAT_TYPES.map((t) => [t.id, t]));

// The ACT reading test's passage kinds and the question types in each set.
export const ACT_KINDS = {
  Literature: "LITERARY NARRATIVE",
  "Social science": "SOCIAL SCIENCE",
  History: "SOCIAL SCIENCE",
  Humanities: "HUMANITIES",
  Science: "NATURAL SCIENCE",
};
export const SET_TYPES = ["central_idea", "detail", "detail", "detail", "inference", "inference", "words_in_context", "words_in_context", "structure_purpose"];
export const ACT_TYPE_HOW = {
  central_idea: 'The main idea or purpose of the whole passage: "The main purpose of the passage is to:" or "Which of the following best states the main idea of the passage?"',
  detail: 'A fact the passage states, pointed to by paragraph: "According to the passage, ..." or "The passage states that ..."',
  inference: 'What the passage implies: "It can most reasonably be inferred from the passage that ..." or "Based on the passage, the narrator most likely ..."',
  words_in_context: 'A word or phrase in a numbered paragraph: "As it is used in paragraph 3, the word \\"X\\" most nearly means:" (X quoted exactly as it appears in that paragraph).',
  structure_purpose: 'The function of a paragraph or detail: "The main function of the fourth paragraph is to:" or "The author mentions X most likely in order to:"',
};

export const DIFFICULTIES = ["Easy", "Medium", "Hard"];

// ---------- text helpers ----------

export const wordCount = (text) => String(text || "").split(/\s+/).filter(Boolean).length;

// Lowercase words without punctuation, for comparing a passage with its source.
export function tokens(text) {
  return String(text || "").toLowerCase()
    .replace(/[‘’‛]/g, "'").replace(/[“”]/g, '"')
    .replace(/_{3,}/g, " ").replace(/[{}]/g, " ")
    .split(/[^a-z0-9']+/).map((w) => w.replace(/^'+|'+$/g, "")).filter(Boolean);
}

function trigrams(words) {
  const out = [];
  for (let i = 0; i + 2 < words.length; i++) out.push(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return out;
}

// The share of the passage's 3-word runs that appear in the source: near 1 for
// an excerpt, low for text Claude wrote itself.
export function overlap(passage, source) {
  const p = trigrams(tokens(passage));
  if (!p.length) return 0;
  const s = new Set(trigrams(tokens(source)));
  return p.filter((t) => s.has(t)).length / p.length;
}

// Numbers in a text, without thousands separators: "1,250 people, 3.5%" -> ["1250", "3.5"].
export function numbers(text) {
  return (String(text || "").match(/\d+(?:[.,]\d+)*/g) || []).map((n) => n.replace(/,(?=\d{3}\b)/g, ""));
}

// Text as compared for quotes: straight quotes, single spaces, lowercase.
export function normalize(text) {
  return String(text || "").toLowerCase()
    .replace(/[‘’‛]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-").replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
}

// Whether a quote (possibly with "..." between parts) appears in the text.
export function quoteFound(quote, text) {
  const hay = normalize(text);
  const parts = normalize(quote).replace(/^["']+|["']+$/g, "").split(/\s*(?:\.\.\.|…)\s*/).map((p) => p.replace(/^["']+|["']+$/g, "").trim()).filter(Boolean);
  return parts.length > 0 && parts.every((p) => hay.includes(p));
}

const distinct = (list) => new Set(list.map(normalize)).size === list.length;

// Firestore can't hold arrays of arrays, so saved table rows are { cells: [...] }.
export const rowCells = (row) => (Array.isArray(row) ? row : row?.cells || []);
export function storeDraft(draft) {
  return draft.table_rows ? { ...draft, table_rows: draft.table_rows.map((r) => ({ cells: rowCells(r) })) } : draft;
}

// ---------- what Claude answers with ----------

const choicesField = z.array(z.string()).describe("Exactly 4 answer choices, without letters");
const answerField = z.number().int().describe("Index (0-3) of the correct choice");
const difficultyField = z.enum(["Easy", "Medium", "Hard"]);

export const ShortDraft = z.object({
  fits: z.boolean().describe("False if this source can't support a good question of the requested type"),
  why_not: z.string().describe('Why the source doesn\'t fit, or ""'),
  title: z.string().describe("A 2-6 word topic label, like \"Coral reef recovery\""),
  intro: z.string().describe('One sentence introducing the text, like "The following text is adapted from Willa Cather\'s 1913 novel O Pioneers!", or ""'),
  passage: z.string().describe("The passage (Text 1 for cross-text questions); empty for rhetorical synthesis"),
  passage2: z.string().describe('Text 2 for cross-text questions, otherwise ""'),
  notes: z.array(z.string()).describe("The student's notes for rhetorical synthesis, otherwise empty"),
  table_title: z.string().describe('The table\'s title for evidence-from-data questions, otherwise ""'),
  table_columns: z.array(z.string()).describe("Column headings, otherwise empty"),
  table_rows: z.array(z.array(z.string())).describe("Table rows, each with one cell per column, otherwise empty"),
  question: z.string(),
  choices: choicesField,
  answer: answerField,
  difficulty: difficultyField,
});

const SetQuestion = z.object({
  type: z.enum(["central_idea", "detail", "inference", "words_in_context", "structure_purpose"]),
  question: z.string(),
  choices: choicesField,
  answer: answerField,
  difficulty: difficultyField,
});

export const SetDraft = z.object({
  fits: z.boolean().describe("False if this source can't make a good 500-800 word passage with 9 questions"),
  why_not: z.string(),
  title: z.string().describe("A 2-6 word topic label"),
  intro: z.string().describe('The ACT-style heading line, like "LITERARY NARRATIVE: This passage is adapted from the novel My Antonia by Willa Cather (1918)."'),
  paragraphs: z.array(z.string()).describe("The passage's paragraphs, in order, without numbers"),
  questions: z.array(SetQuestion).describe("Exactly 9 questions, of the requested types in order"),
});

export const SetReplacement = z.object({
  questions: z.array(SetQuestion).describe("The new questions, one for each slot asked for, in that order"),
});

const reviewFields = {
  answer: z.number().int().describe("Your own answer (0-3), worked out from the passage before anything else"),
  proof_quote: z.string().describe("The exact words from the passage (or notes or table) that prove the right answer"),
  problems: z.array(z.string()).describe("Problems you found; empty if none"),
  verdict: z.enum(["approve", "revise", "reject"]),
  revised_question: z.string().describe('For "revise": the fixed question; otherwise ""'),
  revised_choices: z.array(z.string()).describe('For "revise": the fixed 4 choices; otherwise empty'),
  revised_answer: z.number().int().describe('For "revise": the index of the right fixed choice; otherwise -1'),
  explanation: z.string().describe("For students: why the right answer is right and why each other choice is wrong, 2-4 sentences"),
};

export const ShortReview = z.object({
  ...reviewFields,
  notes: z.string().describe("One or two sentences for teachers on the question's quality"),
});

export const SetReview = z.object({
  passage_ok: z.boolean().describe("False if the passage itself is unsuitable (unclear, unfair, too hard, or broken)"),
  passage_problems: z.array(z.string()),
  questions: z.array(z.object({ number: z.number().int().describe("The question's number as given"), ...reviewFields })),
  notes: z.string().describe("One or two sentences for teachers on the set's quality"),
});

export const NewChoices = z.object({
  correct_choice: z.string().describe("The right answer, reworded so it reads differently but means the same"),
  wrong_choices: z.array(z.string()).describe("3 new wrong choices"),
  explanation: z.string().describe("For the student: why the right answer is right and why each new wrong choice is wrong, 2-4 sentences"),
});

export const ColdAnswer = z.object({
  answer: z.number().int().describe("Index (0-3) of the choice the passage supports"),
  reasoning: z.string().describe("One or two sentences"),
});

// ---------- prompts ----------

export const WRITER_SYSTEM = `You write original reading comprehension questions for an SAT and ACT study app for high school students.

You get a source text from an openly licensed or public-domain work (a PLOS research article, or a book or document from Project Gutenberg) and the kind of question to write. You turn part of the source into a passage and write a question about it in the style of the real tests.

The passage:
- Is an excerpt of the source, "adapted" the way the SAT and ACT adapt passages: you may cut sentences, shorten, and lightly smooth for flow and reading level, remove citations like [12] and figure references, and fix spacing. Keep the source's own wording; don't write new content or add facts, and don't change what the source says. For literature and historical documents, keep the author's words exactly (cutting is fine).
- Stands on its own: a reader with no background can understand it.
- Is something a strong high school junior can read: explain or avoid technical terms, the way the SAT's science passages do.
- SAT-style passages are 25-150 words. ACT-style passages are 500-800 words in 5-9 paragraphs.

The question and choices:
- Exactly one choice is correct, and the passage alone proves it. A careful reader can point to the words that prove it.
- The three wrong choices are tempting but clearly wrong for a reason a teacher could explain: they distort the passage, go beyond it, mix up details, reverse a relationship, or are true but don't answer the question. No trick questions and no choices that are only wrong on a technicality.
- Choices are about the same length and style, and none gives itself away by wording.
- The correct answer's position is up to you; vary it.
- Use the tests' own phrasing for questions. Don't name the SAT or the ACT.

If the source can't support a good question of the kind asked for (for example, a cross-text question needs two views, an evidence-from-data question needs numbers), say so with fits: false instead of forcing it.`;

export const REVIEWER_SYSTEM = `You are the Reviewer: a professor of English who has spent years writing and grading reading questions for standardized tests like the SAT and ACT. You review questions for a study app before high school students see them, and you hold them to the standard of the real tests.

For each question, first answer it yourself from the passage alone, as a careful student would, and give the exact words that prove your answer. You won't be told the intended answer. Then check that:
- exactly one choice can be defended, and the passage proves it;
- each wrong choice is tempting but clearly wrong, for a reason you can explain;
- the passage stands on its own, makes sense, is accurate to its source as far as you can tell, and suits a strong high school junior;
- the question reads like a real SAT or ACT question, in wording and difficulty;
- the question is fair: no outside knowledge needed, no cultural bias, nothing offensive.

Your verdict:
- "approve" if the question is ready as it is.
- "revise" if you can fix it by rewording the question or choices; give the full fixed question and choices and the index of the right one.
- "reject" if it can't be fixed without a new passage.

Write the explanation for a student: why the right answer is right, pointing to the passage, and why each wrong choice is wrong. Keep it to 2-4 plain sentences.`;

function sourceBlock(source) {
  const by = [source.author, source.year].filter(Boolean).join(", ");
  return `Source: ${source.title}${by ? ` (${by})` : ""}, ${source.publisher}, ${source.license}\n\n<source>\n${source.text}\n</source>`;
}

const subjectLine = (subject) => `Subject: ${subject}`;

export function shortWriterPrompt(item, problem = "") {
  const type = TYPE_BY_ID[item.type];
  return [
    `Write one SAT-style question.`,
    `Question type: ${type.label}. ${type.how}`,
    subjectLine(item.subject),
    `Target difficulty: ${item.difficulty}.`,
    `Fields you don't need for this type: leave strings empty and arrays empty.`,
    sourceBlock(item.source),
    problem ? `An earlier attempt was rejected: ${problem}. Fix that.` : "",
  ].filter(Boolean).join("\n\n");
}

export function setWriterPrompt(item, problem = "") {
  return [
    `Write one ACT-style reading set: a passage of 500-800 words in 5-9 paragraphs and 9 questions about it.`,
    `Passage kind: ${ACT_KINDS[item.subject]}. Start intro with "${ACT_KINDS[item.subject]}: This passage is adapted from ..." naming the work, its author, and its year.`,
    `Questions, in this order: ${item.types.map((t, i) => `${i + 1}. ${TYPE_BY_ID[t].label}`).join("; ")}.`,
    `How each type is asked:\n${Object.entries(ACT_TYPE_HOW).map(([t, how]) => `- ${TYPE_BY_ID[t].label} (${t}): ${how}`).join("\n")}`,
    `Questions refer to paragraphs by number (paragraph 1 is the first). Spread the questions across the passage, mostly in passage order after the first.`,
    `Target difficulty: a mix of Easy, Medium, and Hard, mostly Medium.`,
    sourceBlock(item.source),
    problem ? `An earlier attempt was rejected: ${problem}. Fix that.` : "",
  ].filter(Boolean).join("\n\n");
}

const numbered = (paragraphs) => paragraphs.map((p, i) => `[${i + 1}] ${p}`).join("\n\n");

function questionBlock(q, letters = "ABCD") {
  return `${q.question}\n${q.choices.map((c, i) => `${letters[i]}) ${c}`).join("\n")}`;
}

export function setReplacementPrompt(item) {
  const draft = item.draft;
  const keep = draft.questions.map((q, i) => (item.replace.includes(i) ? null : `${i + 1}. ${q.question}`)).filter(Boolean);
  return [
    `This ACT-style set needs new questions in some slots; the passage stays as it is.`,
    `${draft.intro}\n\n${numbered(draft.paragraphs)}`,
    keep.length ? `Questions it already has (don't repeat what they ask):\n${keep.join("\n")}` : "",
    `Write one new question for each of these slots, in this order: ${item.replace.map((i) => `question ${i + 1} (${TYPE_BY_ID[draft.questions[i].type].label}, type ${draft.questions[i].type})`).join("; ")}.`,
    `How each type is asked:\n${Object.entries(ACT_TYPE_HOW).map(([t, how]) => `- ${TYPE_BY_ID[t].label} (${t}): ${how}`).join("\n")}`,
    item.problem ? `What the Reviewer said about the questions being replaced: ${item.problem}` : "",
  ].filter(Boolean).join("\n\n");
}

// The item as a student would see it, without the intended answer.
function shortStudentView(draft) {
  const parts = [];
  if (draft.intro) parts.push(draft.intro);
  if (draft.passage2) parts.push(`Text 1\n${draft.passage}\n\nText 2\n${draft.passage2}`);
  else if (draft.passage) parts.push(draft.passage.replace(/\{\{/g, "<u>").replace(/\}\}/g, "</u>"));
  if (draft.notes?.length) parts.push(`While researching a topic, a student has taken the following notes:\n${draft.notes.map((n) => `- ${n}`).join("\n")}`);
  if (draft.table_columns?.length) {
    parts.push(`Table: ${draft.table_title}\n${draft.table_columns.join(" | ")}\n${draft.table_rows.map((r) => rowCells(r).join(" | ")).join("\n")}`);
  }
  parts.push(questionBlock(draft));
  return parts.join("\n\n");
}

export function shortReviewPrompt(item) {
  return [
    `Review this SAT-style ${TYPE_BY_ID[item.type].label} question (subject: ${item.subject}).`,
    shortStudentView(item.draft),
    `Its source, for checking accuracy:\n${sourceBlock(item.source)}`,
  ].join("\n\n");
}

export function setReviewPrompt(item) {
  const draft = item.draft;
  const pending = draft.questions.map((q, i) => ({ q, i })).filter(({ i }) => item.qstate[i] !== "approved");
  return [
    `Review this ACT-style reading set (${ACT_KINDS[item.subject]}). Paragraphs are numbered in brackets.`,
    `${draft.intro}\n\n${numbered(draft.paragraphs)}`,
    `Questions to review (give "number" as shown):\n\n${pending.map(({ q, i }) => `Question ${i + 1}. ${questionBlock(q)}`).join("\n\n")}`,
    `Its source, for checking accuracy:\n${sourceBlock(item.source)}`,
  ].join("\n\n");
}

// For rewriting a missed question's choices (reading.js, rewriteReadingChoices).
export function newChoicesPrompt(question, set, picked) {
  return [
    `A student missed this question. Write new answer choices for it so that when it comes back the student has to reason it through again, not remember the old choices. Keep the passage and what the question asks exactly the same.`,
    studentView(question, set),
    `The right answer: ${question.choices[question.correct]}`,
    `The student picked: ${picked}`,
    `Write the right answer reworded (same meaning, different words) and 3 new wrong choices. Make one of them tempting in the same way as the choice the student picked, so they practice spotting that mistake. The wrong choices must be clearly wrong for a reason you can explain, and no choice may be a copy of an old one.`,
  ].join("\n\n");
}

export function coldAnswerPrompt(question, set, choices) {
  return [
    `Answer this question from the passage alone.`,
    studentView({ ...question, choices }, set),
  ].join("\n\n");
}

// A question from a finished batch as a student sees it.
export function studentView(q, set) {
  const parts = [];
  if (set) parts.push(`${set.intro}\n\n${numbered(set.paragraphs)}`);
  else {
    if (q.intro) parts.push(q.intro);
    if (q.passage2) parts.push(`Text 1\n${q.passage}\n\nText 2\n${q.passage2}`);
    else if (q.passage) parts.push(q.passage.replace(/\{\{/g, "<u>").replace(/\}\}/g, "</u>"));
    if (q.notes?.length) parts.push(`Notes:\n${q.notes.map((n) => `- ${n}`).join("\n")}`);
    if (q.table) parts.push(`Table: ${q.table.title}\n${q.table.columns.join(" | ")}\n${q.table.rows.map((r) => rowCells(r).join(" | ")).join("\n")}`);
  }
  parts.push(questionBlock(q));
  return parts.join("\n\n");
}

// ---------- checks ----------

// Fidelity to the source: excerpts from books keep the author's words; adapted
// science passages may smooth more.
const MIN_OVERLAP = { gutenberg: 0.75, plos: 0.45 };

function checkChoices(choices, answer) {
  if (!Array.isArray(choices) || choices.length !== 4) return "there must be exactly 4 choices";
  if (choices.some((c) => !String(c).trim())) return "a choice is empty";
  if (choices.some((c) => String(c).length > 400)) return "a choice is too long";
  if (!distinct(choices)) return "two choices are the same";
  if (!Number.isInteger(answer) || answer < 0 || answer > 3) return "the answer must be 0-3";
  if (choices.some((c) => /^\(?[A-DFGHJ][).:]\s/.test(String(c).trim()))) return "choices must not start with a letter";
  return null;
}

// Returns null if a short (SAT-style) draft is usable, or what's wrong with it.
export function checkShortDraft(item, d) {
  const minOverlap = MIN_OVERLAP[item.source.origin] ?? 0.6;
  const choiceProblem = checkChoices(d.choices, d.answer);
  if (choiceProblem) return choiceProblem;
  if (!String(d.question).trim()) return "the question is missing";
  const blanks = `${d.passage} ${d.passage2}`.split(BLANK).length - 1;
  const underlined = /\{\{[^{}]+\}\}/.test(d.passage);
  if ((d.passage.match(/\{\{/g) || []).length !== (d.passage.match(/\}\}/g) || []).length) return "the underline marks {{ }} don't match";
  if (underlined && item.type !== "structure_purpose") return "only structure and purpose questions can underline a sentence";
  if (/underlined/i.test(d.question) && !underlined) return "the question mentions an underlined sentence, but none is marked with {{ }}";

  if (item.type === "rhetorical_synthesis") {
    if (d.notes.length < 4 || d.notes.length > 7) return "rhetorical synthesis needs 4-6 notes";
    const sourceNumbers = new Set(numbers(item.source.text));
    if (numbers(d.notes.join(" ")).some((n) => !sourceNumbers.has(n))) return "a number in the notes isn't in the source";
    if (wordCount(d.notes.join(" ")) > 180) return "the notes are too long";
    return null;
  }
  const words = wordCount(d.passage);
  if (words < 25 || words > 150) return `the passage is ${words} words; it must be 25-150`;
  if (overlap(d.passage, item.source.text) < minOverlap) return "the passage must be an excerpt of the source, keeping its wording";
  if (item.type === "cross_text") {
    const words2 = wordCount(d.passage2);
    if (words2 < 25 || words2 > 150) return `Text 2 is ${words2} words; it must be 25-150`;
    if (overlap(d.passage2, item.source.text) < minOverlap) return "Text 2 must be an excerpt of the source, keeping its wording";
  } else if (d.passage2) return "only cross-text questions have a Text 2";
  if (item.type === "inference" && (blanks !== 1 || !d.passage.trim().replace(/[.\s"'”’]+$/, "").endsWith(BLANK))) {
    return `an inference question's passage must end with ${BLANK}`;
  }
  if (item.type === "words_in_context") {
    const quoted = d.question.match(/["“]([^"”]+)["”]/);
    if (blanks !== 1 && !(quoted && normalize(d.passage).includes(normalize(quoted[1])))) {
      return "a words-in-context question needs one blank, or must quote a word that is in the passage";
    }
  } else if (item.type === "evidence_table") {
    if (blanks > 1) return "too many blanks";
  } else if (item.type !== "inference" && blanks) return "only inference, words-in-context, and data questions have a blank";
  if (item.type === "evidence_table") {
    const cols = d.table_columns.length;
    if (cols < 2 || cols > 5 || d.table_rows.length < 2 || d.table_rows.length > 8) return "the table needs 2-5 columns and 2-8 rows";
    if (d.table_rows.some((r) => rowCells(r).length !== cols)) return "each table row needs one cell per column";
    const sourceNumbers = new Set(numbers(item.source.text));
    if (numbers(d.table_rows.map(rowCells).flat().join(" ")).some((n) => !sourceNumbers.has(n))) return "a number in the table isn't in the source";
  } else if (d.table_columns.length || d.table_rows.length) return "only data questions have a table";
  if (item.type === "evidence_text" && /quotation/i.test(d.question)) {
    const missing = d.choices.filter((c) => !quoteFound(c, item.source.text));
    if (missing.length) return "each quotation choice must be quoted word for word from the source";
  }
  return null;
}

export function checkSetQuestions(questions, types) {
  if (questions.length !== types.length) return `there must be ${types.length} questions`;
  for (const [i, q] of questions.entries()) {
    if (q.type !== types[i]) return `question ${i + 1} must be ${TYPE_BY_ID[types[i]].label}`;
    if (!String(q.question).trim()) return `question ${i + 1} is missing its question`;
    const choiceProblem = checkChoices(q.choices, q.answer);
    if (choiceProblem) return `question ${i + 1}: ${choiceProblem}`;
  }
  return null;
}

export function checkSetDraft(item, d) {
  if (d.paragraphs.length < 4 || d.paragraphs.length > 10) return "the passage needs 5-9 paragraphs";
  const text = d.paragraphs.join("\n\n");
  const words = wordCount(text);
  if (words < 480 || words > 850) return `the passage is ${words} words; it must be 500-800`;
  if (overlap(text, item.source.text) < (MIN_OVERLAP[item.source.origin] ?? 0.6)) return "the passage must be an excerpt of the source, keeping its wording";
  if (!/^[A-Z ]+:/.test(d.intro.trim())) return "the intro must start with the passage kind, like LITERARY NARRATIVE:";
  return checkSetQuestions(d.questions, item.types);
}

// The text a question's proof quote must come from.
export function shortText(d) {
  return [d.passage, d.passage2, ...(d.notes || []), d.table_title, ...(d.table_columns || []), ...(d.table_rows || []).map(rowCells).flat()].join("\n");
}

// ---------- applying a review ----------

// What happens to a short item after its review. Returns the item's new fields.
export function applyShortReview(item, r) {
  const draft = item.draft;
  const notes = [...(item.reviewNotes || []), r.notes].filter(Boolean).slice(-3);
  if (r.verdict === "reject") {
    return { state: "source", problem: r.problems.join("; ") || "the Reviewer rejected it", attempts: item.attempts + 1, reviewNotes: notes };
  }
  if (r.verdict === "revise") {
    const revised = { ...draft, question: r.revised_question || draft.question, choices: r.revised_choices, answer: r.revised_answer };
    const problem = checkShortDraft(item, revised);
    if (problem) return { state: "write", problem: `the Reviewer's fix didn't work (${problem}); the Reviewer said: ${r.problems.join("; ")}`, attempts: item.attempts + 1, reviewNotes: notes };
    return { state: "review", draft: revised, reviews: item.reviews + 1, reviewNotes: notes };
  }
  if (r.answer !== draft.answer) {
    return {
      state: "write",
      problem: `the Reviewer, answering without the key, chose "${draft.choices[r.answer] ?? r.answer}" instead of "${draft.choices[draft.answer]}", so the question isn't clear enough (${r.problems.join("; ") || "no other notes"})`,
      attempts: item.attempts + 1,
      reviewNotes: notes,
    };
  }
  const evidence = quoteFound(r.proof_quote, shortText(draft)) ? r.proof_quote : "";
  return { state: "approved", explanation: r.explanation, evidence, reviewNotes: notes };
}

// After a set's review: approved questions stay, revised ones are reviewed again,
// rejected ones are written again. Returns the item's new fields.
export function applySetReview(item, r) {
  const notes = [...(item.reviewNotes || []), r.notes].filter(Boolean).slice(-3);
  if (!r.passage_ok) {
    return { state: "source", problem: r.passage_problems.join("; ") || "the Reviewer rejected the passage", attempts: item.attempts + 1, reviewNotes: notes };
  }
  const questions = item.draft.questions.map((q) => ({ ...q }));
  const qstate = [...item.qstate];
  const explanations = [...(item.explanations || [])];
  const evidence = [...(item.evidence || [])];
  const replace = [];
  const problems = [];
  const text = item.draft.paragraphs.join("\n\n");
  for (const review of r.questions) {
    const i = review.number - 1;
    if (!(i >= 0 && i < questions.length) || qstate[i] === "approved") continue;
    const q = questions[i];
    if (review.verdict === "approve" && review.answer === q.answer) {
      qstate[i] = "approved";
      explanations[i] = review.explanation;
      evidence[i] = quoteFound(review.proof_quote, text) ? review.proof_quote : "";
    } else if (review.verdict === "revise" && !checkChoices(review.revised_choices, review.revised_answer)) {
      questions[i] = { ...q, question: review.revised_question || q.question, choices: review.revised_choices, answer: review.revised_answer };
      qstate[i] = "review";
    } else {
      replace.push(i);
      qstate[i] = "write";
      problems.push(`question ${i + 1}: ${review.verdict === "approve" ? `answering without the key, the Reviewer chose choice ${review.answer + 1}, not ${q.answer + 1}` : review.problems.join("; ") || "rejected"}`);
    }
  }
  // Questions the Reviewer skipped are reviewed again.
  qstate.forEach((s, i) => { if (s !== "approved" && s !== "write") qstate[i] = "review"; });
  const draft = { ...item.draft, questions };
  const base = { draft, qstate, explanations, evidence, reviewNotes: notes, reviews: item.reviews + 1 };
  if (replace.length) return { ...base, state: "write", replace, problem: problems.join("; ") };
  if (qstate.every((s) => s === "approved")) return { ...base, state: "approved" };
  return { ...base, state: "review" };
}

// A set that ran out of review rounds keeps the questions the Reviewer approved,
// if there are at least MIN_SET of them. Returns the item's new fields.
export const MIN_SET = 7;
export function finishSet(item) {
  const keep = item.qstate.map((s, i) => (s === "approved" ? i : -1)).filter((i) => i >= 0);
  if (keep.length < MIN_SET) return { state: "failed", problem: `only ${keep.length} questions passed review` };
  return {
    state: "approved",
    draft: { ...item.draft, questions: keep.map((i) => item.draft.questions[i]) },
    qstate: keep.map(() => "approved"),
    explanations: keep.map((i) => item.explanations[i]),
    evidence: keep.map((i) => item.evidence[i] || ""),
  };
}

// ---------- the batch students get ----------

function sourceCredit(source) {
  return { title: source.title, author: source.author || "", year: source.year || "", url: source.url, license: source.license, publisher: source.publisher };
}

export function shortQuestion(item) {
  const d = item.draft;
  return {
    style: "SAT", type: item.type, subject: item.subject, difficulty: d.difficulty, title: d.title,
    intro: d.intro || "", passage: d.passage, passage2: d.passage2 || "", notes: d.notes || [],
    table: d.table_columns.length ? { title: d.table_title, columns: d.table_columns, rows: d.table_rows.map((r) => ({ cells: rowCells(r) })) } : null,
    question: d.question, choices: d.choices, correct: d.answer, explanation: item.explanation, evidence: item.evidence || "",
    source: sourceCredit(item.source), review: (item.reviewNotes || []).at(-1) || "",
  };
}

// Puts approved items together into a batch: up to SETS_PER_BATCH sets, then
// short questions up to BATCH_SIZE, in a random order (each set's questions stay
// together, in order). `random` is for tests.
export function assembleBatch(number, items, random = Math.random) {
  const shuffle = (list) => {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const approvedSets = items.filter((i) => i.kind === "set" && i.state === "approved");
  const shorts = shuffle(items.filter((i) => i.kind === "short" && i.state === "approved"));
  const sets = approvedSets.slice(0, SETS_PER_BATCH);
  const setQuestions = () => sets.reduce((n, s) => n + s.draft.questions.length, 0);
  let room = BATCH_SIZE - setQuestions();
  // An extra set fills in for missing short questions.
  if (shorts.length < room && approvedSets.length > sets.length) {
    sets.push(approvedSets[sets.length]);
    room = Math.max(0, BATCH_SIZE - setQuestions());
  }
  const units = shuffle([...sets.map((s) => ({ set: s })), ...shorts.slice(0, room).map((s) => ({ short: s }))]);
  const questions = [];
  const setDocs = {};
  const id = (k) => `b${number}-${String(k).padStart(3, "0")}`;
  let p = 0;
  for (const unit of units) {
    if (unit.short) {
      questions.push({ id: id(questions.length + 1), ...shortQuestion(unit.short) });
      continue;
    }
    const s = unit.set;
    const setId = `b${number}-p${++p}`;
    setDocs[setId] = { id: setId, title: s.draft.title, intro: s.draft.intro, paragraphs: s.draft.paragraphs, subject: s.subject, source: sourceCredit(s.source), review: (s.reviewNotes || []).at(-1) || "" };
    s.draft.questions.forEach((q, i) => {
      questions.push({
        id: id(questions.length + 1), style: "ACT", type: q.type, subject: s.subject, difficulty: q.difficulty, title: s.draft.title,
        set: setId, setPos: i + 1, question: q.question, choices: q.choices, correct: q.answer,
        explanation: s.explanations[i], evidence: s.evidence[i] || "", source: sourceCredit(s.source), review: "",
      });
    });
  }
  return { number, questions, sets: setDocs };
}

// The plan for a batch: which items to write, with types, subjects, and difficulty.
export function planItems(random = Math.random) {
  const items = [];
  const shortCount = SHORT_PER_BATCH + EXTRA_SHORT;
  for (let k = 0; k < shortCount; k++) {
    const type = SAT_TYPES[k % SAT_TYPES.length];
    const subjects = type.subjects;
    const subject = subjects[(Math.floor(k / SAT_TYPES.length) + Math.floor(random() * subjects.length)) % subjects.length];
    items.push({ id: `s${String(k + 1).padStart(3, "0")}`, kind: "short", type: type.id, subject, difficulty: DIFFICULTIES[k % 3] });
  }
  // ACT-style sets: two literary narratives, then the other kinds.
  const setSubjects = ["Literature", "Literature", "Social science", "History", "Humanities", "Science", "Science"];
  for (let k = 0; k < SETS_PER_BATCH + EXTRA_SETS; k++) {
    items.push({ id: `a${k + 1}`, kind: "set", subject: setSubjects[k % setSubjects.length], types: SET_TYPES });
  }
  return items.map((i) => ({ ...i, state: "source", attempts: 0, reviews: 0, problem: "" }));
}
