// Teacher dashboard: lists every student who has signed in, with login history
// and learned/practice counts, lets teachers add words for all students or add
// or remove words for each student, and shows the list of teachers. Firestore rules only let teachers
// read this, and only the owner can add or remove teachers.

import {
  configured, isOwner, isTeacher, watchUser, signIn, signOutUser, listStudents, recentLogins,
  listTeachers, addTeacher, removeTeacher, addStudentWord, removeStudentWord, restoreStudentWord,
  loadClassWords, addClassWord, removeClassWord, writeWordContent, listInvites, addInvite, removeInvite,
  loadHiddenWords, hideWord, unhideWord,
  LEARNED_STREAK, PRACTICE_LIMIT,
} from "./firebase.js";
import { OWNER_EMAILS } from "./firebase-config.js";
import { loadWords, wordsForStudent, sharedWords, TEACHER_SOURCE } from "./words.js";
import { usableExample, suggestChoices, wordFinder } from "./questions.js";

const $ = (id) => document.getElementById(id);
let dbWords = [];
// Words a teacher added for every student.
let classWords = [];
// Database words a teacher took off every student's list: { word, removedBy, removedAt }.
let hiddenWords = [];
const hiddenNames = () => hiddenWords.map((h) => h.word);
let students = [];

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function formatTime(ts) {
  if (!ts) return "—";
  const date = ts.toDate ? ts.toDate() : new Date(ts);
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function studentWordNames(student) {
  return new Set(wordsForStudent(dbWords, student.wordList, classWords, hiddenNames()).map((w) => w.word));
}

// The start of a message about a word that's already there, maybe in another form:
// `"abandoned" is a form of "abandon", which is` or `"abandon" is`.
function alreadyThere(word, found) {
  return found === word ? `"${word}" is` : `"${word}" is a form of "${found}", which is`;
}

function summarize(student) {
  // Only count progress on words still on the student's list.
  const own = studentWordNames(student);
  const entries = Object.entries(student.words).filter(([w]) => own.has(w));
  const learned = entries.filter(([, p]) => p.streak >= LEARNED_STREAK).map(([w]) => w).sort();
  const close = entries
    .filter(([, p]) => p.streak > 0 && p.streak < LEARNED_STREAK)
    .sort((a, b) => b[1].streak - a[1].streak)
    .map(([w, p]) => `${w} (${p.streak}/${LEARNED_STREAK})`);
  const missed = entries.filter(([, p]) => p.streak === 0 && p.wrong > 0).map(([w]) => w).sort();
  const notLearned = own.size - learned.length;
  return {
    total: own.size, learned, close, missed,
    practice: Math.min(PRACTICE_LIMIT, notLearned), upcoming: Math.max(0, notLearned - PRACTICE_LIMIT),
  };
}

function renderStats() {
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const activeThisWeek = students.filter((s) => s.lastLogin && s.lastLogin.toMillis() > weekAgo).length;
  const totalLearned = students.reduce((sum, s) => sum + summarize(s).learned.length, 0);
  $("stats").innerHTML = [
    ["Students", students.length],
    ["Active in the last 7 days", activeThisWeek],
    ["Words learned (all students)", totalLearned],
  ].map(([label, value]) => `<div class="stat"><span class="stat-value">${value}</span><span class="stat-label">${label}</span></div>`).join("");
}

function renderRows() {
  const q = $("search").value.trim().toLowerCase();
  const shown = students.filter((s) => !q || `${s.name} ${s.email}`.toLowerCase().includes(q));
  $("rows").innerHTML = shown.map((s) =>
    `<tr class="student" data-uid="${escapeHtml(s.uid)}" tabindex="0">${rowCells(s)}</tr>`).join("") || `<tr><td colspan="6" class="muted">No students yet. Students appear here after they sign in to the study app.</td></tr>`;

  document.querySelectorAll("tr.student").forEach((row) => {
    const open = () => toggleDetail(row);
    row.addEventListener("click", open);
    row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  });
}

function rowCells(s) {
  const { total, learned, practice } = summarize(s);
  const pct = total ? (learned.length / total) * 100 : 0;
  return `<td><strong>${escapeHtml(s.name || "(no name)")}</strong><br><span class="muted">${escapeHtml(s.email)}</span></td>
    <td>${formatTime(s.lastLogin)}</td>
    <td class="num">${s.loginCount || 0}</td>
    <td class="num">${learned.length}</td>
    <td class="num">${practice}</td>
    <td><span class="bar" title="${pct.toFixed(1)}% learned"><span style="width:${pct}%"></span></span></td>`;
}

async function toggleDetail(row) {
  const existing = row.nextElementSibling;
  if (existing && existing.classList.contains("detail")) {
    existing.remove();
    return;
  }
  const student = students.find((s) => s.uid === row.dataset.uid);
  const { learned, close, missed } = summarize(student);
  const detail = document.createElement("tr");
  detail.className = "detail";
  detail.innerHTML = `<td colspan="6"><p class="muted">Loading logins…</p></td>`;
  row.after(detail);

  let logins = [];
  try {
    logins = await recentLogins(student.uid);
  } catch {
    // Show the rest of the detail even if login history can't load.
  }
  const list = (items, empty) => items.length ? items.map(escapeHtml).join(", ") : `<span class="muted">${empty}</span>`;
  detail.innerHTML = `<td colspan="6"><div class="detail-grid">
    <div><h3>Recent logins</h3>${logins.length
      ? `<ul>${logins.map((l) => `<li>${formatTime(l.at)}</li>`).join("")}</ul>`
      : `<p class="muted">None recorded.</p>`}
      <p class="muted">First login: ${formatTime(student.firstLogin)}</p></div>
    <div><h3>Learned (${learned.length})</h3><p>${list(learned, "None yet.")}</p></div>
    <div><h3>Closest to learning</h3><p>${list(close, "None in progress.")}</p>
      <h3>Recently missed</h3><p>${list(missed, "None.")}</p></div>
  </div><div class="word-tools"></div></td>`;
  renderWordTools(detail.querySelector(".word-tools"), student, row);
}

// ---------- each student's words ----------

const DICTIONARY_API = "https://api.dictionaryapi.dev/api/v2/entries/en/";
const WIKTIONARY_API = "https://en.wiktionary.org/api/rest_v1/page/definition/";

function asSentence(text) {
  const t = text.trim();
  return t && t[0].toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? "" : ".");
}

// Wiktionary's definitions are HTML.
function plainText(html) {
  return new DOMParser().parseFromString(html || "", "text/html").body.textContent.trim();
}

async function fromFreeDictionary(word) {
  const r = await fetch(DICTIONARY_API + encodeURIComponent(word));
  if (!r.ok) throw new Error(`Free Dictionary API returned ${r.status}`);
  const meaning = (await r.json()).flatMap((e) => e.meanings || []).find((m) => m.definitions?.length);
  if (!meaning) return null;
  const example = meaning.definitions[0].example || meaning.definitions.find((d) => d.example)?.example || "";
  return { part_of_speech: meaning.partOfSpeech || "", definition: meaning.definitions[0].definition, example };
}

async function fromWiktionary(word) {
  const r = await fetch(WIKTIONARY_API + encodeURIComponent(word.replace(/ /g, "_")));
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Wiktionary returned ${r.status}`);
  for (const meaning of (await r.json()).en || []) {
    const def = (meaning.definitions || []).find((d) => plainText(d.definition));
    if (def) {
      const example = def.parsedExamples?.[0]?.example || def.examples?.[0] || "";
      return { part_of_speech: meaning.partOfSpeech.toLowerCase(), definition: plainText(def.definition), example: plainText(example) };
    }
  }
  return null;
}

// Looks the word up online, in Wiktionary if the Free Dictionary API doesn't
// have it (that API fails on phrases). Returns null if neither has it.
async function lookUpWord(word) {
  let found = null;
  try {
    found = await fromFreeDictionary(word);
  } catch {
    // Try Wiktionary instead.
  }
  found = found || await fromWiktionary(word);
  return found && { ...found, definition: asSentence(found.definition), example: asSentence(found.example) };
}

// A word as stored: lowercase, single spaces, letters only. Returns "" if it isn't one.
function normalizeWord(text) {
  const word = text.trim().toLowerCase().replace(/\s+/g, " ");
  return /^[a-z]([a-z' -]*[a-z])?$/.test(word) ? word : "";
}

// Look a word up online and have Claude write the rest, then show it in the
// add-word dialog for the teacher to check. If Claude can't, the dialog shows
// what the dictionary has.
async function lookUpAndPreview(word, button, options) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Looking up…";
  let found = null;
  let note = "Found online. Check it and edit if needed.";
  try {
    found = await lookUpWord(word);
    if (!found) note = "Couldn't find this word online. Type a definition and example below.";
    else if (!found.example) note = "Found online, but without an example. Check the definition and write an example sentence.";
  } catch {
    note = "Couldn't reach the online dictionary. Type a definition and example below.";
  }
  button.textContent = "Writing an example…";
  let entry = found || { part_of_speech: "", definition: "", example: "" };
  try {
    const written = await writeWordContent(word, found?.definition || "");
    entry = {
      part_of_speech: written.part_of_speech,
      definition: asSentence(written.definition),
      example: written.passage,
      choices: { wrongWords: written.wrong_words, meaning: written.meaning, wrongMeanings: written.wrong_meanings },
    };
    note = "Written by Claude. Check it and edit anything before you add it.";
  } catch (err) {
    console.error("Couldn't write the word with Claude", err);
    note += " (Claude couldn't write an example this time.)";
  }
  button.disabled = false;
  button.textContent = label;
  showPreview(word, entry, note, options);
}

function renderWordTools(container, student, row) {
  const { added, removed } = student.wordList;
  const addedWords = Object.values(added).sort((a, b) => a.word.localeCompare(b.word));
  const removedWords = Object.keys(removed).sort();
  container.innerHTML = `<h3>Word list</h3>
    <p class="muted">Add a word just for this student or remove one from their list. Added words are looked up online and come up first in their flashcards and quizzes. Progress on removed words is kept in case you restore them.</p>
    <form class="word-form">
      <input type="text" name="word" placeholder="Word" aria-label="Word" autocomplete="off" required>
      <button class="btn primary" type="submit" value="add">Add word</button>
      <button class="btn" type="submit" value="remove">Remove word</button>
    </form>
    <p class="error" hidden></p>
    <div class="detail-grid">
      <div><h3>Added for this student (${addedWords.length})</h3>${addedWords.length
        ? `<ul class="word-changes">${addedWords.map((w) => `<li><span><strong>${escapeHtml(w.word)}</strong>: ${escapeHtml(w.definition)}</span>
          <button class="link remove-word" data-word="${escapeHtml(w.word)}">Remove</button></li>`).join("")}</ul>`
        : `<p class="muted">None.</p>`}</div>
      <div><h3>Removed for this student (${removedWords.length})</h3>${removedWords.length
        ? `<ul class="word-changes">${removedWords.map((w) => `<li><span>${escapeHtml(w)}</span>
          <button class="link restore-word" data-word="${escapeHtml(w)}">Restore</button></li>`).join("")}</ul>`
        : `<p class="muted">None.</p>`}</div>
    </div>`;

  const form = container.querySelector(".word-form");
  const error = container.querySelector(".error");
  const showError = (message) => { error.textContent = message; error.hidden = !message; };

  // Run a change, then redraw this panel and the student's row with the new counts.
  async function change(action, failMessage) {
    container.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    try {
      await action();
    } catch (err) {
      console.error(err);
      container.querySelectorAll("button").forEach((b) => { b.disabled = false; });
      showError(failMessage);
      return false;
    }
    renderWordTools(container, student, row);
    row.innerHTML = rowCells(student);
    renderStats();
    renderAddedWords();
    return true;
  }

  const remove = (word) => {
    if (!confirm(`Remove "${word}" from ${student.name || student.email}'s word list?`)) return;
    // A word every student gets is hidden for this one; a word added just for them is deleted.
    const inDatabase = dbWords.some((w) => w.word === word) || classWords.some((w) => w.word === word);
    change(async () => {
      await removeStudentWord(student.uid, word, inDatabase);
      delete added[word];
      if (inDatabase) removed[word] = true;
    }, "Couldn't remove that word. Please try again.");
  };

  const restore = (word) => change(async () => {
    await restoreStudentWord(student.uid, word);
    delete removed[word];
  }, "Couldn't restore that word. Please try again.");

  container.querySelectorAll(".remove-word").forEach((b) => b.addEventListener("click", () => remove(b.dataset.word)));
  container.querySelectorAll(".restore-word").forEach((b) => b.addEventListener("click", () => restore(b.dataset.word)));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    showError("");
    const word = normalizeWord(form.word.value);
    if (!word) {
      showError("Enter a single word or phrase using letters only.");
      return;
    }
    // The word on the list that this one is, in any form ("abandoned" finds "abandon").
    const onList = wordFinder([...studentWordNames(student)])(word);
    if (e.submitter?.value === "remove") {
      if (onList) remove(onList);
      else showError(`"${word}" isn't on this student's word list.`);
      return;
    }
    if (onList) {
      showError(`${alreadyThere(word, onList)} already on this student's word list.`);
      return;
    }
    // A shared word the teacher removed earlier just comes back, in its own form.
    const wasRemoved = wordFinder(Object.keys(removed))(word);
    if (wasRemoved === word) {
      restore(word);
      return;
    }
    if (wasRemoved) {
      showError(`${alreadyThere(word, wasRemoved)} removed for this student. Add "${wasRemoved}" to restore it.`);
      return;
    }
    lookUpAndPreview(word, e.submitter, {
      title: `Add "${word}" for ${student.name || student.email}?`,
      // The dialog shows the error if saving fails.
      save: (saved) => change(async () => {
        await addStudentWord(student.uid, saved);
        added[word] = saved;
      }, ""),
    });
  });
}

// Show a looked-up word in a dialog where the teacher checks and edits it and its
// quiz choices. Nothing is saved until they confirm; save(entry) stores it and
// resolves to whether that worked.
function showPreview(word, entry, note, { title, warning = "", save }) {
  const dialog = $("word-dialog");
  const preview = $("word-preview");
  preview.innerHTML = `<h2 id="word-dialog-title">${escapeHtml(title)}</h2>
    <p class="dialog-word"><strong>${escapeHtml(word)}</strong> <span class="pos-label"></span></p>
    ${warning ? `<p class="dialog-warning">${escapeHtml(warning)}</p>` : ""}
    <p class="muted">${escapeHtml(note)}</p>
    <label>Part of speech <input name="pos" value="${escapeHtml(entry.part_of_speech)}" placeholder="noun, verb, adjective…"></label>
    <label>Definition <textarea name="definition" rows="2" required>${escapeHtml(entry.definition)}</textarea></label>
    <label>Example sentence, using the word <textarea name="example" rows="4" required>${escapeHtml(entry.example)}</textarea></label>
    <p class="muted">Quiz questions are built from this sentence in the SAT's Words in Context format, so it needs to use the word (or a form like "-ed" or "-ing"). <span class="form-used"></span></p>
    <fieldset class="choice-fields">
      <legend>Quiz answer choices (optional)</legend>
      <p class="muted choice-help"></p>
      <div class="choice-group">
        <span class="group-label">Wrong choices for the fill-in-the-blank question</span>
        <div class="choice-inputs">
          ${[1, 2, 3].map((n) => `<input name="wrong${n}" aria-label="Wrong choice ${n}" autocomplete="off">`).join("")}
        </div>
      </div>
      <div class="choice-group">
        <label class="group-label" for="word-meaning">Meaning as used in the sentence (the correct answer)</label>
        <input name="meaning" id="word-meaning" autocomplete="off">
        <span class="group-label">Wrong meanings</span>
        <div class="choice-inputs stacked">
          ${[1, 2, 3].map((n) => `<input name="wrongMeaning${n}" aria-label="Wrong meaning ${n}" autocomplete="off">`).join("")}
        </div>
      </div>
      <button class="link suggest" type="button">Suggest new choices</button>
    </fieldset>
    <p class="error" hidden></p>
    <div class="preview-actions">
      <button class="btn primary" type="submit">Confirm add</button>
      <button class="btn cancel" type="button">Cancel</button>
    </div>`;
  dialog.showModal();
  (entry.definition ? preview.example : preview.definition).focus();
  preview.querySelector(".cancel").addEventListener("click", () => dialog.close());

  // The word, its part of speech, and the form the example sentence uses, kept up to date.
  const showForm = () => {
    preview.querySelector(".pos-label").textContent = preview.pos.value.trim() ? `(${preview.pos.value.trim().toLowerCase()})` : "";
    const s = suggestChoices(draft(), []);
    preview.querySelector(".form-used").textContent = s && s.form !== word ? `The sentence uses the form "${s.form}".` : "";
  };

  const blankInputs = [1, 2, 3].map((n) => preview[`wrong${n}`]);
  const meaningInputs = [1, 2, 3].map((n) => preview[`wrongMeaning${n}`]);
  const help = preview.querySelector(".choice-help");
  const showError = (message, field) => {
    preview.querySelector(".error").textContent = message;
    preview.querySelector(".error").hidden = false;
    field?.focus();
  };
  const draft = () => ({
    word,
    part_of_speech: preview.pos.value.trim().toLowerCase() || "word",
    definition: preview.definition.value.trim(),
    examples: [asSentence(preview.example.value)],
  });
  // Choices the teacher has typed aren't replaced by new suggestions unless they ask.
  let edited = false;
  function suggest() {
    const s = suggestChoices(draft(), dbWords);
    if (!s) {
      help.textContent = "Write an example sentence that uses the word to get suggested choices.";
      return;
    }
    blankInputs.forEach((input, i) => { input.value = s.wrongWords[i] || ""; input.disabled = s.blankAtStart; });
    preview.meaning.value = s.meaning;
    meaningInputs.forEach((input, i) => { input.value = s.wrongMeanings[i] || ""; });
    help.textContent = s.blankAtStart
      ? `The sentence starts with "${s.form}", so the quiz can't blank it out and will only ask what it means. Move the word later in the sentence to use both questions.`
      : "Suggested from other words, in the form the sentence uses. Edit any of them, or clear a group to have the quiz pick new choices each time.";
    edited = false;
  }
  [...blankInputs, preview.meaning, ...meaningInputs].forEach((input) => input.addEventListener("input", () => { edited = true; }));
  [preview.example, preview.definition, preview.pos].forEach((input) => input.addEventListener("change", () => { if (!edited) suggest(); }));
  [preview.example, preview.pos].forEach((input) => input.addEventListener("input", showForm));
  showForm();
  preview.querySelector(".suggest").addEventListener("click", suggest);
  suggest();
  // Claude's choices replace the suggestions; "Suggest new choices" still swaps them out.
  if (entry.choices) {
    const { wrongWords, meaning, wrongMeanings } = entry.choices;
    blankInputs.forEach((input, i) => { if (!input.disabled) input.value = wrongWords[i] || ""; });
    preview.meaning.value = meaning || "";
    meaningInputs.forEach((input, i) => { input.value = wrongMeanings[i] || ""; });
    help.textContent = "Written by Claude for this passage. Edit any of them, click Suggest new choices, or clear a group to have the quiz pick new choices each time.";
  }

  preview.onsubmit = (e) => {
    e.preventDefault();
    const example = preview.example.value.trim();
    if (!usableExample(example, word)) {
      showError(word.includes(" ")
        ? `The example sentence needs to use "${word}".`
        : `The example sentence needs to use "${word}" or a form of it ending in -s, -ed, -ing, or -ly.`, preview.example);
      return;
    }
    // Each group of choices is all or nothing; an empty group is picked by the quiz.
    const info = suggestChoices(draft(), []);
    const filled = (inputs) => inputs.filter((input) => !input.disabled).map((input) => input.value.trim()).filter(Boolean);
    const distinct = (list) => new Set(list.map((t) => t.toLowerCase())).size === list.length;
    const wrongWords = filled(blankInputs);
    if (wrongWords.length && wrongWords.length < 3) {
      showError("Fill in all three wrong choices for the fill-in-the-blank question, or clear them to let the quiz pick.", blankInputs.find((i) => !i.value.trim()));
      return;
    }
    if (wrongWords.length && !distinct([info.form, ...wrongWords])) {
      showError(`The wrong choices for the fill-in-the-blank question must differ from each other and from "${info.form}".`, blankInputs[0]);
      return;
    }
    const meaningGroup = filled([preview.meaning, ...meaningInputs]);
    if (meaningGroup.length && meaningGroup.length < 4) {
      showError("Fill in the meaning and all three wrong meanings, or clear them to let the quiz pick.", [preview.meaning, ...meaningInputs].find((i) => !i.value.trim()));
      return;
    }
    if (meaningGroup.length && !distinct(meaningGroup)) {
      showError("The meaning and the wrong meanings must all be different.", meaningInputs[0]);
      return;
    }
    const capitalize = (t) => t.charAt(0).toUpperCase() + t.slice(1);
    const sat = { passage: asSentence(example), form: info.form };
    if (wrongWords.length) sat.wrong_words = wrongWords;
    if (meaningGroup.length) {
      sat.meaning = capitalize(meaningGroup[0]);
      sat.wrong_meanings = meaningGroup.slice(1).map(capitalize);
    }
    const saved = {
      word,
      part_of_speech: preview.pos.value.trim().toLowerCase() || "word",
      definition: asSentence(preview.definition.value),
      usage: "",
      examples: [asSentence(example)],
      forms_seen_on_tests: [],
      sources: [TEACHER_SOURCE],
      added: new Date().toISOString().slice(0, 10),
      addedBy: currentUser.email,
      ...(sat.wrong_words || sat.meaning ? { sat } : {}),
    };
    const buttons = preview.querySelectorAll("button");
    buttons.forEach((b) => { b.disabled = true; });
    save(saved).then((ok) => {
      if (ok) {
        dialog.close();
        return;
      }
      buttons.forEach((b) => { b.disabled = false; });
      showError("Couldn't save that word. Please try again.");
    });
  };
}

// ---------- words for all students ----------

// Every word a teacher added by hand, for all students or for one, newest first.
function renderAddedWords() {
  const rows = [
    ...classWords.map((w) => ({ entry: w, forLabel: "All students" })),
    ...students.flatMap((st) => Object.values(st.wordList.added).map((w) => ({ entry: w, student: st, forLabel: st.name || st.email }))),
  ].sort((a, b) => (b.entry.added || "").localeCompare(a.entry.added || "") || a.entry.word.localeCompare(b.entry.word));
  $("added-words-heading").textContent = `Words added by teachers (${rows.length})`;
  $("added-words-rows").innerHTML = rows.length
    ? rows.map(({ entry: w, student: st, forLabel }) => `<tr>
      <td><strong>${escapeHtml(w.word)}</strong>${w.part_of_speech ? ` <span class="muted">(${escapeHtml(w.part_of_speech)})</span>` : ""}</td>
      <td>${escapeHtml(w.definition)}</td>
      <td>${st ? escapeHtml(forLabel) : `<span class="badge learned">${forLabel}</span>`}</td>
      <td>${escapeHtml(w.addedBy || "—")}</td>
      <td>${escapeHtml(w.added || "—")}</td>
      <td><button class="link remove-word" data-word="${escapeHtml(w.word)}" data-uid="${st ? escapeHtml(st.uid) : ""}">Remove</button></td>
    </tr>`).join("")
    : `<tr><td colspan="6" class="muted">No words added yet.</td></tr>`;
  document.querySelectorAll("#added-words-rows .remove-word").forEach((b) => {
    b.addEventListener("click", () => removeAddedWord(b.dataset.word, students.find((st) => st.uid === b.dataset.uid)));
  });
}

// Remove a word added for all students, or one added for a single student.
async function removeAddedWord(word, student) {
  const who = student ? `${student.name || student.email}'s word list` : "all students";
  if (!confirm(`Remove "${word}" from ${who}? Progress on it is kept in case you add it again.`)) return;
  showAddedWordsError("");
  try {
    if (student) {
      await removeStudentWord(student.uid, word, false);
      delete student.wordList.added[word];
    } else {
      await removeClassWord(word);
      classWords = classWords.filter((w) => w.word !== word);
    }
  } catch {
    showAddedWordsError("Couldn't remove that word. Please try again.");
    return;
  }
  refreshCounts();
}

function showAddedWordsError(message) {
  $("added-words-error").textContent = message;
  $("added-words-error").hidden = !message;
}

function showClassWordError(message) {
  $("class-word-error").textContent = message;
  $("class-word-error").hidden = !message;
}

// Redraw everything that depends on which words the students have.
function refreshCounts() {
  renderAddedWords();
  renderDatabase();
  renderStats();
  renderRows();
}

$("class-word-form").addEventListener("submit", (e) => {
  e.preventDefault();
  showClassWordError("");
  const word = normalizeWord($("class-word").value);
  if (!word) {
    showClassWordError("Enter a single word or phrase using letters only.");
    return;
  }
  const inClass = wordFinder(classWords.map((w) => w.word))(word);
  if (inClass) {
    showClassWordError(`${alreadyThere(word, inClass)} already added for all students.`);
    return;
  }
  const hidden = wordFinder(hiddenNames())(word);
  if (hidden) {
    showClassWordError(`${alreadyThere(word, hidden)} in the word database but was removed for all students. Restore "${hidden}" under Removed for all students below.`);
    return;
  }
  const inDatabase = wordFinder(dbWords.map((w) => w.word))(word);
  if (inDatabase) {
    showClassWordError(`${alreadyThere(word, inDatabase)} already in the word database, so every student has it.`);
    return;
  }
  // Students who already have this word, in any form, added just for them. Their
  // copy is removed when the word is added for everyone, so no one has it twice.
  const copies = students.flatMap((st) => {
    const found = wordFinder(Object.keys(st.wordList.added))(word);
    return found ? [{ student: st, word: found }] : [];
  });
  lookUpAndPreview(word, e.submitter, {
    title: `Add "${word}" for all students?`,
    warning: copies.length
      ? `Already added just for ${copies.map((c) => `${c.student.name || c.student.email} (as "${c.word}")`).join(", ")}. `
        + "Adding it for all students replaces their copy, so they won't have it twice."
      : "",
    save: async (saved) => {
      try {
        await addClassWord(saved);
        for (const { student, word: copy } of copies) {
          await removeStudentWord(student.uid, copy, false);
          delete student.wordList.added[copy];
        }
      } catch (err) {
        console.error(err);
        return false;
      }
      classWords = [...classWords, saved];
      $("class-word").value = "";
      refreshCounts();
      return true;
    },
  });
});

// ---------- word database tab ----------

const DB_SHOWN = 200;

function showTab(name) {
  document.querySelectorAll(".admin-tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  $("tab-students").hidden = name !== "students";
  $("tab-database").hidden = name !== "database";
  try { sessionStorage.setItem("satvocab.adminTab", name); } catch {}
}

document.querySelectorAll(".admin-tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

// The students whose list has this word.
function studentsWith(word) {
  return students.filter((st) => studentWordNames(st).has(word));
}

function renderDatabase() {
  const q = $("db-search").value.trim().toLowerCase();
  const all = sharedWords(dbWords, classWords, hiddenNames());
  // Words whose name matches come first, then words whose definition does.
  const byName = all.filter((w) => w.word.includes(q));
  const byDefinition = q ? all.filter((w) => !w.word.includes(q) && (w.definition || "").toLowerCase().includes(q)) : [];
  const sortName = (list) => list.sort((a, b) => (b.word.startsWith(q) - a.word.startsWith(q)) || a.word.localeCompare(b.word));
  const matches = [...sortName(byName), ...sortName(byDefinition)];
  const shown = matches.slice(0, DB_SHOWN);
  $("db-count").textContent = q
    ? `${matches.length} of ${all.length} words match "${q}".` + (matches.length > DB_SHOWN ? ` Showing the first ${DB_SHOWN}.` : "")
    : `${all.length} words.` + (all.length > DB_SHOWN ? ` Showing the first ${DB_SHOWN}; search to find others.` : "");
  const isClass = new Set(classWords.map((w) => w.word));
  $("db-rows").innerHTML = shown.length
    ? shown.map((w) => {
      const removedFor = students.filter((st) => st.wordList.removed[w.word]).length;
      return `<tr>
        <td><strong>${escapeHtml(w.word)}</strong>${w.part_of_speech ? ` <span class="muted">(${escapeHtml(w.part_of_speech)})</span>` : ""}</td>
        <td>${escapeHtml(w.definition || "")}</td>
        <td>${isClass.has(w.word) ? `<span class="badge learned">Added for all students</span>` : "Word database"}${removedFor
          ? `<br><span class="muted">Removed for ${removedFor} student${removedFor === 1 ? "" : "s"}</span>` : ""}</td>
        <td><button class="link remove-word" data-word="${escapeHtml(w.word)}">Remove</button></td>
      </tr>`;
    }).join("")
    : `<tr><td colspan="4" class="muted">No words match "${escapeHtml(q)}".</td></tr>`;
  document.querySelectorAll("#db-rows .remove-word").forEach((b) => b.addEventListener("click", () => confirmRemove(b.dataset.word)));

  const hidden = [...hiddenWords].sort((a, b) => a.word.localeCompare(b.word));
  $("hidden-heading").textContent = `Removed for all students (${hidden.length})`;
  $("hidden-list").innerHTML = hidden.length
    ? hidden.map((h) => `<li><span>${escapeHtml(h.word)}</span>
      <span class="muted">removed ${formatTime(h.removedAt)} by ${escapeHtml(h.removedBy)}</span>
      <button class="link restore-hidden" data-word="${escapeHtml(h.word)}">Restore</button></li>`).join("")
    : `<li class="muted">None.</li>`;
  document.querySelectorAll("#hidden-list .restore-hidden").forEach((b) => {
    b.addEventListener("click", async () => {
      showDbError("");
      try {
        await unhideWord(b.dataset.word);
      } catch {
        showDbError("Couldn't restore that word. Please try again.");
        return;
      }
      hiddenWords = hiddenWords.filter((h) => h.word !== b.dataset.word);
      refreshCounts();
    });
  });
}

function showDbError(message) {
  $("db-error").textContent = message;
  $("db-error").hidden = !message;
}

$("db-search").addEventListener("input", renderDatabase);

// Ask how widely to remove a word, then remove it.
function confirmRemove(word) {
  const entry = sharedWords(dbWords, classWords, hiddenNames()).find((w) => w.word === word);
  const dialog = $("delete-dialog");
  const form = $("delete-form");
  const error = form.querySelector(".error");
  const having = studentsWith(word).sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
  $("delete-title").textContent = `Remove "${word}"?`;
  $("delete-definition").textContent = entry?.definition || "";
  form.student.innerHTML = having.length
    ? having.map((st) => `<option value="${escapeHtml(st.uid)}">${escapeHtml(st.name || st.email)}</option>`).join("")
    : `<option value="">No student has this word yet</option>`;
  form.scope.value = "all";
  form.querySelector('input[value="one"]').disabled = !having.length;
  form.student.disabled = !having.length;
  form.student.onchange = () => { form.scope.value = "one"; };
  error.hidden = true;
  form.querySelectorAll("button").forEach((b) => { b.disabled = false; });
  form.querySelector(".cancel").onclick = () => dialog.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    form.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    const student = form.scope.value === "one" && students.find((st) => st.uid === form.student.value);
    try {
      if (student) {
        // Also deletes a copy added just for this student.
        await removeStudentWord(student.uid, word, true);
        delete student.wordList.added[word];
        student.wordList.removed[word] = true;
      } else if (classWords.some((w) => w.word === word)) {
        await removeClassWord(word);
        classWords = classWords.filter((w) => w.word !== word);
      } else {
        await hideWord(word, currentUser.email);
        hiddenWords = [...hiddenWords, { word, removedBy: currentUser.email, removedAt: new Date() }];
      }
    } catch (err) {
      console.error(err);
      form.querySelectorAll("button").forEach((b) => { b.disabled = false; });
      error.textContent = "Couldn't remove that word. Please try again.";
      error.hidden = false;
      return;
    }
    dialog.close();
    refreshCounts();
  };
  dialog.showModal();
}

// ---------- invites ----------

let invites = [];

// The study app's address, next to this dashboard.
const APP_URL = new URL("./", location.href).href;
const INSTALL_GUIDE_URL = new URL("install.pdf", APP_URL).href; // made from INSTALL.md

function inviteMessage(email) {
  const teacher = currentUser.displayName || currentUser.email;
  return {
    subject: "You're invited to SAT Word Study",
    body: `Hi,\n\nI've invited you to SAT Word Study, a vocabulary app for the SAT. You'll study flashcards and take short quizzes in the SAT's Words in Context format.\n\nTo start:\n1. Open ${APP_URL}\n2. Click "Sign in with Google" and sign in with this email address: ${email}\n\nOn an iPhone or iPad, you can put the app on your home screen. This guide shows how, step by step: ${INSTALL_GUIDE_URL}\n\n${teacher}`,
  };
}

// Open the teacher's email app with the invitation written.
function sendInvite(email) {
  const { subject, body } = inviteMessage(email);
  location.href = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  $("invite-sent").innerHTML = `Your email app should open with the invitation to ${escapeHtml(email)}. If it doesn't, <button class="link copy-invite" type="button">copy the invitation</button> and send it yourself.`;
  $("invite-sent").hidden = false;
  $("invite-sent").querySelector(".copy-invite").addEventListener("click", async (e) => {
    try {
      await navigator.clipboard.writeText(`${subject}\n\n${body}`);
      e.target.textContent = "copied";
    } catch {
      e.target.textContent = "couldn't copy";
    }
  });
}

// Invites from students who haven't signed in yet.
function renderInvites() {
  const signedIn = new Set(students.map((s) => (s.email || "").toLowerCase()));
  const pending = invites.filter((i) => !signedIn.has(i.email)).sort((a, b) => a.email.localeCompare(b.email));
  $("invite-list").innerHTML = pending.length
    ? pending.map((i) => `<li><span>${escapeHtml(i.email)}</span>
      <span class="muted">invited ${formatTime(i.invitedAt)} by ${escapeHtml(i.invitedBy)}, hasn't signed in yet</span>
      <button class="link resend-invite" data-email="${escapeHtml(i.email)}">Send again</button>
      <button class="link remove-teacher" data-email="${escapeHtml(i.email)}">Remove</button></li>`).join("")
    : `<li class="muted">No invitations waiting. Invited students move to the table above once they sign in.</li>`;
  document.querySelectorAll("#invite-list .resend-invite").forEach((b) => b.addEventListener("click", () => sendInvite(b.dataset.email)));
  document.querySelectorAll("#invite-list .remove-teacher").forEach((b) => {
    b.addEventListener("click", async () => {
      if (!confirm(`Remove the invitation for ${b.dataset.email}? They won't be able to sign in to the study app.`)) return;
      showInviteError("");
      try {
        await removeInvite(b.dataset.email);
      } catch {
        showInviteError("Couldn't remove that invitation. Please try again.");
        return;
      }
      invites = invites.filter((i) => i.email !== b.dataset.email);
      renderInvites();
    });
  });
}

function showInviteError(message) {
  $("invite-error").textContent = message;
  $("invite-error").hidden = !message;
}

$("invite-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  showInviteError("");
  $("invite-sent").hidden = true;
  const email = $("invite-email").value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showInviteError("Enter a full email address, like name@school.org.");
    return;
  }
  if (students.some((s) => (s.email || "").toLowerCase() === email)) {
    showInviteError("That student has already signed in, so they can use the app.");
    return;
  }
  // Invites can only be created, so sending again doesn't save a new one.
  if (!invites.some((i) => i.email === email)) {
    try {
      await addInvite(email, currentUser.email);
    } catch {
      showInviteError("Couldn't save that invitation. Please try again.");
      return;
    }
    invites = [...invites, { email, invitedBy: currentUser.email, invitedAt: new Date() }];
  }
  $("invite-email").value = "";
  renderInvites();
  sendInvite(email);
});

// ---------- teachers ----------

let currentUser = null;

async function renderTeachers() {
  const owner = isOwner(currentUser);
  $("add-teacher").hidden = !owner;
  $("teachers-help").textContent = owner
    ? "Teachers can open this dashboard and see every student's progress. Add the Google account they'll sign in with. Only you, as the owner, can add or remove teachers."
    : "Teachers can open this dashboard and see every student's progress. Only the owner can add or remove teachers.";
  let teachers = [];
  try {
    teachers = await listTeachers();
  } catch {
    $("teacher-list").innerHTML = `<li class="muted">Couldn't load the teacher list.</li>`;
    return;
  }
  const owners = OWNER_EMAILS.map((email) => `<li><span>${escapeHtml(email)}</span><span class="badge learned">Owner</span></li>`);
  const others = teachers
    .filter((t) => !OWNER_EMAILS.includes(t.email))
    .sort((a, b) => a.email.localeCompare(b.email))
    .map((t) => `<li><span>${escapeHtml(t.email)}</span>
      <span class="muted">added ${formatTime(t.addedAt)}</span>
      ${owner ? `<button class="link remove-teacher" data-email="${escapeHtml(t.email)}">Remove</button>` : ""}</li>`);
  $("teacher-list").innerHTML = [...owners, ...others].join("");
  document.querySelectorAll(".remove-teacher").forEach((b) => {
    b.addEventListener("click", async () => {
      if (!confirm(`Remove ${b.dataset.email} as a teacher? They'll lose access to this dashboard.`)) return;
      try {
        await removeTeacher(b.dataset.email);
        renderTeachers();
      } catch {
        showTeacherError("Couldn't remove that teacher. Please try again.");
      }
    });
  });
}

function showTeacherError(message) {
  $("teacher-error").textContent = message;
  $("teacher-error").hidden = !message;
}

$("add-teacher").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("teacher-email").value.trim().toLowerCase();
  showTeacherError("");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showTeacherError("Enter a full email address, like name@school.org.");
    return;
  }
  if (OWNER_EMAILS.includes(email)) {
    showTeacherError("That's the owner account, which is already a teacher.");
    return;
  }
  try {
    // The rules only allow creating teacher docs, so re-adding one would be denied.
    if ((await listTeachers()).some((t) => t.email === email)) {
      showTeacherError("That account is already a teacher.");
      return;
    }
    await addTeacher(email, currentUser.email);
    $("teacher-email").value = "";
    renderTeachers();
  } catch {
    showTeacherError("Couldn't add that teacher. Please try again.");
  }
});

// ---------- start ----------

async function showDashboard(user) {
  currentUser = user;
  $("sign-in").hidden = true;
  $("who").textContent = user.email;
  $("account").hidden = false;
  if (!(await isTeacher(user))) {
    $("status").textContent = "This account doesn't have teacher access. Ask the app's owner to add you as a teacher.";
    $("status").hidden = false;
    $("dashboard").hidden = true;
    return;
  }
  $("status").textContent = "Loading students…";
  $("status").hidden = false;
  try {
    const [wordsDb, list, shared, invited, hidden] = await Promise.all([
      loadWords(),
      listStudents(),
      loadClassWords(),
      listInvites(),
      loadHiddenWords(),
    ]);
    dbWords = wordsDb.words;
    classWords = shared;
    invites = invited;
    hiddenWords = hidden;
    students = list.sort((a, b) => (b.lastLogin?.toMillis() || 0) - (a.lastLogin?.toMillis() || 0));
  } catch {
    $("status").textContent = "Couldn't load student data. Check that the Firestore rules are published (see FIREBASE-SETUP.md).";
    return;
  }
  $("status").hidden = true;
  $("dashboard").hidden = false;
  refreshCounts();
  renderInvites();
  renderTeachers();
  let tab = "students";
  try { tab = sessionStorage.getItem("satvocab.adminTab") || tab; } catch {}
  showTab(tab === "database" ? "database" : "students");
}

$("search").addEventListener("input", renderRows);
$("sign-in-button").addEventListener("click", () => signIn().catch((err) => {
  console.error("Sign-in failed", err);
  if (err.code === "auth/popup-closed-by-user" || err.code === "auth/cancelled-popup-request") return;
  $("status").textContent = `Sign-in didn't work (${err.code || err.message}).`;
  $("status").hidden = false;
}));
$("sign-out").addEventListener("click", () => signOutUser());

if (!configured) {
  $("status").textContent = "Firebase isn't set up yet. See FIREBASE-SETUP.md.";
} else {
  watchUser((user) => {
    if (user) {
      showDashboard(user);
    } else {
      $("account").hidden = true;
      $("dashboard").hidden = true;
      $("status").hidden = true;
      $("sign-in").hidden = false;
    }
  });
}
