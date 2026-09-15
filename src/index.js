import { buildPass } from "./pass.js";

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

async function handleApi(request, env, url) {
  const path = url.pathname.replace(/^\/api\/?/, "");
  const method = request.method;

  /* --- public: what this deployment can do --- */
  if (path === "config") {
    return json({
      wallet: Boolean(env.SIGNER_CERT_PEM && env.SIGNER_KEY_PEM && env.WWDR_PEM && env.PASS_TYPE_ID && env.TEAM_ID),
      pinRequired: Boolean(env.STAFF_PIN),
      event: env.EVENT_NAME || "Teen Beach Moonta"
    });
  }

  /* --- public: a signed Apple Wallet pass --- */
  if (path.startsWith("pass/")) {
    const code = path.slice(5).replace(/\.pkpass$/i, "").toUpperCase();
    const member = await env.DB.prepare("SELECT * FROM members WHERE code = ?").bind(code).first();
    if (!member) return bad("No one on the list has that code.", 404);
    if (!(env.SIGNER_CERT_PEM && env.SIGNER_KEY_PEM && env.WWDR_PEM && env.PASS_TYPE_ID && env.TEAM_ID)) {
      return bad("Apple Wallet isn't set up on this deployment yet — see README step 5.", 503);
    }
    try {
      const buffer = await buildPass(member, env);
      return new Response(buffer, {
        headers: {
          "content-type": "application/vnd.apple.pkpass",
          "content-disposition": `attachment; filename="teenbeach-${code}.pkpass"`,
          "cache-control": "no-store"
        }
      });
    } catch (err) {
      return bad("The pass couldn't be signed: " + (err && err.message ? err.message : String(err)), 500);
    }
  }

  /* --- everything below is staff only --- */
  if (!staffOk(request, env)) return bad("Wrong PIN.", 401);

  if (path === "rev") {
    const row = await env.DB.prepare("SELECT v FROM meta WHERE k = 'rev'").first();
    return json({ rev: row ? row.v : "0" });
  }

  if (path === "state") {
    const [members, activities, movements, rev] = await Promise.all([
      env.DB.prepare("SELECT * FROM members ORDER BY name").all(),
      env.DB.prepare("SELECT * FROM activities ORDER BY date, start").all(),
      env.DB.prepare(
        "SELECT m.t, m.dir, m.act, m.code, p.name FROM movements m LEFT JOIN members p ON p.code = m.code ORDER BY m.t DESC LIMIT 80"
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

  if (path === "scan" && method === "POST") {
    const { code, dir, act } = await request.json();
    const member = await env.DB.prepare("SELECT * FROM members WHERE code = ?").bind(String(code || "").toUpperCase()).first();
    if (!member) return bad("unknown-code", 404);
    if (dir === "out" && !act) return bad("no-destination");
    if (dir === "in" && member.state !== "out") return bad("already-in");

    const now = Date.now();
    const prev = { state: member.state, act: member.act, since: member.since };
    await env.DB.batch([
      env.DB.prepare("UPDATE members SET state = ?, act = ?, since = ? WHERE code = ?")
        .bind(dir === "out" ? "out" : "in", dir === "out" ? act : null, now, member.code),
      env.DB.prepare("INSERT INTO movements (code, dir, act, t) VALUES (?, ?, ?, ?)")
        .bind(member.code, dir, dir === "out" ? act : member.act, now)
    ]);
    await bumpRev(env);
    return json({ ok: true, member: { ...member, state: dir === "out" ? "out" : "in", act: dir === "out" ? act : null, since: now }, prev, at: now });
  }

  if (path === "undo" && method === "POST") {
    const { code, prev } = await request.json();
    if (!code || !prev) return bad("nothing-to-undo");
    await env.DB.batch([
      env.DB.prepare("UPDATE members SET state = ?, act = ?, since = ? WHERE code = ?")
        .bind(prev.state, prev.act, prev.since, String(code).toUpperCase()),
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
        state: "in",
        act: null,
        since: Date.now(),
        created: Date.now()
      };
      added.push(row);
      statements.push(
        env.DB.prepare("INSERT INTO members (code, name, crew, state, act, since, created) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .bind(row.code, row.name, row.crew, row.state, row.act, row.since, row.created)
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
    const id = "a" + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
    await env.DB.prepare(
      "INSERT INTO activities (id, name, loc, date, start, end, kind, dest) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(id, a.name, a.loc || "", a.date, a.start, a.end, a.kind || "main", a.dest ? 1 : 0).run();
    await bumpRev(env);
    return json({ ok: true, id });
  }

  if (path.startsWith("activities/") && method === "DELETE") {
    await env.DB.prepare("DELETE FROM activities WHERE id = ?").bind(path.slice(11)).run();
    await bumpRev(env);
    return json({ ok: true });
  }

  return bad("Unknown endpoint.", 404);
}

/* A plain page for one person: their code, QR and Wallet button. Send them
   https://your-site/p/THEIRCODE and they can add the pass themselves. */
async function personPage(code, env, origin) {
  const member = await env.DB.prepare("SELECT * FROM members WHERE code = ?").bind(code.toUpperCase()).first();
  const event = env.EVENT_NAME || "Teen Beach Moonta";
  if (!member) {
    return new Response(
      `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">` +
      `<title>${event}</title><body style="font-family:system-ui;padding:40px;text-align:center;color:#16333A">` +
      `<h1>That code isn't on the list</h1><p>Check with the camp registration desk.</p>`,
      { status: 404, headers: { "content-type": "text/html; charset=utf-8" } }
    );
  }
  const walletReady = Boolean(env.SIGNER_CERT_PEM && env.SIGNER_KEY_PEM && env.WWDR_PEM && env.PASS_TYPE_ID && env.TEAM_ID);
  return new Response(
    `<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>${member.name} — ${event}</title>
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
 .code{font-family:ui-monospace,Menlo,monospace;font-size:22px;letter-spacing:.24em;font-weight:700;margin-top:14px}
 a.btn{display:block;margin-top:22px;background:#F5459B;color:#fff;text-decoration:none;font-weight:700;
       padding:16px;border-radius:14px;font-size:17px}
 p.hint{color:#5F7A80;font-size:14px;margin-top:18px;line-height:1.5}
</style>
<div class=top><img src="/logo.png" alt=""><h1>${member.name}</h1><div class=crew>${member.crew || event}</div></div>
<main>
 <div class=qr id=qr></div>
 <div class=code>${member.code}</div>
 ${walletReady
      ? `<a class=btn href="/api/pass/${member.code}.pkpass">Add to Apple Wallet</a>`
      : `<p class=hint>Screenshot this page and the desk can scan it from your photos.</p>`}
 <p class=hint>Show this at the check in desk whenever you leave site and when you come back.</p>
</main>
<script src="/vendor/qrcode.js"></script>
<script>
 var q = qrcode(0, "M"); q.addData("${member.code}"); q.make();
 var n = q.getModuleCount(), quiet = 2, total = n + quiet * 2, d = "";
 for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (q.isDark(r, c)) d += "M" + (c + quiet) + " " + (r + quiet) + "h1v1h-1z";
 document.getElementById("qr").innerHTML =
   '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + total + ' ' + total + '" shape-rendering="crispEdges">' +
   '<rect width="' + total + '" height="' + total + '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
</script>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) return await handleApi(request, env, url);
      if (url.pathname.startsWith("/p/")) return await personPage(url.pathname.slice(3), env, url.origin);
    } catch (err) {
      return bad("Server error: " + (err && err.message ? err.message : String(err)), 500);
    }
    return env.ASSETS.fetch(request);
  }
};
