/* event-wrap.js - R253 (owner, 25 Nov: "till check in vendors and all everything should be taken care here"): the things you DO at the end of an
 * event, inside Wrap-up (event-steps.js), and the Vendors card of Pre-event / On the event - the same on Tasks & Crew and the Event-day monitor.
 *
 *   HelmWrapDo.paint(id, host, env)   one block under its Wrap-up row: vendors | stock | teardown | crew | issues (true = it draws something)
 *   HelmWrapDo.vendorCard(host, ctx)  the compact Vendors card (expected / here / left); hidden without a booked vendor or the right to see them
 *   env: { q, ctx, data (event-steps' reads), reload(part) -> Promise }
 *
 * Only calls the other pages already use, with the same rights on the page (the database has the last word):
 *   vendors   dayops.list / add / setStatus "arrival" rows (Event-day command), bookings.update status delivered (Teardown) - Event-day command
 *             edit, + Vendors edit for "returned". Undo = the status before. A crash between the two records leaves both as they were read.
 *   stock     checkouts.backV2 / back, returnReservation, the shared Mark back dialog (stock-checkin.js) - Event-day command edit, like Teardown.
 *             Nothing reserved is released here (Teardown does that when it is opened).
 *   teardown  checklist.update / add section "teardown" - Event-day command edit + Event plan edit. Nothing is deleted here.
 *   crew      shifts.officeCheck (the office check-in; a reason when the crew member recorded the time) - the timesheet's can_edit.
 *   issues    issue-assign.js list (assign, Mark resolved) - Issues edit.
 * Every press: one at a time, the row is read again first (changed meanwhile = nothing is saved, the new state is shown) and read back after
 * (the database can refuse without an error). DOM calls only (textContent); no money. Unit-tested in test/r253-wrap.test.mjs. */
(function (global) {
  "use strict";
  var doc = global.document, FRESH = 25000, XTRA_MS = 300000;
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function pl(n, one, many) { return n + " " + (n === 1 ? one : many || one + "s"); }
  function same(a, b) { return String(a == null ? "" : a) === String(b == null ? "" : b); }

  /* ---------------- pure ---------------- */
  var WORD = { expected: "Not arrived", arrived: "Here", left: "Left", no_show: "Did not come" };
  // the arrival row of one booking: the newest when two people added one at the same moment
  function arrivalOf(arrivals, id) {
    var a = (arrivals || []).filter(function (x) { return x && x.ref_id && same(x.ref_id, id); });
    return a.sort(function (x, y) { return String(y.updated_at || y.created_at || "").localeCompare(String(x.updated_at || x.created_at || "")); })[0] || null;
  }
  // one line per booked vendor: { id, label, status (booking), arr, state, at, exited }
  function vendorRows(list, arrivals) {
    return (list || []).filter(function (b) { return b && b.status !== "cancelled" && b.status !== "enquiry"; }).map(function (b) {
      var a = arrivalOf(arrivals, b.id), st = a ? (WORD[a.status] ? a.status : "expected") : "expected", exited = b.status === "delivered";
      return { id: b.id, label: String(b.label || (a && a.who) || "Partner"), status: b.status, arr: a ? a.id : null, state: exited && st !== "left" && st !== "no_show" ? "left" : st,
        raw: st, at: a && a.status !== "expected" ? (a.status === "arrived" ? a.arrived_at : a.status === "left" ? a.left_at : null) || a.updated_at || null : null,
        arrivedAt: a && a.status === "left" ? a.arrived_at || null : null, exited: exited };   // R254 (0437): both times; older databases = the last change only
    });
  }
  function vendorCount(rows) { var r = { total: rows.length, expected: 0, arrived: 0, left: 0, no_show: 0 }; rows.forEach(function (x) { r[x.state]++; }); return r; }
  function vendorLine(rows) { var c = vendorCount(rows); return [c.expected ? c.expected + " expected" : "", c.arrived ? c.arrived + " here" : "", c.left ? c.left + " left" : "", c.no_show ? c.no_show + " did not come" : ""].filter(Boolean).join(" · "); }
  // what can be pressed for a vendor now: [to, words, main]
  function vendorMoves(r) {
    if (r.exited) return [];
    return r.state === "expected" ? [["arrived", "Arrived", 1], ["no_show", "Did not come"]] : r.state === "arrived" ? [["left", "Left", 1], ["expected", "Undo"]] : r.state === "left" ? [["arrived", "Undo"]] : [["expected", "Undo"]];
  }
  function outLeft(c) { return Math.max(num(c && c.qty_out) - num(c && c.qty_in), 0); }
  // the stock lines to bring back: [{ key, kind "co"|"res", id, item, name, unit, left, who, consumable, c, r }]
  function stockLines(res, cos, items) {
    var SF = global.HelmStockFlow, by = {}, out = []; (items || []).forEach(function (i) { if (i) by[i.id] = i; });
    if (!SF) return out;
    SF.eventItems({ reservations: res, checkouts: cos }).forEach(function (r) {
      var it = by[r.item_id] || {}, nm = it.name || "Item", base = { item: r.item_id, name: nm, unit: it.unit || "", consumable: it.item_kind === "consumable", known: !!it.id };
      if (r.state !== "out") { if (r.history.length) out.push(Object.assign({ key: "it:" + r.item_id, kind: "done", words: SF.detail(r, { unit: it.unit || "" }), state: r.state, label: r.label }, base)); return; }
      (r.outs || []).forEach(function (c) { out.push(Object.assign({ key: "co:" + c.id, kind: "co", id: c.id, left: outLeft(c), who: c.issued_to || "", c: c }, base)); });
      if (r.legacyOut) (r.legacyIds || []).forEach(function (id) { var rr = (res || []).filter(function (x) { return x.id === id; })[0] || {}; out.push(Object.assign({ key: "res:" + id, kind: "res", id: id, left: num(rr.qty), who: "", r: rr }, base)); });
    });
    return out.sort(function (a, b) { return (a.kind === "done") - (b.kind === "done") || a.name.localeCompare(b.name); });
  }
  // counted by hand: came back OK + damaged, the rest is missing -> { ok, dmg, miss, error }
  function count(left, okV, dmgV) {
    var w = function (v) { var s = String(v == null ? "" : v).trim(); if (s === "") return 0; var n = Number(s); return isFinite(n) && n >= 0 && Math.floor(n) === n ? n : NaN; }, ok = w(okV), dmg = w(dmgV);
    if (isNaN(ok) || isNaN(dmg)) return { error: "Use whole numbers, 0 or more." }; if (ok + dmg > left) return { error: "Only " + left + " went out." };
    return { ok: ok, dmg: dmg, miss: left - ok - dmg };
  }
  // the timesheet's people: [{ id, name, dept, e (latest entry) | null, state "in"|"out"|"none", ins, outs }]
  function crewRows(ts) {
    return ((ts && ts.rows) || []).filter(function (r) { return r && r.crew_id; }).map(function (r) {
      var es = (r.entries || []).filter(function (k) { return k && k["in"]; }).sort(function (a, b) { return String(b.day).localeCompare(String(a.day)); }), e = es[0] || null;
      return { id: r.crew_id, name: r.name || "Staff", dept: r.department || "", e: e, state: !e ? "none" : e.out ? "out" : "in" };
    }).sort(function (a, b) { var o = { "in": 0, none: 1, out: 2 }; return o[a.state] - o[b.state] || a.name.localeCompare(b.name); });
  }
  // the server's own plain words for a refused value; anything else in the app's friendly words
  function plain(e, action) {
    var c = String((e && e.code) || ""), m = String((e && e.message) || "").trim();
    if (global.navigator && global.navigator.onLine === false) return "You are offline - nothing was saved. Try again when you are back.";
    if ((c === "22023" || c === "P0001" || c === "P0002") && m && !/^[a-z0-9_]+$/.test(m)) return m.slice(0, 240);
    if (c === "42501" || /row-level security|not authori/i.test(m)) return "Your role may not do this (the database refused it).";
    try { return global.BPUI.friendlyError(e, { action: action }); } catch (x) { return "Couldn’t " + action + " - try again."; }
  }
  var pure = { arrivalOf: arrivalOf, vendorRows: vendorRows, vendorCount: vendorCount, vendorLine: vendorLine, vendorMoves: vendorMoves, stockLines: stockLines, count: count, crewRows: crewRows, plain: plain, WORD: WORD };
  var api = global.HelmWrapDo = { _pure: pure };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (!doc || !doc.createElement) return;

  /* ---------------- helpers ---------------- */
  function B() { return global.BPStore; }
  function h(tag, a, kids) {
    var n = doc.createElement(tag);
    Object.keys(a || {}).forEach(function (k) { var v = a[k]; if (v === null || v === undefined || v === false) return;
      if (k === "text") n.textContent = String(v); else if (k === "cls") n.className = v; else if (k === "on") Object.keys(v).forEach(function (e) { n.addEventListener(e, v[e]); }); else n.setAttribute(k, v === true ? "" : String(v)); });
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === "string" ? doc.createTextNode(c) : c); });
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function enc(s) { return encodeURIComponent(s || ""); }
  function say(ctx, m, type) { try { if (ctx && ctx.toast) ctx.toast(m, type); else global.BPUI.toast(m, { type: type || "ok" }); } catch (e) {} }
  function clock(ctx, iso) { var d = new Date(iso); if (!iso || isNaN(d.getTime())) return ""; var loc = "en-IN"; try { loc = B().studioLocale() || loc; } catch (e) {}
    try { return new Intl.DateTimeFormat(loc, { timeZone: (ctx && ctx.tz) || "Asia/Kolkata", hour: "numeric", minute: "2-digit" }).format(d); } catch (e) { return ""; } }
  function ask(f) { return Promise.resolve().then(f).then(function (v) { return v === true; }, function () { return false; }); }
  // { command, vendors, plan, issues } = Can change; seeVendors, seeCommand, seePlan - asked once per page
  var PERM = null;
  function perms() {
    if (PERM) return PERM; var A = B() && B().auth; if (!A || !A.canView) return Promise.resolve({});
    PERM = Promise.all(["command", "vendors", "plan", "issues"].map(function (k) { return ask(function () { return A.canEditArea(k); }); }).concat(["vendors", "command", "plan"].map(function (k) { return ask(function () { return A.canView(k); }); })))
      .then(function (r) { return { command: r[0], vendors: r[1], plan: r[2], issues: r[3], seeVendors: r[4], seeCommand: r[5], seePlan: r[6] }; });
    return PERM;
  }
  api._reset = function () { PERM = P = null; XT = {}; BUSY = {}; };
  var P = null, BUSY = {}, XT = {};
  function need(repaint) { if (P) return P; perms().then(function (p) { P = p; repaint(); }); return null; }   // every block that asked is drawn again once the answer is in
  // item names + stock settings of the Mark back dialog: once per event (5 min)
  function extra(q, repaint) {
    var x = XT[q]; if (x && Date.now() - x.at < XTRA_MS) return x.v; if (x && x.busy) return x.v; var I = B().inventory; XT[q] = { at: Date.now(), busy: true, v: x ? x.v : null };
    Promise.all([Promise.resolve().then(function () { return I.items(true); }).catch(function () { return []; }), Promise.resolve().then(function () { return I.stock ? I.stock.settings() : null; }).catch(function () { return null; })])
      .then(function (r) { XT[q] = { at: Date.now(), v: { items: r[0] || [], ctx: r[1] || null } }; repaint(); });
    return XT[q].v;
  }
  // one press at a time per block: busy while it runs, then that block is read again whatever happened
  function run(S, env, part, action, fn) {
    var k = env.q + ":" + part; if (BUSY[k]) return Promise.resolve(false);
    if (global.navigator && global.navigator.onLine === false) { say(env.ctx, "You are offline - nothing was saved. Try again when you are back.", "err"); return Promise.resolve(false); }
    BUSY[k] = true; S.repaint();
    return Promise.resolve().then(fn).then(function (m) { if (m) say(env.ctx, m.text || m, m.type || "ok"); return true; }, async function (e) {
      var handled = false; try { handled = await B().auth.handleAuthError(e); } catch (x) {} if (!handled) say(env.ctx, plain(e, action), "err"); return false; })
      .then(function (ok) { return Promise.resolve().then(function () { return env.reload(part); }).catch(function () {}).then(function () { BUSY[k] = false; S.repaint(); return ok; }); });
  }
  var CHANGED = { type: "err", text: "This changed meanwhile - nothing was saved. The new state is shown." };
  var NOSAVE = { type: "err", text: "That was not saved. Your role may not be allowed to change it." };
  function btn(text, key, fn, o) { o = o || {}; return h("button", { type: "button", cls: "tc-btn sm hwd-b" + (o.main ? " is-main" : o.ghost ? " ghost" : ""), "data-key": key, "aria-label": o.label || null, disabled: o.off ? true : null, text: text, on: { click: function (e) { if (e.detail > 1) return; fn(e.currentTarget); } } }); }
  function why(text) { return h("p", { cls: "hwd-why", text: text }); }
  function draw(S, host, sig, build) {
    if (S.sig === sig && host.firstChild) return; var a = doc.activeElement, inHost = a && host.contains(a);
    if (inHost && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) && a.type !== "checkbox" && host.firstChild) { S.late = true; return; }   // someone is typing: after they leave
    S.sig = sig; var key = inHost && a.getAttribute("data-key"); clear(host); build(host);
    if (key) { var n = host.querySelector('[data-key="' + String(key).replace(/["\\]/g, "") + '"]'); if (n) try { n.focus({ preventScroll: true }); } catch (e) {} }
  }
  function state(host, repaint) { var S = host._hwd; if (!S) { S = host._hwd = { sig: "" }; host.addEventListener("focusout", function () { setTimeout(function () { if (S.late && !host.contains(doc.activeElement)) { S.late = false; S.repaint(); } }, 60); }); } S.repaint = repaint; return S; }

  /* ---------------- vendors ---------------- */
  async function readVendors(q) { var r = await Promise.all([B().bookings.list(q), B().dayops.list(q, "arrival")]); return { list: r[0] || [], arr: r[1] || [] }; }
  async function moveVendor(env, row, to) {
    var now = await readVendors(env.q), cur = vendorRows(now.list, now.arr).filter(function (x) { return x.id === row.id; })[0];
    if (!cur || cur.state !== row.state || cur.exited !== row.exited) return CHANGED;
    if (cur.arr) await B().dayops.setStatus(cur.arr, to);
    else { var made = await B().dayops.add(env.q, { kind: "arrival", who: row.label, role: "vendor", ref_id: row.id, status: to }); if (made && made.existed) return CHANGED; }
    var back = await readVendors(env.q), b2 = vendorRows(back.list, back.arr).filter(function (x) { return x.id === row.id; })[0];
    if (!b2 || b2.raw !== to) return NOSAVE;
    return row.label + ": " + WORD[to].toLowerCase() + (b2.at ? " " + clock(env.ctx, b2.at) : "") + ".";
  }
  async function exitVendor(env, row) {   // the same second record as Event-day command's "Also mark exited on Teardown"
    var b = ((await B().bookings.list(env.q)) || []).filter(function (x) { return x.id === row.id; })[0];
    if (!b || (b.status !== "booked" && b.status !== "confirmed")) return CHANGED;
    await B().bookings.update(row.id, { status: "delivered" });
    var a = ((await B().bookings.list(env.q)) || []).filter(function (x) { return x.id === row.id; })[0];
    return a && a.status === "delivered" ? row.label + ": returned / exited. Teardown shows it too." : NOSAVE;
  }
  function vendorList(host, S, env, rows, p) {
    var ul = h("ul", { cls: "hwd-list" }), off = !!BUSY[env.q + ":vendors"];
    rows.forEach(function (r) {
      var acts = h("span", { cls: "hwd-acts" });
      if (p.command) {
        vendorMoves(r).forEach(function (m) { acts.appendChild(btn(m[1], "v:" + m[0] + ":" + r.id, function () { run(S, env, "vendors", "update the vendor", function () { return moveVendor(env, r, m[0]); }).then(ring); }, { main: m[2], ghost: !m[2], off: off, label: (m[1] === "Undo" ? "Undo: " + WORD[r.state].toLowerCase() : m[1]) + ", " + r.label })); });
        if (r.state === "left" && !r.exited && p.vendors && (r.status === "booked" || r.status === "confirmed")) acts.appendChild(btn("Returned on Teardown too", "v:exit:" + r.id, function () { run(S, env, "vendors", "mark the vendor returned", function () { return exitVendor(env, r); }).then(ring); }, { off: off, label: "Also mark " + r.label + " returned or exited on Teardown" }));
      }
      var when = r.at && r.state !== "expected" ? clock(env.ctx, r.at) : "";
      ul.appendChild(h("li", { cls: "hwd-row" }, [h("span", { cls: "hwd-main" }, [h("b", { text: r.label }), h("small", { text: (r.arrivedAt ? "Arrived " + clock(env.ctx, r.arrivedAt) + " · " : "") + (r.arrivedAt ? WORD[r.state].toLowerCase() : WORD[r.state]) + (when ? " " + when : "") + (r.exited ? " · returned on Teardown" : r.status === "booked" ? " · not confirmed" : "") })]),
        h("span", { cls: "hwd-pill is-" + r.state, text: WORD[r.state] }), acts]));
    });
    host.appendChild(ul);
    if (!p.command) host.appendChild(why("Your role can see this, not change it (Event-day command - Can change)."));
  }
  function ring() { try { doc.dispatchEvent(new global.CustomEvent("helm:vendors")); } catch (e) {} }
  function vendorsBlock(host, env) {
    var d = env.data || {}, p = need(env.redraw || function () { vendorsBlock(host, env); }); if (!p || !d.vendors || d.vendors === "err") return false;
    var S = state(host, function () { vendorsBlock(host, env); }), rows = vendorRows(d.vendors, d.arrivals);
    if (!S.ring) { S.ring = true; doc.addEventListener("helm:vendors", function () { if (host.isConnected && S.env && !BUSY[S.env.q + ":vendors"]) S.env.reload("vendors"); }); } S.env = env;
    draw(S, host, JSON.stringify([rows, p, d.arrErr, !!BUSY[env.q + ":vendors"]]), function (n) {
      if (d.arrErr) { n.appendChild(h("p", { cls: "hwd-why", role: "status" }, ["Couldn’t check who has arrived. ", btn("Try again", "v:retry", function () { env.reload("vendors"); })])); return; }
      if (!p.seeCommand) { n.appendChild(why("Who has arrived is on Event-day command - your role cannot see it.")); return; }
      if (rows.length) vendorList(n, S, env, rows, p);
    });
    return rows.length > 0;
  }
  // the card: its own read (the page's 30 s redraw calls this; a read at most every 25 s)
  function vendorCard(host, ctx) {
    var q = ctx && ctx.quoteId && ctx.quoteId !== "all" ? String(ctx.quoteId) : ""; if (!host) return;
    var again = function () { vendorCard(host, host._vctx || ctx); }; host._vctx = ctx; if (!q || ctx.show === false || (ctx.quote && ctx.quote.status === "cancelled")) { host.hidden = true; return; }
    var p = need(again); if (!p) return; if (!p.seeVendors || !p.seeCommand || !B().bookings || !B().dayops) { host.hidden = true; return; }
    var S = host._vs; if (!S || S.q !== q) { S = host._vs = { q: q, at: 0, sig: "" }; clear(host); host.hidden = true; }
    S.repaint = again;
    var load = function () { if (S.busy) return S.busy; S.at = Date.now(); S.busy = readVendors(q).then(function (r) { S.data = r; S.err = false; }, function () { S.err = true; }).then(function () { S.busy = null; again(); }); return S.busy; };
    if (!S.ring) { S.ring = true; doc.addEventListener("helm:vendors", function () { if (host._vs === S && !BUSY[q + ":vendors"]) load(); }); }
    if (Date.now() - S.at > FRESH) load();
    if (!S.data && !S.err) return;
    var rows = S.data ? vendorRows(S.data.list, S.data.arr) : [], env = { q: q, ctx: ctx, reload: function () { return load(); } };
    host.hidden = !S.err && !rows.length; if (host.hidden) return;
    draw(S, host, JSON.stringify([rows, S.err, p, !!BUSY[q + ":vendors"]]), function (n) {
      n.appendChild(h("div", { cls: "hwd-head" }, [h("h3", { cls: "tc-h2", id: (host.id || "hwdV") + "H" }, ["Vendors ", h("span", { cls: "tc-count", text: S.err && !S.data ? "not checked" : vendorLine(rows) })])]));
      if (S.err) n.appendChild(h("p", { cls: "hwd-why", role: "status" }, ["Couldn’t check the vendors. ", btn("Try again", "v:retry", function () { load(); })]));
      if (rows.length) vendorList(n, S, env, rows, p);
    });
    host.setAttribute("aria-labelledby", (host.id || "hwdV") + "H");
  }

  /* ---------------- stock ---------------- */
  async function freshLine(env, l) {
    if (l.kind === "co") { var c = ((await B().inventory.checkouts.list(env.q)) || []).filter(function (x) { return x.id === l.id; })[0]; return c && c.status === "out" && outLeft(c) === l.left ? c : null; }
    var r = ((await B().inventory.reservations(env.q)) || []).filter(function (x) { return x.id === l.id; })[0]; return r && r.status === "allocated" && num(r.qty) === l.left ? r : null;
  }
  async function saveBack(env, l, c) {
    if (!(await freshLine(env, l))) return CHANGED;
    if (l.kind === "co") await (env.v2 ? B().inventory.checkouts.backV2(l.id, { ok: c.ok, damaged: c.dmg }) : B().inventory.checkouts.back(l.id, c.ok, c.dmg, null));
    else await B().inventory.returnReservation(l.id, l.item, c.miss + c.dmg);   // given out before names were recorded - the same as Teardown
    return (await freshLine(env, l)) ? NOSAVE : l.name + ": marked back.";
  }
  async function allBack(S, env, lines) {
    var names = lines.slice(0, 6).map(function (l) { return l.left + " " + l.name; }).join(", ") + (lines.length > 6 ? " and " + (lines.length - 6) + " more" : "");
    if (!(await global.BPUI.confirm(names + ". Anything damaged or missing? Cancel and mark that one by itself.", { title: "Mark all " + lines.length + " back OK?", okLabel: "All back OK" }))) return;
    S.results = [];
    await run(S, env, "stock", "mark the stock back", async function () {
      var ok = 0;
      for (var i = 0; i < lines.length; i++) { var l = lines[i], m;
        try { m = await saveBack(env, l, { ok: l.left, dmg: 0, miss: 0 }); } catch (e) { m = { type: "err", text: plain(e, "mark it back") }; }
        var good = !m.type; if (good) ok++; else S.results.push(l.name + ": " + m.text); }
      return { type: ok === lines.length ? "ok" : "err", text: ok + " of " + lines.length + " marked back." };
    });
  }
  function stockBlock(host, env) {
    var d = env.data || {}, again = function () { stockBlock(host, env); }, p = need(env.redraw || again); if (!p || !d.stock || d.stock === "err" || !global.HelmStockFlow) return false;
    var S = state(host, again), raw = stockLines(d.stock.res, d.stock.cos, []); if (!raw.length) { clear(host); S.sig = ""; return false; }
    var x = extra(env.q, again), lines = x ? stockLines(d.stock.res, d.stock.cos, x.items) : raw, off = !!BUSY[env.q + ":stock"]; env.v2 = !!(x && x.ctx);
    draw(S, host, JSON.stringify([lines.map(function (l) { return [l.key, l.left, l.name, l.who, l.words, l.consumable]; }), p.command, off, S.open, S.results, !!x, env.v2]), function (n) {
      var ul = h("ul", { cls: "hwd-list" }), quick = [];
      lines.forEach(function (l) {
        var acts = h("span", { cls: "hwd-acts" }), form = null;
        if (l.kind !== "done" && p.command && x) {
          var can = !l.consumable && l.known; if (can) { quick.push(l); acts.appendChild(btn("Back OK", "s:ok:" + l.key, function () { run(S, env, "stock", "mark it back", function () { return saveBack(env, l, { ok: l.left, dmg: 0, miss: 0 }); }); }, { main: true, off: off, label: "All " + l.left + " " + l.name + " back OK" })); }
          acts.appendChild(btn(l.consumable ? "Count what is left" : "Damaged / missing", "s:mark:" + l.key, function () {
            if (l.kind === "co" && env.v2 && global.HelmStockCheckin) { global.HelmStockCheckin.open({ checkout: l.c, item: x.items.filter(function (i) { return i.id === l.item; })[0] || {}, quoteId: env.q, ctx: x.ctx, onDone: function () { return env.reload("stock"); } }); return; }
            S.open = S.open === l.key ? "" : l.key; S.sig = ""; again(); var f = host.querySelector(".hwd-form input"); if (f) f.focus(); }, { ghost: can, off: off, label: (l.consumable ? "Count what is left of " : "Damaged or missing: ") + l.name }));
          if (S.open === l.key) form = backForm(S, env, l, again);
        }
        ul.appendChild(h("li", { cls: "hwd-row" }, [h("span", { cls: "hwd-main" }, [h("b", { text: l.name }), h("small", { text: l.kind === "done" ? l.words : l.left + (l.unit ? " " + l.unit : "") + " out" + (l.who ? " with " + l.who : "") })]),
          h("span", { cls: "hwd-pill is-" + (l.kind === "done" ? (l.state === "back" ? "left" : "no_show") : "arrived"), text: l.kind === "done" ? l.label : "Out" }), acts, form]));
      });
      n.appendChild(ul);
      if (quick.length > 1 && p.command) n.appendChild(h("div", { cls: "hwd-foot" }, [btn("Mark all " + quick.length + " back OK", "s:all", function () { allBack(S, env, quick); }, { off: off })]));
      if (S.results && S.results.length) n.appendChild(h("ul", { cls: "hwd-res", role: "status" }, S.results.map(function (t) { return h("li", { text: t }); })));
      if (!p.command) n.appendChild(why("Your role can see this, not change it (Event-day command - Can change)."));
    });
    return true;
  }
  function backForm(S, env, l, again) {
    var ok = h("input", { type: "number", min: "0", step: "1", inputmode: "numeric", value: String(l.left), cls: "tc-inp", "data-key": "s:f1:" + l.key }), dm = h("input", { type: "number", min: "0", step: "1", inputmode: "numeric", value: "0", cls: "tc-inp", "data-key": "s:f2:" + l.key }), err = h("p", { cls: "hwd-err", role: "alert", hidden: true });
    var f = h("form", { cls: "hwd-form", novalidate: true, "aria-label": "Mark " + l.name + " back" }, [h("label", null, ["Came back OK", ok]), h("label", null, ["Damaged", dm]), h("span", { cls: "hwd-acts" }, [h("button", { type: "submit", cls: "tc-btn sm hwd-b is-main", text: "Mark back" }),
      h("button", { type: "button", cls: "tc-btn sm ghost hwd-b", text: "Cancel", on: { click: function () { S.open = ""; S.sig = ""; again(); } } })]), h("small", { text: l.left + " went out. Anything not counted here is missing." }), err]);
    f.addEventListener("submit", async function (e) {
      e.preventDefault(); var c = count(l.left, ok.value, dm.value); if (c.error) { err.textContent = c.error; err.hidden = false; ok.focus(); return; }
      if ((c.miss || c.dmg) && !(await global.BPUI.confirm((c.miss ? c.miss + " missing" : "") + (c.miss && c.dmg ? " and " : "") + (c.dmg ? c.dmg + " damaged" : "") + " - " + (c.miss + c.dmg === 1 ? "it comes" : "they come") + " off what you own. Continue?", { title: "Missing or damaged?", okLabel: "Mark back", danger: true }))) return;
      doc.activeElement && doc.activeElement.blur && doc.activeElement.blur(); S.open = ""; run(S, env, "stock", "mark it back", function () { return saveBack(env, l, c); });
    });
    return f;
  }

  /* ---------------- teardown checklist ---------------- */
  var TDW = { open: "To do", done: "Done", na: "Not needed" };
  async function setTd(env, c, to) {
    var find = async function () { return ((await B().checklist.list(env.q, "teardown")) || []).filter(function (x) { return x.id === c.id; })[0]; }, now = await find();
    if (!now || now.status !== c.status) return CHANGED;
    await B().checklist.update(c.id, { status: to }); var a = await find();
    return a && a.status === to ? null : NOSAVE;
  }
  function teardownBlock(host, env) {
    var d = env.data || {}, again = function () { teardownBlock(host, env); }, p = need(env.redraw || again); if (!p || !Array.isArray(d.checklist)) return false;
    var S = state(host, again), can = p.command && p.plan && p.seePlan, off = !!BUSY[env.q + ":teardown"], list = d.checklist.filter(Boolean);
    draw(S, host, JSON.stringify([list.map(function (c) { return [c.id, c.title, c.status]; }), can, off]), function (n) {
      var ul = h("ul", { cls: "hwd-list" });
      list.forEach(function (c) {
        var id = "hwdTd" + c.id, set = function (to) { run(S, env, "teardown", "update the item", function () { return setTd(env, c, to); }); }, box = h("input", { type: "checkbox", id: id, "data-key": "t:" + c.id, disabled: !can || off || c.status === "na" ? true : null }); box.checked = c.status === "done";
        box.addEventListener("change", function () { var to = box.checked ? "done" : "open"; box.checked = c.status === "done"; set(to); });
        ul.appendChild(h("li", { cls: "hwd-row is-tick" + (c.status === "open" ? "" : " is-off") }, [h("label", { cls: "hwd-tick", "for": id }, [box, h("span", { text: c.title || "Item" })]), c.status === "na" ? h("span", { cls: "hwd-pill", text: TDW.na }) : null,
          can && c.status !== "done" ? h("span", { cls: "hwd-acts" }, [btn(c.status === "na" ? "Needed after all" : "Not needed", "t:na:" + c.id, function () { set(c.status === "na" ? "open" : "na"); }, { ghost: true, off: off, label: (c.status === "na" ? "Needed after all: " : "Not needed: ") + (c.title || "item") })]) : null]));
      });
      if (list.length) n.appendChild(ul);
      if (can) {
        var inp = h("input", { cls: "tc-inp", maxlength: "200", placeholder: "e.g. Venue walkthrough with the manager", "aria-label": "New teardown item", "data-key": "t:new", autocomplete: "off" }); inp.value = S.draft || ""; inp.addEventListener("input", function () { S.draft = inp.value; });
        var f = h("form", { cls: "hwd-add", novalidate: true }, [inp, h("button", { type: "submit", cls: "tc-btn sm hwd-b", "data-key": "t:add", disabled: off ? true : null, text: "+ Add" })]);
        f.addEventListener("submit", function (e) { e.preventDefault(); var t = String(inp.value || "").replace(/\s+/g, " ").trim().slice(0, 200); if (!t) { inp.focus(); say(env.ctx, "Type the teardown item first.", "err"); return; }
          if (BUSY[env.q + ":teardown"]) return; inp.blur();
          run(S, env, "teardown", "add the item", async function () {
            var had = ((await B().checklist.list(env.q, "teardown")) || []).some(function (x) { return String(x.title || "").trim().toLowerCase() === t.toLowerCase(); }); if (had) { S.draft = ""; return { type: "info", text: "That is already on the list." }; }
            await B().checklist.add(env.q, { section: "teardown", title: t }); S.draft = ""; return "Added: " + t + "."; }); });
        n.appendChild(f);
      } else n.appendChild(why("Your role can see this, not change it (Event-day command and Event plan - Can change)."));
    });
    return true;
  }

  /* ---------------- crew ---------------- */
  async function office(env, row, what) {
    var t = await B().ops.shifts.timesheet(env.q), now = crewRows(t).filter(function (x) { return x.id === row.id; })[0];
    if (!now || now.state !== row.state || !same(now.e && now.e.in_at, row.e && row.e.in_at)) return CHANGED;
    var at = new Date().toISOString(), note = null;
    if (what === "out" && now.e.source === "crew") { note = await global.BPUI.prompt("Why is the office checking " + row.name + " out? It is kept with their hours.", { title: "Check out " + row.name + "?", label: "Reason (required)", required: true, requiredMessage: "Give a short reason.", okLabel: "Check out", value: "Checked out by the office at wrap-up" }); if (note === null) return null; }
    if (what === "out") await B().ops.shifts.officeCheck(env.q, row.id, now.e.day, now.e.in_at, at, note ? String(note).trim().slice(0, 300) : null);
    else await B().ops.shifts.officeCheck(env.q, row.id, t.today, at, null, null);
    return row.name + (what === "out" ? " checked out " : " checked in ") + clock(env.ctx, at) + ".";
  }
  function crewBlock(host, env) {
    var d = env.data || {}, again = function () { crewBlock(host, env); }, t = d.ts; if (!t || !Array.isArray(t.rows)) return false;
    var rows = crewRows(t); if (!rows.length) return false; var S = state(host, again), off = !!BUSY[env.q + ":crew"], today = t.today && t.event_date && t.today === t.event_date;
    draw(S, host, JSON.stringify([rows, t.can_edit, off, today, S.all]), function (n) {
      var ul = h("ul", { cls: "hwd-list" }), max = S.all ? rows.length : 8;
      rows.slice(0, max).forEach(function (r) {
        var acts = h("span", { cls: "hwd-acts" });
        if (t.can_edit && r.state === "in" && r.e.in_at && r.e.day) acts.appendChild(btn("Check out now", "c:out:" + r.id, function () { run(S, env, "crew", "save the time", function () { return office(env, r, "out"); }); }, { main: true, off: off, label: "Check out " + r.name + " now" }));
        else if (t.can_edit && r.state === "none" && today) acts.appendChild(btn("Check in now", "c:in:" + r.id, function () { run(S, env, "crew", "save the time", function () { return office(env, r, "in"); }); }, { off: off, label: "Check in " + r.name + " now" }));
        ul.appendChild(h("li", { cls: "hwd-row" }, [h("span", { cls: "hwd-main" }, [h("b", { text: r.name }), h("small", { text: r.state === "none" ? "No check-in" : "In " + r.e["in"] + (r.e.out ? " · out " + r.e.out : "") })]), h("span", { cls: "hwd-pill is-" + (r.state === "in" ? "arrived" : r.state === "out" ? "left" : "expected"), text: r.state === "in" ? "Still in" : r.state === "out" ? "Out" : "Not in" }), acts]));
      });
      n.appendChild(ul);
      if (rows.length > 8) n.appendChild(h("div", { cls: "hwd-foot" }, [btn(S.all ? "Show fewer" : "Show all " + rows.length, "c:all", function () { S.all = !S.all; S.sig = ""; again(); }, { ghost: true })]));
      n.appendChild(h("p", { cls: "hwd-why" }, [t.can_edit ? "Another time? " : "Your role cannot enter times. ", h("a", { cls: "hwd-a", href: "command.html?quote=" + enc(env.q), text: "Crew check-in & hours" })]));
    });
    return true;
  }

  /* ---------------- issues ---------------- */
  function issuesBlock(host, env) {
    var d = env.data || {}, IA = global.HelmIssueAssign, again = function () { issuesBlock(host, env); }, p = need(env.redraw || again); if (!p || !IA || !Array.isArray(d.issues) || !d.issues.length) return false;
    var ctx = env.ctx || {}, done = function () { return env.reload("issues").then(function () { if (ctx.onIssues) ctx.onIssues(); }); };
    IA.list(host, { items: d.issues, quoteId: env.q, canEdit: p.issues, max: 8, allHref: "issues.html?quote=" + enc(env.q), tasks: function () { return ctx.tasks || []; }, locked: function () { var EF = global.HelmEventFloor; return !!(EF && EF.isLocked(env.q)); }, empty: "",
      toast: function (m, k) { say(ctx, m, k); }, reload: done, onTask: function () { if (ctx.onTask) ctx.onTask(); }, resolve: async function (i, b) {
        b.disabled = true;
        try { var now = ((await B().issues.list(env.q)) || []).filter(function (x) { return x.id === i.id; })[0];
          if (!now || now.status === "resolved") say(ctx, now ? "Already resolved by someone else." : "This issue is gone.", "info");
          else { await B().issues.setStatus(i.id, "resolved"); say(ctx, "Resolved: " + (i.title || "issue") + ".", "ok"); } }
        catch (e) { say(ctx, plain(e, "resolve the issue"), "err"); b.disabled = false; }
        await done(); } });
    return true;
  }

  var BLOCK = { vendors: vendorsBlock, stock: stockBlock, teardown: teardownBlock, crew: crewBlock, issues: issuesBlock };
  api.paint = function (id, host, env) { try { return BLOCK[id] ? BLOCK[id](host, env) : false; } catch (e) { clear(host); return false; } };
  api.has = function (id) { return !!BLOCK[id]; };
  api.vendorCard = vendorCard;
})(typeof window !== "undefined" ? window : globalThis);
