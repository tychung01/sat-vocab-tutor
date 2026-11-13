// SAT Word Study: flashcards, quizzes, and a word list built from data/words.json.
// Students sign in with Google. Each word is Learned (answered correctly in
// LEARNED_STREAK quizzes in a row), Practice (the student's current list, at most
// PRACTICE_LIMIT words), or Upcoming (waiting for room in the practice list).
// Progress is saved to Firestore so the teacher dashboard can see it.
// Each finished flashcard set is followed by a required quiz on its words, and
// every REVIEW_EVERY words studied by a required review quiz on all of them. The
// student needs a perfect score to move on to the next set.
// Each student picks a unique user name and a picture the first time they sign
// in. The leaderboard ranks students by study streak (days in a row finishing a
// flashcard set) and by words learned, showing only user names and pictures.

import {
  configured, isTeacher, watchUser, signIn, signOutUser, recordLogin,
  loadProgress, saveWordProgress, saveStudyState, loadWordList, loadClassWords, loadHiddenWords,
  loadProfile, isUsernameTaken, createProfile, saveProfile, listProfiles, localDay,
  LEARNED_STREAK, PRACTICE_LIMIT,
} from "./firebase.js";
import { AVATARS, USERNAME_PATTERN, avatarHtml, photoFromFile } from "./avatars.js";
import { loadWords, wordsForStudent, TEACHER_SOURCE } from "./words.js";
import { buildQuestion, shuffle, escapeHtml } from "./questions.js";
import { fireworks } from "./fireworks.js";

const SET_SIZE = 10;
const REVIEW_PER_QUIZ = 2;
const REVIEW_EVERY = 50;
const LEARNED_REVIEW_SIZE = 20;
// Scores above this percentage get a congratulation.
const CHEER_PERCENT = 80;

let dbWords = [];
let dbUpdated = "";
let words = [];
let user = null;
let progress = {};
// The student's public profile: { username, photo, setStreak, lastSetDay, learned }.
let profile = null;
// Words from finished flashcard sets since the last review quiz.
let studied = [];
// The quiz the student must pass with a perfect score before the next set:
// { mode: "set" | "review", words: [...] }, or null.
let required = null;
let practiceSet = new Set();

const $ = (id) => document.getElementById(id);

// ---------- progress ----------

function isLearned(word) {
  const p = progress[word];
  return Boolean(p && p.streak >= LEARNED_STREAK);
}

function categoryOf(word) {
  if (isLearned(word)) return "learned";
  return practiceSet.has(word) ? "practice" : "upcoming";
}

// Small stable hash so words added on the same day aren't introduced alphabetically.
function hashWord(word) {
  let h = 0;
  for (const c of word) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}

// Order in which untried words join a practice list: words the teacher added
// first, then oldest additions first, practice-test words before word-list
// words before curated words.
function introOrder(a, b) {
  const rank = (w) => (isOfficial(w) ? 0 : isAcademic(w) ? 1 : 2);
  return isTeacherWord(b) - isTeacherWord(a)
    || a.added.localeCompare(b.added) || rank(a) - rank(b) || hashWord(a.word) - hashWord(b.word);
}

// The practice list: every word the student has tried but not learned, then
// untried words in introduction order, up to PRACTICE_LIMIT.
function rebuildPracticeSet() {
  const notLearned = words.filter((w) => !isLearned(w.word));
  const tried = notLearned.filter((w) => progress[w.word]);
  const untried = notLearned.filter((w) => !progress[w.word]).sort(introOrder);
  practiceSet = new Set([...tried, ...untried].slice(0, PRACTICE_LIMIT).map((w) => w.word));
}

function record(word, correct) {
  const p = progress[word] || { streak: 0, correct: 0, wrong: 0 };
  const next = {
    streak: correct ? p.streak + 1 : 0,
    correct: p.correct + (correct ? 1 : 0),
    wrong: p.wrong + (correct ? 0 : 1),
    last: Date.now(),
  };
  const wasLearned = isLearned(word);
  progress[word] = next;
  if (wasLearned !== isLearned(word)) {
    rebuildPracticeSet();
    saveProfileChanges({ learned: learnedCount() });
  }
  renderProgress();
  saveWordProgress(user.uid, word, next).catch(() => {
    $("status").textContent = "Couldn't save your progress. Check your connection; your answers will save when it's back.";
    $("status").hidden = false;
  });
  return { becameLearned: !wasLearned && isLearned(word), lostLearned: wasLearned && !correct };
}

function learnedCount() {
  return words.filter((w) => isLearned(w.word)).length;
}

function renderStatus(learned) {
  const streak = currentStreak(profile);
  $("student-status").innerHTML = (streak
    ? `<span title="Days in a row finishing a set of flashcards">🔥 <b>${streak}</b> day${streak === 1 ? "" : "s"} in a row</span>` : "") +
    `<span>⭐ <b>${learned}</b> word${learned === 1 ? "" : "s"} learned</span>`;
  $("student-status").hidden = false;
}

function renderProgress() {
  const learned = learnedCount();
  renderStatus(learned);
  const upcoming = words.length - learned - practiceSet.size;
  $("progress").innerHTML =
    `<span><b>${practiceSet.size}</b> practice</span>` +
    (upcoming > 0 ? `<span><b>${upcoming}</b> more unlock as you learn</span>` : "") +
    `<span class="bar" aria-hidden="true"><span style="width:${(learned / words.length) * 100}%"></span></span>`;
}

// ---------- helpers ----------

function isOfficial(w) {
  return w.sources.some((s) => s.includes("Practice Test"));
}

function isAcademic(w) {
  return w.sources.some((s) => s.includes("Word List"));
}

function isTeacherWord(w) {
  return w.sources.includes(TEACHER_SOURCE);
}

// Practice words in study order: new words from the teacher, then words in
// progress (closest to learned first), then recently missed words, then words never tried.
function practiceQueue() {
  const practice = words.filter((w) => categoryOf(w.word) === "practice");
  const tried = practice.filter((w) => progress[w.word]);
  const fresh = practice.filter((w) => !progress[w.word]);
  tried.sort((a, b) => progress[b.word].streak - progress[a.word].streak || progress[b.word].last - progress[a.word].last);
  return [...shuffle(fresh.filter(isTeacherWord)), ...tried, ...shuffle(fresh.filter((w) => !isTeacherWord(w)))];
}

function streakText(word) {
  const p = progress[word];
  if (!p) return "";
  if (p.streak >= LEARNED_STREAK) return "Learned";
  return `This word: ${p.streak} of ${LEARNED_STREAK} correct in a row`;
}

// ---------- tabs ----------

const views = ["study", "quiz", "review", "words", "leaders", "about"];
let reviewStarted = false;

function showView(name) {
  // Lets the stylesheet adjust the header for a tab (the quiz tabs hide the status row).
  document.body.dataset.view = name;
  views.forEach((v) => {
    $(`view-${v}`).hidden = v !== name;
  });
  document.querySelectorAll(".tabs button").forEach((b) => {
    b.setAttribute("aria-selected", String(b.dataset.view === name));
  });
  try { sessionStorage.setItem("satvocab.view", name); } catch {}
  if (name === "words") renderWordList();
  if (name === "leaders") renderLeaderboard();
  // Start a review quiz on first visit, or when there were no learned words before.
  if (name === "review" && (!reviewStarted || !$("review-empty").hidden)) {
    reviewStarted = true;
    startLearnedReview();
  }
}

document.querySelectorAll(".tabs button").forEach((b) => {
  b.addEventListener("click", () => showView(b.dataset.view));
});

// ---------- flashcards ----------

let deck = [];
let deckIndex = 0;

// The next flashcard set: new words first (the teacher's first), then words in progress.
function nextSet() {
  const queue = practiceQueue();
  return [...queue.filter((w) => !progress[w.word]), ...queue.filter((w) => progress[w.word])].slice(0, SET_SIZE);
}

function startStudy() {
  // Until the required quiz is passed, the cards are its words.
  deck = shuffle(required ? requiredWords() : nextSet());
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
  $("study-counter").textContent = `${required ? "Review card" : "Card"} ${deckIndex + 1} of ${deck.length}` + (progress[w.word] ? ` · ${streakText(w.word)}` : "");
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
    finishSet();
  }
});

// A new set counts toward the next review and must be passed in a quiz.
function finishSet() {
  recordSetFinished();
  if (!required) {
    studied = [...new Set([...studied, ...deck.map((w) => w.word)])];
    required = { mode: "set", words: deck.map((w) => w.word) };
    saveStudy();
  }
  startRequiredQuiz();
  document.querySelector(".card-stage").hidden = true;
  $("study-done").hidden = false;
  const count = requiredWords().length;
  $("study-done-text").textContent = required.mode === "review"
    ? `Time for the ${REVIEW_EVERY}-word review quiz. You need ${count} out of ${count} to move on to the next set.`
    : `Now take a quiz on these ${count} words. You need ${count} out of ${count} to move on to the next set.`;
  $("study-quiz").textContent = required.mode === "review" ? "Take the review quiz" : "Take the quiz";
  $("study-quiz").focus();
}

$("study-again").addEventListener("click", startStudy);
$("study-quiz").addEventListener("click", () => {
  // After a finished attempt, start a new one.
  if (mainQuiz.isFinished()) startRequiredQuiz();
  showView("quiz");
});

// ---------- quiz ----------

let quizMode = "practice";

// The questions asked about each word, so a retake asks it a different way.
const asked = {};

function questionFor(target) {
  const history = asked[target.word] || (asked[target.word] = []);
  const q = buildQuestion(target, words, history);
  // Once every question has been asked, start the cycle again from this one.
  if (history.includes(q.key)) history.length = 0;
  history.push(q.key);
  return q;
}

// Mostly practice words, plus a couple of learned words to check they've stuck.
function pickQuizWords() {
  const learned = shuffle(words.filter((w) => categoryOf(w.word) === "learned")).slice(0, REVIEW_PER_QUIZ);
  const practice = practiceQueue().slice(0, SET_SIZE - learned.length);
  return shuffle([...practice, ...learned]);
}

const QUIZ_TITLES = { practice: "", set: "Set quiz · ", review: `${REVIEW_EVERY}-word review · ` };

// The studied words still on the student's list (a teacher may have removed some).
function studiedWords() {
  const names = new Set(studied);
  return words.filter((w) => names.has(w.word));
}

function reviewReady() {
  return studiedWords().length >= REVIEW_EVERY;
}

// The required words still on the student's list.
function requiredWords() {
  const names = new Set(required ? required.words : []);
  return words.filter((w) => names.has(w.word));
}

// Once nothing else is required, a due review becomes the required quiz.
function requireReviewIfDue() {
  if (required && !requiredWords().length) required = null;
  if (!required && reviewReady()) {
    required = { mode: "review", words: studiedWords().slice(0, REVIEW_EVERY).map((w) => w.word) };
  }
}

function saveStudy() {
  saveStudyState(user.uid, { studied, required }).catch(() => {
    $("status").textContent = "Couldn't save your progress. Check your connection; your answers will save when it's back.";
    $("status").hidden = false;
  });
}

// Each attempt is a new quiz: new question order, question types, and answer choices.
function startRequiredQuiz() {
  startQuiz(requiredWords(), required.mode);
}

// A quiz shown in one view's markup. onDone(result) fills in that view's next steps.
function makeQuiz(root, onDone) {
  const el = (name) => root.querySelector(`.quiz-${name}`);
  let questions = [];
  let index = 0;
  let missed = [];
  let newlyLearned = [];
  let title = "";
  // Questions answered correctly in a row in this quiz.
  let run = 0;

  function show() {
    const q = questions[index];
    el("counter").textContent = `${title}Question ${index + 1} of ${questions.length}`;
    el("prompt").innerHTML = q.prompt;
    el("q").textContent = q.question;
    el("feedback").hidden = true;
    el("next").hidden = true;
    el("choices").innerHTML = "";
    q.choices.forEach((choice, i) => {
      const b = document.createElement("button");
      b.className = "choice";
      b.innerHTML = `<span class="letter">${"ABCD"[i]})</span><span>${escapeHtml(choice.text)}</span>`;
      b.addEventListener("click", () => answer(choice, b));
      el("choices").appendChild(b);
    });
  }

  function answer(choice, button) {
    const q = questions[index];
    const right = choice.correct;
    [...el("choices").children].forEach((b, i) => {
      b.disabled = true;
      if (q.choices[i].correct) b.classList.add("correct");
    });
    if (!right) {
      button.classList.add("wrong");
      missed.push(q.target);
    }
    run = right ? run + 1 : 0;
    const { becameLearned, lostLearned } = record(q.target.word, right);
    if (becameLearned) newlyLearned.push(q.target.word);

    const t = q.target;
    let html = `<p><strong>${right ? "Correct!" : "Not quite."}</strong> <strong>${escapeHtml(t.word)}</strong> (${escapeHtml(t.part_of_speech)}): ${escapeHtml(t.definition)}</p>`;
    if (!right) {
      html += `<p>You chose <strong>${escapeHtml(choice.text)}</strong>${choice.note ? `, which means: ${escapeHtml(choice.note)}` : ""}.</p>`;
    }
    if (t.usage) html += `<p>${escapeHtml(t.usage)}</p>`;
    if (becameLearned) html += `<p class="win">🎉 <strong>${escapeHtml(t.word)}</strong> moved to Learned!</p>`;
    if (lostLearned) html += `<p>This word moved back to Practice. Get it right ${LEARNED_STREAK} times in a row to learn it again.</p>`;
    html += `<p class="streak">${run ? "🔥 " : ""}${run} of ${index + 1} correct in a row</p>`;
    el("feedback").innerHTML = html;
    el("feedback").hidden = false;
    el("next").hidden = false;
    el("next").textContent = index + 1 < questions.length ? "Next" : "See results";
    el("next").focus();
  }

  el("next").addEventListener("click", () => {
    index++;
    if (index < questions.length) {
      show();
      return;
    }
    el("question").hidden = true;
    el("done").hidden = false;
    const total = questions.length;
    const score = total - missed.length;
    const percent = Math.round((score / total) * 100);
    el("score").textContent = `You scored ${score} out of ${total} (${percent}%)`;
    el("cheer").textContent = "🎉 Congratulations! Great work on this quiz.";
    el("cheer").hidden = percent <= CHEER_PERCENT;
    el("learned").textContent = newlyLearned.length ? `New words learned: ${newlyLearned.join(", ")}.` : "";
    el("missed").innerHTML = missed.length
      ? `<h3>Review these words</h3>` + missed.map(entryHtml).join("")
      : "<p>Perfect score!</p>";
    if (score === total) fireworks();
    onDone({ total, score, percent, perfect: score === total, targets: questions.map((q) => q.target), cheer: el("cheer") });
  });

  return {
    // Each start is a new quiz: new question order, question types, and answer choices.
    start(targets, quizTitle = "") {
      title = quizTitle;
      questions = shuffle(targets).map(questionFor);
      index = 0;
      run = 0;
      missed = [];
      newlyLearned = [];
      el("done").hidden = true;
      el("question").hidden = false;
      show();
    },
    hide() {
      el("done").hidden = true;
      el("question").hidden = true;
    },
    isFinished: () => !el("done").hidden,
  };
}

const mainQuiz = makeQuiz($("view-quiz"), finishMainQuiz);

// mode is "practice" (the Quiz tab), "set" (the flashcard set just studied), or "review".
function startQuiz(targets = pickQuizWords(), mode = "practice") {
  quizMode = mode;
  mainQuiz.start(targets, QUIZ_TITLES[mode]);
}

function finishMainQuiz({ total, percent, perfect, targets, cheer }) {
  const mustPass = quizMode !== "practice";
  if (mustPass && !perfect) cheer.textContent = `🎉 Congratulations on ${percent}%! Get every answer right to move on.`;
  else if (quizMode === "review") cheer.textContent = `🎉 Congratulations! You remembered all ${total} words you studied.`;

  let nextStep = "";
  if (mustPass && perfect) {
    if (quizMode === "review") {
      // The review covered these words; start counting toward the next one.
      const reviewed = new Set(targets.map((w) => w.word));
      studied = studied.filter((w) => !reviewed.has(w));
    }
    required = null;
    requireReviewIfDue();
    saveStudy();
    startStudy();
    nextStep = required
      ? `You passed! You've now studied ${REVIEW_EVERY} words, so next is a review quiz on all of them. You need ${REVIEW_EVERY} out of ${REVIEW_EVERY} to move on.`
      : "You passed! You're ready for the next set.";
  } else if (mustPass) {
    nextStep = `You need ${total} out of ${total} to move on. Go through the cards again or retake the quiz. You'll get new questions each time.`;
  }
  $("quiz-next-step").textContent = nextStep;
  $("quiz-next-step").hidden = !nextStep;
  $("quiz-retake").textContent = mustPass && perfect ? "Take the review quiz" : "Retake the quiz";
  $("quiz-retake").hidden = !required;
  $("quiz-cards").hidden = !required;
  $("quiz-study").hidden = Boolean(required);
  $("quiz-again").hidden = Boolean(required);
}

$("quiz-again").addEventListener("click", () => startQuiz());
$("quiz-retake").addEventListener("click", startRequiredQuiz);
$("quiz-cards").addEventListener("click", () => {
  startStudy();
  showView("study");
});
$("quiz-study").addEventListener("click", () => {
  startStudy();
  showView("study");
});

// ---------- review words ----------

// The Review words tab quizzes a random sample of learned words. Missing one
// moves it back to Practice.
const reviewQuiz = makeQuiz($("view-review"), ({ perfect }) => {
  $("review-missed-note").hidden = perfect;
});

function startLearnedReview() {
  const learned = words.filter((w) => isLearned(w.word));
  $("review-empty").hidden = learned.length > 0;
  if (!learned.length) {
    reviewQuiz.hide();
    return;
  }
  reviewQuiz.start(shuffle(learned).slice(0, LEARNED_REVIEW_SIZE), "Review · ");
}

$("review-again").addEventListener("click", startLearnedReview);
$("review-study").addEventListener("click", () => {
  startStudy();
  showView("study");
});

// ---------- word list ----------

let filter = "practice";
let sourceFilter = "any";

function entryHtml(w) {
  const category = categoryOf(w.word);
  const badge = category === "learned"
    ? `<span class="badge learned">Learned</span>`
    : category === "upcoming" ? `<span class="badge upcoming">Later</span>`
    : progress[w.word] ? `<span class="badge practice">${progress[w.word].streak}/${LEARNED_STREAK}</span>` : "";
  return `<details class="entry">
    <summary><span class="w">${escapeHtml(w.word)}</span>${badge}<span class="d">${escapeHtml(w.definition)}</span></summary>
    <div class="body">
      <p><em>${escapeHtml(w.part_of_speech)}</em></p>
      ${w.usage ? `<p>${escapeHtml(w.usage)}</p>` : ""}
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
    if (sourceFilter === "teacher" && !isTeacherWord(w)) return false;
    if (sourceFilter === "curated" && (isOfficial(w) || isAcademic(w) || isTeacherWord(w))) return false;
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

// ---------- profile ----------

function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return localDay(d);
}

// A streak still counts if its last set was finished today or yesterday.
function currentStreak(p) {
  return p && (p.lastSetDay === localDay(new Date()) || p.lastSetDay === yesterday()) ? p.setStreak : 0;
}

function saveProfileChanges(changes) {
  if (!profile) return;
  Object.assign(profile, changes);
  saveProfile(user.uid, changes).catch(() => {
    $("status").textContent = "Couldn't save your progress. Check your connection; your answers will save when it's back.";
    $("status").hidden = false;
  });
}

// Finishing a set of flashcards adds a day to the streak, once a day.
function recordSetFinished() {
  if (!profile) return;
  const today = localDay(new Date());
  if (profile.lastSetDay === today) return;
  saveProfileChanges({ setStreak: profile.lastSetDay === yesterday() ? profile.setStreak + 1 : 1, lastSetDay: today });
  renderProgress();
}

function renderWho() {
  $("who").innerHTML = profile
    ? `${avatarHtml(profile, 28)}<span>${escapeHtml(profile.username)}</span>`
    : escapeHtml(user.displayName || user.email);
}

// The profile dialog creates the profile the first time and changes the picture after that.
let profileFirstTime = false;
let profileCreated = null;
let chosenPhoto = "";
let uploadedPhoto = "";

function showProfileError(message) {
  $("profile-error").textContent = message;
  $("profile-error").hidden = !message;
}

function renderAvatarGrid() {
  const options = [
    ...AVATARS.map(([id, label]) => ({ photo: `avatar:${id}`, label })),
    ...(uploadedPhoto ? [{ photo: uploadedPhoto, label: "Your photo" }] : []),
  ];
  $("avatar-grid").innerHTML = options.map((o, i) =>
    `<button type="button" class="avatar-option" data-index="${i}" aria-pressed="${o.photo === chosenPhoto}" aria-label="${escapeHtml(o.label)}">${avatarHtml(o, 56)}</button>`).join("")
    + `<button type="button" class="avatar-option upload" id="profile-upload">Upload a photo</button>`;
  $("avatar-grid").querySelectorAll("[data-index]").forEach((b) => b.addEventListener("click", () => {
    chosenPhoto = options[b.dataset.index].photo;
    renderAvatarGrid();
  }));
  $("profile-upload").addEventListener("click", () => $("profile-file").click());
}

function openProfileDialog(firstTime) {
  profileFirstTime = firstTime;
  $("profile-title").textContent = firstTime ? "Create your profile" : "Change your picture";
  $("profile-intro").hidden = !firstTime;
  $("profile-username").value = profile?.username || "";
  $("profile-username").disabled = !firstTime;
  $("profile-username-help").textContent = firstTime
    ? "3 to 20 letters, numbers, or underscores (_). You can't change it later, but your teacher can."
    : "To change your user name, ask your teacher.";
  $("profile-cancel").textContent = firstTime ? "Sign out" : "Cancel";
  chosenPhoto = profile?.photo || `avatar:${AVATARS[Math.floor(Math.random() * AVATARS.length)][0]}`;
  uploadedPhoto = chosenPhoto.startsWith("data:") ? chosenPhoto : "";
  showProfileError("");
  renderAvatarGrid();
  $("profile-dialog").showModal();
}

$("who").addEventListener("click", () => {
  if (profile) openProfileDialog(false);
});

// The first time, the dialog stays open until the profile is saved.
$("profile-dialog").addEventListener("cancel", (e) => {
  if (profileFirstTime) e.preventDefault();
});

$("profile-cancel").addEventListener("click", () => {
  $("profile-dialog").close();
  if (profileFirstTime) signOutUser();
});

$("profile-file").addEventListener("change", async () => {
  const file = $("profile-file").files[0];
  $("profile-file").value = "";
  if (!file) return;
  showProfileError("");
  try {
    uploadedPhoto = chosenPhoto = await photoFromFile(file);
    renderAvatarGrid();
  } catch (err) {
    showProfileError(err.message === "too-big"
      ? "That picture is too large. Try a smaller one."
      : "Couldn't open that picture. Try a JPEG or PNG photo.");
  }
});

$("profile-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  showProfileError("");
  const button = $("profile-save");
  if (!profileFirstTime) {
    button.disabled = true;
    try {
      await saveProfile(user.uid, { photo: chosenPhoto });
      profile.photo = chosenPhoto;
    } catch {
      showProfileError("Couldn't save your picture. Please try again.");
      return;
    } finally {
      button.disabled = false;
    }
    $("profile-dialog").close();
    renderWho();
    return;
  }
  const username = $("profile-username").value.trim();
  if (!USERNAME_PATTERN.test(username)) {
    showProfileError("Use 3 to 20 letters, numbers, or underscores (_), with no spaces.");
    return;
  }
  const taken = `"${username}" is already taken. Try a different user name.`;
  button.disabled = true;
  try {
    if (await isUsernameTaken(username)) {
      showProfileError(taken);
      return;
    }
    const created = { username, photo: chosenPhoto, setStreak: 0, lastSetDay: "", learned: learnedCount() };
    await createProfile(user.uid, created);
    profile = created;
  } catch (err) {
    // Someone may have taken the name since the check.
    showProfileError(err?.code === "permission-denied" ? taken : "Couldn't save your profile. Please try again.");
    return;
  } finally {
    button.disabled = false;
  }
  $("profile-dialog").close();
  profileCreated?.();
});

// ---------- leaderboard ----------

const BOARD_SIZE = 10;

async function renderLeaderboard() {
  $("leaders-status").textContent = "Loading the leaderboard…";
  $("leaders-status").hidden = false;
  let profiles;
  try {
    profiles = await listProfiles();
  } catch {
    $("leaders-status").textContent = "Couldn't load the leaderboard. Please try again later.";
    return;
  }
  $("leaders-status").hidden = true;
  // Show this student's latest numbers, even if a save hasn't reached the server yet.
  const mine = profiles.find((p) => p.uid === user.uid);
  if (mine && profile) Object.assign(mine, profile);
  renderBoard("streak-board", profiles.map((p) => ({ ...p, value: currentStreak(p) })),
    "day", "days", "No streaks yet. Finish a set of flashcards to start one.");
  renderBoard("learned-board", profiles.map((p) => ({ ...p, value: p.learned })),
    "word", "words", "No words learned yet.");
}

// The top students, plus this student's own place if they're further down.
function renderBoard(id, rows, one, many, empty) {
  const ranked = rows.filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value || a.username.localeCompare(b.username));
  // Tied students share a rank.
  ranked.forEach((r, i) => { r.rank = i && r.value === ranked[i - 1].value ? ranked[i - 1].rank : i + 1; });
  const top = ranked.slice(0, BOARD_SIZE);
  const me = ranked.find((r) => r.uid === user.uid);
  const rowHtml = (r) => `<li${r.uid === user.uid ? ' class="me"' : ""}>
    <span class="rank">${r.rank}</span>${avatarHtml(r, 36)}
    <span class="name">${escapeHtml(r.username)}${r.uid === user.uid ? ' <span class="muted">(you)</span>' : ""}</span>
    <span class="value"><b>${r.value}</b> ${r.value === 1 ? one : many}</span></li>`;
  $(id).innerHTML = top.length
    ? top.map(rowHtml).join("") + (me && !top.includes(me) ? `<li class="gap" aria-hidden="true">⋯</li>${rowHtml(me)}` : "")
    : `<li class="muted empty">${empty}</li>`;
}

// ---------- sign-in and start ----------

function showSignedOut() {
  user = null;
  $("account").hidden = true;
  $("tabs").hidden = true;
  $("progress").innerHTML = "";
  $("student-status").hidden = true;
  profile = null;
  if ($("profile-dialog").open) $("profile-dialog").close();
  reviewStarted = false;
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
  $("admin-link").hidden = true;
  isTeacher(user).then((teacher) => { $("admin-link").hidden = !teacher; });
  $("account").hidden = false;

  // Recording the login is also the access check: a student who hasn't been invited can't.
  const login = recordLogin(user).then((streak) => ({ streak }), (error) => ({ error }));
  try {
    // Without the teacher's changes the student still gets the full database.
    const [saved, list, classWords, hidden, savedProfile, { error }] = await Promise.all([
      loadProgress(user.uid),
      loadWordList(user.uid).catch(() => ({})),
      loadClassWords().catch(() => []),
      loadHiddenWords().catch(() => []),
      loadProfile(user.uid),
      login,
    ]);
    if (error?.code === "permission-denied") throw error;
    profile = savedProfile;
    progress = saved.words;
    studied = saved.studied;
    required = saved.required;
    words = wordsForStudent(dbWords, list, classWords, hidden.map((h) => h.word));
  } catch (err) {
    // Not invited yet, or a teacher took this account's access away.
    $("status").textContent = err?.code === "permission-denied"
      ? `${user.email} doesn't have access to SAT Word Study. Ask your teacher to invite this email address, then sign in again. If your teacher invited a different address, sign out and sign in with that one.`
      : "Couldn't load your progress. Please refresh the page.";
    return;
  }
  if (!profile) {
    $("status").textContent = "Create your profile to start studying.";
    await new Promise((resolve) => {
      profileCreated = resolve;
      openProfileDialog(true);
    });
  } else if (profile.learned !== learnedCount()) {
    // A teacher may have added or removed words since the last visit.
    saveProfileChanges({ learned: learnedCount() });
  }
  renderWho();
  showWordCount();
  $("source-teacher").hidden = !words.some(isTeacherWord);
  rebuildPracticeSet();
  $("status").hidden = true;
  $("tabs").hidden = false;
  renderProgress();
  requireReviewIfDue();
  startStudy();
  if (required) startRequiredQuiz();
  else startQuiz();
  let view = "study";
  try { view = sessionStorage.getItem("satvocab.view") || view; } catch {}
  showView(views.includes(view) ? view : "study");
}

$("sign-in-button").addEventListener("click", () => {
  $("sign-in-error").hidden = true;
  signIn().catch((err) => {
    console.error("Sign-in failed", err);
    if (err.code === "auth/popup-closed-by-user" || err.code === "auth/cancelled-popup-request") return;
    const hint = err.code === "auth/popup-blocked"
      ? "Your browser blocked the sign-in pop-up. Allow pop-ups for this site and try again."
      : "Sign-in didn't work. Please try again.";
    $("sign-in-error").textContent = `${hint} (${err.code || err.message})`;
    $("sign-in-error").hidden = false;
  });
});

$("sign-out").addEventListener("click", () => signOutUser());

function showWordCount() {
  $("updated").textContent = `${words.length} words · word list updated ${dbUpdated}`;
}

async function start() {
  try {
    const db = await loadWords();
    dbWords = words = db.words;
    dbUpdated = db.updated;
    showWordCount();
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
