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

// Words a teacher added for one student carry this source.
export const TEACHER_SOURCE = "Added by your teacher";

// One student's words: the database minus words a teacher removed for them,
// plus words a teacher added (which replace a database entry of the same name).
export function wordsForStudent(dbWords, list) {
  const added = Object.values(list.added || {});
  const addedNames = new Set(added.map((w) => w.word));
  const removed = list.removed || {};
  return [...dbWords.filter((w) => !removed[w.word] && !addedNames.has(w.word)), ...added];
}
