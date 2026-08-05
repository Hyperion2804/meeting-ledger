import { ORG_DOMAIN, firebaseConfig, OPTIONS } from "./config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth, signOut, onAuthStateChanged,
  signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendEmailVerification, sendPasswordResetEmail, reload
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, updateDoc,
  deleteDoc, query, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

/* ============================ setup ============================ */
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const $ = (id) => document.getElementById(id);
const SEGMENTS = OPTIONS.personType;          // Wealth Manager, Channel Partner, Investor
const RESULTS = OPTIONS.result;               // Interested, To be followed up, Not Interested

const state = { user: null, profile: null, meetings: [], team: [], plans: [], page: null, editingId: null };
const isAdminOrAbove = () => state.profile && ["admin", "superadmin"].includes(state.profile.role);
const isObserver = () => state.profile && state.profile.role === "observer";
// Everyone who sees Master + Team roster: Admin, Superadmin, and Observer.
// Observer stops there — no logging, no editing, view + download only.
const canViewAll = () => isAdminOrAbove() || isObserver();
const isSuperAdmin = () => state.profile && state.profile.role === "superadmin";
const roleLabel = (r) => r === "superadmin" ? "Super Admin" : r === "admin" ? "Admin" : r === "observer" ? "Observer" : r === "founder" ? "Founder (legacy)" : "RM";

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

const doSignOut = () => {
  if (confirm("Sign out of Meeting Ledger?")) signOut(auth);
};
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
  $("who-role").textContent = roleLabel(profile.role);

  buildTabs();
  await loadAll();
  show(canViewAll() ? "master" : "log");
});

/* ============================ navigation ============================ */
function buildTabs() {
  const tabs = isAdminOrAbove()
    ? [["master", "Master"], ["log", "My meetings"], ["team", "Team"]]
    : isObserver()
    ? [["master", "Master"], ["team", "Team"]]
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
  if (page === "team") { populateRoleOptions(); renderTeam(); }
}

/* ============================ data ============================ */
async function loadAll() {
  await Promise.all([
    loadMeetings(),
    loadPlans(),
    canViewAll() ? loadTeam() : Promise.resolve()
  ]);
}

async function loadMeetings() {
  const col = collection(db, "meetings");
  // Single-field constraints only — no composite index needed.
  const q = canViewAll() ? col : query(col, where("rmEmail", "==", state.user.email));
  const snap = await getDocs(q);
  state.meetings = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((x, y) => (y.date || "").localeCompare(x.date || ""));
}

async function loadPlans() {
  const col = collection(db, "plans");
  const q = canViewAll() ? col : query(col, where("rmEmail", "==", state.user.email));
  const snap = await getDocs(q);
  state.plans = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
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
    seg: {}, byResult: {}, shared: {}, notShared: {}, done: {}, pending: {},
    firstSeg: {}, followupSeg: {}
  };
  SEGMENTS.forEach((sg) => {
    s.seg[sg] = 0; s.shared[sg] = 0; s.notShared[sg] = 0; s.done[sg] = 0; s.pending[sg] = 0;
    s.firstSeg[sg] = 0; s.followupSeg[sg] = 0;
    s.byResult[sg] = {};
    RESULTS.forEach((r) => { s.byResult[sg][r] = 0; });
  });

  for (const r of rows) {
    if (r.meetingType === "First") s.first++;
    else if (r.meetingType === "Follow-up") s.followup++;
    const sg = r.personType;
    if (!SEGMENTS.includes(sg)) continue;
    s.seg[sg]++;
    if (r.meetingType === "First") s.firstSeg[sg]++;
    else if (r.meetingType === "Follow-up") s.followupSeg[sg]++;
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

// Investor uses different vocabulary (docs/logged in) than WM/CP (leads/meeting).
const shareLabel = (sg) => sg === "Investor" ? ["Docs Shared", "No Docs"] : ["Lead Shared", "No Lead"];
const doneLabel = (sg) => sg === "Investor" ? ["Logged In", "Pending"] : ["Meeting Done", "Pending"];

// One table per segment — Date/RM, Total, Interested/FU/NI, Shared/Not,
// Done/Pending, First/Follow-up. Replaces the old single 28-column table
// that forced sideways scrolling; three narrow tables need none.
function renderSegmentTables(containerId, rowLabelHeader, rowDefs, totalsLabel) {
  const blocks = SEGMENTS.map((sg) => {
    const [shLbl, nshLbl] = shareLabel(sg);
    const [doneLbl, pendLbl] = doneLabel(sg);
    const rows = rowDefs.map(({ label, meetings }) => ({ label, s: summarise(meetings) }));
    const totalMeetings = rowDefs.flatMap((r) => r.meetings);
    const totalS = summarise(totalMeetings);

    const head = `<tr>
      <th>${esc(rowLabelHeader)}</th>
      <th class="num">Total</th><th class="num">Interested</th>
      <th class="num">To be followed up</th><th class="num">Not Interested</th>
      <th class="num">${shLbl}</th><th class="num">${nshLbl}</th>
      <th class="num">${doneLbl}</th><th class="num">${pendLbl}</th>
      <th class="num">First</th><th class="num">Follow-up</th></tr>`;

    const body = rows
      .filter((r) => r.s.seg[sg] > 0)
      .map(({ label, s: x }) => `<tr><td>${esc(label)}</td>${n(x.seg[sg])}
        ${n(x.byResult[sg]["Interested"])}${n(x.byResult[sg]["To be followed up"])}${n(x.byResult[sg]["Not Interested"])}
        ${n(x.shared[sg])}${n(x.notShared[sg])}
        ${n(x.done[sg])}${n(x.pending[sg])}
        ${n(x.firstSeg[sg])}${n(x.followupSeg[sg])}</tr>`).join("");

    const foot = `<tr class="is-total"><td><strong>${esc(totalsLabel)}</strong></td>${n(totalS.seg[sg])}
      ${n(totalS.byResult[sg]["Interested"])}${n(totalS.byResult[sg]["To be followed up"])}${n(totalS.byResult[sg]["Not Interested"])}
      ${n(totalS.shared[sg])}${n(totalS.notShared[sg])}
      ${n(totalS.done[sg])}${n(totalS.pending[sg])}
      ${n(totalS.firstSeg[sg])}${n(totalS.followupSeg[sg])}</tr>`;

    const emptyBody = body || `<tr><td colspan="11" class="empty">Nothing for ${esc(sg)} in this range.</td></tr>`;

    return `<div class="segment-block">
      <h3 class="segment-title">${esc(sg)}</h3>
      <div class="scroller"><table class="grid grid-dense">
        <thead>${head}</thead><tbody>${emptyBody}</tbody>
        ${body ? `<tfoot>${foot}</tfoot>` : ""}
      </table></div>
    </div>`;
  }).join("");
  $(containerId).innerHTML = blocks;
}

/* Column contract — identical to the Data tab of Mastersheet.xlsx */
const DATA_HEADERS = [
  "Date", "Name", "Designation", "Employee ID", "Total Reachouts",
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

// Looks up a person's roster details for the export. Falls back gracefully
// if someone logged meetings before being added to the team (shouldn't
// happen under the rules, but a stale/removed record could still exist).
function rosterLookup(email) {
  const u = state.team.find((x) => x.email === email);
  return {
    name: u ? u.name : email,
    designation: u ? (u.designation || "") : "",
    employeeId: u ? (u.employeeId || "") : ""
  };
}

function summaryRow(date, roster, rows) {
  const s = summarise(rows);
  const [WM, CP, INV] = SEGMENTS;
  return [
    date, roster.name, roster.designation, roster.employeeId, s.total,
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
fillSelect($("f-notInterestedReason"), OPTIONS.notInterestedReason, { blank: true });
$("f-date").max = todayISO();
$("f-date").value = todayISO();
$("rm-month").value = thisMonth();
$("admin-month").value = thisMonth();

let currentLeads = [];   // [{name, phone, status}] — only used while WM/CP + Lead Shared = Yes

function syncLabels() {
  const investor = $("f-personType").value === "Investor";
  $("lbl-shared").textContent = investor ? "Documents shared" : "Lead shared";
  $("lbl-progressed").textContent = investor ? "Logged in" : "Meeting with lead done";
  $("lbl-leads").textContent = investor ? "Documents shared this meeting" : "Leads shared this meeting";
  toggleLeadsSection();
}

// Prospect source = Reference → ask who referred them.
function toggleReferenceField() {
  const on = $("f-source").value === "Reference";
  $("field-reference").hidden = !on;
  $("f-referenceName").required = on;
  if (!on) $("f-referenceName").value = "";
}

// Result = Not Interested → ask why. Otherwise the field is meaningless.
function toggleNotInterestedField() {
  const on = $("f-result").value === "Not Interested";
  $("field-notinterested").hidden = !on;
  $("f-notInterestedReason").required = on;
  $("f-notInterestedReason").disabled = !on;
  if (!on) $("f-notInterestedReason").value = "";
}

// Shared/progressed only make sense once the person is Interested — for
// anyone else there's nothing to share and nothing to be done/pending.
function toggleSharedProgressed() {
  const interested = $("f-result").value === "Interested";
  $("f-shared").disabled = !interested;
  $("f-shared").required = interested;
  if (!interested) $("f-shared").value = "";
  toggleProgressedField();
}

// Meeting Done / Logged In only makes sense once a lead or doc was
// actually shared — "Not yet" or "No" turns this off automatically.
function toggleProgressedField() {
  const wmcp = $("f-personType").value === "Wealth Manager" || $("f-personType").value === "Channel Partner";
  const leadsApply = wmcp && $("f-shared").value === "Yes";
  const on = $("f-shared").value === "Yes" && !leadsApply;
  $("field-progressed").hidden = leadsApply;
  $("f-progressed").disabled = !on;
  $("f-progressed").required = on;
  if (!on) $("f-progressed").value = "";
  toggleLeadsSection();
}

// WM/CP + Lead Shared = Yes → let them list who the leads actually are.
// Each lead carries its own Meeting Done/Pending + expected meeting date,
// which replaces the single top-level "Meeting done" field above.
function toggleLeadsSection() {
  const wmcp = $("f-personType").value === "Wealth Manager" || $("f-personType").value === "Channel Partner";
  const on = wmcp && $("f-shared").value === "Yes";
  $("field-leads").hidden = !on;
  if (!on) { currentLeads = []; }
  renderLeadsList();
}

function renderLeadsList() {
  const wrap = $("leads-list");
  if (!currentLeads.length) {
    wrap.innerHTML = `<p class="leads-empty">No leads added yet.</p>`;
  } else {
    wrap.innerHTML = currentLeads.map((l, i) => `
      <div class="lead-row">
        <input type="text" placeholder="Lead name" value="${esc(l.name)}" data-lead-name="${i}" />
        <input type="tel" placeholder="10-digit mobile" value="${esc(l.phone)}" data-lead-phone="${i}" />
        <select data-lead-status="${i}">
          ${OPTIONS.leadStatus.map((s) => `<option value="${s}"${s === l.status ? " selected" : ""}>${s}</option>`).join("")}
        </select>
        <input type="date" max="${todayISO()}" title="Expected meeting date" value="${esc(l.expectedDate || "")}" data-lead-expected="${i}" />
        <button type="button" class="btn-link danger" data-lead-remove="${i}">Remove</button>
      </div>`).join("");
  }
  wrap.querySelectorAll("[data-lead-name]").forEach((el) =>
    el.addEventListener("input", () => { currentLeads[+el.dataset.leadName].name = el.value; }));
  wrap.querySelectorAll("[data-lead-phone]").forEach((el) =>
    el.addEventListener("input", () => { currentLeads[+el.dataset.leadPhone].phone = el.value; }));
  wrap.querySelectorAll("[data-lead-status]").forEach((el) =>
    el.addEventListener("change", () => { currentLeads[+el.dataset.leadStatus].status = el.value; }));
  wrap.querySelectorAll("[data-lead-expected]").forEach((el) =>
    el.addEventListener("change", () => { currentLeads[+el.dataset.leadExpected].expectedDate = el.value; }));
  wrap.querySelectorAll("[data-lead-remove]").forEach((el) =>
    el.addEventListener("click", () => { currentLeads.splice(+el.dataset.leadRemove, 1); renderLeadsList(); }));
}

$("btn-add-lead").addEventListener("click", () => {
  currentLeads.push({ name: "", phone: "", status: OPTIONS.leadStatus[1], expectedDate: "" });
  renderLeadsList();
});

$("f-personType").addEventListener("change", syncLabels);
$("f-source").addEventListener("change", toggleReferenceField);
$("f-result").addEventListener("change", () => { toggleNotInterestedField(); toggleSharedProgressed(); });
$("f-shared").addEventListener("change", toggleProgressedField);
syncLabels();
toggleReferenceField();
toggleNotInterestedField();
toggleSharedProgressed();

$("rm-month").addEventListener("change", renderLog);
$("btn-cancel").addEventListener("click", resetForm);

function resetForm() {
  state.editingId = null;
  currentLeads = [];
  $("meeting-form").reset();
  $("f-date").max = todayISO();
  $("f-date").value = todayISO();
  $("f-id").value = "";
  $("btn-save").textContent = "Save meeting";
  $("btn-cancel").hidden = true;
  $("form-error").hidden = true;
  syncLabels();
  toggleReferenceField();
  toggleNotInterestedField();
  toggleSharedProgressed();
}

const phoneDigitsOf = (v) => (v || "").replace(/\D/g, "");
const meetingDocId = (date, phone) => `${date}_${phoneDigitsOf(phone)}`;

$("meeting-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("form-error");
  err.hidden = true;

  const wmcp = $("f-personType").value === "Wealth Manager" || $("f-personType").value === "Channel Partner";
  const leadsApply = wmcp && $("f-shared").value === "Yes";

  const payload = {
    date: $("f-date").value,
    prospectName: $("f-prospectName").value.trim(),
    personType: $("f-personType").value,
    phone: phoneDigitsOf($("f-phone").value),
    email: $("f-email").value.trim(),
    address: $("f-address").value.trim(),
    meetingType: $("f-meetingType").value,
    mode: $("f-mode").value,
    source: $("f-source").value,
    referenceName: $("f-source").value === "Reference" ? $("f-referenceName").value.trim() : "",
    result: $("f-result").value,
    notInterestedReason: $("f-result").value === "Not Interested" ? $("f-notInterestedReason").value : "",
    shared: $("f-result").value === "Interested" ? $("f-shared").value : "",
    progressed: $("f-shared").value === "Yes" ? $("f-progressed").value : "",
    leadsShared: leadsApply ? currentLeads.filter((l) => l.name.trim() || l.phone.trim()) : [],
    followUpDate: $("f-followUpDate").value,
    remarks: $("f-remarks").value.trim(),
    rmEmail: state.user.email,
    rmName: state.profile.name || state.user.email
  };

  const required = [
    ["date", "date"], ["prospectName", "name"], ["personType", "meeting person type"],
    ["phone", "phone"], ["email", "email"], ["address", "address"],
    ["meetingType", "type of meeting"], ["mode", "mode"], ["source", "prospect source"],
    ["result", "meeting result"], ["followUpDate", "follow-up date"], ["remarks", "remarks"]
  ];
  const missing = required.find(([key]) => !payload[key]);
  if (missing) {
    err.textContent = `Fill in the ${missing[1]} — every field is required.`;
    err.hidden = false;
    return;
  }
  if (payload.source === "Reference" && !payload.referenceName) {
    err.textContent = "Add the name of the person who made the reference.";
    err.hidden = false;
    return;
  }
  if (payload.result === "Not Interested" && !payload.notInterestedReason) {
    err.textContent = "Pick a reason they're not interested.";
    err.hidden = false;
    return;
  }
  if (payload.result === "Interested" && !payload.shared) {
    err.textContent = "Say whether a lead or document was shared.";
    err.hidden = false;
    return;
  }
  if (payload.shared === "Yes" && !payload.progressed) {
    err.textContent = "Say whether the meeting is done or still pending.";
    err.hidden = false;
    return;
  }
  if (payload.phone.length !== 10) {
    err.textContent = "Enter a valid 10-digit phone number.";
    err.hidden = false;
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
    err.textContent = "Enter a valid email address.";
    err.hidden = false;
    return;
  }
  if (payload.date > todayISO()) {
    err.textContent = "The meeting date can't be in the future.";
    err.hidden = false;
    return;
  }
  if (leadsApply) {
    const bad = currentLeads.find((l) => !l.name.trim() || phoneDigitsOf(l.phone).length !== 10);
    if (bad) {
      err.textContent = "Every lead needs a name and a valid 10-digit mobile number.";
      err.hidden = false;
      return;
    }
    payload.leadsShared = currentLeads.map((l) => ({ name: l.name.trim(), phone: phoneDigitsOf(l.phone), status: l.status }));
  }

  const newId = meetingDocId(payload.date, payload.phone);
  const isNew = !state.editingId;

  $("btn-save").disabled = true;
  try {
    await setDoc(doc(db, "meetings", newId),
      { ...payload, ...(isNew ? { createdAt: serverTimestamp() } : { updatedAt: serverTimestamp() }) },
      { merge: true });
    // Editing changed the phone or date enough to move to a different
    // document — clean up the old one so it doesn't linger as a ghost row.
    if (state.editingId && state.editingId !== newId) {
      await deleteDoc(doc(db, "meetings", state.editingId));
    }
    toast(isNew ? "Meeting saved" : "Meeting updated");
    resetForm();
    await loadMeetings();
    renderLog();
  } catch (e2) {
    if (e2.code === "permission-denied") {
      err.textContent = "That phone number already has a meeting logged for this date — it wasn't added again.";
    } else {
      err.textContent = "Couldn't save that. " + (e2.message || "Check your connection and try again.");
    }
    err.hidden = false;
  } finally {
    $("btn-save").disabled = false;
  }
});

function renderLog() {
  const m = $("rm-month").value || thisMonth();
  const mine = canViewAll()
    ? state.meetings.filter((r) => r.rmEmail === state.user.email)
    : state.meetings;
  const rows = inMonth(mine, m).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const s = summarise(rows);

  $("rm-strip").innerHTML = [
    ["Reachouts", s.total], ["First", s.first], ["Follow-ups", s.followup],
    ["Interested", s.allInterested], ["Lead / docs in", s.allShared], ["Converted", s.allDone]
  ].map(([label, v]) => `<div class="stat"><b>${v}</b><span>${label}</span></div>`).join("");

  renderPlanCard();
  renderFollowups(mine);

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
    const leads = (r.leadsShared || []).length
      ? `<div class="entry-leads">${(r.leadsShared || []).map((l) =>
          `<span class="tag tag-flat">${esc(l.name)} · ${esc(l.phone)} · ${esc(l.status)}${l.expectedDate ? " · exp. " + esc(l.expectedDate) : ""}</span>`).join(" ")}</div>`
      : "";
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
      <div class="entry-meta">${bits} · ${esc(r.phone)} · ${esc(r.email)} · ${esc(r.address)}</div>
      ${r.result === "Not Interested" && r.notInterestedReason ? `<div class="entry-remarks">Why: ${esc(r.notInterestedReason)}</div>` : ""}
      ${r.source === "Reference" && r.referenceName ? `<div class="entry-remarks">Referred by: ${esc(r.referenceName)}</div>` : ""}
      ${leads}
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
  $("f-date").max = todayISO();
  $("f-date").value = r.date || "";
  $("f-prospectName").value = r.prospectName || "";
  $("f-personType").value = r.personType || "";
  $("f-phone").value = r.phone || "";
  $("f-email").value = r.email || "";
  $("f-address").value = r.address || "";
  $("f-meetingType").value = r.meetingType || "";
  $("f-mode").value = r.mode || "";
  $("f-source").value = r.source || "";
  $("f-referenceName").value = r.referenceName || "";
  $("f-result").value = r.result || "";
  $("f-notInterestedReason").value = r.notInterestedReason || "";
  $("f-shared").value = r.shared || "";
  $("f-progressed").value = r.progressed || "";
  $("f-followUpDate").value = r.followUpDate || "";
  $("f-remarks").value = r.remarks || "";
  currentLeads = (r.leadsShared || []).map((l) => ({ ...l }));
  $("btn-save").textContent = "Update meeting";
  $("btn-cancel").hidden = false;
  syncLabels();
  toggleReferenceField();
  toggleNotInterestedField();
  toggleSharedProgressed();
  // toggleSharedProgressed already re-enabled/disabled shared+progressed
  // based on result, but startEdit needs the loaded values to survive that.
  $("f-shared").value = r.shared || "";
  $("f-progressed").value = r.progressed || "";
  toggleLeadsSection();
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

/* ============================ RM: tomorrow's plan ============================ */
const tomorrowISO = () => {
  const d = new Date(); d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const PLAN_FIELDS = ["newChannel", "newCustomer", "fuChannel", "fuCustomer"];
const PLAN_INPUT = { newChannel: "p-newChannel", newCustomer: "p-newCustomer", fuChannel: "p-fuChannel", fuCustomer: "p-fuCustomer" };

function updatePlanTotal() {
  const total = PLAN_FIELDS.reduce((sum, k) => sum + (parseInt($(PLAN_INPUT[k]).value, 10) || 0), 0);
  $("p-total").value = total;
}
PLAN_FIELDS.forEach((k) => $(PLAN_INPUT[k]).addEventListener("input", updatePlanTotal));

function renderPlanCard() {
  const planDate = tomorrowISO();
  $("plan-date-label").textContent = fmtDay(planDate);
  const mine = state.plans.find((p) => p.rmEmail === state.user.email && p.planDate === planDate);
  PLAN_FIELDS.forEach((k) => { $(PLAN_INPUT[k]).value = mine ? (mine[k] || 0) : 0; });
  updatePlanTotal();
}

$("plan-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const planDate = tomorrowISO();
  const vals = {};
  for (const k of PLAN_FIELDS) {
    const v = parseInt($(PLAN_INPUT[k]).value, 10);
    if (!Number.isInteger(v) || v < 0) { toast("Enter a whole number, zero or more, in every box."); return; }
    vals[k] = v;
  }
  const plannedCount = PLAN_FIELDS.reduce((sum, k) => sum + vals[k], 0);
  const planId = `${state.user.email}_${planDate}`;
  try {
    await setDoc(doc(db, "plans", planId), {
      rmEmail: state.user.email, rmName: state.profile.name || state.user.email,
      planDate, ...vals, plannedCount, updatedAt: serverTimestamp()
    }, { merge: true });
    $("plan-saved").textContent = `Saved — ${plannedCount} meeting${plannedCount === 1 ? "" : "s"} planned for ${fmtDay(planDate)}.`;
    $("plan-saved").hidden = false;
    await loadPlans();
  } catch (e2) {
    toast("Couldn't save the plan. " + (e2.message || ""));
  }
});

/* ============================ RM: follow-ups this week ============================ */
// Monday–Sunday containing today, as ISO date strings.
function thisWeekBounds() {
  const d = new Date();
  const dow = d.getDay();                     // 0=Sun..6=Sat
  const toMonday = dow === 0 ? -6 : 1 - dow;   // days to subtract to reach Monday
  const mon = new Date(d); mon.setDate(d.getDate() + toMonday);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  const iso = (x) => `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
  return { start: iso(mon), end: iso(sun) };
}

function renderFollowups(mine) {
  const { start, end } = thisWeekBounds();
  $("followups-range-label").textContent = `${fmtDay(start)} – ${fmtDay(end)}`;
  const due = mine
    .filter((r) => r.followUpDate && r.followUpDate >= start && r.followUpDate <= end)
    .sort((a, b) => (a.followUpDate || "").localeCompare(b.followUpDate || ""));

  if (!due.length) {
    $("followups-list").innerHTML = `<p class="followups-empty">Nothing due this week.</p>`;
    return;
  }
  $("followups-list").innerHTML = due.map((r) => `
    <article class="fu-item">
      <div class="fu-top">
        <span class="fu-name">${esc(r.prospectName)}</span>
        <span class="fu-date">${esc(fmtDay(r.followUpDate))}</span>
      </div>
      <div class="fu-meta">${esc(r.personType)} · ${esc(r.phone || "")}${r.remarks ? " · " + esc(r.remarks) : ""}</div>
    </article>`).join("");
}

/* ============================ admin: master ============================ */
// Nobody can browse into the future: month picker capped at the current
// month, custom range capped at today, and "to" can never sit before "from".
$("admin-month").max = thisMonth();
$("export-from").max = todayISO();
$("export-to").max = todayISO();

$("admin-month").addEventListener("change", () => {
  // Picking a month means "use the month" — clear any stale custom range
  // so there's no ambiguity about which one is actually active.
  $("export-from").value = ""; $("export-to").value = "";
  renderMaster();
});
$("export-from").addEventListener("change", () => {
  const from = $("export-from").value;
  $("export-to").min = from;
  if (from && $("export-to").value && $("export-to").value < from) $("export-to").value = from;
  renderMaster();
});
$("export-to").addEventListener("change", renderMaster);

$("btn-export").addEventListener("click", exportWorkbook);
$("btn-export-leads").addEventListener("click", exportLeads);
$("achieve-date").value = todayISO();
$("achieve-date").max = todayISO();
$("achieve-date").addEventListener("change", renderMaster);

/* master sub-tabs: Dashboard (charts) vs Sheets (funnel/tables/export data) */
let masterSub = "dashboard";
$("master-subtabs").querySelectorAll(".subtab").forEach((b) =>
  b.addEventListener("click", () => {
    masterSub = b.dataset.sub;
    $("master-subtabs").querySelectorAll(".subtab").forEach((x) =>
      x.setAttribute("aria-selected", String(x === b)));
    $("master-panel-dashboard").hidden = masterSub !== "dashboard";
    $("master-panel-sheets").hidden = masterSub !== "sheets";
  }));

/* ============================ visual dashboard ============================ */
const charts = {};   // canvas id -> Chart instance, so re-render replaces rather than stacks
const INK3 = "#6B5A44", RULE = "#E3D9C8", PAPER = "#FBF8F2";
// Brand — same gold family as the CSS. Used for decorative/categorical chart color only.
const GOLD_DEEP = "#7A4A12", GOLD = "#B8862F", GOLD2 = "#D4A94F";
// Status — semantic only (matches .tag-green/.tag-amber/.tag-rust exactly). Never used decoratively.
const GREEN = "#1B4D3E", AMBER = "#9C6B15", RUST = "#8F3A2C";
const FONT_UI = "'Public Sans', sans-serif";
const FONT_MONO = "'IBM Plex Mono', monospace";
const RM_PALETTE = ["#7A4A12", "#B8862F", "#D4A94F", "#9C6B15", "#C9A227", "#8F3A2C", "#6B5A44", "#E3C77A"];

function drawChart(id, config) {
  const el = $(id);
  if (!el) return;
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
  charts[id] = new Chart(el, config);
}

function renderDashStrip(s, rmCount) {
  const rate = s.total ? Math.round((s.allDone / s.total) * 100) : 0;
  const items = [
    ["Reachouts", s.total, false],
    ["Interested", s.allInterested, false],
    ["Lead / docs in", s.allShared, false],
    ["Converted", s.allDone, true],
    ["Conversion", rate + "%", false],
    ["Active RMs", rmCount, false]
  ];
  $("dash-strip").innerHTML = items.map(([label, v, accent]) =>
    `<div class="dstat${accent ? " accent" : ""}"><b>${v}</b><span>${esc(label)}</span></div>`).join("");
}

function renderCharts(from, to, rows, s, rmRows) {
  if (typeof Chart === "undefined") return;   // CDN blocked/offline — tables still work fine
  ["chart-trend", "chart-rm", "chart-type", "chart-result"].forEach((id) => {
    $(id).parentElement.querySelectorAll(".chart-empty").forEach((el) => el.remove());
  });

  /* --- daily trend, line --- */
  const dateList = eachDateISO(from, to);
  const labels = dateList.map((iso) => String(Number(iso.slice(8, 10))));
  const daily = dateList.map((iso) => rows.filter((r) => r.date === iso).length);
  drawChart("chart-trend", {
    type: "line",
    data: { labels, datasets: [{
      data: daily, borderColor: GOLD, backgroundColor: "rgba(184,134,47,.12)",
      pointRadius: 0, pointHoverRadius: 4, borderWidth: 2, fill: true, tension: .3
    }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { family: FONT_MONO, size: 10 }, color: INK3, maxTicksLimit: 10 } },
        y: { beginAtZero: true, ticks: { precision: 0, font: { family: FONT_MONO, size: 10 }, color: INK3 },
             grid: { color: RULE } }
      }
    }
  });

  /* --- by RM, horizontal bar --- */
  const top = rmRows.slice(0, 8);
  drawChart("chart-rm", {
    type: "bar",
    data: { labels: top.map((r) => r.name), datasets: [{
      data: top.map((r) => r.s.total),
      backgroundColor: top.map((_, i) => RM_PALETTE[i % RM_PALETTE.length]),
      borderRadius: 5, maxBarThickness: 22
    }] },
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { beginAtZero: true, ticks: { precision: 0, font: { family: FONT_MONO, size: 10 }, color: INK3 },
             grid: { color: RULE } },
        y: { grid: { display: false }, ticks: { font: { family: FONT_UI, size: 11 }, color: "#1C140A" } }
      }
    }
  });
  if (!top.length) el_empty("chart-rm");

  /* --- reachouts by type, doughnut --- */
  const typeVals = SEGMENTS.map((g) => s.seg[g]);
  drawChart("chart-type", {
    type: "doughnut",
    data: { labels: SEGMENTS, datasets: [{
      data: typeVals, backgroundColor: [GOLD_DEEP, GOLD, AMBER], borderColor: PAPER, borderWidth: 2
    }] },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: "62%",
      plugins: { legend: { position: "bottom", labels: {
        font: { family: FONT_UI, size: 11 }, color: "#1C140A", boxWidth: 10, padding: 12 } } }
    }
  });
  if (!s.total) el_empty("chart-type");

  /* --- result split, doughnut --- */
  const resultVals = SEGMENTS.reduce((acc, g) => {
    RESULTS.forEach((r, i) => { acc[i] += s.byResult[g][r]; });
    return acc;
  }, [0, 0, 0]);
  drawChart("chart-result", {
    type: "doughnut",
    data: { labels: RESULTS, datasets: [{
      data: resultVals, backgroundColor: [GREEN, AMBER, RUST], borderColor: PAPER, borderWidth: 2
    }] },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: "62%",
      plugins: { legend: { position: "bottom", labels: {
        font: { family: FONT_UI, size: 11 }, color: "#1C140A", boxWidth: 10, padding: 12 } } }
    }
  });
  if (!s.total) el_empty("chart-result");
}

function el_empty(canvasId) {
  const wrap = $(canvasId).parentElement;
  if (wrap.querySelector(".chart-empty")) return;
  const p = document.createElement("p");
  p.className = "chart-empty";
  p.textContent = "Nothing to show yet.";
  wrap.appendChild(p);
}

function renderMaster() {
  const { from, to, label } = exportRange();
  const rows = state.meetings.filter((r) => r.date >= from && r.date <= to);
  const s = summarise(rows);

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

  renderSegmentTables("rm-segment-tables", "Relationship manager",
    [...byRm.values()].map((g) => ({ label: g.name, meetings: g.rows })), "All RMs");

  /* --- visual dashboard: stat strip + charts --- */
  renderDashStrip(s, rmRows.length);
  renderCharts(from, to, rows, s, rmRows);

  /* --- plan vs achievement --- */
  renderAchievement();

  /* --- day by day, one table per segment, no sideways scroll --- */
  const dayRowDefs = [];
  for (const iso of eachDateISO(from, to)) {
    const drows = rows.filter((r) => r.date === iso);
    if (drows.length) dayRowDefs.push({ label: fmtDay(iso), meetings: drows });
  }
  renderSegmentTables("daily-segment-tables", "Date", dayRowDefs, "Total");

  /* --- every meeting --- */
  $("all-count").textContent = `${rows.length} row${rows.length === 1 ? "" : "s"}`;
  const sorted = [...rows].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  $("tbl-all").innerHTML = `<thead><tr>
    <th>Date</th><th>RM</th><th>Name</th><th>Type</th><th>Meeting</th><th>Mode</th>
    <th>Phone</th><th>Email</th><th>Address</th>
    <th>Source</th><th>Result</th><th>Lead / docs</th><th>Next stage</th><th>Remarks</th>
    </tr></thead><tbody>${
      sorted.length ? sorted.map((r) => `<tr>
        <td class="num">${esc(r.date)}</td><td>${esc(r.rmName || r.rmEmail)}</td>
        <td class="name">${esc(r.prospectName)}</td><td>${esc(r.personType)}</td>
        <td>${esc(r.meetingType)}</td><td>${esc(r.mode)}</td>
        <td>${esc(r.phone)}</td><td>${esc(r.email)}</td><td class="wrap">${esc(r.address)}</td>
        <td>${esc(r.source || "—")}</td>
        <td>${resultTag(r.result)}</td><td>${esc(r.shared || "—")}</td>
        <td>${esc(r.progressed || "—")}</td><td class="wrap">${esc(r.remarks || "")}</td></tr>`).join("")
        : `<tr><td colspan="14" class="empty">No meetings this month.</td></tr>`
    }</tbody>`;
}

/* ============================ export ============================ */
// Custom range wins if both dates are filled; otherwise fall back to the
// selected month. Returns { from, to, label } as ISO date strings.
function exportRange() {
  const from = $("export-from").value, to = $("export-to").value;
  if (from && to && from <= to) return { from, to, label: `${from} to ${to}` };
  const m = $("admin-month").value || thisMonth();
  const { from: mf, to: mt } = monthBounds(m);
  const label = new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1)
    .toLocaleDateString(undefined, { month: "long", year: "numeric" });
  return { from: mf, to: mt, label };
}

function eachDateISO(from, to) {
  const out = [];
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const cur = new Date(fy, fm - 1, fd);
  const end = new Date(ty, tm - 1, td);
  while (cur <= end) {
    out.push(`${cur.getFullYear()}-${pad(cur.getMonth() + 1)}-${pad(cur.getDate())}`);
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

function exportWorkbook() {
  if (typeof XLSX === "undefined") { toast("Excel library didn't load. Check your connection."); return; }
  const { from, to, label } = exportRange();
  const rows = state.meetings.filter((r) => r.date >= from && r.date <= to);

  const byRmDate = new Map();
  for (const r of rows) {
    const k = r.rmEmail + "|" + r.date;
    if (!byRmDate.has(k)) byRmDate.set(k, { email: r.rmEmail, date: r.date, rows: [] });
    byRmDate.get(k).rows.push(r);
  }
  const data = [DATA_HEADERS];
  [...byRmDate.values()]
    .sort((a, b) => a.date.localeCompare(b.date) || a.email.localeCompare(b.email))
    .forEach((g) => data.push(summaryRow(g.date, rosterLookup(g.email), g.rows)));

  // Master rollup: one row per day in range, roster columns dropped since
  // they don't apply to an all-RM total.
  const rollupCols = [0, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    21, 22, 23, 24, 25, 26, 27, 28, 29, 30];
  const master = [rollupCols.map((i) => DATA_HEADERS[i])];
  eachDateISO(from, to).forEach((iso) => {
    const drows = rows.filter((r) => r.date === iso);
    if (!drows.length) return;
    const row = summaryRow(iso, { name: "", designation: "", employeeId: "" }, drows);
    master.push(rollupCols.map((i) => row[i]));
  });
  const totalsRow = summaryRow("Total", { name: "", designation: "", employeeId: "" }, rows);
  master.push(rollupCols.map((i) => totalsRow[i]));

  const detail = [["Date", "RM", "Designation", "Employee ID", "Name", "Meeting Person Type",
    "Phone", "Email", "Address", "Type of Meeting", "Mode", "Prospect source", "Reference Name",
    "Meeting Result", "Not Interested Reason", "Lead / Docs Shared", "Meeting Done / Logged In",
    "Follow up Date", "Remarks"]];
  [...rows].sort((a, b) => a.date.localeCompare(b.date)).forEach((r) => {
    const ru = rosterLookup(r.rmEmail);
    detail.push([
      r.date, ru.name, ru.designation, ru.employeeId, r.prospectName, r.personType,
      r.phone || "", r.email || "", r.address || "", r.meetingType, r.mode, r.source || "",
      r.referenceName || "", r.result, r.notInterestedReason || "", r.shared || "", r.progressed || "",
      r.followUpDate || "", r.remarks || ""
    ]);
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(master), "Master");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(data), "Data");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(detail), "All Meetings");
  XLSX.writeFile(wb, `Meeting Ledger ${label}.xlsx`);
  toast("Workbook downloaded");
}

// Leads are never in the workbook above — they're a separate, deliberate
// download so a Wealth Manager or Channel Partner's shared contacts don't
// travel in every routine export.
function exportLeads() {
  if (typeof XLSX === "undefined") { toast("Excel library didn't load. Check your connection."); return; }
  const { from, to, label } = exportRange();
  const rows = state.meetings.filter((r) => r.date >= from && r.date <= to && (r.leadsShared || []).length);

  const sheet = [["Date", "RM", "Prospect (source of lead)", "Segment", "Lead Name", "Lead Phone", "Status", "Expected Meeting Date"]];
  rows.forEach((r) => {
    const ru = rosterLookup(r.rmEmail);
    (r.leadsShared || []).forEach((l) => {
      sheet.push([r.date, ru.name, r.prospectName, r.personType, l.name, l.phone, l.status, l.expectedDate || ""]);
    });
  });
  if (sheet.length === 1) { toast("No leads shared in that range."); return; }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet), "Leads");
  XLSX.writeFile(wb, `Leads Shared ${label}.xlsx`);
  toast("Leads workbook downloaded");
}

/* ============================ admin: plan vs achievement ============================ */
function renderAchievement() {
  const date = $("achieve-date").value || todayISO();
  const rosterList = state.team.length ? state.team : [];
  const rowsForDate = state.meetings.filter((r) => r.date === date);
  const plansForDate = state.plans.filter((p) => p.planDate === date);

  // "Channel" = Wealth Manager / Channel Partner. "Customer" = Investor.
  // "New" = First meeting. "Follow-up" = Follow-up meeting. Same four
  // buckets the RM planned against, so Planned and Actual are apples to apples.
  const isChannel = (r) => r.personType === "Wealth Manager" || r.personType === "Channel Partner";
  const bucketOf = (r) => {
    const chan = isChannel(r) ? "Channel" : "Customer";
    const stage = r.meetingType === "Follow-up" ? "fu" : "new";
    return stage === "new" ? (chan === "Channel" ? "newChannel" : "newCustomer") : (chan === "Channel" ? "fuChannel" : "fuCustomer");
  };

  const actualByEmail = new Map();
  rowsForDate.forEach((r) => {
    const email = r.rmEmail;
    if (!actualByEmail.has(email)) actualByEmail.set(email, { newChannel: 0, newCustomer: 0, fuChannel: 0, fuCustomer: 0, total: 0 });
    const bucket = actualByEmail.get(email);
    bucket[bucketOf(r)]++;
    bucket.total++;
  });
  const plannedByEmail = new Map();
  plansForDate.forEach((p) => plannedByEmail.set(p.rmEmail, p));

  const people = rosterList.length ? rosterList
    : [...new Set([...actualByEmail.keys(), ...plannedByEmail.keys()])].map((email) => ({ email, name: email }));

  const cell = (planned, actual) => `<td class="num">${planned || 0} / ${actual || 0}</td>`;

  const body = people.map((u) => {
    const p = plannedByEmail.get(u.email) || {};
    const a = actualByEmail.get(u.email) || {};
    const plannedTotal = PLAN_FIELDS.reduce((sum, k) => sum + (p[k] || 0), 0);
    const actualTotal = a.total || 0;
    const pct = plannedTotal ? Math.round((actualTotal / plannedTotal) * 100) : null;
    return `<tr><td class="name">${esc(u.name || u.email)}</td>
      ${cell(p.newChannel, a.newChannel)}${cell(p.newCustomer, a.newCustomer)}
      ${cell(p.fuChannel, a.fuChannel)}${cell(p.fuCustomer, a.fuCustomer)}
      <td class="num">${plannedTotal} / ${actualTotal}</td>
      <td class="num">${pct === null ? "—" : pct + "%"}</td></tr>`;
  }).join("");

  $("tbl-achieve").innerHTML = `<thead><tr>
    <th>Relationship manager</th>
    <th class="num">New Channel<br><span class="th-sub">Planned / Actual</span></th>
    <th class="num">New Customer<br><span class="th-sub">Planned / Actual</span></th>
    <th class="num">Follow-up Channel<br><span class="th-sub">Planned / Actual</span></th>
    <th class="num">Follow-up Customer<br><span class="th-sub">Planned / Actual</span></th>
    <th class="num">Total<br><span class="th-sub">Planned / Actual</span></th>
    <th class="num">Achievement</th>
    </tr></thead><tbody>${body || `<tr><td colspan="7" class="empty">No one on the team yet.</td></tr>`}</tbody>`;
}

/* ============================ admin: team ============================ */
function populateRoleOptions() {
  $("t-role").innerHTML = [["rm", "Relationship manager"], ["observer", "Observer"], ["admin", "Admin"], ["superadmin", "Super Admin"]]
    .map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("");
}

$("team-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("team-error");
  err.hidden = true;
  const email = $("t-email").value.trim().toLowerCase();
  const name = $("t-name").value.trim();
  const designation = $("t-designation").value.trim();
  const employeeId = $("t-employeeId").value.trim();
  const role = $("t-role").value;

  if (!email.endsWith("@" + ORG_DOMAIN.toLowerCase())) {
    err.textContent = `That address isn't on @${ORG_DOMAIN}. Only work accounts can sign in.`;
    err.hidden = false;
    return;
  }
  if (!name) { err.textContent = "Add a full name — it's what shows up in reports."; err.hidden = false; return; }
  if (!designation) { err.textContent = "Add a designation — it appears on every export."; err.hidden = false; return; }
  if (!employeeId) { err.textContent = "Add an employee ID."; err.hidden = false; return; }

  try {
    await setDoc(doc(db, "users", email), { email, name, designation, employeeId, role, active: true });
    toast(`${name} added`);
    $("team-form").reset();
    populateRoleOptions();
    await loadTeam();
    renderTeam();
  } catch (e2) {
    err.textContent = "Couldn't add them. " + (e2.message || "");
    err.hidden = false;
  }
});

function renderTeam() {
  const editable = isSuperAdmin();
  $("team-add-card").hidden = !editable;
  $("team-readonly-note").hidden = editable;

  const roleOptions = (current) =>
    [["rm", "RM"], ["observer", "Observer"], ["admin", "Admin"], ["superadmin", "Super Admin"]]
      .map(([v, l]) => `<option value="${v}"${v === current ? " selected" : ""}>${esc(l)}</option>`).join("");

  $("tbl-team").innerHTML = `<thead><tr>
    <th>Name</th><th>Email</th><th>Designation</th><th>Employee ID</th><th>Role</th>
    <th>Status</th><th class="num">Meetings logged</th><th></th>
    </tr></thead><tbody>${
      state.team.length ? state.team.map((u) => {
        const count = state.meetings.filter((r) => r.rmEmail === u.email).length;
        const self = u.email === state.user.email;
        const canManage = editable && !self;
        const roleCell = canManage
          ? `<select class="role-select" data-role="${esc(u.email)}">${roleOptions(u.role)}</select>`
          : `<span class="tag ${u.role === "superadmin" || u.role === "admin" ? "tag-green" : u.role === "observer" ? "tag-amber" : u.role === "founder" ? "tag-amber" : "tag-flat"}">${roleLabel(u.role)}</span>`;
        return `<tr>
          <td class="name">${esc(u.name || "—")}</td><td>${esc(u.email)}</td>
          <td>${esc(u.designation || "—")}</td><td>${esc(u.employeeId || "—")}</td>
          <td>${roleCell}</td>
          <td><span class="tag ${u.active === false ? "tag-rust" : "tag-flat"}">${u.active === false ? "No access" : "Active"}</span></td>
          <td class="num">${count}</td>
          <td>${canManage ? `<button class="btn-link${u.active === false ? "" : " danger"}" data-toggle="${esc(u.email)}">${u.active === false ? "Restore access" : "Remove access"}</button>` : ""}</td>
        </tr>`;
      }).join("") : `<tr><td colspan="8" class="empty">Nobody added yet.</td></tr>`
    }</tbody>`;

  $("tbl-team").querySelectorAll("[data-role]").forEach((sel) =>
    sel.addEventListener("change", async () => {
      const email = sel.dataset.role;
      const u = state.team.find((x) => x.email === email);
      const newRole = sel.value;
      if (!u || newRole === u.role) return;
      try {
        await updateDoc(doc(db, "users", email), { role: newRole });
        toast(`${u.name || email} is now ${roleLabel(newRole)}`);
        await loadTeam();
        renderTeam();
      } catch (e) {
        sel.value = u.role;   // put it back — the write was rejected
        toast("Couldn't change that role. " + (e.message || ""));
      }
    }));

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
