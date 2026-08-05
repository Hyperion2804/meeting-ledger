import { ORG_DOMAIN, firebaseConfig, OPTIONS } from "./config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth, signOut, onAuthStateChanged,
  signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendEmailVerification, sendPasswordResetEmail, reload
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc,
  deleteDoc, query, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

/* ============================ setup ============================ */
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const $ = (id) => document.getElementById(id);
const SEGMENTS = OPTIONS.personType;          // Wealth Manager, Channel Partner, Investor
const RESULTS = OPTIONS.result;               // Interested, To be followed up, Not Interested

const state = { user: null, profile: null, meetings: [], team: [], page: null, editingId: null };

/* ============================ helpers ============================ */
const pad = (n) => String(n).padStart(2, "0");
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const thisMonth = () => todayISO().slice(0, 7);
const monthBounds = (m) => {
  const [y, mo] = m.split("-").map(Number);
  const last = new Date(y, mo, 0).getDate();
  return { from: `${m}-01`, to: `${m}-${pad(last)}`, days: last, year: y, month: mo };
};
const fmtDay = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined,
    { weekday: "short", day: "numeric", month: "short" });
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

function fillSelect(el, values, { blank = false } = {}) {
  el.innerHTML = (blank ? '<option value=""></option>' : "") +
    values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
}

function resultTag(r) {
  const cls = r === "Interested" ? "tag-green"
    : r === "To be followed up" ? "tag-amber"
    : r === "Not Interested" ? "tag-rust" : "tag-flat";
  return `<span class="tag ${cls}">${esc(r || "—")}</span>`;
}

const n = (v) => (v ? `<td class="num">${v}</td>` : `<td class="num zero">0</td>`);

/* ============================ auth ============================ */
$("domain-label").textContent = ORG_DOMAIN;

const onDomain = (email) => email.toLowerCase().endsWith("@" + ORG_DOMAIN.toLowerCase());

const sErr = $("signin-error");
const sNote = $("signin-note");
const say = (el, msg) => { el.textContent = msg; el.hidden = false; };
const clearMsgs = () => { sErr.hidden = true; sNote.hidden = true; };

function authMessage(e) {
  const map = {
    "auth/invalid-email": "That doesn't look like a valid email address.",
    "auth/user-not-found": "No account for that address yet. Check the spelling, or ask your admin to add you.",
    "auth/wrong-password": "That password doesn't match. Use 'Set or reset my password' if you've forgotten it.",
    "auth/invalid-credential": "That email and password don't match. Use 'Set or reset my password' if you've forgotten it.",
    "auth/too-many-requests": "Too many tries. Wait a few minutes and try again.",
    "auth/weak-password": "Passwords need at least six characters.",
    "auth/email-already-in-use": "There's already an account for that address. Sign in, or reset the password.",
    "auth/operation-not-allowed": "Password sign-in isn't switched on yet. Ask your admin.",
    "auth/network-request-failed": "Couldn't reach the server. Check your connection."
  };
  return map[e.code] || e.message || "Something went wrong. Try again.";
}

$("signin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  clearMsgs();
  const email = $("s-email").value.trim().toLowerCase();
  const pw = $("s-password").value;
  if (!email) { say(sErr, "Enter your work email address."); return; }
  if (!onDomain(email)) {
    say(sErr, `Use your @${ORG_DOMAIN} address. ${email} isn't on that domain.`);
    return;
  }
  if (!pw) { say(sErr, "Enter your password."); return; }

  const btn = $("btn-auth");
  btn.disabled = true;
  try {
    try {
      await signInWithEmailAndPassword(auth, email, pw);
    } catch (e1) {
      // First-ever sign-in for this address creates the account and
      // asks them to confirm the inbox before they can do anything.
      // Modern Firebase projects hide whether an email exists (privacy
      // feature). "No account" and "wrong password" can BOTH arrive as
      // auth/invalid-credential, so we can't tell them apart from the
      // error code alone — we have to actually try creating the account.
      if (e1.code === "auth/user-not-found" || e1.code === "auth/invalid-credential") {
        try {
          const cred = await createUserWithEmailAndPassword(auth, email, pw);
          await sendEmailVerification(cred.user);
        } catch (e3) {
          // Account really did exist — it was just the wrong password.
          if (e3.code === "auth/email-already-in-use") {
            say(sErr, "That password doesn't match. Use 'Set or reset my password' if you've forgotten it.");
          } else {
            say(sErr, authMessage(e3));
          }
        }
      } else throw e1;
    }
  } catch (e2) {
    say(sErr, authMessage(e2));
  } finally {
    btn.disabled = false;
  }
});

$("btn-forgot").addEventListener("click", async () => {
  clearMsgs();
  const email = $("s-email").value.trim().toLowerCase();
  if (!email || !onDomain(email)) {
    say(sErr, `Enter your @${ORG_DOMAIN} address first, then tap this again.`);
    return;
  }
  try {
    await sendPasswordResetEmail(auth, email);
    say(sNote, `Sent. Check ${email} for a link to set your password.`);
  } catch (e) {
    say(sErr, authMessage(e));
  }
});

$("btn-resend").addEventListener("click", async () => {
  try {
    await sendEmailVerification(auth.currentUser);
    toast("Confirmation email sent");
  } catch (e) { toast(authMessage(e)); }
});

const doSignOut = () => signOut(auth);
$("btn-signout").addEventListener("click", doSignOut);
document.querySelectorAll("[data-signout]").forEach((b) => b.addEventListener("click", doSignOut));

onAuthStateChanged(auth, async (user) => {
  $("boot").hidden = true;

  if (!user) {
    state.user = null; state.profile = null;
    $("view-app").hidden = true;
    $("verify").hidden = true;
    $("view-signin").hidden = false;
    return;
  }

  const email = (user.email || "").toLowerCase();
  if (!onDomain(email)) {
    await signOut(auth);
    say(sErr, `Use your @${ORG_DOMAIN} address. ${email} isn't on that domain.`);
    return;
  }

  // Password sign-ups must confirm they own the inbox first.
  try { await reload(user); } catch (_) {}
  if (!user.emailVerified) {
    $("view-signin").hidden = true;
    $("view-app").hidden = false;
    $("verify-email").textContent = email;
    $("verify").hidden = false;
    $("pending").hidden = true;
    $("tabs").innerHTML = "";
    $("who-name").textContent = email;
    $("who-role").hidden = true;
    ["page-log", "page-master", "page-team"].forEach((p) => { $(p).hidden = true; });
    return;
  }

  state.user = { email, uid: user.uid };
  $("view-signin").hidden = true;
  $("view-app").hidden = false;
  $("verify").hidden = true;

  let profile = null;
  try {
    const snap = await getDoc(doc(db, "users", email));
    if (snap.exists()) profile = snap.data();
  } catch (e) { /* falls through to the not-set-up screen */ }

  if (!profile || profile.active === false) {
    state.profile = null;
    $("pending-email").textContent = email;
    $("pending").hidden = false;
    $("tabs").innerHTML = "";
    $("who-name").textContent = email;
    $("who-role").hidden = true;
    ["page-log", "page-master", "page-team"].forEach((p) => { $(p).hidden = true; });
    return;
  }

  state.profile = profile;
  $("pending").hidden = true;
  $("verify").hidden = true;
  $("who-name").textContent = profile.name || email;
  $("who-role").hidden = false;
  $("who-role").textContent = profile.role === "admin" ? "Admin" : "RM";

  buildTabs();
  await loadAll();
  show(profile.role === "admin" ? "master" : "log");
});

/* ============================ navigation ============================ */
function buildTabs() {
  const admin = state.profile.role === "admin";
  const tabs = admin
    ? [["master", "Master"], ["log", "My meetings"], ["team", "Team"]]
    : [["log", "My meetings"]];
  $("tabs").innerHTML = tabs.map(([id, label]) =>
    `<button class="tab" role="tab" data-page="${id}" aria-selected="false">${label}</button>`).join("");
  $("tabs").querySelectorAll(".tab").forEach((b) =>
    b.addEventListener("click", () => show(b.dataset.page)));
}

function show(page) {
  state.page = page;
  ["log", "master", "team"].forEach((p) => { $("page-" + p).hidden = p !== page; });
  $("tabs").querySelectorAll(".tab").forEach((b) =>
    b.setAttribute("aria-selected", String(b.dataset.page === page)));
  if (page === "log") renderLog();
  if (page === "master") renderMaster();
  if (page === "team") renderTeam();
}

/* ============================ data ============================ */
async function loadAll() {
  await Promise.all([loadMeetings(), state.profile.role === "admin" ? loadTeam() : Promise.resolve()]);
}

async function loadMeetings() {
  const isAdmin = state.profile.role === "admin";
  const col = collection(db, "meetings");
  // Single-field constraints only — no composite index needed.
  const q = isAdmin ? col : query(col, where("rmEmail", "==", state.user.email));
  const snap = await getDocs(q);
  state.meetings = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((x, y) => (y.date || "").localeCompare(x.date || ""));
}

async function loadTeam() {
  const snap = await getDocs(collection(db, "users"));
  state.team = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
}

const inMonth = (rows, m) => rows.filter((r) => (r.date || "").startsWith(m));

/* ============================ aggregation ============================ */
/* One meeting = one reachout. First meetings and follow-ups both count. */
function summarise(rows) {
  const s = {
    total: rows.length, first: 0, followup: 0,
    seg: {}, byResult: {}, shared: {}, notShared: {}, done: {}, pending: {}
  };
  SEGMENTS.forEach((sg) => {
    s.seg[sg] = 0; s.shared[sg] = 0; s.notShared[sg] = 0; s.done[sg] = 0; s.pending[sg] = 0;
    s.byResult[sg] = {};
    RESULTS.forEach((r) => { s.byResult[sg][r] = 0; });
  });

  for (const r of rows) {
    if (r.meetingType === "First") s.first++;
    else if (r.meetingType === "Follow-up") s.followup++;
    const sg = r.personType;
    if (!SEGMENTS.includes(sg)) continue;
    s.seg[sg]++;
    if (RESULTS.includes(r.result)) s.byResult[sg][r.result]++;
    if (r.result === "Interested") {
      if (r.shared === "Yes") s.shared[sg]++; else s.notShared[sg]++;
    }
    if (r.shared === "Yes") {
      if (r.progressed === "Yes") s.done[sg]++; else s.pending[sg]++;
    }
  }
  const sum = (o) => SEGMENTS.reduce((a, k) => a + o[k], 0);
  s.allInterested = SEGMENTS.reduce((a, k) => a + s.byResult[k]["Interested"], 0);
  s.allShared = sum(s.shared);
  s.allDone = sum(s.done);
  return s;
}

/* Column contract — identical to the Data tab of Format.xlsx */
const DATA_HEADERS = [
  "Date", "RM Name", "Total Reachouts",
  "WM - Total", "CP - Total", "Investor - Total",
  "WM - Interested", "WM - To be followed up", "WM - Not Interested",
  "CP - Interested", "CP - To be followed up", "CP - Not Interested",
  "Investor - Interested", "Investor - To be followed up", "Investor - Not Interested",
  "WM - Lead Shared", "WM - Lead Not Shared",
  "CP - Lead Shared", "CP - Lead Not Shared",
  "Investor - Docs Shared", "Investor - Docs Not Shared",
  "WM - Meeting Done", "WM - Meeting Pending",
  "CP - Meeting Done", "CP - Meeting Pending",
  "Investor - Logged In", "Investor - Login Pending",
  "First Meetings", "Follow-up Meetings"
];

function summaryRow(date, rmName, rows) {
  const s = summarise(rows);
  const [WM, CP, INV] = SEGMENTS;
  return [
    date, rmName, s.total,
    s.seg[WM], s.seg[CP], s.seg[INV],
    s.byResult[WM][RESULTS[0]], s.byResult[WM][RESULTS[1]], s.byResult[WM][RESULTS[2]],
    s.byResult[CP][RESULTS[0]], s.byResult[CP][RESULTS[1]], s.byResult[CP][RESULTS[2]],
    s.byResult[INV][RESULTS[0]], s.byResult[INV][RESULTS[1]], s.byResult[INV][RESULTS[2]],
    s.shared[WM], s.notShared[WM], s.shared[CP], s.notShared[CP], s.shared[INV], s.notShared[INV],
    s.done[WM], s.pending[WM], s.done[CP], s.pending[CP], s.done[INV], s.pending[INV],
    s.first, s.followup
  ];
}

/* ============================ RM: log ============================ */
[["f-meetingType", "meetingType"], ["f-personType", "personType"], ["f-mode", "mode"],
 ["f-result", "result"]].forEach(([id, key]) => fillSelect($(id), OPTIONS[key]));
fillSelect($("f-source"), OPTIONS.source, { blank: true });
fillSelect($("f-shared"), OPTIONS.shared, { blank: true });
fillSelect($("f-progressed"), OPTIONS.progressed, { blank: true });
$("f-date").value = todayISO();
$("rm-month").value = thisMonth();
$("admin-month").value = thisMonth();

$("f-personType").addEventListener("change", syncLabels);
function syncLabels() {
  const investor = $("f-personType").value === "Investor";
  $("lbl-shared").textContent = investor ? "Documents shared" : "Lead shared";
  $("lbl-progressed").textContent = investor ? "Logged in" : "Meeting with lead done";
}
syncLabels();

$("rm-month").addEventListener("change", renderLog);
$("btn-cancel").addEventListener("click", resetForm);

function resetForm() {
  state.editingId = null;
  $("meeting-form").reset();
  $("f-date").value = todayISO();
  $("f-id").value = "";
  $("btn-save").textContent = "Save meeting";
  $("btn-cancel").hidden = true;
  $("form-error").hidden = true;
  syncLabels();
}

$("meeting-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("form-error");
  err.hidden = true;

  const payload = {
    date: $("f-date").value,
    prospectName: $("f-prospectName").value.trim(),
    personType: $("f-personType").value,
    contact: $("f-contact").value.trim(),
    meetingType: $("f-meetingType").value,
    mode: $("f-mode").value,
    source: $("f-source").value,
    result: $("f-result").value,
    shared: $("f-shared").value,
    progressed: $("f-progressed").value,
    followUpDate: $("f-followUpDate").value,
    remarks: $("f-remarks").value.trim(),
    rmEmail: state.user.email,
    rmName: state.profile.name || state.user.email
  };

  if (!payload.date || !payload.prospectName || !payload.personType || !payload.result) {
    err.textContent = "Fill in the date, the name, the person type and the result.";
    err.hidden = false;
    return;
  }
  if (payload.result === "Interested" && !payload.shared) {
    err.textContent = "This person is interested — say whether a lead or documents came through.";
    err.hidden = false;
    return;
  }

  $("btn-save").disabled = true;
  try {
    if (state.editingId) {
      await updateDoc(doc(db, "meetings", state.editingId),
        { ...payload, updatedAt: serverTimestamp() });
      toast("Meeting updated");
    } else {
      await addDoc(collection(db, "meetings"),
        { ...payload, createdAt: serverTimestamp() });
      toast("Meeting saved");
    }
    resetForm();
    await loadMeetings();
    renderLog();
  } catch (e2) {
    err.textContent = "Couldn't save that. " + (e2.message || "Check your connection and try again.");
    err.hidden = false;
  } finally {
    $("btn-save").disabled = false;
  }
});

function renderLog() {
  const m = $("rm-month").value || thisMonth();
  const mine = state.profile.role === "admin"
    ? state.meetings.filter((r) => r.rmEmail === state.user.email)
    : state.meetings;
  const rows = inMonth(mine, m).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const s = summarise(rows);

  $("rm-strip").innerHTML = [
    ["Reachouts", s.total], ["First", s.first], ["Follow-ups", s.followup],
    ["Interested", s.allInterested], ["Lead / docs in", s.allShared], ["Converted", s.allDone]
  ].map(([label, v]) => `<div class="stat"><b>${v}</b><span>${label}</span></div>`).join("");

  if (!rows.length) {
    $("rm-list").innerHTML = `<p class="empty">No meetings logged this month yet. Add your first one on the left.</p>`;
    return;
  }

  let html = "";
  let lastDate = null;
  for (const r of rows) {
    if (r.date !== lastDate) {
      lastDate = r.date;
      html += `<div class="day-head">${esc(fmtDay(r.date))}</div>`;
    }
    const bits = [r.personType, r.meetingType, r.mode].filter(Boolean).map(esc).join(" · ");
    html += `<article class="entry">
      <div class="entry-top">
        <span class="entry-name">${esc(r.prospectName)}</span>
        ${resultTag(r.result)}
        ${r.shared === "Yes" ? `<span class="tag tag-flat">${r.personType === "Investor" ? "Docs in" : "Lead in"}</span>` : ""}
        ${r.progressed === "Yes" ? `<span class="tag tag-green">${r.personType === "Investor" ? "Logged in" : "Met"}</span>` : ""}
        <span class="entry-actions">
          <button class="btn-link" data-edit="${r.id}">Edit</button>
          <button class="btn-link danger" data-del="${r.id}">Delete</button>
        </span>
      </div>
      <div class="entry-meta">${bits}${r.contact ? " · " + esc(r.contact) : ""}</div>
      ${r.remarks ? `<div class="entry-remarks">${esc(r.remarks)}</div>` : ""}
    </article>`;
  }
  $("rm-list").innerHTML = html;

  $("rm-list").querySelectorAll("[data-edit]").forEach((b) =>
    b.addEventListener("click", () => startEdit(b.dataset.edit)));
  $("rm-list").querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", () => removeMeeting(b.dataset.del)));
}

function startEdit(id) {
  const r = state.meetings.find((x) => x.id === id);
  if (!r) return;
  state.editingId = id;
  $("f-id").value = id;
  $("f-date").value = r.date || "";
  $("f-prospectName").value = r.prospectName || "";
  $("f-personType").value = r.personType || "";
  $("f-contact").value = r.contact || "";
  $("f-meetingType").value = r.meetingType || "";
  $("f-mode").value = r.mode || "";
  $("f-source").value = r.source || "";
  $("f-result").value = r.result || "";
  $("f-shared").value = r.shared || "";
  $("f-progressed").value = r.progressed || "";
  $("f-followUpDate").value = r.followUpDate || "";
  $("f-remarks").value = r.remarks || "";
  $("btn-save").textContent = "Update meeting";
  $("btn-cancel").hidden = false;
  syncLabels();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function removeMeeting(id) {
  const r = state.meetings.find((x) => x.id === id);
  if (!confirm(`Delete the meeting with ${r ? r.prospectName : "this person"}? This can't be undone.`)) return;
  try {
    await deleteDoc(doc(db, "meetings", id));
    toast("Meeting deleted");
    await loadMeetings();
    state.page === "master" ? renderMaster() : renderLog();
  } catch (e) {
    toast("Couldn't delete that. " + (e.message || ""));
  }
}

/* ============================ admin: master ============================ */
$("admin-month").addEventListener("change", renderMaster);
$("btn-export").addEventListener("click", exportWorkbook);

function renderMaster() {
  const m = $("admin-month").value || thisMonth();
  const rows = inMonth(state.meetings, m);
  const s = summarise(rows);

  const label = new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1)
    .toLocaleDateString(undefined, { month: "long", year: "numeric" });
  $("master-sub").textContent = `${label} · ${rows.length} meeting${rows.length === 1 ? "" : "s"} across ${new Set(rows.map(r => r.rmEmail)).size} relationship manager${new Set(rows.map(r => r.rmEmail)).size === 1 ? "" : "s"}.`;

  /* --- the funnel --- */
  const stages = [
    ["Reachouts", s.total],
    ["Interested", s.allInterested],
    ["Lead / docs shared", s.allShared],
    ["Meeting done · logged in", s.allDone]
  ];
  const top = Math.max(s.total, 1);
  $("funnel-bands").innerHTML = s.total === 0
    ? `<p class="funnel-empty">Nothing logged for ${label} yet.</p>`
    : stages.map(([label2, v], i) => {
        const w = Math.max(18, Math.round((v / top) * 100));
        const pct = i === 0 ? "" : `${Math.round((v / top) * 100)}% of reachouts`;
        return `<div class="f-band" style="--w:${w}%;animation-delay:${i * 90}ms">
          <span class="f-label">${label2}</span><span class="f-num">${v}</span>
          ${pct ? `<span class="f-pct">${pct}</span>` : ""}</div>`;
      }).join("");

  /* --- by RM --- */
  const byRm = new Map();
  for (const r of rows) {
    if (!byRm.has(r.rmEmail)) byRm.set(r.rmEmail, { name: r.rmName || r.rmEmail, rows: [] });
    byRm.get(r.rmEmail).rows.push(r);
  }
  const rmRows = [...byRm.values()].map((g) => ({ name: g.name, s: summarise(g.rows) }))
    .sort((a, b) => b.s.total - a.s.total);

  const rmHead = `<thead><tr>
    <th>Relationship manager</th><th class="num">Reachouts</th><th class="num">First</th>
    <th class="num">Follow-up</th>${SEGMENTS.map((x) => `<th class="num">${esc(x)}</th>`).join("")}
    <th class="num">Interested</th><th class="num">Lead / docs</th><th class="num">Converted</th>
    <th class="num">Rate</th></tr></thead>`;
  const rmBody = rmRows.length
    ? rmRows.map(({ name, s: x }) => `<tr><td class="name">${esc(name)}</td>
        ${n(x.total)}${n(x.first)}${n(x.followup)}
        ${SEGMENTS.map((g) => n(x.seg[g])).join("")}
        ${n(x.allInterested)}${n(x.allShared)}${n(x.allDone)}
        <td class="num">${x.total ? Math.round((x.allDone / x.total) * 100) + "%" : "—"}</td></tr>`).join("")
    : `<tr><td colspan="11" class="empty">No meetings this month.</td></tr>`;
  const rmFoot = rmRows.length ? `<tfoot><tr><td>All RMs</td>
    ${n(s.total)}${n(s.first)}${n(s.followup)}
    ${SEGMENTS.map((g) => n(s.seg[g])).join("")}
    ${n(s.allInterested)}${n(s.allShared)}${n(s.allDone)}
    <td class="num">${s.total ? Math.round((s.allDone / s.total) * 100) + "%" : "—"}</td></tr></tfoot>` : "";
  $("tbl-rm").innerHTML = rmHead + `<tbody>${rmBody}</tbody>` + rmFoot;

  /* --- day by day, Format layout --- */
  const { days, year, month } = monthBounds(m);
  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(r);
  }
  const groups = `<tr class="group-head">
    <th rowspan="2">Date</th><th rowspan="2" class="num">Total</th>
    <th colspan="3">Reachouts by type</th><th colspan="9">Status</th>
    <th colspan="6">If interested</th><th colspan="6">Next stage</th>
    <th colspan="2">Meeting split</th></tr>`;
  const cols = `<tr>
    ${SEGMENTS.map((x) => `<th class="num">${esc(x)}</th>`).join("")}
    ${SEGMENTS.map(() => RESULTS.map((r) => `<th class="num">${esc(r)}</th>`).join("")).join("")}
    ${SEGMENTS.map((sg) => sg === "Investor"
        ? `<th class="num">Docs in</th><th class="num">No docs</th>`
        : `<th class="num">Lead in</th><th class="num">No lead</th>`).join("")}
    ${SEGMENTS.map((sg) => sg === "Investor"
        ? `<th class="num">Logged in</th><th class="num">Pending</th>`
        : `<th class="num">Met</th><th class="num">Pending</th>`).join("")}
    <th class="num">First</th><th class="num">Follow-up</th></tr>`;

  let body = "";
  for (let d = 1; d <= days; d++) {
    const iso = `${year}-${pad(month)}-${pad(d)}`;
    const drows = byDate.get(iso) || [];
    if (!drows.length) continue;
    const x = summarise(drows);
    body += `<tr><td>${esc(fmtDay(iso))}</td>${n(x.total)}
      ${SEGMENTS.map((g) => n(x.seg[g])).join("")}
      ${SEGMENTS.map((g) => RESULTS.map((r) => n(x.byResult[g][r])).join("")).join("")}
      ${SEGMENTS.map((g) => n(x.shared[g]) + n(x.notShared[g])).join("")}
      ${SEGMENTS.map((g) => n(x.done[g]) + n(x.pending[g])).join("")}
      ${n(x.first)}${n(x.followup)}</tr>`;
  }
  if (!body) body = `<tr><td colspan="28" class="empty">No meetings this month.</td></tr>`;
  else body += `<tr class="is-total"><td><strong>Month total</strong></td>${n(s.total)}
      ${SEGMENTS.map((g) => n(s.seg[g])).join("")}
      ${SEGMENTS.map((g) => RESULTS.map((r) => n(s.byResult[g][r])).join("")).join("")}
      ${SEGMENTS.map((g) => n(s.shared[g]) + n(s.notShared[g])).join("")}
      ${SEGMENTS.map((g) => n(s.done[g]) + n(s.pending[g])).join("")}
      ${n(s.first)}${n(s.followup)}</tr>`;
  $("tbl-daily").innerHTML = `<thead>${groups}${cols}</thead><tbody>${body}</tbody>`;

  /* --- every meeting --- */
  $("all-count").textContent = `${rows.length} row${rows.length === 1 ? "" : "s"}`;
  const sorted = [...rows].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  $("tbl-all").innerHTML = `<thead><tr>
    <th>Date</th><th>RM</th><th>Name</th><th>Type</th><th>Meeting</th><th>Mode</th>
    <th>Source</th><th>Result</th><th>Lead / docs</th><th>Next stage</th><th>Remarks</th>
    </tr></thead><tbody>${
      sorted.length ? sorted.map((r) => `<tr>
        <td class="num">${esc(r.date)}</td><td>${esc(r.rmName || r.rmEmail)}</td>
        <td class="name">${esc(r.prospectName)}</td><td>${esc(r.personType)}</td>
        <td>${esc(r.meetingType)}</td><td>${esc(r.mode)}</td><td>${esc(r.source || "—")}</td>
        <td>${resultTag(r.result)}</td><td>${esc(r.shared || "—")}</td>
        <td>${esc(r.progressed || "—")}</td><td class="wrap">${esc(r.remarks || "")}</td></tr>`).join("")
        : `<tr><td colspan="11" class="empty">No meetings this month.</td></tr>`
    }</tbody>`;
}

/* ============================ export ============================ */
function exportWorkbook() {
  if (typeof XLSX === "undefined") { toast("Excel library didn't load. Check your connection."); return; }
  const m = $("admin-month").value || thisMonth();
  const rows = inMonth(state.meetings, m);
  const { days, year, month } = monthBounds(m);

  const byRmDate = new Map();
  for (const r of rows) {
    const k = r.rmEmail + "|" + r.date;
    if (!byRmDate.has(k)) byRmDate.set(k, { name: r.rmName || r.rmEmail, date: r.date, rows: [] });
    byRmDate.get(k).rows.push(r);
  }
  const data = [DATA_HEADERS];
  [...byRmDate.values()]
    .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name))
    .forEach((g) => data.push(summaryRow(g.date, g.name, g.rows)));

  const master = [DATA_HEADERS.filter((_, i) => i !== 1)];
  for (let d = 1; d <= days; d++) {
    const iso = `${year}-${pad(month)}-${pad(d)}`;
    const drows = rows.filter((r) => r.date === iso);
    const row = summaryRow(iso, "", drows);
    master.push(row.filter((_, i) => i !== 1));
  }
  const totals = summaryRow("Month total", "", rows).filter((_, i) => i !== 1);
  master.push(totals);

  const detail = [["Date", "RM", "Name", "Meeting Person Type", "Contact", "Type of Meeting", "Mode",
    "Prospect source", "Meeting Result", "Lead / Docs Shared", "Meeting Done / Logged In",
    "Follow up Date", "Remarks"]];
  [...rows].sort((a, b) => a.date.localeCompare(b.date)).forEach((r) => detail.push([
    r.date, r.rmName || r.rmEmail, r.prospectName, r.personType, r.contact || "",
    r.meetingType, r.mode, r.source || "", r.result, r.shared || "", r.progressed || "",
    r.followUpDate || "", r.remarks || ""
  ]));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(master), "Master");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(data), "Data");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(detail), "All Meetings");
  XLSX.writeFile(wb, `Meeting Ledger ${m}.xlsx`);
  toast("Workbook downloaded");
}

/* ============================ admin: team ============================ */
$("team-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("team-error");
  err.hidden = true;
  const email = $("t-email").value.trim().toLowerCase();
  const name = $("t-name").value.trim();
  const role = $("t-role").value;

  if (!email.endsWith("@" + ORG_DOMAIN.toLowerCase())) {
    err.textContent = `That address isn't on @${ORG_DOMAIN}. Only work accounts can sign in.`;
    err.hidden = false;
    return;
  }
  if (!name) { err.textContent = "Add a full name — it's what shows up in reports."; err.hidden = false; return; }

  try {
    await setDoc(doc(db, "users", email), { email, name, role, active: true });
    toast(`${name} added`);
    $("team-form").reset();
    await loadTeam();
    renderTeam();
  } catch (e2) {
    err.textContent = "Couldn't add them. " + (e2.message || "");
    err.hidden = false;
  }
});

function renderTeam() {
  $("tbl-team").innerHTML = `<thead><tr>
    <th>Name</th><th>Email</th><th>Role</th><th>Status</th><th class="num">Meetings logged</th><th></th>
    </tr></thead><tbody>${
      state.team.length ? state.team.map((u) => {
        const count = state.meetings.filter((r) => r.rmEmail === u.email).length;
        const self = u.email === state.user.email;
        return `<tr>
          <td class="name">${esc(u.name || "—")}</td><td>${esc(u.email)}</td>
          <td><span class="tag ${u.role === "admin" ? "tag-green" : "tag-flat"}">${u.role === "admin" ? "Admin" : "RM"}</span></td>
          <td><span class="tag ${u.active === false ? "tag-rust" : "tag-flat"}">${u.active === false ? "No access" : "Active"}</span></td>
          <td class="num">${count}</td>
          <td>${self ? "" : `<button class="btn-link${u.active === false ? "" : " danger"}" data-toggle="${esc(u.email)}">${u.active === false ? "Restore access" : "Remove access"}</button>`}</td>
        </tr>`;
      }).join("") : `<tr><td colspan="6" class="empty">Nobody added yet.</td></tr>`
    }</tbody>`;

  $("tbl-team").querySelectorAll("[data-toggle]").forEach((b) =>
    b.addEventListener("click", async () => {
      const u = state.team.find((x) => x.email === b.dataset.toggle);
      if (!u) return;
      try {
        await updateDoc(doc(db, "users", u.email), { active: u.active === false });
        toast(u.active === false ? "Access restored" : "Access removed");
        await loadTeam();
        renderTeam();
      } catch (e) { toast("Couldn't change that. " + (e.message || "")); }
    }));
}
