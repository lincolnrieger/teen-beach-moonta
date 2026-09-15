# Teen Beach Moonta — who's where

Everyone at camp is somewhere. They're on site, they're at one of the
programme's activities, or they've gone home. Scan a lanyard and they move —
there's no separate sign out and sign in to fall out of step with each other.

Runs on Cloudflare Workers with a D1 database and deploys from GitHub on every
push.

- **Move someone** — pick where they're going, scan a lanyard, done. **On site**
  and **Going home** are always on offer; every activity on the programme sits
  underneath them.
- **Who's where** — live counts and everyone grouped by the place they're at,
  with anyone past an off-site activity's return time flagged.
- **Programme** — all four days are loaded from the Branch Moot schedule, each
  activity marked on site or off site. Add your own in the app.
- **People & cards** — everyone gets a six character code as a QR code *and* a
  barcode. Printable card sheet, phone image, or their own web page.

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

Type a PIN when prompted. Everyone on the desk enters it once per device. Without
this secret the board is open to anyone with the link — fine while you're testing,
not for the camp.

## 6. Run the camp

1. **People & cards** → paste the roster (`Name, Crew` per line) → **Download the
   print sheet** → print at 100% and cut. 88 × 54 mm, fits a standard lanyard pouch.

   ```
   Alex Moreno, Aurora Rover Unit
   Sam Whitlock, Attunga Rover Unit
   Priya Raman, Cove Rover Unit
   ```

2. Send each person `https://your-site/p/THEIRCODE` (the **Copy their own page
   link** button). Their page shows their QR code and their barcode, so it works
   with a camera or a laser scanner either way.
3. At the desk: pick where they're going, scan, repeat. A $30 USB barcode scanner
   is the most reliable option — it just types the code and presses enter. The
   camera and the search-by-name fallback both work too.

### On a phone

The board never grabs focus on a touch device, so the on-screen keyboard stays
shut while you're scanning. **Scan with the camera** is the first button on the
panel; the code box below it only opens the keyboard if you tap it on purpose.

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
public/vendor/      QR generator, QR scanner, barcode generator
src/index.js        the Worker: API, person pages, static assets
schema.sql          database tables and the four day programme
wrangler.jsonc      Cloudflare settings
```
