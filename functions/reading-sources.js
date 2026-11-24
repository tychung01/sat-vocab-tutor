// SAT Reading: source texts for passages, from openly licensed works only.
//
// - Science and social science: research articles in PLOS journals, which are
//   published under the Creative Commons Attribution license (CC BY 4.0). Found
//   with PLOS's public search API (api.plos.org).
// - Literature, historical documents, and humanities: public-domain books from
//   Project Gutenberg, read from its official mirror (gutenberg.pglaf.org), as
//   Project Gutenberg asks programs to do.
//
// Each source is { key, origin, title, author, year, url, license, publisher, text }.
// `key` names the part of the work used, so a later batch can skip it.

const AGENT = { "User-Agent": "SAT-Reading-study-app/1.0" };

async function fetchText(url) {
  const res = await fetch(url, { headers: AGENT, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.arrayBuffer();
}

// ---------- Project Gutenberg ----------

// Public-domain works by subject. file is the mirror's file name; -8 files are Latin-1.
export const BOOKS = {
  Literature: [
    [1342, "Pride and Prejudice", "Jane Austen", 1813],
    [158, "Emma", "Jane Austen", 1815],
    [1260, "Jane Eyre", "Charlotte Brontë", 1847],
    [98, "A Tale of Two Cities", "Charles Dickens", 1859],
    [145, "Middlemarch", "George Eliot", 1871],
    [541, "The Age of Innocence", "Edith Wharton", 1920],
    [284, "The House of Mirth", "Edith Wharton", 1905],
    [160, "The Awakening", "Kate Chopin", 1899],
    [24, "O Pioneers!", "Willa Cather", 1913],
    [242, "My Ántonia", "Willa Cather", 1918],
    [64317, "The Great Gatsby", "F. Scott Fitzgerald", 1925],
    [174, "The Picture of Dorian Gray", "Oscar Wilde", 1890],
    [33, "The Scarlet Letter", "Nathaniel Hawthorne", 1850],
    [1952, "The Yellow Wallpaper", "Charlotte Perkins Gilman", 1892],
    [514, "Little Women", "Louisa May Alcott", 1868],
    [2814, "Dubliners", "James Joyce", 1914],
    [10376, "American Indian Stories", "Zitkála-Šá", 1921],
    [11228, "The Marrow of Tradition", "Charles W. Chesnutt", 1901],
    [7166, "The Home and the World", "Rabindranath Tagore", 1916, "7166-8.txt"],
  ],
  History: [
    [1404, "The Federalist Papers", "Alexander Hamilton, James Madison, and John Jay", 1788],
    [23, "Narrative of the Life of Frederick Douglass", "Frederick Douglass", 1845],
    [202, "My Bondage and My Freedom", "Frederick Douglass", 1855],
    [14721, "Speeches & Letters of Abraham Lincoln", "Abraham Lincoln", 1907],
    [147, "Common Sense", "Thomas Paine", 1776],
    [815, "Democracy in America, Volume 1", "Alexis de Tocqueville", 1835],
    [3420, "A Vindication of the Rights of Woman", "Mary Wollstonecraft", 1792, "3420.txt"],
    [71, "On the Duty of Civil Disobedience", "Henry David Thoreau", 1849],
    [408, "The Souls of Black Folk", "W. E. B. Du Bois", 1903],
    [2376, "Up from Slavery", "Booker T. Washington", 1901],
    [1325, "Twenty Years at Hull-House", "Jane Addams", 1910, "1325.txt"],
  ],
  Humanities: [
    [2944, "Essays, First Series", "Ralph Waldo Emerson", 1841],
    [205, "Walden", "Henry David Thoreau", 1854],
    [2398, "The Renaissance", "Walter Pater", 1873, "2398.txt"],
    [64457, "The Common Reader", "Virginia Woolf", 1925],
    [34901, "On Liberty", "John Stuart Mill", 1859],
    [32540, "My First Summer in the Sierra", "John Muir", 1911],
  ],
  // Classic science writing, used for some ACT natural science passages.
  Science: [
    [1228, "On the Origin of Species", "Charles Darwin", 1859],
    [944, "The Voyage of the Beagle", "Charles Darwin", 1839],
    [14474, "The Chemical History of a Candle", "Michael Faraday", 1861],
    [1408, "The Natural History of Selborne", "Gilbert White", 1789],
  ],
};

function mirrorUrl(id, file) {
  const s = String(id);
  const dirs = s.length === 1 ? "0" : s.slice(0, -1).split("").join("/");
  return `https://gutenberg.pglaf.org/${dirs}/${s}/${file || `${s}-0.txt`}`;
}

// A book's paragraphs, without Project Gutenberg's header and license.
export function bookParagraphs(raw) {
  let text = raw.replace(/\r/g, "");
  const start = text.search(/\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG/i);
  if (start >= 0) text = text.slice(text.indexOf("\n", start) + 1);
  const end = text.search(/\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG/i);
  if (end >= 0) text = text.slice(0, end);
  return text.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").replace(/_([^_]+)_/g, "$1").trim()).filter(Boolean);
}

// Ordinary prose, not a heading, illustration note, or table of contents line.
export function isProse(p) {
  const words = p.split(" ").length;
  if (words < 12) return false;
  if (/^\[(illustration|footnote|sidenote)/i.test(p)) return false;
  if (/^(chapter|book|part|letter|section|no\.)\s+[\divxlc]+\b/i.test(p) && words < 20) return false;
  const letters = p.replace(/[^A-Za-z]/g, "");
  return letters.length > 0 && letters.replace(/[^A-Z]/g, "").length / letters.length < 0.5;
}

// A run of consecutive prose paragraphs with min-max words, starting at a random
// paragraph, or null if none is found. Returns { start, text }.
export function excerpt(paragraphs, min, max, random = Math.random) {
  const from = Math.floor(paragraphs.length * 0.04);
  const to = Math.floor(paragraphs.length * 0.95);
  for (let tries = 0; tries < 40; tries++) {
    const start = from + Math.floor(random() * Math.max(1, to - from));
    const picked = [];
    let words = 0;
    for (let i = start; i < paragraphs.length && words < min; i++) {
      if (!isProse(paragraphs[i])) break;
      picked.push(paragraphs[i]);
      words += paragraphs[i].split(" ").length;
    }
    if (words >= min && words <= max) return { start, text: picked.join("\n\n") };
  }
  return null;
}

const bookCache = new Map();

async function loadBook(id, file) {
  if (!bookCache.has(id)) {
    const buffer = await fetchText(mirrorUrl(id, file));
    const raw = new TextDecoder(file?.endsWith("-8.txt") ? "latin1" : "utf-8").decode(buffer);
    bookCache.set(id, bookParagraphs(raw));
  }
  return bookCache.get(id);
}

// Short passages come from 180-450 words of the book; long ones from 750-1300.
const LENGTHS = { short: [180, 450], long: [750, 1300] };

export async function gutenbergSource(subject, length, used, random = Math.random) {
  const books = BOOKS[subject];
  for (let tries = 0; tries < 6; tries++) {
    const [id, title, author, year, file] = books[Math.floor(random() * books.length)];
    let paragraphs;
    try {
      paragraphs = await loadBook(id, file);
    } catch (err) {
      console.warn("Couldn't load book", id, err.message);
      continue;
    }
    const [min, max] = LENGTHS[length];
    const found = excerpt(paragraphs, min, max, random);
    if (!found) continue;
    // Parts of a book 20 paragraphs apart count as different sources.
    const key = `gutenberg:${id}:${Math.floor(found.start / 20)}`;
    if (used.has(key)) continue;
    used.add(key);
    return {
      key, origin: "gutenberg", title, author, year, url: `https://www.gutenberg.org/ebooks/${id}`,
      license: "Public domain", publisher: "Project Gutenberg", text: found.text,
    };
  }
  return null;
}

// ---------- PLOS ----------

export const PLOS_TOPICS = {
  Science: ["Ecology", "Marine biology", "Astronomy", "Geology", "Paleontology", "Animal behavior", "Plant science",
    "Evolutionary biology", "Microbiology", "Entomology", "Ornithology", "Oceanography", "Climatology", "Neuroscience",
    "Zoology", "Botany", "Volcanology", "Biogeography"],
  "Social science": ["Psychology", "Sociology", "Economics", "Linguistics", "Anthropology", "Archaeology", "Political science",
    "Cognitive psychology", "Social psychology", "Behavioral economics", "Human geography", "Music cognition", "Education"],
};

// PLOS full text runs paragraphs together ("scarce.Previous"); citations look like
// [4,5] or [e.g. 17], and removing them can leave "ants,." behind.
export function cleanPlos(text) {
  return String(text || "")
    .replace(/\s*\[[^\]]*\d[^\]]*\]/g, "")
    .replace(/\s*\((?:Figs?|Tables?|S\d+ (?:Fig|Table))\.? ?[\dA-Z,–\- ]*\)/g, "")
    .replace(/,\s*(?=[.,;:])/g, "")
    .replace(/([a-z0-9)%])\.([A-Z])/g, "$1.\n\n$2")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Numbers a data question can use: not years or citation-like single digits.
const dataNumbers = (text) => (text.match(/\b\d+(?:[.,]\d+)*%?/g) || []).filter((n) => !/^(1[89]|20)\d\d$/.test(n) && !/^\d$/.test(n));

function plosText(doc, length, needs) {
  if (length === "short") {
    const abstract = cleanPlos([].concat(doc.abstract || []).join(" "));
    const words = abstract.split(/\s+/).length;
    if (needs === "numbers" && dataNumbers(abstract).length < 4) return null;
    return words >= 120 && words <= 450 ? abstract : null;
  }
  const intro = cleanPlos([].concat(doc.introduction || []).join(" "));
  const paragraphs = intro.split(/\n\n/);
  const picked = [];
  let words = 0;
  for (const p of paragraphs) {
    if (words >= 950) break;
    picked.push(p);
    words += p.split(/\s+/).length;
  }
  return words >= 750 ? picked.join("\n\n") : null;
}

export async function plosSource(subject, length, used, random = Math.random, needs = "") {
  const topics = PLOS_TOPICS[subject];
  for (let tries = 0; tries < 5; tries++) {
    const topic = topics[Math.floor(random() * topics.length)];
    const params = new URLSearchParams({
      q: `subject:"${topic}"`,
      fq: 'doc_type:full AND article_type_facet:"Research Article"',
      fl: "id,title_display,journal,author_display,publication_date,abstract,introduction",
      rows: "20",
      start: String(Math.floor(random() * 400)),
      wt: "json",
    });
    let docs;
    try {
      const body = JSON.parse(new TextDecoder().decode(await fetchText(`https://api.plos.org/search?${params}`)));
      docs = body.response?.docs || [];
    } catch (err) {
      console.warn("PLOS search failed", topic, err.message);
      continue;
    }
    for (const doc of docs) {
      const key = `plos:${doc.id}`;
      // Retracted articles aren't sound sources.
      if (used.has(key) || /retract/i.test(String(doc.title_display))) continue;
      const text = plosText(doc, length, needs);
      if (!text) continue;
      used.add(key);
      const authors = doc.author_display || [];
      return {
        key, origin: "plos",
        title: String(doc.title_display || "").replace(/<[^>]+>/g, ""),
        author: authors.length > 2 ? `${authors[0]} and others` : authors.join(" and "),
        year: String(doc.publication_date || "").slice(0, 4),
        url: `https://doi.org/${doc.id}`, license: "CC BY 4.0", publisher: doc.journal || "PLOS", text,
      };
    }
  }
  return null;
}

// ---------- picking a source for an item ----------

// SAT-style science and social science passages come from PLOS. ACT natural
// science passages come mostly from PLOS, sometimes from classic science books;
// ACT social science passages come from PLOS. History, literature, and humanities
// come from Project Gutenberg.
// Data questions need an abstract with numbers in it. Cross-text questions need two
// views, which an article's introduction (reviewing earlier work) or a longer
// stretch of a book has more often than an abstract, so they get a long source.
export async function findSource(item, used, random = Math.random) {
  const length = item.kind === "set" || item.type === "cross_text" ? "long" : "short";
  const needs = item.type === "evidence_table" ? "numbers" : "";
  const fromPlos = item.subject === "Social science" || (item.subject === "Science" && (item.kind === "short" || random() < 0.7));
  if (fromPlos) return (await plosSource(item.subject, length, used, random, needs)) || (item.subject === "Science" && !needs ? gutenbergSource("Science", length, used, random) : null);
  return gutenbergSource(item.subject, length, used, random);
}
