# Teen Beach Moonta — camp check in board

Who's on site, who's away, and where they went. Runs on Cloudflare Workers with a
D1 database, deploys from GitHub on every push, and hands out real Apple Wallet
passes once you add your signing certificates.

- **Check in & out** — pick a destination, scan a lanyard, done. Automatic mode
  signs people out if they're here and back in if they're away.
- **Who's where** — live counts, everyone grouped by activity, anyone past their
  return time flagged.
- **Programme** — Monday 5 October is already loaded from the spreadsheet, with
  the first aid roster. Add the other days in the app.
- **People & passes** — everyone gets a six character code as a QR code and a
  barcode. Printable card sheet, phone image, or an Apple Wallet pass.

---

## 1. Get the code onto GitHub

```bash
cd teen-beach-moonta
git init
git add .
git commit -m "Teen Beach Moonta check in board"
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

It prints a `database_id`. Open **wrangler.jsonc** and paste it over
`PASTE_YOUR_DATABASE_ID_HERE`, then create the tables and load the programme:

```bash
npm run db:remote
```

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

## 6. Apple Wallet

This is the only part that needs an Apple Developer Program membership
(US$99 a year, around A$150). Everything else works without it — people can
screenshot their card page instead.

**a. Register a Pass Type ID.**
[developer.apple.com](https://developer.apple.com/account) → Certificates,
Identifiers & Profiles → Identifiers → **+** → **Pass Type IDs**. Call it
something like `pass.au.com.sarovers.teenbeach`.

**b. Make a signing certificate.** On any machine with openssl:

```bash
mkdir certs && cd certs
openssl genrsa -out signerKey.pem 2048
openssl req -new -key signerKey.pem -out request.certSigningRequest \
  -subj "/emailAddress=branchmoot@sarovers.com.au/CN=Teen Beach Moonta/C=AU"
```

Upload `request.certSigningRequest` to the Pass Type ID you just made, download
the `pass.cer` it gives you, and convert it:

```bash
openssl x509 -inform DER -outform PEM -in pass.cer -out signerCert.pem
```

**c. Get Apple's intermediate certificate.** Download the **Worldwide Developer
Relations G4** certificate from
[apple.com/certificateauthority](https://www.apple.com/certificateauthority/), then:

```bash
openssl x509 -inform DER -outform PEM -in AppleWWDRCAG4.cer -out wwdr.pem
```

**d. Put them on the Worker.**

```bash
npx wrangler secret put SIGNER_CERT_PEM < certs/signerCert.pem
npx wrangler secret put SIGNER_KEY_PEM  < certs/signerKey.pem
npx wrangler secret put WWDR_PEM        < certs/wwdr.pem
```

(Or paste each one into the dashboard under **Settings → Variables and Secrets**,
including the `-----BEGIN…` and `-----END…` lines.)

**e. Fill in the two IDs** in `wrangler.jsonc` under `vars`:

- `PASS_TYPE_ID` — the Pass Type ID from step a, e.g. `pass.au.com.sarovers.teenbeach`
- `TEAM_ID` — the ten character Team ID from developer.apple.com → Membership

Push, and the **Add to Apple Wallet** button switches itself on.

> The `certs/` folder is in `.gitignore`. Never commit the private key.

## 7. Run the camp

1. **People & passes** → paste the roster (`Name, Crew` per line) → **Download the
   print sheet** → print at 100% and cut. 88 × 54 mm, fits a standard lanyard pouch.
2. Send each person `https://your-site/p/THEIRCODE` (the **Copy their own page
   link** button) so they can add the Wallet pass themselves.
3. At the desk: pick a destination, scan, repeat. A $30 USB barcode scanner is the
   most reliable option — it just types the code and presses enter. The camera and
   the search-by-name fallback both work too.

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
| Apple Developer Program | US$99/yr — only for Wallet passes |
| Domain name | Optional; the `workers.dev` address works fine |

## Files

```
public/index.html   the board (markup + styles)
public/app.js       all the front end logic
public/vendor/      QR generator, QR scanner, barcode generator
src/index.js        the Worker: API, person pages, static assets
src/pass.js         builds and signs the Apple Wallet pass
src/icons.js        event artwork for the pass, as base64
schema.sql          database tables + Monday's programme
wrangler.jsonc      Cloudflare settings
```
