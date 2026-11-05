// Teacher dashboard: lists every student who has signed in, with login history
// and learned/practice counts. Firestore rules only let admin accounts read this.

import {
  configured, isAdmin, watchUser, signIn, signOutUser, listStudents, recentLogins, LEARNED_STREAK,
} from "./firebase.js";

const $ = (id) => document.getElementById(id);
let totalWords = 0;
let students = [];

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function formatTime(ts) {
  if (!ts) return "—";
  const date = ts.toDate ? ts.toDate() : new Date(ts);
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function summarize(student) {
  const entries = Object.entries(student.words);
  const learned = entries.filter(([, p]) => p.streak >= LEARNED_STREAK).map(([w]) => w).sort();
  const close = entries
    .filter(([, p]) => p.streak > 0 && p.streak < LEARNED_STREAK)
    .sort((a, b) => b[1].streak - a[1].streak)
    .map(([w, p]) => `${w} (${p.streak}/${LEARNED_STREAK})`);
  const missed = entries.filter(([, p]) => p.streak === 0 && p.wrong > 0).map(([w]) => w).sort();
  return { learned, close, missed, practice: totalWords - learned.length };
}

function renderStats() {
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const activeThisWeek = students.filter((s) => s.lastLogin && s.lastLogin.toMillis() > weekAgo).length;
  const totalLearned = students.reduce((sum, s) => sum + summarize(s).learned.length, 0);
  $("stats").innerHTML = [
    ["Students", students.length],
    ["Active in the last 7 days", activeThisWeek],
    ["Words learned (all students)", totalLearned],
  ].map(([label, value]) => `<div class="stat"><span class="stat-value">${value}</span><span class="stat-label">${label}</span></div>`).join("");
}

function renderRows() {
  const q = $("search").value.trim().toLowerCase();
  const shown = students.filter((s) => !q || `${s.name} ${s.email}`.toLowerCase().includes(q));
  $("rows").innerHTML = shown.map((s) => {
    const { learned, practice } = summarize(s);
    const pct = totalWords ? (learned.length / totalWords) * 100 : 0;
    return `<tr class="student" data-uid="${escapeHtml(s.uid)}" tabindex="0">
      <td><strong>${escapeHtml(s.name || "(no name)")}</strong><br><span class="muted">${escapeHtml(s.email)}</span></td>
      <td>${formatTime(s.lastLogin)}</td>
      <td class="num">${s.loginCount || 0}</td>
      <td class="num">${learned.length}</td>
      <td class="num">${practice}</td>
      <td><span class="bar" title="${pct.toFixed(1)}% learned"><span style="width:${pct}%"></span></span></td>
    </tr>`;
  }).join("") || `<tr><td colspan="6" class="muted">No students yet. Students appear here after they sign in to the study app.</td></tr>`;

  document.querySelectorAll("tr.student").forEach((row) => {
    const open = () => toggleDetail(row);
    row.addEventListener("click", open);
    row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  });
}

async function toggleDetail(row) {
  const existing = row.nextElementSibling;
  if (existing && existing.classList.contains("detail")) {
    existing.remove();
    return;
  }
  const student = students.find((s) => s.uid === row.dataset.uid);
  const { learned, close, missed } = summarize(student);
  const detail = document.createElement("tr");
  detail.className = "detail";
  detail.innerHTML = `<td colspan="6"><p class="muted">Loading logins…</p></td>`;
  row.after(detail);

  let logins = [];
  try {
    logins = await recentLogins(student.uid);
  } catch {
    // Show the rest of the detail even if login history can't load.
  }
  const list = (items, empty) => items.length ? items.map(escapeHtml).join(", ") : `<span class="muted">${empty}</span>`;
  detail.innerHTML = `<td colspan="6"><div class="detail-grid">
    <div><h3>Recent logins</h3>${logins.length
      ? `<ul>${logins.map((l) => `<li>${formatTime(l.at)}</li>`).join("")}</ul>`
      : `<p class="muted">None recorded.</p>`}
      <p class="muted">First login: ${formatTime(student.firstLogin)}</p></div>
    <div><h3>Learned (${learned.length})</h3><p>${list(learned, "None yet.")}</p></div>
    <div><h3>Closest to learning</h3><p>${list(close, "None in progress.")}</p>
      <h3>Recently missed</h3><p>${list(missed, "None.")}</p></div>
  </div></td>`;
}

async function showDashboard(user) {
  $("sign-in").hidden = true;
  $("who").textContent = user.email;
  $("account").hidden = false;
  if (!isAdmin(user)) {
    $("status").textContent = "This account doesn't have teacher access.";
    $("status").hidden = false;
    $("dashboard").hidden = true;
    return;
  }
  $("status").textContent = "Loading students…";
  $("status").hidden = false;
  try {
    const [wordsDb, list] = await Promise.all([
      fetch("data/words.json", { cache: "no-cache" }).then((r) => r.json()),
      listStudents(),
    ]);
    totalWords = wordsDb.words.length;
    students = list.sort((a, b) => (b.lastLogin?.toMillis() || 0) - (a.lastLogin?.toMillis() || 0));
  } catch {
    $("status").textContent = "Couldn't load student data. Check that the Firestore rules are published (see FIREBASE-SETUP.md).";
    return;
  }
  $("status").hidden = true;
  $("dashboard").hidden = false;
  renderStats();
  renderRows();
}

$("search").addEventListener("input", renderRows);
$("sign-in-button").addEventListener("click", () => signIn().catch(() => {}));
$("sign-out").addEventListener("click", () => signOutUser());

if (!configured) {
  $("status").textContent = "Firebase isn't set up yet. See FIREBASE-SETUP.md.";
} else {
  watchUser((user) => {
    if (user) {
      showDashboard(user);
    } else {
      $("account").hidden = true;
      $("dashboard").hidden = true;
      $("status").hidden = true;
      $("sign-in").hidden = false;
    }
  });
}
