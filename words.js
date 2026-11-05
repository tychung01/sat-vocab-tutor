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
