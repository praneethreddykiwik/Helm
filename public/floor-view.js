/* floor-view.js - R253 (owner, 25 Nov 2026: "when Layout is clicked it opens like a dropdown with only these options, no headers,
 * nothing; only the map with pinch zoom; and in measure they want the distances very clearly"). The read-only layout viewer.
 *
 *   HelmFloorView.open({ floor, mode, fullscreen, eventType, returnFocus })   the full-window viewer: "2d" | "3d" | "measure"
 *   HelmFloorView.menuButton({ label, cls, current, isFull, onPick })         the "Layout" button + its dropdown (2D plan, 3D view,
 *                                                                             Measure, Full screen) - the same one on the card and in the viewer
 *   pure (tests): ftIn, metres, dist, geo, snap, gapBetween, keyDistances, itemDistances, placeLabels
 *
 * The plan is drawn by the planner's own code (floor-draw.js, generated from builder.js); 3D is the planner's own 3D (floor-3d.js,
 * loaded only when asked for). floor = event_floor_get's answer (0397, BPStore.ops.planLock.floor) - no other call is made, nothing is
 * ever edited or saved, and no photo render exists here. Colours of the chrome: the page's --tc-* tokens. DOM calls only, no HTML strings. */
(function (global) {
  "use strict";
  var doc = global.document, SVGNS = "http://www.w3.org/2000/svg", FT_PER_M = 3.280839895;
  var TIGHT_FT = 4;   // walkways / exits under this are marked "check" (the same 4 ft event-floor.js uses)

  /* ================= pure: units ================= */
  function ftIn(ft) {
    if (!isFinite(ft)) return "";
    var t = Math.round(Math.abs(ft) * 12), f = Math.floor(t / 12), i = t % 12, sign = ft < 0 && t ? "-" : "";
    return sign + (f && i ? f + " ft " + i + " in" : f || !i ? f + " ft" : i + " in");
  }
  function metres(ft) { return isFinite(ft) ? (ft / FT_PER_M).toFixed(2) + " m" : ""; }
  // the studio's unit first, the other one second
  function dist(ft, unit) { return unit === "m" ? { main: metres(ft), alt: ftIn(ft) } : { main: ftIn(ft), alt: metres(ft) }; }
  function both(ft, unit) { var d = dist(ft, unit); return d.main + " (" + d.alt + ")"; }

  /* ================= pure: geometry (feet) ================= */
  // the items the planner draws as a circle (builder.js renderItem); every other item is its rectangle
  var ROUND = {}; "table cocktail planter ottoman floral pillar heater uplight fountain chandelier barstool chocolatefountain floralpillar aislefloral centrepiece balloonbunch diyastand rangoli floralstand urli kalash micstand pyro varmala umbrellas stagelight jyothi"
    .split(" ").forEach(function (t) { ROUND[t] = 1; });
  var OVERHEAD = {}; "chandelier hangingfloral fairylights tent canopy stageroof lighting umbrellas toran lanterns neonsign truss".split(" ").forEach(function (t) { OVERHEAD[t] = 1; });
  var FLOORING = {}; "redcarpet dancefloor lawnfloor walkway rangoli cableramp pathlights parking".split(" ").forEach(function (t) { FLOORING[t] = 1; });
  var ENTRY = {}; "entrancegate floralentrance checkpoint".split(" ").forEach(function (t) { ENTRY[t] = 1; });
  var SEAT1 = { chiavari: 1, barstool: 1, sofa: 1, loveseat: 1, armchair: 1, ottoman: 1, bench: 1, lounge: 1, couplesofa: 1 };
  function isRound(it) { return !!ROUND[it.type] && !(it.properties && it.properties.shape === "square" && (it.type === "table" || it.type === "cocktail")); }
  function isSeats(it) { var p = it.properties || {}; return !!((p.rows && p.cols) || p.seats || SEAT1[it.type]); }
  function isBlock(it) { return it.type === "seatblock" || it.type === "chairrow" || it.type === "bleacher"; }
  function geo(it) {
    var cx = it.x + it.width / 2, cy = it.y + it.height / 2, a = ((+it.rotation || 0) % 360) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), hw = it.width / 2, hh = it.height / 2;
    var P = function (ox, oy) { return { x: cx + ox * c - oy * s, y: cy + ox * s + oy * c }; };
    var g = { it: it, id: it.id, cx: cx, cy: cy, round: isRound(it), r: Math.min(hw, hh), c: [P(-hw, -hh), P(hw, -hh), P(hw, hh), P(-hw, hh)] };
    var xs, ys;
    if (g.round) { xs = [cx - g.r, cx + g.r]; ys = [cy - g.r, cy + g.r]; }
    else { xs = g.c.map(function (p) { return p.x; }); ys = g.c.map(function (p) { return p.y; }); }
    var r2 = function (v) { return Math.round(v * 100) / 100; };
    g.l = r2(Math.min.apply(null, xs)); g.rt = r2(Math.max.apply(null, xs)); g.t = r2(Math.min.apply(null, ys)); g.b = r2(Math.max.apply(null, ys));
    return g;
  }
  function onSeg(p, a, b) { var dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy, t = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0; return { x: a.x + dx * t, y: a.y + dy * t }; }
  function len(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function inside(p, g) {
    if (g.round) return Math.hypot(p.x - g.cx, p.y - g.cy) <= g.r;
    var ok = true; for (var i = 0; i < 4; i++) { var a = g.c[i], b = g.c[(i + 1) % 4]; if ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) < -1e-9) ok = false; }
    return ok;
  }
  function onEdge(p, g) {   // the nearest point of the item's outline
    if (g.round) { var d = Math.hypot(p.x - g.cx, p.y - g.cy) || 1e-9; return { x: g.cx + (p.x - g.cx) / d * g.r, y: g.cy + (p.y - g.cy) / d * g.r }; }
    var best = null, bd = Infinity; for (var i = 0; i < 4; i++) { var q = onSeg(p, g.c[i], g.c[(i + 1) % 4]), k = len(p, q); if (k < bd) { bd = k; best = q; } }
    return best;
  }
  // the shortest line between two items' outlines (0 when they touch or overlap)
  function gapBetween(A, B) {
    if (A.round && B.round) {
      var d = Math.hypot(A.cx - B.cx, A.cy - B.cy), g = Math.max(0, d - A.r - B.r), ux = (B.cx - A.cx) / (d || 1), uy = (B.cy - A.cy) / (d || 1);
      return { ft: g, a: { x: A.cx + ux * A.r, y: A.cy + uy * A.r }, b: { x: B.cx - ux * B.r, y: B.cy - uy * B.r } };
    }
    if (A.round || B.round) {
      var R = A.round ? A : B, Q = A.round ? B : A, c = { x: R.cx, y: R.cy }, e = onEdge(c, Q), dd = len(c, e);
      if (inside(c, Q) || dd <= R.r) return { ft: 0, a: e, b: e };
      var p = { x: R.cx + (e.x - R.cx) / dd * R.r, y: R.cy + (e.y - R.cy) / dd * R.r };
      return A.round ? { ft: dd - R.r, a: p, b: e } : { ft: dd - R.r, a: e, b: p };
    }
    if (inside({ x: A.cx, y: A.cy }, B) || inside({ x: B.cx, y: B.cy }, A)) return { ft: 0, a: A.c[0], b: A.c[0] };
    var best = { ft: Infinity, a: null, b: null }, i, j, q, k;
    for (i = 0; i < 4; i++) for (j = 0; j < 4; j++) {
      if (cross(A.c[i], A.c[(i + 1) % 4], B.c[j], B.c[(j + 1) % 4])) return { ft: 0, a: A.c[i], b: A.c[i] };
      q = onSeg(A.c[i], B.c[j], B.c[(j + 1) % 4]); k = len(A.c[i], q); if (k < best.ft - 1e-9) best = { ft: k, a: A.c[i], b: q };
      q = onSeg(B.c[j], A.c[i], A.c[(i + 1) % 4]); k = len(B.c[j], q); if (k < best.ft - 1e-9) best = { ft: k, a: q, b: B.c[j] };
    }
    return best;
  }
  function cross(a, b, c, d) { var o = function (p, q, r) { return (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x); }; return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0; }

  // the point a tap means: corners, edge middles and centres first, then edges, then the hall's walls, then the bare floor
  function snap(p, geos, world, tol) {
    var best = null, score = Infinity, pt = null, ps = Infinity;
    function tryPt(q, kind, name, w) {
      var d = len(p, q); if (d > tol) return; var sc = d * w;
      if (w < 1) { if (d <= tol * 0.55 && sc < ps) { ps = sc; pt = { x: q.x, y: q.y, kind: kind, name: name, snapped: true }; } return; }
      if (sc < score) { score = sc; best = { x: q.x, y: q.y, kind: kind, name: name, snapped: true }; }
    }
    var W = world.w, H = world.h;
    geos.forEach(function (g) {
      if (p.x < g.l - tol || p.x > g.rt + tol || p.y < g.t - tol || p.y > g.b + tol) return;
      var nm = g.it.label || g.it.type;
      tryPt({ x: g.cx, y: g.cy }, "centre", nm, 0.6);
      if (g.round) [[0, -1], [1, 0], [0, 1], [-1, 0]].forEach(function (v) { tryPt({ x: g.cx + v[0] * g.r, y: g.cy + v[1] * g.r }, "edge", nm, 0.65); });
      else g.c.forEach(function (q, i) { tryPt(q, "corner", nm, 0.5); var n = g.c[(i + 1) % 4]; tryPt({ x: (q.x + n.x) / 2, y: (q.y + n.y) / 2 }, "middle of the side", nm, 0.65); });
      tryPt(onEdge(p, g), "edge", nm, 1);
    });
    [[0, 0], [W, 0], [W, H], [0, H]].forEach(function (c) { tryPt({ x: c[0], y: c[1] }, "corner", "Hall", 0.5); });
    [[{ x: 0, y: p.y }, "Left wall"], [{ x: W, y: p.y }, "Right wall"], [{ x: p.x, y: 0 }, "Top wall"], [{ x: p.x, y: H }, "Bottom wall"]].forEach(function (w) {
      var q = { x: Math.max(0, Math.min(W, w[0].x)), y: Math.max(0, Math.min(H, w[0].y)) }; tryPt(q, "wall", w[1], 1.05);
    });
    if (pt) return pt;   // a corner / middle / centre close by is what was meant, even when the edge itself is closer
    if (best) return best;
    return { x: Math.max(0, Math.min(W, p.x)), y: Math.max(0, Math.min(H, p.y)), kind: "floor", name: "Floor", snapped: false };
  }
  function snapWords(s) { return s.kind === "floor" ? "a point on the floor" : s.kind === "wall" ? s.name.toLowerCase() : s.kind + " of " + s.name; }

  var EPS = 0.1;
  function yOv(a, b) { return a.t < b.b - EPS && b.t < a.b - EPS; }
  function xOv(a, b) { return a.l < b.rt - EPS && b.l < a.rt - EPS; }
  // one item: its size, the distance to the 4 walls and to the nearest item on each side (the planner's Measure rule)
  function itemDistances(g, geos, world) {
    var out = { walls: [], near: [] }, W = world.w, H = world.h, o = { L: null, R: null, U: null, D: null };
    out.walls = [
      { side: "left", label: "Left wall", ft: g.l, a: { x: 0, y: g.cy }, b: { x: g.l, y: g.cy } },
      { side: "right", label: "Right wall", ft: W - g.rt, a: { x: g.rt, y: g.cy }, b: { x: W, y: g.cy } },
      { side: "top", label: "Top wall", ft: g.t, a: { x: g.cx, y: 0 }, b: { x: g.cx, y: g.t } },
      { side: "bottom", label: "Bottom wall", ft: H - g.b, a: { x: g.cx, y: g.b }, b: { x: g.cx, y: H } }
    ].map(function (w) { w.ft = Math.max(0, Math.round(w.ft * 100) / 100); return w; });
    function take(k, gap, b) { if (gap > EPS && (!o[k] || gap < o[k].ft)) o[k] = { ft: gap, g: b }; }
    geos.forEach(function (b) {
      if (b === g || b.id === g.id) return;
      if (yOv(g, b)) { take("L", g.l - b.rt, b); take("R", b.l - g.rt, b); }
      if (xOv(g, b)) { take("U", g.t - b.b, b); take("D", b.t - g.b, b); }
    });
    ["L", "R", "U", "D"].forEach(function (k) {
      var n = o[k]; if (!n) return; var b = n.g, v = k === "L" || k === "R", m = v ? (Math.max(g.t, b.t) + Math.min(g.b, b.b)) / 2 : (Math.max(g.l, b.l) + Math.min(g.rt, b.rt)) / 2;
      var A = k === "L" ? { x: b.rt, y: m } : k === "R" ? { x: g.rt, y: m } : k === "U" ? { x: m, y: b.b } : { x: m, y: g.b };
      var B = k === "L" ? { x: g.l, y: m } : k === "R" ? { x: b.l, y: m } : k === "U" ? { x: m, y: g.t } : { x: m, y: b.t };
      out.near.push({ side: { L: "left", R: "right", U: "above", D: "below" }[k], label: b.it.label || b.it.type, ft: Math.round(n.ft * 100) / 100, a: A, b: B, id: b.id });
    });
    return out;
  }

  // the distances a crew asks for, with the line to draw; only the ones this plan can answer
  function keyDistances(plan) {
    var W = plan.world.w, H = plan.world.h, gs = plan.items.map(geo), out = [], m = plan.margins || {};
    function add(key, label, ft, a, b, o) { if (!isFinite(ft)) return; o = o || {}; out.push({ key: key, label: label, ft: Math.round(ft * 100) / 100, a: a, b: b, warn: !!(o.walk && ft < TIGHT_FT), note: o.note || "" }); }
    function nm(g, fallback) { return g.it.label || fallback || g.it.type; }
    add("hall-w", "Hall, left to right", W, { x: 0, y: H }, { x: W, y: H });
    add("hall-h", "Hall, top to bottom", H, { x: W, y: 0 }, { x: W, y: H });
    if (m.left || m.right || m.top || m.bottom) {
      add("use-w", "Usable area, left to right", W - (m.left || 0) - (m.right || 0), { x: m.left || 0, y: H - (m.bottom || 0) }, { x: W - (m.right || 0), y: H - (m.bottom || 0) });
      add("use-h", "Usable area, top to bottom", H - (m.top || 0) - (m.bottom || 0), { x: W - (m.right || 0), y: m.top || 0 }, { x: W - (m.right || 0), y: H - (m.bottom || 0) });
    }
    var stages = gs.filter(function (g) { return g.it.type === "stage" || g.it.type === "mandap"; }), seats = gs.filter(function (g) { return isSeats(g.it); });
    var mains = stages.filter(function (g) { return !stages.some(function (s) { return s !== g && inside({ x: g.cx, y: g.cy }, s) && s.it.width * s.it.height > g.it.width * g.it.height; }); });   // a mandap on the stage = the stage
    function facing(g, list, k) {   // the nearest of list on one side of g
      var best = null; list.forEach(function (c) {
        if (c === g) return; var gap = k === "D" ? c.t - g.b : k === "U" ? g.t - c.b : k === "R" ? c.l - g.rt : g.l - c.rt;
        if (gap < -1e-6 || !(k === "D" || k === "U" ? xOv(g, c) : yOv(g, c))) return;
        if (!best || gap < best.ft) best = { ft: gap, g: c, k: k };
      }); return best;
    }
    function line(g, f) {
      var v = f.k === "U" || f.k === "D", q = f.g, mid = v ? (Math.max(g.l, q.l) + Math.min(g.rt, q.rt)) / 2 : (Math.max(g.t, q.t) + Math.min(g.b, q.b)) / 2;
      return f.k === "D" ? [{ x: mid, y: g.b }, { x: mid, y: q.t }] : f.k === "U" ? [{ x: mid, y: q.b }, { x: mid, y: g.t }] : f.k === "R" ? [{ x: g.rt, y: mid }, { x: q.l, y: mid }] : [{ x: q.rt, y: mid }, { x: g.l, y: mid }];
    }
    function nearest(g, list) { var f = facing(g, list, "D"); if (f) return f; return ["U", "L", "R"].map(function (k) { return facing(g, list, k); }).filter(Boolean).sort(function (x, y) { return x.ft - y.ft; })[0] || null; }
    mains.forEach(function (st, i) {
      var f = nearest(st, seats); if (f) { var L = line(st, f); add("stage-row-" + i, nm(st, "Stage") + " to the first seats", f.ft, L[0], L[1]); }
      var d = nearest(st, gs.filter(function (g) { return g.it.type === "dancefloor"; })); if (d) { var D = line(st, d); add("stage-dance-" + i, nm(st, "Stage") + " to the dance floor", d.ft, D[0], D[1]); }
      [["left", st.l, { x: 0, y: st.cy }, { x: st.l, y: st.cy }], ["right", W - st.rt, { x: st.rt, y: st.cy }, { x: W, y: st.cy }], ["top", st.t, { x: st.cx, y: 0 }, { x: st.cx, y: st.t }]].forEach(function (w) {
        if (w[1] > EPS) add("stage-" + w[0] + "-" + i, nm(st, "Stage") + " to the " + w[0] + " wall", w[1], w[2], w[3]); });
    });
    gs.filter(function (g) { return g.it.type === "dancefloor"; }).forEach(function (d, i) { var f = nearest(d, seats); if (f) { var L = line(d, f); add("dance-seats-" + i, nm(d, "Dance floor") + " to the nearest seats", f.ft, L[0], L[1]); } });
    gs.filter(function (g) { return g.it.type === "redcarpet"; }).forEach(function (g, i) {
      var w = g.rt - g.l, h = g.b - g.t, v = w <= h, mid = v ? g.cy : g.cx;
      add("aisle-" + i, "Aisle width (" + nm(g, "carpet") + ")", Math.min(w, h), v ? { x: g.l, y: mid } : { x: mid, y: g.t }, v ? { x: g.rt, y: mid } : { x: mid, y: g.b }, { walk: true });
    });
    // walkways between seating blocks that sit side by side / one behind the other (nothing else between them is checked)
    var blocks = gs.filter(function (g) { return isBlock(g.it); }), walks = [];
    blocks.forEach(function (A) { blocks.forEach(function (B) {
      if (A === B) return;
      var g = B.l - A.rt, ov = Math.min(A.b, B.b) - Math.max(A.t, B.t), y = (Math.max(A.t, B.t) + Math.min(A.b, B.b)) / 2;
      if (g > 0.5 && g < 60 && ov >= Math.min(A.b - A.t, B.b - B.t) * 0.3 && !between(A, B, blocks, "x")) walks.push(["Walkway, " + nm(A) + " to " + nm(B), g, { x: A.rt, y: y }, { x: B.l, y: y }]);
      var q = B.t - A.b, ox = Math.min(A.rt, B.rt) - Math.max(A.l, B.l), x = (Math.max(A.l, B.l) + Math.min(A.rt, B.rt)) / 2;
      if (q > 0.5 && q < 60 && ox >= Math.min(A.rt - A.l, B.rt - B.l) * 0.3 && !between(A, B, blocks, "y")) walks.push(["Cross aisle, " + nm(A) + " to " + nm(B), q, { x: x, y: A.b }, { x: x, y: B.t }]);
    }); });
    walks.sort(function (a, b) { return a[1] - b[1]; }).slice(0, 8).forEach(function (w, i) { add("walk-" + i, w[0], w[1], w[2], w[3], { walk: true }); });
    // the tightest pair of tables (edge to edge - chairs are not counted)
    var tb = gs.filter(function (g) { return /^(table|longtable|headtable|recttable|cocktail)$/.test(g.it.type); }), bt = null;
    for (var i = 0; i < tb.length; i++) for (var j = i + 1; j < tb.length; j++) {
      var A = tb[i], B = tb[j], rough = Math.max(B.l - A.rt, A.l - B.rt, B.t - A.b, A.t - B.b, 0);
      if (bt && rough >= bt.g.ft) continue; var gp = gapBetween(A, B); if (gp.ft > EPS && (!bt || gp.ft < bt.g.ft)) bt = { g: gp, A: A, B: B };
    }
    if (bt) add("tables", "Closest tables, " + nm(bt.A) + " and " + nm(bt.B), bt.g.ft, bt.g.a, bt.g.b, { note: "table edge to table edge, chairs not counted" });
    // side aisles: the outermost seats to the walls
    if (seats.length) {
      var mn = function (f) { return seats.reduce(function (p, c) { return f(c) < f(p) ? c : p; }); };
      var sl = mn(function (g) { return g.l; }), sr = mn(function (g) { return -g.rt; });
      add("side-l", "Seats to the left wall", sl.l, { x: 0, y: sl.cy }, { x: sl.l, y: sl.cy }, { walk: true });
      add("side-r", "Seats to the right wall", W - sr.rt, { x: sr.rt, y: sr.cy }, { x: W, y: sr.cy }, { walk: true });
    }
    gs.filter(function (g) { return g.it.type === "exit" || ENTRY[g.it.type]; }).forEach(function (e, n) {
      var best = null; gs.forEach(function (o) { if (o === e || o.it.type === "exit" || ENTRY[o.it.type] || FLOORING[o.it.type] || OVERHEAD[o.it.type] || /arch$/.test(o.it.type)) return; var g = gapBetween(e, o); if (!best || g.ft < best.g.ft) best = { g: g, o: o }; });
      if (best) add("exit-" + n, nm(e, "Exit") + " clear to " + nm(best.o), best.g.ft, best.g.a, best.g.b, { walk: true, note: best.g.ft < 0.05 ? "touching" : "" });
    });
    return out;
  }
  function between(A, B, list, axis) {   // another block sits between these two
    return list.some(function (C) { if (C === A || C === B) return false;
      return axis === "x" ? C.l >= A.rt - EPS && C.rt <= B.l + EPS && yOv(A, C) && yOv(B, C) : C.t >= A.b - EPS && C.b <= B.t + EPS && xOv(A, C) && xOv(B, C); });
  }

  // labels never cover each other: each tries several places along and beside its line. labels: [{ ax, ay, bx, by, w, h }] (screen px)
  function placeLabels(labels, box, taken) {
    var used = (taken || []).slice();
    function hit(r) { return used.some(function (u) { return r.x < u.x + u.w + 3 && u.x < r.x + r.w + 3 && r.y < u.y + u.h + 3 && u.y < r.y + r.h + 3; }); }
    function off(r) { return box && (r.x < box.x || r.y < box.y || r.x + r.w > box.x + box.w || r.y + r.h > box.y + box.h); }
    return labels.map(function (L) {
      var dx = L.bx - L.ax, dy = L.by - L.ay, d = Math.hypot(dx, dy) || 1, nx = -dy / d, ny = dx / d, spots = [], along = [0.5, 0.35, 0.65, 0.2, 0.8];
      var ext = Math.abs(nx) * L.w / 2 + Math.abs(ny) * L.h / 2, run = Math.abs(dx / d) * L.w + Math.abs(dy / d) * L.h, fits = d > run + 14;
      if (fits) along.forEach(function (t) { spots.push([t, 0]); });
      [1, -1, 2, -2, 3, -3].forEach(function (k) { along.slice(0, 3).forEach(function (t) { spots.push([t, Math.sign(k) * (ext + 10 + (Math.abs(k) - 1) * (L.h + 8))]); }); });
      var best = null, i, r;
      function tryAt(x, y, side) { r = { x: x - L.w / 2, y: y - L.h / 2, w: L.w, h: L.h }; if (hit(r) || off(r)) return false; best = { x: x, y: y, off: side, r: r }; return true; }
      for (i = 0; i < spots.length && !best; i++) tryAt(L.ax + dx * spots[i][0] + nx * spots[i][1], L.ay + dy * spots[i][0] + ny * spots[i][1], Math.abs(spots[i][1]) > 0.5);
      // crowded: the nearest free place around the middle of the line (joined to it by a thin line)
      var mx = (L.ax + L.bx) / 2, my = (L.ay + L.by) / 2;
      for (var R = 30; R <= 420 && !best; R += 15) for (i = 0; i < 24 && !best; i++) tryAt(mx + Math.cos(i * Math.PI / 12) * R, my + Math.sin(i * Math.PI / 12) * R * 0.8, true);
      if (!best) return null;   // no room at all at this zoom: it is in the Distances list, and zooming in shows it
      used.push(best.r); return best;
    });
  }

  // the part of a line that is on screen (a wall can be outside the window when zoomed in), or null
  function clipLine(a, b, box) {
    var t0 = 0, t1 = 1, dx = b.x - a.x, dy = b.y - a.y, p = [-dx, dx, -dy, dy], q = [a.x - box.x, box.x + box.w - a.x, a.y - box.y, box.y + box.h - a.y];
    for (var i = 0; i < 4; i++) { if (Math.abs(p[i]) < 1e-9) { if (q[i] < 0) return null; continue; } var t = q[i] / p[i]; if (p[i] < 0) { if (t > t1) return null; if (t > t0) t0 = t; } else { if (t < t0) return null; if (t < t1) t1 = t; } }
    return [{ x: a.x + dx * t0, y: a.y + dy * t0 }, { x: a.x + dx * t1, y: a.y + dy * t1 }];
  }

  var PURE = { ftIn: ftIn, metres: metres, dist: dist, geo: geo, snap: snap, snapWords: snapWords, gapBetween: gapBetween, keyDistances: keyDistances, itemDistances: itemDistances, placeLabels: placeLabels, clipLine: clipLine, isRound: isRound, TIGHT_FT: TIGHT_FT };
  if (typeof module !== "undefined" && module.exports) module.exports = PURE;
  if (!doc) return;

  /* ================= DOM ================= */
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
  function s(tag, attrs, kids) { var n = doc.createElementNS(SVGNS, tag); Object.keys(attrs || {}).forEach(function (k) { if (attrs[k] != null) n.setAttribute(k, String(attrs[k])); }); (kids || []).forEach(function (c) { if (c) n.appendChild(c); }); return n; }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); return n; }
  function icon(d) { return s("svg", { viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false", class: "fv-ico" }, [s("path", { d: d })]); }
  var ICON = { "2d": "M4 4h16v16H4zM4 10h16M10 10v10", "3d": "M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5", measure: "M3 15L15 3l6 6L9 21zM7 11l2 2M10 8l3 3M13 5l2 2",
    full: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5", down: "M6 9l6 6 6-6", close: "M6 6l12 12M18 6L6 18", plus: "M12 5v14M5 12h14", minus: "M5 12h14", fit: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5M9 12h6", list: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" };
  var MODES = [["2d", "2D plan"], ["3d", "3D view"], ["measure", "Measure"]];
  function reduced() { try { return global.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; } }
  function fsEl() { return doc.fullscreenElement || doc.webkitFullscreenElement || null; }

  /* the "Layout" button + dropdown. o: { label, cls, current(), isFull(), onPick(mode | "full") } */
  function menuButton(o) {
    var id = "fvm" + Math.random().toString(36).slice(2, 8), open = false, pop = null;
    var btn = h("button", { type: "button", cls: o.cls || "", "aria-haspopup": "menu", "aria-expanded": "false", "aria-controls": id }, [h("span", { cls: "fv-mlabel", text: o.label }), icon(ICON.down)]);
    var wrap = h("span", { cls: "fv-menuwrap" }, [btn]);
    function items() { return [].slice.call(pop.querySelectorAll("[role^=menuitem]")); }
    function close(back) { if (!open) return; open = false; btn.setAttribute("aria-expanded", "false"); if (pop) { pop.remove(); pop = null; } doc.removeEventListener("pointerdown", away, true); if (back) btn.focus(); }
    function away(e) { if (!wrap.contains(e.target)) close(false); }
    function pick(k) { close(true); o.onPick(k); }
    function show(last) {
      if (open) return; open = true; btn.setAttribute("aria-expanded", "true");
      var cur = o.current ? o.current() : "", full = o.isFull ? o.isFull() : false;
      pop = h("div", { cls: "fv-menu", id: id, role: "menu", "aria-label": "Layout" });
      MODES.forEach(function (m) { pop.appendChild(h("button", { type: "button", role: cur ? "menuitemradio" : "menuitem", "aria-checked": cur ? String(cur === m[0]) : null, cls: cur === m[0] ? "on" : "", "data-k": m[0], tabindex: "-1", on: { click: function () { pick(m[0]); } } }, [icon(ICON[m[0]]), h("span", { text: m[1] })])); });
      pop.appendChild(h("button", { type: "button", role: "menuitem", "data-k": "full", tabindex: "-1", on: { click: function () { pick("full"); } } }, [icon(ICON.full), h("span", { text: full ? "Exit full screen" : "Full screen" })]));
      pop.addEventListener("keydown", function (e) {
        var L = items(), i = L.indexOf(doc.activeElement), k = e.key;
        if (k === "ArrowDown" || k === "ArrowUp") { e.preventDefault(); L[(i + (k === "ArrowDown" ? 1 : L.length - 1)) % L.length].focus(); }
        else if (k === "Home") { e.preventDefault(); L[0].focus(); } else if (k === "End") { e.preventDefault(); L[L.length - 1].focus(); }
        else if (k === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); } else if (k === "Tab") close(false);
      });
      wrap.appendChild(pop);
      var r = pop.getBoundingClientRect(); if (r.right > global.innerWidth - 8) pop.classList.add("right"); if (r.bottom > global.innerHeight - 8 && r.top > r.height + 60) pop.classList.add("up");
      var L = items(), on = L.filter(function (x) { return x.classList.contains("on"); })[0]; (last ? L[L.length - 1] : on || L[0]).focus();
      doc.addEventListener("pointerdown", away, true);
    }
    btn.addEventListener("click", function () { open ? close(false) : show(); });
    btn.addEventListener("keydown", function (e) { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); show(e.key === "ArrowUp"); } });
    wrap._close = close; wrap._open = function () { return open; }; wrap._btn = btn;
    return wrap;
  }

  /* ---- lazy scripts (same origin, once) ---- */
  var loaded = {};
  function load(src, has) {
    if (has && has()) return Promise.resolve();
    if (!loaded[src]) loaded[src] = new Promise(function (ok, no) {
      var sc = doc.createElement("script"); sc.src = src; sc.async = false; sc.onload = function () { ok(); }; sc.onerror = function () { delete loaded[src]; sc.remove(); no(new Error("load " + src)); };
      doc.head.appendChild(sc);
    });
    return loaded[src];
  }
  function load2D() {
    return Promise.all([load("/builder-tools.js?v=7", function () { return !!global.HelmBuilderTools; }), load("/stage-screen.js?v=6", function () { return !!global.HelmScreen; }), load("/floor-draw.js?v=2", function () { return !!global.HelmFloorDraw; })]).then(wireScreens);
  }
  function load3D() {
    return Promise.all([load2D(), load("/capture-frame.js?v=15", function () { return !!global.HelmCaptureFrame; }), load("/dancers-3d.js?v=1", function () { return !!global.HelmDancers; }), load("/floor-3d.js?v=3", function () { return !!global.HelmFloor3D; })]);
  }
  // logo / picture references on stage screens -> short-lived signed links (the planner's rule); without one the brand letter shows
  var wired = false, redraw = [];
  function wireScreens() {
    var S = global.HelmScreen, B = global.BPStore; if (wired || !S || !S.setLogoResolver) return; wired = true;
    S.setLogoResolver(function (ref) {
      if (ref === "studio") return Promise.resolve(B && B.org && B.org.identity ? B.org.identity() : null).then(function (id) {
        var u = id && id.logo, o = ""; try { o = new URL(String((global.SUPABASE_CONFIG || {}).url || "")).origin; } catch (e) { return ""; }
        try { return typeof u === "string" && /^https:\/\//i.test(u) && new URL(u).origin === o ? u : ""; } catch (e) { return ""; } });
      if (!(B && B.sites && B.sites.mediaUrls)) return Promise.resolve("");
      return Promise.resolve(B.sites.mediaUrls(["/storage/v1/object/public/invite-media/" + ref], 3600)).then(function (r) { var u = Array.isArray(r) ? r[0] : ""; return /^https:\/\//i.test(String(u || "")) ? u : ""; });
    });
    if (S.onLogoChange) S.onLogoChange(function () { redraw = redraw.filter(function (f) { try { return f() !== false; } catch (e) { return false; } }); });
  }

  /* ================= the viewer ================= */
  var cur = null;
  function open(o) {
    o = o || {}; if (cur) cur.close(true);
    var V = { mode: "", plan: null, geos: [], k: 1, tx: 0, ty: 0, fitK: 1, touched: false, fake: false, dead: false, loading: 0 };
    var back = o.returnFocus || doc.activeElement;
    var root = h("div", { cls: "fv", role: "dialog", "aria-modal": "true", "aria-label": "Floor plan viewer", tabindex: "-1" });
    var stage = h("div", { cls: "fv-stage" }), layer = h("div", { cls: "fv-layer" }), over = s("svg", { class: "fv-over", "aria-hidden": "true" });
    var t3 = h("div", { cls: "fv-3d", hidden: true }), msg = h("div", { cls: "fv-msg", role: "status", hidden: true }), live = h("div", { cls: "fv-sr", "aria-live": "polite" });
    var loupe = h("div", { cls: "fv-loupe", hidden: true, "aria-hidden": "true" });
    stage.appendChild(layer); stage.appendChild(over); stage.appendChild(loupe);
    var menu = menuButton({ label: "Layout", cls: "fv-btn fv-menu-btn", current: function () { return V.mode; }, isFull: isFull, onPick: function (k) { if (k === "full") toggleFull(); else setMode(k); } });
    var closeB = h("button", { type: "button", cls: "fv-btn fv-icon", "aria-label": "Close the floor plan", title: "Close", on: { click: function () { close(); } } }, [icon(ICON.close)]);
    var chip = h("div", { cls: "fv-chip" }, [menu, closeB]);
    function zb(d, label, f) { return h("button", { type: "button", cls: "fv-btn fv-icon", "aria-label": label, title: label, on: { click: f } }, [icon(d)]); }
    var zoomBox = h("div", { cls: "fv-zoom", role: "group", "aria-label": "Zoom" }, [zb(ICON.plus, "Zoom in", function () { zoomStep(1.5); }), zb(ICON.minus, "Zoom out", function () { zoomStep(1 / 1.5); }), zb(ICON.fit, "Fit the whole plan", function () { fitAll(); })]);
    var presets = h("div", { cls: "fv-presets", role: "group", "aria-label": "3D views", hidden: true });
    var mbar = h("div", { cls: "fv-mbar", role: "group", "aria-label": "Measure", hidden: true }), panel = h("div", { cls: "fv-list", role: "region", "aria-label": "Distances", hidden: true });
    [stage, t3, msg, chip, zoomBox, presets, mbar, panel, live].forEach(function (n) { root.appendChild(n); });
    var shell = h("div", { cls: "tc-layer" }, [root]);   // the page's theme tokens (ops-board.css) reach the viewer
    doc.body.appendChild(shell);
    // the page behind: not scrollable, not reachable
    var inerted = [].slice.call(doc.body.children).filter(function (n) { return n !== shell && !n.inert && !/^(SCRIPT|STYLE|LINK)$/.test(n.tagName); });
    inerted.forEach(function (n) { n.inert = true; });
    doc.documentElement.classList.add("fv-open");
    root.focus({ preventScroll: true });
    if (o.fullscreen) toggleFull(true);

    function say(t) { live.textContent = ""; if (t) global.setTimeout(function () { if (!V.dead) live.textContent = t; }, 30); }
    function note(text, kids) { clear(msg); if (!text) { msg.hidden = true; return; } msg.hidden = false; msg.appendChild(h("p", { text: text })); (kids || []).forEach(function (k) { msg.appendChild(k); }); }
    function size() { return { w: stage.clientWidth || root.clientWidth || 1, h: stage.clientHeight || root.clientHeight || 1 }; }

    /* ---- full screen (with a fallback where there is none, e.g. iPhone Safari) ---- */
    function isFull() { return !!fsEl() || V.fake; }
    function setFake(on) { V.fake = on; root.classList.toggle("fv-fake", on); if (on) say("Full window. This browser has no full screen for pages."); }
    function toggleFull(force) {
      if (isFull() && !force) { if (V.fake) setFake(false); else { var x = doc.exitFullscreen || doc.webkitExitFullscreen; if (x) try { var pr = x.call(doc); if (pr && pr.catch) pr.catch(function () {}); } catch (e) {} } return; }
      var f = root.requestFullscreen || root.webkitRequestFullscreen;
      if (!f) { setFake(true); return; }
      try { var p = f.call(root, { navigationUI: "hide" }); if (p && p.catch) p.catch(function () { if (!V.dead) setFake(true); }); } catch (e) { setFake(true); }
    }
    function onFs() { if (!V.dead && !fsEl()) root.focus({ preventScroll: true }); }

    /* ---- the plan ---- */
    var planSvg = null, PX = 12, planNode = null;
    function drawPlan() {
      var D = global.HelmFloorDraw; PX = D.PX;
      var sv = D.svg(V.plan); sv.setAttribute("aria-hidden", "true"); sv.setAttribute("preserveAspectRatio", "none");
      sv.querySelectorAll(".margins rect").forEach(function (r) { r.setAttribute("vector-effect", "non-scaling-stroke"); });
      planNode = s("g", { id: "fvPlan" }); while (sv.firstChild) planNode.appendChild(sv.firstChild); sv.appendChild(planNode);
      clear(layer); layer.appendChild(sv); planSvg = sv; commitView();
    }
    function start(floor) {
      V.plan = global.HelmFloorDraw.prepare(floor); V.geos = V.plan.items.map(geo); V.unit = V.plan.unit;
      stage.setAttribute("role", "img"); stage.setAttribute("aria-label", "Floor plan, hall " + both(V.plan.world.w, V.unit) + " by " + both(V.plan.world.h, V.unit) + ", " + V.plan.items.length + " items");
      drawPlan(); fitAll(true);
    }
    /* view: plan px * k + t = screen px. During a gesture the layer is only transformed (smooth); then the plan is redrawn sharp. */
    var base = { k: 1, tx: 0, ty: 0 }, commitT = 0, raf = 0;
    function commitView() {
      commitT = 0; if (!planSvg || V.dead) return; var z = size();
      base = { k: V.k, tx: V.tx, ty: V.ty };
      planSvg.setAttribute("viewBox", (-V.tx / V.k) + " " + (-V.ty / V.k) + " " + (z.w / V.k) + " " + (z.h / V.k)); planSvg.setAttribute("width", z.w); planSvg.setAttribute("height", z.h);
      layer.style.transform = ""; layer.classList.remove("moving");
    }
    function paint() {
      raf = 0; if (V.dead) return; var r = V.k / base.k;
      layer.classList.add("moving"); layer.style.transform = "translate(" + (V.tx - base.tx * r) + "px," + (V.ty - base.ty * r) + "px) scale(" + r + ")";
      drawOver(); global.clearTimeout(commitT); commitT = global.setTimeout(commitView, 130);
    }
    function moved() { if (!raf) raf = global.requestAnimationFrame(paint); }
    function kLimits() { return { lo: V.fitK * 0.6, hi: Math.max(V.fitK * 10, 7) }; }
    function clampView() {   // some of the plan always stays on screen
      var z = size(), W = V.plan.world.w * PX * V.k, H = V.plan.world.h * PX * V.k, m = 80;
      V.tx = Math.max(m - W, Math.min(z.w - m, V.tx)); V.ty = Math.max(m - H, Math.min(z.h - m, V.ty));
    }
    function zoomAt(f, x, y) { var L = kLimits(), k = Math.max(L.lo, Math.min(L.hi, V.k * f)), r = k / V.k; V.tx = x - (x - V.tx) * r; V.ty = y - (y - V.ty) * r; V.k = k; V.touched = true; clampView(); moved(); }
    function zoomStep(f) { if (V.mode === "3d") { three.zoom(1 / f); return; } var z = size(); zoomAt(f, z.w / 2, z.h / 2); }
    function pad() { var z = size(), small = Math.min(z.w, z.h) < 520; return { x: small ? 14 : 40, t: 68, b: V.mode === "measure" ? (z.w > z.h && z.h < 520 ? 80 : 116) : small ? 18 : 40 }; }
    // the part of the window the plan may use: not under the chip, the Measure bar or an open Distances list
    function fitRect(x0, y0, x1, y1, quiet) {
      var z = size(), p = pad(), land = z.w > z.h && z.h < 520, L = land ? 76 : p.x, R = L, T = land ? 14 : p.t, B = p.b;
      if (!panel.hidden) { var r = panel.getBoundingClientRect(), sr = stage.getBoundingClientRect(); if (r.width < z.w * 0.7) L = Math.max(L, r.right - sr.left + 14); else B = Math.max(B, z.h - (r.top - sr.top) + 12); }
      var aw = Math.max(60, z.w - L - R), ah = Math.max(60, z.h - T - B), w = Math.max(1, x1 - x0) * PX, hh = Math.max(1, y1 - y0) * PX;
      V.k = Math.max(0.02, Math.min(aw / w, ah / hh)); V.tx = L + (aw - w * V.k) / 2 - x0 * PX * V.k; V.ty = T + (ah - hh * V.k) / 2 - y0 * PX * V.k;
      if (quiet) { commitView(); drawOver(); } else moved();
    }
    function fitAll(quiet) { if (V.mode === "3d" && !quiet) { three.fit(); return; } if (!V.plan) return; V.touched = false; fitRect(0, 0, V.plan.world.w, V.plan.world.h, quiet === true); V.fitK = V.k; }
    function toFt(x, y) { return { x: (x - V.tx) / V.k / PX, y: (y - V.ty) / V.k / PX }; }
    function toPx(p) { return { x: p.x * PX * V.k + V.tx, y: p.y * PX * V.k + V.ty }; }

    /* ---- touch, mouse, wheel, keys on the plan ---- */
    var ptr = {}, gest = null, lastTap = null, hold = 0;
    function xy(e) { var r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    function ids() { return Object.keys(ptr); }
    function startPinch() { var a = ptr[ids()[0]], b = ptr[ids()[1]]; gest = { t: "pinch", d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }; }
    function onDown(e) {
      if (V.mode === "3d" || !V.plan || (e.button && e.button !== 1)) return;
      var p = xy(e); try { stage.setPointerCapture(e.pointerId); } catch (x) {}
      ptr[e.pointerId] = { x: p.x, y: p.y, sx: p.x, sy: p.y, at: Date.now(), type: e.pointerType };
      global.clearTimeout(hold);
      if (ids().length === 2) { endLoupe(); M.cancelDrag(); startPinch(); return; }
      if (ids().length > 2) return;
      if (V.mode === "measure" && e.button !== 1) {
        var hd = M.handleAt(p, e.pointerType !== "mouse"); if (hd) { gest = { t: "grip", hd: hd }; return; }   // moving it adjusts the end; a plain tap is a new point
        if (M.sub === "pts" && e.pointerType !== "mouse") hold = global.setTimeout(function () { if (ids().length === 1 && gest && gest.t === "tap") { gest = { t: "place" }; var q = ptr[e.pointerId]; M.aim(q, "touch", true); try { if (global.navigator.vibrate && !reduced()) global.navigator.vibrate(8); } catch (x) {} } }, 220);
      }
      gest = { t: "tap" };
    }
    function onMove(e) {
      if (V.mode === "3d" || !V.plan) return;
      var q = ptr[e.pointerId], p = xy(e);
      if (!q) { if (V.mode === "measure" && e.pointerType === "mouse") M.aim(p, "mouse", false); return; }
      if (gest && gest.t === "pinch" && ids().length >= 2) {
        q.x = p.x; q.y = p.y; var a = ptr[ids()[0]], b = ptr[ids()[1]], d = Math.hypot(a.x - b.x, a.y - b.y) || 1, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        V.tx += mx - gest.mx; V.ty += my - gest.my; zoomAt(d / gest.d, mx, my); gest.d = d; gest.mx = mx; gest.my = my; return;
      }
      if (gest && gest.t === "grip" && Math.hypot(p.x - q.sx, p.y - q.sy) > (e.pointerType === "mouse" ? 3 : 7)) gest = { t: "handle", hd: gest.hd };
      if (gest && gest.t === "handle") { q.x = p.x; q.y = p.y; M.dragHandle(gest.hd, p, e.pointerType); return; }
      if (gest && gest.t === "place") { q.x = p.x; q.y = p.y; M.aim(p, "touch", true); return; }
      if (gest && gest.t === "tap" && Math.hypot(p.x - q.sx, p.y - q.sy) > (e.pointerType === "mouse" ? 4 : 9)) { global.clearTimeout(hold); gest = { t: "pan" }; }
      if (gest && gest.t === "pan") { V.tx += p.x - q.x; V.ty += p.y - q.y; V.touched = true; clampView(); moved(); if (V.mode === "measure") M.hover = null; }
      q.x = p.x; q.y = p.y;
    }
    function onUp(e) {
      var q = ptr[e.pointerId]; if (!q) return; delete ptr[e.pointerId]; global.clearTimeout(hold);
      var g = gest, n = ids().length;
      if (g && g.t === "pinch") { gest = n ? { t: "pan" } : null; return; }
      gest = null; endLoupe();
      if (!g || e.type === "pointercancel") { M.hover = null; drawOver(); return; }
      if (g.t === "handle") { M.dropHandle(); return; }
      if (g.t === "place") { M.place({ x: q.x, y: q.y }, "touch"); return; }
      if (g.t !== "tap" && g.t !== "grip") return;
      var now = Date.now();
      if (V.mode === "measure") { M.tap({ x: q.x, y: q.y }, q.type); return; }
      if (q.type !== "mouse") { if (lastTap && now - lastTap.at < 320 && Math.hypot(lastTap.x - q.x, lastTap.y - q.y) < 30) { lastTap = null; dbl(q.x, q.y); } else lastTap = { at: now, x: q.x, y: q.y }; }
    }
    function dbl(x, y) { if (V.k > V.fitK * 3.5) fitAll(); else zoomAt(2.2, x, y); }
    function onWheel(e) {
      if (V.mode === "3d" || !V.plan) return; e.preventDefault(); var p = xy(e), dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1); dy = Math.max(-240, Math.min(240, dy));
      zoomAt(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0018)), p.x, p.y);
    }
    function noGesture(e) { e.preventDefault(); }
    function onKey(e) {
      if (V.dead) return;
      if (e.key === "Escape") { if (menu._open()) return; e.preventDefault(); e.stopPropagation(); if (V.mode === "measure" && M.escape()) return; if (V.fake) { setFake(false); return; } if (fsEl()) return; close(); return; }
      if (e.key === "Tab") { trap(e); return; }
      if (/INPUT|SELECT|TEXTAREA/.test((e.target && e.target.tagName) || "") || (e.target && e.target.closest && e.target.closest(".fv-menu"))) return;
      var onBtn = e.target && e.target.closest && e.target.closest("button");
      if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomStep(1.5); } else if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomStep(1 / 1.5); } else if (e.key === "0") { e.preventDefault(); fitAll(); }
      else if (/^Arrow/.test(e.key) && V.mode !== "3d" && V.plan) { e.preventDefault(); var d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key]; if (V.mode === "measure") M.keyMove(d, e.shiftKey); else { V.tx -= d[0] * 60; V.ty -= d[1] * 60; V.touched = true; clampView(); moved(); } }
      else if (/^Arrow/.test(e.key) && V.mode === "3d" && !onBtn) { e.preventDefault(); three.pan({ ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" }[e.key]); }
      else if ((e.key === "Enter" || e.key === " ") && V.mode === "measure" && !onBtn) { e.preventDefault(); M.keyPlace(); }
      else if ((e.key === "Backspace" || e.key === "Delete") && V.mode === "measure" && !onBtn) { e.preventDefault(); M.undo(); }
    }
    function trap(e) {
      var f = [].slice.call(root.querySelectorAll("button,select,a[href]")).filter(function (n) { return !n.disabled && n.tabIndex >= 0 && n.getClientRects().length; }); if (!f.length) { e.preventDefault(); return; }
      var a = doc.activeElement, i = f.indexOf(a);
      if (e.shiftKey ? i <= 0 : i === f.length - 1) { e.preventDefault(); f[e.shiftKey ? f.length - 1 : 0].focus(); }
    }

    /* ---- Measure ---- */
    var ctx = doc.createElement("canvas").getContext("2d"), UIF = '"IBM Plex Sans",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
    function tw(t, px, w) { if (!ctx) return t.length * px * 0.58; ctx.font = (w || 700) + " " + px + "px " + UIF; return ctx.measureText(t).width; }
    var M = { sub: "pts", list: [], pending: null, hover: null, sel: null, key: null, drag: null, keys: null, cursor: null };
    M.tol = function (type) { return (type === "mouse" ? 12 : 24) / (V.k * PX); };
    M.snapAt = function (p, type) { return snap(toFt(p.x, p.y), V.geos, V.plan.world, M.tol(type)); };
    M.aim = function (p, type, withLoupe) { if (M.sub !== "pts") { M.hover = null; return; } M.hover = M.snapAt(p, type); if (withLoupe) showLoupe(p, M.hover); moved0(); };
    M.place = function (p, type) { placePt(M.snapAt(p, type)); };
    function placePt(q) {
      M.hover = null; M.key = null;
      if (!M.pending) { M.pending = q; say("First point: " + snapWords(q) + ". Now the second point."); }
      else { if (len(M.pending, q) < 0.02) { drawOver(); return; } M.list.push({ a: M.pending, b: q }); M.pending = null; say(both(len(M.list[M.list.length - 1].a, q), V.unit) + ", from " + snapWords(M.list[M.list.length - 1].a) + " to " + snapWords(q)); }
      bar(); drawOver(); if (!panel.hidden) fillPanel();
    }
    M.tap = function (p, type) {
      if (M.sub === "pts") { M.place(p, type); return; }
      var f = toFt(p.x, p.y), best = null; V.geos.forEach(function (g) { var near = inside(f, g) ? 0 : len(f, onEdge(f, g)); if (near > M.tol(type) * 0.6) return; var a = (g.round ? Math.PI * g.r * g.r : g.it.width * g.it.height) * (near ? 4 : 1) + near; if (!best || a < best.a) best = { a: a, g: g }; });
      M.select(best ? best.g.id : null);
    };
    M.select = function (id) {
      M.sel = id; M.key = null; var g = selG(); if (g) showItem(g); bar(); drawOver(); if (!panel.hidden) fillPanel();
      if (g) { var d = itemDistances(g, V.geos, V.plan.world); say((g.it.label || g.it.type) + ", " + sizeWords(g) + ". " + d.walls.map(function (w) { return w.label + " " + dist(w.ft, V.unit).main; }).join(", ") + (d.near.length ? ". " + d.near.map(function (n) { return n.side + ": " + n.label + " " + dist(n.ft, V.unit).main; }).join(", ") : "")); }
    };
    // make room for the labels: on a small screen (or a small item) the view moves to the item and its neighbours
    function showItem(g) {
      var z = size(), d = itemDistances(g, V.geos, V.plan.world), x0 = g.l, x1 = g.rt, y0 = g.t, y1 = g.b, far = Math.max(g.rt - g.l, g.b - g.t, 10) * 1.2;
      d.near.forEach(function (n) { if (n.ft > far) return; x0 = Math.min(x0, n.a.x, n.b.x); x1 = Math.max(x1, n.a.x, n.b.x); y0 = Math.min(y0, n.a.y, n.b.y); y1 = Math.max(y1, n.a.y, n.b.y); });
      var m = Math.max(5, (x1 - x0) * 0.35, (y1 - y0) * 0.35), need = Math.min(z.w, z.h) < 520 ? 12 : 8;   // px per foot the labels need
      if (V.k * PX >= need && toPx({ x: g.l, y: 0 }).x > 0 && toPx({ x: g.rt, y: 0 }).x < z.w && toPx({ x: 0, y: g.t }).y > 0 && toPx({ x: 0, y: g.b }).y < z.h) return;
      V.touched = true; fitRect(x0 - m, y0 - m, x1 + m, y1 + m); if (V.k * PX > 22) { var c = toFt(z.w / 2, z.h / 2); V.k = 22 / PX; V.tx = z.w / 2 - c.x * PX * V.k; V.ty = z.h / 2 - c.y * PX * V.k; }
    }
    function selG() { return M.sel == null ? null : V.geos.filter(function (g) { return g.id === M.sel; })[0] || null; }
    function sizeWords(g) { return g.round ? dist(g.r * 2, V.unit).main + " across" : dist(g.it.width, V.unit).main + " × " + dist(g.it.height, V.unit).main; }
    M.handleAt = function (p, touch) {
      var R = touch ? 26 : 13, best = null, bd = R;
      M.list.forEach(function (m, i) { ["a", "b"].forEach(function (k) { var q = toPx(m[k]), d = Math.hypot(q.x - p.x, q.y - p.y); if (d < bd) { bd = d; best = { i: i, k: k }; } }); });
      if (M.sub !== "pts" || (M.pending && touch === false)) return null;
      if (M.pending) { var pp = toPx(M.pending); if (Math.hypot(pp.x - p.x, pp.y - p.y) < R) return { pend: true }; return null; }   // the second tap may land next to an older point
      return best;
    };
    M.dragHandle = function (hd, p, type) { var q = M.snapAt(p, type === "mouse" ? "mouse" : "touch"); M.drag = hd; M.hover = q; if (hd.pend) M.pending = q; else M.list[hd.i][hd.k] = q; if (type !== "mouse") showLoupe(p, q); moved0(); };
    M.dropHandle = function () { var hd = M.drag; M.drag = null; M.hover = null; if (hd && !hd.pend && M.list[hd.i]) { var m = M.list[hd.i]; say(both(len(m.a, m.b), V.unit)); } bar(); drawOver(); if (!panel.hidden) fillPanel(); };
    M.cancelDrag = function () { M.drag = null; M.hover = null; };
    M.undo = function () { if (M.pending) M.pending = null; else if (M.list.length) M.list.pop(); else return; M.hover = null; say("Removed. " + M.list.length + " measurements left."); bar(); drawOver(); if (!panel.hidden) fillPanel(); };
    M.clear = function () { M.list = []; M.pending = null; M.hover = null; M.sel = null; M.key = null; say("Cleared"); bar(); drawOver(); if (!panel.hidden) fillPanel(); };
    M.escape = function () { if (!panel.hidden) { togglePanel(false); return true; } if (M.pending) { M.pending = null; M.hover = null; bar(); drawOver(); return true; } if (M.key || M.sel != null) { M.key = null; M.sel = null; bar(); drawOver(); return true; } return false; };
    M.keyMove = function (d, big) {
      if (M.sub !== "pts") { var L = V.geos, i = L.findIndex(function (g) { return g.id === M.sel; }); if (L.length) M.select(L[(i + (d[0] + d[1] > 0 ? 1 : L.length - 1) + (i < 0 && d[0] + d[1] < 0 ? 1 : 0)) % L.length].id); return; }
      var st = (big ? 5 : 1) * (V.unit === "m" ? FT_PER_M / (big ? 1 : 4) : 1), c = M.cursor || (M.pending ? { x: M.pending.x, y: M.pending.y } : { x: V.plan.world.w / 2, y: V.plan.world.h / 2 });
      M.cursor = { x: Math.max(0, Math.min(V.plan.world.w, c.x + d[0] * st)), y: Math.max(0, Math.min(V.plan.world.h, c.y + d[1] * st)) };
      M.hover = snap(M.cursor, V.geos, V.plan.world, big ? 0.01 : 0.6); drawOver(); say(snapWords(M.hover) + (M.pending ? ", " + dist(len(M.pending, M.hover), V.unit).main : ", " + dist(M.hover.x, V.unit).main + " from the left wall, " + dist(M.hover.y, V.unit).main + " from the top wall"));
    };
    M.keyPlace = function () { if (M.sub === "pts" && M.hover) placePt(M.hover); };
    function moved0() { if (!raf) raf = global.requestAnimationFrame(function () { raf = 0; if (!V.dead) drawOver(); }); }

    function bar() {
      clear(mbar); if (V.mode !== "measure") return;
      function seg(k, t) { return h("button", { type: "button", cls: "fv-btn" + (M.sub === k ? " on" : ""), "aria-pressed": String(M.sub === k), text: t, on: { click: function () { M.sub = k; M.pending = null; M.hover = null; M.key = null; if (k === "pts") M.sel = null; bar(); drawOver(); mbar.querySelector('[aria-pressed="true"]').focus(); } } }); }
      var n = M.list.length, g = selG();
      var hint = M.key ? M.key.label + ": " + both(M.key.ft, V.unit) : M.sub === "pts" ? (M.pending ? "Now tap the second point" : n ? "Tap two more points, or drag a round end to adjust" : "Tap two points. Hold for a magnifier") : g ? (g.it.label || g.it.type) + ": " + sizeWords(g) : "Tap an item to see its size and distances";
      mbar.appendChild(h("p", { cls: "fv-hint", text: hint }));
      mbar.appendChild(h("div", { cls: "fv-mrow" }, [h("span", { cls: "fv-seg", role: "group", "aria-label": "What to measure" }, [seg("pts", "Two points"), seg("item", "One item")]),
        h("button", { type: "button", cls: "fv-btn", text: "Clear", disabled: !(n || M.pending || M.sel != null || M.key), on: { click: M.clear } }),
        h("button", { type: "button", cls: "fv-btn" + (panel.hidden ? "" : " on"), "aria-expanded": String(!panel.hidden), text: "Distances", on: { click: function () { togglePanel(panel.hidden); } } })]));
    }
    function togglePanel(on) { panel.hidden = !on; if (on) { fillPanel(); } if (!V.touched) fitAll(true); bar(); drawOver(); var b = mbar.querySelector("[aria-expanded]"); if (on) { var c = panel.querySelector("button,select"); if (c) c.focus({ preventScroll: true }); } else if (b) b.focus({ preventScroll: true }); }
    function row(label, ft, o) {
      o = o || {}; var d = dist(ft, V.unit);
      return h("li", {}, [h("button", { type: "button", cls: "fv-row" + (o.on ? " on" : "") + (o.warn ? " warn" : ""), "aria-pressed": o.pick ? String(!!o.on) : null, disabled: !o.pick, on: o.pick ? { click: o.pick } : {} }, [h("span", { cls: "fv-rl" }, [label, o.note ? h("small", { text: o.note }) : null, o.warn ? h("small", { cls: "fv-chk", text: "Check: under " + dist(TIGHT_FT, V.unit).main }) : null]), h("span", { cls: "fv-rv" }, [h("b", { text: d.main }), h("small", { text: d.alt })])]),
        o.del ? h("button", { type: "button", cls: "fv-btn fv-icon sm", "aria-label": "Remove this measurement", on: { click: o.del } }, [icon(ICON.close)]) : null]);
    }
    function showKey(kd) { M.key = M.key && M.key.key === kd.key ? null : kd; M.sel = null; M.pending = null; fillPanel(); bar(); drawOver(); if (M.key) { var x0 = Math.min(kd.a.x, kd.b.x), x1 = Math.max(kd.a.x, kd.b.x), y0 = Math.min(kd.a.y, kd.b.y), y1 = Math.max(kd.a.y, kd.b.y), m = Math.max(14, kd.ft * 0.6); V.touched = true; fitRect(x0 - m, y0 - m, x1 + m, y1 + m); say(kd.label + ", " + both(kd.ft, V.unit)); } }
    function fillPanel() {
      var top = panel.scrollTop, hadFocus = panel.contains(doc.activeElement) ? [].indexOf.call(panel.querySelectorAll("button,select"), doc.activeElement) : -1;
      clear(panel); if (!M.keys) M.keys = keyDistances(V.plan);
      panel.appendChild(h("div", { cls: "fv-lh" }, [h("h2", { text: "Distances" }), h("button", { type: "button", cls: "fv-btn fv-icon sm", "aria-label": "Close the distances list", on: { click: function () { togglePanel(false); } } }, [icon(ICON.close)])]));
      if (M.list.length) { panel.appendChild(h("h3", { text: "Your measurements" })); panel.appendChild(h("ul", {}, M.list.map(function (m, i) { return row((i + 1) + ". " + cap(snapWords(m.a)) + " to " + snapWords(m.b), len(m.a, m.b), { del: function () { M.list.splice(i, 1); fillPanel(); bar(); drawOver(); } }); }))); }
      var sel = h("select", { id: "fvItem", on: { change: function () { M.sub = "item"; M.select(sel.value || null); } } }, [h("option", { value: "", text: "Pick an item" })]);
      V.geos.forEach(function (g) { var op = h("option", { value: g.id, text: (g.it.label || g.it.type) }); if (g.id === M.sel) op.selected = true; sel.appendChild(op); });
      panel.appendChild(h("label", { "for": "fvItem", cls: "fv-il", text: "One item" })); panel.appendChild(sel);
      var g = selG();
      if (g) { var d = itemDistances(g, V.geos, V.plan.world); panel.appendChild(h("p", { cls: "fv-size", text: "Size " + sizeWords(g) })); panel.appendChild(h("ul", {}, d.walls.map(function (w) { return row(w.label, w.ft, w.ft < 0.05 ? { note: "touching" } : {}); }).concat(d.near.map(function (n) { return row(cap(n.side) + ": " + n.label, n.ft); })))); }
      panel.appendChild(h("h3", { text: "Key distances" }));
      panel.appendChild(h("ul", {}, M.keys.map(function (k) { return row(k.label, k.ft, { on: M.key && M.key.key === k.key, warn: k.warn, note: k.note, pick: function () { showKey(k); } }); })));
      panel.appendChild(h("p", { cls: "fv-foot", text: "From the saved plan, edge to edge. Check on site before you build." }));
      panel.scrollTop = top; if (hadFocus >= 0) { var f = panel.querySelectorAll("button,select")[hadFocus]; if (f) f.focus({ preventScroll: true }); }
    }
    function cap(t) { return t.charAt(0).toUpperCase() + t.slice(1); }

    /* the measure overlay is drawn in screen pixels, so lines and words keep their size at every zoom */
    function drawOver() {
      clear(over); if (V.mode !== "measure" || !V.plan) return;
      var z = size(); over.setAttribute("width", z.w); over.setAttribute("height", z.h); over.setAttribute("viewBox", "0 0 " + z.w + " " + z.h);
      var small = Math.min(z.w, z.h) < 520, fs = small ? 17 : 19, f2 = small ? 12 : 13, lines = [], labels = [];
      var vis = { x: 6, y: 6, w: z.w - 12, h: z.h - 12 };
      function ln(a, b, cls, text, alt) { var A = toPx(a), B = toPx(b); lines.push([A, B, cls]); var C = text && clipLine(A, B, vis); if (C) { A = C[0]; B = C[1]; var w = Math.max(tw(text, fs), alt ? tw(alt, f2, 600) : 0) + 16; labels.push({ ax: A.x, ay: A.y, bx: B.x, by: B.y, w: w, h: alt ? fs + f2 + 14 : fs + 10, text: text, alt: alt, cls: cls }); } }
      function D(ft) { return dist(ft, V.unit); }
      var mine = M.sel == null && !M.key ? M.list : [];   // looking at one item / one key distance: only that is drawn
      mine.forEach(function (m) { var d = D(len(m.a, m.b)); ln(m.a, m.b, "pt", d.main, d.alt); });
      if (M.pending && M.hover) { var pd = D(len(M.pending, M.hover)); ln(M.pending, M.hover, "pt live", pd.main, pd.alt); }
      if (M.key) { var kd = D(M.key.ft); ln(M.key.a, M.key.b, "key", kd.main, M.key.label); }
      var g = selG(), gs = null;
      if (g) {
        var dd = itemDistances(g, V.geos, V.plan.world); gs = g;
        dd.near.forEach(function (n) { var t = n.label.length > 18 ? n.label.slice(0, 17) + "…" : n.label; ln(n.a, n.b, "near", D(n.ft).main, "to " + t); });
        dd.walls.forEach(function (w) { if (w.ft > 0.05) ln(w.a, w.b, "wall", D(w.ft).main, w.label.toLowerCase()); });
        var T = toPx({ x: g.cx, y: g.t }), nm = (g.it.label || g.it.type), st = sizeWords(g), nw = Math.max(tw(st, fs), tw(nm, f2, 600)) + 16;
        labels.unshift({ ax: T.x, ay: toPx({ x: 0, y: g.cy }).y, bx: T.x + 0.01, by: toPx({ x: 0, y: g.cy }).y, w: nw, h: fs + f2 + 14, text: st, alt: nm, cls: "size" });
      }
      if (gs) over.appendChild(gs.round ? s("circle", { cx: toPx({ x: gs.cx, y: 0 }).x, cy: toPx({ x: 0, y: gs.cy }).y, r: gs.r * PX * V.k, class: "fv-sel" }) : s("polygon", { points: gs.c.map(function (p) { var q = toPx(p); return q.x + "," + q.y; }).join(" "), class: "fv-sel" }));
      lines.forEach(function (L) {
        var A = L[0], B = L[1], d = Math.hypot(B.x - A.x, B.y - A.y) || 1, nx = -(B.y - A.y) / d * 8, ny = (B.x - A.x) / d * 8, pt = /^pt/.test(L[2]);
        over.appendChild(s("line", { x1: A.x, y1: A.y, x2: B.x, y2: B.y, class: "fv-cas" }));
        over.appendChild(s("line", { x1: A.x, y1: A.y, x2: B.x, y2: B.y, class: "fv-ln " + L[2] }));
        if (!pt) [A, B].forEach(function (p) { over.appendChild(s("line", { x1: p.x - nx, y1: p.y - ny, x2: p.x + nx, y2: p.y + ny, class: "fv-ln " + L[2] })); });
      });
      function knob(p, cls) { var q = toPx(p); over.appendChild(s("circle", { cx: q.x, cy: q.y, r: 11, class: "fv-knob " + (cls || "") })); over.appendChild(s("circle", { cx: q.x, cy: q.y, r: 2.5, class: "fv-dot" })); }
      mine.forEach(function (m) { knob(m.a); knob(m.b); });
      if (M.pending) knob(M.pending, "first");
      if (M.hover && !M.drag) { var q = toPx(M.hover); over.appendChild(s("circle", { cx: q.x, cy: q.y, r: M.hover.snapped ? 9 : 6, class: "fv-hov" + (M.hover.snapped ? " snapped" : "") })); over.appendChild(s("path", { d: "M" + (q.x - 15) + " " + q.y + "h30M" + q.x + " " + (q.y - 15) + "v30", class: "fv-crosshair" })); }
      var box = vis, busy = [], sr = stage.getBoundingClientRect();
      [chip, zoomBox, mbar, panel].forEach(function (n) { if (!n.hidden) { var r = n.getBoundingClientRect(); if (r.width) busy.push({ x: r.left - sr.left, y: r.top - sr.top, w: r.width, h: r.height }); } });
      // the ends of the lines stay visible too
      var knobs = []; mine.forEach(function (m) { [m.a, m.b].forEach(function (p) { var q = toPx(p); knobs.push({ x: q.x - 11, y: q.y - 11, w: 22, h: 22 }); }); });
      placeLabels(labels, box, busy.concat(knobs)).forEach(function (pl, i) {
        var L = labels[i]; if (!pl) return; var cx = pl.x, cy = pl.y;
        if (pl.off) over.appendChild(s("line", { x1: (L.ax + L.bx) / 2, y1: (L.ay + L.by) / 2, x2: cx, y2: cy, class: "fv-lead" }));
        over.appendChild(s("rect", { x: cx - L.w / 2, y: cy - L.h / 2, width: L.w, height: L.h, rx: 7, class: "fv-tag " + L.cls }));
        var t = s("text", { x: cx, y: cy - L.h / 2 + 5 + fs * 0.85, "text-anchor": "middle", class: "fv-tx" }); t.style.fontSize = fs + "px"; t.textContent = L.text; over.appendChild(t);
        if (L.alt) { var t2 = s("text", { x: cx, y: cy + L.h / 2 - 7, "text-anchor": "middle", class: "fv-tx2" }); t2.style.fontSize = f2 + "px"; t2.textContent = L.alt; over.appendChild(t2); }
      });
    }
    /* the magnifier above the finger: the same drawing, 2.5 times bigger, with the snapped point in the middle */
    var LP = 132;
    function showLoupe(p, at) {
      var z = size(), q = toPx(at), mag = Math.max(V.k * 2.5, V.fitK * 4), half = LP / 2 / mag, cx = at.x * PX, cy = at.y * PX, sv = loupe.firstChild;
      if (!sv) { var P = global.HelmFloorDraw.PALETTE; sv = s("svg", { width: LP, height: LP }); Object.keys(P).forEach(function (k) { sv.style.setProperty(k, P[k]); }); sv.style.setProperty("--c-logistics", global.HelmFloorDraw.CAT.logistics);
        sv.appendChild(s("use", { href: "#fvPlan" })); loupe.appendChild(sv);
        loupe.appendChild(s("svg", { width: LP, height: LP, viewBox: "0 0 " + LP + " " + LP, class: "fv-lx" }, [s("path", { d: "M0 " + LP / 2 + "h" + (LP / 2 - 12) + "M" + (LP / 2 + 12) + " " + LP / 2 + "H" + LP + "M" + LP / 2 + " 0v" + (LP / 2 - 12) + "M" + LP / 2 + " " + (LP / 2 + 12) + "V" + LP }), s("circle", { cx: LP / 2, cy: LP / 2, r: 11 }), s("circle", { cx: LP / 2, cy: LP / 2, r: 2 })])); loupe.appendChild(h("span", { cls: "fv-lw" })); }
      sv.setAttribute("viewBox", (cx - half) + " " + (cy - half) + " " + 2 * half + " " + 2 * half);
      loupe.lastChild.textContent = (at.snapped ? cap(snapWords(at)) : "Floor") + (M.pending && !(M.drag && M.drag.pend) ? " · " + dist(len(M.pending, at), V.unit).main : M.drag && !M.drag.pend ? " · " + dist(len(M.list[M.drag.i].a, M.list[M.drag.i].b), V.unit).main : "");
      var x = Math.max(6, Math.min(z.w - LP - 6, p.x - LP / 2)), y = p.y - LP - 64; if (y < 6) { y = Math.min(z.h - LP - 40, p.y + 48); if (Math.abs(q.y - y - LP / 2) < LP / 2) x = p.x > z.w / 2 ? Math.max(6, p.x - LP - 56) : Math.min(z.w - LP - 6, p.x + 56); }
      var lw = loupe.lastChild, half2 = Math.min(220, tw(lw.textContent, 13, 600) + 20) / 2, lc = Math.max(half2 + 4, Math.min(z.w - half2 - 4, x + LP / 2)); lw.style.left = (lc - x) + "px";
      loupe.style.transform = "translate(" + x + "px," + y + "px)"; loupe.hidden = false;
    }
    function endLoupe() { loupe.hidden = true; }

    /* ---- 3D: the planner's own 3D, view only ---- */
    var three = { b: null, zoom: function () {}, fit: function () {}, pan: function () {} };
    function webgl() { try { var c = doc.createElement("canvas"), gl = c.getContext("webgl2"); if (!gl) return false; var x = gl.getExtension("WEBGL_lose_context"); if (x) x.loseContext(); return true; } catch (e) { return false; } }
    function seatTotal() { return V.plan.items.reduce(function (n, it) { var p = it.properties || {}; return n + (p.rows && p.cols ? p.rows * p.cols : +p.seats || 0); }, 0); }
    function heavy() { var m = +global.navigator.deviceMemory || 0, n = V.plan.items.length, c = seatTotal(), low = (m && m <= 2) || (+global.navigator.hardwareConcurrency || 8) <= 2; return low ? n > 120 || c > 600 : n > 1200 || c > 5000; }
    function btn2(t, f, dark) { return h("button", { type: "button", cls: "fv-btn" + (dark ? " dark" : ""), text: t, on: { click: f } }); }
    function start3D(sure) {
      stop3D(); t3.hidden = false;
      if (!webgl()) { note("3D is not available on this device or browser. The 2D plan and Measure still work.", [btn2("Open the 2D plan", function () { setMode("2d"); }, true)]); return; }
      if (!sure && heavy()) { note("This is a big layout (" + V.plan.items.length + " items, " + seatTotal() + " seats). 3D may be slow on this device.", [btn2("Show 3D", function () { start3D(true); }, true), btn2("Open the 2D plan", function () { setMode("2d"); })]); return; }
      note("Loading 3D…"); var tk = ++V.loading;
      load3D().then(function () { if (V.dead || tk !== V.loading || V.mode !== "3d") return; boot3D(tk); }, function () { if (!V.dead && V.mode === "3d") fail3D("3D could not be loaded. Check the connection and try again."); });
    }
    function fail3D(t) { stop3D(); t3.hidden = false; note(t, [btn2("Try again", function () { start3D(true); }, true), btn2("Open the 2D plan", function () { setMode("2d"); })]); }
    function boot3D(tk) {
      var D = global.HelmFloorDraw, cv = h("canvas", { cls: "fv-cv", "aria-label": "3D view of the floor plan. Drag to turn, pinch or scroll to zoom.", role: "img" }), st = h("div", { cls: "fv-st", hidden: true }, [cv]);
      var b2 = h("button", { type: "button", "data-v": "2d" }), b3 = h("button", { type: "button", "data-v": "3d" }), seg = h("div", { hidden: true }, [b2, b3]), leg = h("div", { hidden: true });
      clear(t3); t3.appendChild(st);
      var low = (+global.navigator.deviceMemory || 8) <= 4, offs = [], B = { out: { __HELM_WALK_TEST__: true }, cv: cv };
      var store = { items: JSON.parse(JSON.stringify(V.plan.items)), selectedId: null, selectedIds: [], grid: { snap: false, show: true, unit: V.unit }, margins: V.plan.margins, view: { zoom: 1 } };
      var ok = function () { return !V.dead && three.b === B; };
      three.b = B;
      try {
        global.HelmFloor3D.boot({ out: B.out, canvas: cv, stage: st, viewport: t3, seg: seg, legend: leg, store: store, WORLD: { w: V.plan.world.w, h: V.plan.world.h }, PRICING: { eventType: o.eventType || "" },
          dpr: Math.min(global.devicePixelRatio || 1, low ? 1.25 : 2), CONG_COLORS: ["", "#e8912d", "#e5484d"], congestionOf: cong, cellFt: function () { return V.unit === "m" ? FT_PER_M : 1; }, clamp: function (v, a, b) { return Math.max(a, Math.min(b, v)); },
          getComputedStyle: function () { return { getPropertyValue: function (k) { return D.PALETTE[k] || ""; } }; }, noop: function () {}, toast: function () {}, BPUI: { toast: function (t) { if (ok()) B.err = String(t || ""); } },
          setSelection: function (ids) { store.selectedIds = ids; store.selectedId = ids[0] || null; picked(store); },
          on: function (ev, f) { if (ev !== "resize") return; var ro = global.ResizeObserver ? new global.ResizeObserver(function () { f(); }) : null; if (ro) { ro.observe(t3); offs.push(function () { ro.disconnect(); }); } else { global.addEventListener("resize", f); offs.push(function () { global.removeEventListener("resize", f); }); } } });
      } catch (e) { fail3D("3D could not start on this device. The 2D plan and Measure still work."); return; }
      B.free = function () { offs.forEach(function (f) { f(); }); try { b2.click(); } catch (e) {} try { var ins = B.out.__helm3D.inspect(); if (ins && ins.scene) ins.scene.traverse(function (n) { if (n.geometry && n.geometry.dispose) n.geometry.dispose(); var m = n.material; (Array.isArray(m) ? m : [m]).forEach(function (x) { if (x) { if (x.map && x.map.dispose) x.map.dispose(); if (x.dispose) x.dispose(); } }); }); } catch (e) {}
        try { var gl = cv.getContext("webgl2"), x = gl && gl.getExtension("WEBGL_lose_context"); if (x) x.loseContext(); } catch (e) {} B.out = {}; };
      cv.addEventListener("webglcontextlost", function () { if (ok() && V.mode === "3d") fail3D("3D stopped because the device ran low on memory."); });
      b3.click();   // the planner's own "3D View" switch
      var t0 = Date.now(); (function wait() {
        if (!ok() || tk !== V.loading) return;
        var H3 = B.out.__helm3D, v = H3 && H3.isActive() && H3.getView();
        if (B.err) { fail3D("3D could not start on this device. The 2D plan and Measure still work."); return; }
        if (v) { note(""); wire3D(B); return; }
        if (Date.now() - t0 > 45000) { fail3D("3D is taking too long to load."); return; }
        global.setTimeout(wait, 60);
      })();
    }
    function cong(it) { if (it.type !== "seatblock" && it.type !== "chairrow") return 0; var p = it.properties || {}, c = Math.max(1, p.cols || 1), r = Math.max(1, p.rows || 1), q = r <= 1 ? it.width / c : Math.min(it.width / c, it.height / r); return q < 1.7 ? 2 : q < 2.2 ? 1 : 0; }
    function picked(store) { var it = store.items.filter(function (x) { return x.id === store.selectedId; })[0]; if (it) { var g = geo(it), t = (it.label || it.type) + ": " + sizeWords(g); info3.textContent = t; info3.hidden = false; say(t); } else info3.hidden = true; }
    var info3 = h("p", { cls: "fv-info3", hidden: true });
    function wire3D(B) {
      var H3 = B.out.__helm3D, W = V.plan.world.w, Hh = V.plan.world.h;
      three.zoom = function (f) { B.out.__zoom3D(f); }; three.pan = function (d) { if (d) B.out.__pan3D(d); };
      three.fit = function () { top3(false); };
      function aspect() { var v = H3.getView(); return (v && v.aspect) || 1; }
      function away(fill) { var v = H3.getView(), t = Math.tan((v.fov || 48) * Math.PI / 360), a = aspect(); return [Hh / 2 / (t * fill), W / 2 / (t * a * fill)]; }
      function top3(straight) {   // straight down, or the planner's raised overview
        var d = away(0.92), k = Math.max(d[0], d[1]) + 6;
        if (straight) { H3.setView([0, k, 0.02], [0, 0, 0]); return; }
        var fr = global.HelmCaptureFrame.frameBox({ min: [-W / 2, 0, -Hh / 2], max: [W / 2, 8, Hh / 2] }, { fovDeg: (H3.getView() || {}).fov || 48, aspect: aspect(), fill: 0.9, elevationDeg: 40, azimuthDeg: 0, minDist: 20 }); H3.setView(fr.position, fr.target);
      }
      function at(x, y) { return [x - W / 2, y - Hh / 2]; }
      function item(list) { for (var i = 0; i < list.length; i++) { var f = V.plan.items.filter(function (x) { return x.type === list[i]; }); if (f.length) return f.reduce(function (p, c) { return c.width * c.height > p.width * p.height ? c : p; }); } return null; }
      function stageView() {
        var st = item(["stage", "mandap", "dais"]), g = st && geo(st), a = st ? (+st.rotation || 0) * Math.PI / 180 : 0; if (!st) return;
        var f = [-Math.sin(a), Math.cos(a)], need = Math.max(st.width * 0.62 / (Math.tan(48 * Math.PI / 360) * Math.min(1.2, aspect())), 24) + st.height / 2, c = at(g.cx, g.cy);
        H3.setView([c[0] + f[0] * need, 11, c[1] + f[1] * need], [c[0], 5, c[1]]);
      }
      function entranceView() {
        var e = item(["entrancegate", "floralentrance", "floralarch", "exit"]), st = item(["stage", "mandap", "dais"]), p = e ? geo(e) : null, c = p ? [p.cx, p.cy] : [W / 2, Hh];
        var to = st ? [st.x + st.width / 2, st.y + st.height / 2] : [W / 2, Hh / 2], dx = to[0] - c[0], dy = to[1] - c[1], d = Math.hypot(dx, dy) || 1, from = at(c[0] - dx / d * 30, c[1] - dy / d * 30), look = at(c[0] + dx / d * Math.min(d, 40), c[1] + dy / d * Math.min(d, 40));
        H3.setView([from[0], 10, from[1]], [look[0], 5, look[1]]);
      }
      clear(presets); [["Overview", function () { top3(false); }], ["Top", function () { top3(true); }], ["Entrance", entranceView], item(["stage", "mandap", "dais"]) ? ["Stage", stageView] : null].forEach(function (p) { if (p) presets.appendChild(btn2(p[0], p[1])); });
      presets.hidden = false; t3.appendChild(info3); top3(false);
      // pinch = zoom (the planner zooms by wheel only), double tap = zoom in
      var d0 = 0, tap = 0;
      B.cv.addEventListener("touchmove", function (e) { if (e.touches.length !== 2) { d0 = 0; return; } e.preventDefault(); var d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); if (d0 > 0 && d > 0) B.out.__zoom3D(Math.max(0.6, Math.min(1.6, d0 / d))); d0 = d; }, { passive: false });
      B.cv.addEventListener("touchend", function (e) { d0 = 0; if (e.touches.length || e.changedTouches.length !== 1) return; var n = Date.now(); if (n - tap < 300) { B.out.__zoom3D(0.6); tap = 0; } else tap = n; });
      B.cv.addEventListener("dblclick", function () { B.out.__zoom3D(0.6); });
      say("3D view ready. Drag to turn, pinch or scroll to zoom.");
      V.view3D = function () { return H3.getView(); };
    }
    function stop3D() { V.loading++; if (three.b) { var B = three.b; three.b = null; if (B.free) B.free(); } three.zoom = three.fit = three.pan = function () {}; V.view3D = null; clear(t3); t3.hidden = true; presets.hidden = true; info3.hidden = true; note(""); }

    /* ---- modes ---- */
    function setMode(m) {
      if (V.dead) return; if (m === V.mode && m !== "3d") return;
      V.mode = m; root.setAttribute("data-mode", m); root.setAttribute("aria-label", "Floor plan viewer, " + MODES.filter(function (x) { return x[0] === m; })[0][1]);
      if (m !== "3d") stop3D(); if (m !== "measure") { M.hover = null; panel.hidden = true; endLoupe(); }
      mbar.hidden = m !== "measure"; stage.hidden = m === "3d";
      if (!V.plan) return;
      if (m === "3d") { start3D(); return; }
      if (!V.touched) fitAll(true); else { commitView(); }
      bar(); drawOver(); say(m === "measure" ? "Measure. Tap two points, or choose One item. With the keyboard: arrow keys move the point, Enter places it." : "2D plan");
    }
    var rs = null, rt = 0;
    function onResize() { global.clearTimeout(rt); rt = global.setTimeout(function () { if (V.dead || !V.plan || V.mode === "3d") return; if (!V.touched) fitAll(true); else { clampView(); commitView(); drawOver(); } }, 60); }
    if (global.ResizeObserver) { rs = new global.ResizeObserver(onResize); rs.observe(root); } else global.addEventListener("resize", onResize);

    function redrawPlan() { if (V.dead || !V.plan) return; drawPlan(); if (three.b && three.b.out.__on3DStateChange) three.b.out.__on3DStateChange(); }
    function close(silent) {
      if (V.dead) return; stop3D(); V.dead = true; cur = null;
      redraw = redraw.filter(function (f) { return f !== redrawPlan; });
      if (rs) rs.disconnect(); else global.removeEventListener("resize", onResize);
      doc.removeEventListener("keydown", onKey, true); doc.removeEventListener("fullscreenchange", onFs); doc.removeEventListener("webkitfullscreenchange", onFs);
      global.clearTimeout(commitT); global.clearTimeout(hold); global.clearTimeout(rt);
      if (fsEl()) { var x = doc.exitFullscreen || doc.webkitExitFullscreen; try { var p = x.call(doc); if (p && p.catch) p.catch(function () {}); } catch (e) {} }
      inerted.forEach(function (n) { n.inert = false; }); doc.documentElement.classList.remove("fv-open"); shell.remove();
      if (!silent && back && back.focus && doc.contains(back)) back.focus({ preventScroll: true });
      if (o.onClose) o.onClose();
    }
    stage.addEventListener("pointerdown", onDown); stage.addEventListener("pointermove", onMove); stage.addEventListener("pointerup", onUp); stage.addEventListener("pointercancel", onUp);
    stage.addEventListener("pointerleave", function (e) { if (e.pointerType === "mouse" && M.hover && !gest) { M.hover = null; drawOver(); } });
    stage.addEventListener("wheel", onWheel, { passive: false }); stage.addEventListener("dblclick", function (e) { if (V.mode === "2d") { var p = xy(e); dbl(p.x, p.y); } });
    root.addEventListener("gesturestart", noGesture); root.addEventListener("gesturechange", noGesture);
    stage.addEventListener("touchmove", noGesture, { passive: false }); stage.addEventListener("contextmenu", noGesture);
    doc.addEventListener("keydown", onKey, true); doc.addEventListener("fullscreenchange", onFs); doc.addEventListener("webkitfullscreenchange", onFs);

    cur = { close: close, setMode: setMode, root: root, _V: V, _M: M, _toPx: toPx, _three: function () { return three; } };
    note("Opening the plan…"); setMode(o.mode || "2d");
    load2D().then(function () {
      if (V.dead) return; redraw.push(redrawPlan);
      if (!o.floor || !Array.isArray(o.floor.items) || !o.floor.items.length) { note("There is nothing placed on this layout yet.", [btn2("Close", function () { close(); }, true)]); return; }
      note(""); start(o.floor); var m = V.mode; V.mode = ""; setMode(m);
    }, function () { if (!V.dead) note("The plan could not be loaded. Check the connection and try again.", [btn2("Close", function () { close(); }, true)]); });
    return cur;
  }
  // the exact plan as a still picture (Floor plan card): { svg, plan }
  function still(floor) { var D = global.HelmFloorDraw, plan = D.prepare(floor), sv = D.svg(plan); sv.querySelectorAll(".margins rect").forEach(function (r) { r.setAttribute("vector-effect", "non-scaling-stroke"); }); return { svg: sv, plan: plan }; }

  global.HelmFloorView = Object.assign({ open: open, menuButton: menuButton, ready: load2D, still: still, onRedraw: function (f) { redraw.push(f); }, _cur: function () { return cur; } }, PURE);
})(typeof window !== "undefined" ? window : globalThis);
