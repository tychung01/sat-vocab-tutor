import { wordFinder } from "./questions.js";

// Loads the word database. The site is served from Firebase Hosting, but the
// monthly update commits new words to GitHub, so the GitHub copy is read first
// and the copy deployed with the site is the fallback.

const SOURCES = [
  "https://raw.githubusercontent.com/tychung01/sat-vocab-tutor/main/data/words.json",
  "data/words.json",
];

export async function loadWords() {
  for (const url of SOURCES) {
    try {
      const r = await fetch(url, { cache: "no-cache" });
      if (r.ok) return await r.json();
    } catch {
      // Try the next source.
    }
  }
  throw new Error("Couldn't load the word list");
}

// Words a teacher added, for one student or for all of them, carry this source.
export const TEACHER_SOURCE = "Added by your teacher";

// The words in list minus any that are the same word, in any form, as one in
// replacements ("abandoned" replaces "abandon"), followed by the replacements.
function replaceSameWords(list, replacements) {
  if (!replacements.length) return list;
  const find = wordFinder(replacements.map((w) => w.word));
  return [...list.filter((w) => !find(w.word)), ...replacements];
}

// The words every student gets: the database minus words a teacher removed for
// everyone (hidden, a list of words), plus words a teacher added for all students
// (which replace a database entry for the same word, in any form).
export function sharedWords(dbWords, classWords = [], hidden = []) {
  const hiddenNames = new Set(hidden);
  return replaceSameWords(dbWords.filter((w) => !hiddenNames.has(w.word)), classWords);
}

// One student's words: the shared words minus words a teacher removed for them,
// plus words a teacher added just for them (which replace a shared word for the
// same word, in any form). No student gets two forms of one word.
export function wordsForStudent(dbWords, list, classWords = [], hidden = []) {
  const removed = list.removed || {};
  const shared = sharedWords(dbWords, classWords, hidden).filter((w) => !removed[w.word]);
  return replaceSameWords(shared, Object.values(list.added || {}));
}
