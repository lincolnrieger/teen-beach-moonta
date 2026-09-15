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

async function handleApi(request, env, url) {
  const path = url.pathname.replace(/^\/api\/?/, "");
  const method = request.method;

  /* --- public: what this deployment can do --- */
  if (path === "config") {
    return json({
      pinRequired: Boolean(env.STAFF_PIN),
      event: env.EVENT_NAME || "Teen Beach Moonta"
    });
  }

  /* --- everything below is staff only --- */
  if (!staffOk(request, env)) return bad("Wrong PIN.", 401);

  if (path === "rev") {
    const row = await env.DB.prepare("SELECT v FROM meta WHERE k = 'rev'").first();
    return json({ rev: row ? row.v : "0" });
  }

  if (path === "state") {
    const [members, activities, aiders, movements, rev] = await Promise.all([
      env.DB.prepare("SELECT * FROM members ORDER BY name").all(),
      env.DB.prepare("SELECT * FROM activities ORDER BY date, start").all(),
      env.DB.prepare("SELECT * FROM aiders ORDER BY date, start").all(),
      env.DB.prepare(
        "SELECT m.t, m.place, m.code, p.name FROM movements m LEFT JOIN members p ON p.code = m.code ORDER BY m.t DESC LIMIT 80"
      ).all(),
      env.DB.prepare("SELECT v FROM meta WHERE k = 'rev'").first()
    ]);
    return json({
      members: members.results,
      activities: activities.results.map((a) => ({ ...a, dest: !!a.dest })),
      aiders: aiders.results,
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

  if (path === "aiders" && method === "POST") {
    const a = await request.json();
    const who = String(a.who || "").trim();
    if (!who) return bad("Say who is on duty.");
    if (!a.date) return bad("Pick a day.");
    const id = newId("f");
    await env.DB.prepare("INSERT INTO aiders (id, date, start, end, who) VALUES (?, ?, ?, ?, ?)")
      .bind(id, a.date, a.start || "07:00", a.end || "19:00", who).run();
    await bumpRev(env);
    return json({ ok: true, id });
  }

  if (path.startsWith("aiders/") && method === "PATCH") {
    const a = await request.json();
    const who = String(a.who || "").trim();
    if (!who) return bad("Say who is on duty.");
    await env.DB.prepare("UPDATE aiders SET who = ?, start = ?, end = ? WHERE id = ?")
      .bind(who, a.start || "07:00", a.end || "19:00", path.slice(7)).run();
    await bumpRev(env);
    return json({ ok: true });
  }

  if (path.startsWith("aiders/") && method === "DELETE") {
    await env.DB.prepare("DELETE FROM aiders WHERE id = ?").bind(path.slice(7)).run();
    await bumpRev(env);
    return json({ ok: true });
  }

  return bad("Unknown endpoint.", 404);
}

/* A plain page for one person: their code as a QR code and a barcode. Send them
   https://your-site/p/THEIRCODE and they can keep it on their phone. */
async function personPage(code, env) {
  const member = await env.DB.prepare("SELECT * FROM members WHERE code = ?").bind(code.toUpperCase()).first();
  const event = env.EVENT_NAME || "Teen Beach Moonta";
  if (!member) {
    return new Response(
      `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">` +
      `<title>${esc(event)}</title><body style="font-family:system-ui;padding:40px;text-align:center;color:#16333A">` +
      `<h1>That code isn't on the list</h1><p>Check with the camp registration desk.</p>`,
      { status: 404, headers: { "content-type": "text/html; charset=utf-8" } }
    );
  }
  return new Response(
    `<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>${esc(member.name)} — ${esc(event)}</title>
<link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600&family=Archivo:wght@400;600;700&display=swap" rel=stylesheet>
<style>
 body{margin:0;background:#fff;color:#16333A;font-family:Archivo,system-ui,sans-serif;text-align:center}
 .top{background:#2BA8A0;color:#fff;padding:26px 20px 30px}
 .top img{width:92px;height:92px;border-radius:50%}
 h1{font-family:Fredoka,sans-serif;font-size:28px;margin:16px 0 4px}
 .crew{opacity:.9;font-size:15px}
 main{padding:26px 20px 50px;max-width:420px;margin:0 auto}
 .qr{width:230px;margin:0 auto}
 .qr svg{width:100%;height:auto;display:block}
 .bc{margin:20px auto 0;max-width:300px}
 .bc svg{width:100%;height:68px;display:block}
 .code{font-family:ui-monospace,Menlo,monospace;font-size:22px;letter-spacing:.24em;font-weight:700;margin-top:10px}
 p.hint{color:#5F7A80;font-size:14px;margin-top:18px;line-height:1.5}
</style>
<div class=top><img src="/logo.png" alt=""><h1>${esc(member.name)}</h1><div class=crew>${esc(member.crew || event)}</div></div>
<main>
 <div class=qr id=qr></div>
 <div class=bc id=bc></div>
 <div class=code>${esc(member.code)}</div>
 <p class=hint>Screenshot this page — the desk can scan either code from your photos.</p>
 <p class=hint>Show it whenever you move between camp and an activity.</p>
</main>
<script src="/vendor/qrcode.js"></script>
<script src="/vendor/JsBarcode.all.min.js"></script>
<script>
 var CODE = ${JSON.stringify(member.code)};
 var q = qrcode(0, "M"); q.addData(CODE); q.make();
 var n = q.getModuleCount(), quiet = 2, total = n + quiet * 2, d = "";
 for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (q.isDark(r, c)) d += "M" + (c + quiet) + " " + (r + quiet) + "h1v1h-1z";
 document.getElementById("qr").innerHTML =
   '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + total + ' ' + total + '" shape-rendering="crispEdges">' +
   '<rect width="' + total + '" height="' + total + '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
 try {
   var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
   JsBarcode(svg, CODE, { format: "CODE128", width: 3, height: 68, displayValue: false, margin: 0, background: "#ffffff" });
   svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
   var bw = parseFloat(svg.getAttribute("width")), bh = parseFloat(svg.getAttribute("height"));
   if (bw && bh) svg.setAttribute("viewBox", "0 0 " + bw + " " + bh);
   document.getElementById("bc").appendChild(svg);
 } catch (e) {}
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
