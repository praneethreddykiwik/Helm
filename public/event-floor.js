/* event-floor.js - R227 (owner, 18 Nov 2026: "Event day - add planner 2D, 3D, measure, and can print. Add a lock so no
 * modifications - you need to unlock and then edit it"). Shared by Tasks & Crew (ops.html), the Event-day monitor
 * (monitor.html), the Run-sheet (runsheet.html) and the printed Event-day pack (eventday-pack.html).
 * R257 (owner, 25 Nov 2026: "First of all remove the lock"): there is no event-day lock any more (0442) - no lock bar, no Lock / Unlock, no
 * history. Only a CLOSED event refuses plan changes (the server says so; isClosed lets the pages hide what cannot work).
 *
 *   HelmEventFloor.normalize(floor)        the saved floor plan (event_floor_get, 0397) -> { items, room, unit } in feet
 *   HelmEventFloor.seatsOf(item)           seats of one item (the planner's genSeats rule: rows x cols, seats, single chairs, sofas)
 *   HelmEventFloor.measure(floor)          hall + usable area, venue size, stage / dance floor sizes, tables, seats vs guests,
 *                                          aisle widths, the gap between seating blocks, stage to the first seats, exits
 *   HelmEventFloor.legend(floor)           [{ cat, label, color, n }] for the plan's legend
 *   HelmEventFloor.planSvg(doc, floor, o)  the 2D plan as an <svg> (room outline, items, the hall's width / length marked,
 *                                          stage / dance-floor sizes written on them). DOM only, no HTML strings.
 *                                          R253: the planner's own drawing (floor-draw.js) when it is loaded; without it the plain shapes
 *   HelmEventFloor.panel(o)                the "Floor plan" card on the event-day pages (loads + caches, 60 s; the event's state alone is read
 *                                          again every 25 s and when the page is looked at again)
 *   HelmEventFloor.isClosed(quoteId)       the event is closed and its plan cannot be changed (false when unknown)
 *   HelmEventFloor.oldLock(st) / oldBar()  a database WITHOUT 0442 that still refuses changes on the event day: one line + Unlock (admin / event
 *                                          manager). With 0442 it never shows.
 *   HelmEventFloor.viewer()                R253: loads floor-view.js / .css once (the exact plan + the full-window Layout viewer)
 *   HelmEventFloor.viewUrl(quoteId, mode)  builder.html?quote=..&view=1 (mode "3d" | "measure") - the planner opens VIEW ONLY
 *
 * Before 0397 is applied BPStore.ops.planLock.floor / get answer null: no card, no error. Money is never read or shown
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
      // R257: the chairs rule is 70% of the guests (the pricing default), so only fewer than that is short
      if (out.guests && seats) { var need = Math.round(out.guests * 0.7), d = seats - out.guests;
        vs += d === 0 ? " - exactly enough" : d > 0 ? " - " + d + " spare" : seats >= need ? " - enough for 70% of the guests" : " - " + (need - seats) + " short of 70%";
        if (seats < need) out.warnings.push((need - seats) + " seats short (70% of " + out.guests + " guests = " + need + ")"); }
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
  // R253: exactly what the planner's 2D canvas shows (floor-draw.js is generated from builder.js), with the hall size as its name
  function exactSvg(floor) {
    try {
      var D = global.HelmFloorDraw, plan = D.prepare(floor), sv = D.svg(plan), ttl = s("title", {});
      sv.setAttribute("class", "fv-plan ef-svg ef-exact"); sv.setAttribute("role", "img");
      sv.setAttribute("aria-label", "Floor plan, hall " + size(plan.world.w, plan.world.h, plan.unit) + ", " + plan.items.length + " items");
      ttl.textContent = "Floor plan"; sv.insertBefore(ttl, sv.firstChild);
      sv.querySelectorAll(".margins rect").forEach(function (r) { r.setAttribute("vector-effect", "non-scaling-stroke"); });
      return sv;
    } catch (e) { return null; }
  }
  function planSvg(d, floor, o) {
    d = d || doc; o = o || {};
    if (d === doc && !o.plain && global.HelmFloorDraw) { var ex = exactSvg(floor); if (ex) return ex; }
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

  /* ---- a database without 0442: it may still refuse plan changes on the event day. One line + Unlock; nothing otherwise ---- */
  function api() { return global.BPStore && global.BPStore.ops && global.BPStore.ops.planLock; }
  function toast(msg, type) { try { if (global.BPUI && global.BPUI.toast) global.BPUI.toast(msg, { type: type || "ok" }); } catch (e) {} }
  function errText(e, action) { try { if (global.BPUI && global.BPUI.friendlyError) return global.BPUI.friendlyError(e, { action: action }); } catch (x) {} return String((e && e.message) || e || "Something went wrong"); }
  function oldLock(st) { return !!(st && st.locked && !st.removed && st.stage !== "closed"); }
  function closedPlan(st) { return !!(st && st.locked && st.stage === "closed"); }
  // o: { quoteId, onChange(state) }; may = the caller may unlock (the server checks it again)
  function oldBar(host, st, o) {
    if (!host) return; var on = oldLock(st) && st.can_unlock;
    if (!on) { host.hidden = true; clear(host); return; }
    clear(host); host.hidden = false; host.className = "ef-lock is-locked"; host.setAttribute("role", "region"); host.setAttribute("aria-label", "Changes on the event day");
    var b = h("button", { type: "button", cls: "ef-btn dark", id: "efUnlock", text: "Unlock", on: { click: async function () {
      var A = api(); if (!A || b.disabled) return; b.disabled = true; b.setAttribute("aria-busy", "true");
      try {
        var nx = await A.set(o.quoteId, false, "The event-day lock was removed (R257)");
        cache[o.quoteId] = Object.assign({}, cache[o.quoteId] || {}, { lock: nx, at: Date.now(), lat: Date.now() }); oldBar(host, nx, o);
        toast("Unlocked. Tasks and times can be changed."); if (o.onChange) o.onChange(nx);
      } catch (e) { toast(errText(e, "unlock"), "err"); b.disabled = false; b.removeAttribute("aria-busy"); }
    } } });
    host.appendChild(h("div", { cls: "ef-lock-row" }, [h("span", { cls: "ef-lock-txt" }, [h("span", { cls: "ef-lock-sub", text: "This database still refuses task and time changes on the event day (needs database update 0442)." })]), h("span", { cls: "ef-lock-acts" }, [b])]));
  }
  // the run-sheet: { closed } - and the one line above for a database without 0442
  async function planState(host, o) {
    var A = api(), st = null; if (!A || !A.get || !o || !o.quoteId) return { closed: false };
    try { st = await A.get(o.quoteId); } catch (e) { st = null; }
    oldBar(host, st, o); return { closed: closedPlan(st) };
  }
  // the event's state alone, read again (it was closed or re-opened on another page)
  function checkLock(o, force) {
    var qid = o.quoteId, c = cache[qid], A = api();
    if (!A || !A.get || !c || !c.lock || loading[qid] || c.asking || Date.now() - (c.lat || c.at || 0) < (force ? 3000 : 25000)) return;
    c.asking = true;
    A.get(qid).then(function (st) {
      var d = cache[qid]; if (!d) return; d.asking = false; d.lat = Date.now(); if (!st) return;
      var prev = d.lock; d.lock = st; if (sig(prev) === sig(st)) return;
      draw(o); if (o.onChange && !!(prev && prev.locked) !== !!st.locked) o.onChange(st);
    }, function () { var d = cache[qid]; if (d) { d.asking = false; d.lat = Date.now(); } });
  }
  var seen = null;   // the panel of this page, so a return to the page asks again at once
  function back() { if (seen && !(doc && doc.hidden)) checkLock(seen, true); }
  if (doc && doc.addEventListener) doc.addEventListener("visibilitychange", back);
  if (doc && global.addEventListener) { global.addEventListener("focus", back); global.addEventListener("pageshow", function (e) { if (e && e.persisted) back(); }); }

  /* ---- R253: the Layout viewer (floor-view.js + .css), loaded once, only on pages that show a plan ---- */
  var viewerP = null;
  function viewer() {
    if (viewerP) return viewerP;
    viewerP = new Promise(function (ok, no) {
      if (!doc.querySelector('link[href*="floor-view.css"]')) { var lk = doc.createElement("link"); lk.rel = "stylesheet"; lk.href = "/floor-view.css?v=1"; doc.head.appendChild(lk); }
      if (global.HelmFloorView) { ok(); return; }
      var sc = doc.createElement("script"); sc.src = "/floor-view.js?v=3"; sc.onload = function () { ok(); }; sc.onerror = function () { sc.remove(); no(new Error("floor-view")); };
      doc.head.appendChild(sc);
    }).then(function () { return global.HelmFloorView.ready(); }).then(function () { return global.HelmFloorView; });
    viewerP.catch(function () { viewerP = null; });   // a later redraw tries again
    return viewerP;
  }

  /* ---- the Floor plan card on the event-day pages ---- */
  var cache = {}, loading = {};
  function isClosed(qid) { var c = cache[qid]; return !!(c && closedPlan(c.lock)); }
  function sig(v) { try { return JSON.stringify(v); } catch (e) { return String(Math.random()); } }
  // R253: "Edit in the planner" only for a role that may change layouts (the same areas the planner itself asks for)
  var editP = null;
  function mayEdit() {
    var A = global.BPStore && global.BPStore.auth; if (!A || !A.canEditArea) return Promise.resolve(false);
    if (!editP) editP = Promise.resolve(A.canEditArea("layouts")).then(function (y) { return y || A.canEditArea("quotes"); }).then(Boolean, function () { editP = null; return false; });
    return editP;
  }
  function emptyWords(f) {   // one clear line: never "V1 saved" next to "nothing saved"
    if (!f || !f.version_no) return "No layout yet.";
    var d = day(f.saved_at); return "The saved layout (V" + f.version_no + (d ? ", " + d : "") + ") is empty - nothing is placed on it yet.";
  }
  function day(iso) {
    var t = new Date(iso); if (!iso || !isFinite(t.getTime())) return "";
    try { return new Intl.DateTimeFormat("en-IN", { timeZone: tzName(), day: "numeric", month: "short" }).format(t); } catch (e) { return ""; }
  }
  function renderFloor(host, f, o) {
    clear(host); host.hidden = false;
    var closed = (f.lock || {}).stage === "closed", mz = measure(f), qid = o.quoteId;   // a closed event keeps its layout
    var head = h("div", { cls: "ef-head" }, [h("h3", { cls: "tc-h2", id: host.id + "H", text: "Floor plan" }),
      mz.items ? h("span", { cls: "ef-meta", text: [f.version_no ? "V" + f.version_no : "", f.saved_at ? "saved " + when(f.saved_at) : "", mz.items + " items"].filter(Boolean).join(" · ") }) : null]);
    host.appendChild(head);
    if (!mz.items) {   // nothing to view: one message, one action; the pack still prints the run-sheet, call sheet and contacts
      host.appendChild(h("p", { cls: "ef-empty", text: emptyWords(f) }));
      var ea = h("div", { cls: "ef-acts" }, [printLink(qid, true)]); host.appendChild(ea);
      if (!closed) mayEdit().then(function (y) { if (y && ea.isConnected) ea.insertBefore(h("a", { cls: "ef-btn dark", href: plannerUrl(qid), text: "Edit in the planner" }), ea.firstChild); });
      return;
    }
    // R253: only the plan, exactly as the planner draws it, and one Layout button (2D plan, 3D view, Measure, Full screen)
    var sheet = h("div", { cls: "ef-sheet", "aria-busy": "true" }, [h("span", { cls: "ef-wait", text: "Loading the plan…" })]);
    var acts = h("div", { cls: "ef-acts" }, [printLink(qid)]);
    if (!closed && o.canEditPlan) mayEdit().then(function (y) { if (y && acts.isConnected) acts.appendChild(h("a", { cls: "ef-link", href: plannerUrl(qid), text: "Edit in the planner →" })); });
    host.appendChild(sheet);
    if (mz.warnings.length) host.appendChild(h("p", { cls: "ef-warn", role: "note", text: "Check: " + mz.warnings.join("; ") + "." }));
    host.appendChild(acts);
    host.appendChild(h("details", { cls: "ef-more" }, [h("summary", { text: "Sizes and counts" }), h("div", { cls: "ef-body" }, [factsEl(mz), legendEl(f)])]));
    viewer().then(function (FV) {
      if (!sheet.isConnected) return;
      var btn = h("button", { type: "button", cls: "ef-plan", "aria-label": "Open the floor plan in the full window", on: { click: function () { go("2d"); } } });
      function go(k) { FV.open({ floor: f, mode: k === "full" ? "2d" : k, fullscreen: k === "full", eventType: o.eventType || "", returnFocus: k === "btn" ? btn : menu._btn }); }
      function paint() { if (!btn.isConnected && btn.firstChild) return false; clear(btn); btn.appendChild(planSvg(doc, f)); }
      var menu = FV.menuButton({ label: "Layout", cls: "ef-btn dark ef-layout", onPick: go });
      clear(sheet); sheet.removeAttribute("aria-busy"); paint(); sheet.appendChild(btn); head.appendChild(menu);
      if (FV.onRedraw) FV.onRedraw(paint);   // a screen's logo / picture that arrives later
    }, function () {   // the viewer could not be loaded: the plain drawing + the planner's own view-only page
      if (!sheet.isConnected) return; clear(sheet); sheet.removeAttribute("aria-busy"); sheet.appendChild(planSvg(doc, f, { plain: true }));
      ["", "3d", "measure"].reverse().forEach(function (k) { acts.insertBefore(h("a", { cls: "ef-btn", href: viewUrl(qid, k), text: k === "3d" ? "3D view" : k ? "Measure" : "2D plan" }), acts.firstChild); });
    });
  }
  function plannerUrl(qid) { return "builder.html?quote=" + encodeURIComponent(qid); }
  function printLink(qid, quiet) { return h("a", { cls: quiet ? "ef-link" : "ef-btn", href: "eventday-pack.html?quote=" + encodeURIComponent(qid), text: "🖨 Print event-day pack" }); }
  // o: { quoteId, lockHost (the one line for a database without 0442), floorHost, showFloor, onChange(state), compact, canEditPlan, eventType (3D only: which events get flowers) }
  function panel(o) {
    o = o || {}; var qid = o.quoteId, A = api();
    if (!qid || !A || !A.floor) { [o.lockHost, o.floorHost].forEach(function (n) { if (n) n.hidden = true; }); return; }
    seen = o;
    var c = cache[qid];
    if ((!c || !c.floor || Date.now() - (c.fat || 0) > 60000 || o.force) && !loading[qid]) {
      loading[qid] = true;
      A.floor(qid).then(function (f) {
        var prev = c && c.lock; cache[qid] = { floor: f || null, lock: f ? f.lock : null, at: Date.now(), fat: Date.now(), none: !f };
        loading[qid] = false; draw(o);
        if (o.onChange && sig(prev && prev.locked) !== sig(f && f.lock && f.lock.locked)) o.onChange(f ? f.lock : null);
      }, function () { loading[qid] = false; cache[qid] = { floor: null, lock: null, at: Date.now(), fat: Date.now(), none: true }; draw(o); });
    } else checkLock(o, false);
    draw(o);
  }
  function stale(qid) { if (cache[qid]) cache[qid].fat = 0; }   // the stage moved: read again on the next draw
  function draw(o) {
    var c = cache[o.quoteId] || {}, f = c.floor;
    if (o.lockHost) {   // drawn again when the answer or the event changed (the monitor can switch events: the button must act on the one shown)
      var ls = sig([o.quoteId, f ? c.lock : null]); if (o.lockHost._efSig !== ls || o.lockHost._efHid !== o.lockHost.hidden) { o.lockHost._efSig = ls; oldBar(o.lockHost, f ? c.lock : null, o); o.lockHost._efHid = o.lockHost.hidden; }
    }
    if (o.floorHost) {
      if (!f || !o.showFloor) { o.floorHost.hidden = true; o.floorHost._efSig = ""; return; }
      var fs = sig([Object.assign({}, f, { lock: null }), !!o.canEditPlan, c.lock && c.lock.stage]); if (o.floorHost._efSig === fs && !o.floorHost.hidden) return;
      o.floorHost._efSig = fs; renderFloor(o.floorHost, Object.assign({}, f, { lock: c.lock || f.lock }), o);
    }
  }
  function reset(qid) { if (qid) delete cache[qid]; else cache = {}; }

  var API = { normalize: normalize, seatsOf: seatsOf, measure: measure, legend: legend, planSvg: planSvg, legendEl: legendEl, factsEl: factsEl,
    viewUrl: viewUrl, panel: panel, stale: stale, viewer: viewer, emptyWords: emptyWords, oldLock: oldLock, oldBar: oldBar, planState: planState, closedPlan: closedPlan, isClosed: isClosed, reset: reset,
    size: size, len: len, CAT_LABEL: CAT_LABEL, _cache: function () { return cache; } };
  global.HelmEventFloor = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof window !== "undefined" ? window : globalThis);
