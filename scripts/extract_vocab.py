"""Extract vocabulary candidates from SAT practice test PDFs.

Finds the two Reading & Writing question types that test vocabulary directly:
  - "Which choice completes the text with the most logical and precise word or phrase?"
  - "As used in the text, what does the word "X" most nearly mean?"
and collects the answer choices (and the quoted word) for each one.

Usage: python scripts/extract_vocab.py PDF [PDF ...] > candidates.json
"""

import json
import re
import sys
from pathlib import Path

from pypdf import PdfReader

WORD_IN_CONTEXT = re.compile(r"most\s+logical\s+and\s+precise\s+word\s+or\s+phrase\s*\?", re.I)
MOST_NEARLY = re.compile(r"what\s+does\s+the\s+word\s+[“\"](?P<word>[^”\"]+)[”\"]\s+most\s+nearly\s+mean\s*\?", re.I)
CHOICES = re.compile(
    r"A\)\s*(?P<a>.+?)\s+B\)\s*(?P<b>.+?)\s+C\)\s*(?P<c>.+?)\s+D\)\s*(?P<d>.+?)(?=\s+(?:\d+\s|Unauthorized|Module|CONTINUE|STOP)|$)",
    re.S,
)


def pdf_text(path):
    reader = PdfReader(path)
    text = "\n".join(page.extract_text() or "" for page in reader.pages)
    return re.sub(r"\s+", " ", text)


def clean_choice(choice):
    choice = choice.strip().strip(".").lower()
    # Vocabulary choices are short; longer matches are parsing spillover.
    return choice if 0 < len(choice.split()) <= 3 else None


def extract(path):
    text = pdf_text(path)
    found = []
    for pattern, kind in ((WORD_IN_CONTEXT, "word-in-context"), (MOST_NEARLY, "most-nearly-means")):
        for match in pattern.finditer(text):
            choices = CHOICES.match(text, match.end() + (1 if text[match.end():match.end() + 1] == " " else 0))
            if not choices:
                continue
            words = [w for w in (clean_choice(choices[k]) for k in "abcd") if w]
            if kind == "most-nearly-means":
                words.insert(0, match["word"].lower())
            # Passage text is left out on purpose: it's copyrighted test content.
            found.append({"type": kind, "words": words})
    return found


def main():
    results = {}
    for arg in sys.argv[1:]:
        results[Path(arg).stem] = extract(arg)
    json.dump(results, sys.stdout, indent=2, ensure_ascii=False)


if __name__ == "__main__":
    main()
