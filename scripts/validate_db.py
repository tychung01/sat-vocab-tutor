"""Check data/words.json before it's committed.

Fails (exit code 1) if the file isn't valid, "count" doesn't match, a word
appears twice, or an entry is missing a definition, usage, example, source, or
added date. Also fails if no example sentence contains the word (the quiz
builds extra questions from it, same rule as questions.js), or if the word's
SAT quiz content is missing or breaks a rule in add_sat_questions.py.

Usage: python scripts/validate_db.py
"""

import json
import re
import sys
from pathlib import Path

from add_sat_questions import sat_problems

DB = Path(__file__).resolve().parent.parent / "data" / "words.json"


def word_in(sentence, word):
    stem = word[:-2] if len(word) > 5 else word
    return re.search(rf"\b{re.escape(stem)}[a-z]*\b", sentence, re.I)


def main():
    db = json.loads(DB.read_text())
    words = db["words"]
    problems = []
    if db.get("count") != len(words):
        problems.append(f"count is {db.get('count')} but there are {len(words)} words")
    seen = set()
    for entry in words:
        w = entry.get("word", "")
        if w in seen:
            problems.append(f"duplicate word: {w}")
        seen.add(w)
        for field in ("part_of_speech", "definition", "usage", "examples", "sources", "added"):
            if not entry.get(field):
                problems.append(f"{w}: missing {field}")
        if entry.get("examples") and not any(word_in(e, w) for e in entry["examples"]):
            problems.append(f"{w}: no example sentence contains the word (quiz can't blank it)")
        if "sat" not in entry:
            problems.append(f"{w}: missing SAT quiz content (write it and run scripts/add_sat_questions.py)")
        else:
            problems += [f"{w}: SAT quiz content: {p}" for p in sat_problems(w, entry["sat"])]
    if problems:
        print("\n".join(problems))
        sys.exit(1)
    print(f"ok: {len(words)} words")


if __name__ == "__main__":
    main()
