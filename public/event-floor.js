/* event-floor.js - R227 (owner, 18 Nov 2026: "Event day - add planner 2D, 3D, measure, and can print. Add a lock so no
 * modifications - you need to unlock and then edit it"). Shared by Tasks & Crew (ops.html), the Event-day monitor
 * (monitor.html), the planner (builder.html), the Run-sheet (runsheet.html) and the printed Event-day pack (eventday-pack.html):
 *
 *   HelmEventFloor.normalize(floor)        the saved floor plan (event_floor_get, 0397) -> { items, room, unit } in feet
 *   HelmEventFloor.seatsOf(item)           seats of one item (the planner's genSeats rule: rows x cols, seats, single chairs, sofas)
 *   HelmEventFloor.measure(floor)          hall + usable area, venue size, stage / dance floor sizes, tables, seats vs guests,
 *                                          aisle widths, the gap between seating blocks, stage to the first seats, exits
 *   HelmEventFloor.legend(floor)           [{ cat, label, color, n }] for the plan's legend
 *   HelmEventFloor.planSvg(doc, floor, o)  the 2D plan as an <svg> (room outline, items, the hall's width / length marked,
 *                                          stage / dance-floor sizes written on them). DOM only, no HTML strings.
 *   HelmEventFloor.panel(o)                the "Floor plan" card + the lock bar on the event-day pages (loads + caches, 60 s)
 *   HelmEventFloor.lockBar(host, o)        the lock bar alone (planner, run-sheet): "Locked for the event day - Unlock to edit"
 *   HelmEventFloor.isLocked(quoteId)       the last answer for that event (false when unknown / before 0397)
 *   HelmEventFloor.viewUrl(quoteId, mode)  builder.html?quote=..&view=1 (mode "3d" | "measure") - the planner opens VIEW ONLY
 *
 * Before 0397 is applied BPStore.ops.planLock.floor / get answer null: no card, no bar, no error. Money is never read or shown
 * (the server strips prices from every item). Colours: the --tc-* tokens of ops-board.css, with fallbacks (event-floor.css). */
(function (global) {
  "use strict";
  var doc = global.document, SVGNS = "http://www.w3.org/2000/svg", FT_PER_M = 3.28084;

  /* ---------------- pure ---------------- */
  var CAT_LABEL = { structure: "Structure", seating: "Seating", av: "Sound & light", decor: "Decor", logistics: "Logistics", safety: "Safety", security: "Security", other: "Other" };
  var CAT_FALLBACK = { structure: "#8d7a64", seating: "#5f7f9e", av: "#7a6a9e", decor: "#b0708a", logistics: "#8a7f5c", safety: "#c0563f", security: "#6f6f6f", other: "#a59e94" };
  var SEAT_UNIT = { chiavari: 1, barstool: 1 }, FLOOR_SEATS = { sofa: 3, loveseat: 2, armchair: 1, ottoman: 1, bench: 2, lounge: 4 };
  var TABLES = { table: "Round", round: "Round", longtable: "Banquet", headtable: "Head", cocktail: "Cocktail", coffeetable: "Coffee" };
  function num(v) { var n = Number(v); return v === null || v === "" || v === undefined || !isFinite(n) ? NaN : n; }
  function pos(v) { var n = num(v); return n > 0 ? n : NaN; }
  function r1(n) { return Math.round(n * 10) / 10; }
  function hex(c) { return typeof c === "string" && /^#[0-9a-f]{3,8}$/i.test(c.trim()) ? c.trim() : ""; }
  function seatsOf(it) {
    var p = (it && it.properties) || {};
    if (p.rows && p.cols) return Math.max(0, Math.round(num(p.rows) * num(p.cols))) || 0;
    if (p.seats) return Math.max(0, Math.round(num(p.seats))) || 0;
    return SEAT_UNIT[it && it.type] || FLOOR_SEATS[it && it.type] || 0;
  }
  function normalize(floor) {
    var f = floor || {}, items = [];
    (Array.isArray(f.items) ? f.items : []).forEach(function (it) {
      if (!it || typeof it !== "object") return;
      var x = num(it.x), y = num(it.y), w = pos(it.width), hh = pos(it.height);
      if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(hh) || w > 5000 || hh > 5000) return;
      var cat = CAT_LABEL[it.category] ? it.category : "other", r = num(it.rotation) || 0;
      // the box the item covers on the floor (a 90 / 270 degree turn swaps width and length)
      var q = ((Math.round(r) % 180) + 180) % 180, turned = q > 45 && q < 135;
      var bw = turned ? hh : w, bh = turned ? w : hh, cx = x + w / 2, cy = y + hh / 2;
      items.push({ x: x, y: y, w: w, h: hh, r: r, type: String(it.type || ""), cat: cat, label: String(it.label || it.type || "").slice(0, 60),
        color: hex(it.color) || CAT_FALLBACK[cat], seats: seatsOf(it), box: { x0: cx - bw / 2, y0: cy - bh / 2, x1: cx + bw / 2, y1: cy + bh / 2, w: bw, h: bh } });
    });
    var wd = f.world || {}, hall = f.hall || {};
    var rw = pos(wd.w) || pos(hall.len), rh = pos(wd.h) || pos(hall.wid);
    return { items: items, room: isFinite(rw) && isFinite(rh) ? { w: rw, h: rh } : null, unit: f.unit === "m" ? "m" : "ft" };
  }
  function len(ft, unit) { if (!isFinite(ft)) return ""; return unit === "m" ? r1(ft / FT_PER_M) + " m" : r1(ft) + " ft"; }
  function size(w, hh, unit) { if (!isFinite(w) || !isFinite(hh)) return ""; return unit === "m" ? r1(w / FT_PER_M) + " × " + r1(hh / FT_PER_M) + " m" : r1(w) + " × " + r1(hh) + " ft"; }
  function areaTxt(w, hh, unit) { if (!isFinite(w) || !isFinite(hh)) return ""; var a = w * hh; return unit === "m" ? Math.round(a / (FT_PER_M * FT_PER_M)).toLocaleString("en-IN") + " sq m" : Math.round(a).toLocaleString("en-IN") + " sq ft"; }
  function isSeatBlock(i) { return i.type === "seatblock" || i.type === "chairrow" || i.type === "bleacher"; }
  function overlap(a0, a1, b0, b1) { return Math.min(a1, b1) - Math.max(a0, b0); }
  // the narrowest walkway between two seating blocks side by side (rows that face the same way share a y band)
  function blockGap(items) {
    var b = items.filter(isSeatBlock), best = NaN;
    for (var i = 0; i < b.length; i++) for (var j = 0; j < b.length; j++) {
      if (i === j) continue; var A = b[i].box, C = b[j].box;
      if (C.x0 < A.x1 || overlap(A.y0, A.y1, C.y0, C.y1) < Math.min(A.h, C.h) * 0.3) continue;
      var g = C.x0 - A.x1; if (g > 0.5 && g < 60 && (!isFinite(best) || g < best)) best = g;
    }
    return best;
  }
  // the clear floor between the front of a stage / mandap and the nearest seats in front of it (below it on the plan)
  function stageGap(items) {
    var st = items.filter(function (i) { return i.type === "stage" || i.type === "mandap"; }), seats = items.filter(function (i) { return i.seats > 0; }), best = NaN;
    st.forEach(function (s) { seats.forEach(function (c) {
      if (overlap(s.box.x0, s.box.x1, c.box.x0, c.box.x1) <= 0) return;
      var g = c.box.y0 - s.box.y1; if (g >= 0 && (!isFinite(best) || g < best)) best = g;
    }); });
    return best;
  }
  function measure(floor) {
    var f = floor || {}, m = normalize(f), u = m.unit, hall = f.hall || {}, out = { unit: u, rows: [], warnings: [] };
    var hl = pos(hall.len), hw = pos(hall.wid), vl = pos(hall.venue_len), vw = pos(hall.venue_wid);
    if (!isFinite(hl) && m.room) { hl = m.room.w; hw = m.room.h; }
    out.hall = isFinite(hl) && isFinite(hw) ? { len: hl, wid: hw } : null;
    out.venue = isFinite(vl) && isFinite(vw) ? { len: vl, wid: vw } : null;
    if (out.venue) out.rows.push(["Venue", size(vl, vw, u) + " · " + areaTxt(vl, vw, u)]);
    if (out.hall) out.rows.push([out.venue ? "Usable area (laid out)" : "Hall (usable area)", size(hl, hw, u) + " · " + areaTxt(hl, hw, u)]);
    var stages = m.items.filter(function (i) { return i.type === "stage"; }), dance = m.items.filter(function (i) { return i.type === "dancefloor"; }), mandap = m.items.filter(function (i) { return i.type === "mandap"; });
    function sizes(list, word) { if (!list.length) return; out.rows.push([word + (list.length > 1 ? " (" + list.length + ")" : ""), list.map(function (i) { return size(i.box.w, i.box.h, u); }).join(", ")]); }
    sizes(stages, "Stage"); sizes(mandap, "Mandap"); sizes(dance, "Dance floor");
    var tables = {}, nT = 0; m.items.forEach(function (i) { if (TABLES[i.type]) { tables[TABLES[i.type]] = (tables[TABLES[i.type]] || 0) + 1; nT++; } });
    out.tables = nT;
    if (nT) out.rows.push(["Tables", nT + " (" + Object.keys(tables).map(function (k) { return tables[k] + " " + k.toLowerCase(); }).join(", ") + ")"]);
    var seats = m.items.reduce(function (n, i) { return n + i.seats; }, 0), guests = pos(f.guests);
    out.seats = seats; out.guests = isFinite(guests) ? Math.round(guests) : null;
    if (seats || out.guests) {
      var vs = seats + " seats" + (out.guests ? " for " + out.guests + " guests" : "");
      if (out.guests && seats) { var d = seats - out.guests; vs += d === 0 ? " - exactly enough" : d > 0 ? " - " + d + " spare" : " - " + (-d) + " short"; if (d < 0) out.warnings.push((-d) + " seats short of the guest count"); }
      out.rows.push(["Seats vs guests", vs]);
    }
    if (pos(f.capacity)) out.rows.push(["Venue capacity", Math.round(f.capacity) + " people"]);
    var aisles = m.items.filter(function (i) { return i.type === "redcarpet"; });
    if (aisles.length) out.rows.push(["Aisle / carpet", aisles.map(function (i) { return len(Math.min(i.box.w, i.box.h), u) + " wide, " + len(Math.max(i.box.w, i.box.h), u) + " long"; }).join("; ")]);
    var bg = blockGap(m.items); if (isFinite(bg)) { out.rows.push(["Walkway between seating blocks", len(bg, u)]); if (bg < 4) out.warnings.push("walkway between seating blocks under 4 ft"); }
    var sg = stageGap(m.items); if (isFinite(sg)) out.rows.push(["Stage to the first seats", len(sg, u)]);
    var ex = m.items.filter(function (i) { return i.type === "exit"; }).length; if (ex) out.rows.push(["Exits marked", String(ex)]);
    out.items = m.items.length;
    return out;
  }
  function legend(floor) {
    var m = normalize(floor), by = {}, order = [];
    m.items.forEach(function (i) { if (!by[i.cat]) { by[i.cat] = { cat: i.cat, label: CAT_LABEL[i.cat], color: i.color, n: 0 }; order.push(i.cat); } by[i.cat].n++; });
    return order.map(function (k) { return by[k]; });
  }
  function viewUrl(quoteId, mode) {
    return "builder.html?quote=" + encodeURIComponent(quoteId || "") + "&view=1" + (mode === "3d" ? "&mode=3d" : mode === "measure" ? "&measure=1" : "");
  }
  function lockWords(st) {
    st = st || {};
    if (st.locked) return { title: "Locked for the event day - Unlock to edit",
      sub: st.state === "locked" ? "Locked by " + (st.changed_by || "someone") + (st.changed_at ? " · " + when(st.changed_at) : "") + (st.reason ? " · " + st.reason : "")
        : "Locked by itself: the event is on its day (" + (st.stage === "event_day" ? "Event Day stage" : st.stage === "settlement" || st.stage === "closed" ? "after the event" : "On the day") + ")." };
    if (st.state === "unlocked") return { title: "Plan unlocked for changes", sub: "Unlocked by " + (st.changed_by || "someone") + (st.changed_at ? " · " + when(st.changed_at) : "") + (st.reason ? " · " + st.reason : "") };
    return { title: "Plan open for changes", sub: st.confirmed ? "Locks by itself on the event day. Lock it now when the plan is final." : "The plan can be locked once the event is confirmed." };
  }
  function when(iso) {
    var t = new Date(iso); if (!isFinite(t.getTime())) return "";
    try { return new Intl.DateTimeFormat("en-IN", { timeZone: tzName(), day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).format(t); } catch (e) { return t.toISOString().slice(0, 16).replace("T", " "); }
  }
  function tzName() { try { return (global.BPStore && global.BPStore.studioTimezone && global.BPStore.studioTimezone()) || "Asia/Kolkata"; } catch (e) { return "Asia/Kolkata"; } }

  /* ---------------- DOM ---------------- */
  function h(tag, o, kids) {
    var n = doc.createElement(tag); o = o || {};
    Object.keys(o).forEach(function (k) {
      var v = o[k]; if (v == null || v === false) return;
      if (k === "cls") n.className = v; else if (k === "text") n.textContent = v;
      else if (k === "on") Object.keys(v).forEach(function (e) { n.addEventListener(e, v[e]); });
      else n.setAttribute(k, v === true ? "" : String(v));
    });
    (kids || []).forEach(function (c) { if (c == null || c === false) return; n.appendChild(typeof c === "string" ? doc.createTextNode(c) : c); });
    return n;
  }
  function s(tag, attrs, d) {
    var n = (d || doc).createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) { if (attrs[k] != null) n.setAttribute(k, String(attrs[k])); });
    return n;
  }
  // the text size goes in style (user units): a page rule on svg text must never blow the labels up
  function fsz(n, v) { try { n.style.fontSize = r1(v) + "px"; } catch (e) {} return n; }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); return n; }
  function planSvg(d, floor, o) {
    d = d || doc; o = o || {};
    var m = normalize(floor), u = m.unit;
    var x0 = 0, y0 = 0, x1 = m.room ? m.room.w : 0, y1 = m.room ? m.room.h : 0;
    m.items.forEach(function (i) { x0 = Math.min(x0, i.box.x0); y0 = Math.min(y0, i.box.y0); x1 = Math.max(x1, i.box.x1); y1 = Math.max(y1, i.box.y1); });
    if (x1 - x0 < 1) x1 = x0 + 10; if (y1 - y0 < 1) y1 = y0 + 10;
    var W = x1 - x0, H = y1 - y0, pad = Math.max(4, Math.min(W, H) * 0.06), fs = Math.max(1.4, Math.min(W, H) / 42);
    var svg = s("svg", { viewBox: (x0 - pad * 1.6) + " " + (y0 - pad * 1.6) + " " + (W + pad * 2.6) + " " + (H + pad * 2.6), role: "img", class: "ef-svg",
      "aria-label": "Floor plan" + (m.room ? ", hall " + size(m.room.w, m.room.h, u) : "") + ", " + m.items.length + " items", preserveAspectRatio: "xMidYMid meet" }, d);
    var ttl = s("title", {}, d); ttl.textContent = "Floor plan"; svg.appendChild(ttl);
    if (m.room) svg.appendChild(s("rect", { x: 0, y: 0, width: m.room.w, height: m.room.h, class: "ef-room", "stroke-width": Math.max(0.25, fs * 0.12) }, d));
    m.items.slice().sort(function (a, b) { return (a.type === "redcarpet" || a.type === "dancefloor" ? 0 : 1) - (b.type === "redcarpet" || b.type === "dancefloor" ? 0 : 1); }).forEach(function (i) {
      var g = s("g", { transform: i.r ? "rotate(" + r1(i.r) + " " + r1(i.x + i.w / 2) + " " + r1(i.y + i.h / 2) + ")" : null, class: "ef-it ef-c-" + i.cat }, d);
      var round = /^(table|round|cocktail|chandelier|fountain)$/.test(i.type);
      var shape = round ? s("ellipse", { cx: i.x + i.w / 2, cy: i.y + i.h / 2, rx: i.w / 2, ry: i.h / 2 }, d)
        : s("rect", { x: i.x, y: i.y, width: i.w, height: i.h, rx: Math.min(i.w, i.h) * 0.08 }, d);
      shape.setAttribute("fill", i.color); shape.setAttribute("fill-opacity", "0.78"); shape.setAttribute("class", "ef-shape"); shape.setAttribute("stroke-width", String(Math.max(0.12, fs * 0.06)));
      g.appendChild(shape);
      var t = s("title", {}, d); t.textContent = i.label + " · " + size(i.box.w, i.box.h, u) + (i.seats ? " · " + i.seats + " seats" : ""); g.appendChild(t);
      svg.appendChild(g);
      var big = i.box.w * i.box.h > fs * fs * 18;
      if (big && i.label) {
        var tx = s("text", { x: r1(i.box.x0 + i.box.w / 2), y: r1(i.box.y0 + i.box.h / 2), "text-anchor": "middle", "dominant-baseline": "central", "font-size": r1(fs), class: "ef-lbl" }, d);
        tx.textContent = i.label.length > 18 ? i.label.slice(0, 17) + "…" : i.label; svg.appendChild(fsz(tx, fs));
        if (/^(stage|dancefloor|mandap)$/.test(i.type)) {
          var dz = s("text", { x: r1(i.box.x0 + i.box.w / 2), y: r1(i.box.y0 + i.box.h / 2 + fs * 1.15), "text-anchor": "middle", "dominant-baseline": "central", "font-size": r1(fs * 0.85), class: "ef-dim" }, d);
          dz.textContent = size(i.box.w, i.box.h, u); svg.appendChild(fsz(dz, fs * 0.85));
        }
      }
    });
    // the hall's width along the top and its length down the left side
    if (m.room && o.dims !== false) {
      var dy = -pad * 0.7, dx = -pad * 0.7, sw = Math.max(0.15, fs * 0.07);
      svg.appendChild(s("line", { x1: 0, y1: dy, x2: m.room.w, y2: dy, class: "ef-dimline", "stroke-width": sw }, d));
      [0, m.room.w].forEach(function (x) { svg.appendChild(s("line", { x1: x, y1: dy - fs * 0.4, x2: x, y2: dy + fs * 0.4, class: "ef-dimline", "stroke-width": sw }, d)); });
      var tw = s("text", { x: r1(m.room.w / 2), y: r1(dy - fs * 0.55), "text-anchor": "middle", "font-size": r1(fs), class: "ef-dim" }, d); tw.textContent = len(m.room.w, u); svg.appendChild(fsz(tw, fs));
      svg.appendChild(s("line", { x1: dx, y1: 0, x2: dx, y2: m.room.h, class: "ef-dimline", "stroke-width": sw }, d));
      [0, m.room.h].forEach(function (y) { svg.appendChild(s("line", { x1: dx - fs * 0.4, y1: y, x2: dx + fs * 0.4, y2: y, class: "ef-dimline", "stroke-width": sw }, d)); });
      var th = s("text", { x: r1(dx - fs * 0.55), y: r1(m.room.h / 2), "text-anchor": "middle", "font-size": r1(fs), class: "ef-dim", transform: "rotate(-90 " + r1(dx - fs * 0.55) + " " + r1(m.room.h / 2) + ")" }, d);
      th.textContent = len(m.room.h, u); svg.appendChild(fsz(th, fs));
    }
    return svg;
  }
  function legendEl(floor) {
    var ul = h("ul", { cls: "ef-legend", "aria-label": "Legend" });
    legend(floor).forEach(function (l) {
      var sw = h("span", { cls: "ef-sw", "aria-hidden": "true" }); sw.style.background = l.color;
      ul.appendChild(h("li", {}, [sw, l.label + " (" + l.n + ")"]));
    });
    return ul;
  }
  function factsEl(mz) {
    var dl = h("dl", { cls: "ef-facts" });
    mz.rows.forEach(function (r) { dl.appendChild(h("div", {}, [h("dt", { text: r[0] }), h("dd", { text: r[1] })])); });
    return dl;
  }

  /* ---- the lock bar ---- */
  var UI = { form: null, hist: {} };   // the open unlock form (quote id) - kept across redraws
  function api() { return global.BPStore && global.BPStore.ops && global.BPStore.ops.planLock; }
  function toast(msg, type) { try { if (global.BPUI && global.BPUI.toast) global.BPUI.toast(msg, { type: type || "ok" }); } catch (e) {} }
  function errText(e, action) { try { if (global.BPUI && global.BPUI.friendlyError) return global.BPUI.friendlyError(e, { action: action }); } catch (x) {} return String((e && e.message) || e || "Something went wrong"); }
  function renderLock(host, st, o) {
    if (!host) return;
    o = o || {};
    if (!st || (!st.locked && !st.confirmed && st.state !== "unlocked")) { host.hidden = true; clear(host); return; }
    var qid = o.quoteId, w = lockWords(st), open = UI.form === qid;
    var kr = host.querySelector ? host.querySelector("#efReason") : null, keep = kr ? kr.value : null;   // a redraw keeps what was typed
    clear(host); host.hidden = false;
    host.className = "ef-lock " + (st.locked ? "is-locked" : "is-open") + (o.compact ? " compact" : "");
    host.setAttribute("role", "region"); host.setAttribute("aria-label", "Event plan lock");
    var row = h("div", { cls: "ef-lock-row" }, [
      h("span", { cls: "ef-lock-ico", "aria-hidden": "true", text: st.locked ? "🔒" : "🔓" }),
      h("span", { cls: "ef-lock-txt" }, [h("b", { text: w.title }), h("span", { cls: "ef-lock-sub", text: w.sub })])]);
    var acts = h("span", { cls: "ef-lock-acts" });
    if (st.locked && st.can_unlock && !open) acts.appendChild(h("button", { type: "button", cls: "ef-btn dark", id: "efUnlock", text: "Unlock to edit", on: { click: function () { UI.form = qid; renderLock(host, st, o); var f = doc.getElementById("efReason"); if (f) f.focus(); } } }));
    if (st.locked && !st.can_unlock) acts.appendChild(h("span", { cls: "ef-lock-note", text: "Only an admin or the event manager can unlock." }));
    if (!st.locked && st.can_lock) acts.appendChild(h("button", { type: "button", cls: "ef-btn", id: "efLockBtn", text: st.state === "unlocked" ? "Lock again" : "Lock plan", on: { click: function (e) { doLock(e.currentTarget, host, st, o, true, null); } } }));
    var hist = Array.isArray(st.history) ? st.history : [];
    if (hist.length) acts.appendChild(h("button", { type: "button", cls: "ef-link", "aria-expanded": UI.hist[qid] ? "true" : "false", text: "History (" + hist.length + ")",
      on: { click: function () { UI.hist[qid] = !UI.hist[qid]; renderLock(host, st, o); } } }));
    row.appendChild(acts); host.appendChild(row);
    if (open) {
      var inp = h("textarea", { id: "efReason", cls: "ef-inp", rows: "2", maxlength: "300", placeholder: "e.g. The client added a photo booth - stage moves 4 ft", "aria-describedby": "efReasonHint" });
      if (keep != null) inp.value = keep;
      var err = h("p", { cls: "ef-err", id: "efReasonErr", role: "alert", hidden: true });
      var go = h("button", { type: "button", cls: "ef-btn dark", id: "efUnlockGo", text: "Unlock", on: { click: function (e) {
        var r = String(inp.value || "").trim(); if (r.length < 3) { err.textContent = "Say why in a few words (3-300 characters)."; err.hidden = false; inp.focus(); return; }
        doLock(e.currentTarget, host, st, o, false, r); } } });
      host.appendChild(h("div", { cls: "ef-form" }, [h("label", { "for": "efReason", cls: "ef-lbl", text: "Why unlock? (kept in the event's history)" }), inp,
        h("p", { cls: "ef-hint", id: "efReasonHint", text: "Unlocking lets people change the floor plan, measurements, run-sheet times and the task plan again. Lock it again when you are done." }), err,
        h("div", { cls: "ef-acts" }, [h("button", { type: "button", cls: "ef-btn", text: "Cancel", on: { click: function () { UI.form = null; renderLock(host, st, o); } } }), go])]));
    }
    if (UI.hist[qid] && hist.length) {
      var ol = h("ol", { cls: "ef-hist", "aria-label": "Lock history" });
      hist.forEach(function (x) { ol.appendChild(h("li", {}, [h("b", { text: x.action === "lock" ? "Locked" : "Unlocked" }), " by " + (x.by || "someone") + " · " + when(x.at) + (x.reason ? " · " + x.reason : "")])); });
      host.appendChild(ol);
    }
  }
  async function doLock(btn, host, st, o, lock, reason) {
    var A = api(); if (!A) return;
    btn.disabled = true; btn.setAttribute("aria-busy", "true");
    try {
      var nx = await A.set(o.quoteId, lock, reason);
      UI.form = null; cache[o.quoteId] = Object.assign({}, cache[o.quoteId] || {}, { lock: nx, at: Date.now() });
      renderLock(host, nx, o);
      toast(lock ? "Plan locked for the event day." : "Plan unlocked - lock it again when you are done.");
      if (o.onChange) o.onChange(nx);
    } catch (e) {
      toast(errText(e, lock ? "lock the plan" : "unlock the plan"), "err");
      btn.disabled = false; btn.removeAttribute("aria-busy");
    }
  }
  // the lock bar alone (planner, run-sheet): loads once; o: { quoteId, state?, onChange(state), compact }
  async function lockBar(host, o) {
    o = o || {}; if (!host || !o.quoteId) return null;
    var st = o.state; if (st === undefined) { var A = api(); if (!A) return null; try { st = await A.get(o.quoteId); } catch (e) { st = null; } }
    cache[o.quoteId] = Object.assign({}, cache[o.quoteId] || {}, { lock: st, at: Date.now() });
    renderLock(host, st, o);
    return st;
  }

  /* ---- the Floor plan card + lock bar on the event-day pages ---- */
  var cache = {}, loading = {};
  function isLocked(qid) { var c = cache[qid]; return !!(c && c.lock && c.lock.locked); }
  function sig(v) { try { return JSON.stringify(v); } catch (e) { return String(Math.random()); } }
  function renderFloor(host, f, o) {
    clear(host); host.hidden = false;
    var lk = f.lock || {}, mz = measure(f), qid = o.quoteId;
    var head = h("div", { cls: "ef-head" }, [h("h3", { cls: "tc-h2", id: host.id + "H", text: "Floor plan" }),
      h("span", { cls: "ef-meta", text: [f.version_no ? "V" + f.version_no : "", f.saved_at ? "saved " + when(f.saved_at) : "", mz.items ? mz.items + " items" : ""].filter(Boolean).join(" · ") }),
      lk.locked ? h("span", { cls: "ef-chip locked", text: "🔒 Locked" }) : null]);
    host.appendChild(head);
    if (!mz.items) {
      host.appendChild(h("p", { cls: "ef-empty", text: "No floor plan saved yet. Draw it in the planner (2D, 3D and Measure) - it shows here for the day." }));
    } else {
      var fig = h("figure", { cls: "ef-fig" }); fig.appendChild(planSvg(doc, f)); fig.appendChild(legendEl(f));
      var body = h("div", { cls: "ef-body" }, [fig, factsEl(mz)]);
      if (mz.warnings.length) body.appendChild(h("p", { cls: "ef-warn", role: "note", text: "Check: " + mz.warnings.join("; ") + "." }));
      host.appendChild(body);
    }
    var acts = h("div", { cls: "ef-acts" });
    if (mz.items) {
      acts.appendChild(h("a", { cls: "ef-btn dark", href: viewUrl(qid, ""), text: "Open 2D plan", title: "Opens the planner view only - nothing can be changed there" }));
      acts.appendChild(h("a", { cls: "ef-btn", href: viewUrl(qid, "3d"), text: "3D view" }));
      acts.appendChild(h("a", { cls: "ef-btn", href: viewUrl(qid, "measure"), text: "📏 Measure" }));
    }
    acts.appendChild(h("a", { cls: "ef-btn", href: "eventday-pack.html?quote=" + encodeURIComponent(qid), text: "🖨 Print event-day pack" }));
    if (!lk.locked && o.canEditPlan) acts.appendChild(h("a", { cls: "ef-link", href: "builder.html?quote=" + encodeURIComponent(qid), text: "Edit in the planner →" }));
    host.appendChild(acts);
    host.appendChild(h("p", { cls: "ef-hint", text: "Opens view only: 2D, 3D and Measure work, nothing is saved." + (lk.locked ? " The plan is locked for the event day." : "") }));
  }
  // o: { quoteId, lockHost, floorHost, showFloor, onChange(lockState), compact, canEditPlan }
  function panel(o) {
    o = o || {}; var qid = o.quoteId, A = api();
    if (!qid || !A || !A.floor) { if (o.lockHost) o.lockHost.hidden = true; if (o.floorHost) o.floorHost.hidden = true; return; }
    var c = cache[qid];
    if ((!c || !c.floor || Date.now() - (c.fat || 0) > 60000 || o.force) && !loading[qid]) {
      loading[qid] = true;
      A.floor(qid).then(function (f) {
        var prev = c && c.lock; cache[qid] = { floor: f || null, lock: f ? f.lock : null, at: Date.now(), fat: Date.now(), none: !f };
        loading[qid] = false; draw(o);
        if (o.onChange && sig(prev && prev.locked) !== sig(f && f.lock && f.lock.locked)) o.onChange(f ? f.lock : null);
      }, function () { loading[qid] = false; cache[qid] = { floor: null, lock: null, at: Date.now(), fat: Date.now(), none: true }; draw(o); });
    }
    draw(o);
  }
  function draw(o) {
    var c = cache[o.quoteId] || {}, f = c.floor;
    if (o.lockHost) {
      if (!f || !c.lock) { o.lockHost.hidden = true; }
      else if (UI.form !== o.quoteId) { var ls = sig([c.lock, UI.hist[o.quoteId]]); if (o.lockHost._efSig !== ls) { o.lockHost._efSig = ls; renderLock(o.lockHost, c.lock, o); } }
    }
    if (o.floorHost) {
      if (!f || !o.showFloor) { o.floorHost.hidden = true; o.floorHost._efSig = ""; return; }
      var fs = sig([f, !!o.canEditPlan, c.lock && c.lock.locked]); if (o.floorHost._efSig === fs && !o.floorHost.hidden) return;
      o.floorHost._efSig = fs; renderFloor(o.floorHost, Object.assign({}, f, { lock: c.lock || f.lock }), o);
    }
  }
  function reset(qid) { if (qid) delete cache[qid]; else cache = {}; }

  var API = { normalize: normalize, seatsOf: seatsOf, measure: measure, legend: legend, planSvg: planSvg, legendEl: legendEl, factsEl: factsEl,
    lockWords: lockWords, viewUrl: viewUrl, panel: panel, lockBar: lockBar, renderLock: renderLock, isLocked: isLocked, reset: reset,
    size: size, len: len, CAT_LABEL: CAT_LABEL, _ui: UI, _cache: function () { return cache; } };
  global.HelmEventFloor = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof window !== "undefined" ? window : globalThis);
