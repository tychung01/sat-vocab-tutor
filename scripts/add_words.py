"""Merge new word entries into data/words.json.

Each entry file is a JSON list of objects with keys:
  w (word), pos, def, use, ex (list of example sentences), and optional
  seen (other forms of the word that appeared in tests, e.g. "exacerbating").

Sources are attached automatically: any test in the candidates file whose
vocabulary questions used the word (or one of its seen forms) is listed.
--source adds a label for words from somewhere else, such as a curated list.
Existing words keep their definition; only new sources are added to them.

Usage: python scripts/add_words.py ENTRIES.json [--source LABEL]
"""

import argparse
import json
import re
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "data" / "words.json"
CANDIDATES = ROOT / "sources" / "candidates.json"
PREPOSITIONS = {"of", "to", "by", "with", "from", "in", "about", "for", "at", "toward", "among", "as", "between", "on", "into", "over"}


def normalize(word):
    word = re.sub(r"^(a|an) ", "", word.strip().lower())
    parts = word.split()
    if len(parts) > 1 and parts[-1] in PREPOSITIONS:
        parts = parts[:-1]
    return " ".join(parts)


TEST_NAMES = [
    ("psat-8-9-", "PSAT 8/9"),
    ("psat-10-", "PSAT 10"),
    ("psat-nmsqt-", "PSAT/NMSQT"),
    ("sat-", "SAT"),
]


def test_label(stem):
    """Turn a PDF name like 'psat-8-9-practice-test-2' into 'PSAT 8/9 Practice Test 2 (College Board)'."""
    number = re.search(r"test-(\d+)", stem)
    for prefix, name in TEST_NAMES:
        if stem.startswith(prefix) and number:
            return f"{name} Practice Test {number[1]} (College Board)"
    return stem


def test_sources():
    """Map each normalized word to the practice tests it appeared in."""
    if not CANDIDATES.exists():
        return {}
    found = {}
    for test, questions in json.loads(CANDIDATES.read_text()).items():
        label = test_label(test)
        for question in questions:
            for word in question["words"]:
                found.setdefault(normalize(word), set()).add(label)
    return found


def sort_key(label):
    """Order sources SAT first, then PSAT/NMSQT, PSAT 10, PSAT 8/9, then anything else."""
    number = re.search(r"Practice Test (\d+)", label)
    if not number:
        return (len(TEST_NAMES), 0, label)
    rank = next(i for i, (_, name) in enumerate(reversed(TEST_NAMES)) if label.startswith(name + " "))
    return (rank, int(number[1]), label)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("entries", type=Path)
    parser.add_argument("--source", help="label for words not taken from a practice test")
    args = parser.parse_args()

    db = json.loads(DB.read_text()) if DB.exists() else {"words": []}
    words = {entry["word"]: entry for entry in db["words"]}
    appearances = test_sources()
    today = date.today().isoformat()
    added = updated = 0

    for item in json.loads(args.entries.read_text()):
        forms = {normalize(item["w"]), *(normalize(f) for f in item.get("seen", []))}
        sources = set().union(*(appearances.get(f, set()) for f in forms))
        if args.source:
            sources.add(args.source)
        if not sources:
            print(f"warning: no source for {item['w']!r}, skipped")
            continue

        if item["w"] in words:
            entry = words[item["w"]]
            new_sources = sources - set(entry["sources"])
            new_forms = forms - {item["w"]} - set(entry["forms_seen_on_tests"])
            if new_sources or new_forms:
                entry["sources"] = sorted(set(entry["sources"]) | new_sources, key=sort_key)
                entry["forms_seen_on_tests"] = sorted(set(entry["forms_seen_on_tests"]) | new_forms)
                updated += 1
            continue

        words[item["w"]] = {
            "word": item["w"],
            "part_of_speech": item["pos"],
            "definition": item["def"],
            "usage": item["use"],
            "examples": item["ex"],
            "forms_seen_on_tests": sorted(forms - {item["w"]}),
            "sources": sorted(sources, key=sort_key),
            "added": today,
        }
        added += 1

    DB.parent.mkdir(exist_ok=True)
    db = {"updated": today, "count": len(words), "words": [words[w] for w in sorted(words)]}
    DB.write_text(json.dumps(db, indent=2, ensure_ascii=False) + "\n")
    print(f"added {added}, updated {updated}, total {len(words)}")


if __name__ == "__main__":
    main()
