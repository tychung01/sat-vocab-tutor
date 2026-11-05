"""Tag entries with the academic word lists they belong to.

Adds source labels to each entry's "src" field when the word (or one of its
"seen" forms) is in the New Academic Word List or the Academic Word List.
With --curated, entries in neither list get the curated label instead; leave
it off for words that come from a practice test.

Needs the list files in sources/lists/ (not committed; see UPDATE.md):
  nawl.csv              NAWL 1.2 lemmatized for teaching, from newgeneralservicelist.com
  awl-sublists.txt      text of Coxhead's AWL sublists PDF

Usage: python scripts/tag_word_lists.py [--curated] ENTRIES.json [ENTRIES.json ...]
"""

import csv
import json
import re
import sys
from pathlib import Path

LISTS = Path(__file__).resolve().parent.parent / "sources" / "lists"
NAWL = "New Academic Word List (Browne, Culligan & Phillips, CC BY-SA 4.0)"
AWL = "Academic Word List (Coxhead, 2000)"
CURATED = "Curated high-frequency SAT words"


def nawl_forms():
    with open(LISTS / "nawl.csv", encoding="latin-1") as f:
        return {form.strip().lower() for row in csv.reader(f) for form in row if form.strip()}


def awl_forms():
    text = (LISTS / "awl-sublists.txt").read_text()
    return {line.strip().lower() for line in text.split("\n") if re.fullmatch(r"\s*[a-zA-Z]+\s*", line)}


def main():
    args = sys.argv[1:]
    curated = "--curated" in args
    lists = [(NAWL, nawl_forms()), (AWL, awl_forms())]
    for path in (Path(a) for a in args if a != "--curated"):
        entries = json.loads(path.read_text())
        counts = {}
        for item in entries:
            forms = {item["w"], *item.get("seen", [])}
            labels = [label for label, members in lists if forms & members]
            if not labels and curated:
                labels = [CURATED]
            if not labels:
                item.pop("src", None)
                continue
            item["src"] = labels
            for label in labels:
                counts[label] = counts.get(label, 0) + 1
        path.write_text("[\n" + ",\n".join(json.dumps(e, ensure_ascii=False) for e in entries) + "\n]\n")
        print(path.name, counts)


if __name__ == "__main__":
    main()
