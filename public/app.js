/* Teen Beach Moonta — camp check in board.
   Talks to the Worker API in src/index.js. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var SVGNS = "http://www.w3.org/2000/svg";
  var EVENT = "Teen Beach Moonta";
  var DATES = "2–5 October 2026";
  var LOGO = "/logo.png";

  /* First aid roster from the programme sheet — reference only, not stored. */
  var AID = [
    { date: "2026-10-05", start: "06:00", end: "07:00", who: "Bella" },
    { date: "2026-10-05", start: "07:00", end: "13:00", who: "Victor" },
    { date: "2026-10-05", start: "13:00", end: "19:00", who: "Jordan" }
  ];
  var STATIC_DESTS = [
    { id: "town", name: "Moonta town", note: "Shops, chemist, supplies" },
    { id: "beach", name: "Beach / foreshore", note: "Moonta Bay" },
    { id: "other", name: "Somewhere else", note: "Anything not listed" }
  ];

  var members = new Map();
  var activities = new Map();
  var movements = [];
  var config = { wallet: false, pinRequired: false };
  var rev = null;
  var ui = { view: "station", mode: "auto", dest: null, recent: [], day: null, card: null, showAll: false };
  var lastScan = { code: null, at: 0 };
  var undoable = null;

  /* ---------------- api ---------------- */
  function pin() { try { return localStorage.getItem("tbm.pin") || ""; } catch (e) { return ""; } }
  async function api(path, options) {
    options = options || {};
    options.headers = Object.assign({ "x-pin": pin() }, options.headers || {});
    if (options.body && typeof options.body !== "string") {
      options.body = JSON.stringify(options.body);
      options.headers["content-type"] = "application/json";
    }
    var res = await fetch("/api/" + path, options);
    if (res.status === 401) { showGate("That PIN didn't work."); throw new Error("unauthorised"); }
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { code: data.error, status: res.status });
    return data;
  }

  async function refresh(force) {
    try {
      if (!force) {
        var r = await api("rev");
        if (r.rev === rev) return;
      }
      var state = await api("state");
      rev = state.rev;
      members.clear();
      state.members.forEach(function (m) { members.set(m.code, m); });
      activities.clear();
      state.activities.forEach(function (a) { activities.set(a.id, a); });
      movements = state.movements || [];
      renderAll();
    } catch (e) { /* offline or locked — keep showing the last board */ }
  }

  function download(filename, data, type) {
    var blob = data instanceof Blob ? data : new Blob([data], { type: type || "text/plain;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  /* ---------------- helpers ---------------- */
  function todayISO(d) {
    d = d || new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function clock(ms) {
    var d = new Date(ms);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }
  function since(ms) {
    var m = Math.max(0, Math.round((Date.now() - ms) / 60000));
    return m < 60 ? m + " min" : Math.floor(m / 60) + "h " + String(m % 60).padStart(2, "0") + "m";
  }
  function mins(hhmm) {
    var p = String(hhmm || "").split(":");
    return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
  }
  function nowMins() { var d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
  function staticDest(id) {
    for (var i = 0; i < STATIC_DESTS.length; i++) if (STATIC_DESTS[i].id === id) return STATIC_DESTS[i];
    return null;
  }
  function actLabel(id) {
    if (!id) return "off site";
    var s = staticDest(id);
    if (s) return s.name;
    var a = activities.get(id);
    return a ? a.name : "off site";
  }
  function endStamp(a) {
    if (!a || !a.date || !a.end) return null;
    var t = new Date(a.date + "T" + a.end + ":00");
    return isNaN(t.getTime()) ? null : t.getTime();
  }
  function isLate(m) {
    if (m.state !== "out" || !m.act || staticDest(m.act)) return false;
    var e = endStamp(activities.get(m.act));
    return !!e && Date.now() > e + 15 * 60000;
  }
  function sortedMembers() {
    return Array.from(members.values()).sort(function (a, b) { return a.name.localeCompare(b.name); });
  }
  function sortedActivities() {
    return Array.from(activities.values()).sort(function (a, b) { return (a.date + a.start).localeCompare(b.date + b.start); });
  }

  /* ---------------- QR + barcode ---------------- */
  function qrSvg(text) {
    var q = qrcode(0, "M"); q.addData(text); q.make();
    var n = q.getModuleCount(), quiet = 2, total = n + quiet * 2, d = "";
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) {
      if (q.isDark(r, c)) d += "M" + (c + quiet) + " " + (r + quiet) + "h1v1h-1z";
    }
    return '<svg xmlns="' + SVGNS + '" viewBox="0 0 ' + total + " " + total +
      '" shape-rendering="crispEdges"><rect width="' + total + '" height="' + total + '" fill="#fff"/>' +
      '<path d="' + d + '" fill="#000"/></svg>';
  }
  function qrOnCanvas(ctx, text, x, y, size) {
    var q = qrcode(0, "M"); q.addData(text); q.make();
    var n = q.getModuleCount(), quiet = 2, total = n + quiet * 2, s = size / total;
    ctx.fillStyle = "#fff"; ctx.fillRect(x, y, size, size);
    ctx.fillStyle = "#000";
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) {
      if (q.isDark(r, c)) ctx.fillRect(Math.round(x + (c + quiet) * s), Math.round(y + (r + quiet) * s), Math.ceil(s), Math.ceil(s));
    }
  }
  function barcodeSvg(code, w, h) {
    var svg = document.createElementNS(SVGNS, "svg");
    try { JsBarcode(svg, code, { format: "CODE128", width: w || 2, height: h || 34, displayValue: false, margin: 0, lineColor: "#000", background: "#ffffff" }); }
    catch (e) { return ""; }
    svg.setAttribute("xmlns", SVGNS);
    var bw = parseFloat(svg.getAttribute("width")), bh = parseFloat(svg.getAttribute("height"));
    if (bw && bh) svg.setAttribute("viewBox", "0 0 " + bw + " " + bh);
    return svg.outerHTML;
  }
  function barcodeCanvas(code, w, h) {
    var c = document.createElement("canvas");
    try { JsBarcode(c, code, { format: "CODE128", width: w, height: h, displayValue: false, margin: 0, lineColor: "#000", background: "#ffffff" }); }
    catch (e) { return null; }
    return c;
  }

  /* ---------------- scanning ---------------- */
  var audio = null;
  function beep(ok) {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      var o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = ok ? 950 : 240;
      o.connect(g); g.connect(audio.destination);
      g.gain.setValueAtTime(0.09, audio.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + (ok ? 0.12 : 0.3));
      o.start(); o.stop(audio.currentTime + (ok ? 0.13 : 0.32));
    } catch (e) {}
  }
  var armedMap = new Map();
  function arm(btn, key, label, fn) {
    var p = armedMap.get(key);
    if (p) { clearTimeout(p); armedMap.delete(key); fn(); return; }
    var original = btn.textContent;
    btn.textContent = label;
    armedMap.set(key, setTimeout(function () { armedMap.delete(key); btn.textContent = original; }, 4500));
  }
  function showResult(kind, who, what, when) {
    var el = $("result");
    el.className = "result " + (kind || "");
    $("resWho").textContent = who;
    $("resWhat").textContent = what;
    $("resWhen").textContent = when || "";
    el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
  }

  async function processScan(raw) {
    var code = String(raw || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!code) return;
    var now = Date.now();
    if (code === lastScan.code && now - lastScan.at < 2500) return;
    lastScan = { code: code, at: now };

    var local = members.get(code);
    var dir = ui.mode === "auto" ? (local && local.state === "out" ? "in" : "out") : ui.mode;
    if (dir === "out" && !ui.dest) {
      beep(false);
      showResult("bad", local ? local.name : code, "Pick where they're going first.", "");
      return;
    }
    try {
      var res = await api("scan", { method: "POST", body: { code: code, dir: dir, act: dir === "out" ? ui.dest : null } });
      var m = res.member;
      members.set(m.code, m);
      undoable = { code: m.code, prev: res.prev };
      $("undoBtn").disabled = false;
      beep(true);
      if (dir === "out") {
        showResult("out", m.name, (res.prev.state === "out" ? "Moved to " : "Signed out to ") + actLabel(ui.dest),
          clock(res.at) + (m.crew ? " · " + m.crew : ""));
      } else {
        showResult("in", m.name, "Back on site from " + actLabel(res.prev.act),
          clock(res.at) + " · away " + since(res.prev.since || res.at));
      }
      ui.recent.unshift({ name: m.name, dir: dir, where: actLabel(dir === "out" ? ui.dest : res.prev.act), t: res.at });
      ui.recent = ui.recent.slice(0, 8);
      renderRecent();
      refresh(true);
    } catch (err) {
      beep(false);
      if (err.code === "unknown-code") showResult("bad", "Code not recognised", "“" + code + "” isn't on the list.", "Add them under People & passes.");
      else if (err.code === "already-in") showResult("bad", local ? local.name : code, "Already marked on site.", "Nothing changed.");
      else showResult("bad", "That didn't save", err.message || "Check the connection and try again.", "");
    }
  }

  async function undoLast() {
    if (!undoable) return;
    try {
      await api("undo", { method: "POST", body: undoable });
      showResult("", "Undone", "The last scan has been rolled back.", "");
      ui.recent.shift(); renderRecent();
    } catch (e) { showResult("bad", "Couldn't undo", e.message || "", ""); }
    undoable = null;
    $("undoBtn").disabled = true;
    lastScan = { code: null, at: 0 };
    refresh(true);
  }

  var cam = { stream: null, raf: 0, canvas: null };
  async function toggleCamera() {
    if (cam.stream) return stopCamera();
    $("camBtn").textContent = "Starting…";
    try { cam.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }); }
    catch (e) {
      $("camBtn").textContent = "Use the camera";
      $("scanHint").textContent = "The camera couldn't start. Check the browser's camera permission, or use a scanner.";
      return;
    }
    var v = $("video");
    v.srcObject = cam.stream;
    await v.play().catch(function () {});
    $("camWrap").hidden = false;
    $("camBtn").textContent = "Stop the camera";
    cam.canvas = cam.canvas || document.createElement("canvas");
    var ctx = cam.canvas.getContext("2d", { willReadFrequently: true });
    (function tick() {
      cam.raf = requestAnimationFrame(tick);
      if (v.readyState !== 4) return;
      var w = 320, h = Math.round(v.videoHeight / v.videoWidth * 320) || 240;
      cam.canvas.width = w; cam.canvas.height = h;
      ctx.drawImage(v, 0, 0, w, h);
      var d = ctx.getImageData(0, 0, w, h);
      var hit = window.jsQR ? jsQR(d.data, w, h, { inversionAttempts: "dontInvert" }) : null;
      if (hit && hit.data) processScan(hit.data);
    })();
  }
  function stopCamera() {
    if (cam.raf) cancelAnimationFrame(cam.raf);
    if (cam.stream) cam.stream.getTracks().forEach(function (t) { t.stop(); });
    cam.stream = null;
    $("camWrap").hidden = true;
    $("camBtn").textContent = "Use the camera";
  }

  /* ---------------- render ---------------- */
  function renderAll() {
    renderTally(); renderDests(); renderRecent();
    renderBoard(); renderSchedule(); renderMembers();
  }
  function renderTally() {
    var all = Array.from(members.values());
    var out = all.filter(function (m) { return m.state === "out"; });
    var late = out.filter(isLate);
    $("tally").innerHTML =
      "<div><b>" + (all.length - out.length) + "</b><small>on site</small></div>" +
      "<div><b>" + out.length + "</b><small>away</small></div>" +
      (late.length ? '<div class="hot"><b>' + late.length + "</b><small>due back</small></div>" : "");
  }
  function renderDests() {
    var acts = sortedActivities().filter(function (a) { return ui.showAll || a.dest !== false; });
    var today = todayISO();
    $("dests").innerHTML = acts.map(function (a) {
      var when = (a.date === today ? "today " : a.date.slice(8) + "/" + a.date.slice(5, 7) + " ") + a.start + "–" + a.end;
      return '<button class="dest" type="button" data-dest="' + esc(a.id) + '" aria-pressed="' + (ui.dest === a.id) + '"><b>' +
        esc(a.name) + "</b><small>" + esc(when + (a.loc ? " · " + a.loc : "")) + "</small></button>";
    }).join("") + STATIC_DESTS.map(function (s) {
      return '<button class="dest off" type="button" data-dest="' + s.id + '" aria-pressed="' + (ui.dest === s.id) + '"><b>' +
        esc(s.name) + "</b><small>" + esc(s.note) + "</small></button>";
    }).join("");
  }
  function renderRecent() {
    $("recent").innerHTML = ui.recent.length ? ui.recent.map(function (r) {
      return "<li><b>" + esc(r.name) + "</b> <span>" +
        (r.dir === "out" ? "out to " + esc(r.where) : "back on site") + " · " + clock(r.t) + "</span></li>";
    }).join("") : '<li style="border:0;color:var(--dim)">Scans show up here.</li>';
  }
  function personHtml(m) {
    var late = isLate(m);
    return '<div class="person' + (late ? " late" : "") + '"><b>' + esc(m.name) + "</b><small>" +
      esc(m.crew || m.code) + " · " + (m.state === "out" ? "away " + since(m.since) : "here") +
      (late ? " · due back" : "") + "</small></div>";
  }
  function renderBoard() {
    var all = Array.from(members.values());
    var out = all.filter(function (m) { return m.state === "out"; });
    var late = out.filter(isLate);
    $("boardStats").innerHTML =
      '<div class="stat"><b>' + (all.length - out.length) + "</b><small>on site right now</small></div>" +
      '<div class="stat pink"><b>' + out.length + "</b><small>away right now</small></div>" +
      '<div class="stat' + (late.length ? " warn" : "") + '"><b>' + late.length + "</b><small>past their return time</small></div>" +
      '<div class="stat"><b>' + all.length + "</b><small>on the list</small></div>";
    var q = ($("boardSearch").value || "").trim().toLowerCase();
    function match(m) { return !q || (m.name + " " + (m.crew || "") + " " + m.code).toLowerCase().indexOf(q) >= 0; }
    var groups = new Map();
    out.filter(match).forEach(function (m) {
      var k = m.act || "other";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(m);
    });
    var html = Array.from(groups.entries())
      .sort(function (a, b) { return actLabel(a[0]).localeCompare(actLabel(b[0])); })
      .map(function (pair) {
        var a = activities.get(pair[0]);
        return '<div class="group"><div class="group-head"><h3>' + esc(actLabel(pair[0])) + "</h3><em>" +
          pair[1].length + " away" + (a ? " · due back " + esc(a.end) : "") + '</em></div><div class="people">' +
          pair[1].sort(function (x, y) { return x.name.localeCompare(y.name); }).map(personHtml).join("") + "</div></div>";
      }).join("");
    var here = all.filter(function (m) { return m.state !== "out"; }).filter(match)
      .sort(function (x, y) { return x.name.localeCompare(y.name); });
    html += '<div class="group"><div class="group-head"><h3>On site</h3><em>' + here.length + " here</em></div>" +
      (here.length ? '<div class="people">' + here.map(personHtml).join("") + "</div>" : '<p class="muted">Nobody is marked on site.</p>') + "</div>";
    $("boardGroups").innerHTML = all.length ? html :
      '<div class="empty">Nobody on the list yet. Add people under <b>People &amp; passes</b>.</div>';
  }
  function renderSchedule() {
    var acts = sortedActivities();
    var days = Array.from(new Set(acts.map(function (a) { return a.date; })));
    if (days.indexOf(todayISO()) < 0) days.push(todayISO());
    days.sort();
    if (!ui.day || days.indexOf(ui.day) < 0) ui.day = days.indexOf(todayISO()) >= 0 ? todayISO() : days[0];
    $("dayPick").innerHTML = days.map(function (d) {
      var label = new Date(d + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
      return '<option value="' + d + '"' + (d === ui.day ? " selected" : "") + ">" + esc(label) + (d === todayISO() ? " — today" : "") + "</option>";
    }).join("");

    var isToday = ui.day === todayISO(), nm = nowMins();
    $("aidbar").innerHTML = AID.filter(function (a) { return a.date === ui.day; }).map(function (a) {
      var on = isToday && nm >= mins(a.start) && nm < mins(a.end);
      return '<div class="aid"' + (on ? ' style="border-color:var(--pink)"' : "") + "><b>" + esc(a.who) + "</b> " +
        esc(a.start) + "–" + esc(a.end) + (on ? " · on duty now" : "") + "</div>";
    }).join("") || '<div class="muted">No first aid roster for this day.</div>';

    var counts = new Map();
    members.forEach(function (m) { if (m.state === "out" && m.act) counts.set(m.act, (counts.get(m.act) || 0) + 1); });

    var dayActs = acts.filter(function (a) { return a.date === ui.day; });
    $("agenda").innerHTML = dayActs.length ? dayActs.map(function (a) {
      var now = isToday && nm >= mins(a.start) && nm < mins(a.end);
      var done = isToday && nm >= mins(a.end);
      var n = counts.get(a.id) || 0;
      var cls = "slot " + (a.kind === "meal" ? "meal " : a.kind === "cater" ? "cater " : "") + (now ? "now " : done ? "done " : "");
      return '<div class="' + cls.trim() + '"><div class="tm">' + esc(a.start) + "–" + esc(a.end) + "</div>" +
        '<div class="nm">' + esc(a.name) + (a.loc || a.kind === "cater" ? "<small>" + esc(a.loc || "catering team") + "</small>" : "") + "</div>" +
        '<div class="cnt">' + (n ? n + " away now" : now ? "on now" : "") + "</div></div>";
    }).join("") : '<div class="empty">Nothing on the programme for this day yet.</div>';

    $("feed").innerHTML = movements.length ? movements.map(function (e) {
      return "<li><time>" + clock(e.t) + '</time><span class="pill' + (e.dir === "in" ? " in" : "") + '">' +
        (e.dir === "in" ? "in" : "out") + "</span><span><b>" + esc(e.name || e.code) + "</b> " +
        (e.dir === "in" ? "returned from " : "left for ") + esc(actLabel(e.act)) + "</span></li>";
    }).join("") : '<li style="border:0;color:var(--dim)">No movements recorded yet.</li>';

    $("actTable").innerHTML = acts.length
      ? "<thead><tr><th>Activity</th><th>When</th><th>Where</th><th>At the desk</th><th>Away</th><th></th></tr></thead><tbody>" +
      acts.map(function (a) {
        return "<tr><td><b>" + esc(a.name) + "</b></td><td>" + esc(a.date.slice(8) + "/" + a.date.slice(5, 7)) + " " +
          esc(a.start) + "–" + esc(a.end) + "</td><td>" + esc(a.loc || "—") + "</td><td>" +
          (a.dest ? '<span class="tag">shown</span>' : '<span class="muted">hidden</span>') +
          "</td><td>" + (counts.get(a.id) || 0) + '</td><td class="actions"><button class="btn small danger" data-delact="' +
          esc(a.id) + '">Remove</button></td></tr>';
      }).join("") + "</tbody>"
      : "<tbody><tr><td class='muted'>No activities yet.</td></tr></tbody>";
  }
  function renderMembers() {
    var q = ($("mSearch").value || "").trim().toLowerCase();
    var list = sortedMembers().filter(function (m) {
      return !q || (m.name + " " + (m.crew || "") + " " + m.code).toLowerCase().indexOf(q) >= 0;
    });
    $("memTable").innerHTML = list.length
      ? "<thead><tr><th>Name</th><th>Crew</th><th>Code</th><th>Status</th><th></th></tr></thead><tbody>" +
      list.map(function (m) {
        return "<tr><td><b>" + esc(m.name) + "</b></td><td>" + esc(m.crew || "—") + '</td><td class="code">' + esc(m.code) +
          "</td><td>" + (m.state === "out" ? '<span class="tag out">away</span>' : '<span class="tag">on site</span>') +
          '</td><td class="actions"><button class="btn small" data-card="' + esc(m.code) + '">Card &amp; pass</button> ' +
          '<button class="btn small danger" data-delmem="' + esc(m.code) + '">Remove</button></td></tr>';
      }).join("") + "</tbody>"
      : "<tbody><tr><td class='muted'>Nobody added yet.</td></tr></tbody>";
    $("siteBase").textContent = location.origin;
    $("deployNote").textContent = config.wallet
      ? "Apple Wallet is set up on this deployment — the Add to Apple Wallet button works."
      : "Apple Wallet isn't set up yet. Add the four certificate secrets (README step 5) and the button turns on by itself.";
  }

  /* ---------------- cards ---------------- */
  var logoImg = new Image();
  logoImg.src = LOGO;

  function openCard(code) {
    var m = members.get(code);
    if (!m) return;
    ui.card = code;
    $("lanyard").innerHTML =
      '<div class="qr">' + qrSvg(m.code) + "</div>" +
      '<div class="side"><div class="nm">' + esc(m.name) + "</div>" +
      (m.crew ? '<div class="cr">' + esc(m.crew) + "</div>" : "") +
      '<div class="bc">' + barcodeSvg(m.code, 2, 34) + "</div>" +
      '<div class="cd">' + esc(m.code) + "</div>" +
      '<div class="ev">' + EVENT + " · " + DATES + "</div></div>";
    $("cardStatus").textContent = "";
    $("cardWallet").disabled = !config.wallet;
    $("walletNote").textContent = config.wallet
      ? "The pass opens straight into Apple Wallet on an iPhone."
      : "Apple Wallet needs the signing certificates added to the Worker first — see README step 5.";
    $("modal").hidden = false;
  }

  async function cardPng(code) {
    var m = members.get(code);
    if (!m) return;
    try { await document.fonts.load("600 64px Fredoka"); await document.fonts.load("500 30px Archivo"); } catch (e) {}
    var W = 1016, H = 638, c = document.createElement("canvas");
    c.width = W; c.height = H;
    var ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#2BA8A0"; ctx.fillRect(0, 0, W, 14);
    qrOnCanvas(ctx, m.code, 44, 150, 360);
    ctx.textBaseline = "top"; ctx.fillStyle = "#16333A";
    ctx.font = "600 60px Fredoka, Archivo, sans-serif";
    var name = m.name, maxW = W - 480;
    while (ctx.measureText(name).width > maxW && name.length > 4) name = name.slice(0, -2);
    if (name !== m.name) name = name.trim() + "…";
    ctx.fillText(name, 452, 132);
    ctx.font = "500 30px Archivo, sans-serif"; ctx.fillStyle = "#5F7A80";
    if (m.crew) ctx.fillText(m.crew, 452, 212);
    var bc = barcodeCanvas(m.code, 3, 104);
    if (bc) ctx.drawImage(bc, 452, 300, Math.min(bc.width, 500), 104);
    ctx.font = "600 27px ui-monospace, Menlo, monospace"; ctx.fillStyle = "#4A5F63";
    if ("letterSpacing" in ctx) ctx.letterSpacing = "6px";
    ctx.fillText(m.code, 452, 426);
    if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
    ctx.font = "700 24px Archivo, sans-serif"; ctx.fillStyle = "#1B7F79";
    ctx.fillText(EVENT + " · " + DATES, 452, 500);
    if (logoImg.complete && logoImg.naturalWidth) ctx.drawImage(logoImg, W - 190, H - 190, 150, 150);
    ctx.strokeStyle = "#DCE7E7"; ctx.lineWidth = 3; ctx.strokeRect(1.5, 1.5, W - 3, H - 3);
    c.toBlob(function (blob) {
      if (!blob) { $("cardStatus").textContent = "The image couldn't be built."; return; }
      var slug = m.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || m.code;
      download(slug + "-" + m.code + ".png", blob);
      $("cardStatus").textContent = "Saved to your downloads.";
    }, "image/png");
  }

  function sheetHtml() {
    var cards = sortedMembers().map(function (m) {
      return '<div class="c"><div class="nm">' + esc(m.name) + "</div>" +
        (m.crew ? '<div class="cr">' + esc(m.crew) + "</div>" : "") +
        '<div class="mid"><div class="qr">' + qrSvg(m.code) + "</div>" +
        '<div class="rt"><div class="bc">' + barcodeSvg(m.code, 2, 30) + '</div><div class="cd">' + esc(m.code) +
        '</div><div class="ev">' + EVENT + "</div></div></div></div>";
    }).join("");
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>' + EVENT + ' — lanyard cards</title><style>' +
      "@page{size:A4;margin:9mm}" +
      "body{margin:0;font-family:Arial,Helvetica,sans-serif;color:#16333A;background:#fff}" +
      ".grid{display:grid;grid-template-columns:repeat(2,88mm);gap:4mm;justify-content:center}" +
      ".c{width:88mm;height:54mm;border:1px dashed #bbb;border-radius:3mm;padding:4mm;display:flex;flex-direction:column;" +
      "box-sizing:border-box;page-break-inside:avoid;background-image:url(" + location.origin + "/logo.png);" +
      "background-repeat:no-repeat;background-position:right 3mm top 3mm;background-size:14mm 14mm}" +
      ".nm{font-size:15pt;font-weight:700;line-height:1.1;max-width:68mm}" +
      ".cr{font-size:8.5pt;color:#5F7A80;margin-top:1mm}" +
      ".mid{display:flex;gap:4mm;align-items:flex-end;margin-top:auto}" +
      ".qr{width:25mm;flex:0 0 25mm}.qr svg{width:100%;height:auto;display:block}" +
      ".rt{flex:1 1 auto;min-width:0}.bc svg{width:100%;height:11mm}" +
      ".cd{font-family:monospace;font-size:10.5pt;letter-spacing:.2em;margin-top:1mm;color:#4A5F63;font-weight:bold}" +
      ".ev{font-size:7.5pt;color:#1B7F79;font-weight:bold;margin-top:1mm}" +
      "@media print{.note{display:none}}" +
      '</style></head><body><p class="note" style="font-size:10pt;color:#555">' + members.size +
      " cards — print at 100% (turn off “fit to page”), then cut along the dashed lines.</p>" +
      '<div class="grid">' + cards + "</div></body></html>";
  }

  /* ---------------- gate ---------------- */
  function showGate(msg) {
    $("gate").hidden = false;
    $("gateStatus").textContent = msg || "";
    $("pin").focus();
  }
  $("gateForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    try { localStorage.setItem("tbm.pin", $("pin").value.trim()); } catch (err) {}
    $("gateStatus").textContent = "Checking…";
    try {
      await api("rev");
      $("gate").hidden = true;
      $("pin").value = "";
      refresh(true);
      $("scan").focus();
    } catch (err) { /* showGate already fired on 401 */ }
  });

  /* ---------------- wiring ---------------- */
  document.querySelectorAll(".tab").forEach(function (t) {
    t.addEventListener("click", function () {
      ui.view = t.dataset.view;
      document.querySelectorAll(".tab").forEach(function (x) { x.setAttribute("aria-selected", String(x === t)); });
      ["station", "board", "schedule", "members"].forEach(function (v) { $("view-" + v).hidden = v !== ui.view; });
      if (ui.view !== "station") stopCamera(); else $("scan").focus();
      renderAll();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
  $("modes").addEventListener("click", function (e) {
    var b = e.target.closest("[data-mode]");
    if (!b) return;
    ui.mode = b.dataset.mode;
    document.querySelectorAll("[data-mode]").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
    $("scan").focus();
  });
  $("showAll").addEventListener("change", function () { ui.showAll = this.checked; renderDests(); });
  $("dests").addEventListener("click", function (e) {
    var b = e.target.closest("[data-dest]");
    if (!b) return;
    ui.dest = b.dataset.dest === ui.dest ? null : b.dataset.dest;
    renderDests();
    $("scan").focus();
  });
  $("scan").addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    processScan($("scan").value);
    $("scan").value = "";
  });
  document.addEventListener("keydown", function (e) {
    if (ui.view !== "station" || !$("modal").hidden || !$("gate").hidden) return;
    var t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
    if (e.key.length === 1 && /[a-z0-9]/i.test(e.key)) $("scan").focus();
  });
  $("camBtn").addEventListener("click", toggleCamera);
  $("undoBtn").addEventListener("click", undoLast);
  $("findBtn").addEventListener("click", function () {
    var w = $("findWrap");
    w.hidden = !w.hidden;
    if (!w.hidden) $("findInput").focus();
  });
  $("findInput").addEventListener("input", function () {
    var q = this.value.trim().toLowerCase();
    var list = q ? sortedMembers().filter(function (m) {
      return (m.name + " " + (m.crew || "")).toLowerCase().indexOf(q) >= 0;
    }).slice(0, 12) : [];
    $("findResults").innerHTML = list.map(function (m) {
      return '<button class="person" type="button" data-pick="' + esc(m.code) + '"><b>' + esc(m.name) + "</b><small>" +
        esc(m.crew || m.code) + " · " + (m.state === "out" ? "away" : "on site") + "</small></button>";
    }).join("") || (q ? '<p class="muted">No match.</p>' : "");
  });
  $("findResults").addEventListener("click", function (e) {
    var b = e.target.closest("[data-pick]");
    if (!b) return;
    processScan(b.dataset.pick);
    $("findInput").value = "";
    $("findResults").innerHTML = "";
  });
  $("boardSearch").addEventListener("input", renderBoard);
  $("mSearch").addEventListener("input", renderMembers);
  $("dayPick").addEventListener("change", function () { ui.day = this.value; renderSchedule(); });

  $("actAdd").addEventListener("click", async function () {
    var name = $("actName").value.trim();
    if (!name) { $("actStatus").textContent = "Give the activity a name."; return; }
    try {
      await api("activities", {
        method: "POST",
        body: {
          name: name, loc: $("actLoc").value.trim(), date: $("actDate").value || todayISO(),
          start: $("actStart").value || "09:00", end: $("actEnd").value || "12:00", dest: $("actDest").checked
        }
      });
      $("actName").value = ""; $("actLoc").value = "";
      $("actStatus").textContent = "Added to the programme.";
      refresh(true);
    } catch (e) { $("actStatus").textContent = e.message || "That didn't save."; }
  });
  $("actTable").addEventListener("click", function (e) {
    var b = e.target.closest("[data-delact]");
    if (!b) return;
    var id = b.dataset.delact, out = 0;
    members.forEach(function (m) { if (m.state === "out" && m.act === id) out++; });
    arm(b, "act:" + id, out ? out + " still away — remove?" : "Remove?", async function () {
      if (ui.dest === id) ui.dest = null;
      await api("activities/" + id, { method: "DELETE" }).catch(function () {});
      refresh(true);
    });
  });

  async function addPeople(people, statusEl) {
    try {
      var res = await api("members", { method: "POST", body: { people: people } });
      statusEl.textContent = res.added.length === 1
        ? res.added[0].name + " added — code " + res.added[0].code + "."
        : res.added.length + " people added. Download the print sheet when the list is final.";
      refresh(true);
    } catch (e) { statusEl.textContent = e.message || "That didn't save."; }
  }
  $("mAdd").addEventListener("click", function () {
    var name = $("mName").value.trim();
    if (!name) { $("mStatus").textContent = "Enter a name first."; return; }
    addPeople([{ name: name, crew: $("mCrew").value }], $("mStatus"));
    $("mName").value = "";
    $("mName").focus();
  });
  $("mName").addEventListener("keydown", function (e) { if (e.key === "Enter") $("mAdd").click(); });
  $("mCrew").addEventListener("keydown", function (e) { if (e.key === "Enter") $("mAdd").click(); });
  $("mBulkAdd").addEventListener("click", function () {
    var people = $("mBulk").value.split("\n").map(function (l) { return l.trim(); }).filter(Boolean)
      .map(function (line) {
        var p = line.split(",");
        return { name: p[0], crew: p.slice(1).join(",") };
      });
    if (!people.length) { $("mStatus").textContent = "Paste some names first."; return; }
    $("mBulk").value = "";
    addPeople(people, $("mStatus"));
  });
  $("memTable").addEventListener("click", function (e) {
    var card = e.target.closest("[data-card]");
    if (card) return openCard(card.dataset.card);
    var del = e.target.closest("[data-delmem]");
    if (del) {
      var m = members.get(del.dataset.delmem);
      if (m) arm(del, "mem:" + m.code, "Remove?", async function () {
        await api("members/" + m.code, { method: "DELETE" }).catch(function () {});
        refresh(true);
      });
    }
  });

  $("cardClose").addEventListener("click", function () { $("modal").hidden = true; });
  $("modal").addEventListener("click", function (e) { if (e.target === $("modal")) $("modal").hidden = true; });
  $("cardPng").addEventListener("click", function () { if (ui.card) cardPng(ui.card); });
  $("cardWallet").addEventListener("click", function () {
    if (ui.card) window.location.href = "/api/pass/" + ui.card + ".pkpass";
  });
  $("cardLink").addEventListener("click", function () {
    if (!ui.card) return;
    var link = location.origin + "/p/" + ui.card;
    if (navigator.clipboard) navigator.clipboard.writeText(link);
    $("cardStatus").textContent = link;
  });
  $("sheetBtn").addEventListener("click", function () {
    if (!members.size) { $("sheetStatus").textContent = "Add some people first."; return; }
    download("teen-beach-moonta-lanyard-cards.html", sheetHtml(), "text/html;charset=utf-8");
    $("sheetStatus").textContent = "Saved — open it and print at 100%.";
  });

  /* ---------------- boot ---------------- */
  (async function start() {
    $("actDate").value = "2026-10-05";
    try { config = await (await fetch("/api/config")).json(); } catch (e) {}
    if (config.pinRequired && !pin()) showGate();
    await refresh(true);
    if (!$("gate").hidden) return;
    $("scan").focus();
  })();

  setInterval(function () { if (!document.hidden) refresh(false); }, 4000);
  setInterval(function () {
    renderTally();
    if (ui.view === "board") renderBoard();
    if (ui.view === "schedule") renderSchedule();
  }, 30000);
})();
