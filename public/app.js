/* Teen Beach Moonta — camp location board.
   Talks to the Worker API in src/index.js.

   One idea runs through the whole thing: everyone is somewhere. Either they're
   on site, or they're at one of the programme's activities, or they've
   signed out of camp. A scan moves them to the place the board has selected — there is no
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

  /* The three places that are always offered, whether or not anything is on the
     programme. Everything else is a real activity. `name` is the button,
     `label` is how someone who is there reads on the board. 'offsite' is a
     temporary sign out — away from camp for a bit, not on a programme
     activity, and coming back. The id stays 'home' for signing out so
     databases from before the rename keep working. */
  var FIXED = [
    { id: "onsite", name: "On site", label: "On site", note: "Here at camp" },
    { id: "offsite", name: "Off site", label: "Off site", note: "Out for a bit, coming back" },
    { id: "home", name: "Signing out", label: "Signed out", note: "Leaving camp" }
  ];

  var members = new Map();
  var activities = new Map();
  var movements = [];
  var config = { pinRequired: false, contacts: [] };
  var rev = null;
  var ui = { view: "station", dest: null, pickDay: null, showPast: false, recent: [], day: null, card: null, act: null, mem: null };
  var lastScan = { code: null, place: null, at: 0 };
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
      if (ui.dest && !fixedPlace(ui.dest) && !activities.has(ui.dest)) ui.dest = null;
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
  function dayLabel(d, style) {
    var t = new Date(d + "T12:00:00");
    if (isNaN(t.getTime())) return d;
    return style === "short"
      ? t.toLocaleDateString(undefined, { weekday: "short", day: "numeric" })
      : t.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
  }

  function fixedPlace(id) {
    for (var i = 0; i < FIXED.length; i++) if (FIXED[i].id === id) return FIXED[i];
    return null;
  }
  function placeLabel(id) {
    var f = fixedPlace(id);
    if (f) return f.label;
    var a = activities.get(id);
    return a ? a.name : "On site";
  }
  /* 'onsite' | 'off' | 'home' — where someone counts as being. */
  function whereKind(id) {
    if (id === "home") return "home";
    if (id === "offsite") return "off";
    var a = activities.get(id);
    if (a) return a.site === "off" ? "off" : "onsite";
    return "onsite";
  }
  function isOff(m) { return whereKind(m.place) === "off"; }
  function isHome(m) { return m.place === "home"; }

  function stamp(date, hhmm) {
    if (!date || !hhmm) return null;
    var t = new Date(date + "T" + hhmm + ":00");
    return isNaN(t.getTime()) ? null : t.getTime();
  }
  function endStamp(a) { return a ? stamp(a.date, a.end) : null; }
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
  function whenLabel(a) {
    var day = a.date === todayISO() ? "Today" : dayLabel(a.date, "short");
    return day + " " + a.start + "–" + a.end;
  }
  function countAt(id) {
    var n = 0;
    members.forEach(function (m) { if (m.place === id) n++; });
    return n;
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

  /* Destructive buttons ask twice: the first tap relabels the button, the
     second within a few seconds does it. */
  var armedMap = new Map();
  function arm(btn, key, label, fn) {
    var p = armedMap.get(key);
    if (p) { clearTimeout(p.t); armedMap.delete(key); btn.textContent = p.original; fn(); return; }
    var original = btn.textContent;
    btn.textContent = label;
    armedMap.set(key, { original: original, t: setTimeout(function () { armedMap.delete(key); btn.textContent = original; }, 4500) });
  }
  function showResult(kind, who, what, when) {
    var el = $("result");
    el.className = "result " + (kind || "");
    $("resWho").textContent = who;
    $("resWhat").textContent = what;
    $("resWhen").textContent = when || "";
    el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
  }
  function setUndo(u) {
    undoable = u;
    $("undoBtn").hidden = !u;
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
      showResult("bad", local ? local.name : code, "Pick where they're going first.", "");
      return;
    }
    try {
      var res = await api("scan", { method: "POST", body: { code: code, place: ui.dest } });
      var m = res.member;
      members.set(m.code, m);
      beep(true);
      var kind = whereKind(m.place);
      showResult(kind === "onsite" ? "in" : kind === "home" ? "home" : "out",
        m.name,
        fixedPlace(m.place) ? placeLabel(m.place) : "At " + placeLabel(m.place),
        clock(res.at) + " · was " + placeLabel(res.prev.place) + (res.prev.since ? " for " + since(res.prev.since) : ""));
      setUndo({ code: m.code, prev: res.prev });
      ui.recent.unshift({ name: m.name, where: placeLabel(m.place), kind: kind, t: res.at });
      ui.recent = ui.recent.slice(0, 8);
      renderRecent();
      refresh(true);
    } catch (err) {
      beep(false);
      if (err.code === "unknown-code") showResult("bad", "Not recognised", "Nobody has the code “" + code + "”.", "Add them under People.");
      else if (err.code === "already-there") showResult("bad", local ? local.name : code, "Already at " + placeLabel(ui.dest) + ".", "Nothing changed.");
      else showResult("bad", "That didn't save", err.message || "Check the connection and try again.", "");
    }
  }

  /* The one box takes a scanner, a typed code or a typed name. */
  function nameMatches(q) {
    q = q.trim().toLowerCase();
    if (q.length < 2) return [];
    return sortedMembers().filter(function (m) {
      return (m.name + " " + (m.crew || "")).toLowerCase().indexOf(q) >= 0;
    });
  }
  function renderFind(list) {
    $("findResults").innerHTML = list.slice(0, 8).map(function (m) {
      return '<button class="person" type="button" data-pick="' + esc(m.code) + '"><b>' + esc(m.name) + "</b><small>" +
        esc(m.crew || m.code) + " · " + esc(placeLabel(m.place)) + "</small></button>";
    }).join("");
  }
  function handleEntry(raw) {
    var code = String(raw || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!code) return;
    renderFind([]);
    if (members.has(code)) return processScan(code);
    var list = nameMatches(raw);
    if (list.length === 1) return processScan(list[0].code);
    if (list.length > 1) {
      renderFind(list);
      showResult("", list.length + " people match", "Tap the right one below.", "");
      return;
    }
    processScan(code);
  }

  async function undoLast() {
    if (!undoable) return;
    try {
      await api("undo", { method: "POST", body: undoable });
      showResult("", "Undone", "The last scan has been rolled back.", "");
      ui.recent.shift(); renderRecent();
    } catch (e) { showResult("bad", "Couldn't undo", e.message || "", ""); }
    setUndo(null);
    lastScan = { code: null, place: null, at: 0 };
    refresh(true);
  }

  var cam = { stream: null, raf: 0, canvas: null };
  async function toggleCamera() {
    if (cam.stream) return stopCamera();
    $("camBtn").textContent = "Starting…";
    try { cam.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }); }
    catch (e) {
      $("camBtn").textContent = "Camera";
      $("scanHint").textContent = "The camera couldn't start. Check the browser's camera permission.";
      return;
    }
    lockScan();
    var v = $("video");
    v.srcObject = cam.stream;
    await v.play().catch(function () {});
    $("camWrap").hidden = false;
    $("camBtn").textContent = "Stop";
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
    $("camBtn").textContent = "Camera";
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
      (home.length ? "<div><b>" + home.length + "</b><small>signed out</small></div>" : "") +
      (late.length ? '<div class="hot"><b>' + late.length + "</b><small>due back</small></div>" : "");
  }

  /* The scan screen: the three fixed places as big buttons, then one day of the
     programme at a time as a list to tap. What's picked is repeated right
     above the scan box, so nobody has to scroll back up to check. */
  function destButton(id, name, note, cls) {
    return '<button class="dest ' + cls + '" type="button" data-dest="' + esc(id) + '" aria-pressed="' +
      (ui.dest === id) + '"><b>' + esc(name) + "</b><small>" + esc(note) + "</small></button>";
  }
  function destOption(a, now) {
    var s = stamp(a.date, a.start) || 0, e = endStamp(a) || 0;
    var running = s <= now && now < e, done = now >= e;
    var n = countAt(a.id);
    var note = (running ? "On now · till " : "till ") + a.end + (a.site === "off" ? " · off site" : "") + (n ? " · " + n + " there" : "");
    return '<button type="button" class="dopt' + (a.site === "off" ? " off" : "") + (running ? " live" : done ? " past" : "") +
      '" data-dest="' + esc(a.id) + '" aria-pressed="' + (ui.dest === a.id) + '"><span class="t">' + esc(a.start) +
      "</span><b>" + esc(a.name) + "</b><small>" + esc(note) + "</small></button>";
  }
  function renderDests() {
    var now = Date.now(), today = todayISO();
    $("destFixed").innerHTML = FIXED.map(function (f) {
      return destButton(f.id, f.name, f.note, f.id === "home" ? "home" : f.id === "offsite" ? "off" : "here");
    }).join("");

    var acts = sortedActivities().filter(function (a) { return a.dest || a.id === ui.dest; });
    var days = [];
    acts.forEach(function (a) { if (days.indexOf(a.date) < 0) days.push(a.date); });
    if (!ui.pickDay || days.indexOf(ui.pickDay) < 0) {
      ui.showPast = false;
      ui.pickDay = days.indexOf(today) >= 0 ? today
        : days.filter(function (d) { return acts.some(function (a) { return a.date === d && (endStamp(a) || 0) > now; }); })[0]
          || days[days.length - 1] || null;
    }
    $("destDays").innerHTML = days.length > 1 ? days.map(function (d) {
      return '<button class="day" type="button" data-pday="' + d + '" aria-pressed="' + (d === ui.pickDay) + '">' +
        esc(d === today ? "Today" : dayLabel(d, "short")) + "</button>";
    }).join("") : "";

    /* Finished activities fold away so what's on now is at the top. */
    var list = acts.filter(function (a) { return a.date === ui.pickDay; });
    var past = list.filter(function (a) { return (endStamp(a) || 0) <= now && a.id !== ui.dest; });
    var shown = ui.showPast ? list : list.filter(function (a) { return past.indexOf(a) < 0; });
    var html = past.length ? '<button class="linkbtn" type="button" data-past>' +
      (ui.showPast ? "Hide the " + past.length + " finished" : "Show " + past.length + " finished earlier") + "</button>" : "";
    html += shown.map(function (a) { return destOption(a, now); }).join("");
    $("destList").innerHTML = html || '<div class="empty" style="grid-column:1/-1">' +
      (acts.length ? "Nothing left on this day." : "Nothing on the programme yet.") + "</div>";
    renderGoing();
  }
  function renderGoing() {
    var el = $("going"), id = ui.dest;
    if (!id) {
      el.className = "going none";
      el.innerHTML = '<div class="gtxt"><b>Pick where they\'re going</b><span class="gnote">Scans won\'t move anyone until you do.</span></div>' +
        '<button class="btn small" type="button" data-change>Pick</button>';
      return;
    }
    var f = fixedPlace(id), a = activities.get(id), now = Date.now();
    var note;
    if (f) note = f.note;
    else {
      var running = (stamp(a.date, a.start) || 0) <= now && now < (endStamp(a) || 0);
      note = (running ? "On now · until " + a.end : whenLabel(a)) + " · " + (a.site === "off" ? "off site" : "on site") + (a.loc ? " · " + a.loc : "");
    }
    el.className = "going " + (id === "home" ? "home" : whereKind(id) === "off" ? "off" : "here");
    el.innerHTML = '<div class="gtxt"><small>' + (id === "home" ? "Each scan signs them out" : id === "offsite" ? "Each scan signs them out for a bit" : "Each scan moves them to") + "</small><b>" +
      esc(f ? f.name : a.name) + '</b><span class="gnote">' + esc(note) + "</span></div>" +
      '<button class="btn small" type="button" data-change>Change</button>';
  }
  function renderRecent() {
    $("recent").innerHTML = ui.recent.length ? ui.recent.map(function (r) {
      return "<li><b>" + esc(r.name) + "</b> <span>" +
        (r.kind === "home" ? "signed out" : esc(r.where)) + " · " + clock(r.t) + "</span></li>";
    }).join("") : '<li style="color:var(--dim)">Scans show up here.</li>';
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
      '<div class="stat"><b>' + (all.length - off.length - home.length) + "</b><small>on site</small></div>" +
      '<div class="stat pink"><b>' + off.length + "</b><small>off site</small></div>" +
      '<div class="stat' + (late.length ? " warn" : "") + '"><b>' + late.length + "</b><small>past return time</small></div>" +
      '<div class="stat"><b>' + home.length + "</b><small>signed out</small></div>";

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
      var kindNote = place === "home" ? "left camp" : place === "offsite" ? "out for a bit" : a ? (a.site === "off" ? "off site" : "on site") + " · until " + a.end : "on site";
      return '<div class="group' + (whereKind(place) === "off" ? " away" : "") + '"><div class="group-head"><h3>' +
        esc(placeLabel(place)) + "</h3><em>" + people.length + " · " + esc(kindNote) + '</em></div><div class="people">' +
        people.sort(function (x, y) { return x.name.localeCompare(y.name); }).map(personHtml).join("") + "</div></div>";
    }
    var order = Array.from(groups.keys()).sort(function (a, b) {
      var rank = function (p) { return p === "onsite" ? 1 : p === "offsite" ? 2 : p === "home" ? 3 : 0; };
      return rank(a) - rank(b) || placeLabel(a).localeCompare(placeLabel(b));
    });
    var html = order.map(function (p) { return groupHtml(p, groups.get(p)); }).join("");
    $("boardGroups").innerHTML = !all.length
      ? '<div class="empty">Nobody on the list yet. Add people under <b>People</b>.</div>'
      : html || '<div class="empty">No match.</div>';

    $("feed").innerHTML = movements.length ? movements.map(function (e) {
      var k = whereKind(e.place);
      return "<li><time>" + clock(e.t) + '</time><span class="pill ' + k + '">' +
        (k === "home" ? "out" : k === "off" ? "off" : "on") + "</span><span><b>" + esc(e.name || e.code) + "</b> " +
        (e.place === "home" ? "signed out" : e.place === "offsite" ? "went off site for a bit" : e.place === "onsite" ? "came back on site" : "moved to " + esc(placeLabel(e.place))) +
        "</span></li>";
    }).join("") : '<li style="border:0;color:var(--dim)">No movements recorded yet.</li>';
  }

  function renderSchedule() {
    var acts = sortedActivities();
    var days = Array.from(new Set(acts.map(function (a) { return a.date; })));
    var today = todayISO();
    if (!days.length) days = [today];
    if (!ui.day || days.indexOf(ui.day) < 0) ui.day = days.indexOf(today) >= 0 ? today : days[0];
    $("days").innerHTML = days.map(function (d) {
      return '<button class="day" type="button" data-day="' + d + '" aria-pressed="' + (d === ui.day) + '">' +
        esc(d === today ? "Today" : dayLabel(d, "short")) + "</button>";
    }).join("");

    var now = Date.now();
    var dayActs = acts.filter(function (a) { return a.date === ui.day; });
    $("agenda").innerHTML = dayActs.length ? dayActs.map(function (a) {
      var s = stamp(a.date, a.start) || 0, e = endStamp(a) || 0;
      var running = s <= now && now < e, done = now >= e;
      var n = countAt(a.id);
      var cls = "slot" + (a.kind === "meal" ? " meal" : "") + (a.dest ? "" : " hid") + (running ? " now" : done ? " done" : "");
      return '<button type="button" class="' + cls + '" data-act="' + esc(a.id) + '"><span class="tm">' + esc(a.start) + "–" + esc(a.end) + "</span>" +
        '<span class="nm">' + esc(a.name) + '<small><span class="site ' + (a.site === "off" ? "off" : "on") + '">' +
        (a.site === "off" ? "off site" : "on site") + "</span>" + (a.loc ? " · " + esc(a.loc) : "") + "</small></span>" +
        '<span class="end"><span class="cnt">' + (n ? n + " there" : running ? "on now" : "") + '</span><span class="ed">Edit</span></span></button>';
    }).join("") : '<div class="empty">Nothing on the programme for this day yet.</div>';
  }

  function renderMembers() {
    var q = ($("mSearch").value || "").trim().toLowerCase();
    var list = sortedMembers().filter(function (m) {
      return !q || (m.name + " " + (m.crew || "") + " " + m.code).toLowerCase().indexOf(q) >= 0;
    });
    $("mCount").textContent = members.size ? "(" + members.size + ")" : "";
    $("memList").innerHTML = list.length ? list.map(function (m) {
      var k = whereKind(m.place);
      return '<div class="prow"><div class="who"><b>' + esc(m.name) + "</b><small>" + esc(m.crew || "No crew") + "</small></div>" +
        '<span class="tag ' + k + '">' + esc(placeLabel(m.place)) + "</span>" +
        '<span class="code">' + esc(m.code) + "</span>" +
        '<div class="acts"><button class="btn small" data-card="' + esc(m.code) + '">Card</button>' +
        '<button class="btn small" data-editmem="' + esc(m.code) + '">Edit</button></div></div>';
    }).join("") : '<div class="empty">' + (members.size ? "No match." : "Nobody added yet.") + "</div>";
  }

  /* ---------------- modals ---------------- */
  function openModal(id) { $(id).hidden = false; }
  function closeModals() {
    document.querySelectorAll(".modal").forEach(function (m) { m.hidden = true; });
    ui.card = ui.act = ui.mem = null;
  }
  document.querySelectorAll(".modal").forEach(function (m) {
    m.addEventListener("click", function (e) {
      if (e.target === m || e.target.closest("[data-close]")) closeModals();
    });
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeModals(); });

  function openAct(id) {
    var a = id ? activities.get(id) : null;
    ui.act = a ? a.id : null;
    $("actTitle").textContent = a ? "Edit activity" : "Add activity";
    $("actName").value = a ? a.name : "";
    $("actLoc").value = a ? a.loc || "" : "";
    $("actDate").value = a ? a.date : (ui.day || todayISO());
    $("actStart").value = a ? a.start : "09:00";
    $("actEnd").value = a ? a.end : "10:00";
    $("actSite").value = a && a.site === "off" ? "off" : "on";
    $("actDest").checked = a ? !!a.dest : true;
    $("actDel").hidden = !a;
    $("actDel").textContent = "Delete";
    $("actStatus").textContent = "";
    openModal("actModal");
    if (!TOUCH) $("actName").focus();
  }

  function openMem(code) {
    var m = members.get(code);
    if (!m) return;
    ui.mem = code;
    $("eName").value = m.name;
    $("eCrew").value = m.crew || "";
    $("memDel").textContent = "Remove";
    $("memStatus").textContent = "";
    openModal("memModal");
  }

  /* ---------------- cards ---------------- */
  /* Lanyard cards are portrait and printed over the camp artwork: the frame on
     the front, the important numbers sheet on the back. Everything on the front
     is placed as a fraction of the card, so the same layout works for the
     preview, the print sheet and the saved image. The frame's white panel runs
     from 10% to 90% across and 7% to 90% down, with the camp badge in the
     bottom right corner. */
  var FRONT = "/card-front.webp", BACK = "/card-back.webp";
  var ART_W = 1240, ART_H = 1748;
  var frontImg = new Image();
  frontImg.src = FRONT;

  function firstAid() {
    var c = (config.contacts || []).filter(function (x) { return x.group === "First aid"; })[0];
    return c ? c.tel : "";
  }
  /* Name size, as a percentage of the card's width, shrinking for long names. */
  function nameSize(name) { return name.length > 22 ? 5.2 : name.length > 16 ? 6.2 : 7.6; }

  /* Sized in cqw, so it scales to whatever box it's put in. */
  var FRONT_CSS =
    ".c{position:relative;container-type:inline-size;aspect-ratio:" + ART_W + "/" + ART_H + ";overflow:hidden;background:#fff;color:#16333A}" +
    ".c > img{position:absolute;inset:0;width:100%;height:100%;display:block}" +
    ".c .nm,.c .cr{position:absolute;left:12%;right:12%;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
    ".c .nm{top:9.5%;font-family:Fredoka,Arial,sans-serif;font-weight:600;line-height:1.2}" +
    ".c .cr{top:17.5%;font-size:4.2cqw;color:#5F7A80;font-family:Arial,Helvetica,sans-serif}" +
    ".c .qr{position:absolute;left:28%;width:44%;top:23.5%}.c .qr svg{width:100%;height:auto;display:block}" +
    ".c .bc{position:absolute;left:15%;right:15%;top:57.5%;height:7%}.c .bc svg{width:100%;height:100%;display:block}" +
    ".c .cd{position:absolute;left:10%;right:10%;top:65.5%;text-align:center;font-family:ui-monospace,Menlo,monospace;" +
    "font-weight:700;font-size:4.8cqw;letter-spacing:.25em;color:#4A5F63}" +
    ".c .fa{position:absolute;left:13%;width:50%;top:78%;font-family:Arial,Helvetica,sans-serif;font-weight:700;" +
    "font-size:3.6cqw;line-height:1.3;color:#E4574B}.c .fa b{display:block;font-family:Fredoka,Arial,sans-serif;font-size:5.4cqw}" +
    ".c.back > img{object-fit:cover}";

  function frontHtml(m, origin) {
    return '<div class="c"><img src="' + (origin || "") + FRONT + '" alt="">' +
      '<div class="nm" style="font-size:' + nameSize(m.name) + 'cqw">' + esc(m.name) + "</div>" +
      (m.crew ? '<div class="cr">' + esc(m.crew) + "</div>" : "") +
      '<div class="qr">' + qrSvg(m.code) + "</div>" +
      '<div class="bc">' + barcodeSvg(m.code, 2, 40) + "</div>" +
      '<div class="cd">' + esc(m.code) + "</div>" +
      (firstAid() ? '<div class="fa">First aid<b>' + esc(firstAid()) + "</b></div>" : "") + "</div>";
  }

  function openCard(code) {
    var m = members.get(code);
    if (!m) return;
    ui.card = code;
    $("lanyard").innerHTML = "<style>" + FRONT_CSS + "</style>" + frontHtml(m);
    $("cardStatus").textContent = "";
    openModal("modal");
  }

  function loaded(img) {
    return img.complete && img.naturalWidth ? Promise.resolve() : new Promise(function (ok) {
      img.onload = img.onerror = function () { ok(); };
    });
  }
  function fitText(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    while (text.length > 2 && ctx.measureText(text + "…").width > maxW) text = text.slice(0, -1);
    return text.trim() + "…";
  }

  /* The front at the artwork's own resolution, laid out as frontHtml does. */
  async function cardPng(code) {
    var m = members.get(code);
    if (!m) return;
    try { await document.fonts.load("600 90px Fredoka"); } catch (e) {}
    await loaded(frontImg);
    var W = ART_W, H = ART_H, u = W / 100, c = document.createElement("canvas");
    c.width = W; c.height = H;
    var ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
    if (frontImg.naturalWidth) ctx.drawImage(frontImg, 0, 0, W, H);
    ctx.textBaseline = "top"; ctx.textAlign = "center";
    ctx.fillStyle = "#16333A";
    ctx.font = "600 " + Math.round(nameSize(m.name) * u) + "px Fredoka, Arial, sans-serif";
    ctx.fillText(fitText(ctx, m.name, W * 0.76), W / 2, H * 0.095);
    if (m.crew) {
      ctx.font = Math.round(4.2 * u) + "px Arial, Helvetica, sans-serif"; ctx.fillStyle = "#5F7A80";
      ctx.fillText(fitText(ctx, m.crew, W * 0.76), W / 2, H * 0.175);
    }
    qrOnCanvas(ctx, m.code, W * 0.28, H * 0.235, W * 0.44);
    var bc = barcodeCanvas(m.code, 4, 120);
    if (bc) ctx.drawImage(bc, W * 0.15, H * 0.575, W * 0.70, H * 0.07);
    ctx.font = "700 " + Math.round(4.8 * u) + "px ui-monospace, Menlo, monospace"; ctx.fillStyle = "#4A5F63";
    if ("letterSpacing" in ctx) ctx.letterSpacing = Math.round(1.2 * u) + "px";
    ctx.fillText(m.code, W / 2, H * 0.655);
    if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
    if (firstAid()) {
      ctx.textAlign = "left"; ctx.fillStyle = "#E4574B";
      ctx.font = "700 " + Math.round(3.6 * u) + "px Arial, Helvetica, sans-serif";
      ctx.fillText("First aid", W * 0.13, H * 0.78);
      ctx.font = "600 " + Math.round(5.4 * u) + "px Fredoka, Arial, sans-serif";
      ctx.fillText(firstAid(), W * 0.13, H * 0.78 + 4.8 * u);
    }
    c.toBlob(function (blob) {
      if (!blob) { $("cardStatus").textContent = "The image couldn't be built."; return; }
      var slug = m.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || m.code;
      download(slug + "-" + m.code + ".png", blob);
      $("cardStatus").textContent = "Saved to your downloads.";
    }, "image/png");
  }

  /* Cards come nine to an A4 page, 60 × 85 mm. Each page of fronts is followed
     by a page of backs, so it prints double sided (flip on the long edge).
     Every back is the same, so they line up whichever way the printer turns
     the sheet. */
  function sheetHtml() {
    var PER = 9;
    var list = sortedMembers();
    var origin = location.origin;
    var back = '<div class="c back"><img src="' + origin + BACK + '" alt=""></div>';
    var pages = "";
    for (var i = 0; i < list.length; i += PER) {
      /* A short last page is padded with empty slots so its fronts sit exactly
         where the full page of backs will print. */
      var fronts = list.slice(i, i + PER).map(function (m) { return frontHtml(m, origin); });
      while (fronts.length < PER) fronts.push('<div class="c blank"></div>');
      pages += '<div class="page">' + fronts.join("") + "</div>";
      pages += '<div class="page">' + new Array(PER + 1).join(back) + "</div>";
    }
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>' + EVENT + ' — lanyard cards</title>' +
      '<link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@600;700&display=swap" rel="stylesheet"><style>' +
      "@page{size:A4;margin:0}" +
      "*{-webkit-print-color-adjust:exact;print-color-adjust:exact;box-sizing:border-box}" +
      "body{margin:0;font-family:Arial,Helvetica,sans-serif;background:#fff}" +
      ".page{width:210mm;height:297mm;display:grid;grid-template-columns:repeat(3,60mm);grid-auto-rows:84.6mm;gap:4mm;" +
      "justify-content:center;align-content:center;break-after:page}" +
      FRONT_CSS +
      ".c{width:60mm;outline:.2mm dashed #bbb}.c.blank{visibility:hidden}" +
      "@media screen{body{background:#eee}.page{background:#fff;margin:10mm auto;box-shadow:0 2px 10px rgba(0,0,0,.15)}}" +
      "@media print{.note{display:none}}" +
      '</style></head><body><p class="note" style="font-size:11pt;color:#555;text-align:center;margin:10mm 0 0">' +
      list.length + " cards. Print double sided, flipped on the long edge, at 100% (turn off “fit to page”). Then cut along the lines.</p>" +
      pages + "</body></html>";
  }

  /* ---------------- gate ---------------- */
  function showGate(msg) {
    $("gate").hidden = false;
    $("gateStatus").textContent = msg || "";
    if (!TOUCH) $("pin").focus();
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
      focusScan();
    } catch (err) { /* showGate already fired on 401 */ }
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

  /* Picking a place keeps it picked — tapping it again doesn't clear it, so a
     stray second tap can't leave the desk scanning to nowhere. On a phone the
     page then scrolls down to the scan box and camera. */
  function chooseDest(id) {
    ui.dest = id;
    lastScan = { code: null, place: null, at: 0 };
    renderDests();
    if (TOUCH) $("scanCard").scrollIntoView({ behavior: "smooth", block: "start" });
    focusScan();
  }
  $("destCard").addEventListener("click", function (e) {
    var b = e.target.closest("[data-dest]");
    if (b) return chooseDest(b.dataset.dest);
    var d = e.target.closest("[data-pday]");
    if (d) { ui.pickDay = d.dataset.pday; ui.showPast = false; return renderDests(); }
    if (e.target.closest("[data-past]")) { ui.showPast = !ui.showPast; renderDests(); }
  });
  $("going").addEventListener("click", function (e) {
    if (e.target.closest("[data-change]")) $("destCard").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  $("scan").addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    handleEntry($("scan").value);
    $("scan").value = "";
    lockScan();
  });
  $("scan").addEventListener("input", function () {
    var v = this.value;
    renderFind(members.has(v.trim().toUpperCase()) ? [] : nameMatches(v));
  });
  /* Tapping the box is the one way the keyboard opens on a phone. */
  $("scan").addEventListener("click", function () {
    if (this.hasAttribute("readonly")) { this.removeAttribute("readonly"); this.focus(); }
  });
  $("findResults").addEventListener("click", function (e) {
    var b = e.target.closest("[data-pick]");
    if (!b) return;
    processScan(b.dataset.pick);
    $("scan").value = "";
    renderFind([]);
    lockScan();
  });
  document.addEventListener("keydown", function (e) {
    if (TOUCH || ui.view !== "station" || !$("gate").hidden) return;
    if (document.querySelector(".modal:not([hidden])")) return;
    var t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
    if (e.key.length === 1 && /[a-z0-9]/i.test(e.key)) $("scan").focus();
  });
  $("camBtn").addEventListener("click", toggleCamera);
  $("undoBtn").addEventListener("click", undoLast);
  $("boardSearch").addEventListener("input", renderBoard);
  $("mSearch").addEventListener("input", renderMembers);

  /* programme */
  $("days").addEventListener("click", function (e) {
    var b = e.target.closest("[data-day]");
    if (b) { ui.day = b.dataset.day; renderSchedule(); }
  });
  $("agenda").addEventListener("click", function (e) {
    var b = e.target.closest("[data-act]");
    if (b) openAct(b.dataset.act);
  });
  $("actNew").addEventListener("click", function () { openAct(null); });
  $("actForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    var body = {
      name: $("actName").value.trim(), loc: $("actLoc").value.trim(), date: $("actDate").value,
      start: $("actStart").value, end: $("actEnd").value, site: $("actSite").value, dest: $("actDest").checked
    };
    if (!body.name) { $("actStatus").textContent = "Give the activity a name."; return; }
    if (!body.date || !body.start || !body.end) { $("actStatus").textContent = "Pick a date, start and end."; return; }
    if (body.end <= body.start) { $("actStatus").textContent = "It has to end after it starts."; return; }
    $("actStatus").textContent = "Saving…";
    try {
      if (ui.act) await api("activities/" + encodeURIComponent(ui.act), { method: "PUT", body: body });
      else await api("activities", { method: "POST", body: body });
      ui.day = body.date;
      closeModals();
      refresh(true);
    } catch (err) { $("actStatus").textContent = err.message || "That didn't save."; }
  });
  $("actDel").addEventListener("click", function () {
    var id = ui.act;
    if (!id) return;
    var there = countAt(id);
    arm(this, "act:" + id, there ? "Delete? " + there + " there go back on site" : "Tap again to delete", async function () {
      try {
        await api("activities/" + encodeURIComponent(id), { method: "DELETE" });
        if (ui.dest === id) ui.dest = null;
        closeModals();
        refresh(true);
      } catch (err) { $("actStatus").textContent = err.message || "That didn't delete."; }
    });
  });

  /* people */
  async function addPeople(people, statusEl) {
    try {
      var res = await api("members", { method: "POST", body: { people: people } });
      statusEl.textContent = res.added.length === 1
        ? res.added[0].name + " added — code " + res.added[0].code + "."
        : res.added.length + " people added.";
      refresh(true);
      return true;
    } catch (e) { statusEl.textContent = e.message || "That didn't save."; return false; }
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
  $("mBulkAdd").addEventListener("click", async function () {
    var people = $("mBulk").value.split("\n").map(function (l) { return l.trim(); }).filter(Boolean)
      .map(function (line) {
        var p = line.split(",");
        return { name: p[0], crew: p.slice(1).join(",") };
      });
    if (!people.length) { $("mStatus").textContent = "Paste some names first."; return; }
    if (await addPeople(people, $("mStatus"))) $("mBulk").value = "";
  });
  $("memList").addEventListener("click", function (e) {
    var card = e.target.closest("[data-card]");
    if (card) return openCard(card.dataset.card);
    var ed = e.target.closest("[data-editmem]");
    if (ed) openMem(ed.dataset.editmem);
  });
  $("memForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    var name = $("eName").value.trim();
    if (!name) { $("memStatus").textContent = "Give them a name."; return; }
    try {
      await api("members/" + ui.mem, { method: "PUT", body: { name: name, crew: $("eCrew").value.trim() } });
      closeModals();
      refresh(true);
    } catch (err) { $("memStatus").textContent = err.message || "That didn't save."; }
  });
  $("memDel").addEventListener("click", function () {
    var code = ui.mem;
    if (!code) return;
    arm(this, "mem:" + code, "Tap again to remove", async function () {
      try {
        await api("members/" + code, { method: "DELETE" });
        closeModals();
        refresh(true);
      } catch (err) { $("memStatus").textContent = err.message || "That didn't remove."; }
    });
  });

  /* cards */
  $("cardPng").addEventListener("click", function () { if (ui.card) cardPng(ui.card); });
  $("cardLink").addEventListener("click", function () {
    if (!ui.card) return;
    var link = location.origin + "/p/" + ui.card;
    if (navigator.clipboard) navigator.clipboard.writeText(link).catch(function () {});
    $("cardStatus").innerHTML = 'Copied: <a href="' + esc(link) + '" target="_blank" rel="noopener">' + esc(link) + "</a>";
  });
  $("sheetBtn").addEventListener("click", function () {
    if (!members.size) { $("sheetStatus").textContent = "Add some people first."; return; }
    download("teen-beach-moonta-lanyard-cards.html", sheetHtml(), "text/html;charset=utf-8");
    $("sheetStatus").textContent = "Saved. Open it and print double sided at 100%.";
  });

  /* ---------------- boot ---------------- */
  (async function start() {
    if (TOUCH) {
      document.body.classList.add("touch");
      $("scan").setAttribute("readonly", "readonly");
      $("scan").placeholder = "Tap to type";
      $("scanHint").textContent = "Use the camera, or tap the box to type.";
    }
    try { config = await (await fetch("/api/config")).json(); } catch (e) {}
    if (config.pinRequired && !pin()) showGate();
    await refresh(true);
    if (!$("gate").hidden) return;
    focusScan();
  })();

  setInterval(function () { if (!document.hidden) refresh(false); }, 4000);
  setInterval(function () {
    renderTally();
    if (ui.view === "station") renderDests();
    if (ui.view === "board") renderBoard();
    if (ui.view === "schedule") renderSchedule();
  }, 30000);
})();
