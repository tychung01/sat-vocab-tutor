# Monthly word database update

These are the instructions for the scheduled monthly update. A person can follow
them too.

## 1. Look for new official practice tests

1. Set up: `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`
2. Read `data/sources.json` to see which practice tests are already processed.
3. Check https://satsuite.collegeboard.org/practice/practice-tests/paper for
   digital SAT practice tests with numbers that aren't in `data/sources.json`.
   Also try the next few test numbers directly:
   `https://satsuite.collegeboard.org/media/pdf/sat-practice-test-<N>-digital.pdf`
   A real test returns HTTP 200 with content type `application/pdf`. A missing
   one returns an HTML page.
4. If you find no new tests, update `"checked"` in `data/sources.json` to
   today's date, commit, push, and stop.

## 2. Extract words from each new test

1. Download each new PDF into `sources/pdfs/`. That folder is ignored by git,
   because the PDFs are College Board's copyrighted material.
2. Run `.venv/bin/python scripts/extract_vocab.py sources/pdfs/*.pdf > sources/candidates.json`.
   This writes the answer choices from every "most logical and precise word or
   phrase" and "most nearly mean" question.
3. Compare the new test's words to `data/words.json`. Words already in the
   database still need step 3, so the new test gets added to their sources.

## 3. Write entries and merge them

1. Create `entries/test-<N>.json`, with one object for each word to add:
   `{"w", "pos", "def", "use", "ex", "seen"}`. Follow the existing files in
   `entries/` for the format.
   - Use the base form for `w` ("exacerbate"). Put the form that appeared on
     the test in `seen` ("exacerbating").
   - Include words at SAT level, and include everyday words when the test uses
     a less common meaning ("import" meaning significance). Skip plain
     everyday words like "amount" or "useful".
   - Write definitions and example sentences yourself. Don't copy test
     passages or dictionary text.
   - Add entries for words already in the database too. The merge only adds
     the new test to their sources.
2. Run `.venv/bin/python scripts/add_words.py entries/test-<N>.json`. Any
   warning about a missing source means `w`/`seen` doesn't match what the test
   used, so fix that before going on.
3. Add the test to `practice_tests` in `data/sources.json` and set `"checked"`
   to today's date.

## 4. Commit

Commit `data/`, `entries/`, and `sources/candidates.json` with a message like
"Add words from SAT Practice Test 12", then push.
