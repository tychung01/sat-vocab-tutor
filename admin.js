// Teacher dashboard: lists every student who has signed in, with login history
// and learned/practice counts, lets teachers add or remove words for each
// student, and shows the list of teachers. Firestore rules only let teachers
// read this, and only the owner can add or remove teachers.

import {
  configured, isOwner, isTeacher, watchUser, signIn, signOutUser, listStudents, recentLogins,
  listTeachers, addTeacher, removeTeacher, addStudentWord, removeStudentWord, restoreStudentWord,
  LEARNED_STREAK, PRACTICE_LIMIT,
} from "./firebase.js";
import { OWNER_EMAILS } from "./firebase-config.js";
import { loadWords, wordsForStudent, TEACHER_SOURCE } from "./words.js";
import { usableExample } from "./questions.js";

const $ = (id) => document.getElementById(id);
let dbWords = [];
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
  return new Set(wordsForStudent(dbWords, student.wordList).map((w) => w.word));
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
    <form class="word-preview" hidden></form>
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
  const preview = container.querySelector(".word-preview");
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
      return;
    }
    renderWordTools(container, student, row);
    row.innerHTML = rowCells(student);
    renderStats();
  }

  const remove = (word) => {
    if (!confirm(`Remove "${word}" from ${student.name || student.email}'s word list?`)) return;
    const inDatabase = dbWords.some((w) => w.word === word);
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
    preview.hidden = true;
    const word = form.word.value.trim().toLowerCase().replace(/\s+/g, " ");
    if (!/^[a-z]([a-z' -]*[a-z])?$/.test(word)) {
      showError("Enter a single word or phrase using letters only.");
      return;
    }
    const onList = studentWordNames(student).has(word);
    if (e.submitter?.value === "remove") {
      if (onList) remove(word);
      else showError(`"${word}" isn't on this student's word list.`);
      return;
    }
    if (onList) {
      showError(`"${word}" is already on this student's word list.`);
      return;
    }
    // A database word the teacher removed earlier just comes back.
    if (removed[word]) {
      restore(word);
      return;
    }
    const button = e.submitter;
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
    button.disabled = false;
    button.textContent = "Add word";
    showPreview(word, found || { part_of_speech: "", definition: "", example: "" }, note);
  });

  function showPreview(word, entry, note) {
    preview.innerHTML = `<p><strong>${escapeHtml(word)}</strong> <span class="muted">${escapeHtml(note)}</span></p>
      <label>Part of speech <input name="pos" value="${escapeHtml(entry.part_of_speech)}" placeholder="noun, verb, adjective…"></label>
      <label>Definition <textarea name="definition" rows="2" required>${escapeHtml(entry.definition)}</textarea></label>
      <label>Example sentence, using the word <textarea name="example" rows="2" required>${escapeHtml(entry.example)}</textarea></label>
      <p class="muted">Quiz questions are built from this sentence in the SAT's Words in Context format, so it needs to use the word (or a form like "-ed" or "-ing").</p>
      <p class="error" hidden></p>
      <div class="preview-actions">
        <button class="btn primary" type="submit">Save word</button>
        <button class="btn" type="button">Cancel</button>
      </div>`;
    preview.hidden = false;
    (entry.definition ? preview.example : preview.definition).focus();
    preview.querySelector("button[type=button]").addEventListener("click", () => { preview.hidden = true; });
    preview.onsubmit = (e) => {
      e.preventDefault();
      const example = preview.example.value.trim();
      if (!usableExample(example, word)) {
        preview.querySelector(".error").textContent = word.includes(" ")
          ? `The example sentence needs to use "${word}".`
          : `The example sentence needs to use "${word}" or a form of it ending in -s, -ed, -ing, or -ly.`;
        preview.querySelector(".error").hidden = false;
        preview.example.focus();
        return;
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
      };
      change(async () => {
        await addStudentWord(student.uid, saved);
        added[word] = saved;
      }, "Couldn't save that word. Please try again.");
    };
  }
}

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
    const [wordsDb, list] = await Promise.all([
      loadWords(),
      listStudents(),
    ]);
    dbWords = wordsDb.words;
    students = list.sort((a, b) => (b.lastLogin?.toMillis() || 0) - (a.lastLogin?.toMillis() || 0));
  } catch {
    $("status").textContent = "Couldn't load student data. Check that the Firestore rules are published (see FIREBASE-SETUP.md).";
    return;
  }
  $("status").hidden = true;
  $("dashboard").hidden = false;
  renderStats();
  renderRows();
  renderTeachers();
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
