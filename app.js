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

const state = { user: null, profile: null, meetings: [], team: [], plans: [], contacts: [], leads: [], myLeads: [], reportEmails: [], page: null, editingId: null };
const isAdminOrAbove = () => state.profile && ["admin", "superadmin"].includes(state.profile.role);
const isObserver = () => state.profile && state.profile.role === "observer";
const isTeamLead = () => state.profile && state.profile.role === "teamlead";
// Everyone who sees Master + Team roster: Admin, Superadmin, and Observer.
// Observer stops there — no logging, no editing, view + download only.
const canViewAll = () => isAdminOrAbove() || isObserver();
// True whenever state.meetings/state.contacts holds more than just this
// person's own rows — everyone canViewAll() covers, plus Team Lead (their
// reports). Used to decide whether a view should narrow back down to
// "just me," not to decide what got loaded in the first place.
const hasWideView = () => canViewAll() || isTeamLead();
// Leads are more sensitive than the contacts registry — Observer is
// excluded here even though they pass canViewAll() for everything else.
// Team Lead sees their reports' leads, scoped, via a separate branch.
const canSeeAllLeads = () => isAdminOrAbove();
const canSeeTeamLeads = () => canSeeAllLeads() || isTeamLead();
const canLogHere = () => state.profile && ["rm", "admin", "superadmin", "teamlead"].includes(state.profile.role);
const isSuperAdmin = () => state.profile && state.profile.role === "superadmin";
const roleLabel = (r) => r === "superadmin" ? "Super Admin" : r === "admin" ? "Admin" : r === "teamlead" ? "Team Lead" : r === "observer" ? "Observer" : r === "founder" ? "Founder (legacy)" : "RM";

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

// Source column, with the actual detail alongside the bare category —
// "Reference — Rohan Shah" instead of just "Reference".
function sourceDetail(r) {
  if (!r.source) return "—";
  if (r.source === "Reference" && r.referenceName) return `Reference — ${r.referenceName}`;
  if (r.sourceContactId) return `${r.source} — ${r.sourceContactName || r.sourceContactId}`;
  if (r.source === "Other" && r.sourceOther) return `Other — ${r.sourceOther}`;
  return r.source;
}

// Next Stage column. A meeting's own `progressed` field still covers
// Investor rows directly. For WM/CP rows where leads carry their own
// status instead, roll those up into "2 of 3 done" so the column stays
// meaningful instead of going blank.
function nextStageDisplay(r, allLeads) {
  const wmcp = r.personType === "Wealth Manager" || r.personType === "Channel Partner";
  if (wmcp && r.shared === "Yes") {
    const rLeads = (allLeads || []).filter((l) => l.meetingId === r.id);
    if (!rLeads.length) return "—";
    const done = rLeads.filter((l) => l.status === "Meeting Done").length;
    return `${done} of ${rLeads.length} done`;
  }
  return r.progressed || "—";
}

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
  show(hasWideView() ? "master" : "log");
});

/* ============================ navigation ============================ */
function buildTabs() {
  const tabs = isAdminOrAbove()
    ? [["master", "Master"], ["log", "My meetings"], ["team", "Team"], ["contacts", "Contacts"]]
    : isTeamLead()
    ? [["master", "Master"], ["log", "My meetings"], ["contacts", "Contacts"]]
    : isObserver()
    ? [["master", "Master"], ["team", "Team"], ["contacts", "Contacts"]]
    : [["log", "My meetings"], ["contacts", "Contacts"]];
  $("tabs").innerHTML = tabs.map(([id, label]) =>
    `<button class="tab" role="tab" data-page="${id}" aria-selected="false">${label}</button>`).join("");
  $("tabs").querySelectorAll(".tab").forEach((b) =>
    b.addEventListener("click", () => show(b.dataset.page)));
}

function show(page) {
  state.page = page;
  ["log", "master", "team", "contacts"].forEach((p) => { $("page-" + p).hidden = p !== page; });
  $("tabs").querySelectorAll(".tab").forEach((b) =>
    b.setAttribute("aria-selected", String(b.dataset.page === page)));
  if (page === "log") renderLog();
  if (page === "master") { populateMasterRmFilter(); renderMaster(); }
  if (page === "team") { populateRoleOptions(); renderTeam(); }
  if (page === "contacts") renderContacts();
}

/* ============================ data ============================ */
async function loadAll() {
  await loadMyReports();   // must resolve first — everything else below depends on it
  await Promise.all([
    loadMeetings(),
    loadPlans(),
    loadContacts(),
    loadLeads(),
    canViewAll() ? loadTeam() : Promise.resolve()
  ]);
}

// A Team Lead's direct reports — the whole basis for their scoped view.
// Firestore's `in` operator caps at 30 values; fine for a direct-report
// list, but if a Team Lead ever manages more than that, only the first
// 30 would be included in the wide-scope queries below.
async function loadMyReports() {
  if (!isTeamLead()) { state.reportEmails = []; return; }
  const snap = await getDocs(query(collection(db, "users"), where("managedBy", "==", state.user.email)));
  const reports = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  state.reportEmails = reports.map((u) => u.email);
  // Team Lead never calls loadTeam() (that's the full org roster) — this
  // is their own scoped roster instead: themselves plus their reports.
  state.team = [{ ...state.profile, email: state.user.email }, ...reports]
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
}

// Team Lead's "in" scope: their own email plus every direct report's.
// Capped at 30 to match Firestore's `in` operator limit.
function scopeEmails() {
  return [state.user.email, ...state.reportEmails].slice(0, 30);
}

async function loadMeetings() {
  const col = collection(db, "meetings");
  // Single-field constraints only — no composite index needed.
  const q = canViewAll() ? col
    : isTeamLead() ? query(col, where("rmEmail", "in", scopeEmails()))
    : query(col, where("rmEmail", "==", state.user.email));
  const snap = await getDocs(q);
  state.meetings = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((x, y) => (y.date || "").localeCompare(x.date || ""));
}

async function loadPlans() {
  const col = collection(db, "plans");
  const q = canViewAll() ? col
    : isTeamLead() ? query(col, where("rmEmail", "in", scopeEmails()))
    : query(col, where("rmEmail", "==", state.user.email));
  const snap = await getDocs(q);
  state.plans = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function loadTeam() {
  const snap = await getDocs(collection(db, "users"));
  state.team = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
}

// Contacts registry: RM sees only what they created; Team Lead sees their
// own plus their reports'; everyone else (including Observer) sees all —
// less sensitive than the leads below.
async function loadContacts() {
  const col = collection(db, "contacts");
  const q = canViewAll() ? col
    : isTeamLead() ? query(col, where("createdByEmail", "in", scopeEmails()))
    : query(col, where("createdByEmail", "==", state.user.email));
  const snap = await getDocs(q);
  state.contacts = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
}

// Leads: RM sees only their own. Team Lead sees their own plus their
// reports'. Admin/Superadmin see all. Observer gets neither branch here —
// state.myLeads stays empty and state.leads is never fetched for them,
// on top of the rules blocking it anyway.
async function loadLeads() {
  if (!canLogHere() && !canSeeAllLeads()) { state.myLeads = []; state.leads = []; return; }
  const col = collection(db, "leads");
  const mine = await getDocs(query(col, where("rmEmail", "==", state.user.email)));
  state.myLeads = mine.docs.map((d) => ({ id: d.id, ...d.data() }));
  if (canSeeAllLeads()) {
    const all = await getDocs(col);
    state.leads = all.docs.map((d) => ({ id: d.id, ...d.data() }));
  } else if (isTeamLead()) {
    const team = await getDocs(query(col, where("rmEmail", "in", scopeEmails())));
    state.leads = team.docs.map((d) => ({ id: d.id, ...d.data() }));
  } else {
    state.leads = [];
  }
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
fillSelect($("f-contactMode"), OPTIONS.contactMode);
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
  toggleContactMode();
  toggleLeadsSection();
}

// The Wealth Manager / Channel Partner registry. Investor never uses this —
// every investor is logged fresh, there's no "existing investor" concept.
let resolvedContact = null;   // the looked-up contacts/{id} doc, once Existing succeeds

const isWmCp = () => $("f-personType").value === "Wealth Manager" || $("f-personType").value === "Channel Partner";
const contactPrefix = () => $("f-personType").value === "Wealth Manager" ? "WM" : "CP";

function setContactFieldsEditable(editable) {
  ["f-prospectName", "f-phone", "f-email", "f-address"].forEach((id) => { $(id).readOnly = !editable; });
}

// Follow-up on a WM/CP almost always means "we already know this contact,"
// so default to Existing there and New on a first meeting — but only ever
// as a starting point. Once the RM picks a mode themselves, later changing
// the meeting type won't silently flip their choice back.
let contactModeTouched = false;

function toggleContactMode() {
  const on = isWmCp();
  $("field-contact-mode").hidden = !on;
  if (!on) {
    $("field-contact-lookup").hidden = true;
    resolvedContact = null;
    setContactFieldsEditable(true);
    return;
  }
  $("contact-id-prefix").textContent = contactPrefix() + "-";
  if (!contactModeTouched) {
    $("f-contactMode").value = $("f-meetingType").value === "Follow-up" ? "Existing" : "New";
  }
  applyContactMode();
}

function applyContactMode() {
  const existing = $("f-contactMode").value === "Existing";
  $("field-contact-lookup").hidden = !existing;
  if (!existing) {
    resolvedContact = null;
    $("f-contactId").value = "";
    $("contact-lookup-status").hidden = true;
    setContactFieldsEditable(true);
  } else {
    setContactFieldsEditable(false);
    if (!resolvedContact) {
      $("f-prospectName").value = ""; $("f-phone").value = ""; $("f-email").value = ""; $("f-address").value = "";
    }
  }
}

async function lookupContact() {
  const status = $("contact-lookup-status");
  const digits = phoneDigitsOf($("f-contactId").value);
  resolvedContact = null;
  setContactFieldsEditable(false);
  $("f-prospectName").value = ""; $("f-phone").value = ""; $("f-email").value = ""; $("f-address").value = "";
  status.hidden = false;
  if (digits.length !== 10) { status.textContent = "Enter the full 10-digit number."; return; }
  const idVal = `${contactPrefix()}-${digits}`;
  try {
    const snap = await getDoc(doc(db, "contacts", idVal));
    if (!snap.exists()) { status.textContent = "No contact found with that ID."; return; }
    const c = snap.data();
    resolvedContact = { id: idVal, ...c };
    $("f-prospectName").value = c.name || "";
    $("f-phone").value = c.phone || "";
    $("f-email").value = c.email || "";
    $("f-address").value = c.address || "";
    status.textContent = `Found: ${c.name}`;
  } catch (e) {
    status.textContent = "You don't have access to that contact, or it doesn't exist.";
  }
}

$("f-contactMode").addEventListener("change", () => { contactModeTouched = true; applyContactMode(); });
$("f-meetingType").addEventListener("change", toggleContactMode);
$("btn-lookup-contact").addEventListener("click", lookupContact);

// Prospect source = Reference → ask who referred them.
function toggleReferenceField() {
  const on = $("f-source").value === "Reference";
  $("field-reference").hidden = !on;
  $("f-referenceName").required = on;
  if (!on) $("f-referenceName").value = "";
}

function toggleSourceOtherField() {
  const on = $("f-source").value === "Other";
  $("field-source-other").hidden = !on;
  $("f-sourceOther").required = on;
  if (!on) $("f-sourceOther").value = "";
}

// Source = Wealth Manager / Channel Partner → which one, exactly, by ID.
// Same prefix-badge pattern as the New/Existing contact lookup on this form.
let resolvedSourceContact = null;

function sourceContactPrefix() {
  return $("f-source").value === "Wealth Manager" ? "WM" : "CP";
}

function toggleSourceContactField() {
  const on = $("f-source").value === "Wealth Manager" || $("f-source").value === "Channel Partner";
  $("field-source-contact").hidden = !on;
  if (!on) {
    resolvedSourceContact = null;
    $("f-sourceContactId").value = "";
    $("source-contact-status").hidden = true;
    return;
  }
  $("source-contact-prefix").textContent = sourceContactPrefix() + "-";
}

async function lookupSourceContact() {
  const status = $("source-contact-status");
  const digits = phoneDigitsOf($("f-sourceContactId").value);
  resolvedSourceContact = null;
  status.hidden = false;
  if (digits.length !== 10) { status.textContent = "Enter the full 10-digit number."; return; }
  const idVal = `${sourceContactPrefix()}-${digits}`;
  try {
    const snap = await getDoc(doc(db, "contacts", idVal));
    if (!snap.exists()) { status.textContent = "No contact found with that ID."; return; }
    const c = snap.data();
    resolvedSourceContact = { id: idVal, ...c };
    status.textContent = `Found: ${c.name}`;
  } catch (e) {
    status.textContent = "You don't have access to that contact, or it doesn't exist.";
  }
}
$("btn-lookup-source").addEventListener("click", lookupSourceContact);

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
  $("field-progressed").hidden = !on;
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
    wrap.innerHTML = currentLeads.map((l, i) => {
      const done = l.status === "Meeting Done";
      return `
      <div class="lead-row">
        <input class="lr-name" type="text" placeholder="Lead name" value="${esc(l.name)}" data-lead-name="${i}" />
        <input class="lr-phone" type="tel" placeholder="10-digit mobile" value="${esc(l.phone)}" data-lead-phone="${i}" />
        <select class="lr-status" data-lead-status="${i}">
          ${OPTIONS.leadStatus.map((s) => `<option value="${s}"${s === l.status ? " selected" : ""}>${s}</option>`).join("")}
        </select>
        <input class="lr-date" type="date" ${done ? `max="${todayISO()}"` : ""}
          title="${done ? "Date the meeting happened" : "Expected meeting date — can be in the future"}"
          value="${esc(l.date || "")}" data-lead-date="${i}" required />
        <button type="button" class="btn-link danger lr-remove" data-lead-remove="${i}">Remove</button>
      </div>`;
    }).join("");
  }
  wrap.querySelectorAll("[data-lead-name]").forEach((el) =>
    el.addEventListener("input", () => { currentLeads[+el.dataset.leadName].name = el.value; }));
  wrap.querySelectorAll("[data-lead-phone]").forEach((el) =>
    el.addEventListener("input", () => { currentLeads[+el.dataset.leadPhone].phone = el.value; }));
  wrap.querySelectorAll("[data-lead-status]").forEach((el) =>
    el.addEventListener("change", () => {
      const lead = currentLeads[+el.dataset.leadStatus];
      lead.status = el.value;
      // Switching to Done can leave a future-dated Pending date behind —
      // that's no longer valid, so clear it rather than silently keep it.
      if (lead.status === "Meeting Done" && lead.date && lead.date > todayISO()) lead.date = "";
      renderLeadsList();
    }));
  wrap.querySelectorAll("[data-lead-date]").forEach((el) =>
    el.addEventListener("change", () => { currentLeads[+el.dataset.leadDate].date = el.value; }));
  wrap.querySelectorAll("[data-lead-remove]").forEach((el) =>
    el.addEventListener("click", () => { currentLeads.splice(+el.dataset.leadRemove, 1); renderLeadsList(); }));
}

$("btn-add-lead").addEventListener("click", () => {
  currentLeads.push({ name: "", phone: "", status: OPTIONS.leadStatus[1], date: "" });
  renderLeadsList();
});

$("f-personType").addEventListener("change", syncLabels);
$("f-source").addEventListener("change", () => { toggleReferenceField(); toggleSourceContactField(); toggleSourceOtherField(); });
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
  resolvedContact = null;
  resolvedSourceContact = null;
  contactModeTouched = false;
  $("meeting-form").reset();
  $("f-prospectName").value = "";
  $("f-phone").value = "";
  $("f-email").value = "";
  $("f-address").value = "";
  $("f-date").max = todayISO();
  $("f-date").value = todayISO();
  $("f-id").value = "";
  setContactFieldsEditable(true);
  $("contact-lookup-status").hidden = true;
  $("source-contact-status").hidden = true;
  $("btn-save").textContent = "Save meeting";
  $("btn-cancel").hidden = true;
  $("form-error").hidden = true;
  syncLabels();
  toggleReferenceField();
  toggleSourceContactField();
  toggleSourceOtherField();
  toggleNotInterestedField();
  toggleSharedProgressed();
}

const phoneDigitsOf = (v) => (v || "").replace(/\D/g, "");
const meetingDocId = (date, phone) => `${date}_${phoneDigitsOf(phone)}`;

$("meeting-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("form-error");
  err.hidden = true;

  const wmcp = isWmCp();
  const leadsApply = wmcp && $("f-shared").value === "Yes";
  const contactMode = wmcp ? $("f-contactMode").value : "";

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
    sourceOther: $("f-source").value === "Other" ? $("f-sourceOther").value.trim() : "",
    sourceContactId: "", sourceContactName: "",   // filled in below once validated
    result: $("f-result").value,
    notInterestedReason: $("f-result").value === "Not Interested" ? $("f-notInterestedReason").value : "",
    shared: $("f-result").value === "Interested" ? $("f-shared").value : "",
    progressed: $("f-shared").value === "Yes" ? $("f-progressed").value : "",
    contactMode, contactId: "",   // contactId filled in once resolved below
    followUpDate: $("f-followUpDate").value,
    remarks: $("f-remarks").value.trim(),
    rmEmail: state.user.email,
    rmName: state.profile.name || state.user.email
  };

  const required = [
    ["date", "date"], ["prospectName", "name"], ["personType", "meeting person type"],
    ["phone", "phone"], ["address", "address"],
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
  if (payload.source === "Other" && !payload.sourceOther) {
    err.textContent = "Specify the prospect source.";
    err.hidden = false;
    return;
  }
  if ((payload.source === "Wealth Manager" || payload.source === "Channel Partner") && !resolvedSourceContact) {
    err.textContent = "Look up the contact who referred this prospect before saving.";
    err.hidden = false;
    return;
  }
  if (resolvedSourceContact) {
    payload.sourceContactId = resolvedSourceContact.id;
    payload.sourceContactName = resolvedSourceContact.name || "";
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
  if (payload.shared === "Yes" && !leadsApply && !payload.progressed) {
    err.textContent = "Say whether the meeting is done or still pending.";
    err.hidden = false;
    return;
  }
  if (payload.phone.length !== 10) {
    err.textContent = "Enter a valid 10-digit phone number.";
    err.hidden = false;
    return;
  }
  if (payload.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
    err.textContent = "Enter a valid email address.";
    err.hidden = false;
    return;
  }
  if (payload.date > todayISO()) {
    err.textContent = "The meeting date can't be in the future.";
    err.hidden = false;
    return;
  }
  if (wmcp && contactMode === "Existing" && !resolvedContact) {
    err.textContent = "Look up a valid contact ID before saving, or switch to New.";
    err.hidden = false;
    return;
  }
  let leadsToSave = [];
  if (leadsApply) {
    const bad = currentLeads.find((l) => !l.name.trim() || phoneDigitsOf(l.phone).length !== 10 || !l.date);
    if (bad) {
      err.textContent = "Every lead needs a name, a valid 10-digit mobile number, and a date.";
      err.hidden = false;
      return;
    }
    leadsToSave = currentLeads.map((l) => ({ name: l.name.trim(), phone: phoneDigitsOf(l.phone), status: l.status, date: l.date }));
  }

  const newId = meetingDocId(payload.date, payload.phone);
  const isNew = !state.editingId;
  const oldMeetingId = state.editingId;
  const oldRecord = oldMeetingId ? state.meetings.find((m) => m.id === oldMeetingId) : null;

  // First time the follow-up date actually changes, freeze the true
  // original. Further reschedules keep pointing back to that, not to
  // whatever it most recently was.
  payload.followUpDateOriginal = oldRecord ? (oldRecord.followUpDateOriginal || "") : "";
  if (oldRecord && oldRecord.followUpDate && oldRecord.followUpDate !== payload.followUpDate && !payload.followUpDateOriginal) {
    payload.followUpDateOriginal = oldRecord.followUpDate;
  }

  $("btn-save").disabled = true;
  try {
    // Wealth Manager / Channel Partner contact registry, resolved or created
    // BEFORE the meeting itself — if this fails (someone else already
    // registered this phone), nothing else gets saved.
    if (wmcp) {
      if (contactMode === "New") {
        const contactId = `${contactPrefix()}-${payload.phone}`;
        try {
          await setDoc(doc(db, "contacts", contactId), {
            name: payload.prospectName, phone: payload.phone, email: payload.email, address: payload.address,
            segment: payload.personType,
            createdByEmail: state.user.email,
            createdByEmployeeId: state.profile.employeeId || "",
            createdByName: state.profile.name || state.user.email,
            createdAt: serverTimestamp()
          });
          payload.contactId = contactId;
        } catch (ce) {
          err.textContent = "This contact is already registered. Check with your admin.";
          err.hidden = false;
          $("btn-save").disabled = false;
          return;
        }
      } else {
        payload.contactId = resolvedContact.id;
      }
    }

    await setDoc(doc(db, "meetings", newId),
      { ...payload, ...(isNew ? { createdAt: serverTimestamp() } : { updatedAt: serverTimestamp() }) },
      { merge: true });
    // Editing changed the phone or date enough to move to a different
    // document — clean up the old one so it doesn't linger as a ghost row.
    if (oldMeetingId && oldMeetingId !== newId) {
      await deleteDoc(doc(db, "meetings", oldMeetingId));
    }

    await syncLeadsForMeeting(oldMeetingId, newId, payload.date, payload.prospectName, payload.personType, leadsToSave);

    toast(isNew ? "Meeting saved" : "Meeting updated");
    resetForm();
    await loadMeetings();
    await loadLeads();
    await loadContacts();
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

// Leads live in their own collection, keyed by `${meetingId}_${leadPhone}`.
// On edit, anything that existed before but isn't in the new set gets
// deleted (removed lead, or the meeting itself moved to a new document ID).
async function syncLeadsForMeeting(oldMeetingId, newMeetingId, date, prospectName, personType, newLeadsList) {
  const oldLeadDocs = oldMeetingId ? state.myLeads.filter((l) => l.meetingId === oldMeetingId) : [];
  const newIds = new Set(newLeadsList.map((l) => `${newMeetingId}_${l.phone}`));
  for (const old of oldLeadDocs) {
    if (!newIds.has(old.id)) await deleteDoc(doc(db, "leads", old.id));
  }
  for (const l of newLeadsList) {
    const id = `${newMeetingId}_${l.phone}`;
    const prior = oldLeadDocs.find((o) => o.id === id);
    // First time the date actually changes, freeze the true original —
    // any further reschedules after that keep pointing back to it, not
    // to whatever the date happened to be most recently.
    let leadDateOriginal = prior ? (prior.leadDateOriginal || "") : "";
    if (prior && prior.leadDate && prior.leadDate !== l.date && !leadDateOriginal) {
      leadDateOriginal = prior.leadDate;
    }
    await setDoc(doc(db, "leads", id), {
      meetingId: newMeetingId, rmEmail: state.user.email, rmName: state.profile.name || state.user.email,
      rmEmployeeId: state.profile.employeeId || "",
      date, prospectName, personType,
      leadName: l.name, leadPhone: l.phone, status: l.status, leadDate: l.date,
      leadDateOriginal,
      updatedAt: serverTimestamp()
    }, { merge: true });
  }
}

function renderLog() {
  const m = $("rm-month").value || thisMonth();
  const mine = hasWideView()
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
  renderHistory(mine);
  renderMyLeads();

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
    const rLeads = state.myLeads.filter((l) => l.meetingId === r.id);
    const leads = rLeads.length
      ? `<div class="entry-leads">${rLeads.map((l) =>
          `<span class="tag tag-flat">${esc(l.leadName)} · ${esc(l.leadPhone)} · ${esc(l.status)}${l.leadDate ? " · " + esc(l.leadDate) : ""}${l.leadDateOriginal ? ` <em class="reschedule-note">(rescheduled from ${esc(l.leadDateOriginal)})</em>` : ""}</span>`).join(" ")}</div>`
      : "";
    html += `<article class="entry">
      <div class="entry-top">
        <span class="entry-name">${esc(r.prospectName)}</span>
        ${resultTag(r.result)}
        ${r.shared === "Yes" ? `<span class="tag tag-flat">${r.personType === "Investor" ? "Docs in" : "Lead in"}</span>` : ""}
        ${r.progressed === "Yes" ? `<span class="tag tag-green">${r.personType === "Investor" ? "Logged in" : "Met"}</span>` : ""}
      </div>
      <div class="entry-meta">${bits} · ${esc(r.phone)}${r.email ? " · " + esc(r.email) : ""} · ${esc(r.address)}</div>
      ${r.result === "Not Interested" && r.notInterestedReason ? `<div class="entry-remarks">Why: ${esc(r.notInterestedReason)}</div>` : ""}
      ${r.source === "Reference" && r.referenceName ? `<div class="entry-remarks">Referred by: ${esc(r.referenceName)}</div>` : ""}
      ${r.sourceContactId ? `<div class="entry-remarks">Referred by: ${esc(r.sourceContactName)} (${esc(r.sourceContactId)})</div>` : ""}
      ${r.source === "Other" && r.sourceOther ? `<div class="entry-remarks">Source: ${esc(r.sourceOther)}</div>` : ""}
      ${leads}
      ${r.remarks ? `<div class="entry-remarks">${esc(r.remarks)}</div>` : ""}
    </article>`;
  }
  $("rm-list").innerHTML = html;
}

function startEdit(id) {
  const r = state.meetings.find((x) => x.id === id);
  if (!r) return;
  state.editingId = id;
  $("f-id").value = id;
  $("f-date").max = todayISO();
  $("f-date").value = r.date || "";
  $("f-personType").value = r.personType || "";
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

  // Reconstruct the resolved contact from the meeting's own saved fields —
  // no need to re-fetch, they were correct at save time.
  if (r.contactId) {
    resolvedContact = { id: r.contactId, name: r.prospectName, phone: r.phone, email: r.email, address: r.address };
  } else {
    resolvedContact = null;
  }
  $("f-contactMode").value = r.contactMode || "New";
  contactModeTouched = true;
  $("f-contactId").value = r.contactId ? r.contactId.split("-")[1] || "" : "";
  $("contact-lookup-status").hidden = true;

  if (r.sourceContactId) {
    resolvedSourceContact = { id: r.sourceContactId, name: r.sourceContactName || "" };
    $("f-sourceContactId").value = r.sourceContactId.split("-")[1] || "";
  } else {
    resolvedSourceContact = null;
    $("f-sourceContactId").value = "";
  }
  $("source-contact-status").hidden = true;

  $("f-prospectName").value = r.prospectName || "";
  $("f-phone").value = r.phone || "";
  $("f-email").value = r.email || "";
  $("f-address").value = r.address || "";

  currentLeads = state.myLeads.filter((l) => l.meetingId === id)
    .map((l) => ({ name: l.leadName, phone: l.leadPhone, status: l.status, date: l.leadDate }));

  $("btn-save").textContent = "Update meeting";
  $("btn-cancel").hidden = false;
  $("f-sourceOther").value = r.sourceOther || "";
  syncLabels();
  toggleReferenceField();
  toggleSourceContactField();
  toggleSourceOtherField();
  toggleNotInterestedField();
  toggleSharedProgressed();
  // toggleSharedProgressed already re-enabled/disabled shared+progressed
  // based on result, but startEdit needs the loaded values to survive that.
  $("f-shared").value = r.shared || "";
  $("f-progressed").value = r.progressed || "";
  toggleContactMode();
  toggleLeadsSection();
  window.scrollTo({ top: 0, behavior: "smooth" });
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
// Monday–Sunday containing a given reference date, as ISO date strings.
function weekBoundsAround(refDate) {
  const d = new Date(refDate);
  const dow = d.getDay();                     // 0=Sun..6=Sat
  const toMonday = dow === 0 ? -6 : 1 - dow;   // days to subtract to reach Monday
  const mon = new Date(d); mon.setDate(d.getDate() + toMonday);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  const iso = (x) => `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
  return { start: iso(mon), end: iso(sun) };
}

let followupsRef = new Date();   // which week is currently on screen

$("btn-week-prev").addEventListener("click", () => { followupsRef.setDate(followupsRef.getDate() - 7); renderLog(); });
$("btn-week-next").addEventListener("click", () => { followupsRef.setDate(followupsRef.getDate() + 7); renderLog(); });
$("btn-week-today").addEventListener("click", () => { followupsRef = new Date(); renderLog(); });

function renderFollowups(mine) {
  const { start, end } = weekBoundsAround(followupsRef);
  $("followups-range-label").textContent = `${fmtDay(start)} – ${fmtDay(end)}`;

  // Two sources: a meeting's own follow-up date, and any pending lead's
  // expected date — both are "something to chase this week."
  const fromMeetings = mine
    .filter((r) => r.followUpDate && r.followUpDate >= start && r.followUpDate <= end)
    .map((r) => ({
      kind: "meeting", date: r.followUpDate, name: r.prospectName,
      meta: `${r.personType}${r.phone ? " · " + r.phone : ""}`, note: r.remarks || "",
      rescheduledFrom: r.followUpDateOriginal || ""
    }));
  const fromLeads = state.myLeads
    .filter((l) => l.status === "Pending" && l.leadDate && l.leadDate >= start && l.leadDate <= end)
    .map((l) => ({
      kind: "lead", date: l.leadDate, name: l.leadName,
      meta: `Lead via ${l.prospectName} (${l.personType})${l.leadPhone ? " · " + l.leadPhone : ""}`, note: "",
      rescheduledFrom: l.leadDateOriginal || ""
    }));
  const due = [...fromMeetings, ...fromLeads].sort((a, b) => a.date.localeCompare(b.date));

  if (!due.length) {
    $("followups-list").innerHTML = `<p class="followups-empty">Nothing due this week.</p>`;
    return;
  }
  $("followups-list").innerHTML = due.map((f) => `
    <article class="fu-item">
      <div class="fu-top">
        <span class="fu-name">${esc(f.name)}</span>
        ${f.kind === "lead" ? `<span class="tag tag-amber">Lead</span>` : ""}
        <span class="fu-date">${esc(fmtDay(f.date))}</span>
      </div>
      <div class="fu-meta">${esc(f.meta)}${f.note ? " · " + esc(f.note) : ""}</div>
      ${f.rescheduledFrom ? `<div class="reschedule-note">Rescheduled from ${esc(fmtDay(f.rescheduledFrom))} → ${esc(fmtDay(f.date))}</div>` : ""}
    </article>`).join("");
}

/* ============================ RM: my history sub-tab ============================ */
let logSub = "log";
$("log-subtabs").querySelectorAll(".subtab").forEach((b) =>
  b.addEventListener("click", () => {
    logSub = b.dataset.sub;
    $("log-subtabs").querySelectorAll(".subtab").forEach((x) =>
      x.setAttribute("aria-selected", String(x === b)));
    $("log-panel-log").hidden = logSub !== "log";
    $("log-panel-history").hidden = logSub !== "history";
    $("log-panel-leads").hidden = logSub !== "leads";
  }));

$("history-month").value = thisMonth();
$("history-month").max = thisMonth();
$("history-from").max = todayISO();
$("history-to").max = todayISO();
$("history-month").addEventListener("change", () => {
  $("history-from").value = ""; $("history-to").value = "";
  renderLog();
});
$("history-from").addEventListener("change", () => {
  const from = $("history-from").value;
  $("history-to").min = from;
  if (from && $("history-to").value && $("history-to").value < from) $("history-to").value = from;
  renderLog();
});
$("history-to").addEventListener("change", renderLog);
$("btn-export-history").addEventListener("click", exportMyHistory);

// Same custom-range-wins-else-month logic as Master, scoped to these three fields.
function historyRange() {
  const from = $("history-from").value, to = $("history-to").value;
  if (from && to && from <= to) return { from, to, label: `${from} to ${to}` };
  const m = $("history-month").value || thisMonth();
  const { from: mf, to: mt } = monthBounds(m);
  const label = new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1)
    .toLocaleDateString(undefined, { month: "long", year: "numeric" });
  return { from: mf, to: mt, label };
}

function renderHistory(mine) {
  const { from, to, label } = historyRange();
  const rows = [...mine].filter((r) => r.date >= from && r.date <= to)
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  $("history-sub").textContent = `${label} · ${rows.length} meeting${rows.length === 1 ? "" : "s"}.`;
  $("history-count").textContent = `${rows.length} row${rows.length === 1 ? "" : "s"}`;

  $("tbl-history").innerHTML = `<thead><tr>
    <th>Date</th><th>Name</th><th>Type</th><th>Meeting</th><th>Mode</th>
    <th>Phone</th><th>Email</th><th>Address</th><th>Source</th><th>Result</th>
    <th>Lead / docs</th><th>Next stage</th><th>Follow-up</th><th>Remarks</th><th></th>
    </tr></thead><tbody>${
      rows.length ? rows.map((r) => `<tr>
        <td class="num">${esc(r.date)}</td><td class="name">${esc(r.prospectName)}</td>
        <td>${esc(r.personType)}</td><td>${esc(r.meetingType)}</td><td>${esc(r.mode)}</td>
        <td>${esc(r.phone || "")}</td><td>${esc(r.email || "")}</td><td class="wrap">${esc(r.address || "")}</td>
        <td>${esc(sourceDetail(r))}</td><td>${resultTag(r.result)}</td>
        <td>${esc(r.shared || "—")}</td><td>${esc(nextStageDisplay(r, state.myLeads))}</td>
        <td class="num">${esc(r.followUpDate || "")}${r.followUpDateOriginal ? ` <span class="reschedule-note">(was ${esc(r.followUpDateOriginal)})</span>` : ""}</td>
        <td class="wrap">${esc(r.remarks || "")}</td>
        <td><button class="btn-link" data-edit="${r.id}">Edit</button></td></tr>`).join("")
        : `<tr><td colspan="15" class="empty">Nothing logged in this range.</td></tr>`
    }</tbody>`;

  $("tbl-history").querySelectorAll("[data-edit]").forEach((b) =>
    b.addEventListener("click", () => {
      startEdit(b.dataset.edit);
      $('.subtab[data-sub="log"]').click();
    }));
}

function exportMyHistory() {
  if (typeof XLSX === "undefined") { toast("Excel library didn't load. Check your connection."); return; }
  const { from, to, label } = historyRange();
  const rows = state.meetings
    .filter((r) => r.rmEmail === state.user.email && r.date >= from && r.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date));

  const sheet = [["Date", "Name", "Meeting Person Type", "Phone", "Email", "Address",
    "Type of Meeting", "Mode", "Prospect source", "Reference Name", "Meeting Result",
    "Not Interested Reason", "Lead / Docs Shared", "Meeting Done / Logged In",
    "Follow up Date", "Remarks"]];
  rows.forEach((r) => sheet.push([
    r.date, r.prospectName, r.personType, r.phone || "", r.email || "", r.address || "",
    r.meetingType, r.mode, r.source || "", r.referenceName || "", r.result,
    r.notInterestedReason || "", r.shared || "", r.progressed || "", r.followUpDate || "", r.remarks || ""
  ]));
  if (sheet.length === 1) { toast("Nothing to export in that range."); return; }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet), "My Meetings");
  XLSX.writeFile(wb, `My Meetings ${label}.xlsx`);
  toast("Workbook downloaded");
}

/* ============================ RM: my leads sub-tab ============================ */
$("myleads-month").value = thisMonth();
$("myleads-month").max = thisMonth();
$("myleads-from").max = todayISO();
$("myleads-to").max = todayISO();
$("myleads-month").addEventListener("change", () => {
  $("myleads-from").value = ""; $("myleads-to").value = "";
  renderMyLeads();
});
$("myleads-from").addEventListener("change", () => {
  const from = $("myleads-from").value;
  $("myleads-to").min = from;
  if (from && $("myleads-to").value && $("myleads-to").value < from) $("myleads-to").value = from;
  renderMyLeads();
});
$("myleads-to").addEventListener("change", renderMyLeads);
$("btn-export-myleads").addEventListener("click", exportMyLeadsDownload);

function myLeadsRange() {
  const from = $("myleads-from").value, to = $("myleads-to").value;
  if (from && to && from <= to) return { from, to, label: `${from} to ${to}` };
  const m = $("myleads-month").value || thisMonth();
  const { from: mf, to: mt } = monthBounds(m);
  const label = new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1)
    .toLocaleDateString(undefined, { month: "long", year: "numeric" });
  return { from: mf, to: mt, label };
}

function renderMyLeads() {
  const { from, to, label } = myLeadsRange();
  const rows = state.myLeads.filter((l) => l.date >= from && l.date <= to)
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  $("myleads-sub").textContent = `${label} · ${rows.length} lead${rows.length === 1 ? "" : "s"}.`;
  $("myleads-count").textContent = `${rows.length} row${rows.length === 1 ? "" : "s"}`;
  $("tbl-myleads").innerHTML = `<thead><tr>
    <th>Date</th><th>Prospect</th><th>Segment</th><th>Lead name</th>
    <th>Lead phone</th><th>Status</th><th>Lead date</th>
    </tr></thead><tbody>${
      rows.length ? rows.map((l) => `<tr>
        <td class="num">${esc(l.date)}</td><td class="name">${esc(l.prospectName)}</td>
        <td>${esc(l.personType)}</td><td>${esc(l.leadName)}</td><td>${esc(l.leadPhone)}</td>
        <td>${esc(l.status)}</td><td class="num">${esc(l.leadDate || "")}</td></tr>`).join("")
        : `<tr><td colspan="7" class="empty">Nothing in this range.</td></tr>`
    }</tbody>`;
}

function exportMyLeadsDownload() {
  if (typeof XLSX === "undefined") { toast("Excel library didn't load. Check your connection."); return; }
  const { from, to, label } = myLeadsRange();
  const rows = state.myLeads.filter((l) => l.date >= from && l.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!rows.length) { toast("Nothing to export in that range."); return; }

  const sheet = [["Date", "Prospect", "Segment", "Lead Name", "Lead Phone", "Status", "Lead Date"]];
  rows.forEach((l) => sheet.push([l.date, l.prospectName, l.personType, l.leadName, l.leadPhone, l.status, l.leadDate || ""]));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet), "My Leads");
  XLSX.writeFile(wb, `My Leads ${label}.xlsx`);
  toast("Workbook downloaded");
}

/* ============================ admin: master ============================ */
// Nobody can browse into the future: month picker capped at the current
// month, custom range capped at today, and "to" can never sit before "from".
$("admin-month").max = thisMonth();
$("export-from").max = todayISO();
$("export-to").max = todayISO();
$("master-rm-filter").addEventListener("change", renderMaster);

function populateMasterRmFilter() {
  const sel = $("master-rm-filter");
  const current = sel.value;
  // Only people who have actually logged a meeting — this is what keeps
  // Observer off the list entirely, and Superadmin off it unless they've
  // genuinely logged something themselves.
  const activeEmails = new Set(state.meetings.map((r) => r.rmEmail));
  const people = state.team
    .filter((u) => activeEmails.has(u.email))
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  sel.innerHTML = `<option value="">All RMs</option>` +
    people.map((u) => `<option value="${esc(u.email)}">${esc(u.name || u.email)} (${roleLabel(u.role)})</option>`).join("");
  if (people.some((u) => u.email === current)) sel.value = current;
}

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
  const rmFilter = $("master-rm-filter").value;
  const rows = state.meetings.filter((r) => r.date >= from && r.date <= to && (!rmFilter || r.rmEmail === rmFilter));
  const s = summarise(rows);

  const who = rmFilter ? (state.team.find((u) => u.email === rmFilter)?.name || rmFilter) : null;
  $("master-sub").textContent = who
    ? `${label} · ${rows.length} meeting${rows.length === 1 ? "" : "s"} · ${who} only.`
    : `${label} · ${rows.length} meeting${rows.length === 1 ? "" : "s"} across ${new Set(rows.map(r => r.rmEmail)).size} relationship manager${new Set(rows.map(r => r.rmEmail)).size === 1 ? "" : "s"}.`;

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
        <td>${esc(sourceDetail(r))}</td>
        <td>${resultTag(r.result)}</td><td>${esc(r.shared || "—")}</td>
        <td>${esc(nextStageDisplay(r, state.leads))}</td><td class="wrap">${esc(r.remarks || "")}</td></tr>`).join("")
        : `<tr><td colspan="14" class="empty">No meetings this month.</td></tr>`
    }</tbody>`;

  /* --- leads shared with the team (Admin/Superadmin see all, Team Lead sees their own reports', never Observer) --- */
  $("leads-card").hidden = !canSeeTeamLeads();
  if (canSeeTeamLeads()) {
    const leadRows = state.leads.filter((l) => l.date >= from && l.date <= to && (!rmFilter || l.rmEmail === rmFilter))
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    $("leads-count").textContent = `${leadRows.length} lead${leadRows.length === 1 ? "" : "s"}`;
    $("tbl-leads").innerHTML = `<thead><tr>
      <th>Date</th><th>RM</th><th>Prospect</th><th>Segment</th>
      <th>Lead name</th><th>Lead phone</th><th>Status</th><th>Lead date</th>
      </tr></thead><tbody>${
        leadRows.length ? leadRows.map((l) => `<tr>
          <td class="num">${esc(l.date)}</td><td>${esc(l.rmName)}</td><td class="name">${esc(l.prospectName)}</td>
          <td>${esc(l.personType)}</td><td>${esc(l.leadName)}</td><td>${esc(l.leadPhone)}</td>
          <td>${esc(l.status)}</td><td class="num">${esc(l.leadDate || "")}</td></tr>`).join("")
          : `<tr><td colspan="8" class="empty">No leads shared in this range.</td></tr>`
      }</tbody>`;
  }
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
  const rmFilter = $("master-rm-filter").value;
  const rows = state.meetings.filter((r) => r.date >= from && r.date <= to && (!rmFilter || r.rmEmail === rmFilter));

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
// travel in every routine export. state.leads is only ever populated for
// Admin/Superadmin (see loadLeads) — Observer has nothing to export here
// even if this somehow got triggered.
function exportLeads() {
  if (typeof XLSX === "undefined") { toast("Excel library didn't load. Check your connection."); return; }
  const { from, to, label } = exportRange();
  const rmFilter = $("master-rm-filter").value;
  const rows = state.leads.filter((l) => l.date >= from && l.date <= to && (!rmFilter || l.rmEmail === rmFilter));
  if (!rows.length) { toast("No leads shared in that range."); return; }

  const sheet = [["Date", "RM", "Prospect (source of lead)", "Segment", "Lead Name", "Lead Phone", "Status", "Lead Date"]];
  rows.forEach((l) => {
    sheet.push([l.date, l.rmName, l.prospectName, l.personType, l.leadName, l.leadPhone, l.status, l.leadDate || ""]);
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet), "Leads");
  XLSX.writeFile(wb, `Leads Shared ${label}.xlsx`);
  toast("Leads workbook downloaded");
}

/* ============================ admin: plan vs achievement ============================ */
function renderAchievement() {
  const date = $("achieve-date").value || todayISO();
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

  const people = state.team.filter((u) => {
    if (u.role === "observer") return false;                 // never goes to meetings
    if (u.role === "superadmin") return actualByEmail.has(u.email) || plannedByEmail.has(u.email);
    return true;
  });

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

/* ============================ contacts: WM / CP registry ============================ */
let selectedContacts = new Set();

$("contacts-filter").addEventListener("change", renderContacts);
$("contacts-owner-filter").addEventListener("change", renderContacts);

function populateContactsOwnerFilter() {
  const sel = $("contacts-owner-filter");
  const current = sel.value;
  const owners = new Map();   // email -> display name
  state.contacts.forEach((c) => {
    if (c.createdByEmail) owners.set(c.createdByEmail, c.createdByName || c.createdByEmail);
  });
  const list = [...owners.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  sel.innerHTML = `<option value="all">All RMs</option>` +
    list.map(([email, name]) => `<option value="${esc(email)}">${esc(name)}</option>`).join("");
  if (owners.has(current)) sel.value = current;
}

/* ============================ contacts: sub-tabs ============================ */
let contactsSub = "wmcp";
$("contacts-subtabs").querySelectorAll(".subtab").forEach((b) =>
  b.addEventListener("click", () => {
    contactsSub = b.dataset.sub;
    $("contacts-subtabs").querySelectorAll(".subtab").forEach((x) =>
      x.setAttribute("aria-selected", String(x === b)));
    $("contacts-panel-wmcp").hidden = contactsSub !== "wmcp";
    $("contacts-panel-investors").hidden = contactsSub !== "investors";
    if (contactsSub === "investors") renderInvestors();
  }));

$("investors-owner-filter").addEventListener("change", renderInvestors);

// Purely derived from state.meetings — already scoped correctly per role
// (own / own+reports / everyone) by the loaders, so no new data fetch or
// rules needed here at all.
function renderInvestors() {
  const investorRows = state.meetings.filter((r) => r.personType === "Investor");

  const ownerSel = $("investors-owner-filter");
  ownerSel.hidden = !hasWideView();
  if (hasWideView()) {
    const current = ownerSel.value;
    const owners = new Map();
    investorRows.forEach((r) => { if (r.rmEmail) owners.set(r.rmEmail, r.rmName || r.rmEmail); });
    const list = [...owners.entries()].sort((a, b) => a[1].localeCompare(b[1]));
    ownerSel.innerHTML = `<option value="all">All RMs</option>` +
      list.map(([email, name]) => `<option value="${esc(email)}">${esc(name)}</option>`).join("");
    if (owners.has(current)) ownerSel.value = current;
  }
  const ownerFilter = hasWideView() ? ownerSel.value : "all";
  const filtered = investorRows.filter((r) => ownerFilter === "all" || r.rmEmail === ownerFilter);

  // One row per unique investor (by phone) — most recent meeting wins.
  const byPhone = new Map();
  filtered.forEach((r) => {
    const key = r.phone || r.prospectName;
    const existing = byPhone.get(key);
    if (!existing || r.date > existing.date) byPhone.set(key, r);
  });
  const rows = [...byPhone.values()].sort((a, b) => (a.prospectName || "").localeCompare(b.prospectName || ""));

  $("investors-count").textContent = `${rows.length} investor${rows.length === 1 ? "" : "s"}`;
  $("tbl-investors").innerHTML = `<thead><tr>
    <th>Name</th><th>Phone</th><th>Email</th><th class="wrap">Address</th>
    <th>Met by</th><th>Last met</th><th>Result</th>
    </tr></thead><tbody>${
      rows.length ? rows.map((r) => `<tr>
        <td class="name">${esc(r.prospectName)}</td><td>${esc(r.phone || "")}</td>
        <td>${esc(r.email || "")}</td><td class="wrap">${esc(r.address || "")}</td>
        <td>${esc(r.rmName || r.rmEmail || "")}</td><td class="num">${esc(r.date || "")}</td>
        <td>${resultTag(r.result)}</td></tr>`).join("")
        : `<tr><td colspan="7" class="empty">No investors met yet.</td></tr>`
    }</tbody>`;
}

function renderContacts() {
  const mine = !hasWideView();
  const filter = $("contacts-filter").value;
  $("contacts-sub").textContent = mine
    ? "Wealth Managers and Channel Partners you've registered."
    : "Every Wealth Manager and Channel Partner on file, across the team.";

  // Owner filter only makes sense when you can see more than your own —
  // for a plain RM the answer is always "just me," so hide it entirely.
  $("contacts-owner-filter").hidden = mine;
  if (!mine) populateContactsOwnerFilter();
  const ownerFilter = mine ? "all" : $("contacts-owner-filter").value;

  const rows = state.contacts
    .filter((c) => filter === "all" || c.segment === filter)
    .filter((c) => ownerFilter === "all" || c.createdByEmail === ownerFilter)
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  $("contacts-count").textContent = `${rows.length} contact${rows.length === 1 ? "" : "s"}`;

  // Selection only makes sense for rows currently on screen.
  const visibleIds = new Set(rows.map((c) => c.id));
  selectedContacts.forEach((id) => { if (!visibleIds.has(id)) selectedContacts.delete(id); });
  updateTransferButton();

  const ownerCol = mine ? "" : "<th>Owner</th><th>Employee ID</th>";
  const checkCol = isSuperAdmin() ? "<th></th>" : "";
  const actionCol = isSuperAdmin() ? "<th></th>" : "";
  const colCount = (mine ? 6 : 8) + (isSuperAdmin() ? 2 : 0);

  $("tbl-contacts").innerHTML = `<thead><tr>
    ${checkCol}<th>ID</th><th>Name</th><th>Segment</th><th>Phone</th><th>Email</th><th class="wrap">Address</th>${ownerCol}${actionCol}
    </tr></thead><tbody>${
      rows.length ? rows.map((c) => `<tr>
        ${isSuperAdmin() ? `<td><input type="checkbox" class="contact-check" data-id="${esc(c.id)}"${selectedContacts.has(c.id) ? " checked" : ""} /></td>` : ""}
        <td class="num">${esc(c.id)}</td><td class="name">${esc(c.name)}</td><td>${esc(c.segment)}</td>
        <td>${esc(c.phone)}</td><td>${esc(c.email || "")}</td><td class="wrap">${esc(c.address || "")}</td>
        ${mine ? "" : `<td>${esc(c.createdByName || c.createdByEmail || "")}</td><td>${esc(c.createdByEmployeeId || "")}</td>`}
        ${isSuperAdmin() ? `<td><button class="btn-link danger" data-delete-contact="${esc(c.id)}">Delete</button></td>` : ""}
        </tr>`).join("")
        : `<tr><td colspan="${colCount}" class="empty">Nothing on file yet.</td></tr>`
    }</tbody>`;

  $("tbl-contacts").querySelectorAll("[data-delete-contact]").forEach((b) =>
    b.addEventListener("click", () => deleteContact(b.dataset.deleteContact)));

  $("tbl-contacts").querySelectorAll(".contact-check").forEach((cb) =>
    cb.addEventListener("change", () => {
      if (cb.checked) selectedContacts.add(cb.dataset.id); else selectedContacts.delete(cb.dataset.id);
      updateTransferButton();
    }));
}

// History stays put — past meetings and leads keep whatever name/phone was
// true at the time. Deleting only removes the ability to reference this
// contact as "Existing" going forward.
async function deleteContact(contactId) {
  const c = state.contacts.find((x) => x.id === contactId);
  if (!c) return;
  if (!confirm(`Delete ${c.name} (${contactId})? Past meetings that reference this contact keep their own saved details — this only removes it from the registry.`)) return;
  try {
    await deleteDoc(doc(db, "contacts", contactId));
    toast(`${c.name} deleted`);
    selectedContacts.delete(contactId);
    await loadContacts();
    renderContacts();
  } catch (e) {
    toast("Couldn't delete that. " + (e.message || ""));
  }
}

function updateTransferButton() {
  const btn = $("btn-transfer-selected");
  if (!isSuperAdmin()) { btn.hidden = true; return; }
  btn.hidden = false;
  btn.disabled = selectedContacts.size === 0;
  btn.textContent = selectedContacts.size ? `Transfer selected (${selectedContacts.size})` : "Transfer selected";
}

$("btn-transfer-selected").addEventListener("click", () => {
  $("transfer-count").textContent = `${selectedContacts.size} contact${selectedContacts.size === 1 ? "" : "s"}`;
  $("transfer-employee-id").value = "";
  $("transfer-match").hidden = true;
  $("btn-transfer-confirm").disabled = true;
  $("transfer-panel").hidden = false;
  $("transfer-employee-id").focus();
});
$("btn-transfer-cancel").addEventListener("click", () => { $("transfer-panel").hidden = true; });

// Resolves live, on every keystroke — no need to submit first to find out who it is.
let transferTarget = null;
$("transfer-employee-id").addEventListener("input", () => {
  const code = $("transfer-employee-id").value.trim();
  const status = $("transfer-match");
  transferTarget = code ? state.team.find((u) => (u.employeeId || "").trim() === code) : null;
  $("btn-transfer-confirm").disabled = !transferTarget;
  if (!code) { status.hidden = true; return; }
  status.hidden = false;
  status.textContent = transferTarget ? `→ ${transferTarget.name} (${roleLabel(transferTarget.role)})` : "No team member with that employee ID.";
});

$("btn-transfer-confirm").addEventListener("click", async () => {
  if (!transferTarget || !selectedContacts.size) return;
  const ids = [...selectedContacts];
  const names = ids.map((id) => state.contacts.find((c) => c.id === id)?.name || id);
  if (!confirm(`Move ${ids.length} contact${ids.length === 1 ? "" : "s"} (${names.join(", ")}) to ${transferTarget.name}?`)) return;

  $("btn-transfer-confirm").disabled = true;
  let failed = 0;
  for (const id of ids) {
    try {
      await updateDoc(doc(db, "contacts", id), {
        createdByEmail: transferTarget.email, createdByEmployeeId: transferTarget.employeeId || "", createdByName: transferTarget.name || transferTarget.email
      });
    } catch (e) { failed++; }
  }
  toast(failed ? `Transferred ${ids.length - failed} of ${ids.length} — ${failed} failed` : `Transferred ${ids.length} contact${ids.length === 1 ? "" : "s"} to ${transferTarget.name}`);
  selectedContacts.clear();
  $("transfer-panel").hidden = true;
  await loadContacts();
  renderContacts();
});

/* ============================ admin: team ============================ */
function populateRoleOptions() {
  $("t-role").innerHTML = [["rm", "Relationship manager"], ["teamlead", "Team Lead"], ["observer", "Observer"], ["admin", "Admin"], ["superadmin", "Super Admin"]]
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
    [["rm", "RM"], ["teamlead", "Team Lead"], ["observer", "Observer"], ["admin", "Admin"], ["superadmin", "Super Admin"]]
      .map(([v, l]) => `<option value="${v}"${v === current ? " selected" : ""}>${esc(l)}</option>`).join("");

  const editField = (email, field, value) =>
    `<input type="text" class="team-edit" data-field="${field}" data-email="${esc(email)}" value="${esc(value || "")}" />`;

  const managers = state.team.filter((u) => u.role === "teamlead" || u.role === "admin");
  const managerCell = (u) => {
    if (u.role !== "rm") return "—";   // only RMs report to a manager
    const opts = [`<option value=""${!u.managedBy ? " selected" : ""}>— none —</option>`]
      .concat(managers.map((m) => `<option value="${esc(m.email)}"${u.managedBy === m.email ? " selected" : ""}>${esc(m.name || m.email)} (${roleLabel(m.role)})</option>`));
    return editable
      ? `<select class="manager-select" data-manager="${esc(u.email)}">${opts.join("")}</select>`
      : esc((managers.find((m) => m.email === u.managedBy) || {}).name || "—");
  };

  $("tbl-team").innerHTML = `<thead><tr>
    <th>Name</th><th>Email</th><th>Designation</th><th>Employee ID</th><th>Role</th><th>Reports to</th>
    <th>Status</th><th class="num">Meetings logged</th><th></th>
    </tr></thead><tbody>${
      state.team.length ? state.team.map((u) => {
        const count = state.meetings.filter((r) => r.rmEmail === u.email).length;
        const self = u.email === state.user.email;
        const canManage = editable && !self;
        const roleCell = canManage
          ? `<select class="role-select" data-role="${esc(u.email)}">${roleOptions(u.role)}</select>`
          : `<span class="tag ${u.role === "superadmin" || u.role === "admin" ? "tag-green" : u.role === "teamlead" ? "tag-green" : u.role === "observer" ? "tag-amber" : u.role === "founder" ? "tag-amber" : "tag-flat"}">${roleLabel(u.role)}</span>`;
        return `<tr>
          <td class="name">${canManage ? editField(u.email, "name", u.name) : esc(u.name || "—")}</td>
          <td>${esc(u.email)}</td>
          <td>${canManage ? editField(u.email, "designation", u.designation) : esc(u.designation || "—")}</td>
          <td>${canManage ? editField(u.email, "employeeId", u.employeeId) : esc(u.employeeId || "—")}</td>
          <td>${roleCell}</td>
          <td>${managerCell(u)}</td>
          <td><span class="tag ${u.active === false ? "tag-rust" : "tag-flat"}">${u.active === false ? "No access" : "Active"}</span></td>
          <td class="num">${count}</td>
          <td>${canManage ? `<button class="btn-link${u.active === false ? "" : " danger"}" data-toggle="${esc(u.email)}">${u.active === false ? "Restore access" : "Remove access"}</button>` : ""}</td>
        </tr>`;
      }).join("") : `<tr><td colspan="9" class="empty">Nobody added yet.</td></tr>`
    }</tbody>`;

  $("tbl-team").querySelectorAll("[data-manager]").forEach((sel) =>
    sel.addEventListener("change", async () => {
      const email = sel.dataset.manager;
      const u = state.team.find((x) => x.email === email);
      if (!u) return;
      try {
        await updateDoc(doc(db, "users", email), { managedBy: sel.value });
        u.managedBy = sel.value;
        toast(sel.value ? `${u.name || email} now reports to ${(managers.find((m) => m.email === sel.value) || {}).name || sel.value}` : `${u.name || email} no longer has a manager assigned`);
      } catch (e) {
        toast("Couldn't change that. " + (e.message || ""));
      }
    }));

  $("tbl-team").querySelectorAll(".team-edit").forEach((el) => {
    el.addEventListener("blur", async () => {
      const email = el.dataset.email, field = el.dataset.field;
      const u = state.team.find((x) => x.email === email);
      const val = el.value.trim();
      if (!u || val === (u[field] || "")) return;
      if (!val) { el.value = u[field] || ""; toast("That can't be left blank."); return; }
      try {
        await updateDoc(doc(db, "users", email), { [field]: val });
        u[field] = val;   // keep local state in sync without a full reload
        toast(`Updated ${email}`);
      } catch (e) {
        el.value = u[field] || "";
        toast("Couldn't save that. " + (e.message || ""));
      }
    });
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") el.blur(); });
  });

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
