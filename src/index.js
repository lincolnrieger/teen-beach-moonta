const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
const bad = (message, status = 400) => json({ error: message }, status);

/* Staff routes need the shared PIN. Set it with:
   npx wrangler secret put STAFF_PIN
   If it is not set, the whole site is open — fine for a trial, not for the camp. */
function staffOk(request, env) {
  if (!env.STAFF_PIN) return true;
  const sent = request.headers.get("x-pin") || "";
  return sent === env.STAFF_PIN;
}

async function bumpRev(env) {
  await env.DB.prepare(
    "INSERT INTO meta (k, v) VALUES ('rev', ?1) ON CONFLICT(k) DO UPDATE SET v = ?1"
  ).bind(String(Date.now())).run();
}

/* The numbers on the back of every lanyard and on everyone's own page. The
   board reads them from /api/config, so this is the one place to change them. */
const CONTACTS = [
  { group: "Camp leads", name: "Ethan", tel: "0434 997 161" },
  { group: "Camp leads", name: "Nikki", tel: "0412 584 406" },
  { group: "First aid", name: "", tel: "0468 442 515", note: "Day or night" },
  { group: "Out of hours", name: "Ethan", tel: "0434 997 161" },
  { group: "Emergency", name: "", tel: "000", alt: "112", urgent: true }
];

function newCode() {
  const ab = "ACDEFHJKLMNPQRTUVWXY3479";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let s = "";
  for (let i = 0; i < 6; i++) s += ab[bytes[i] % ab.length];
  return s;
}

function newId(prefix) {
  return prefix + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
}

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* Bring a database built by an older version of this Worker up to date, in
   place, without touching the roster. The old shape tracked an in/out flag and
   the activity someone signed out to; this one tracks the single place they
   are. Runs at most once per isolate and does nothing on a database that is
   already current, or on one that has no tables yet — that is schema.sql's job. */
let migrated = null;
async function ensureSchema(env) {
  if (!migrated) migrated = migrate(env).catch((err) => { migrated = null; throw err; });
  return migrated;
}

async function columnsOf(env, table) {
  try {
    const r = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
    return new Set((r.results || []).map((c) => c.name));
  } catch {
    return new Set();
  }
}

async function migrate(env) {
  const [members, movements, activities] = await Promise.all([
    columnsOf(env, "members"),
    columnsOf(env, "movements"),
    columnsOf(env, "activities")
  ]);
  const steps = [];

  /* An activity is now marked on site or off site. */
  if (activities.size && !activities.has("site")) {
    steps.push("ALTER TABLE activities ADD COLUMN site TEXT DEFAULT 'on'");
  }

  /* state + act become a single place. */
  if (members.size && !members.has("place")) {
    steps.push(
      "CREATE TABLE members_v2 (code TEXT PRIMARY KEY, name TEXT NOT NULL, crew TEXT, " +
        "place TEXT NOT NULL DEFAULT 'onsite', since INTEGER, created INTEGER)",
      "INSERT INTO members_v2 (code, name, crew, place, since, created) SELECT code, name, crew, " +
        (members.has("state") && members.has("act")
          ? "CASE WHEN state = 'out' AND act IS NOT NULL THEN act ELSE 'onsite' END"
          : "'onsite'") +
        ", since, created FROM members",
      "DROP TABLE members",
      "ALTER TABLE members_v2 RENAME TO members"
    );
  }

  /* The movement log records where someone went, not which way they crossed the
     gate. `dir` was NOT NULL with no default, so this table has to be rebuilt. */
  if (movements.size && !movements.has("place")) {
    steps.push(
      "CREATE TABLE movements_v2 (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, " +
        "place TEXT NOT NULL, t INTEGER NOT NULL)",
      "INSERT INTO movements_v2 (id, code, place, t) SELECT id, code, " +
        (movements.has("dir") && movements.has("act")
          ? "CASE WHEN dir = 'in' THEN 'onsite' ELSE COALESCE(act, 'onsite') END"
          : "'onsite'") +
        ", t FROM movements",
      "DROP TABLE movements",
      "ALTER TABLE movements_v2 RENAME TO movements",
      "CREATE INDEX IF NOT EXISTS movements_t ON movements (t DESC)"
    );
  }

  /* The first aid roster lived here briefly and is gone again. */
  steps.push("DROP TABLE IF EXISTS aiders");

  if (steps.length === 1) return;   /* nothing but the unconditional drop */
  for (const sql of steps) await env.DB.prepare(sql).run();
  await bumpRev(env);
}

async function handleApi(request, env, url) {
  const path = url.pathname.replace(/^\/api\/?/, "");
  const method = request.method;

  /* --- public: what this deployment can do --- */
  if (path === "config") {
    return json({
      pinRequired: Boolean(env.STAFF_PIN),
      event: env.EVENT_NAME || "Teen Beach Moonta",
      contacts: CONTACTS
    });
  }

  /* --- everything below is staff only --- */
  if (!staffOk(request, env)) return bad("Wrong PIN.", 401);

  await ensureSchema(env);

  if (path === "rev") {
    const row = await env.DB.prepare("SELECT v FROM meta WHERE k = 'rev'").first();
    return json({ rev: row ? row.v : "0" });
  }

  if (path === "state") {
    const [members, activities, movements, rev] = await Promise.all([
      env.DB.prepare("SELECT * FROM members ORDER BY name").all(),
      env.DB.prepare("SELECT * FROM activities ORDER BY date, start").all(),
      env.DB.prepare(
        "SELECT m.t, m.place, m.code, p.name FROM movements m LEFT JOIN members p ON p.code = m.code ORDER BY m.t DESC LIMIT 80"
      ).all(),
      env.DB.prepare("SELECT v FROM meta WHERE k = 'rev'").first()
    ]);
    return json({
      members: members.results,
      activities: activities.results.map((a) => ({ ...a, dest: !!a.dest })),
      movements: movements.results,
      rev: rev ? rev.v : "0"
    });
  }

  /* A scan just moves someone to the place the board has selected: 'onsite',
     'offsite' (a temporary sign out), 'home', or an activity id. There is no in/out flag to get out of step. */
  if (path === "scan" && method === "POST") {
    const { code, place } = await request.json();
    const where = String(place || "").trim();
    if (!where) return bad("no-destination");
    const member = await env.DB.prepare("SELECT * FROM members WHERE code = ?")
      .bind(String(code || "").toUpperCase()).first();
    if (!member) return bad("unknown-code", 404);
    if (where !== "onsite" && where !== "offsite" && where !== "home") {
      const act = await env.DB.prepare("SELECT id FROM activities WHERE id = ?").bind(where).first();
      if (!act) return bad("unknown-place", 404);
    }
    if (member.place === where) return bad("already-there");

    const now = Date.now();
    const prev = { place: member.place, since: member.since };
    await env.DB.batch([
      env.DB.prepare("UPDATE members SET place = ?, since = ? WHERE code = ?").bind(where, now, member.code),
      env.DB.prepare("INSERT INTO movements (code, place, t) VALUES (?, ?, ?)").bind(member.code, where, now)
    ]);
    await bumpRev(env);
    return json({ ok: true, member: { ...member, place: where, since: now }, prev, at: now });
  }

  if (path === "undo" && method === "POST") {
    const { code, prev } = await request.json();
    if (!code || !prev) return bad("nothing-to-undo");
    await env.DB.batch([
      env.DB.prepare("UPDATE members SET place = ?, since = ? WHERE code = ?")
        .bind(prev.place, prev.since, String(code).toUpperCase()),
      env.DB.prepare("DELETE FROM movements WHERE id = (SELECT id FROM movements WHERE code = ? ORDER BY t DESC LIMIT 1)")
        .bind(String(code).toUpperCase())
    ]);
    await bumpRev(env);
    return json({ ok: true });
  }

  if (path === "members" && method === "POST") {
    const body = await request.json();
    const people = Array.isArray(body.people) ? body.people : [body];
    const added = [];
    const statements = [];
    for (const person of people) {
      const name = String(person.name || "").trim();
      if (!name) continue;
      const row = {
        code: newCode(),
        name,
        crew: String(person.crew || "").trim(),
        place: "onsite",
        since: Date.now(),
        created: Date.now()
      };
      added.push(row);
      statements.push(
        env.DB.prepare("INSERT INTO members (code, name, crew, place, since, created) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(row.code, row.name, row.crew, row.place, row.since, row.created)
      );
    }
    if (!statements.length) return bad("No names given.");
    await env.DB.batch(statements);
    await bumpRev(env);
    return json({ ok: true, added });
  }

  if (path.startsWith("members/") && method === "PUT") {
    const code = path.slice(8).toUpperCase();
    const body = await request.json();
    const name = String(body.name || "").trim();
    if (!name) return bad("Give them a name.");
    const r = await env.DB.prepare("UPDATE members SET name = ?, crew = ? WHERE code = ?")
      .bind(name, String(body.crew || "").trim(), code).run();
    if (!r.meta || !r.meta.changes) return bad("unknown-code", 404);
    await bumpRev(env);
    return json({ ok: true });
  }

  if (path.startsWith("members/") && method === "DELETE") {
    const code = path.slice(8).toUpperCase();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM members WHERE code = ?").bind(code),
      env.DB.prepare("DELETE FROM movements WHERE code = ?").bind(code)
    ]);
    await bumpRev(env);
    return json({ ok: true });
  }

  /* Add a new activity, or change one that is already on the programme. */
  if ((path === "activities" && method === "POST") || (path.startsWith("activities/") && method === "PUT")) {
    const a = await request.json();
    const name = String(a.name || "").trim();
    if (!name) return bad("Give the activity a name.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a.date || "")) return bad("Pick a date.");
    if (!/^\d{2}:\d{2}$/.test(a.start || "") || !/^\d{2}:\d{2}$/.test(a.end || "")) return bad("Pick a start and end time.");
    if (a.end <= a.start) return bad("It has to end after it starts.");
    const fields = [name, String(a.loc || "").trim(), a.date, a.start, a.end, a.site === "off" ? "off" : "on", a.dest ? 1 : 0];
    if (method === "PUT") {
      const id = path.slice(11);
      const r = await env.DB.prepare(
        "UPDATE activities SET name = ?, loc = ?, date = ?, start = ?, end = ?, site = ?, dest = ? WHERE id = ?"
      ).bind(...fields, id).run();
      if (!r.meta || !r.meta.changes) return bad("That activity is gone.", 404);
      await bumpRev(env);
      return json({ ok: true, id });
    }
    const id = newId("a");
    await env.DB.prepare(
      "INSERT INTO activities (id, name, loc, date, start, end, kind, site, dest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(id, fields[0], fields[1], fields[2], fields[3], fields[4], a.kind || "main", fields[5], fields[6]).run();
    await bumpRev(env);
    return json({ ok: true, id });
  }

  if (path.startsWith("activities/") && method === "DELETE") {
    const id = path.slice(11);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM activities WHERE id = ?").bind(id),
      /* nobody can be left standing at an activity that no longer exists */
      env.DB.prepare("UPDATE members SET place = 'onsite', since = ? WHERE place = ?").bind(Date.now(), id)
    ]);
    await bumpRev(env);
    return json({ ok: true });
  }

  return bad("Unknown endpoint.", 404);
}

/* The important numbers as a list of tap-to-call rows. */
function contactsHtml() {
  const telHref = (t) => "tel:" + t.replace(/\s+/g, "");
  let html = "";
  let last = null;
  for (const c of CONTACTS) {
    if (c.group !== last) {
      if (last !== null) html += "</div>";
      html += `<div class="grp${c.urgent ? " urgent" : ""}"><h3>${esc(c.group)}</h3>`;
      last = c.group;
    }
    const num = `<a href="${telHref(c.tel)}">${esc(c.tel)}</a>` +
      (c.alt ? ` <span>or</span> <a href="${telHref(c.alt)}">${esc(c.alt)}</a>` : "");
    html += `<div class="ln">${c.name ? `<b>${esc(c.name)}</b>` : ""}${num}` +
      (c.note ? `<small>${esc(c.note)}</small>` : "") + "</div>";
  }
  return html + (last !== null ? "</div>" : "");
}

/* A plain page for one person: their code as a barcode, and the numbers to
   call. Send them https://your-site/p/THEIRCODE to keep on their phone. */
async function personPage(code, env) {
  await ensureSchema(env);
  const member = await env.DB.prepare("SELECT * FROM members WHERE code = ?").bind(code.toUpperCase()).first();
  const event = env.EVENT_NAME || "Teen Beach Moonta";
  const head = `<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<meta name=theme-color content="#2BA8A0">
<link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&family=Archivo:wght@400;500;600;700&display=swap" rel=stylesheet>
<style>
 *{box-sizing:border-box}
 body{margin:0;min-height:100vh;color:#16333A;font-family:Archivo,system-ui,sans-serif;text-align:center;
   background:linear-gradient(#2BA8A0,#1B7F79) fixed;-webkit-font-smoothing:antialiased}
 main{max-width:440px;margin:0 auto;padding:22px 14px 40px}
 .card{background:#fff;border-radius:22px;padding:22px 20px;box-shadow:0 14px 40px rgba(0,0,0,.18)}
 .card + .card{margin-top:16px}
 .logo{width:84px;height:84px;border-radius:50%;margin-top:-4px}
 h1{font-family:Fredoka,sans-serif;font-weight:600;font-size:28px;line-height:1.1;margin:10px 0 2px}
 .crew{color:#5F7A80;font-size:15px}
 .bc{max-width:280px;margin:18px auto 0}
 .bc svg{width:100%;height:64px;display:block}
 .code{font-family:ui-monospace,Menlo,monospace;font-size:20px;letter-spacing:.24em;font-weight:700;margin-top:8px}
 h2{font-family:Fredoka,sans-serif;font-weight:700;font-size:22px;margin:0 0 6px}
 .grp{text-align:left;padding:12px 0;border-top:1px solid #E3ECEC}
 .grp:first-of-type{border-top:0}
 .grp h3{margin:0 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#16333A}
 .ln{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;font-size:17px;margin-top:2px}
 .ln b{font-weight:700;min-width:52px}
 .ln a{color:#1B7F79;font-weight:700;text-decoration:none;font-variant-numeric:tabular-nums}
 .ln small{flex-basis:100%;color:#5F7A80;font-size:13px}
 .ln span{color:#5F7A80;font-size:14px}
 .urgent h3,.urgent .ln a{color:#E4574B}
 .urgent .ln a{font-size:22px;font-family:Fredoka,sans-serif}
</style>`;
  if (!member) {
    return new Response(
      head + `<title>${esc(event)}</title><main><div class=card><img class=logo src="/logo.png" alt="">` +
      `<h1>That code isn't on the list</h1><p class=crew>Check with a camp lead.</p></div>` +
      `<div class=card><h2>Important numbers</h2>${contactsHtml()}</div></main>`,
      { status: 404, headers: { "content-type": "text/html; charset=utf-8" } }
    );
  }
  return new Response(
    head + `<title>${esc(member.name)} — ${esc(event)}</title>
<main>
 <div class=card>
  <img class=logo src="/logo.png" alt="${esc(event)}">
  <h1>${esc(member.name)}</h1>
  <div class=crew>${esc(member.crew || event)}</div>
  <div class=bc id=bc></div>
  <div class=code>${esc(member.code)}</div>
 </div>
 <div class=card>
  <h2>Important numbers</h2>
  ${contactsHtml()}
 </div>
</main>
<script src="/vendor/JsBarcode.all.min.js"></script>
<script>
 var CODE = ${JSON.stringify(member.code)};
 try {
   var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
   JsBarcode(svg, CODE, { format: "CODE128", width: 3, height: 64, displayValue: false, margin: 0, background: "#ffffff" });
   svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
   var bw = parseFloat(svg.getAttribute("width")), bh = parseFloat(svg.getAttribute("height"));
   if (bw && bh) svg.setAttribute("viewBox", "0 0 " + bw + " " + bh);
   document.getElementById("bc").appendChild(svg);
 } catch (e) {}</script>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) return await handleApi(request, env, url);
      if (url.pathname.startsWith("/p/")) return await personPage(url.pathname.slice(3), env);
    } catch (err) {
      return bad("Server error: " + (err && err.message ? err.message : String(err)), 500);
    }
    return env.ASSETS.fetch(request);
  }
};
