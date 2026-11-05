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
Add their email in two places: `ADMIN_EMAILS` in `firebase-config.js` and
`isAdmin()` in `firestore.rules`. Then run the deploy command.

## What's stored
- `users/{uid}`: name, email, photo, first and last login, login count
- `users/{uid}/logins`: one entry per visit (time and browser)
- `progress/{uid}`: for each word tried, the current streak of correct
  answers, total correct and wrong, and when it was last answered

Students can read and write only their own records. Teachers listed in the
rules can read everyone's.
