# Monthly word database update

These are the instructions for the scheduled monthly update. A person can follow
them too.

Each month the database gains **50 new words**: first any words from new
official practice tests, then SAT-level words from the academic word lists or
curated SAT vocabulary to make up the rest. The database keeps growing; the app
limits each student's practice list to 1,200 words at a time (`PRACTICE_LIMIT`
in `firebase.js`), and newer words join a student's list as they learn older
ones. Words join in the order they were added, so new words never jump ahead of
words a student hasn't reached yet.

## 1. Look for new official practice tests

1. Set up: `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`
2. Read `data/sources.json` to see which practice tests are already processed
   (`practice_tests` = SAT, `psat_practice_tests` = PSAT,
   `act_practice_tests` = ACT).
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
4. If you find no new tests, skip to section 4.

## 2. Extract words from each new test

1. Download each new PDF into `sources/pdfs/`. That folder is ignored by git,
   because the PDFs are copyrighted test material. A fresh checkout (like the
   monthly cloud run) has none, so also download every test already listed in
   `data/sources.json` from its `url`, keeping the file name from the URL (ACT
   files get an `act-` prefix). Otherwise the next step would drop the
   earlier tests from `sources/candidates.json`.
2. Run `.venv/bin/python scripts/extract_vocab.py sources/pdfs/*.pdf > sources/candidates.json`.
   This writes the answer choices from every SAT/PSAT "most logical and precise
   word or phrase" and "most nearly mean" question, and the ACT "most nearly
   means" and "clearest and most precise" questions.
3. Compare the new test's words to `data/words.json`. Words already in the
   database still need section 3, so the new test gets added to their sources.

## 3. Write entries for test words and merge them

1. Create `entries/test-<name>.json`, with one object for each word:
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
2. Run `.venv/bin/python scripts/tag_word_lists.py entries/test-<name>.json`
   (no `--curated`: test words aren't curated), then
   `.venv/bin/python scripts/add_words.py entries/test-<name>.json`. Any
   warning about a missing source means `w`/`seen` doesn't match what the test
   used, so fix that before going on.
3. Add the test to the matching list in `data/sources.json`.

Keep the PDFs' file names as the test makers publish them. `add_words.py`
uses the name to label the source (for example `psat-8-9-practice-test-2`
becomes "PSAT 8/9 Practice Test 2").

## 4. Fill the month's 50 new words

Count the words that section 3 added as **new** (not ones that only gained a
source). Add more new words until this month's total is 50.

1. Run `.venv/bin/python scripts/candidate_words.py`. It downloads the New
   Academic Word List and Coxhead's Academic Word List into `sources/lists/`
   (git-ignored) and prints the words from each that aren't in the database.
2. Choose words in this order:
   - SAT-level words from those lists. Most of the New Academic Word List is
     technical (*abdominal*, *chromosome*); skip those and plain everyday words.
     Prefer words that appear in SAT/ACT reading passages: academic verbs and
     adjectives, words about argument and evidence.
   - Curated SAT vocabulary once the lists run out of good words: words common
     in SAT literature, history, and science passages. Skip rare GRE-style
     words (*querulous*, *sycophant*); the digital SAT favors academic words.
   - Never add a word that's already in the database or an inflected form of
     one (check `forms_seen_on_tests` too).
3. Write them to `entries/monthly-YYYY-MM.json` in the same format. Every
   example sentence must contain the word or a regular form of it, so the quiz
   can blank it out (avoid irregular forms like "withheld" or "undertook").
4. Run `.venv/bin/python scripts/tag_word_lists.py --curated entries/monthly-YYYY-MM.json`,
   then `.venv/bin/python scripts/add_words.py entries/monthly-YYYY-MM.json`.
   It should report `added` equal to the number you needed.

## 5. Write SAT quiz content for the new words

The quiz asks about each word with an original SAT-style passage. Every new
word needs one, or `validate_db.py` fails.

1. Write `entries/sat/monthly-YYYY-MM.json`: one object per new word,
   `{"w", "passage", "form", "wrong_words", "meaning", "wrong_meanings"}`.
   The rules are at the top of `scripts/add_sat_questions.py`, and the files
   already in `entries/sat/` show the style. In short:
   - `passage`: 2–4 original sentences (about 40–90 words) on an SAT-like
     topic (science, history, social science, the arts, literature) that use
     the word once, in the meaning the SAT tests, with context clues. The word
     can't start a sentence. Don't credit invented findings to real people.
   - `form`: the word as it appears in the passage.
   - `wrong_words`: 3 tempting words in the same form that fit the grammar but
     not the meaning. None may be a synonym of the answer.
   - `meaning` and `wrong_meanings`: short choices (1–6 words, capitalized) in
     the same form, for "what does the word most nearly mean?" Good traps
     are other senses of the word.
2. Run `.venv/bin/python scripts/add_sat_questions.py entries/sat/monthly-YYYY-MM.json`.
   It merges nothing until every entry passes, so fix what it reports.

## 6. Check and commit

1. Run `.venv/bin/python scripts/validate_db.py`. Fix anything it reports.
2. Set `"checked"` in `data/sources.json` to today's date.
3. Commit `data/`, `entries/`, and (if it changed) `sources/candidates.json`
   with a message like "Monthly update: 50 new words (3 from SAT Practice
   Test 12)", then push to main. The study app reads `data/words.json` from
   GitHub, so students see the new words right away.

## Word list files

`scripts/tag_word_lists.py` and `scripts/candidate_words.py` use two files in
`sources/lists/`, which git ignores (`candidate_words.py` puts them there):
- `nawl.csv`: NAWL 1.2 "lemmatized for teaching" from
  https://www.newgeneralservicelist.com/new-academic-word-list (CC BY-SA 4.0).
  A copy is kept in `lists/nawl.csv`, so no download is needed.
- `awl-sublists.txt`: the text of Coxhead's AWL sublists PDF from
  https://www.wgtn.ac.nz/lals/resources/academicwordlist/publications/awlsublists1.pdf
