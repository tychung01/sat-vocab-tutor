# Firebase setup (one time, about 5 minutes)

The study app uses Firebase for Google sign-in and to save each student's
progress. The free "Spark" plan is enough for a class.

## 1. Create the project
1. Go to https://console.firebase.google.com and sign in with your Google account.
2. Click **Create a project**, name it (for example `sat-word-study`), and
   finish the steps. You don't need Google Analytics.

## 2. Turn on Google sign-in
1. In the left menu, open **Build → Authentication** and click **Get started**.
2. Under **Sign-in method**, pick **Google**, switch it on, choose a support
   email, and click **Save**.
3. Under **Settings → Authorized domains**, click **Add domain** and add
   `tychung01.github.io`.

## 3. Create the database
1. Open **Build → Firestore Database** and click **Create database**.
2. Pick a location near you, then choose **Start in production mode**.
3. Open the **Rules** tab, replace everything with the contents of
   `firestore.rules` in this repo, and click **Publish**.

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
`isAdmin()` in `firestore.rules`. Then publish the rules again.

## What's stored
- `users/{uid}`: name, email, photo, first and last login, login count
- `users/{uid}/logins`: one entry per visit (time and browser)
- `progress/{uid}`: for each word tried, the current streak of correct
  answers, total correct and wrong, and when it was last answered

Students can read and write only their own records. Teachers listed in the
rules can read everyone's.
