# Court Split

Auto-calculates court fees, shuttle costs, and guest markup ("funds") for weekly badminton sessions. Regulars pay actual cost (even for guests they personally bring); guests pay a fixed rate, and the difference becomes profit ("funds").

## How the math works

- A **session** is one playing block. The Session tab opens on today; the date bar steps back/forward a day or jumps to any date, so you can record a session you missed. Today is created automatically; any other date waits for an explicit **Start a session for this date** so browsing the calendar doesn't leave empty rows behind. Dates are shareable URLs (`#/session/2026-08-28`) and History links straight to them.
- **A date can hold several sessions** — a morning game and an evening one. The tab strip under the date bar switches between them, **+ Add session** starts another, and each carries its own rates, roster, extras and totals. Name them with the optional **Label** field ("Morning", "Evening"); unlabelled ones show as "Session 1", "Session 2" in creation order.
- A **payment group** = one payer covering a headcount of people (themselves + anyone they bring).
- `players` = the sum of every payment group's headcount in that session.
- **Shuttle cost per person** is auto-calculated: enter the number of **shuttles used** and the **price per shuttle**; the app computes `shuttle_count × shuttle_price_each ÷ players`. Optionally pick a **shuttle type** (e.g. "Yonex Mavis 350") — each type has a suggested **base price** that fills in the price field, but the session's own price stays editable so the actual cost can still vary session to session.
- **Court fee** has two modes, picked per session:
  - *Fixed amount per person* → `court_fee_per_slot`
  - *Total court fee ÷ all players* → `court_fee_total ÷ players`
- **Costs & credits** are free-form line items (name + amount). A **charge** adds (water, penalties, parking); a **credit** subtracts (someone bought the shuttles for the group, or overpaid last time). Either one is **applied in full to one payer** or **split among everyone** by headcount. They're pass-through: collected and paid straight back out, so they never change "funds generated". A credit stored as a negative `amount`, so the arithmetic is identical.
  - *Example:* 4 regulars, ₱175 court each, 4 shuttles at ₱140 (₱560). Carl bought the shuttles, so credit ₱560 to Carl. Everyone owes ₱175 + ₱140 = ₱315; Carl's becomes **−₱245** (you owe him). Total collected ₱700 = the ₱1,260 real cost minus the ₱560 Carl already fronted.
- The ledger lists **grouped regulars first, then ungrouped regulars, then guests** (an all-guest couple sits with the guests).
- The ledger exports as a PNG receipt to send to the group — **Share** hands it to the OS share sheet (Messenger, WhatsApp, Mail…) and **Download image** saves it. Share only appears where the browser supports it. The receipt itemises every cost and credit with who it applies to, and is drawn on a canvas rather than screenshotting the table, so the Remove buttons and headcount inputs stay out of it.
- **Groups** (Players tab) bundle couples/families. When two or more members of the same group are in a session, the ledger collapses them into **one line with a combined total** (each person still calculated at their own Regular/Guest rate); expand the row to see or edit each person.
- All per-person rates update live on the session screen as you add payment groups.
- `base_cost = (court_unit_cost + shuttle_unit_cost) × headcount`
- `extras = own direct line items + (split line items ÷ players) × headcount`
- If the payer is a **Regular** → they pay `base_cost + extras`. No funds generated, even if they're covering guests.
- If the payer is a **Guest** → they pay `guest_fixed_rate × headcount + extras`. Funds = `(guest_fixed_rate × headcount) − base_cost` (extras don't touch funds).

Status lives on the **player** (Players tab) and is snapshotted onto each payment group when added, so changing someone's status later doesn't rewrite history.

---

## 1. Set up Supabase

1. Go to [supabase.com](https://supabase.com) → New project. Pick any name/region, set a database password.
2. Once it's ready, open **SQL Editor** and paste in the full contents of `supabase/schema.sql` from this repo, then run it. This creates the `players`, `sessions`, and `payment_groups` tables plus a helper view.
3. Go to **Project Settings → API Keys**. Copy:
   - **Project URL** (from the Connect dialog or API settings) → this is `VITE_SUPABASE_URL`
   - **Publishable key** (`sb_publishable_...`, under the API Keys tab — click "Create new API keys" if you don't see one yet) → this is `VITE_SUPABASE_PUBLISHABLE_KEY`

   Note: Supabase is phasing out the older `anon` key in favor of publishable keys — same low privileges, same RLS behavior, just a new format. Use the publishable key from the start so you don't need to migrate later.
4. Go to **Authentication → Providers** and make sure **Email** is enabled (it is by default). This app uses magic-link (passwordless) sign-in — no extra config needed, but under **Authentication → URL Configuration**, add your future GitHub Pages URL (see step 3 below) to **Redirect URLs**, e.g. `https://yourusername.github.io/court-split/`.
5. Add yourself (and any co-admin) as a user: **Authentication → Users → Add user**, or just sign in once from the app and it'll send you a magic link to that email.

## 2. Push this code to GitHub

```bash
cd badminton-app
git init
git add .
git commit -m "Initial commit"
git branch -M master
git remote add origin https://github.com/YOUR-USERNAME/court-split.git
git push -u origin master
```

> If you name your repo something other than `court-split`, update the `base` path in `vite.config.js` to match — it must be `/your-repo-name/`.

## 3. Add your Supabase keys as GitHub Secrets

In your GitHub repo: **Settings → Secrets and variables → Actions → New repository secret**. Add two:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

(Use the values from Supabase step 1.3 above.)

## 4. Enable GitHub Pages

**Settings → Pages → Build and deployment → Source → GitHub Actions.**

That's it — the workflow in `.github/workflows/deploy.yml` runs automatically on every push to `master` and deploys to `https://YOUR-USERNAME.github.io/court-split/`.

## 5. Add players

Once deployed, sign in (magic link goes to your email), go to the **Players** tab, and add your roster with their status (Regular/Guest). You can flip anyone's status anytime.

---

## Local development

```bash
npm install
cp .env.example .env   # then fill in your Supabase URL/key
npm run dev
```

## Project structure

```
supabase/schema.sql       — run once on a brand-new database
supabase/migrate.sql      — run on an existing database to catch it up (idempotent)
src/lib/calc.js           — the payment calculation engine (pure functions)
src/lib/supabaseClient.js — Supabase connection
src/pages/Login.jsx       — magic-link sign-in
src/pages/Players.jsx     — manage roster + status, organise into groups
src/pages/SessionPage.jsx — today's session: tap players in from the roster, set rates + extra costs, live totals
src/pages/History.jsx     — past sessions + all-time accumulated funds
```
