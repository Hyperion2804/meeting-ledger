# Meeting Ledger

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
   Under **Sign-in method** click **Email/Password**, then turn on
   **both** toggles — *Email/Password* and *Email link (passwordless sign-in)*.
   Save.

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

## Step 4 — Make yourself the admin

The app can't let anyone in until at least one person is on the team list, and
only an admin can add people. So create your own entry by hand, once.

1. Firebase → **Firestore Database → Data → Start collection**.
2. Collection ID: `users`
3. Document ID: **your work email, all lowercase** — e.g. `you@yourcompany.com`
4. Add four fields, all type **string** except the last:

   | Field    | Type    | Value                  |
   |----------|---------|------------------------|
   | `email`  | string  | `you@yourcompany.com`  |
   | `name`   | string  | `Your Name`            |
   | `role`   | string  | `admin`                |
   | `active` | boolean | `true`                 |

5. Save. From now on you add everyone else from the **Team** tab inside the app.

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

They open the same URL on their phone, type their work email, and tap
**Email me a sign-in link**. They open the link from their inbox and they're in —
no password to invent or forget. Anyone who prefers a password can tap
**Use a password instead** and set one. Either way they land on a
single screen: a form on top, their month underneath. One row per meeting. They
never see anyone else's numbers, and there's nothing to email you.

If someone signs in before you've added them, they get a polite "not set up yet"
screen rather than an error.

---

## How you use it

**Master** — the funnel, a per-RM table, and a day-by-day grid with the same
columns as the Format sheet. **Download Excel** gives you a workbook with three
tabs: `Master` (daily totals), `Data` (one row per RM per day, matching the old
paste format exactly), and `All Meetings` (every row).

**My meetings** — you can log your own meetings too.

**Team** — add people, change roles, remove access. Removing access keeps their
history; it just stops them signing in.

---

## Rules of the road

**One meeting = one reachout.** First meetings and follow-ups both count. The
master shows the split.

**Lead / docs shared** means leads for Wealth Managers and Channel Partners,
documents for Investors. The form relabels itself when you pick the type.

**Only "Yes" counts as shared.** "Not yet" and "No" both land in Not Shared.

---

## If something goes wrong

**"Missing or insufficient permissions"** — the rules aren't published, or your
`users` document ID isn't your email in lowercase, or `active` was saved as the
text `"true"` instead of the boolean `true`.

**The sign-in link email never arrives** — check spam first. Then check that
*Email link (passwordless sign-in)* is actually toggled on in Firebase
(Step 1.3), and that your GitHub Pages domain is in authorised domains (Step 6).

**"This web address isn't authorised"** — your GitHub Pages domain isn't in
Firebase's authorised domains (Step 6).

**"Confirm your email address" screen won't go away** — that's the password
route. Open the confirmation email, click the link, then reload the app.

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
