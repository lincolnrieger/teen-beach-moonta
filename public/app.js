/* Teen Beach Moonta — camp location board.
   Talks to the Worker API in src/index.js.

   One idea runs through the whole thing: everyone is somewhere. Either they're
   on site, or they're at one of the programme's activities, or they've gone
   home. A scan moves them to the place the desk has selected — there is no
   separate sign out / sign in to fall out of step. */
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

  /* A phone has no keyboard to type with, so nothing on the page may steal
     focus into a text field — that is what pops the on-screen keyboard open
     over the camera. On a laptop with a USB scanner, focus is exactly what we
     want, so the two cases are kept apart here and nowhere else. */
  var TOUCH = false;
  try {
    TOUCH = window.matchMedia("(pointer: coarse)").matches && !window.matchMedia("(pointer: fine)").matches;
  } catch (e) {}

  /* The two places that are always offered, whether or not anything is on the
     programme. Everything else in the list is a real activity. */
  var FIXED = [
    { id: "onsite", name: "On site", note: "Here at camp, not on an activity" },
    { id: "home", name: "Departing camp", note: "Signing off and leaving site" }
  ];

  var members = new Map();
  var activities = new Map();
  var movements = [];
  var config = { pinRequired: false };
  var rev = null;
  var ui = { view: "station", dest: null, recent: [], day: null, card: null, showAll: false, filter: "" };
  var lastScan = { code: null, place: null, at: 0 };
  var undoable = null;

  /* ---------------- api ---------------- */
  /* The desk holds a session token, not the PIN. It expires on its own, so a
     borrowed laptop stops working without anyone having to change the PIN. */
  function token() { try { return localStorage.getItem("tbm.session") || ""; } catch (e) { return ""; } }
  function setToken(t) {
    try { t ? localStorage.setItem("tbm.session", t) : localStorage.removeItem("tbm.session"); } catch (e) {}
  }
  async function api(path, options) {
    options = options || {};
    options.headers = Object.assign({ "x-session": token() }, options.headers || {});
    if (options.body && typeof options.body !== "string") {
      options.body = JSON.stringify(options.body);
      options.headers["content-type"] = "application/json";
    }
    var res = await fetch("/api/" + path, options);
    if (res.status === 401) { setToken(""); showGate("Your session has ended — enter the PIN again."); throw new Error("unauthorised"); }
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { code: data.error, status: res.status });
    return data;
  }

  async function refresh(force) {
    try {
      if (!force) {
        var r = await api("rev");
        if (r.rev === rev) { markOnline(true); return; }
      }
      var state = await api("state");
      rev = state.rev;
      members.clear();
      state.members.forEach(function (m) { members.set(m.code, m); });
      activities.clear();
      state.activities.forEach(function (a) { activities.set(a.id, a); });
      movements = state.movements || [];
      markOnline(true);
      renderAll();
    } catch (e) {
      /* Keep the last board on screen, but never let the desk believe a stale
         count is live. */
      if (e.message !== "unauthorised") markOnline(false);
    }
  }

  var online = true, offlineSince = 0;
  function markOnline(ok) {
    if (ok === online) { if (ok) return; } else { online = ok; offlineSince = ok ? 0 : Date.now(); }
    var el = $("offline");
    el.hidden = ok;
    if (!ok) var gap = Math.round((Date.now() - offlineSince) / 60000);
    el.textContent = "Can't reach the server. " + (gap < 1 ? "The board below was live a moment ago" : "The board below is " + since(offlineSince) + " out of date") + " — scans won't save until the connection is back.";
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
  function dayLabel(d) {
    var t = new Date(d + "T12:00:00");
    return isNaN(t.getTime()) ? d : t.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
  }

  function fixedPlace(id) {
    for (var i = 0; i < FIXED.length; i++) if (FIXED[i].id === id) return FIXED[i];
    return null;
  }
  function placeLabel(id) {
    var f = fixedPlace(id);
    if (f) return f.name;
    var a = activities.get(id);
    return a ? a.name : "on site";
  }
  /* 'onsite' | 'off' | 'home' — where someone counts as being. */
  function whereKind(id) {
    if (id === "home") return "home";
    var a = activities.get(id);
    if (a) return a.site === "off" ? "off" : "onsite";
    return "onsite";
  }
  function isOff(m) { return whereKind(m.place) === "off"; }
  function isHome(m) { return m.place === "home"; }

  function endStamp(a) {
    if (!a || !a.date || !a.end) return null;
    var t = new Date(a.date + "T" + a.end + ":00");
    return isNaN(t.getTime()) ? null : t.getTime();
  }
  function isLate(m) {
    if (!isOff(m)) return false;
    var e = endStamp(activities.get(m.place));
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

  /* On a phone the box stays read-only until it is tapped on purpose, so the
     keyboard only ever opens when someone asks for it. */
  function focusScan() { if (!TOUCH) $("scan").focus(); }
  function lockScan() {
    if (!TOUCH) return;
    var s = $("scan");
    s.setAttribute("readonly", "readonly");
    s.blur();
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
    /* Bounce protection: a scanner that fires twice is ignored, but moving the
       same person straight on to a different place is a real instruction. */
    if (code === lastScan.code && ui.dest === lastScan.place && now - lastScan.at < 2500) return;
    lastScan = { code: code, place: ui.dest, at: now };

    var local = members.get(code);
    if (!ui.dest) {
      beep(false);
      showResult("bad", local ? local.name : code, "Pick where they are first.", "");
      return;
    }
    try {
      var res = await api("scan", { method: "POST", body: { code: code, place: ui.dest } });
      var m = res.member;
      members.set(m.code, m);
      undoable = { code: m.code, prev: res.prev };
      $("undoBtn").disabled = false;
      beep(true);
      var kind = whereKind(m.place);
      var from = placeLabel(res.prev.place);
      showResult(kind === "onsite" ? "in" : kind === "home" ? "home" : "out",
        m.name,
        m.place === "onsite" ? "On site" : m.place === "home" ? "Departing camp" : "At " + placeLabel(m.place),
        clock(res.at) + " · from " + from + (res.prev.since ? " after " + since(res.prev.since) : ""));
      ui.recent.unshift({ name: m.name, where: placeLabel(m.place), kind: kind, t: res.at });
      ui.recent = ui.recent.slice(0, 8);
      renderRecent();
      refresh(true);
    } catch (err) {
      beep(false);
      if (err.code === "unknown-code") showResult("bad", "Code not recognised", "“" + code + "” isn't on the list.", "Add them under People & passes.");
      else if (err.code === "already-there") showResult("bad", local ? local.name : code, "Already at " + placeLabel(ui.dest) + ".", "Nothing changed.");
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
    lastScan = { code: null, place: null, at: 0 };
    refresh(true);
  }

  var cam = { stream: null, raf: 0, canvas: null };
  async function toggleCamera() {
    if (cam.stream) return stopCamera();
    $("camBtn").textContent = "Starting…";
    try { cam.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }); }
    catch (e) {
      $("camBtn").textContent = "Scan with the camera";
      $("scanHint").textContent = "The camera couldn't start. Check the browser's camera permission, or use a scanner.";
      return;
    }
    lockScan();
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
    $("camBtn").textContent = "Scan with the camera";
  }

  /* ---------------- render ---------------- */
  function renderAll() {
    renderTally(); renderDests(); renderRecent();
    renderBoard(); renderSchedule(); renderMembers();
  }
  function renderTally() {
    var all = Array.from(members.values());
    var off = all.filter(isOff), home = all.filter(isHome), late = off.filter(isLate);
    $("tally").innerHTML =
      "<div><b>" + (all.length - off.length - home.length) + "</b><small>on site</small></div>" +
      "<div><b>" + off.length + "</b><small>off site</small></div>" +
      (home.length ? "<div><b>" + home.length + "</b><small>departing</small></div>" : "") +
      (late.length ? '<div class="hot"><b>' + late.length + "</b><small>due back</small></div>" : "");
  }

  /* The desk list: the two fixed places on top, then the programme. Four days
     of programme is far too many buttons to read at a scanning desk, so what is
     happening now floats to the top, a filter box cuts the rest down, and
     everything else stays one checkbox away. With nothing on the programme at
     all, the two fixed places are the whole list. */
  function destButton(id, name, note, cls, count) {
    return '<button class="dest ' + cls + '" type="button" data-dest="' + esc(id) + '" aria-pressed="' +
      (ui.dest === id) + '"><b>' + esc(name) + "</b><small>" + esc(note) + "</small>" +
      (count ? '<i class="at">' + count + " there</i>" : "") + "</button>";
  }
  function renderDests() {
    $("fixedDests").innerHTML = FIXED.map(function (f) {
      var n = 0;
      members.forEach(function (m) { if (m.place === f.id) n++; });
      return destButton(f.id, f.name, f.note, f.id === "home" ? "home" : "here", n);
    }).join("");

    var counts = new Map();
    members.forEach(function (m) { counts.set(m.place, (counts.get(m.place) || 0) + 1); });

    var all = sortedActivities();
    var today = todayISO();
    var todays = all.filter(function (a) { return a.date === today; });
    /* Outside the camp dates there is no "today" to narrow to, so show the lot. */
    var pool = ui.showAll ? all : (todays.length ? todays : all);
    if (!ui.showAll) pool = pool.filter(function (a) { return a.dest !== false; });

    var q = (ui.filter || "").trim().toLowerCase();
    if (q) pool = pool.filter(function (a) {
      return (a.name + " " + (a.loc || "")).toLowerCase().indexOf(q) >= 0;
    });

    var nm = nowMins();
    function bucket(a) {
      if (a.date !== today) return 2;
      if (nm >= mins(a.start) && nm < mins(a.end)) return 0;
      if (mins(a.start) > nm && mins(a.start) - nm <= 120) return 1;
      return 2;
    }
    var groups = [
      { title: "On now", items: [] },
      { title: "Starting soon", items: [] },
      { title: todays.length && !ui.showAll ? "Rest of today" : "Everything else", items: [] }
    ];
    pool.forEach(function (a) { groups[bucket(a)].items.push(a); });

    $("actDests").innerHTML = groups.filter(function (g) { return g.items.length; }).map(function (g) {
      return '<h4 class="destgroup">' + esc(g.title) + "</h4><div class=\"dests\">" + g.items.map(function (a) {
        var when = (a.date === today ? "" : a.date.slice(8) + "/" + a.date.slice(5, 7) + " ") + a.start + "–" + a.end;
        var note = when + (a.loc ? " · " + a.loc : "") + (a.site === "off" ? " · off site" : "");
        return destButton(a.id, a.name, note, a.site === "off" ? "off" : "on", counts.get(a.id) || 0);
      }).join("") + "</div>";
    }).join("");

    $("actDestsEmpty").hidden = pool.length > 0;
    $("actDestsEmpty").textContent = q
      ? "Nothing on the programme matches “" + (ui.filter || "").trim() + "”."
      : "No activities on today. People are either on site or departing camp.";
    $("destFilterWrap").hidden = all.length < 8;
    $("showAllWrap").hidden = all.length === 0;
  }
  function renderRecent() {
    $("recent").innerHTML = ui.recent.length ? ui.recent.map(function (r) {
      return "<li><b>" + esc(r.name) + "</b> <span>" +
        (r.kind === "home" ? "departing camp" : r.kind === "off" ? "off site at " + esc(r.where) : "at " + esc(r.where)) +
        " · " + clock(r.t) + "</span></li>";
    }).join("") : '<li style="border:0;color:var(--dim)">Scans show up here.</li>';
  }
  function personHtml(m) {
    var late = isLate(m);
    return '<div class="person' + (late ? " late" : "") + '"><b>' + esc(m.name) + "</b><small>" +
      esc(m.crew || m.code) + " · " + since(m.since) + (late ? " · due back" : "") + "</small></div>";
  }
  function renderBoard() {
    var all = Array.from(members.values());
    var off = all.filter(isOff), home = all.filter(isHome), late = off.filter(isLate);
    $("boardStats").innerHTML =
      '<div class="stat"><b>' + (all.length - off.length - home.length) + "</b><small>on site right now</small></div>" +
      '<div class="stat pink"><b>' + off.length + "</b><small>off site right now</small></div>" +
      '<div class="stat' + (late.length ? " warn" : "") + '"><b>' + late.length + "</b><small>past their return time</small></div>" +
      '<div class="stat"><b>' + home.length + "</b><small>departing camp</small></div>";

    var q = ($("boardSearch").value || "").trim().toLowerCase();
    function match(m) { return !q || (m.name + " " + (m.crew || "") + " " + m.code).toLowerCase().indexOf(q) >= 0; }

    /* One group per place someone is actually at, activities first. */
    var groups = new Map();
    all.filter(match).forEach(function (m) {
      if (!groups.has(m.place)) groups.set(m.place, []);
      groups.get(m.place).push(m);
    });
    function groupHtml(place, people) {
      var a = activities.get(place);
      var kindNote = place === "home" ? "departing camp" : a ? (a.site === "off" ? "off site" : "on site") + " · " + a.start + "–" + a.end : "on site";
      return '<div class="group' + (a && a.site === "off" ? " away" : "") + '"><div class="group-head"><h3>' +
        esc(placeLabel(place)) + "</h3><em>" + people.length + " · " + esc(kindNote) + '</em></div><div class="people">' +
        people.sort(function (x, y) { return x.name.localeCompare(y.name); }).map(personHtml).join("") + "</div></div>";
    }
    var order = Array.from(groups.keys()).sort(function (a, b) {
      var rank = function (p) { return p === "onsite" ? 1 : p === "home" ? 2 : 0; };
      return rank(a) - rank(b) || placeLabel(a).localeCompare(placeLabel(b));
    });
    var html = order.map(function (p) { return groupHtml(p, groups.get(p)); }).join("");
    if (!groups.has("onsite")) {
      html += '<div class="group"><div class="group-head"><h3>On site</h3><em>0 · on site</em></div>' +
        '<p class="muted">Nobody is marked on site.</p></div>';
    }
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
      return '<option value="' + d + '"' + (d === ui.day ? " selected" : "") + ">" + esc(dayLabel(d)) + (d === todayISO() ? " — today" : "") + "</option>";
    }).join("");

    var isToday = ui.day === todayISO(), nm = nowMins();

    var counts = new Map();
    members.forEach(function (m) { counts.set(m.place, (counts.get(m.place) || 0) + 1); });

    var dayActs = acts.filter(function (a) { return a.date === ui.day; });
    $("agenda").innerHTML = dayActs.length ? dayActs.map(function (a) {
      var now = isToday && nm >= mins(a.start) && nm < mins(a.end);
      var done = isToday && nm >= mins(a.end);
      var n = counts.get(a.id) || 0;
      var cls = "slot " + (a.kind === "meal" ? "meal " : a.kind === "cater" ? "cater " : "") + (now ? "now " : done ? "done " : "");
      var sub = a.loc || (a.kind === "cater" ? "catering team" : "");
      return '<div class="' + cls.trim() + '"><div class="tm">' + esc(a.start) + "–" + esc(a.end) + "</div>" +
        '<div class="nm">' + esc(a.name) + '<small><span class="site ' + (a.site === "off" ? "off" : "on") + '">' +
        (a.site === "off" ? "off site" : "on site") + "</span>" + (sub ? " · " + esc(sub) : "") + "</small></div>" +
        '<div class="cnt">' + (n ? n + " there" : now ? "on now" : "") + "</div></div>";
    }).join("") : '<div class="empty">Nothing on the programme for this day yet.</div>';

    $("feed").innerHTML = movements.length ? movements.map(function (e) {
      var k = whereKind(e.place);
      return "<li><time>" + clock(e.t) + '</time><span class="pill ' + k + '">' +
        (k === "home" ? "home" : k === "off" ? "off" : "on") + "</span><span><b>" + esc(e.name || e.code) + "</b> " +
        (e.place === "home" ? "departed camp" : e.place === "onsite" ? "came back on site" : "moved to " + esc(placeLabel(e.place))) +
        "</span></li>";
    }).join("") : '<li style="border:0;color:var(--dim)">No movements recorded yet.</li>';

    $("actTable").innerHTML = acts.length
      ? "<thead><tr><th>Activity</th><th>When</th><th>Where</th><th>Site</th><th>At the desk</th><th>There</th><th></th></tr></thead><tbody>" +
      acts.map(function (a) {
        return "<tr><td><b>" + esc(a.name) + "</b></td><td>" + esc(a.date.slice(8) + "/" + a.date.slice(5, 7)) + " " +
          esc(a.start) + "–" + esc(a.end) + "</td><td>" + esc(a.loc || "—") + "</td><td>" +
          '<span class="site ' + (a.site === "off" ? "off" : "on") + '">' + (a.site === "off" ? "off site" : "on site") + "</span></td><td>" +
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
      ? "<thead><tr><th>Name</th><th>Crew</th><th>Code</th><th>Where</th><th></th></tr></thead><tbody>" +
      list.map(function (m) {
        var k = whereKind(m.place);
        return "<tr><td><b>" + esc(m.name) + "</b></td><td>" + esc(m.crew || "—") + '</td><td class="code">' + esc(m.code) +
          '</td><td><span class="tag ' + k + '">' + esc(placeLabel(m.place)) + "</span>" +
          '</td><td class="actions"><button class="btn small" data-card="' + esc(m.code) + '">Card</button> ' +
          '<button class="btn small danger" data-delmem="' + esc(m.code) + '">Remove</button></td></tr>';
      }).join("") + "</tbody>"
      : "<tbody><tr><td class='muted'>Nobody added yet.</td></tr></tbody>";
    $("siteBase").textContent = location.origin;
  }

  /* ---------------- cards ---------------- */
  /* A true preview of the printed card, laid out over the same artwork with the
     same panel measurements the print sheet uses. */
  function openCard(code) {
    var m = members.get(code);
    if (!m) return;
    ui.card = code;
    var pad = function (f) { return (f * 100).toFixed(2) + "%"; };
    $("lanyard").innerHTML =
      '<div class="cardface front">' +
        '<img class="art" src="/card-front.png" alt="">' +
        '<div class="inner" style="left:' + pad(PANEL.left + 0.035) + ';right:' + pad(1 - PANEL.right + 0.035) +
          ';top:' + pad(PANEL.top + 0.035) + ';bottom:' + pad(1 - PANEL_SAFE) + '">' +
          '<div class="nm">' + esc(m.name) + "</div>" +
          (m.crew ? '<div class="cr">' + esc(m.crew) + "</div>" : "") +
          '<div class="qr">' + qrSvg(m.code) + "</div>" +
          '<div class="bc">' + barcodeSvg(m.code, 2, 30) + "</div>" +
          '<div class="cd">' + esc(m.code) + "</div>" +
        "</div></div>" +
      '<div class="cardface"><img class="art" src="/card-back.png" alt="The Important Numbers page printed on the back"></div>';
    $("cardStatus").textContent = "";
    $("modal").hidden = false;
  }

  /* The same card as the print sheet, as one image — for sending to someone who
     has lost theirs, or for a phone screen at the desk. */
  async function cardPng(code) {
    var m = members.get(code);
    if (!m) return;
    $("cardStatus").textContent = "Building the image…";
    try {
      var src = await artwork("card-front.png");
      var art = await new Promise(function (resolve, reject) {
        var i = new Image();
        i.onload = function () { resolve(i); };
        i.onerror = function () { reject(new Error("The card artwork didn't load.")); };
        i.src = src;
      });
      try { await document.fonts.load("600 64px Fredoka"); await document.fonts.load("600 30px Archivo"); } catch (e) {}

      var W = art.naturalWidth, H = art.naturalHeight;
      var c = document.createElement("canvas");
      c.width = W; c.height = H;
      var ctx = c.getContext("2d");
      ctx.drawImage(art, 0, 0, W, H);

      var left = (PANEL.left + 0.035) * W, right = (PANEL.right - 0.035) * W;
      var mid = (left + right) / 2, avail = right - left;
      var y = (PANEL.top + 0.045) * H;

      ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillStyle = "#16333A";
      var nameSize = W * 0.082;
      ctx.font = "600 " + nameSize + "px Fredoka, Archivo, sans-serif";
      var name = m.name;
      while (ctx.measureText(name).width > avail && nameSize > W * 0.05) {
        nameSize -= 2;
        ctx.font = "600 " + nameSize + "px Fredoka, Archivo, sans-serif";
      }
      ctx.fillText(name, mid, y);
      y += nameSize * 1.2;

      if (m.crew) {
        ctx.font = "600 " + (W * 0.040) + "px Archivo, sans-serif";
        ctx.fillStyle = "#5F7A80";
        ctx.fillText(m.crew, mid, y);
        y += W * 0.040 * 1.5;
      }

      var qrSize = W * 0.44;
      qrOnCanvas(ctx, m.code, mid - qrSize / 2, y + W * 0.02, qrSize);
      y += qrSize + W * 0.05;

      var bc = barcodeCanvas(m.code, 3, 120);
      if (bc) {
        var bw = W * 0.74, bh = W * 0.145;
        ctx.drawImage(bc, mid - bw / 2, y, bw, bh);
        y += bh + W * 0.025;
      }

      ctx.font = "700 " + (W * 0.062) + "px ui-monospace, Menlo, monospace";
      ctx.fillStyle = "#16333A";
      if ("letterSpacing" in ctx) ctx.letterSpacing = (W * 0.016) + "px";
      ctx.fillText(m.code, mid, y);
      if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";

      await new Promise(function (resolve) {
        c.toBlob(function (blob) {
          if (!blob) { $("cardStatus").textContent = "The image couldn't be built."; return resolve(); }
          var slug = m.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || m.code;
          download(slug + "-" + m.code + ".png", blob);
          $("cardStatus").textContent = "Saved to your downloads.";
          resolve();
        }, "image/png");
      });
    } catch (e) {
      $("cardStatus").textContent = e.message || "The image couldn't be built.";
    }
  }

  /* ---------------- print sheet ---------------- */
  /* Cards print onto the camp artwork: the front is the blank frame with the
     name and the two codes dropped into its white panel, the back is the
     Important Numbers page. Both sizes tile an A4 sheet exactly, and because
     every back is identical the sheet needs no mirroring — print it double
     sided, flip on either edge, and every card lands on its own back. */
  var SIZES = {
    lanyard: { w: 70, h: 98.7, cols: 3, rows: 3, label: "lanyard card, 70 × 99 mm, 9 a sheet" },
    badge:   { w: 105, h: 148, cols: 2, rows: 2, label: "A6 badge, 105 × 148 mm, 4 a sheet" }
  };
  /* The white panel measured off the artwork, as fractions of the whole card.
     Below PANEL_SAFE the camp logo sits over the panel, so nothing goes there. */
  var PANEL = { left: 0.100, right: 0.899, top: 0.071, bottom: 0.929 };
  var PANEL_SAFE = 0.74;

  var artCache = {};
  async function artwork(name) {
    if (artCache[name]) return artCache[name];
    var res = await fetch("/" + name);
    if (!res.ok) throw new Error("Couldn't load " + name);
    var blob = await res.blob();
    artCache[name] = await new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
    return artCache[name];
  }

  async function sheetHtml(sizeKey) {
    var S = SIZES[sizeKey] || SIZES.lanyard;
    /* Inlined so the sheet still prints correctly from a laptop with no signal. */
    var front = await artwork("card-front.png");
    var back = await artwork("card-back.png");

    var per = S.cols * S.rows;
    var people = sortedMembers();
    var pages = [];
    for (var i = 0; i < people.length; i += per) pages.push(people.slice(i, i + per));

    /* Sizes are set in mm off the card width so both options read the same. */
    var u = function (f) { return (S.w * f).toFixed(2) + "mm"; };
    var inner = "left:" + ((PANEL.left + 0.035) * 100).toFixed(2) + "%;" +
                "right:" + ((1 - PANEL.right + 0.035) * 100).toFixed(2) + "%;" +
                "top:" + ((PANEL.top + 0.035) * 100).toFixed(2) + "%;" +
                "bottom:" + ((1 - PANEL_SAFE) * 100).toFixed(2) + "%;";

    function cardFront(m) {
      return '<div class=card><img class=art src="' + front + '" alt="">' +
        '<div class=inner><div class=nm>' + esc(m.name) + "</div>" +
        (m.crew ? '<div class=cr>' + esc(m.crew) + "</div>" : "") +
        '<div class=qr>' + qrSvg(m.code) + "</div>" +
        '<div class=bc>' + barcodeSvg(m.code, 2, 30) + "</div>" +
        '<div class=cd>' + esc(m.code) + "</div></div></div>";
    }
    var backCard = '<div class=card><img class=art src="' + back + '" alt=""></div>';

    var body = pages.map(function (page) {
      return '<div class=page>' + page.map(cardFront).join("") + "</div>" +
             '<div class=page>' + new Array(page.length + 1).join(backCard) + "</div>";
    }).join("");

    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>' + esc(EVENT) +
      ' — cards</title><style>' +
      "@page{size:A4;margin:0}" +
      "*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}" +
      "body{margin:0;background:#fff;font-family:'Fredoka','Archivo',Arial,Helvetica,sans-serif;color:#16333A}" +
      ".note{padding:8mm;font-size:11pt;line-height:1.5;font-family:Arial,Helvetica,sans-serif}" +
      ".note b{font-size:13pt}" +
      ".page{width:210mm;height:297mm;display:grid;grid-template-columns:repeat(" + S.cols + "," + S.w + "mm);" +
        "grid-auto-rows:" + S.h + "mm;page-break-after:always;break-after:page;align-content:start}" +
      ".card{position:relative;width:" + S.w + "mm;height:" + S.h + "mm;overflow:hidden;break-inside:avoid}" +
      ".art{position:absolute;inset:0;width:100%;height:100%;display:block}" +
      ".inner{position:absolute;" + inner + "display:flex;flex-direction:column;align-items:center;" +
        "justify-content:flex-start;text-align:center;gap:" + u(0.018) + "}" +
      ".nm{font-weight:600;font-size:" + u(0.082) + ";line-height:1.1;width:100%;overflow-wrap:anywhere}" +
      ".cr{font-family:Archivo,Arial,sans-serif;font-weight:600;font-size:" + u(0.040) + ";color:#5F7A80;line-height:1.2}" +
      ".qr{width:" + u(0.44) + ";margin-top:" + u(0.02) + "}.qr svg{width:100%;height:auto;display:block}" +
      ".bc{width:" + u(0.74) + ";margin-top:" + u(0.015) + "}.bc svg{width:100%;height:" + u(0.145) + ";display:block}" +
      ".cd{font-family:ui-monospace,'Courier New',monospace;font-weight:700;font-size:" + u(0.062) + ";" +
        "letter-spacing:" + u(0.016) + ";color:#16333A;line-height:1.1}" +
      "@media print{.note{display:none}}" +
      '</style></head><body><div class="note"><b>' + people.length + " cards — " + esc(S.label) + ".</b><br>" +
      "Print at 100% with <i>Fit to page</i> and <i>Margins</i> off, double sided, and turn on <i>Background graphics</i> " +
      "if your printer dialog offers it. Every card's back is the same Important Numbers page, so it doesn't matter " +
      "which edge it flips on. Then cut along the grid.</div>" + body + "</body></html>";
  }

  /* ---------------- gate ---------------- */
  function showGate(msg) {
    $("gate").hidden = false;
    $("gateStatus").textContent = msg || "";
    if (!TOUCH) $("pin").focus();
  }
  $("gateForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    var entered = $("pin").value.trim();
    if (!entered) { $("gateStatus").textContent = "Enter the PIN."; return; }
    $("gateStatus").textContent = "Checking…";
    $("gateBtn").disabled = true;
    try {
      var res = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin: entered })
      });
      var data = await res.json().catch(function () { return {}; });
      if (res.status === 429) {
        $("gateStatus").textContent = "Too many wrong tries. Wait " + Math.ceil((data.wait || 60) / 60) + " min and try again.";
        return;
      }
      if (!res.ok || !data.token) { $("gateStatus").textContent = "That PIN didn't work."; return; }
      setToken(data.token);
      $("gate").hidden = true;
      $("pin").value = "";
      $("gateStatus").textContent = "";
      await refresh(true);
      focusScan();
    } catch (err) {
      $("gateStatus").textContent = "Couldn't reach the server. Check the connection.";
    } finally {
      $("gateBtn").disabled = false;
    }
  });
  $("signOut").addEventListener("click", function () {
    arm(this, "signout", "Sign out of this device?", function () {
      setToken("");
      location.reload();
    });
  });

  /* ---------------- wiring ---------------- */
  document.querySelectorAll(".tab").forEach(function (t) {
    t.addEventListener("click", function () {
      ui.view = t.dataset.view;
      document.querySelectorAll(".tab").forEach(function (x) { x.setAttribute("aria-selected", String(x === t)); });
      ["station", "board", "schedule", "members"].forEach(function (v) { $("view-" + v).hidden = v !== ui.view; });
      if (ui.view !== "station") stopCamera(); else focusScan();
      renderAll();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
  $("showAll").addEventListener("change", function () { ui.showAll = this.checked; renderDests(); });
  $("destFilter").addEventListener("input", function () { ui.filter = this.value; renderDests(); });
  $("destFilter").addEventListener("keydown", function (e) {
    if (e.key === "Escape") { this.value = ""; ui.filter = ""; renderDests(); }
  });
  function pickDest(e) {
    var b = e.target.closest("[data-dest]");
    if (!b) return;
    ui.dest = b.dataset.dest === ui.dest ? null : b.dataset.dest;
    renderDests();
    focusScan();
  }
  $("fixedDests").addEventListener("click", pickDest);
  $("actDests").addEventListener("click", pickDest);

  $("scan").addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    processScan($("scan").value);
    $("scan").value = "";
    lockScan();
  });
  /* Tapping the box is the one way the keyboard opens on a phone. */
  $("scan").addEventListener("click", function () {
    if (this.hasAttribute("readonly")) { this.removeAttribute("readonly"); this.focus(); }
  });
  document.addEventListener("keydown", function (e) {
    if (TOUCH || ui.view !== "station" || !$("modal").hidden || !$("gate").hidden) return;
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
        esc(m.crew || m.code) + " · " + esc(placeLabel(m.place)) + "</small></button>";
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
          start: $("actStart").value || "09:00", end: $("actEnd").value || "12:00",
          site: $("actSite").value, dest: $("actDest").checked
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
    var id = b.dataset.delact, there = 0;
    members.forEach(function (m) { if (m.place === id) there++; });
    arm(b, "act:" + id, there ? there + " still there — remove?" : "Remove?", async function () {
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
  $("cardLink").addEventListener("click", function () {
    if (!ui.card) return;
    var link = location.origin + "/p/" + ui.card;
    if (navigator.clipboard) navigator.clipboard.writeText(link);
    $("cardStatus").textContent = link;
  });
  $("sheetBtn").addEventListener("click", async function () {
    if (!members.size) { $("sheetStatus").textContent = "Add some people first."; return; }
    var size = $("sheetSize").value;
    this.disabled = true;
    $("sheetStatus").textContent = "Building the sheet…";
    try {
      download("teen-beach-moonta-cards-" + size + ".html", await sheetHtml(size), "text/html;charset=utf-8");
      $("sheetStatus").textContent = "Saved — open it and print double sided at 100%.";
    } catch (e) {
      $("sheetStatus").textContent = e.message || "The sheet couldn't be built.";
    } finally {
      this.disabled = false;
    }
  });

  /* ---------------- boot ---------------- */
  (async function start() {
    $("actDate").value = "2026-10-03";
    if (TOUCH) {
      document.body.classList.add("touch");
      $("scan").setAttribute("readonly", "readonly");
      $("scan").placeholder = "Tap to type a code";
      $("scanHint").textContent = "Scan with the camera, or tap the box above to type a code by hand.";
    }
    try { config = await (await fetch("/api/config")).json(); } catch (e) {}
    $("signOut").hidden = !config.pinRequired;
    if (config.unprotected) {
      $("banner").hidden = false;
      $("banner").className = "banner bad";
      $("banner").innerHTML = "<b>This board has no staff PIN.</b> Anyone with the link can see the roster and move people. " +
        "Set one with <code>npx wrangler secret put STAFF_PIN</code>, then redeploy.";
    }
    if (config.pinRequired && !token()) { showGate(); return; }
    await refresh(true);
    if (!$("gate").hidden) return;
    focusScan();
  })();

  /* Nothing polls while the PIN screen is up, or while the tab is in the
     background — there is no token to poll with and nobody watching. */
  function awake() { return !document.hidden && $("gate").hidden; }
  setInterval(function () { if (awake()) refresh(false); }, 4000);
  setInterval(function () {
    if (!awake()) return;
    renderTally();
    if (ui.view === "station") renderDests();   /* "on now" moves with the clock */
    if (ui.view === "board") renderBoard();
    if (ui.view === "schedule") renderSchedule();
  }, 30000);
})();
