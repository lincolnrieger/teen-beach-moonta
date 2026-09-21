import { login, staffOk, pinRequired, lockedOut } from "./auth.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
const bad = (message, status = 400) => json({ error: message }, status);

async function bumpRev(env) {
  await env.DB.prepare(
    "INSERT INTO meta (k, v) VALUES ('rev', ?1) ON CONFLICT(k) DO UPDATE SET v = ?1"
  ).bind(String(Date.now())).run();
}

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
      pinRequired: pinRequired(env),
      unprotected: !pinRequired(env),
      event: env.EVENT_NAME || "Teen Beach Moonta"
    });
  }

  /* --- public: trade the PIN for a session token --- */
  if (path === "login" && method === "POST") {
    const wait = lockedOut(request);
    if (wait) return json({ error: "locked-out", wait }, 429);
    const { pin } = await request.json().catch(() => ({}));
    const res = await login(request, env, String(pin || ""));
    if (!res.ok) return bad(res.reason === "no-pin-set" ? "no-pin-set" : "wrong-pin", 401);
    return json({ ok: true, token: res.token, expires: res.expires });
  }

  /* --- public: one person's own status, for their card page --- */
  if (path.startsWith("me/")) {
    await ensureSchema(env);
    const code = path.slice(3).toUpperCase();
    const member = await env.DB.prepare("SELECT code, name, crew, place, since FROM members WHERE code = ?")
      .bind(code).first();
    if (!member) return bad("unknown-code", 404);
    const acts = await env.DB.prepare("SELECT id, name, loc, date, start, end, kind, site FROM activities ORDER BY date, start").all();
    const here = acts.results.find((a) => a.id === member.place) || null;
    return json({
      member,
      where: member.place === "home" ? { kind: "home", name: "Departing camp" }
        : here ? { kind: here.site === "off" ? "off" : "onsite", name: here.name, loc: here.loc, end: here.end, date: here.date }
        : { kind: "onsite", name: "On site" },
      activities: acts.results
    });
  }

  /* --- everything below is staff only --- */
  if (!(await staffOk(request, env))) return bad("Wrong PIN.", 401);

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

  /* A scan just moves someone to the place the desk has selected: 'onsite',
     'home', or an activity id. There is no in/out flag to get out of step. */
  if (path === "scan" && method === "POST") {
    const { code, place } = await request.json();
    const where = String(place || "").trim();
    if (!where) return bad("no-destination");
    const member = await env.DB.prepare("SELECT * FROM members WHERE code = ?")
      .bind(String(code || "").toUpperCase()).first();
    if (!member) return bad("unknown-code", 404);
    if (where !== "onsite" && where !== "home") {
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

  if (path.startsWith("members/") && method === "DELETE") {
    const code = path.slice(8).toUpperCase();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM members WHERE code = ?").bind(code),
      env.DB.prepare("DELETE FROM movements WHERE code = ?").bind(code)
    ]);
    await bumpRev(env);
    return json({ ok: true });
  }

  if (path === "activities" && method === "POST") {
    const a = await request.json();
    if (!a.name) return bad("Give the activity a name.");
    const id = newId("a");
    await env.DB.prepare(
      "INSERT INTO activities (id, name, loc, date, start, end, kind, site, dest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(id, a.name, a.loc || "", a.date, a.start, a.end, a.kind || "main", a.site === "off" ? "off" : "on", a.dest ? 1 : 0).run();
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

/* One person's own page. They get the link once and keep it on their phone:
   their two codes to be scanned, where the desk currently has them, what is on
   today, and the numbers to ring if something goes wrong. */
function contactsOf(env) {
  try {
    const list = JSON.parse(env.EVENT_CONTACTS || "[]");
    return Array.isArray(list) ? list.filter((c) => c && c.name && c.phone) : [];
  } catch {
    return [];
  }
}

async function personPage(code, env) {
  await ensureSchema(env);
  const member = await env.DB.prepare("SELECT * FROM members WHERE code = ?").bind(code.toUpperCase()).first();
  const event = env.EVENT_NAME || "Teen Beach Moonta";
  if (!member) {
    return new Response(
      `<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">` +
      `<title>${esc(event)}</title>` +
      `<body style="margin:0;font-family:system-ui,sans-serif;background:#2BA8A0;color:#fff;min-height:100vh;display:grid;place-items:center;padding:32px;text-align:center">` +
      `<div><img src="/logo.png" width="96" height="96" style="border-radius:50%" alt="">` +
      `<h1 style="font-size:24px;margin:20px 0 8px">That code isn't on the list</h1>` +
      `<p style="opacity:.9;margin:0">Check with the camp registration desk.</p></div>`,
      { status: 404, headers: { "content-type": "text/html; charset=utf-8" } }
    );
  }

  const contacts = contactsOf(env);
  const contactRows = contacts.map((c) =>
    `<a class=contact href="tel:${esc(String(c.phone).replace(/[^0-9+]/g, ""))}">` +
    `<span class=cname><b>${esc(c.name)}</b>${c.role ? `<small>${esc(c.role)}</small>` : ""}</span>` +
    `<span class=cnum>${esc(c.phone)}</span></a>`
  ).join("");

  return new Response(
    `<!doctype html><html lang=en><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name=theme-color content="#2BA8A0">
<title>${esc(member.name)} — ${esc(event)}</title>
<link rel="icon" href="/logo.png">
<link rel=preconnect href="https://fonts.googleapis.com">
<link rel=preconnect href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&family=Archivo:wght@400;600;700&display=swap" rel=stylesheet>
<style>
 :root{--teal:#2BA8A0;--teal-dk:#1B7F79;--teal-lt:#E3F5F3;--pink:#F5459B;--ink:#16333A;--dim:#5F7A80;
       --line:#DCE7E7;--warn-bg:#FFF0D6;--warn:#A4650B;--ok-bg:#E2F5EC;--ok:#17845F;--coral:#FF6F61;
       --pad-top:env(safe-area-inset-top,0px);--pad-bot:env(safe-area-inset-bottom,0px)}
 *{box-sizing:border-box}
 body{margin:0;background:#F4F9F9;color:var(--ink);font-family:Archivo,system-ui,sans-serif;line-height:1.5;
      -webkit-font-smoothing:antialiased}
 .top{background:var(--teal);color:#fff;padding:calc(24px + var(--pad-top)) 20px 34px;text-align:center;position:relative}
 .top img{width:82px;height:82px;border-radius:50%;box-shadow:0 4px 14px rgba(0,0,0,.18)}
 .top h1{font-family:Fredoka,sans-serif;font-size:27px;margin:14px 0 2px;font-weight:600;line-height:1.15}
 .top .crew{opacity:.92;font-size:15px}
 .wave{display:block;width:100%;height:26px;margin-top:-1px}
 main{max-width:460px;margin:0 auto;padding:0 16px calc(40px + var(--pad-bot))}
 .card{background:#fff;border:1px solid var(--line);border-radius:18px;padding:20px;margin-top:-18px;
       box-shadow:0 10px 28px rgba(22,51,58,.10);position:relative}
 .card + .card{margin-top:16px}
 h2{font-family:Fredoka,sans-serif;font-size:13px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;
    color:var(--dim);margin:0 0 12px}
 .status{display:flex;align-items:center;gap:14px}
 .blob{width:52px;height:52px;border-radius:16px;flex:0 0 auto;display:grid;place-items:center;font-size:24px;
       background:var(--ok-bg)}
 .status.off .blob{background:var(--warn-bg)}
 .status.home .blob{background:#EEF3F4}
 .where{font-family:Fredoka,sans-serif;font-size:21px;font-weight:600;line-height:1.15}
 .whensince{font-size:13.5px;color:var(--dim);margin-top:2px}
 .codes{text-align:center}
 .qr{width:215px;margin:0 auto;max-width:100%}
 .qr svg{width:100%;height:auto;display:block;border-radius:6px}
 .bc{margin:18px auto 0;max-width:290px}
 .bc svg{width:100%;height:62px;display:block}
 .code{font-family:ui-monospace,Menlo,monospace;font-size:21px;letter-spacing:.24em;font-weight:700;margin-top:8px}
 .hint{color:var(--dim);font-size:13.5px;margin:14px 0 0}
 ul.prog{list-style:none;margin:0;padding:0}
 ul.prog li{display:flex;gap:12px;align-items:baseline;padding:10px 0;border-top:1px solid var(--line)}
 ul.prog li:first-child{border-top:0}
 ul.prog .t{font-size:13px;font-weight:700;color:var(--dim);font-variant-numeric:tabular-nums;flex:0 0 auto;white-space:nowrap}
 ul.prog .n{flex:1 1 auto;font-weight:600;font-size:15px}
 ul.prog .n small{display:block;font-weight:500;font-size:12px;color:var(--dim)}
 ul.prog li.now{background:var(--teal-lt);margin:0 -10px;padding:10px;border-radius:10px;border-top:0}
 .tagnow{font-size:10.5px;font-weight:800;color:#fff;background:var(--teal);padding:2px 7px;border-radius:999px}
 .tagoff{font-size:10.5px;font-weight:800;color:var(--warn);background:var(--warn-bg);padding:2px 7px;border-radius:999px}
 a.contact{display:flex;align-items:center;justify-content:space-between;gap:12px;text-decoration:none;color:inherit;
           padding:12px 0;border-top:1px solid var(--line)}
 a.contact:first-of-type{border-top:0}
 .cname b{display:block;font-size:16px}
 .cname small{color:var(--dim);font-size:12.5px}
 .cnum{font-weight:700;color:var(--teal-dk);white-space:nowrap;font-size:15.5px}
 a.emergency{display:flex;align-items:center;justify-content:space-between;gap:12px;text-decoration:none;
             background:var(--coral);color:#fff;border-radius:14px;padding:15px 18px;font-weight:700;font-size:17px;
             margin-top:4px}
 .foot{text-align:center;color:var(--dim);font-size:12.5px;margin-top:22px}
</style>
<div class=top>
 <img src="/logo.png" alt="">
 <h1>${esc(member.name)}</h1>
 <div class=crew>${esc(member.crew || event)}</div>
</div>
<svg class=wave viewBox="0 0 1200 40" preserveAspectRatio=none aria-hidden=true>
 <path d="M0 22 C 150 44 250 2 400 14 C 550 26 620 44 780 30 C 920 18 1050 0 1200 16 L1200 0 L0 0 Z" fill="#2BA8A0"/>
 <path d="M0 22 C 150 44 250 2 400 14 C 550 26 620 44 780 30 C 920 18 1050 0 1200 16 L1200 40 L0 40 Z" fill="#F4F9F9"/>
</svg>
<main>
 <div class=card>
  <h2>Where the desk has you</h2>
  <div class="status" id=status>
   <div class=blob id=blob>📍</div>
   <div><div class=where id=where>Checking…</div><div class=whensince id=whensince></div></div>
  </div>
 </div>

 <div class="card codes">
  <h2>Your codes</h2>
  <div class=qr id=qr></div>
  <div class=bc id=bc></div>
  <div class=code>${esc(member.code)}</div>
 </div>

 <div class=card id=progCard hidden>
  <h2>Today</h2>
  <ul class=prog id=prog></ul>
 </div>

 ${contacts.length ? `<div class=card><h2>Who to ring</h2>${contactRows}</div>` : ""}

 <a class=emergency href="tel:000"><span>Emergency</span><span>000</span></a>
 <p class=foot>${esc(event)}</p>
</main>
<script src="/vendor/qrcode.js"></script>
<script src="/vendor/JsBarcode.all.min.js"></script>
<script>
(function () {
  var CODE = ${JSON.stringify(member.code)};

  var q = qrcode(0, "M"); q.addData(CODE); q.make();
  var n = q.getModuleCount(), quiet = 2, total = n + quiet * 2, d = "";
  for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (q.isDark(r, c)) d += "M" + (c + quiet) + " " + (r + quiet) + "h1v1h-1z";
  document.getElementById("qr").innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + total + ' ' + total + '" shape-rendering="crispEdges">' +
    '<rect width="' + total + '" height="' + total + '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
  try {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    JsBarcode(svg, CODE, { format: "CODE128", width: 3, height: 62, displayValue: false, margin: 0, background: "#ffffff" });
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    var bw = parseFloat(svg.getAttribute("width")), bh = parseFloat(svg.getAttribute("height"));
    if (bw && bh) svg.setAttribute("viewBox", "0 0 " + bw + " " + bh);
    document.getElementById("bc").appendChild(svg);
  } catch (e) {}

  function esc(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
  function todayISO(){ var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0"); }
  function mins(t){ var p = String(t||"").split(":"); return (parseInt(p[0],10)||0)*60 + (parseInt(p[1],10)||0); }
  function ago(ms){ var m = Math.max(0, Math.round((Date.now()-ms)/60000));
    return m < 1 ? "just now" : m < 60 ? m + " min ago" : Math.floor(m/60) + "h " + String(m%60).padStart(2,"0") + "m ago"; }

  var ICON = { onsite: "⛺", off: "🚌", home: "👋" };
  async function tick() {
    try {
      var r = await fetch("/api/me/" + CODE, { cache: "no-store" });
      if (!r.ok) return;
      var d = await r.json();
      var w = d.where, m = d.member;
      document.getElementById("status").className = "status " + w.kind;
      document.getElementById("blob").textContent = ICON[w.kind] || "📍";
      document.getElementById("where").textContent =
        w.kind === "home" ? "Departing camp" : w.kind === "off" ? "Off site — " + w.name : w.name === "On site" ? "On site" : "On site — " + w.name;
      document.getElementById("whensince").textContent =
        (m.since ? "Since " + ago(m.since) : "") + (w.end && w.kind === "off" ? " · back by " + w.end : "");

      var today = todayISO(), nm = new Date().getHours()*60 + new Date().getMinutes();
      var list = (d.activities || []).filter(function (a) {
        return a.date === today && a.kind !== "cater" && mins(a.end) >= nm;
      }).slice(0, 6);
      var card = document.getElementById("progCard");
      card.hidden = list.length === 0;
      document.getElementById("prog").innerHTML = list.map(function (a) {
        var on = nm >= mins(a.start) && nm < mins(a.end);
        return '<li class="' + (on ? "now" : "") + '"><span class=t>' + esc(a.start) + "–" + esc(a.end) + "</span>" +
          '<span class=n>' + esc(a.name) +
          (a.loc ? "<small>" + esc(a.loc) + "</small>" : "") + "</span>" +
          (on ? '<span class=tagnow>now</span>' : a.site === "off" ? '<span class=tagoff>off site</span>' : "") + "</li>";
      }).join("");
    } catch (e) { /* offline — leave the last state showing */ }
  }
  tick();
  setInterval(function () { if (!document.hidden) tick(); }, 20000);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) tick(); });
})();
</script>`,
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
