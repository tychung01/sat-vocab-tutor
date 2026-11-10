# Firebase setup

The study app uses Firebase for Google sign-in, to save each student's
progress, and to host the site. The free "Spark" plan is enough for a class.

**Live app:** https://sat-word-study-bfabd.firebaseapp.com
(teacher dashboard: `/admin.html`). The old GitHub Pages address forwards
here; its redirect pages live in `docs/`.

The app has to be served from the `firebaseapp.com` address. That's where
Google sign-in finishes, and Chrome blocks sign-in when the app and the
sign-in handler are on different sites. The `web.app` address forwards to it.

## Publishing changes
Run from the project folder (after a one-time `npx -y firebase-tools@13.29.1 login`
in a normal terminal):

    npx -y firebase-tools@13.29.1 deploy --only hosting,firestore:rules

Before publishing a change to `firestore.rules`, run its tests. They need
Java for the Firestore emulator (for example `brew install openjdk`):

    cd tests && npm install && npm test

New words don't need a deploy. The app reads `data/words.json` from GitHub
first, so the monthly update shows up on its own.

The steps below were used to create the project the first time.

## 1. Create the project
1. Go to https://console.firebase.google.com and sign in with your Google account.
2. Click **Create a project**, name it (for example `sat-word-study`), and
   finish the steps. You don't need Google Analytics.

## 2. Turn on Google sign-in
1. In the left menu, open **Build → Authentication** and click **Get started**.
2. Under **Sign-in method**, pick **Google**, switch it on, choose a support
   email, and click **Save**.
3. Under **Settings → Authorized domains**, check that
   `sat-word-study-bfabd.firebaseapp.com` is listed (it is by default).

## 3. Create the database
1. Open **Build → Firestore Database** and click **Create database**.
2. Pick a location near you, then choose **Start in production mode**.
3. The deploy command above publishes `firestore.rules`. You can also paste
   it into the **Rules** tab and click **Publish**.

## 4. Register the web app
1. Click the gear icon → **Project settings**. Under **Your apps**, click the
   web icon (`</>`), give it a nickname, and click **Register app**. You don't
   need Firebase Hosting.
2. Copy the `firebaseConfig` values it shows (`apiKey`, `authDomain`,
   `projectId`, `appId`, …) and send them to Claude, or paste them into
   `firebase-config.js` yourself.

These values are meant to be public. The Firestore rules decide who can read
or write data.

## Adding another teacher
Open the teacher dashboard while signed in as the owner, enter the teacher's
Google email under **Teachers**, and click **Add teacher**. They can use the
dashboard as soon as they sign in with that account. Remove them the same way.
Teachers are stored in Firestore under `teachers/{email}`.

Only the owner can add or remove teachers. The owner is set in two places:
`OWNER_EMAILS` in `firebase-config.js` and `isAppOwner()` in
`firestore.rules`. Changing the owner means editing both and running the
deploy command.

## Inviting students
Only invited students can use the study app. In the teacher dashboard, use
**Invite students**: enter the Google email the student will sign in with and
click **Invite student**. Your email app opens with an invitation (a link to
the app and how to sign in); click Send. If your email app doesn't open, use
**copy the invitation** and send it from anywhere. The student shows under the
invite form until they first sign in, with **Send again** and **Remove**.

Students who signed in before invites were added keep access. Teachers can
use the study app without an invite. Anyone else who signs in sees a message
asking them to get an invite from their teacher.

## Adding words for all students
In the teacher dashboard, use **Words for all students** below the student
table. Type a word and click **Add word for all students**. You check and
save it the same way as a word for one student (below). The word goes to
every student, including students who sign up later, and comes up first in
their flashcards and quizzes. **Remove** takes it off everyone's list; their
progress on it is kept. Words already in the shared database can't be added
again. To take a word off just one student's list, use their **Word list**.

No student gets the same word twice, even in another form or tense: the
dashboard won't add "abandoned" when "abandon" is on the list (for all
students, the database, or that student). If some students already have a
word added just for them, adding it for all students replaces their copy, and
the dialog says who. The study app also keeps only one form of each word, with
a teacher's word winning over the database's.

**Words added by teachers**, below that, lists every word added by hand,
whether for all students or for one student, newest first, with who it's for,
who added it, and when. **Remove** there takes off that one addition.

## Reviewing the word database
The dashboard's **Word database** tab lists every word students study (the
database plus words added for all students) with its definition. Search by
word or definition. **Remove** opens a confirmation where you choose **All
students** (every list, including students who sign up later) or **One
student**. Database words removed for everyone are listed under **Removed for
all students**, where **Restore** gives them back. Progress is kept either way.
The monthly update never brings a removed word back.

## Changing one student's words
In the teacher dashboard, click a student and use **Word list**. Type a word
and click **Add word**. The dashboard looks it up online (the Free Dictionary
API, then Wiktionary for phrases), then has Claude write the part of speech,
definition, an SAT-style example passage, and the quiz answer choices (see
"Claude-written words" below). If Claude isn't set up or can't answer, the
dialog shows what the dictionary has. It shows the definition, part of speech,
and an example so you can check or edit them in a dialog. Nothing is saved until you click **Confirm add**; **Cancel** discards it.
If neither dictionary has the word, type the definition yourself. The example
sentence is required and has to use the word, because quiz questions are
built from it. Added words show up first in that student's flashcards and
quizzes the next time they open the app.

Under **Quiz answer choices** the dashboard suggests three wrong words for
the fill-in-the-blank question, the word's meaning as used in the sentence,
and three wrong meanings. Edit them, click **Suggest new choices** for a
fresh set, or clear a group to have the quiz pick new choices each time.
Each group is all or nothing. The quiz shuffles the choices every time.

**Remove word** takes a word off that student's list. Words from the shared
database can be restored later; their progress on them is kept. Any teacher
can do this, and students can't change their own list.

## Claude-written words (one-time setup)
The `writeWord` Cloud Function in `functions/` asks Claude (`claude-opus-5-5`)
to write each new word's content. Only teachers can call it. It needs:

1. The Firebase pay-as-you-go **Blaze** plan (Cloud Functions require it):
   Firebase console → the project → **Upgrade**. The free allowance covers
   this function's use.
2. An Anthropic API key from https://console.anthropic.com, stored as a
   Firebase secret (it never reaches the browser):
   `npx -y firebase-tools@13 functions:secrets:set ANTHROPIC_API_KEY`
3. Deploy it: `npx -y firebase-tools@13 deploy --only functions`

Each word costs well under a cent in Claude usage. If Claude declines a
request, the function retries it on Anthropic's default fallback model.

## What's stored
- `users/{uid}`: name, email, photo, first and last login, login count, and
  how many days in a row they've visited
- `users/{uid}/logins`: one entry per visit (time and browser)
- `teachers/{email}`: teachers the owner has added, with who added them and when
- `invites/{email}`: students a teacher invited, with who invited them and when
- `classwords/{word}`: words a teacher added for all students (with definitions)
- `hiddenwords/{word}`: database words a teacher removed for all students
- `wordlists/{uid}`: words a teacher added for that student (with definitions)
  and shared words a teacher removed for them
- `progress/{uid}`: for each word tried, the current streak of correct
  answers, total correct and wrong, and when it was last answered, the words
  studied since the last 50-word review, and the quiz the student must pass
  with a perfect score before the next set (each 10-card set, and a review
  quiz every 50 words)

Students can read and write only their own records, except their word list
and the words for all students, which they can read but only teachers can
change. The owner and the teachers
in `teachers/` can read everyone's.
