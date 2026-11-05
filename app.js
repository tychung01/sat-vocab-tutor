// SAT Word Study: flashcards, quizzes, and a word list built from data/words.json.
// Students sign in with Google. Each word is either Learned (answered correctly
// in LEARNED_STREAK quizzes in a row) or Practice (everything else). Progress is
// saved to Firestore so the teacher dashboard can see it.

import {
  configured, isAdmin, watchUser, signIn, signOutUser, recordLogin,
  loadProgress, saveWordProgress, LEARNED_STREAK,
} from "./firebase.js";

const SET_SIZE = 10;
const REVIEW_PER_QUIZ = 2;

let words = [];
let user = null;
let progress = {};

const $ = (id) => document.getElementById(id);

// ---------- progress ----------

function categoryOf(word) {
  const p = progress[word];
  return p && p.streak >= LEARNED_STREAK ? "learned" : "practice";
}

function record(word, correct) {
  const p = progress[word] || { streak: 0, correct: 0, wrong: 0 };
  const next = {
    streak: correct ? p.streak + 1 : 0,
    correct: p.correct + (correct ? 1 : 0),
    wrong: p.wrong + (correct ? 0 : 1),
    last: Date.now(),
  };
  const wasLearned = categoryOf(word) === "learned";
  progress[word] = next;
  renderProgress();
  saveWordProgress(user.uid, word, next).catch(() => {
    $("status").textContent = "Couldn't save your progress. Check your connection; your answers will save when it's back.";
    $("status").hidden = false;
  });
  return { becameLearned: !wasLearned && categoryOf(word) === "learned", lostLearned: wasLearned && !correct };
}

function renderProgress() {
  const learned = words.filter((w) => categoryOf(w.word) === "learned").length;
  $("progress").innerHTML =
    `<span><b>${learned}</b> learned</span>` +
    `<span><b>${words.length - learned}</b> practice</span>` +
    `<span class="bar" aria-hidden="true"><span style="width:${(learned / words.length) * 100}%"></span></span>`;
}

// ---------- helpers ----------

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function isOfficial(w) {
  return w.sources.some((s) => s.includes("Practice Test"));
}

function isAcademic(w) {
  return w.sources.some((s) => s.includes("Word List"));
}

function mainPos(w) {
  return w.part_of_speech.split("/")[0].trim();
}

// Practice words in study order: words in progress (closest to learned first),
// then recently missed words, then words never tried.
function practiceQueue() {
  const practice = words.filter((w) => categoryOf(w.word) === "practice");
  const tried = practice.filter((w) => progress[w.word]);
  const fresh = shuffle(practice.filter((w) => !progress[w.word]));
  tried.sort((a, b) => progress[b.word].streak - progress[a.word].streak || progress[b.word].last - progress[a.word].last);
  return [...tried, ...fresh];
}

// Find the word (or an inflected form like "exacerbated") in a sentence.
function findWordIn(sentence, word) {
  const stem = word.length > 5 ? word.slice(0, word.length - 2) : word;
  const re = new RegExp(`\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[a-z]*\\b`, "i");
  return sentence.match(re);
}

function streakText(word) {
  const p = progress[word];
  if (!p) return "";
  if (p.streak >= LEARNED_STREAK) return "Learned";
  return `${p.streak} of ${LEARNED_STREAK} correct in a row`;
}

// ---------- tabs ----------

const views = ["study", "quiz", "words"];

function showView(name) {
  views.forEach((v) => {
    $(`view-${v}`).hidden = v !== name;
  });
  document.querySelectorAll(".tabs button").forEach((b) => {
    b.setAttribute("aria-selected", String(b.dataset.view === name));
  });
  try { sessionStorage.setItem("satvocab.view", name); } catch {}
  if (name === "words") renderWordList();
}

document.querySelectorAll(".tabs button").forEach((b) => {
  b.addEventListener("click", () => showView(b.dataset.view));
});

// ---------- flashcards ----------

let deck = [];
let deckIndex = 0;

function startStudy() {
  const queue = practiceQueue();
  deck = shuffle(queue.slice(0, SET_SIZE));
  deckIndex = 0;
  $("study-done").hidden = true;
  document.querySelector(".card-stage").hidden = deck.length === 0;
  if (deck.length) showCard();
  else {
    $("study-done").hidden = false;
    $("study-done").querySelector("h2").textContent = "You've learned every word!";
  }
}

function showCard() {
  const w = deck[deckIndex];
  $("study-counter").textContent = `Card ${deckIndex + 1} of ${deck.length}` + (progress[w.word] ? ` · ${streakText(w.word)}` : "");
  $("fc-word").textContent = w.word;
  $("fc-pos").textContent = w.part_of_speech;
  $("fc-word-back").textContent = w.word;
  $("fc-def").textContent = w.definition;
  $("fc-use").textContent = w.usage;
  $("fc-ex").innerHTML = w.examples.map((e) => `<li>${escapeHtml(e)}</li>`).join("");
  setFlipped(false);
}

function setFlipped(flipped) {
  document.querySelector("#flashcard .front").hidden = flipped;
  document.querySelector("#flashcard .back").hidden = !flipped;
  $("flashcard").setAttribute("aria-label", flipped ? "Show word" : "Show meaning");
}

$("flashcard").addEventListener("click", () => {
  setFlipped(!document.querySelector("#flashcard .front").hidden);
});

$("next-card").addEventListener("click", () => {
  deckIndex++;
  if (deckIndex < deck.length) {
    showCard();
  } else {
    document.querySelector(".card-stage").hidden = true;
    $("study-done").hidden = false;
  }
});

$("study-again").addEventListener("click", startStudy);

// ---------- quiz ----------

let quiz = [];
let quizIndex = 0;
let quizMissed = [];
let quizNewlyLearned = [];

function distractorsFor(target, count) {
  const samePos = words.filter((w) => w.word !== target.word && mainPos(w) === mainPos(target));
  const pool = samePos.length >= count ? samePos : words.filter((w) => w.word !== target.word);
  return shuffle(pool).slice(0, count);
}

function buildQuestion(target) {
  const choices = shuffle([target, ...distractorsFor(target, 3)]);
  const example = shuffle(target.examples).find((e) => findWordIn(e, target.word));
  // Alternate question types; fall back to definition when the word can't be blanked.
  if (example && Math.random() < 0.6) {
    const match = findWordIn(example, target.word);
    const blanked = escapeHtml(example.slice(0, match.index)) + '<span class="blank"></span>' + escapeHtml(example.slice(match.index + match[0].length));
    return {
      target, choices, kind: "Words in context",
      prompt: blanked,
      question: "Which choice completes the text with the most logical and precise word?",
      label: (w) => w.word,
    };
  }
  return {
    target, choices, kind: "Definition",
    prompt: escapeHtml(target.word),
    question: "Which choice best defines this word?",
    label: (w) => w.definition,
  };
}

// Mostly practice words, plus a couple of learned words to check they've stuck.
function pickQuizWords() {
  const learned = shuffle(words.filter((w) => categoryOf(w.word) === "learned")).slice(0, REVIEW_PER_QUIZ);
  const practice = practiceQueue().slice(0, SET_SIZE - learned.length);
  return shuffle([...practice, ...learned]);
}

function startQuiz() {
  quiz = pickQuizWords().map(buildQuestion);
  quizIndex = 0;
  quizMissed = [];
  quizNewlyLearned = [];
  $("quiz-done").hidden = true;
  $("quiz-question").hidden = false;
  showQuestion();
}

function showQuestion() {
  const q = quiz[quizIndex];
  $("quiz-counter").textContent = `Question ${quizIndex + 1} of ${quiz.length}`;
  $("quiz-kind").textContent = q.kind;
  $("quiz-prompt").innerHTML = q.prompt;
  $("quiz-q").textContent = q.question;
  $("quiz-feedback").hidden = true;
  $("quiz-next").hidden = true;
  $("quiz-choices").innerHTML = "";
  q.choices.forEach((choice, i) => {
    const b = document.createElement("button");
    b.className = "choice";
    b.innerHTML = `<span class="letter">${"ABCD"[i]})</span><span>${escapeHtml(q.label(choice))}</span>`;
    b.addEventListener("click", () => answerQuestion(choice, b));
    $("quiz-choices").appendChild(b);
  });
}

function answerQuestion(choice, button) {
  const q = quiz[quizIndex];
  const right = choice.word === q.target.word;
  [...$("quiz-choices").children].forEach((b, i) => {
    b.disabled = true;
    if (q.choices[i].word === q.target.word) b.classList.add("correct");
  });
  if (!right) {
    button.classList.add("wrong");
    quizMissed.push(q.target);
  }
  const { becameLearned, lostLearned } = record(q.target.word, right);
  if (becameLearned) quizNewlyLearned.push(q.target.word);

  const t = q.target;
  let html = `<p><strong>${right ? "Correct!" : "Not quite."}</strong> <strong>${escapeHtml(t.word)}</strong> (${escapeHtml(t.part_of_speech)}): ${escapeHtml(t.definition)}</p>`;
  if (!right) {
    html += `<p>You chose <strong>${escapeHtml(choice.word)}</strong>, which means: ${escapeHtml(choice.definition.toLowerCase())}</p>`;
  }
  html += `<p>${escapeHtml(t.usage)}</p>`;
  if (becameLearned) html += `<p class="win">🎉 <strong>${escapeHtml(t.word)}</strong> moved to Learned!</p>`;
  else if (lostLearned) html += `<p>This word moved back to Practice. Get it right ${LEARNED_STREAK} times in a row to learn it again.</p>`;
  else html += `<p class="streak">${streakText(t.word)}</p>`;
  $("quiz-feedback").innerHTML = html;
  $("quiz-feedback").hidden = false;
  $("quiz-next").hidden = false;
  $("quiz-next").textContent = quizIndex + 1 < quiz.length ? "Next" : "See results";
  $("quiz-next").focus();
}

$("quiz-next").addEventListener("click", () => {
  quizIndex++;
  if (quizIndex < quiz.length) {
    showQuestion();
    return;
  }
  $("quiz-question").hidden = true;
  $("quiz-done").hidden = false;
  const score = quiz.length - quizMissed.length;
  $("quiz-score").textContent = `You scored ${score} out of ${quiz.length}`;
  $("quiz-learned").textContent = quizNewlyLearned.length
    ? `New words learned: ${quizNewlyLearned.join(", ")}.`
    : "";
  $("quiz-missed").innerHTML = quizMissed.length
    ? `<h3>Review these words</h3>` + quizMissed.map(entryHtml).join("")
    : "<p>Perfect score! Try another quiz to keep going.</p>";
});

$("quiz-again").addEventListener("click", startQuiz);

// ---------- word list ----------

let filter = "practice";
let sourceFilter = "any";

function entryHtml(w) {
  const category = categoryOf(w.word);
  const badge = category === "learned"
    ? `<span class="badge learned">Learned</span>`
    : progress[w.word] ? `<span class="badge practice">${progress[w.word].streak}/${LEARNED_STREAK}</span>` : "";
  return `<details class="entry">
    <summary><span class="w">${escapeHtml(w.word)}</span>${badge}<span class="d">${escapeHtml(w.definition)}</span></summary>
    <div class="body">
      <p><em>${escapeHtml(w.part_of_speech)}</em></p>
      <p>${escapeHtml(w.usage)}</p>
      ${w.examples.map((e) => `<p><em>“${escapeHtml(e)}”</em></p>`).join("")}
      <p class="sources">Source: ${escapeHtml(w.sources.join("; "))}</p>
    </div>
  </details>`;
}

function renderWordList() {
  const queryText = $("search").value.trim().toLowerCase();
  const shown = words.filter((w) => {
    if (filter !== "all" && categoryOf(w.word) !== filter) return false;
    if (sourceFilter === "official" && !isOfficial(w)) return false;
    if (sourceFilter === "academic" && !isAcademic(w)) return false;
    if (sourceFilter === "curated" && (isOfficial(w) || isAcademic(w))) return false;
    return !queryText || w.word.toLowerCase().includes(queryText) || w.definition.toLowerCase().includes(queryText);
  });
  $("words-count").textContent = `${shown.length} word${shown.length === 1 ? "" : "s"}`;
  $("word-list").innerHTML = shown.map(entryHtml).join("");
}

$("search").addEventListener("input", renderWordList);

function wireChips(containerId, key, onPick) {
  document.querySelectorAll(`#${containerId} button`).forEach((b) => {
    b.addEventListener("click", () => {
      onPick(b.dataset[key]);
      document.querySelectorAll(`#${containerId} button`).forEach((c) => c.setAttribute("aria-pressed", String(c === b)));
      renderWordList();
    });
  });
}

wireChips("chips", "filter", (value) => { filter = value; });
wireChips("source-chips", "source", (value) => { sourceFilter = value; });

// ---------- sign-in and start ----------

function showSignedOut() {
  user = null;
  $("account").hidden = true;
  $("tabs").hidden = true;
  $("progress").innerHTML = "";
  views.forEach((v) => { $(`view-${v}`).hidden = true; });
  $("status").hidden = true;
  $("sign-in").hidden = false;
}

async function showSignedIn(signedInUser) {
  user = signedInUser;
  $("sign-in").hidden = true;
  $("status").textContent = "Loading your progress…";
  $("status").hidden = false;
  $("who").textContent = user.displayName || user.email;
  $("admin-link").hidden = !isAdmin(user);
  $("account").hidden = false;

  recordLogin(user).catch(() => {});
  try {
    progress = await loadProgress(user.uid);
  } catch {
    $("status").textContent = "Couldn't load your progress. Please refresh the page.";
    return;
  }
  $("status").hidden = true;
  $("tabs").hidden = false;
  renderProgress();
  startStudy();
  startQuiz();
  let view = "study";
  try { view = sessionStorage.getItem("satvocab.view") || view; } catch {}
  showView(views.includes(view) ? view : "study");
}

$("sign-in-button").addEventListener("click", () => {
  $("sign-in-error").hidden = true;
  signIn().catch((err) => {
    if (err.code === "auth/popup-closed-by-user") return;
    $("sign-in-error").textContent = "Sign-in didn't work. If a pop-up was blocked, allow pop-ups for this site and try again.";
    $("sign-in-error").hidden = false;
  });
});

$("sign-out").addEventListener("click", () => signOutUser());

async function start() {
  try {
    const r = await fetch("data/words.json", { cache: "no-cache" });
    if (!r.ok) throw new Error(r.status);
    const db = await r.json();
    words = db.words;
    $("updated").textContent = `${words.length} words · last updated ${db.updated}`;
  } catch {
    $("status").textContent = "Couldn't load the word list. Please refresh the page.";
    return;
  }
  if (!configured) {
    $("status").textContent = "This app isn't connected to its database yet. (Teacher: see FIREBASE-SETUP.md.)";
    return;
  }
  watchUser((u) => (u ? showSignedIn(u) : showSignedOut()));
}

start();
