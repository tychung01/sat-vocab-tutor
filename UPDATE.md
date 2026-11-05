# Monthly word database update

These are the instructions for the scheduled monthly update. A person can follow
them too.

## 1. Look for new official practice tests

1. Set up: `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`
2. Read `data/sources.json` to see which SAT and PSAT practice tests are
   already processed.
3. Check https://satsuite.collegeboard.org/practice/practice-tests/paper for
   SAT, PSAT/NMSQT, and PSAT 8/9 practice test PDFs that aren't in
   `data/sources.json`. (PSAT 10 tests repeat the PSAT/NMSQT ones, so skip them
   unless they're new.) Also try the next few SAT test numbers directly:
   `https://satsuite.collegeboard.org/media/pdf/sat-practice-test-<N>-digital.pdf`
   Then check https://www.act.org/content/act/en/students-and-parents/high-school-success/testing-advice-for-the-act/free-act-practice-test.html
   for ACT practice test PDFs not listed under `act_practice_tests`. Save them
   as `act-<original file name>.pdf`.
   A real test returns HTTP 200 with content type `application/pdf`. A missing
   one returns an HTML page.
4. If you find no new tests, update `"checked"` in `data/sources.json` to
   today's date, commit, push, and stop.

## 2. Extract words from each new test

1. Download each new PDF into `sources/pdfs/`. That folder is ignored by git,
   because the PDFs are copyrighted test material. A fresh checkout (like the
   monthly cloud run) has none, so also download every test already listed in
   `data/sources.json` from its `url`, keeping the file name from the URL (ACT
   files get an `act-` prefix). Otherwise the next step would drop the
   earlier tests from `sources/candidates.json`.
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
3. Add the test to `practice_tests` (SAT) or `psat_practice_tests` (PSAT) in
   `data/sources.json` and set `"checked"` to today's date.

Keep the PDFs' file names as College Board publishes them. `add_words.py`
uses the name to label the source (for example `psat-8-9-practice-test-2`
becomes "PSAT 8/9 Practice Test 2").

## Adding words from the academic word lists (manual, not monthly)

`scripts/tag_word_lists.py` labels entries with the lists they belong to. It
needs two files in `sources/lists/`, which git ignores:
- `nawl.csv`: NAWL 1.2 "lemmatized for teaching" from
  https://www.newgeneralservicelist.com/new-academic-word-list (CC BY-SA 4.0)
- `awl-sublists.txt`: the text of Coxhead's AWL sublists PDF from
  https://www.wgtn.ac.nz/lals/resources/academicwordlist/publications/awlsublists1.pdf

Run `tag_word_lists.py` on an entries file, then `add_words.py`. Pass
`--curated` only for words that don't come from a test, so test words aren't
mislabeled as curated.

## 4. Commit

Commit `data/`, `entries/`, and `sources/candidates.json` with a message like
"Add words from SAT Practice Test 12", then push.
