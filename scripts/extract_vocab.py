"""Extract vocabulary candidates from SAT, PSAT, and ACT practice test PDFs.

Finds the question types that test vocabulary directly:
  SAT/PSAT (choices A) to D)):
  - "Which choice completes the text with the most logical and precise word or phrase?"
  - "As used in the text, what does the word (or phrase) "X" most nearly mean?"
  ACT (choices A. to D. or F. to J.):
  - "As it is used in line N, the word X most nearly means:"
  - "Which choice is clearest and most precise in context?"
  - "Which choice most effectively maintains the essay's tone?"
and collects the answer choices (and the tested word) for each one.

Usage: python scripts/extract_vocab.py PDF [PDF ...] > candidates.json
"""

import json
import re
import sys
from pathlib import Path

from pypdf import PdfReader

WORD_IN_CONTEXT = re.compile(r"most\s+logical\s+and\s+precise\s+word\s+or\s+phrase\s*\?", re.I)
MOST_NEARLY = re.compile(r"what\s+does\s+the\s+(?:word|phrase)\s+[“\"](?P<word>[^”\"]+)[”\"]\s+most\s+nearly\s+mean\s*\?", re.I)
CHOICES = re.compile(
    r"A\)\s*(?P<a>.+?)\s+B\)\s*(?P<b>.+?)\s+C\)\s*(?P<c>.+?)\s+D\)\s*(?P<d>.+?)(?=\s+(?:\d+\s|Unauthorized|Module|CONTINUE|STOP)|$)",
    re.S,
)

ACT_MOST_NEARLY = re.compile(r"the\s+(?:word|phrase)\s+(?P<word>[\w’'-]+(?:\s[\w’'-]+){0,3}?)\s+most\s+nearly\s+means\s*:", re.I)
ACT_PRECISE = re.compile(r"Which\s+choice\s+(?:is\s+clearest\s+and\s+most\s+precise|most\s+effectively\s+maintains\s+the\s+\w+’s\s+tone)[^?]*\?", re.I)
ACT_CHOICES = re.compile(
    r"[AF]\.\s*(?P<a>.+?)\s+[BG]\.\s*(?P<b>.+?)\s+[CH]\.\s*(?P<c>.+?)\s+[DJ]\.\s*(?P<d>.+?)(?=\s+(?:\d+\.\s|\d+\s+\d+|©|GO ON|END OF|Page\s+\d)|$)",
    re.S,
)


def pdf_text(path):
    reader = PdfReader(path)
    text = "\n".join(page.extract_text() or "" for page in reader.pages)
    return re.sub(r"\s+", " ", text)


def clean_choice(choice):
    choice = choice.strip().strip(".,").lower()
    # Vocabulary choices are short; longer matches are parsing spillover.
    # ACT English lists the original wording as "No Change", which isn't a word to learn.
    if choice == "no change":
        return None
    return choice if 0 < len(choice.split()) <= 3 else None


QUESTION_TYPES = [
    (WORD_IN_CONTEXT, CHOICES, "word-in-context"),
    (MOST_NEARLY, CHOICES, "most-nearly-means"),
    (ACT_MOST_NEARLY, ACT_CHOICES, "most-nearly-means"),
    (ACT_PRECISE, ACT_CHOICES, "word-in-context"),
]


def extract(path):
    text = pdf_text(path)
    found = []
    for pattern, choice_pattern, kind in QUESTION_TYPES:
        for match in pattern.finditer(text):
            choices = choice_pattern.match(text, match.end() + (1 if text[match.end():match.end() + 1] == " " else 0))
            if not choices:
                continue
            words = [w for w in (clean_choice(choices[k]) for k in "abcd") if w]
            if "word" in match.groupdict():
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
