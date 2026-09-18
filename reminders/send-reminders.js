// Daily Weekly Plan digest.
// Runs once a day via GitHub Actions (see reminders.yml). Reads
// Firestore directly with a service account — the same data Meeting
// Ledger's app itself reads, just from a script instead of a browser.
//
// RM email:        today's plan + anything still "Planned" from an
//                   earlier date that never got marked Done.
// Team Lead email:  a rollup of their assigned RMs' counts.
// Admin/Superadmin: a rollup of their assigned RMs if they have any,
//                   otherwise the whole company (they can already see
//                   everyone in the app, so this mirrors that).
// Nobody gets an email on a day their own scope is entirely empty.

const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

const FROM_ADDRESS = "communication.hyperioncapital@gmail.com";
const APP_URL = "https://hyperion2804.github.io/meeting-ledger/";   // shown in the email footer — edit if your URL differs

// ---------- Firebase ----------
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ---------- Mail ----------
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: FROM_ADDRESS, pass: process.env.GMAIL_APP_PASSWORD }
});

// ---------- date helpers ----------
// Computed against IST explicitly, not the server's local time — GitHub
// Actions runs in UTC, and this keeps "today" correct regardless of
// exactly when the cron fires.
function todayIST() {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}`;
}
function fmtDMY(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

async function main() {
  const today = todayIST();

  const [usersSnap, plansSnap] = await Promise.all([
    db.collection("users").get(),
    db.collection("weeklyPlans").get()
  ]);

  const users = usersSnap.docs.map((d) => ({ email: d.id, ...d.data() })).filter((u) => u.active !== false);
  const plans = plansSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  const rms = users.filter((u) => u.role === "rm");
  const teamLeads = users.filter((u) => u.role === "teamlead");
  const admins = users.filter((u) => u.role === "admin" || u.role === "superadmin");

  let sent = 0;

  // ---------- one RM at a time ----------
  for (const rm of rms) {
    const mine = plans.filter((p) => p.rmEmail === rm.email);
    const todayEntries = mine.filter((p) => p.date === today && p.status !== "Done");
    const overdueEntries = mine.filter((p) => p.date < today && p.status !== "Done")
      .sort((a, b) => (a.date || "").localeCompare(b.date || ""));

    if (!todayEntries.length && !overdueEntries.length) continue;   // quiet day, no email

    const html = rmDigestHtml(rm, todayEntries, overdueEntries, today);
    await sendMail(rm.email, `Your plan for today — ${fmtDMY(today)}`, html);
    sent++;
  }

  // ---------- Team Leads: rollup of their assigned RMs ----------
  for (const lead of teamLeads) {
    const reports = users.filter((u) => u.managedBy === lead.email);
    const rows = teamRollupRows(reports, plans, today);
    if (!rows.some((r) => r.todayCount || r.overdueCount)) continue;   // whole team quiet, no email

    const html = teamDigestHtml(lead, rows, today);
    await sendMail(lead.email, `Your team's plan for today — ${fmtDMY(today)}`, html);
    sent++;
  }

  // ---------- Admin / Superadmin: their assigned RMs, or the whole company ----------
  for (const person of admins) {
    let reports = users.filter((u) => u.managedBy === person.email);
    if (!reports.length) reports = rms;   // no direct reports assigned — fall back to everyone, same as what they see in the app

    const rows = teamRollupRows(reports, plans, today);
    if (!rows.some((r) => r.todayCount || r.overdueCount)) continue;

    const html = teamDigestHtml(person, rows, today);
    await sendMail(person.email, `Team plan for today — ${fmtDMY(today)}`, html);
    sent++;
  }

  console.log(`Done. ${sent} email(s) sent for ${today}.`);
}

function teamRollupRows(reports, plans, today) {
  return reports.map((u) => {
    const mine = plans.filter((p) => p.rmEmail === u.email);
    const todayCount = mine.filter((p) => p.date === today && p.status !== "Done").length;
    const overdueCount = mine.filter((p) => p.date < today && p.status !== "Done").length;
    return { name: u.name || u.email, todayCount, overdueCount };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- email bodies ----------
function entryRow(p) {
  return `<tr>
    <td style="padding:6px 10px;border-bottom:1px solid #E3D9C8">${esc(p.name)}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #E3D9C8">${esc(p.personType)}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #E3D9C8">${esc(p.location)}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #E3D9C8">${esc(p.phone || "—")}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #E3D9C8;color:#8A5518">${esc(fmtDMY(p.date))}</td>
  </tr>`;
}

function rmDigestHtml(rm, todayEntries, overdueEntries, today) {
  const section = (title, rows) => !rows.length ? "" : `
    <h3 style="font-family:Arial;color:#7A4A12;margin:22px 0 8px">${title}</h3>
    <table style="width:100%;border-collapse:collapse;font-family:Arial;font-size:13px">
      <tr style="background:#7A4A12;color:#fff">
        <th style="padding:6px 10px;text-align:left">Name</th><th style="padding:6px 10px;text-align:left">Type</th>
        <th style="padding:6px 10px;text-align:left">Location</th><th style="padding:6px 10px;text-align:left">Phone</th>
        <th style="padding:6px 10px;text-align:left">Date</th>
      </tr>
      ${rows.map(entryRow).join("")}
    </table>`;
  return baseTemplate(`Hi ${esc(rm.name || rm.email)},`, `
    ${section("Planned for today", todayEntries)}
    ${section("Still not marked done", overdueEntries)}
  `);
}

function teamDigestHtml(person, rows, today) {
  const body = `
    <table style="width:100%;border-collapse:collapse;font-family:Arial;font-size:13px;margin-top:10px">
      <tr style="background:#7A4A12;color:#fff">
        <th style="padding:6px 10px;text-align:left">RM</th>
        <th style="padding:6px 10px;text-align:right">Planned today</th>
        <th style="padding:6px 10px;text-align:right">Not yet done</th>
      </tr>
      ${rows.map((r) => `<tr>
        <td style="padding:6px 10px;border-bottom:1px solid #E3D9C8">${esc(r.name)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #E3D9C8;text-align:right">${r.todayCount}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #E3D9C8;text-align:right;color:${r.overdueCount ? "#8F3A2C" : "#1C140A"}">${r.overdueCount}</td>
      </tr>`).join("")}
    </table>`;
  return baseTemplate(`Hi ${esc(person.name || person.email)},`, `
    <p style="font-family:Arial;font-size:13px;color:#1C140A">Here's where your team stands for ${esc(fmtDMY(today))}.</p>
    ${body}
  `);
}

function baseTemplate(greeting, innerHtml) {
  return `<div style="max-width:600px;margin:0 auto;font-family:Arial">
    <p style="font-family:Arial;font-size:14px;color:#1C140A">${greeting}</p>
    ${innerHtml}
    <p style="font-family:Arial;font-size:11.5px;color:#8A7A63;margin-top:26px">
      Sent automatically from Meeting Ledger. <a href="${APP_URL}" style="color:#7A4A12">Open the app</a>.
    </p>
  </div>`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function sendMail(to, subject, html) {
  try {
    await transporter.sendMail({ from: `"Meeting Ledger" <${FROM_ADDRESS}>`, to, subject, html });
    console.log("Sent:", to, "-", subject);
  } catch (e) {
    console.error("Failed to send to", to, "-", e.message);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
