// Quiz questions in the two Words in Context formats of the official SAT
// Reading and Writing section:
//   - a text with a blank: "Which choice completes the text with the most
//     logical and precise word or phrase?" Choices are words in the form the
//     blank needs ("attached", "collected", ...).
//   - a text using the word: "As used in the text, what does the word "..."
//     most nearly mean?" Choices are short meanings ("Stretching toward").
// Words in the database have written passages and wrong choices for both
// (their "sat" field; see scripts/add_sat_questions.py). A teacher's word may
// have written choices for one or both formats, with its example sentence as
// the passage. Any format without written choices is built from the example
// sentence, with wrong choices picked from other words of the same part of
// speech whose definitions don't overlap with the answer's.
//
// A question is { key, kind, target, prompt (HTML), question, choices }, where
// kind is "complete", "meaning", or "define", and each choice is
// { text, correct, note } (note, if any, explains a wrong choice). Choices
// are always shuffled.

export function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const COMPLETE = "Which choice completes the text with the most logical and precise word or phrase?";
const BLANK = '<span class="blank" role="img" aria-label="blank"></span>';

function meanQuestion(word, form) {
  return `As used in the text, what does the ${word.includes(" ") ? "phrase" : "word"} “${form}” most nearly mean?`;
}

function mainPos(w) {
  return w.part_of_speech.split("/")[0].trim();
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Find the word (or an inflected form like "exacerbated") in a sentence.
function findWordIn(sentence, word) {
  const stem = word.length > 5 ? word.slice(0, word.length - 2) : word;
  const re = new RegExp(`\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[a-z]*\\b`, "i");
  return sentence.match(re);
}

// ---------- word forms ----------

// Irregular verbs: base, past tense, past participle.
const IRREGULAR = Object.fromEntries((
  "arise arose arisen|awake awoke awoken|bear bore borne|beat beat beaten|become became become|begin began begun|"
  + "bend bent bent|bet bet bet|bid bid bid|bind bound bound|bite bit bitten|bleed bled bled|blow blew blown|"
  + "break broke broken|breed bred bred|bring brought brought|build built built|burst burst burst|buy bought bought|"
  + "cast cast cast|catch caught caught|choose chose chosen|cling clung clung|come came come|cost cost cost|"
  + "creep crept crept|cut cut cut|deal dealt dealt|dig dug dug|do did done|draw drew drawn|drink drank drunk|"
  + "drive drove driven|dwell dwelt dwelt|eat ate eaten|fall fell fallen|feed fed fed|feel felt felt|"
  + "fight fought fought|find found found|flee fled fled|fling flung flung|fly flew flown|forbid forbade forbidden|"
  + "forget forgot forgotten|forgive forgave forgiven|forsake forsook forsaken|freeze froze frozen|get got gotten|"
  + "give gave given|go went gone|grind ground ground|grow grew grown|hang hung hung|have had had|hear heard heard|"
  + "hide hid hidden|hit hit hit|hold held held|hurt hurt hurt|keep kept kept|kneel knelt knelt|know knew known|"
  + "lay laid laid|lead led led|leave left left|lend lent lent|let let let|lie lay lain|light lit lit|lose lost lost|"
  + "make made made|mean meant meant|meet met met|pay paid paid|put put put|quit quit quit|read read read|rid rid rid|"
  + "ride rode ridden|ring rang rung|rise rose risen|run ran run|say said said|see saw seen|seek sought sought|"
  + "sell sold sold|send sent sent|set set set|shake shook shaken|shed shed shed|shine shone shone|shoot shot shot|"
  + "show showed shown|shrink shrank shrunk|shut shut shut|sing sang sung|sink sank sunk|sit sat sat|slay slew slain|"
  + "sleep slept slept|slide slid slid|sling slung slung|speak spoke spoken|speed sped sped|spend spent spent|"
  + "spin spun spun|spit spat spat|split split split|spread spread spread|spring sprang sprung|stand stood stood|"
  + "steal stole stolen|stick stuck stuck|sting stung stung|stride strode stridden|strike struck struck|"
  + "string strung strung|strive strove striven|swear swore sworn|sweep swept swept|swim swam swum|"
  + "swing swung swung|take took taken|teach taught taught|tear tore torn|tell told told|think thought thought|"
  + "throw threw thrown|thrust thrust thrust|tread trod trodden|wake woke woken|wear wore worn|weave wove woven|"
  + "weep wept wept|win won won|wind wound wound|wring wrung wrung|write wrote written"
).split("|").map((line) => { const [base, past, participle] = line.split(" "); return [base, { past, participle }]; }));

// Compounds of irregular verbs ("undertake", "withhold") are irregular too,
// except these, which only look like compounds.
const COMPOUND_PREFIXES = ["", "re", "un", "up", "be", "mis", "out", "fore", "with", "over", "under"];
const NOT_COMPOUNDS = new Set(["behave", "belie", "relay"]);

function irregularForms(word) {
  if (NOT_COMPOUNDS.has(word)) return null;
  for (const prefix of COMPOUND_PREFIXES) {
    const forms = word.startsWith(prefix) && IRREGULAR[word.slice(prefix.length)];
    if (forms) return { past: prefix + forms.past, participle: prefix + forms.participle };
  }
  return null;
}

// Verbs that double their last consonant ("running", "occurred"): one-syllable
// words ending consonant-vowel-consonant, and these, stressed on the last syllable.
const DOUBLES = new Set(("abhor acquit admit allot begin commit compel confer control defer deter emit equip "
  + "excel expel forbid forget incur infer omit occur patrol permit prefer propel rebel recur refer regret "
  + "submit transfer transmit upset").split(" "));

function doubles(word) {
  if (!/[^aeiou][aeiou][bcdfgklmnprtvz]$/.test(word)) return false;
  return DOUBLES.has(word) || (word.match(/[aeiouy]+/g) || []).length === 1;
}

// Adds an ending ("s", "ed", "ing", or "ly"). For "ed", participle picks the
// past participle of irregular verbs ("had given") over the past tense ("gave").
// Returns null when the word can't be trusted to take the ending.
function inflect(word, ending, participle = false) {
  if (!ending) return word;
  if (/[ -]/.test(word)) return null;
  const irregular = irregularForms(word);
  switch (ending) {
    case "s":
      if (irregular && /(do|go)$/.test(word)) return word + "es";
      if (irregular && word.endsWith("have")) return word.slice(0, -4) + "has";
      if (/(is|on|um|us|ex|ix|a|o)$/.test(word)) return null; // Latin plurals and the like
      if (/(s|x|z|ch|sh)$/.test(word)) return word + "es";
      return /[^aeiou]y$/.test(word) ? word.slice(0, -1) + "ies" : word + "s";
    case "ed":
      if (irregular) return participle ? irregular.participle : irregular.past;
      if (doubles(word)) return word + word.at(-1) + "ed";
      if (word.endsWith("e")) return word + "d";
      return /[^aeiou]y$/.test(word) ? word.slice(0, -1) + "ied" : word + "ed";
    case "ing":
      if (doubles(word)) return word + word.at(-1) + "ing";
      if (word.endsWith("ie")) return word.slice(0, -2) + "ying";
      if (/[^e]e$/.test(word)) return word.slice(0, -1) + "ing";
      return word + "ing";
    case "ly":
      if (word.endsWith("ic")) return word + "ally";
      if (/[^aeiou]le$/.test(word)) return word.slice(0, -1) + "y";
      if (/[^aeiou]y$/.test(word)) return word.slice(0, -1) + "ily";
      return word + "ly";
    default:
      return null;
  }
}

// ---------- the same word in another form ----------

// The word and its regular and irregular forms: abandon -> abandons, abandoned,
// abandoning, abandonly; give -> gave, given.
function formsOf(word) {
  const last = word.at(-1);
  const forms = new Set([word, word + "s", word + "es", word + "d", word + "ed", word + last + "ed", word + "ing",
    word + last + "ing", word + "ly", word + "ally"]);
  if (word.endsWith("e")) forms.add(word.slice(0, -1) + "ing");
  if (word.endsWith("y")) ["ies", "ied", "ily"].forEach((ending) => forms.add(word.slice(0, -1) + ending));
  for (const ending of ["s", "ed", "ing", "ly"]) forms.add(inflect(word, ending));
  forms.add(inflect(word, "ed", true));
  forms.delete(null);
  return forms;
}

// The words this one could be a form of, including itself: "abandoned" ->
// abandon(ed); "studies" -> study; "making" -> make; "given" -> give.
export function baseForms(word) {
  const bases = new Set([word]);
  if (/[ -]/.test(word)) return bases;
  const cut = (n, add = "") => word.slice(0, -n) + add;
  const candidates = [
    cut(1), cut(2), cut(3, "y"), // -s, -es, -ies
    cut(1), cut(2), cut(3), cut(3, "y"), // -d, -ed, doubled -ed, -ied
    cut(3), cut(3, "e"), cut(4), cut(4, "ie"), // -ing, -e + ing, doubled -ing, -ying
    cut(2), cut(4), cut(1, "e"), cut(3, "y"), // -ly, -ally, -le -> -ly, -ily
  ];
  for (const base of candidates) {
    if (base.length >= 3 && formsOf(base).has(word)) bases.add(base);
  }
  for (const [base, { past, participle }] of Object.entries(IRREGULAR)) {
    for (const prefix of COMPOUND_PREFIXES) {
      if (word === prefix + past || word === prefix + participle) bases.add(prefix + base);
    }
  }
  return bases;
}

// Finds which of the given words is the same word as another one, in any form:
// find("abandoned") is "abandon" when "abandon" is in the list, and null when
// none is.
export function wordFinder(names) {
  const index = new Map();
  for (const name of names) {
    for (const base of baseForms(name)) if (!index.has(base)) index.set(base, name);
  }
  return (word) => {
    for (const base of baseForms(word)) if (index.has(base)) return index.get(base);
    return null;
  };
}

// Which ending turns the word into the form used in the text: "" for the word
// itself, null for other forms (like "abandonment"), which neither format fits.
function endingOf(word, form) {
  const last = word.at(-1);
  const forms = {
    "": [word],
    s: [word + "s", word + "es", word.slice(0, -1) + "ies"],
    ed: [word + "ed", word + "d", word.slice(0, -1) + "ied", word + last + "ed"],
    ing: [word + "ing", word.slice(0, -1) + "ing", word + last + "ing", word.slice(0, -2) + "ying"],
    ly: [word + "ly", word + "ally", word.slice(0, -1) + "y", word.slice(0, -1) + "ily"],
  };
  const found = Object.keys(forms).find((ending) => forms[ending].includes(form));
  return found === undefined ? null : found;
}

// After a helping verb or a determiner, an "-ed" word is a past participle
// ("had given", "the given"), not the past tense.
function wantsParticiple(textBefore) {
  return /\b(has|have|had|having|is|are|was|were|be|been|being|get|gets|got|the|a|an|its|their|this|that)\s+$/i.test(textBefore);
}

// True when a sentence uses the word in a form the quiz can build questions from.
export function usableExample(sentence, word) {
  const match = findWordIn(sentence, word.toLowerCase());
  return Boolean(match) && endingOf(word.toLowerCase(), match[0].toLowerCase()) !== null;
}

// ---------- written questions ----------

// Written questions, for each format whose choices are all there.
function fromSat(target) {
  const { passage, form, wrong_words: wrongWords = [], meaning = "", wrong_meanings: wrongMeanings = [] } = target.sat;
  const match = passage && form && passage.match(new RegExp(`\\b${form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"));
  if (!match) return [];
  const before = passage.slice(0, match.index);
  const after = passage.slice(match.index + match[0].length);
  const questions = [];
  // A blank at the start of the text would need capitalized choices, which the SAT avoids.
  if (wrongWords.length === 3 && match.index > 0) {
    questions.push({
      key: "sat-complete",
      kind: "complete",
      target,
      prompt: escapeHtml(before) + BLANK + escapeHtml(after),
      question: COMPLETE,
      choices: shuffle([{ text: match[0], correct: true }, ...wrongWords.map((text) => ({ text, correct: false }))]),
    });
  }
  if (meaning && wrongMeanings.length === 3) {
    questions.push({
      key: "sat-meaning",
      kind: "meaning",
      target,
      prompt: escapeHtml(passage),
      question: meanQuestion(target.word, match[0]),
      choices: shuffle([{ text: meaning, correct: true }, ...wrongMeanings.map((text) => ({ text, correct: false }))]),
    });
  }
  return questions;
}

// ---------- questions built from an example sentence ----------

const COMMON = new Set(("about after again against along among another because before being between cannot "
  + "could doing during either every having itself little never other people person quality really should "
  + "since something someone state still their there these thing things those through under until using "
  + "where which while whose within without would").split(" "));

function keyWords(text) {
  return new Set((text.toLowerCase().match(/[a-z]{5,}/g) || []).filter((w) => !COMMON.has(w)).map((w) => w.slice(0, 5)));
}

const SMALL = new Set("a an the of or and to in on for with by as at be is it its that this from into".split(" "));

// Two-word phrases with at least one word that carries meaning ("give up").
function phrases(text) {
  const tokens = text.toLowerCase().match(/[a-z]+/g) || [];
  return new Set(tokens.slice(1).map((t, i) => [tokens[i], t])
    .filter((pair) => pair.some((t) => !SMALL.has(t) && !COMMON.has(t)))
    .map((pair) => pair.join(" ")));
}

// True when two words are close enough in meaning that both could be right:
// one's definition uses the other word, or the definitions share a key word or phrase.
function tooClose(a, b) {
  const stem = (w) => w.word.slice(0, 5);
  if (a.definition.toLowerCase().includes(stem(b)) || b.definition.toLowerCase().includes(stem(a))) return true;
  const sharedWords = keyWords(a.definition);
  const sharedPhrases = phrases(a.definition);
  return [...keyWords(b.definition)].some((w) => sharedWords.has(w))
    || [...phrases(b.definition)].some((p) => sharedPhrases.has(p));
}

// Three wrong choices with the target's part of speech, or any part of speech
// for rare ones (like the conjunction "whereas").
function wrongChoices(target, pool, fits) {
  const picked = [];
  for (const samePos of [true, false]) {
    for (const w of shuffle(pool)) {
      if (picked.length === 3) return picked;
      if (w.word === target.word || picked.includes(w) || tooClose(target, w)) continue;
      if (samePos && mainPos(w) !== mainPos(target)) continue;
      if (fits(w, picked)) picked.push(w);
    }
  }
  return picked.length === 3 ? picked : null;
}

// The first sense of the definition as a short answer choice: "To leave behind;
// to give up completely." becomes "Leave behind".
function shortMeaning(w) {
  const sense = w.definition.replace(/^\([a-z. ]+\)\s*/i, "").split(/;|\(/)[0].trim().replace(/\.$/, "");
  return sense.replace(/^to /i, "");
}

// A wrong choice's definition, to show after a student picks it.
function noteFor(w) {
  return w.definition.replace(/\.$/, "").replace(/^./, (c) => c.toLowerCase());
}

// A verb's short meaning with the ending the text uses ("Proposed an
// explanation" for "hypothesized"), or null if it can't take the ending.
function inflectedMeaning(w, ending, participle) {
  if (!/^to /i.test(w.definition.replace(/^\([a-z. ]+\)\s*/i, ""))) return null;
  const tokens = shortMeaning(w).split(" ");
  // Both verbs in "Gain or come to possess" need the ending.
  const verbs = ["or", "and"].includes(tokens[1]) ? [0, 2] : [0];
  for (const i of verbs) {
    const [, word, punctuation] = tokens[i].match(/^([a-z]*)(.*)$/i);
    const form = inflect(word.toLowerCase(), ending, participle);
    if (!form) return null;
    tokens[i] = form + punctuation;
  }
  return tokens.join(" ");
}

const startsWithVowel = (word) => /^[aeiou]/i.test(word);

function completeQuestion(target, example, match, ending, pool) {
  const before = example.slice(0, match.index);
  const participle = wantsParticiple(before);
  // After "a" or "an", every choice must fit the article so it doesn't give the answer away.
  const article = /\ban?\s+$/i.test(before);
  const others = wrongChoices(target, pool, (w) => {
    const form = inflect(w.word, ending, participle);
    return form !== null && (!article || startsWithVowel(form) === startsWithVowel(match[0]));
  });
  if (!others) return null;
  return {
    key: "example-complete",
    kind: "complete",
    target,
    prompt: escapeHtml(before) + BLANK + escapeHtml(example.slice(match.index + match[0].length)),
    question: COMPLETE,
    choices: shuffle([
      { text: match[0], correct: true },
      ...others.map((w) => ({ text: inflect(w.word, ending, participle), correct: false, note: noteFor(w) })),
    ]),
  };
}

function meaningQuestion(target, example, match, ending, pool) {
  const participle = wantsParticiple(example.slice(0, match.index));
  // When the text uses a verb as "-ed" or "-ing", every choice takes that ending if the answer can.
  const inflected = (ending === "ed" || ending === "ing") && inflectedMeaning(target, ending, participle) !== null;
  const meaningOf = (w) => (inflected ? inflectedMeaning(w, ending, participle) : shortMeaning(w));
  const targetMeaning = meaningOf(target).toLowerCase();
  const others = wrongChoices(target, pool, (w, picked) => {
    const m = meaningOf(w)?.toLowerCase();
    return m && m !== targetMeaning && !picked.some((p) => meaningOf(p).toLowerCase() === m);
  });
  if (!others) return null;
  return {
    key: "example-meaning",
    kind: "meaning",
    target,
    prompt: escapeHtml(example),
    question: meanQuestion(target.word, match[0]),
    choices: shuffle([
      { text: capitalize(meaningOf(target)), correct: true },
      ...others.map((w) => ({ text: capitalize(meaningOf(w)), correct: false })),
    ]),
  };
}

function fromExamples(target, pool) {
  const options = [];
  for (const example of shuffle(target.examples || [])) {
    const match = findWordIn(example, target.word);
    const ending = match && endingOf(target.word, match[0].toLowerCase());
    if (ending === null || !match) continue;
    // A blank at the start of the text would need capitalized choices, which the SAT avoids.
    if (match.index > 0 && !options.some((q) => q.key === "example-complete")) {
      const q = completeQuestion(target, example, match, ending, pool);
      if (q) options.push(q);
    }
    if (!options.some((q) => q.key === "example-meaning")) {
      const q = meaningQuestion(target, example, match, ending, pool);
      if (q) options.push(q);
    }
  }
  return options;
}

// Last resort for a word with no sentence that uses it. This format isn't on the SAT.
function defineQuestion(target, pool) {
  const others = wrongChoices(target, pool, () => true)
    || shuffle(pool.filter((w) => w.word !== target.word)).slice(0, 3);
  return {
    key: "define",
    kind: "define",
    target,
    prompt: escapeHtml(target.word),
    question: `Which choice best defines the ${target.word.includes(" ") ? "phrase" : "word"} “${target.word}”?`,
    choices: shuffle([
      { text: capitalize(shortMeaning(target)), correct: true },
      ...others.map((w) => ({ text: capitalize(shortMeaning(w)), correct: false })),
    ]),
  };
}

// A question about target, with wrong choices from pool when they're picked
// by rule. asked lists the keys of questions already asked about this word, so
// each attempt uses a format not yet asked, or at least not the most recent one.
export function buildQuestion(target, pool, asked = []) {
  const written = target.sat ? fromSat(target) : [];
  const covered = new Set(written.map((q) => q.kind));
  const options = shuffle([...written, ...fromExamples(target, pool).filter((q) => !covered.has(q.kind))]);
  if (!options.length) return defineQuestion(target, pool);
  const fresh = options.find((q) => !asked.includes(q.key));
  if (fresh) return fresh;
  const notLast = options.filter((q) => q.key !== asked.at(-1));
  const pick = notLast.length ? notLast : options;
  return pick[Math.floor(Math.random() * pick.length)];
}

// Suggested choices for a word a teacher is adding, built from its first usable
// example sentence: { form, wrongWords, meaning, wrongMeanings, blankAtStart },
// or null when no example uses the word. wrongWords is empty when the word
// starts the sentence, since the fill-in-the-blank format can't be used then.
export function suggestChoices(entry, pool) {
  for (const example of entry.examples || []) {
    const match = findWordIn(example, entry.word);
    const ending = match && endingOf(entry.word, match[0].toLowerCase());
    if (ending === null || !match) continue;
    const others = pool.filter((w) => w.word !== entry.word);
    const complete = match.index > 0 ? completeQuestion(entry, example, match, ending, others) : null;
    const meaning = meaningQuestion(entry, example, match, ending, others);
    const wrong = (q) => (q ? q.choices.filter((c) => !c.correct).map((c) => c.text) : []);
    return {
      form: match[0],
      blankAtStart: match.index === 0,
      wrongWords: wrong(complete),
      meaning: meaning ? meaning.choices.find((c) => c.correct).text : "",
      wrongMeanings: wrong(meaning),
    };
  }
  return null;
}
