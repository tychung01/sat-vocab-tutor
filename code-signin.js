// Sign-in with a 6-digit code sent by email (functions/signin.js in the SAT Tutor
// repo), for people whose email isn't a Google account (iCloud, a school address).
// Used by the study app and the teacher dashboard. SAT Transitions keeps a copy of
// this file; keep the two the same.
//
// mountCodeSignIn fills `container` with a "Sign in with a code" button and the
// email and code forms. Once the code works, Firebase signs in and the page's
// watchUser picks up the account. Returns { reset }, which goes back to the button.

export function mountCodeSignIn(container, { sendCode, signInWithCode, label = "Sign in with a code sent to your email" }) {
  container.innerHTML = `
    <div class="sign-in-or"><span>or</span></div>
    <button class="btn secondary" type="button" data-step="start">${label}</button>
    <form class="code-form" data-step="email" hidden>
      <label>Your email, like an iCloud or school address
        <input type="email" name="email" required autocomplete="email" autocapitalize="off" spellcheck="false" placeholder="name@icloud.com">
      </label>
      <button class="btn primary">Email me a code</button>
    </form>
    <form class="code-form" data-step="code" hidden>
      <label>Type the 6-digit code we emailed you
        <input class="code-input" type="text" name="code" required inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="123456">
      </label>
      <button class="btn primary">Sign in</button>
      <p class="code-links"><button class="link" type="button" data-action="resend">Send a new code</button> · <button class="link" type="button" data-action="change">Use a different email</button></p>
    </form>
    <p class="error" data-role="error" hidden></p>
    <p class="muted" data-role="info" hidden></p>`;
  const $ = (selector) => container.querySelector(selector);
  const startButton = $('[data-step="start"]');
  const emailForm = $('form[data-step="email"]');
  const codeForm = $('form[data-step="code"]');
  const error = $('[data-role="error"]');
  const info = $('[data-role="info"]');
  let email = "";

  function show(step) {
    startButton.hidden = step !== "start";
    emailForm.hidden = step !== "email";
    codeForm.hidden = step !== "code";
    error.hidden = true;
    if (step !== "code") info.hidden = true;
    if (step === "email") emailForm.email.focus();
    if (step === "code") { codeForm.code.value = ""; codeForm.code.focus(); }
  }

  function showError(err) {
    console.error("Code sign-in failed", err);
    // Callable errors carry the server's message; anything else is the connection.
    const fromServer = err?.code?.startsWith("functions/") && err.code !== "functions/internal";
    error.textContent = fromServer ? err.message : "Couldn't reach the app. Check your internet connection and try again.";
    error.hidden = false;
    info.hidden = true;
  }

  async function busy(button, work) {
    button.disabled = true;
    error.hidden = true;
    try {
      await work();
    } catch (err) {
      showError(err);
    } finally {
      button.disabled = false;
    }
  }

  const requestCode = (button) => busy(button, async () => {
    const { sentTo } = await sendCode(email);
    try { localStorage.setItem("codeSignIn.email", email); } catch {}
    show("code");
    info.textContent = `We sent a code to ${sentTo}. It can take a minute to arrive; check the spam folder too.`;
    info.hidden = false;
  });

  startButton.addEventListener("click", () => {
    try { emailForm.email.value ||= localStorage.getItem("codeSignIn.email") || ""; } catch {}
    show("email");
  });
  emailForm.addEventListener("submit", (e) => {
    e.preventDefault();
    email = emailForm.email.value.trim();
    requestCode(emailForm.querySelector("button"));
  });
  codeForm.addEventListener("submit", (e) => {
    e.preventDefault();
    busy(codeForm.querySelector(".btn"), () => signInWithCode(email, codeForm.code.value.trim()));
  });
  $('[data-action="resend"]').addEventListener("click", (e) => requestCode(e.currentTarget));
  $('[data-action="change"]').addEventListener("click", () => show("email"));

  return { reset: () => show("start") };
}
