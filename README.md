# Teen Beach Moonta — who's where

Everyone at camp is somewhere. They're on site, they're at one of the
programme's activities, or they're departing camp. Scan a lanyard and they move —
there's no separate sign out and sign in to fall out of step with each other.

Runs on Cloudflare Workers with a D1 database and deploys from GitHub on every
push.

- **Move someone** — pick where they're going, scan a lanyard, done. **On site**
  and **Departing camp** are always on offer; the programme sits underneath,
  with whatever is on right now at the top and a filter box for the rest.
- **Who's where** — live counts and everyone grouped by the place they're at,
  with anyone past an off-site activity's return time flagged.
- **Programme** — all four days are loaded from the Branch Moot schedule, each
  activity marked on site or off site. Add your own in the app.
- **People & cards** — everyone gets a six character code as a QR code *and* a
  barcode, printed onto the camp artwork with the Important Numbers page on the
  back. Everyone also gets their own page showing where the desk has them, what
  is on today, and who to ring.

---

## 1. Get the code onto GitHub

```bash
cd teen-beach-moonta
git init
git add .
git commit -m "Teen Beach Moonta camp board"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/teen-beach-moonta.git
git push -u origin main
```

(Or make an empty repo on github.com and drag these files into the web uploader.)

## 2. Install the tools and log in

You need [Node.js](https://nodejs.org) installed.

```bash
npm install
npx wrangler login
```

## 3. Make the database

```bash
npx wrangler d1 create teenbeach
```

It prints a `database_id`. Open **wrangler.jsonc** and paste it over the
`database_id` that's already there, then create the tables and load the
programme:

```bash
npm run db:remote
```

> `schema.sql` drops every table before it rebuilds them, so running it a second
> time wipes the roster along with everything else. Run it once at setup, and
> again only when you really do want to start from scratch.
>
> If you already have a database from an earlier version of this Worker, you
> don't need to re-run it. The Worker upgrades the tables in place the first
> time it's asked for anything, keeping everyone's codes and where they are.
> Your existing activities come across marked **on site** — open the Programme
> tab and fix any that are actually off site.

Commit and push that change — `git add . && git commit -m "database id" && git push`.

## 4. Deploy

**From GitHub (recommended, so every push goes live):**
Cloudflare dashboard → **Compute (Workers)** → **Create** → **Import a repository**
→ choose your repo. Leave the build command empty and set the deploy command to
`npx wrangler deploy`. Cloudflare builds and deploys it, then redeploys on every
push to `main`.

**Or straight from your laptop:**

```bash
npm run deploy
```

Either way you end up with `https://teen-beach-moonta.<your-subdomain>.workers.dev`.
You can add a custom domain later under the Worker's **Settings → Domains & Routes**.

## 5. Lock it with a staff PIN

```bash
npx wrangler secret put STAFF_PIN
```

Type a PIN when prompted, then redeploy. Everyone on the desk enters it once per
device.

**Do this before the camp.** Without the secret the board is open to anyone with
the link, and it says so in a red banner across the top until you set one.

How the lock works: the PIN is sent once, to `/api/login`, and what the browser
keeps afterwards is a session token that stops working after 12 hours. The PIN
itself is never stored in the browser and never replayed on later requests, PINs
are compared in constant time, and eight wrong tries from one address earn a five
minute lockout. **Sign out** in the top right clears a device immediately.

Each person's own page at `/p/THEIRCODE` stays public — they need it without a
PIN — and shows only that one person.

## 6. Run the camp

1. **People & cards** → paste the roster (`Name, Crew` per line) → pick a card
   size → **Download the print sheet**.

   ```
   Alex Moreno, Aurora Rover Unit
   Sam Whitlock, Attunga Rover Unit
   Priya Raman, Cove Rover Unit
   ```

2. Send each person `https://your-site/p/THEIRCODE` (the **Copy their own page
   link** button). Their page shows both codes, where the desk currently has
   them, what is left on today's programme, and tap-to-call camp numbers.
3. At the desk: pick where they're going, scan, repeat. A $30 USB barcode scanner
   is the most reliable option — it just types the code and presses enter. The
   camera and the search-by-name fallback both work too.

### Printing the cards

Cards print onto the camp artwork: the front is the blank frame with the name,
QR code and barcode in its white panel, the back is the Important Numbers page.
Two sizes, both of which tile an A4 sheet exactly:

| | |
|---|---|
| **Lanyard card** | 70 × 99 mm, 9 a sheet |
| **A6 badge** | 105 × 148 mm, 4 a sheet |

Print **double sided at 100%**, with *Fit to page* and *Margins* off and
*Background graphics* on if your printer dialog offers it. The sheet alternates a
page of fronts with a page of backs, and because every back is the same page it
does not matter which edge the printer flips on. Then cut along the grid.

The artwork lives in `public/card-front.png` and `public/card-back.png` — replace
those two files to change the design. The print sheet embeds them, so it still
prints correctly from a laptop with no signal.

> `card-back.png` and the `EVENT_CONTACTS` setting in `wrangler.jsonc` both carry
> real mobile numbers. If you make this repository public, those numbers are
> public too.

### On a phone

The board never grabs focus on a touch device, so the on-screen keyboard stays
shut while you're scanning. **Scan with the camera** is the first button on the
panel; the code box below it only opens the keyboard if you tap it on purpose.

### Who to ring

The **Who to ring** list on each person's page comes from `EVENT_CONTACTS` in
`wrangler.jsonc` — a JSON list of `{"role", "name", "phone"}`. The emergency
button below it always dials 000.

### On site and off site

Each activity is marked on site or off site. Off-site ones are what the "off
site" count and the "past their return time" flag are built on — so when you add
an activity of your own, set that field correctly.

---

## Running it locally

```bash
npm run db:local     # build the tables in a local copy of the database
npm run dev          # http://localhost:8787
```

## What costs money

| | |
|---|---|
| Cloudflare Workers + D1 | Free tier is far more than a camp needs |
| Domain name | Optional; the `workers.dev` address works fine |

## Files

```
public/index.html   the board (markup + styles)
public/app.js       all the front end logic
public/card-*.png   the printed card artwork, front and back
public/vendor/      QR generator, QR scanner, barcode generator
src/index.js        the Worker: API, person pages, static assets
src/auth.js         staff sign in — session tokens and rate limiting
schema.sql          database tables and the four day programme
wrangler.jsonc      Cloudflare settings
```
