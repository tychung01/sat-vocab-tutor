// SAT Word Study: flashcards, quizzes, and a word list built from data/words.json.
// Progress is kept per browser in localStorage using a simple Leitner box
// (0 = missed recently, 3+ = mastered).

const STORE_KEY = "satvocab.progress.v1";
const SET_SIZE = 10;
const MASTERED_BOX = 3;

let words = [];
let progress = loadProgress();

const $ = (id) => document.getElementById(id);

// ---------- progress ----------

function loadProgress() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveProgress() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(progress));
  } catch {
    // Storage blocked (private mode etc.): progress lasts for this visit only.
  }
}

function record(word, knewIt) {
  const p = progress[word] || { box: 0, right: 0, wrong: 0 };
  if (knewIt) {
    p.box = Math.min(p.box + 1, 5);
    p.right += 1;
  } else {
    p.box = 0;
    p.wrong += 1;
  }
  p.last = Date.now();
  progress[word] = p;
  saveProgress();
  renderProgress();
}

function statusOf(word) {
  const p = progress[word];
  if (!p) return "new";
  return p.box >= MASTERED_BOX ? "mastered" : "learning";
}

function renderProgress() {
  const counts = { new: 0, learning: 0, mastered: 0 };
  words.forEach((w) => counts[statusOf(w.word)]++);
  $("progress").innerHTML =
    `<span><b>${counts.mastered}</b> mastered</span>` +
    `<span><b>${counts.learning}</b> learning</span>` +
    `<span><b>${counts.new}</b> new</span>`;
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

// Pick a study set: words being learned first (lowest box, oldest first),
// then new words, then a few mastered words for review.
function pickSet(size) {
  const learning = words
    .filter((w) => statusOf(w.word) === "learning")
    .sort((a, b) => progress[a.word].box - progress[b.word].box || progress[a.word].last - progress[b.word].last);
  const fresh = shuffle(words.filter((w) => statusOf(w.word) === "new"));
  const mastered = shuffle(words.filter((w) => statusOf(w.word) === "mastered"));
  return shuffle([...learning, ...fresh, ...mastered].slice(0, size));
}

// Find the word (or an inflected form like "exacerbated") in a sentence.
function findWordIn(sentence, word) {
  const stem = word.length > 5 ? word.slice(0, word.length - 2) : word;
  const re = new RegExp(`\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[a-z]*\\b`, "i");
  return sentence.match(re);
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
let deckKnown = 0;

function startStudy() {
  deck = pickSet(SET_SIZE);
  deckIndex = 0;
  deckKnown = 0;
  $("study-done").hidden = true;
  document.querySelector(".card-stage").hidden = false;
  showCard();
}

function showCard() {
  const w = deck[deckIndex];
  $("study-counter").textContent = `Card ${deckIndex + 1} of ${deck.length}`;
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
  $("study-actions").hidden = !flipped;
  $("flashcard").setAttribute("aria-label", flipped ? "Show word" : "Show meaning");
}

$("flashcard").addEventListener("click", () => {
  setFlipped(!document.querySelector("#flashcard .front").hidden);
});

function answerCard(knewIt) {
  record(deck[deckIndex].word, knewIt);
  if (knewIt) deckKnown++;
  deckIndex++;
  if (deckIndex < deck.length) {
    showCard();
  } else {
    document.querySelector(".card-stage").hidden = true;
    $("study-done").hidden = false;
    $("study-summary").textContent = `You knew ${deckKnown} of ${deck.length} words. Words you're still learning will come back in your next set.`;
  }
}

$("know-it").addEventListener("click", () => answerCard(true));
$("still-learning").addEventListener("click", () => answerCard(false));
$("study-again").addEventListener("click", startStudy);

// ---------- quiz ----------

let quiz = [];
let quizIndex = 0;
let quizMissed = [];

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

function startQuiz() {
  quiz = pickSet(SET_SIZE).map(buildQuestion);
  quizIndex = 0;
  quizMissed = [];
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
  const buttons = [...$("quiz-choices").children];
  buttons.forEach((b, i) => {
    b.disabled = true;
    if (q.choices[i].word === q.target.word) b.classList.add("correct");
  });
  if (!right) {
    button.classList.add("wrong");
    quizMissed.push(q.target);
  }
  record(q.target.word, right);

  const t = q.target;
  let html = `<p><strong>${right ? "Correct!" : "Not quite."}</strong> <strong>${escapeHtml(t.word)}</strong> (${escapeHtml(t.part_of_speech)}): ${escapeHtml(t.definition)}</p>`;
  if (!right) {
    html += `<p>You chose <strong>${escapeHtml(choice.word)}</strong>, which means: ${escapeHtml(choice.definition.toLowerCase())}</p>`;
  }
  html += `<p>${escapeHtml(t.usage)}</p>`;
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
  $("quiz-missed").innerHTML = quizMissed.length
    ? `<h3>Review these words</h3>` + quizMissed.map(entryHtml).join("")
    : "<p>Perfect score! Try another quiz to keep going.</p>";
});

$("quiz-again").addEventListener("click", startQuiz);

// ---------- word list ----------

let filter = "all";

function entryHtml(w) {
  const status = statusOf(w.word);
  const badge = status === "new" ? "" : `<span class="badge ${status}">${status}</span>`;
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
  const query = $("search").value.trim().toLowerCase();
  const shown = words.filter((w) => {
    if (filter === "official" && !isOfficial(w)) return false;
    if (filter === "academic" && !isAcademic(w)) return false;
    if (filter === "curated" && (isOfficial(w) || isAcademic(w))) return false;
    if ((filter === "learning" || filter === "mastered") && statusOf(w.word) !== filter) return false;
    return !query || w.word.toLowerCase().includes(query) || w.definition.toLowerCase().includes(query);
  });
  $("words-count").textContent = `${shown.length} word${shown.length === 1 ? "" : "s"}`;
  $("word-list").innerHTML = shown.map(entryHtml).join("");
}

$("search").addEventListener("input", renderWordList);
document.querySelectorAll("#chips button").forEach((b) => {
  b.addEventListener("click", () => {
    filter = b.dataset.filter;
    document.querySelectorAll("#chips button").forEach((c) => c.setAttribute("aria-pressed", String(c === b)));
    renderWordList();
  });
});

// ---------- start ----------

fetch("data/words.json", { cache: "no-cache" })
  .then((r) => {
    if (!r.ok) throw new Error(r.status);
    return r.json();
  })
  .then((db) => {
    words = db.words;
    $("status").hidden = true;
    $("updated").textContent = `${words.length} words · last updated ${db.updated}`;
    renderProgress();
    startStudy();
    startQuiz();
    let view = "study";
    try { view = sessionStorage.getItem("satvocab.view") || view; } catch {}
    showView(views.includes(view) ? view : "study");
  })
  .catch(() => {
    $("status").textContent = "Couldn't load the word list. Please refresh the page.";
  });
