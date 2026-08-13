# Meeting Ledger

## ⚠️ Updating from an earlier version? Do this first

This version changes the role model and the meeting form. If you already
have data in Firestore, two things need a manual fix right after you
deploy — nothing else migrates itself.

**1. Merge "Founder" into "Admin."** Founder is no longer a role. Anyone
whose `users` document still says `role: "founder"` will silently drop to
RM-level access (only "My meetings," no Master, no Team) the moment you
publish the new rules. Fix it immediately:

Firebase → **Firestore Database → Data → users** → open each document that
says `founder` → change the **`role`** field to:
```
admin
```

**2. Add Designation and Employee ID to every existing person.** The
export now includes both, matching your Mastersheet exactly. On the same
document, add two new **string** fields:
```
designation:  "Founder"          (their real job title — separate from role)
employeeId:   "HCM/F-005"
```
Do this for everyone already in the team list, including yourself. New
people you add from now on will be asked for these automatically.

**3. Only a Super Admin can manage the team now.** Plain Admins can see
the Team tab (read-only) but can no longer add, edit, or remove anyone —
only a Super Admin can. If nobody is currently `role: "superadmin"`, pick
one existing Admin's document and change their role to `superadmin` the
same way as step 1.

Do all three, then publish the new `firestore.rules` (Step 3 below) and
redeploy the app files, in that order.

---


A small CRM for relationship managers. Each RM logs one row per meeting and sees
only their own. You see everything, plus the master sheet — and can download it
as Excel in the same layout as `Format.xlsx`.

No build step, no npm, no framework. Five files. You edit one of them.

- **Sign-in** — your work email, whoever provides it (Microsoft 365, Zoho, cPanel, anything)
- **Access** — RMs see only their own rows; admins see everything
- **Hosting** — GitHub Pages, free
- **Data** — Firebase Firestore, free tier is far more than enough for 5 RMs

---

## What you need

A Google account, a GitHub account, and about 30 minutes. No coding.

---

## Step 1 — Create the Firebase project

1. Go to <https://console.firebase.google.com> and click **Add project**.
   Name it whatever you like. You can turn Google Analytics off.
2. In the left menu open **Build → Firestore Database → Create database**.
   Pick **Production mode** and a region near you (`asia-south1` for India).
3. In the left menu open **Build → Authentication → Get started**.
   Under **Sign-in method** click **Email/Password**, turn on just that one
   toggle — *Email/Password* — and Save. (Leave *Email link (passwordless
   sign-in)* off; this app uses passwords, not emailed links.)

## Step 2 — Register the web app and copy the config

1. Click the gear icon → **Project settings**.
2. Scroll to **Your apps** and click the web icon `</>`.
3. Give it a nickname, click **Register app**.
4. You'll see a `firebaseConfig = { ... }` block. Copy it.

Open `config.js` in this repo and replace two things:

```js
export const ORG_DOMAIN = "yourcompany.com";   // <- your real email domain
export const firebaseConfig = { ...pasted from Firebase... };
```

Those API keys are meant to be public — they identify your project, they don't
grant access. Access is controlled entirely by Step 3.

## Step 3 — Publish the security rules

This is the step that actually protects your data. Don't skip it.

1. Open `firestore.rules` and change one line near the top:

   ```
   function emailPattern() {
     return '^[^@]+@yourcompany[.]com$';
   }
   ```

   Write your domain with the dots escaped as `[.]` — `acmecapital.com`
   becomes `^[^@]+@acmecapital[.]com$`.

2. In Firebase go to **Firestore Database → Rules**, delete what's there,
   paste the whole file in, and click **Publish**.

## Step 4 — Make yourself the Super Admin

The app can't let anyone in until at least one person is on the team list,
and only a Super Admin can add people or change roles. So create your own
entry by hand, once.

1. Firebase → **Firestore Database → Data → Start collection**.
2. Collection ID: `users`
3. Document ID: **your work email, all lowercase** — e.g. `you@yourcompany.com`
4. Add six fields:

   | Field         | Type    | Value                    |
   |---------------|---------|--------------------------|
   | `email`       | string  | `you@yourcompany.com`    |
   | `name`        | string  | `Your Name`              |
   | `designation` | string  | `Founder` (your real title — shows up on every export) |
   | `employeeId`  | string  | `HCM/001` (anything you like) |
   | `role`        | string  | `superadmin`             |
   | `active`      | boolean | `true`                   |

5. Save. From now on you add everyone else from the **Team** tab inside the
   app — but only someone whose role is `superadmin` will see the option to
   add people. A plain `admin` sees everything else (Master, every meeting,
   the team roster) but can't add, edit, or remove anyone.

## Step 5 — Put it on GitHub Pages

1. Create a new repository on GitHub. Public is fine.
2. Upload every file in this folder to the root of the repo
   (`index.html`, `styles.css`, `app.js`, `config.js`, `firestore.rules`, `README.md`).
3. In the repo go to **Settings → Pages**.
   Under **Source** pick **Deploy from a branch**, branch `main`, folder `/ (root)`. Save.
4. Wait a minute. Your app is live at
   `https://<your-username>.github.io/<repo-name>/`

## Step 6 — Let Firebase trust that address

1. Firebase → **Authentication → Settings → Authorised domains → Add domain**.
2. Add `<your-username>.github.io`.

Open the URL, sign in with your work account, and you should land on the master
sheet. Then go to **Team** and add your five RMs.

---

## How the RMs use it

They open the same URL on their phone, type their work email, and choose a
password. The first time a work email signs in, the app creates the account
automatically and sends a confirmation email — they open it, click the link,
come back, and they're in. After that it's just email + password, like any
normal login. If someone forgets their password, **Set or reset my password**
sends a reset link.

Once in, they land on a single screen: a form on top, their month
underneath. One row per meeting. They never see anyone else's numbers, and
there's nothing to email you.

If someone signs in before you've added them to the team list, they get a
polite "not set up yet" screen rather than an error.

---

## How you use it

**Master** has two sub-tabs. **Dashboard** is the visual view — the stat
strip and the four charts (trend, by-RM, by-type, result split). **Sheets**
is the data view — the funnel, Plan vs Achievement, and the by-relationship-manager
and day-by-day breakdowns. Both of those are now three stacked tables each
(Wealth Manager, Channel Partner, Investor) instead of one very wide table,
so nothing needs sideways scrolling. **Download Excel** gives you a workbook
with three tabs: `Master` (daily totals across everyone), `Data` (one row
per person per day, in the exact column order as your Mastersheet's `Data`
tab — including Designation and Employee ID), and `All Meetings` (every row,
including the reference name and not-interested reason, but never the
leads). Everything — on-screen and downloaded — follows whichever date range
is currently selected, month or custom.

**Download leads** — a second button, visible only to Admin and Super Admin.
Every lead a Wealth Manager or Channel Partner has shared, with name, phone,
and meeting status, for whichever range is selected. This never appears in
the regular Download Excel.

**My meetings** — log your own meetings, set tomorrow's plan, and see
everything with a follow-up date due this week, all in one sidebar that
stays put while the meeting list on the right scrolls past it.

**Team** — Super Admin can add people, change anyone's role (RM, Observer,
Admin, or Super Admin), and remove or restore access. Removing access keeps
their history; it just stops them signing in. Admin and Observer both see
the same table, read-only — no add form, no role dropdowns, no remove
buttons.

**Observer** is a fourth role: Master and Team only, both read-only, but
downloads work normally (Download Excel, Download leads). No "My meetings"
tab — an Observer never logs a meeting, and the database refuses one even
if someone tried to force it through the browser console.

---

## Rules of the road

**Team Lead** is a fifth role, between RM and Admin. From the Team tab,
Super Admin assigns an RM's **"Reports to"** to a Team Lead. That Team Lead
then sees Master, Contacts, and Leads scoped to themselves plus their
direct reports only — never the whole company. They can log their own
meetings, same as Admin, but have no power to manage the team or edit
anyone else's records.

**Editing an existing team member.** Super Admin can now correct someone's
name, designation, or employee ID directly in the Team tab — click into
the field, type, click away, it saves. Email stays fixed; it's how someone
signs in and how every past meeting is attributed to them.

**Deleting a contact.** Super Admin can remove a Wealth Manager or Channel
Partner from the registry entirely. History is untouched — meetings and
leads that already reference it keep their own saved details. Deleting
only means it can no longer be selected as "Existing" going forward.

**Rescheduling.** Change a follow-up date (or a Pending lead's expected
date) on an existing entry, and the *original* date is preserved
underneath — you'll see "Rescheduled from X → Y" wherever that entry
shows up. Reschedule it again later and it still points back to the true
original, not whatever it most recently was.

**Wealth Manager / Channel Partner contacts have a registry now.** Pick
either segment on the form and you'll be asked New or Existing. New — fill
in the details as before, and the app generates an ID like `CP-9876543210`
(the prefix plus their phone number — always unique, never needs a manual
counter). Existing — type that ID, hit Find, and their name/phone/email/
address fill in on their own, read-only.

**The same phone can only be registered once, ever, by anyone.** If a
different RM already registered that number, you'll see "This contact is
already registered. Check with your admin." — nothing gets saved, including
the meeting itself. Re-saving your own contact's details is fine; that's
treated as a correction.

**Contacts are visible more widely than leads.** Everyone sees only their
own contacts and leads — except Admin, Superadmin, and **Observer**, who
see every contact on file. Leads (the actual people a contact introduced)
are more sensitive: only Admin and Superadmin see everyone's; Observer sees
none, enforced by the database itself, not just hidden on screen.

**Only a Super Admin can transfer a contact.** From the Contacts tab, enter
the new owner's employee ID. Past meetings and leads keep the original RM's
name on them — a transfer only changes who owns the contact going forward.

**Every lead needs a date, whichever status it has.** Meeting Done — the
date it happened. Pending — the date it's expected. Both feed the
Follow-ups list on "My meetings," alongside meetings with their own
follow-up date. Use the ‹ › arrows to check other weeks, or "This week" to
jump back to today.

**One meeting = one reachout.** First meetings and follow-ups both count. The
master shows the split.

**Lead / docs shared** means leads for Wealth Managers and Channel Partners,
documents for Investors. The form relabels itself when you pick the type.

**Every field is mandatory.** The form won't submit until it's all filled —
phone, email, address, source, result, follow-up date, remarks, all of it.
Fields that don't apply yet (like the Not Interested reason, or the Reference
name) simply don't appear until they're relevant, and switch off again if you
change your mind.

**Shared and progressed only make sense once someone's Interested.** If the
result isn't Interested, the Lead/Docs Shared field is switched off. If a
lead or document wasn't actually shared yet ("Not yet" or "No"), Meeting
Done/Logged In switches off too — there's nothing to be done or pending yet.

**Duplicate meetings are blocked automatically.** The same phone number on
the same date can only exist once — the database itself refuses a second
attempt by a different person (they'll see "That phone number already has a
meeting logged for this date"). Re-saving your own entry for the same
phone+date is treated as a correction, not a duplicate.

**Meeting dates can't be in the future.** The date picker won't let you go
past today, and the app checks again on save regardless.

**Leads shared by a Wealth Manager or Channel Partner are kept separate.**
When Lead/Docs Shared = Yes for a WM or CP meeting, you can list each lead's
name, phone, and whether the follow-up meeting happened. These names and
numbers never appear in the regular **Download Excel** — only in the
separate **Download leads** button, which only Admin and Super Admin ever
see.

**Tomorrow's plan, and how it's checked.** Everyone — RM, Admin, or Super
Admin — can log how many meetings they plan to do tomorrow, from the small
card under the meeting form. On Master, **Plan vs achievement** shows planned
vs. actual meetings for whichever date you pick, per person, with an
achievement percentage.

**Date range, month or custom.** By default Master shows the selected month —
funnel, dashboard, achievement, both segment-table sections, every meeting,
all of it. Fill in the two date fields next to the month picker and the
*entire view* switches to that exact range instead, live, not just the
downloads. Picking a month again clears any custom range so it's never
ambiguous which one is active. Neither can go into the future: the month
picker stops at the current month, "from" and "to" stop at today, and "to"
can never sit before "from."

**Only "Yes" counts as shared.** "Not yet" and "No" both land in Not Shared.

---

## If something goes wrong

**"Missing or insufficient permissions"** — the rules aren't published, or your
`users` document ID isn't your email in lowercase, or `active` was saved as the
text `"true"` instead of the boolean `true`.

**The confirmation email never arrives** — check spam first (it comes from
Firebase, not a familiar sender, so filters are often suspicious of the
first one). Then check that your GitHub Pages domain is in authorised
domains (Step 6).

**"This web address isn't authorised"** — your GitHub Pages domain isn't in
Firebase's authorised domains (Step 6).

**"Confirm your email address" screen won't go away** — open the
confirmation email, click the link, then reload the app.

**"That email and password don't match"** on a first-ever sign-in — this
should self-correct automatically (the app creates the account behind the
scenes). If it doesn't, make sure *Email/Password* sign-in is switched on in
Firebase (Step 1.3).

**"Use your @company account"** — `ORG_DOMAIN` in `config.js` doesn't match the
address being used. It's just the domain, no `@`.

**Everything loads but no data** — check you're looking at the right month. The
month picker defaults to the current one.

---

## What this costs

Nothing, at your size. Firebase's free tier covers 50,000 document reads a day;
five RMs logging meetings will use a few hundred. GitHub Pages is free. You'll
only ever pay if this grows into the hundreds of users.

## Where it goes next

Right now every RM's meetings load in one go, which is perfect up to a few
thousand rows. Past that you'd want to paginate by month. When you get there,
the change is in `loadMeetings()` — add a `where("date", ">=", ...)` and
Firestore will prompt you for the one index it needs.
