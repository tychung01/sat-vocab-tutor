"""List academic word list words that aren't in the database yet.

Puts the New Academic Word List (copied from lists/) and Coxhead's Academic
Word List (downloaded) into sources/lists/ if they aren't there, then prints the headwords from either list
that aren't already a database word or a form seen on a test. Use it to choose
the monthly new words; most of NAWL is technical, so pick only SAT-level ones.

Usage: python scripts/candidate_words.py
"""

import json
import re
import shutil
import subprocess
from pathlib import Path

from pypdf import PdfReader

ROOT = Path(__file__).resolve().parent.parent
LISTS = ROOT / "sources" / "lists"
# NAWL is CC BY-SA, so a copy is kept in the repo (its download link redirects to a
# host the cloud sandbox can't reach). The AWL is downloaded when needed.
NAWL_COPY = ROOT / "lists" / "nawl.csv"
AWL_URL = "https://www.wgtn.ac.nz/lals/resources/academicwordlist/publications/awlsublists1.pdf"


def download(url, path):
    # curl uses the system's certificates; some Python installs have none.
    subprocess.run(["curl", "-sSfL", "-A", "Mozilla/5.0", "-o", str(path), url], check=True)


def ensure_lists():
    LISTS.mkdir(parents=True, exist_ok=True)
    nawl = LISTS / "nawl.csv"
    if not nawl.exists() or nawl.stat().st_size == 0:
        shutil.copyfile(NAWL_COPY, nawl)
    awl_text = LISTS / "awl-sublists.txt"
    if not awl_text.exists():
        pdf = LISTS / "awl-sublists.pdf"
        download(AWL_URL, pdf)
        awl_text.write_text("\n".join(page.extract_text() or "" for page in PdfReader(pdf).pages))
    return nawl, awl_text


def main():
    nawl, awl_text = ensure_lists()
    nawl_heads = [line.split(",")[0].strip().lower() for line in nawl.read_text(encoding="latin-1").splitlines() if line.strip()]
    # AWL headwords are the lines that aren't indented under another word.
    awl_heads = [line.strip().lower() for line in awl_text.read_text().split("\n")
                 if line and not line.startswith(" ") and re.fullmatch(r"[a-z]+\s*", line)]

    db = json.loads((ROOT / "data" / "words.json").read_text())["words"]
    have = {w["word"] for w in db} | {f for w in db for f in w["forms_seen_on_tests"]}
    for name, heads in (("New Academic Word List", nawl_heads), ("Academic Word List", awl_heads)):
        missing = sorted({h for h in heads if h not in have})
        print(f"{name}: {len(missing)} not in the database")
        print(", ".join(missing))
        print()


if __name__ == "__main__":
    main()
