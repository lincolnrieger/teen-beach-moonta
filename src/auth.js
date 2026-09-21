/* Staff sign in.

   The PIN itself is only ever sent once, to /api/login. What the desk stores
   and replays is a session token: an expiry plus an HMAC of it, keyed on the
   PIN. That means a token can be checked without keeping any extra secret, it
   stops working by itself after a shift, and a PIN left in a browser's storage
   is no longer enough on its own. */

const enc = new TextEncoder();
const SESSION_MS = 12 * 60 * 60 * 1000;   /* one long camp shift */

/* Failed sign-ins per address. Isolate-local and therefore not a perfect
   count, but enough to turn guessing a four digit PIN from seconds into
   something nobody at a campsite is going to sit through. */
const attempts = new Map();
const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 5 * 60 * 1000;

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function key(pin) {
  return crypto.subtle.importKey("raw", enc.encode(pin), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function sign(payload, pin) {
  return b64url(await crypto.subtle.sign("HMAC", await key(pin), enc.encode(payload)));
}

/* Compare without letting the time taken reveal how much of the PIN matched. */
function sameSecret(a, b) {
  const x = enc.encode(String(a)), y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

export function pinRequired(env) {
  return Boolean(env.STAFF_PIN);
}

export function clientKey(request) {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "unknown";
}

export function lockedOut(request) {
  const rec = attempts.get(clientKey(request));
  if (!rec) return 0;
  if (rec.until && rec.until > Date.now()) return Math.ceil((rec.until - Date.now()) / 1000);
  if (rec.until) attempts.delete(clientKey(request));
  return 0;
}

function noteFailure(request) {
  const k = clientKey(request);
  const rec = attempts.get(k) || { n: 0, until: 0 };
  rec.n += 1;
  if (rec.n >= MAX_ATTEMPTS) { rec.until = Date.now() + LOCKOUT_MS; rec.n = 0; }
  attempts.set(k, rec);
}

export async function login(request, env, pin) {
  if (!pinRequired(env)) return { ok: false, reason: "no-pin-set" };
  if (!sameSecret(pin, env.STAFF_PIN)) {
    noteFailure(request);
    /* A small, constant pause blunts rapid-fire guessing without making a
       correct PIN feel sluggish. */
    await new Promise((r) => setTimeout(r, 400));
    return { ok: false, reason: "wrong-pin" };
  }
  attempts.delete(clientKey(request));
  const exp = Date.now() + SESSION_MS;
  return { ok: true, token: `${exp}.${await sign(String(exp), env.STAFF_PIN)}`, expires: exp };
}

/* A request is allowed through when it carries a live token. A deployment with
   no STAFF_PIN set has nothing to check against, so it stays open — the board
   says so in a banner rather than locking the camp out of its own desk. */
export async function staffOk(request, env) {
  if (!pinRequired(env)) return true;
  const token = request.headers.get("x-session") || "";
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const exp = Number(token.slice(0, dot));
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  return sameSecret(token.slice(dot + 1), await sign(String(exp), env.STAFF_PIN));
}
