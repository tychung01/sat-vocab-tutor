"""Check SAT-style question content and merge it into data/words.json.

Each entry file is a JSON list of objects:
  w               the word, as in the database
  passage         an original 2-4 sentence text (25-150 words) that uses the
                  word once, in the meaning the SAT tests
  form            the word as it appears in the passage ("abandoned")
  wrong_words     3 wrong choices for the fill-in-the-blank question, in the
                  same form as `form` so each fits grammatically
  meaning         what the word means in the passage, as a short choice in
                  the same form ("Left behind")
  wrong_meanings  3 wrong choices for the "most nearly mean" question

The quiz uses these for its two Words in Context formats. The merge stores the
content as each word's "sat" field (without "w").

Usage: python scripts/add_sat_questions.py ENTRIES.json [...] [--check-only]
"""

import argparse
import json
import re
import sys
from pathlib import Path

DB = Path(__file__).resolve().parent.parent / "data" / "words.json"
FIELDS = {"passage", "form", "wrong_words", "meaning", "wrong_meanings"}


def forms_of(word):
    """The word and its regular forms: abandon -> abandons, abandoned, abandoning, ..."""
    word = word.lower()
    last, cut = word[-1], word[:-1]
    forms = {word, word + "s", word + "es", word + "ed", word + "ing", word + last + "ed", word + last + "ing", word + "ly"}
    if word.endswith("e"):
        forms |= {word + "d", cut + "ing"}
    if word.endswith("ie"):
        forms.add(word[:-2] + "ying")
    if word.endswith("y"):
        forms |= {cut + "ies", cut + "ied", cut + "ily"}
    if word.endswith("le"):
        forms.add(cut + "y")
    if word.endswith("ic"):
        forms.add(word + "ally")
    return forms


def uses_word(text, word):
    """How many times text uses the word or one of its regular forms."""
    forms = forms_of(word)
    if " " in word:
        return len(re.findall(rf"\b{re.escape(word)}\b", text, re.I))
    return sum(1 for token in re.findall(r"[a-z]+", text.lower()) if token in forms)


def sat_problems(word, sat):
    """Everything wrong with one word's SAT content, as a list of messages."""
    if not isinstance(sat, dict):
        return ["sat content must be an object"]
    problems = []
    if set(sat) != FIELDS:
        return [f"fields must be exactly {sorted(FIELDS)}, got {sorted(sat)}"]
    passage, form = sat["passage"], sat["form"]
    if not isinstance(passage, str) or not isinstance(form, str) or not form.strip():
        return ["passage and form must be text"]

    length = len(passage.split())
    if not 25 <= length <= 150:
        problems.append(f"passage is {length} words (needs 25-150)")
    if len(re.findall(r"[.!?][\"”’)]*(?=\s|$)", passage)) < 2:
        problems.append("passage needs at least 2 sentences")
    if "_" in passage:
        problems.append("passage must not contain a blank; the quiz adds it")

    hits = list(re.finditer(rf"\b{re.escape(form)}\b", passage, re.I))
    if len(hits) != 1:
        problems.append(f'"{form}" appears {len(hits)} times in the passage (needs exactly 1)')
    if form.lower() not in forms_of(word) and form.lower() != word.lower():
        problems.append(f'"{form}" isn\'t a regular form of "{word}" (use the word, or it with -s, -ed, -ing, or -ly)')
    if uses_word(passage, word) > 1:
        problems.append(f'passage uses "{word}" (or a form of it) more than once')
    before = passage[: hits[0].start()].rstrip() if hits else ""
    if hits and (not before or before[-1] in ".!?\"“:"):
        problems.append(f'"{form}" starts a sentence; the blank would need capitalized choices')

    def choice_list(name, count=3):
        items = sat[name]
        if not isinstance(items, list) or len(items) != count or not all(isinstance(i, str) and i.strip() for i in items):
            problems.append(f"{name} must be a list of {count} non-empty strings")
            return []
        if len({i.lower() for i in items}) != count:
            problems.append(f"{name} has duplicates")
        return items

    wrong_words = choice_list("wrong_words")
    for choice in wrong_words:
        if choice.lower() == form.lower():
            problems.append(f'wrong word "{choice}" is the answer')
        if uses_word(choice, word):
            problems.append(f'wrong word "{choice}" is a form of the answer')
        if len(choice.split()) > 3:
            problems.append(f'wrong word "{choice}" is too long')
        if choice != choice.lower() and form == form.lower():
            problems.append(f'wrong word "{choice}" should be lowercase like "{form}"')
        for ending in ("ing", "ly"):
            if form.lower().endswith(ending) and not word.lower().endswith(ending) and not choice.lower().endswith(ending):
                problems.append(f'wrong word "{choice}" should end in -{ending} like "{form}"')
    if re.search(r"\ban?$", before, re.I):
        vowel = lambda text: text[:1].lower() in "aeiou"
        for choice in wrong_words:
            if vowel(choice) != vowel(form):
                problems.append(f'wrong word "{choice}" doesn\'t fit the article before the blank')

    meaning = sat["meaning"]
    if not isinstance(meaning, str) or not meaning.strip():
        problems.append("meaning must be text")
        meaning = ""
    for label, text in [("meaning", meaning)] + [("wrong meaning", m) for m in choice_list("wrong_meanings")]:
        if text and not 1 <= len(text.split()) <= 6:
            problems.append(f'{label} "{text}" should be 1-6 words')
        if text and not text[0].isupper():
            problems.append(f'{label} "{text}" should start with a capital letter')
    if meaning and meaning.lower() in {m.lower() for m in sat["wrong_meanings"] if isinstance(m, str)}:
        problems.append("a wrong meaning repeats the right one")
    return problems


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("files", nargs="+", type=Path)
    parser.add_argument("--check-only", action="store_true", help="report problems without changing the database")
    args = parser.parse_args()

    db = json.loads(DB.read_text())
    by_word = {entry["word"]: entry for entry in db["words"]}
    problems, updates = [], {}
    for path in args.files:
        for item in json.loads(path.read_text()):
            word = item.get("w")
            if word not in by_word:
                problems.append(f"{path.name}: {word!r} isn't in the database")
                continue
            if word in updates:
                problems.append(f"{path.name}: {word} appears twice")
            sat = {k: v for k, v in item.items() if k != "w"}
            problems += [f"{path.name}: {word}: {p}" for p in sat_problems(word, sat)]
            updates[word] = sat

    if problems:
        print("\n".join(problems))
        print(f"\n{len(problems)} problem(s); nothing merged.")
        sys.exit(1)
    if args.check_only:
        print(f"ok: {len(updates)} entries")
        return
    for word, sat in updates.items():
        by_word[word]["sat"] = sat
    DB.write_text(json.dumps(db, indent=2, ensure_ascii=False) + "\n")
    missing = sum(1 for entry in db["words"] if "sat" not in entry)
    print(f"merged {len(updates)} entries; {missing} words still have no SAT content")


if __name__ == "__main__":
    main()
