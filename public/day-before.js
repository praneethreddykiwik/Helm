/* day-before.js - the event-day CHECKLIST (R252 built it as the Day-before card; R257, owner 25 Nov 2026: "Instead of manually locking
 * everything, add a checklist - like Mark as done, who did it"). One component, used by Tasks & Crew (ops.html), the Event-day monitor
 * (monitor.html) and Event Ready (ready.html):
 *
 *   HelmDayBefore.render(host, ctx)     Day before. Called by HelmEventPlan.renderDayBefore (event-plan.js), the callers stay as they are.
 *   HelmDayBefore.renderPre(host, ctx)  Pre-event (the set-up on the day, before guests)
 *   HelmDayBefore.openLines(q, step)    the lines a person still has to tick (null = not known yet) - "Mark pre-event complete" lists them
 *   ctx: { plan (event_day_plan_get), tasks, quoteId, eventDate, eventTime, tz, now, nameOf(t), toast(msg, type), onChanged(),
 *          compact, noReady (Event Ready shows its own checks), closed, sheet (who checked in), goCheckin(), goVendors() }
 *
 * Day before: Vendors (one line per vendor) - Menu and guest count - Plan and floor layout - Inventory and stock - Logistics - People - Final checks -
 * your own lines. Pre-event: People and vendors - Set-up (the departments of this event's pre-event tasks) - Checks - your own lines.
 * Every section is always open. Every line: a tick + "Mark done", the fact as it is now, who ticked it and when, Undo, one button named by what it
 * opens, the rest behind the ... (More) button ("Give to someone" makes a real Day-before task; never a second one while one is open).
 * A line Helm can work out ticks itself ("Auto"). A person may tick it by hand too: "Marked done by Asha, 9:33 AM, though 1 vendor is not confirmed" -
 * a stored tick with a name and a time (0442), the vendor / stock / task itself never changes.
 * Where the ticks are kept: the 11 Day-before lines in event_day_plans.checks (0396, as before), Dry run / Team briefed = the Readiness sign-offs,
 * Logistics rows = event_checklist, everything else + your own lines = event_check_marks / event_check_lines (0442). Before 0442 those say so.
 *
 * Reads: only while the card is on screen, in parallel, kept 3 minutes per event (the ticks 1 minute; the 30 s redraw reads nothing). Each read
 * needs the permission of its page AND of its table (the database answers "no rows", not an error, to a refused read - so an unreadable
 * group is left out and never counts as fine). A failed read says "Couldn't check". A save is read back before it counts as saved.
 * DOM by createElement / textContent only; money fields are dropped as soon as a row is read. */
(function (global) {
  "use strict";
  var doc = global.document, KEEP_MS = 180000, CAT = "Day before";
  var BK = { enquiry: "Asked", booked: "Booked", confirmed: "Confirmed", delivered: "Delivered", cancelled: "Cancelled" };
  var CHK = { open: "Open", done: "Done", na: "N/A" }, GST = { open: "Pending", done: "Confirmed", na: "Declined" };
  var LINE_GROUP = { vendors: "vendors", headcount: "menu", load_list: "stock", transport: "logistics", permits: "logistics",
    venue_access: "logistics", power: "logistics", weather: "logistics", crew_call: "people", runsheet: "final", client: "final" };
  // which section a Readiness check (store-api readiness.check) belongs to; what opens it and the words of that button
  var RD = { layout: "plan", vendors: "vendors", menu: "menu", capacity: "plan", resources: "stock", stock: "stock", staff: "people", date: "final", approval: "final", runsheet: "final", dry_run: "final", briefing: "final" };
  var RD_GO = { layout: ["builder.html?quote=", "Open 2D / 3D plan"], vendors: ["resources.html?quote=", "Open Resource plan"], menu: ["plan.html?quote=", "Open menu"], capacity: ["event.html?id=", "Open event"], resources: ["resources.html?quote=", "Open Resource plan"],
    stock: ["resources.html?quote=", "Open Resource plan"], staff: ["ops.html?quote=", "Open Tasks & Crew"], date: ["event.html?id=", "Open event"], approval: ["event.html?id=", "Open event"],
    runsheet: ["runsheet.html?quote=", "Open run-sheet"], dry_run: ["ready.html?quote=", "Open Readiness"], briefing: ["ready.html?quote=", "Open Readiness"] };
  var MARK_MS = 60000, ARR_MS = 25000, NEED_SQL = "needs database update 0442";

  var MARKS = { exit: 1, parking: 1 };   // floor-plan marks, not products: nothing to link or to get from a vendor

  /* ---------------- pure ---------------- */
  function nl(v) { return String(v == null ? "" : v).trim().toLowerCase().replace(/\s+/g, " "); }
  function n0(v) { var x = Number(v); return isFinite(x) ? x : 0; }
  function ms(v) { if (v == null || v === "") return NaN; var t = typeof v === "number" ? v : new Date(v).getTime(); return isFinite(t) ? t : NaN; }
  function isAre(n, one, many, words) { return plural(n, one, many) + (n === 1 ? " is " : " are ") + words; }
  function fmt(v) { var x = Math.round(n0(v) * 100) / 100; return x.toLocaleString("en-IN"); }
  function plural(n, one, many) { return fmt(n) + " " + (n === 1 ? one : many || one + "s"); }
  function TS() { return global.HelmTaskStatus || {}; }
  function lines() { return (global.HelmEventPlan && global.HelmEventPlan.DAYBEFORE) || []; }
  function groupOf(key) { return LINE_GROUP[key] || "people"; }
  /* when a Day-before task starts: 10 AM the day before (studio time); already past = half an hour from now, still that day;
     the event day itself / no date = null (no time is written - the task then lists under Pre-event). */
  function startFor(o) {
    o = o || {}; var T = TS(), ev = String(o.eventDate || "").slice(0, 10), now = o.now == null ? Date.now() : o.now;
    if (!T.wallMs || !/^\d{4}-\d{2}-\d{2}$/.test(ev)) return null;
    var day0 = T.wallMs(ev, 0, o.tz), eve = T.ymdIn(o.tz, day0 - 12 * 3600000), t = T.wallMs(eve, 600, o.tz);
    if (t > now) return new Date(t).toISOString();
    t = Math.ceil((now + 1800000) / 900000) * 900000;
    if (t >= day0) t = day0 - 300000;
    return t > now ? new Date(t).toISOString() : null;
  }
  // the task made for one line: same category + same words (+ same vendor for a vendor job); an open one wins over a finished one
  function lineTask(tasks, title, vendorId) {
    var T = TS(), want = nl(title), best = null, rank = { started: 0, accepted: 1, waiting: 2, unassigned: 3, rejected: 4, done: 5 };
    (tasks || []).forEach(function (t) {
      if (!t || t.status === "cancelled" || nl(t.category) !== nl(CAT) || nl(t.title) !== want) return;
      if (vendorId && String(t.vendor_id || "") !== String(vendorId)) return;
      var k = T.baseKey ? T.baseKey(t) : "waiting", r = rank[k] == null ? 9 : rank[k];
      if (!best || r < best.r) best = { r: r, t: t, key: k };
    });
    return best ? { t: best.t, key: best.key, held: best.key === "waiting" || best.key === "accepted" || best.key === "started", free: best.key === "unassigned" || best.key === "rejected" } : null;
  }
  // only what the card shows (the money columns of these tables never leave this function)
  function cleanBooking(b) { return { id: b.id, vendor_id: b.vendor_id || null, need_id: b.need_id || null, label: String(b.label || ""), qty: b.qty == null ? null : n0(b.qty), status: String(b.status || ""), kind: b.kind || "" }; }
  function cleanVendor(v) { return { id: v.id, name: String(v.name || "Vendor"), phone: String(v.phone || ""), category: String(v.category || "") }; }
  function cleanCheck(c) { return { id: c.id, section: c.section, title: String(c.title || ""), detail: String(c.detail || ""), owner: String(c.owner || ""), due_date: c.due_date ? String(c.due_date).slice(0, 10) : "", qty: c.qty == null ? null : n0(c.qty), status: String(c.status || "open") }; }
  function vendorRows(bookings, vendors) {
    var by = {}; (vendors || []).forEach(function (v) { by[v.id] = v; });
    return (bookings || []).filter(function (b) { return b && b.status !== "cancelled"; }).map(function (b) {
      var v = by[b.vendor_id];
      return { b: b, id: b.id, vendorId: b.vendor_id, name: v ? v.name : b.label || "Vendor", what: v ? b.label : "", qty: b.qty, phone: v ? v.phone : "",
        status: b.status, label: BK[b.status] || b.status, done: b.status === "confirmed" || b.status === "delivered", canConfirm: b.status === "enquiry" || b.status === "booked" };
    });
  }
  // live vendor bookings for one product: the same rule stock-vendor.js saves by (the need it was made for, the stock shortfall it
  // covers, else exactly the same words - "Chairs" never counts as "Chairs with covers")
  function sourcedFor(o, itemId, label) {
    var k = nl(label), needs = o.needs || [], RENT = /^(.*) - rent (\d+(?:\.\d+)?) \(stock shortfall\)$/i;
    return (o.bookings || []).filter(function (b) { return b && b.status !== "cancelled"; }).map(function (b) {
      var m = RENT.exec(String(b.label || "").trim()), x = { b: b, qty: b.qty != null ? b.qty : m ? n0(m[2]) : null };
      var nd = b.need_id ? needs.filter(function (z) { return z.id === b.need_id; })[0] : null;
      if (nd) return (itemId && nd.item_id === itemId) || (k && nl(nd.label) === k && !(itemId && nd.item_id && nd.item_id !== itemId)) ? x : null;
      if (itemId && (o.shortages || []).some(function (z) { return z.booking_id === b.id && z.item_id === itemId; })) return x;
      return k && (nl(b.label) === k || (m && nl(m[1]) === k)) ? x : null;
    }).filter(Boolean).concat(sourcedLines(o, itemId, k));
  }
  // R262: one request asks one vendor for several products - the line of this product counts (stock-vendor.js fromRequests is the same rule)
  function sourcedLines(o, itemId, k) {
    var out = [], needs = o.needs || [];
    (o.requests || []).forEach(function (r) {
      var b = (o.bookings || []).filter(function (x) { return x && x.id === r.booking_id; })[0]; if (b && b.status === "cancelled") return;
      var bn = b && b.need_id ? needs.filter(function (z) { return z.id === b.need_id; })[0] : null;
      r.lines.forEach(function (l) {
        var nd = l.need_id ? needs.filter(function (z) { return z.id === l.need_id; })[0] : null;
        if (bn && nd && bn.id === nd.id) return;   // the booking itself is for this product
        if (b && (nl(b.label) === k)) return;
        if (nd ? !((itemId && nd.item_id === itemId) || (k && nl(nd.label) === k && !(itemId && nd.item_id && nd.item_id !== itemId))) : !(k && nl(l.name) === k)) return;
        if (l.qty > 0) out.push({ b: { id: r.booking_id, vendor_id: r.vendor_id, status: b && b.status !== "enquiry" ? b.status : r.status === "accepted" ? "booked" : "enquiry" }, qty: l.qty });
      });
    });
    return out;
  }
  function cleanRequest(r) {   // no money
    var of = r.offer && (r.offer_open || r.offer.status === "approved") ? r.offer.lines || [] : [];
    return { id: r.id, booking_id: r.booking_id || null, vendor_id: r.vendor_id || null, status: r.status, lines: (r.lines || []).map(function (l) { var x = of.filter(function (y) { return y && y.id === l.id; })[0]; return { name: String(l.name || ""), need_id: l.need_id || null, qty: n0(x ? x.qty : l.qty) }; }) };
  }
  // R271: given out = the one stock rule (stock-flow.js coParts): only a check-out still Out, less what already came back. A check-out
  // closed with some missing ("partial") is Missing on Inventory, Teardown and Wrap-up - it is not given out any more.
  function outBy(checkouts) {
    var SF = global.HelmStockFlow, r = {};
    (checkouts || []).forEach(function (c) { if (!c || !c.item_id) return;
      var q = SF && SF.coParts ? SF.coParts(c).out : c.status === "out" ? Math.max(n0(c.qty_out) - n0(c.qty_in), 0) : 0;
      if (q > 0) r[c.item_id] = (r[c.item_id] || 0) + q; });
    return r;
  }
  function resBy(res) { var r = {}; (res || []).forEach(function (x) { if (x && (x.status === "reserved" || x.status === "allocated")) r[x.item_id] = (r[x.item_id] || 0) + n0(x.qty); }); return r; }
  /* o: { layout (layout_stock_needs), reservations, checkouts, shortages, needs, bookings (null = not visible) } */
  function stockRows(o) {
    o = o || {}; var L = o.layout || {}, outs = outBy(o.checkouts), res = resBy(o.reservations), labels = {};
    (L.types || []).forEach(function (t) { labels[t.layout_type] = t.label || t.layout_type; });
    var rows = (L.items || []).map(function (i) {
      var needed = n0(i.needed), held = n0(i.held), src = sourcedFor(o, i.item_id, i.name), borrow = Math.max(n0(i.to_borrow), 0);
      var got = 0, firm = 0; src.forEach(function (s) { var q = s.qty == null ? borrow : s.qty; got += q; if (s.b.status !== "enquiry") firm += q; });
      var missing = Math.max(needed - held - got, 0), toGet = Math.max(borrow - got, 0), toReserve = Math.max(missing - toGet, 0);
      var state = toGet > 0 ? "short" : toReserve > 0 ? "reserve" : got > 0 && firm < borrow ? "asked" : "ok";
      return { id: i.item_id, name: i.name, unit: i.unit || "", needed: needed, reserved: o.reservations ? res[i.item_id] || 0 : held, out: outs[i.item_id] || 0, free: n0(i.free),
        missing: missing, toGet: toGet, toReserve: toReserve, held: held, got: got, firm: firm, sourced: src, state: state, done: state === "ok", types: i.types || [],
        shared: Math.max(n0(i.to_borrow_shared) - borrow, 0) };
    });
    var order = { short: 0, reserve: 1, asked: 2, ok: 3 }; rows.sort(function (a, b) { return order[a.state] - order[b.state] || String(a.name).localeCompare(String(b.name)); });
    var un = (L.unlinked || []).filter(function (u) { return u && !MARKS[u.layout_type]; }).map(function (u) {
      var src = sourcedFor(o, null, u.label || u.layout_type);
      return { type: u.layout_type, label: u.label || u.layout_type, objects: n0(u.objects), seats: n0(u.seats), sourced: src };
    });
    var inPlan = {}; rows.forEach(function (r) { inPlan[r.id] = 1; });
    return { rows: rows, unlinked: un, types: planTypes(L.types), extra: Object.keys(res).filter(function (k) { return res[k] > 0 && !inPlan[k]; }).length,
      short: rows.filter(function (r) { return r.state === "short"; }).length,
      otherShort: (o.shortages || []).filter(function (s) { return s && !s.booking_id && s.source !== "buy" && s.source !== "vendor" && !inPlan[s.item_id]; }).map(function (s) { return { id: s.id, itemId: s.item_id, label: String(s.label || "").replace(/^Short:\s*[\d.]+\s*[x×]\s*/i, "") || "item", qty: n0(s.qty) }; }) };
  }
  function planTypes(types) {
    return (types || []).filter(Boolean).map(function (t) { return { label: String(t.label || t.layout_type || "item"), n: n0(t.objects), seats: n0(t.seats) }; })
      .sort(function (a, b) { return (b.seats > 0) - (a.seats > 0) || b.n - a.n || a.label.localeCompare(b.label); });
  }
  // a floor plan (event_floor_get) counted per product, for a viewer without Inventory
  function floorTypes(floor) {
    var by = {}, seatsOf = global.HelmEventFloor && global.HelmEventFloor.seatsOf;
    ((floor && floor.items) || []).forEach(function (i) {
      if (!i || !i.type) return; var k = i.type; by[k] = by[k] || { layout_type: k, label: i.label || k, objects: 0, seats: 0 }; by[k].objects++;
      var p = i.properties || {}, s = n0(p.rows) > 0 && n0(p.cols) > 0 ? Math.round(n0(p.rows) * n0(p.cols)) : n0(p.seats) > 0 ? Math.round(n0(p.seats)) : k === "chiavari" || k === "barstool" ? 1 : 0;
      try { if (seatsOf && i.width && i.height) s = n0(seatsOf(i)); } catch (e) {}
      by[k].seats += s;
    });
    return planTypes(Object.keys(by).map(function (k) { return by[k]; }));
  }
  function planWords(types) {
    if (!types.length) return "";
    var seats = types.reduce(function (n, t) { return n + t.seats; }, 0);
    return types.map(function (t) { return t.label + " × " + fmt(t.n); }).join(", ") + (seats ? " · " + plural(seats, "seat") + " in all" : "");
  }
  function refused(e) { var c = String((e && e.code) || ""), m = String((e && (e.message || e)) || ""); return c === "42501" || c === "PGRST301" || /not authori[sz]ed|permission denied|not allowed/i.test(m); }

  /* ---------------- state: one per event ---------------- */
  var ST = {}, UI = { form: null, folds: {}, busy: {}, open: {}, menu: null, own: {}, flash: null };
  function S(q) { return ST[q] || (ST[q] = { at: 0, loading: false, perms: null, ready: blank(), vendors: blank(), stock: blank(), logistics: blank(), marks: blank(), arrivals: blank(), markAt: 0, arrAt: 0, left: {}, people: null, owners: null }); }
  function blank() { return { state: "wait", data: null }; }
  function store() { return global.BPStore || {}; }
  function ask(fn, name, area) {   // one permission, never throws, unknown = no
    var A = store().auth; if (!A || !A[fn]) return Promise.resolve(false);
    return Promise.resolve().then(function () { return A[fn](area); }).then(function (v) { return v === true; }, function () { return false; });
  }
  function askAll() {
    var A = store().auth || {}, v = function (a) { return ask("canView", "v", a); }, e = function (a) { return ask("canEditArea", "e", a); };
    var can = A.canAssignTasks ? ask("canAssignTasks") : e("staff");
    return Promise.all([v("vendors"), v("inventory"), v("command"), v("logistics"), v("plan"), v("staff"), e("vendors"), e("resources"), e("logistics"), e("plan"), can, v("resources"), e("ready")]).then(function (r) {
      return { vendors: r[0], inventory: r[1], command: r[2], logistics: r[3] && r[4], staff: r[5], vendorsEdit: r[0] && r[6] && r[7], logisticsEdit: r[8] && r[9], assign: r[10], resources: r[11], readyEdit: r[12] };
    });
  }
  function settle(q, g, p) {
    return p.then(function (d) { if (ST[q] === g.s) { g.s[g.k] = d && d.hidden ? { state: "hidden", data: d.data || null } : { state: "ok", data: d }; } },
      function (e) { if (ST[q] === g.s) g.s[g.k] = refused(e) ? { state: "hidden", data: null } : { state: "error", data: g.s[g.k].data }; })
      .then(function () { repaint(q); });
  }
  var READ = {
    ready: function (q, p, force) {
      var EP = global.HelmEventPlan; if (!EP || !EP.readyCheck) return Promise.resolve({ hidden: true });
      return EP.readyCheck(q, force).then(function (r) { return r ? { r: r } : { hidden: true }; });
    },
    vendors: function (q, p) {
      var B = store(); if (!p.vendors || !B.bookings) return Promise.resolve({ hidden: true });
      return B.bookings.list(q).then(function (list) {
        var bk = (list || []).filter(Boolean).map(cleanBooking); if (!bk.length) return { bookings: [], vendors: [], needs: [] };
        return Promise.all([B.vendors.listAll(true), B.vendorRequests && B.vendorRequests.list ? Promise.resolve(B.vendorRequests.list(q, null)).catch(function () { return []; }) : []]).then(function (r0) {
          var rq = (r0[1] || []).filter(function (x) { return x && (x.status === "sent" || x.status === "accepted") && (x.lines || []).length > 1; }).map(cleanRequest);
          return Promise.resolve((rq.length || bk.some(function (b) { return b.need_id; })) && B.resources ? B.resources.listNeeds(q) : []).then(function (nd) { return [r0[0], nd, rq]; });
        }).then(function (r) {
          return { bookings: bk, requests: r[2], vendors: (r[0] || []).map(cleanVendor), needs: (r[1] || []).map(function (x) { return { id: x.id, item_id: x.item_id || null, label: String(x.label || "") }; }) };
        });
      });
    },
    stock: function (q, p) {
      var B = store(), I = B.inventory, PL = B.ops && B.ops.planLock;
      function floorOnly() {   // no stock numbers for this viewer / database: still the floor-plan counts
        var c = null; try { c = global.HelmEventFloor && global.HelmEventFloor._cache && global.HelmEventFloor._cache()[q]; } catch (e) {}
        if (c && c.floor) return Promise.resolve({ hidden: true, data: { floor: floorTypes(c.floor) } });
        if (!PL || !PL.floor) return Promise.resolve({ hidden: true });
        return PL.floor(q).then(function (f) { return { hidden: true, data: f ? { floor: floorTypes(f) } : null }; }, function (e) { if (refused(e)) return { hidden: true }; throw e; });
      }
      if (!p.inventory || !I || !I.layout) return floorOnly();
      return Promise.all([I.layout.needs(q), I.reservations(q), I.checkouts.list(q), p.command && I.shortages ? I.shortages(q) : []]).then(function (r) {
        if (!r[0]) return floorOnly();
        return { layout: r[0], reservations: (r[1] || []).map(function (x) { return { item_id: x.item_id, qty: x.qty, status: x.status }; }),
          checkouts: (r[2] || []).map(function (x) { return { item_id: x.item_id, qty_out: x.qty_out, qty_in: x.qty_in, status: x.status }; }),
          shortages: (r[3] || []).map(function (x) { return { id: x.id, item_id: x.item_id, label: x.label, qty: x.qty, source: x.source, booking_id: x.booking_id }; }) };
      });
    },
    // 0442: who ticked what, your own lines, the history. Before 0442: { old } (the 11 ticks still work)
    marks: function (q) {
      var C = store().ops && store().ops.checks; if (!C || !C.get) return Promise.resolve({ hidden: true, data: { old: true } });
      S(q).markAt = Date.now();
      return C.get(q).then(function (d) { return d ? { marks: d.marks || {}, lines: d.lines || [], log: d.log || [], can_edit: d.can_edit === true } : { hidden: true, data: { old: true } }; });
    },
    // Pre-event only: who has arrived (the same rows as the Vendors card and Event-day command)
    arrivals: function (q, p) {
      var D = store().dayops; S(q).arrAt = Date.now(); if (!p.vendors || !p.command || !D || !D.list) return Promise.resolve({ hidden: true });
      var VI = global.HelmVendorItems;   // R260 (0448): their items, checked in on the Vendors card
      return Promise.all([D.list(q, "arrival"), VI && VI.load ? VI.load(q, 5000) : null]).then(function (r) { var l = r[0]; return { items: VI && r[1] ? VI._pure.sumOf(r[1]) : null, rows: (l || []).map(function (a) { return { ref: a.ref_id, status: String(a.status || "") }; }) }; });
    },
    logistics: function (q, p) {
      var B = store(); if (!p.logistics || !B.checklist) return Promise.resolve({ hidden: true });
      return B.checklist.list(q).then(function (list) { return { rows: (list || []).filter(function (c) { return c && c.section !== "teardown"; }).map(cleanCheck) }; });
    }
  };
  function loadGroup(q, k, force) { var s = S(q); return settle(q, { s: s, k: k }, Promise.resolve().then(function () { return READ[k](q, s.perms || {}, force); })); }
  function load(q, ctx, force) {
    var s = S(q); if (s.loading || !q) return s.p; s.loading = true; repaint(q);
    s.p = askAll().then(function (p) {
      s.perms = p;
      return Promise.all(Object.keys(READ).filter(function (k) { return !(k === "ready" && ctx.noReady) && !(k === "arrivals" && ctx.step !== "pre"); }).map(function (k) { return loadGroup(q, k, force); }));
    }).then(function () { s.loading = false; s.at = Date.now(); repaint(q); }, function () { s.loading = false; s.at = Date.now(); repaint(q); });
    return s.p;
  }
  // a vendor was confirmed / asked: the Readiness lines are worked out again (Event Ready shows them itself: ctx.onData)
  function againReady(ctx) { if (ctx.noReady) { if (ctx.onData) ctx.onData(); } else loadGroup(ctx.quoteId, "ready", true); }
  function onScreen(host) { if (doc.hidden) return false; var n = host; while (n && n !== doc) { if (n.hidden) return false; n = n.parentNode; } return true; }

  /* ---------------- DOM ---------------- */
  function h(tag, o, kids) {
    var n = doc.createElement(tag); o = o || {};
    Object.keys(o).forEach(function (k) {
      var v = o[k]; if (v == null || v === false) return;
      if (k === "text") n.textContent = v; else if (k === "cls") n.className = v;
      else if (k === "on") Object.keys(v).forEach(function (e) { n.addEventListener(e, v[e]); });
      else if (k === "hidden") n.hidden = !!v;
      else n.setAttribute(k, v === true ? "" : String(v));
    });
    (kids || []).forEach(function (c) { if (c != null && c !== false) n.appendChild(typeof c === "string" ? doc.createTextNode(c) : c); });
    return n;
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  function enc(v) { return encodeURIComponent(v == null ? "" : v); }
  function clock(t, tz) { try { return new Intl.DateTimeFormat("en-IN", { timeZone: tz || "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(t)).toUpperCase(); } catch (e) { return ""; } }
  function dayTime(t, tz) { try { return new Intl.DateTimeFormat("en-IN", { timeZone: tz || "Asia/Kolkata", weekday: "short", day: "numeric", month: "short" }).format(new Date(t)) + ", " + clock(t, tz); } catch (e) { return ""; } }
  function dateWords(d) { try { var f = store().fmtDateIN; return f ? f(d) : d; } catch (e) { return d; } }
  function say(ctx, msg, type) { if (ctx && typeof ctx.toast === "function") ctx.toast(msg, type); }
  function why(e, what) {
    var m = String((e && e.message) || "");
    if (/plan_locked/.test(m)) return "The database still refuses changes on the event day (" + NEED_SQL + ").";   // R257: before 0442
    if (/PGRST202/.test(String((e && e.code) || "")) || /function public\.event_check/.test(m)) return "This " + NEED_SQL + ".";
    try { if (global.BPUI && global.BPUI.friendlyError) return global.BPUI.friendlyError(e, { action: what }); } catch (x) {}
    return "Could not " + what + ".";
  }
  function link(href, text, label) { return h("a", { cls: "hdb-link", href: href, text: text, "aria-label": label }); }
  function btn(id, text, fn, o) { o = o || {}; return h("button", { type: "button", id: id, cls: "tc-btn sm hdb-btn" + (o.cls ? " " + o.cls : ""), text: text, "aria-label": o.label, "aria-expanded": o.exp, "aria-pressed": o.pressed, title: o.title, "aria-disabled": UI.busy[o.busy || id] ? "true" : null, on: { click: fn } }); }
  function chip(text, tone) { return h("span", { cls: "hdb-st" + (tone ? " " + tone : ""), text: text }); }
  // a button that saves: greyed while it runs, a second press does nothing
  async function run(ctx, id, what, fn) {
    if (UI.busy[id]) return; UI.busy[id] = 1; repaint(ctx.quoteId, true);
    try { await fn(); } catch (e) { say(ctx, why(e, what), "err"); }
    delete UI.busy[id]; repaint(ctx.quoteId, true);
  }
  var HOSTS = [];
  function hostsOf(q) { HOSTS = HOSTS.filter(function (x) { return x._hdb && (doc.body ? doc.body.contains(x) : true); }); return HOSTS.filter(function (x) { return x._hdb.ctx.quoteId === q; }); }
  function repaint(q, force) { hostsOf(q).forEach(function (x) { paint(x, force); }); }
  // a person is in the middle of something: typing, or one of the card's own forms (with its people menu) is open
  function inUse(host) {
    var a = doc.activeElement, q = host._hdb && host._hdb.ctx.quoteId;
    if (a && a !== doc.body && host.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) return true;
    return !!(UI.form && UI.form.q === q);
  }
  function closeForm(ctx) { var back = UI.form && UI.form.back; UI.form = null; repaint(ctx.quoteId, true); if (back) { var b = doc.getElementById(back); if (b) try { b.focus(); } catch (e) {} } }
  function openForm(ctx, f) {
    if (UI.form && UI.form.key === f.key && UI.form.q === ctx.quoteId) { closeForm(ctx); return; }
    UI.form = Object.assign({ q: ctx.quoteId, val: "", text: "", err: "" }, f); UI.menu = null; repaint(ctx.quoteId, true);
    if (f.need === "owners") loadOwners(ctx.quoteId); else if (f.need === "people") loadPeople(ctx.quoteId);
    var first = doc.getElementById("hdbPick") || doc.getElementById("hdbJob"); if (first) try { first.focus(); } catch (e) {}
  }
  function loadPeople(q) {
    var s = S(q), B = store(); if (s.people && s.people.state !== "error") return;
    s.people = { state: "wait", staff: [], vendors: [] };
    var v = B.vendors && B.vendors.listAll && s.perms && s.perms.vendors ? B.vendors.listAll(false).then(function (x) { return x || []; }, function () { return []; }) : Promise.resolve([]);
    Promise.all([B.ops.listCrew(), v]).then(function (r) {
      s.people = { state: "ok", staff: (r[0] || []).filter(function (c) { return !c.login_off; }).map(function (c) { return { id: c.id, name: String(c.name || ""), phone: String(c.phone || ""), dept: String(c.department || c.role || ""), mail: !!(c.email || c.profile_id) }; }).filter(function (c) { return c.name; }), vendors: r[1].map(cleanVendor) };
    }, function () { s.people = { state: "error", staff: [], vendors: [] }; }).then(function () { repaint(q, true); });
  }
  function loadOwners(q) {
    var s = S(q), P = store().people; if (s.owners && s.owners.state !== "error") return;
    s.owners = { state: "wait", list: [] };
    Promise.resolve().then(function () { return P.options(); }).then(function (l) { s.owners = { state: "ok", list: (l || []).map(function (x) { return { name: x.name, kind: x.kind, role: x.role || "" }; }) }; },
      function () { s.owners = { state: "error", list: [] }; }).then(function () { repaint(q, true); });
  }
  function phoneOk(p) { return String(p || "").replace(/\D/g, "").length >= 8; }
  function pick(label, kids, hint) {
    var sel = h("select", { id: "hdbPick", cls: "ep-inp hdb-inp", "aria-describedby": hint ? "hdbHint" : null }, kids); sel.value = UI.form.val;
    sel.addEventListener("change", function () { UI.form.val = sel.value; UI.form.err = ""; });
    return [h("label", { cls: "ep-lbl", for: "hdbPick", text: label }), sel];
  }
  function group(label, opts) { return opts.length ? h("optgroup", { label: label }, opts) : null; }
  function formBox(ctx, kids, goText, go) {
    if (UI.form.err) kids.push(h("p", { cls: "ep-err", role: "alert", text: UI.form.err }));
    return h("div", { cls: "hdb-form", on: { keydown: function (e) { if (e.key === "Escape") { e.stopPropagation(); closeForm(ctx); } } } }, kids.concat([h("div", { cls: "ep-acts hdb-form-acts" }, [
      btn("hdbCancel", "Cancel", function () { closeForm(ctx); }), btn("hdbGo", goText, go, { cls: "tc-primary" })])]));
  }
  function againBox(q, what, fn) { return h("p", { cls: "hdb-fail", role: "status" }, ["Couldn't check " + what + " ", btn("hdbRetry-" + what.replace(/\W+/g, ""), "Try again", fn)]); }

  /* ---- give one line to a person or a vendor = a real Day-before task ---- */
  async function give(ctx, line) {
    var q = ctx.quoteId, B = store(), O = B.ops, f = UI.form, s = S(q), ppl = s.people || { staff: [], vendors: [] };
    var title = line.vendorId ? nlTitle(f.text) : line.title, parts = line.vendorId ? ["v", line.vendorId] : String(f.val || "").split(":");
    if (!title) { f.err = "Type what they should do."; repaint(q, true); return; }
    if (/[<>]/.test(title)) { f.err = "Leave out < and >."; repaint(q, true); return; }
    var who = (parts[0] === "v" ? ppl.vendors : ppl.staff).filter(function (x) { return String(x.id) === parts.slice(1).join(":"); })[0];
    if (!who) { f.err = "Pick who should do it."; repaint(q, true); return; }
    f.err = "";
    await run(ctx, "hdbGo", "give the task", async function () {
      var iso = startFor(ctx), fresh = await O.listTasks(q), ex = lineTask(fresh, title, line.vendorId);
      if (ex && ex.held) {   // someone gave it out meanwhile: never a second task
        say(ctx, "Already with " + nameOf(ctx, ex.t) + ".", "err"); UI.form = null; if (ctx.onChanged) await ctx.onChanged(); return;
      }
      if (ex && ex.free && parts[0] === "v") { f.err = "There is already a task for this that was turned down or has nobody on it. Reassign it on Tasks & Crew."; return; }
      var TC = parts[0] !== "v" && global.HelmTaskClash;
      if (TC) {   // R254-B: the same time first, then the day
        var T2 = TS(), day2 = iso && T2.ymdIn ? T2.ymdIn(ctx.tz, ms(iso)) : String(ctx.eventDate || "").slice(0, 10), cal = B.calendar && B.calendar.wouldClash;
        if (!(await TC.give(iso ? [{ crew_id: who.id, name: who.name, start: iso, title: title, id: ex && ex.free ? ex.t.id : undefined }] : [], { quoteId: q, tasks: fresh, exclude: ex && ex.free ? [ex.t.id] : [], toast: function (m) { say(ctx, m, "ok"); }, dayOk: "Give anyway",
          dayText: function (x) { return who.name + " is " + x.detail + ". Give the task anyway?"; } }, cal ? function () { return B.calendar.wouldClash({ date: day2, crewId: who.id, excludeQuote: q }); } : null))) return;
      } else if (parts[0] !== "v" && B.calendar && B.calendar.wouldClash && global.BPUI && global.BPUI.confirm) {
        var T = TS(), day = iso && T.ymdIn ? T.ymdIn(ctx.tz, ms(iso)) : String(ctx.eventDate || "").slice(0, 10);
        var c = await B.calendar.wouldClash({ date: day, crewId: who.id, excludeQuote: q }).catch(function () { return { clash: false }; });
        if (c && c.clash && !(await global.BPUI.confirm(who.name + " is " + c.detail + ". Give the task anyway?", { title: "Scheduling clash", okLabel: "Give anyway" }))) return;
      }
      var had = {}, timeBad = false, made = []; fresh.forEach(function (t) { had[t.id] = 1; });
      if (ex && ex.free) { await O.reassign(ex.t.id, who.id, who.name, who.phone); if (!ex.t.planned_start) made = [ex.t]; }
      else {
        if (parts[0] === "v") await O.assignTasksVendor(q, CAT, [title], who.id, { step: "daybefore" }); else await O.assignTasks(q, CAT, [title], who.id, who.name, who.phone, { step: "daybefore" });
        if (iso) try { made = (await O.listTasks(q)).filter(function (t) { return !had[t.id] && nl(t.category) === nl(CAT) && nl(t.title) === nl(title) && String((parts[0] === "v" ? t.vendor_id : t.crew_id) || "") === String(who.id); }); } catch (e) { timeBad = true; }
      }
      if (iso) for (var i = 0; i < made.length; i++) try { await O.setSchedule(made[i].id, iso, null, made[i].depends_on || null); } catch (e) { timeBad = true; }
      var note = parts[0] === "v" ? " Their checklist link is on the task." : who.mail ? " They get an e-mail with their tasks in about a minute." : " There is no e-mail on their staff record - tell them yourself.";
      say(ctx, "Given to " + who.name + "." + note + (timeBad ? " The start time could not be saved - set it with Change time." : ""), timeBad ? "err" : "ok");
      UI.form = null; if (ctx.onChanged) await ctx.onChanged();
    });
  }
  function nlTitle(v) { return String(v || "").trim().replace(/\s+/g, " ").slice(0, 120); }
  function nameOf(ctx, t) { var n = ""; try { n = ctx.nameOf ? ctx.nameOf(t) : ""; } catch (e) {} return String(n || t.assignee_name || "someone"); }
  function whenHint(ctx) { var iso = startFor(ctx); return iso ? "Starts " + dayTime(ms(iso), ctx.tz) + " (change it in the task)." : "It goes on the Pre-event list: there is no time left the day before."; }
  function assignForm(ctx, line, lt) {
    var s = S(ctx.quoteId), P = s.people || { state: "wait" }, kids = [];
    if (P.state === "error") kids.push(h("p", { cls: "hdb-fail", role: "status" }, ["Couldn't load your people ", btn("hdbPplRetry", "Try again", function () { loadPeople(ctx.quoteId); repaint(ctx.quoteId, true); })]));
    else if (line.vendorId) {
      var v = (P.vendors || []).filter(function (x) { return String(x.id) === String(line.vendorId); })[0];
      var inp = h("input", { id: "hdbJob", cls: "ep-inp hdb-inp", type: "text", maxlength: "120", "aria-describedby": "hdbHint" }); inp.value = UI.form.text;
      inp.addEventListener("input", function () { UI.form.text = inp.value; });
      kids.push(h("label", { cls: "ep-lbl", for: "hdbJob", text: "What should " + line.name + " do?" }), inp);
      if (P.state === "ok" && !v) kids.push(h("p", { cls: "ep-hint", text: line.name + " is not in your active vendors list." }));
      else if (v && !phoneOk(v.phone)) kids.push(h("p", { cls: "ep-hint" }, ["No phone saved for " + line.name + ". ", link("vendors.html", "Add it in Vendors →")]));
      kids.push(h("p", { cls: "ep-hint", id: "hdbHint", text: "Optional. The vendor gets a link with their checklist. " + whenHint(ctx) }));
      if (P.state === "ok" && (!v || !phoneOk(v.phone))) return h("div", { cls: "hdb-form" }, kids.concat([h("div", { cls: "ep-acts" }, [btn("hdbCancel", "Close", function () { closeForm(ctx); })])]));
    } else {
      var opt = function (k) { return function (p) { return h("option", { value: k + ":" + p.id, disabled: phoneOk(p.phone) ? null : true, text: p.name + (p.dept || p.category ? " · " + (p.dept || p.category) : "") + (phoneOk(p.phone) ? "" : " (no phone)") }); }; };
      kids = kids.concat(pick("Give “" + line.title + "” to", [h("option", { value: "", text: P.state === "wait" ? "Loading people…" : "Pick a person or a vendor" }), group("Staff", (P.staff || []).map(opt("c"))),
        lt && lt.free ? null : group("Vendors", (P.vendors || []).map(opt("v")))], true));
      kids.push(h("p", { cls: "ep-hint", id: "hdbHint", text: "Optional - you can just tick the line. A staff member is e-mailed their tasks automatically; a vendor gets a link with their checklist. " + whenHint(ctx) }));
    }
    return formBox(ctx, kids, "Give the task", function () { give(ctx, line); });
  }
  function canGive(ctx) { var p = S(ctx.quoteId).perms; return !!(p && p.assign && p.staff && !ctx.closed); }
  function isOpenForm(ctx, key) { return !!(UI.form && UI.form.q === ctx.quoteId && UI.form.key === key); }

  /* ---- lines: first as plain objects (so the count and "Do these first" can be worked out), then as rows ----
     { key, sec, done, quiet (not counted), na (not counted), title, fact (as it is now), who (who ticked it), chip, lead, tick { id, on, can, fn }, acts(top) = the line's own buttons [nodes],
       go [href or fn, words] = the button named by what it opens, more [menu items], detail [strings / nodes, shown when the line is opened], form, urg { rank, why, rest }, kids [lines] } */
  function icon(t, cls) { return h("span", { cls: "hdb-i " + (cls || ""), "aria-hidden": "true", text: t }); }
  function tickBtn(id, on, title, can, fn) {
    return h("button", { type: "button", id: id, cls: "hdb-tick" + (on ? " on" : ""), "aria-pressed": on ? "true" : "false", disabled: can ? null : true, "aria-disabled": UI.busy[id] ? "true" : null, "aria-label": (on ? "Done: " : "Not done: ") + title, on: can ? { click: fn } : null },
      [h("span", { cls: "hdb-box", "aria-hidden": "true", text: on ? "✓" : "" })]);
  }
  function goLink(id, href, text, label) { return h("a", { id: id, cls: "tc-btn sm hdb-btn", href: href, text: text, "aria-label": label }); }
  function dots(list) { return list.filter(Boolean).join(" · "); }
  function low(t) { t = String(t || ""); return /^[A-Z][a-z]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t; }
  function topId(top, id) { return (top ? "hdbTop-" : "") + id; }
  function stepOf(ctx) { return ctx.step === "pre" ? "pre" : "daybefore"; }
  function sfx(ctx) { return stepOf(ctx) === "pre" ? "-pre" : ""; }   // two cards can be on one page (one of them hidden): ids stay apart
  // "Done by Asha, 9:33 AM" (with the day when it was not today, studio time)
  function byWords(by, at, ctx, word) {
    if (!by) return ""; var t = ms(at), T = TS(), today = T.ymdIn ? T.ymdIn(ctx.tz, ctx.now == null ? Date.now() : ctx.now) : "";
    return (word || "Done") + " by " + by + (isFinite(t) ? ", " + (T.ymdIn && T.ymdIn(ctx.tz, t) === today ? clock(t, ctx.tz) : dayTime(t, ctx.tz)) : "");
  }
  /* ---- the stored ticks (0442) ---- */
  function marksOf(ctx) { var m = S(ctx.quoteId).marks; return m.data && m.data.marks ? m.data : null; }
  function markKey(ctx, key) { return stepOf(ctx) + ":" + String(key).toLowerCase(); }
  function markOf(ctx, key) { var d = marksOf(ctx); return (d && d.marks[markKey(ctx, key)]) || null; }
  function canMark(ctx) { var d = marksOf(ctx); return !!(d && d.can_edit); }
  function oldDb(ctx) { var m = S(ctx.quoteId).marks; return !!(m.data && m.data.old); }
  async function saveMark(ctx, key, on, note) {
    var r = await store().ops.checks.mark(ctx.quoteId, markKey(ctx, key), on, note || null), d = marksOf(ctx);
    if (d && r && r.key && r.item) d.marks[r.key] = r.item;   // the server's answer: somebody else's earlier tick stays theirs
    S(ctx.quoteId).markAt = Date.now() - MARK_MS + 1500;   // the history follows in a moment
  }
  function markFn(ctx, key, id, on, note) { return function () { run(ctx, id, "save the tick", function () { return saveMark(ctx, key, on, note); }); }; }
  /* a line only a person can tick */
  function handLine(ctx, it) {
    var m = markOf(ctx, it.key), on = !!(m && m.done), id = "hdbMk-" + it.key;
    it.done = on; it.hand = true; if (on) { it.urg = null; it.chip = null; }
    it.who = on ? byWords(m.by, m.at, ctx) : "";
    it.tick = { id: id, on: on, can: canMark(ctx), fn: markFn(ctx, it.key, id, !on) };
    return it;
  }
  /* a line Helm works out: it ticks itself (Auto). Not done yet = a person may say it is (a stored tick; the fact is still shown). */
  function autoLine(ctx, it) {
    it.auto = true; if (it.na) return it;
    var m = markOf(ctx, it.key), id = "hdbMk-" + it.key, fact = it.fact || (it.chip && it.chip[0]) || "";
    if (it.done) { if (!it.quiet) it.chip = it.chip || ["Auto", "ok"]; return it; }
    if (m && m.done) {
      it.who = byWords(m.by, m.at, ctx, "Marked done") + (it.why || fact ? ", though " + low(it.why || fact) : ""); it.done = true; it.byHand = true; it.urg = null; it.chip = null; it.fact = "";
      it.lead = icon("✓", "ok"); it.tick = { id: id, on: true, can: canMark(ctx), fn: markFn(ctx, it.key, id, false) };
    } else it.tick = { id: id, on: false, can: canMark(ctx), fn: markFn(ctx, it.key, id, true, it.why || fact) };
    return it;
  }
  function tickNodes(ctx, it, top) {
    var t = it.tick; if (!t) return { lead: it.lead, btn: null };
    return { lead: t.can || it.hand || t.box ? tickBtn(t.id, t.on, it.title, t.can, t.fn) : it.lead,
      btn: t.can ? h("button", { type: "button", id: (top ? "hdbTop-" : "hdbB-") + t.id, cls: "tc-btn sm hdb-btn hdb-tk" + (t.on ? " on" : ""), tabindex: top ? null : "-1", "aria-disabled": UI.busy[t.id] ? "true" : null, "aria-label": (t.on ? "Undo: " : "Mark done: ") + it.title, text: t.on ? "Undo" : "Mark done", on: { click: t.fn } }) : null };
  }
  function goNode(ctx, it, top) {
    var g = it.go; if (!g) return null; var id = topId(top, "hdbGo-" + it.key);
    return typeof g[0] === "function" ? btn(id, g[1], g[0], { cls: "hdb-goto", label: g[1] + ": " + it.title }) : h("a", { id: id, cls: "tc-btn sm hdb-btn hdb-goto", href: g[0], text: g[1], "aria-label": g[1] + ": " + it.title });
  }
  function shut(ctx, back) {   // close the More menu, focus back on its button
    var m = UI.menu; if (!m) return; UI.menu = null;
    if (back) { var b = doc.getElementById("hdbMore-" + m.key); if (b) try { b.focus(); } catch (e) {} }
    repaint(m.q, true);
  }
  function moreBox(ctx, it) {
    var list = (it.more || []).filter(Boolean); if (!list.length) return null;
    var id = "hdbMore-" + it.key, mid = "hdbMenu-" + it.key, open = !!(UI.menu && UI.menu.q === ctx.quoteId && UI.menu.key === it.key), nodes = [];
    function step(i) { var n = nodes[(i + nodes.length) % nodes.length]; if (n) try { n.focus(); } catch (e) {} }
    list.forEach(function (m, i) {
      var key = function (e) {
        if (e.key === "ArrowDown") step(i + 1); else if (e.key === "ArrowUp") step(i - 1); else if (e.key === "Home") step(0); else if (e.key === "End") step(-1); else return;
        e.preventDefault();
      };
      nodes.push(m.href ? h("a", { id: m.id, cls: "hdb-mi", role: "menuitem", tabindex: "-1", href: m.href, text: m.text, "aria-label": m.label, on: { keydown: key, click: function () { shut(ctx, true); } } })
        : h("button", { type: "button", id: m.id, cls: "hdb-mi", role: "menuitem", tabindex: "-1", text: m.text, "aria-label": m.label, "aria-disabled": UI.busy[m.id] ? "true" : null, on: { keydown: key, click: function () { shut(ctx, true); m.fn(id); } } }));
    });
    var menu = h("div", { id: mid, cls: "hdb-menu", role: "menu", "aria-label": "More for " + it.title, hidden: !open }, nodes);
    var b = h("button", { type: "button", id: id, cls: "hdb-dots", "aria-haspopup": "menu", "aria-expanded": open ? "true" : "false", "aria-controls": mid, "aria-label": "More: " + it.title, title: "More", text: "⋯", on: { click: function () {
      if (open) { shut(ctx, true); return; }
      UI.menu = { q: ctx.quoteId, key: it.key }; repaint(ctx.quoteId, true);
      var first = doc.getElementById(list[0].id); if (first) try { first.focus(); } catch (e) {}
    } } });
    return h("div", { cls: "hdb-more" + (open ? " open" : ""), on: { keydown: function (e) {
      if (!open) { if (e.key === "ArrowDown") { e.preventDefault(); b.click(); } return; }
      if (e.key === "Escape") { e.stopPropagation(); shut(ctx, true); } else if (e.key === "Tab") shut(ctx, true);
    } } }, [b, menu]);
  }
  function rowNode(ctx, it) {
    var ok = ctx.quoteId + ":" + it.key, det = (it.detail || []).filter(Boolean), open = det.length && !!UI.open[ok], tid = "hdbT-" + it.key, did = "hdbD-" + it.key, cut = it.title.lastIndexOf(" ") + 1;   // the small arrow never stands alone on a new line
    var words = [h("span", { cls: "hdb-t" }, [it.sr ? h("span", { cls: "tc-sr", text: it.sr }) : null, h("b", {}, det.length ? [it.title.slice(0, cut), h("span", { cls: "nw" }, [it.title.slice(cut), h("span", { cls: "hdb-car", "aria-hidden": "true" })])] : [it.title]), it.chip ? chip(it.chip[0], it.chip[1]) : null]),
      it.fact ? h("span", { cls: "hdb-sub", text: it.fact }) : null, it.who ? h("span", { cls: "hdb-sub hdb-who", text: it.who }) : null];
    var main = det.length ? h("button", { type: "button", id: tid, cls: "hdb-main", "aria-expanded": open ? "true" : "false", "aria-controls": open ? did : null, on: { click: function () { UI.open[ok] = !open; repaint(ctx.quoteId, true); } } }, words) : h("div", { id: tid, cls: "hdb-main", tabindex: "-1" }, words);
    var tn = tickNodes(ctx, it, false), acts = (it.acts ? it.acts(false) : []).filter(Boolean), go = goNode(ctx, it, false), shown = [tn.btn].concat(acts, acts.length < 2 && !it.done ? [go] : []).filter(Boolean);
    if (go && shown.indexOf(go) < 0) it.more = (it.more || []).concat(typeof it.go[0] === "function" ? { id: "hdbGo-" + it.key, text: it.go[1], label: it.go[1] + ": " + it.title, fn: it.go[0] } : { id: "hdbGo-" + it.key, text: it.go[1], href: it.go[0], label: it.go[1] + ": " + it.title });
    var more = moreBox(ctx, it), fl = UI.flash && UI.flash.key === it.key && UI.flash.q === ctx.quoteId && Date.now() < UI.flash.until;
    return h("li", { cls: "hdb-row" + (it.done ? " on" : "") + (it.kids ? " par" : "") + (shown.length ? "" : " noact") + (more ? "" : " nomore") + (fl ? " is-flash" : "") }, [tn.lead || icon(it.done ? "✓" : "", it.done ? "ok" : ""), main, shown.length ? h("div", { cls: "hdb-act" }, shown) : null, more,
      open ? h("div", { cls: "hdb-det", id: did }, det.map(function (x) { return typeof x === "string" ? h("p", { text: x }) : x; })) : null, it.form || null,
      it.kids && it.kids.length ? h("ul", { cls: "hdb-list hdb-kids", "aria-label": it.title }, it.kids.map(function (k) { return rowNode(ctx, k); })) : null]);
  }
  function list(ctx, rows) { return rows.length ? h("ul", { cls: "hdb-list" }, rows.map(function (r) { return rowNode(ctx, r); })) : null; }
  function fold(key, text, kids, hide) {
    var d = h("details", { cls: "ep-more hdb-fold", "data-key": key }, [h("summary", { id: "hdbF-" + key }, hide ? [h("span", { cls: "s", text: text }), h("span", { cls: "h", text: hide })] : [text])].concat(kids));
    d.open = !!UI.folds[key]; d.addEventListener("toggle", function () { UI.folds[key] = d.open; }); return d;
  }
  // "Do these first" -> the line itself: opened, scrolled to the middle, lit up for a moment, and focused (R257: before, only the focus moved and nothing was seen)
  function calm() { try { return global.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; } }
  function jump(ctx, it) {
    if ((it.detail || []).some(Boolean)) UI.open[ctx.quoteId + ":" + it.key] = true;
    UI.folds[it.sec] = UI.folds[it.sec] || !!it.folded; UI.flash = { q: ctx.quoteId, key: it.key, until: Date.now() + 2400 }; repaint(ctx.quoteId, true);
    var n = doc.getElementById("hdbT-" + it.key), row = n && n.closest ? n.closest(".hdb-row") : null; if (!n) return;
    try { (row || n).scrollIntoView({ block: "center", behavior: calm() ? "auto" : "smooth" }); } catch (e) {}
    try { n.focus({ preventScroll: true }); } catch (e) {}
    if (global.setTimeout) global.setTimeout(function () { UI.flash = null; var m = doc.getElementById("hdbT-" + it.key), r = m && m.closest ? m.closest(".hdb-row") : null; if (r) r.classList.toggle("is-flash", false); }, 2500);
  }

  var SHORT = { vendors: "vendor calls", headcount: "guest count", crew_call: "crew call times", load_list: "load list", transport: "trucks", venue_access: "venue access", power: "power and generator", permits: "permits", weather: "rain plan", runsheet: "run-sheet", client: "client timings" };
  function lineGo(ctx, key) {
    var q = enc(ctx.quoteId);
    return { vendors: ["vendors.html?tab=requests&quote=" + q, "Open vendors"], headcount: ["event.html?id=" + q, "Open event"], client: ["event.html?id=" + q, "Open event"], crew_call: onOps() ? null : ["ops.html?quote=" + q, "Open Tasks & Crew"],
      load_list: ["resources.html?quote=" + q, "Open Resource plan"], runsheet: ["runsheet.html?quote=" + q, "Open run-sheet"], transport: ["logistics.html?quote=" + q, "Open Logistics"], permits: ["logistics.html?quote=" + q, "Open Logistics"],
      venue_access: ["logistics.html?quote=" + q, "Open Logistics"] }[key] || null;
  }
  function onOps() { return /(^|\/)ops(\.html)?$/.test(String((global.location && global.location.pathname) || "")); }
  // one of the 11 Day-before ticks (0396); kids = the Logistics rows about the same thing (the tick is never set by them); fact = what Helm can see about it
  function lineItem(ctx, key, kids, kidWords, fact) {
    var d = lines().filter(function (x) { return x[0] === key; })[0]; if (!d) return null;
    var p = ctx.plan || {}, c = (p.checks || {})[key] || {}, on = !!c.done, lt = lineTask(ctx.tasks, d[1]), fk = "line:" + key, aid = "hdbAs-" + key, T = TS();
    var late = !!(lt && lt.held && T.isLate && T.isLate(lt.t, ctx.now)), who = lt ? nameOf(ctx, lt.t) : "", chp = null, urg = null, sub = "", undone = !on && c.by ? byWords(c.by, c.at, ctx, "Unticked") : "";
    var counted = (kids || []).filter(function (k) { return !k.na; }), kdone = counted.filter(function (k) { return k.done; }).length, allKids = counted.length && kdone === counted.length, kw = counted.length ? kidWords(kdone, counted.length) : "";
    if (on) sub = dots([fact, kw, lt && lt.held ? "With " + who + " · " + ((T.LABEL && T.LABEL[lt.key]) || lt.key) : lt && lt.key === "done" ? who + " · Done" : ""]);
    else {
      var st = !lt ? "" : lt.key === "rejected" ? "By " + who : lt.key === "unassigned" ? "Task made, not given out" : lt.key === "done" ? "Their task is done - tick the line if you agree." : "With " + who + " · " + ((T.LABEL && T.LABEL[lt.key]) || lt.key);
      if (lt && lt.key === "done") st = who + " · " + st;
      sub = dots([fact, kw ? kw + (allKids ? " · Rows are done - tick if you agree" : "") : "", st || (counted.length || fact ? "" : undone)]);
      if (lt && lt.free) { chp = lt.key === "rejected" ? ["Turned down", "bad"] : ["Nobody on it", "warn"]; urg = { rank: 4, why: chp[0], rest: lt.key === "rejected" ? "by " + who : "", say: SHORT[key] + (lt.key === "rejected" ? " turned down" : " has nobody on it") }; }
      else if (late) { chp = ["Late", "bad"]; urg = { rank: 1, why: "Late", rest: "with " + who, say: SHORT[key] + " late" }; }
    }
    var can = !on && canGive(ctx) && (!lt || lt.free), giveIt = function (back) { openForm(ctx, { key: fk, need: "people", back: back }); };
    var L = key === "permits" || key === "transport" || key === "headcount" ? S(ctx.quoteId) : null, cid = "epChk-" + key;
    return { key: "line-" + key, sec: groupOf(key), done: on, hand: true, title: d[1], fact: sub, who: on ? byWords(c.by, c.at, ctx) : "", chip: chp, urg: urg, kids: kids, go: lineGo(ctx, key),
      tick: { id: cid, on: on, can: !!p.can_edit, fn: function () { run(ctx, cid, "save the tick", async function () { await store().ops.dayPlan.check(ctx.quoteId, key, !on); if (ctx.onChanged) await ctx.onChanged(); }); } },
      acts: can && lt ? function (top) { return [btn(topId(top, aid), "Give to someone", function () { giveIt(aid); }, { label: "Give to someone: " + d[1], exp: top ? null : isOpenForm(ctx, fk) ? "true" : "false" })]; } : null,
      more: [can && !lt ? { id: aid, text: "Give to someone", label: "Give to someone (optional): " + d[1], fn: giveIt } : null,
        L && L.logistics.state === "ok" && L.perms && L.perms.logisticsEdit ? { id: "hdbAd-" + key, text: "Add a line", href: "logistics.html?quote=" + enc(ctx.quoteId), label: "Add a line in Logistics: " + d[1] } : null],
      detail: [d[2].charAt(0).toUpperCase() + d[2].slice(1) + ".", undone && sub.indexOf(undone) < 0 ? undone : null],
      form: isOpenForm(ctx, fk) ? assignForm(ctx, { title: d[1] }, lt) : null };
  }
  // the Readiness checks, one line each, spread over the sections they are about
  function readyItems(ctx, s, sees) {
    var EP = global.HelmEventPlan, r = s.ready.data && s.ready.data.r; if (!r || !EP || !EP.readySum) return {};
    // a list that could not be read is never shown as fine
    r = EP.readyMask ? EP.readyMask(r, { vendors: s.vendors.state !== "error", stock: s.stock.state !== "error" }, "Couldn't check") : r;
    var sum = EP.readySum(r), q = enc(ctx.quoteId), out = {};
    function one(c, ok) {
      var g = RD_GO[c.key], shown = (c.key === "vendors" && s.vendors.state === "ok") || (c.key === "stock" && s.stock.state === "ok"), key = "rd-" + c.key, it;   // these two are listed line by line below
      it = { key: key, sec: RD[c.key] || "final", done: ok, title: c.label, sr: ok ? "Done: " : c.unchecked ? "Not checked: " : "Not done: ", fact: ok && !/^\d{4}-\d{2}-\d{2}$/.test(c.detail || "") && !/^(yes|done|none|no shortages)$/i.test(c.detail || "") ? c.detail : ok ? "" : c.key === "vendors" && sees.vend ? sees.vend : c.detail, why: c.key === "vendors" && sees.vendWhy ? sees.vendWhy : "", lead: icon(ok ? "✓" : c.unchecked ? "?" : c.critical ? "✕" : "!", ok ? "ok" : c.critical ? "bad" : "warn"), go: g ? [g[0] + q, g[1]] : null,
        urg: !ok && c.critical && !c.hidden && !shown ? { rank: 6, why: "", rest: c.detail || "Not done" } : null };
      if (c.signoff) return signLine(ctx, s, c, it);
      return autoLine(ctx, it);
    }
    sum.open.concat(sum.ok).forEach(function (c) { var it = one(c, !!c.ok); (out[it.sec] = out[it.sec] || []).push(it); });
    (sum.hidden || []).forEach(function (c) { var sec = RD[c.key] || "final"; (out[sec] = out[sec] || []).push({ key: "rd-" + c.key, sec: sec, done: false, quiet: true, title: c.label, fact: c.detail, lead: icon("–", "") }); });
    return out;
  }
  // Dry run done / Team briefed: the Readiness sign-off (the same switch as the Readiness page); who = the stored tick beside it (0442)
  function signLine(ctx, s, c, it) {
    var m = markOf(ctx, it.key), real = !!c.ok, on = real || !!(m && m.done), id = "hdbMk-" + it.key, may = !!(s.perms && s.perms.readyEdit);
    it.hand = true; it.done = on; it.lead = null; it.fact = ""; it.who = on ? (m && m.done && byWords(m.by, m.at, ctx)) || "Done" : ""; if (on) it.urg = null; else it.fact = "Not done yet";
    if (on && !real) it.who = byWords(m.by, m.at, ctx, "Marked done") + ", not signed off on the Readiness page";
    it.tick = { id: id, on: on, can: may || canMark(ctx), fn: function () { run(ctx, id, "save the tick", async function () {
      if (may) await store().readiness.setSignoff(ctx.quoteId, c.signoff, !on);
      if (canMark(ctx)) { try { await saveMark(ctx, it.key, !on); } catch (e) { if (!may) throw e; } }
      await loadGroup(ctx.quoteId, "ready", true); if (ctx.onData) ctx.onData();
    }); } };
    return it;
  }
  function vendorItems(ctx, s) {
    var d = s.vendors.data, p = s.perms || {}, out = []; if (s.vendors.state === "hidden" || !d) return out;
    vendorRows(d.bookings, d.vendors).forEach(function (v) {
      var tel = String(v.phone || "").replace(/[^0-9+]/g, ""), fk = "job:" + v.id, jid = "hdbJob-" + v.id, cid = "hdbCf-" + v.id, T = TS(), bad = 0, wait = 0;
      var mine = (ctx.tasks || []).filter(function (t) { return t && v.vendorId && String(t.vendor_id || "") === String(v.vendorId) && t.status !== "cancelled"; });
      mine.forEach(function (t) { var k = T.baseKey ? T.baseKey(t) : "waiting"; if (k === "rejected") bad++; else if (k === "waiting") wait++; });
      function confirm() {
        run(ctx, cid, "mark the vendor confirmed", async function () {
          await store().bookings.update(v.id, { status: "confirmed" }); await loadGroup(ctx.quoteId, "vendors");
          var now = S(ctx.quoteId).vendors, b = now.data && now.data.bookings.filter(function (x) { return x.id === v.id; })[0];
          if (now.state === "ok" && b && b.status === "confirmed") { say(ctx, v.name + " is confirmed.", "ok"); againReady(ctx); } else say(ctx, "That was not saved. You may not be allowed to change vendors.", "err");
        });
      }
      var canCf = v.canConfirm && p.vendorsEdit, canCall = phoneOk(tel), what = v.what.replace(/\s*\(stock shortfall\)\s*$/i, ""), job = mine.length ? plural(mine.length, "job") + (bad ? ", " + (bad > 1 ? bad + " " : "") + "turned down" : wait ? ", not accepted yet" : "") : "";
      out.push(autoLine(ctx, { key: "vn-" + v.id, sec: "vendors", done: v.done, title: v.name, fact: dots([v.label, what, job]), why: "the booking is not confirmed", chip: v.done ? (bad ? ["Job turned down", "bad"] : null) : ["Not confirmed", "warn"],
        urg: v.done ? null : { rank: 3, why: "Not confirmed", rest: what, say: "", nc: v.name }, lead: icon(v.done ? "✓" : "!", v.done ? "ok" : "warn"), sr: v.done ? v.label + ": " : "", go: ["vendors.html", "Open vendors"],
        acts: function (top) {
          return [canCf && !(markOf(ctx, "vn-" + v.id) || {}).done ? btn(topId(top, cid), "Mark confirmed", confirm, { label: "Mark " + v.name + " confirmed", busy: cid }) : null, canCall ? goLink(topId(top, "hdbCall-" + v.id), "tel:" + tel, "Call", "Call " + v.name + ", " + v.phone) : null];
        },
        more: [v.vendorId && canGive(ctx) ? { id: jid, text: "Give a job", label: "Give " + v.name + " a job (optional)", fn: function (back) { openForm(ctx, { key: fk, need: "people", back: back, text: nlTitle("Confirm arrival and set-up time" + (v.what ? " - " + v.what : "")) }); } } : null],
        detail: [dots([v.label, v.what, v.qty ? plural(v.qty, "unit") : ""]), canCall ? "Phone " + v.phone : "No phone saved."].concat(mine.slice(0, 3).map(function (t) {
          var k = T.baseKey ? T.baseKey(t) : "waiting"; return "Job: " + (t.title || "task") + " · " + ((T.LABEL && T.LABEL[k]) || k); }), mine.length > 3 ? "+ " + (mine.length - 3) + " more jobs" : null),
        form: isOpenForm(ctx, fk) ? assignForm(ctx, { vendorId: v.vendorId, name: v.name }) : null }));
    });
    return out;
  }
  function sourcedWords(src, vendors) {
    var by = {}; (vendors || []).forEach(function (v) { by[v.id] = v.name; });
    return src.map(function (x) { return (by[x.b.vendor_id] || "a vendor") + " · " + (BK[x.b.status] || x.b.status); }).join(", ");
  }
  // "Get from a vendor": null without the right to change vendors
  function getMain(ctx, s, o) {
    var p = s.perms || {}, q = ctx.quoteId, V = global.HelmStockVendor; if (!p.vendorsEdit) return null;
    if (!V || typeof V.open !== "function") return function (top) { return goLink(topId(top, o.id), "resources.html?quote=" + enc(q), "Get from a vendor", "Get " + o.label + " from a vendor (Resource plan)"); };
    return function (top) {
      return btn(topId(top, o.id), "Get from a vendor", function () {
        V.open({ quoteId: q, label: o.label, qty: o.qty, itemId: o.itemId || null, layoutType: o.layoutType || null, onDone: function () { loadGroup(q, "vendors"); loadGroup(q, "stock"); againReady(ctx); if (ctx.onChanged) ctx.onChanged(); } });
      }, { label: "Get " + fmt(o.qty) + " " + o.label + " from a vendor" });
    };
  }
  function acts1(f) { return f ? function (top) { return [f(top)]; } : null; }
  function stockModel(s) {
    var d = s.stock.data; if (!d || !d.layout) return null; var v = s.vendors.state === "ok" ? s.vendors.data : null;
    return stockRows({ layout: d.layout, reservations: d.reservations, checkouts: d.checkouts, shortages: d.shortages, needs: v ? v.needs : [], bookings: v ? v.bookings : [], requests: v ? v.requests : [] });
  }
  // "Need 120, have 100 - 20 to reserve" (what is not in stock is the "Missing" chip): have = held for this event + what a vendor said yes to; only asked = said apart
  function stockWords(r) {
    var have = Math.min(r.held + r.firm, r.needed), asked = Math.min(Math.max(r.got - r.firm, 0), Math.max(r.needed - have, 0)), todo = [];
    if (r.toReserve) todo.push(fmt(r.toReserve) + " to reserve");
    return "Need " + fmt(r.needed) + ", have " + fmt(have) + (asked ? ", " + fmt(asked) + " asked from a vendor" : "") + (todo.length ? " - " + todo.join(", ") : "");
  }
  function stockItems(ctx, s, m) {
    var q = enc(ctx.quoteId), vs = s.vendors.data && s.vendors.data.vendors, out = []; if (!m) return out;
    m.rows.forEach(function (r) {
      var get = r.toGet ? getMain(ctx, s, { id: "hdbGet-" + r.id, label: r.name, qty: r.toGet, itemId: r.id, layoutType: r.types[0] }) : null, rh = "inventory.html?quote=" + q + "&tab=layout", rt = "Reserve " + fmt(r.toReserve);
      var todo = []; if (r.toReserve) todo.push(fmt(r.toReserve) + " free in stock - reserve them"); if (r.toGet) todo.push(fmt(r.toGet) + " not in stock - get them from a vendor");
      var why = r.state === "short" ? fmt(r.toGet) + " missing" : r.state === "reserve" ? fmt(r.toReserve) + " to reserve" : r.state === "asked" ? "the vendor has not confirmed" : "";
      out.push(autoLine(ctx, { key: "st-" + r.id, sec: "stock", done: r.done, title: r.name, fact: dots([stockWords(r), "reserved " + fmt(r.reserved), "given out " + fmt(r.out)]), why: why, chip: r.state === "short" ? ["Missing " + fmt(r.toGet), "bad"] : r.state === "asked" ? ["Not confirmed", "warn"] : null, sr: r.done ? "Covered: " : "",
        urg: r.state === "short" ? { rank: 2, why: "Missing " + fmt(r.toGet), rest: "need " + fmt(r.needed), short: r.name } : r.state === "reserve" ? { rank: 5, why: fmt(r.toReserve) + " to reserve", rest: "need " + fmt(r.needed), res: r.name } : null,
        lead: icon(r.done ? "✓" : r.state === "short" ? "✕" : "!", r.done ? "ok" : r.state === "short" ? "bad" : "warn"), go: r.toReserve && !get ? null : [rh, "Open stock"],
        acts: acts1(get || (r.toReserve ? function (top) { return goLink(topId(top, "hdbRes-" + r.id), rh, rt, rt + " " + r.name); } : null)),
        more: [get && r.toReserve ? { id: "hdbRes-" + r.id, text: rt, href: rh, label: rt + " " + r.name } : null],
        detail: ["Needed " + fmt(r.needed) + " · Reserved " + fmt(r.reserved) + " · Given out " + fmt(r.out) + " · Missing " + fmt(r.missing), todo.length ? todo.join("; ") + "." : null, r.sourced.length ? "From " + sourcedWords(r.sourced, vs) : null,
          r.shared && !r.done ? "Other events on the same days need " + fmt(r.shared) + " of these too." : null] }));
    });
    m.otherShort.forEach(function (x) {
      out.push(autoLine(ctx, { key: "sh-" + x.id, sec: "stock", done: false, title: x.label, fact: "Not on the floor plan, no vendor yet", why: fmt(x.qty) + " missing", chip: ["Missing " + fmt(x.qty), "bad"], urg: { rank: 2, why: "Missing " + fmt(x.qty), rest: "no vendor yet", short: x.label }, lead: icon("✕", "bad"),
        acts: acts1(getMain(ctx, s, { id: "hdbGetS-" + x.id, label: x.label, qty: x.qty, itemId: x.itemId })), go: ["resources.html?quote=" + q, "Open Resource plan"], detail: [x.label + " × " + fmt(x.qty) + ". Short in stock, no vendor yet (not on the floor plan)."] }));
    });
    return out;
  }
  function unlinkedBox(ctx, s, m) {
    if (!m || !m.unlinked.length) return null; var q = enc(ctx.quoteId), vs = s.vendors.data && s.vendors.data.vendors;
    return fold("stock-un", plural(m.unlinked.length, "product") + " not linked to stock", [
      h("p", { cls: "hdb-note" }, ["Link them once and Helm counts them against stock. ", link("inventory.html?quote=" + q + "&tab=layout", "Link in Inventory →")]),
      list(ctx, m.unlinked.map(function (u) {
        return { key: "un-" + u.type, sec: "stock", title: u.label, fact: dots([fmt(u.objects) + " on the plan", u.seats && u.seats !== u.objects ? plural(u.seats, "seat") : "", u.sourced.length ? "From " + sourcedWords(u.sourced, vs) : ""]), lead: icon("?", ""),
          acts: acts1(u.sourced.length ? null : getMain(ctx, s, { id: "hdbGetT-" + u.type, label: u.label, qty: u.objects, layoutType: u.type })) };
      }))]);
  }
  function checkItem(ctx, s, c) {
    var can = !!(s.perms && s.perms.logisticsEdit), done = c.status !== "open", words = c.section === "guests" ? GST : CHK, tid = "hdbCk-" + c.id, nid = "hdbNa-" + c.id, oid = "hdbOw-" + c.id, fk = "owner:" + c.id, key = "ck-" + c.id, mk = markOf(ctx, key);
    function save(id, patch, what) {
      return run(ctx, id, what, async function () {
        await store().checklist.update(c.id, patch); await loadGroup(ctx.quoteId, "logistics");
        var now = S(ctx.quoteId).logistics, x = now.data && now.data.rows.filter(function (y) { return y.id === c.id; })[0], k = Object.keys(patch)[0];
        if (now.state !== "ok" || !x || String(x[k] || "") !== String(patch[k] || "")) { say(ctx, "That was not saved. You may not be allowed to change Logistics.", "err"); return; }
        if (patch.owner !== undefined) UI.form = null;
        if (patch.status && canMark(ctx)) try { await saveMark(ctx, key, patch.status === "done"); } catch (e) {}   // who + when; the row itself is saved
      });
    }
    var today = TS().ymdIn ? TS().ymdIn(ctx.tz, ctx.now) : "", over = c.status === "open" && c.due_date && today && c.due_date < today, form = null;
    if (isOpenForm(ctx, fk)) {
      var P = s.owners || { state: "wait", list: [] }, of = function (k) { return P.list.filter(function (x) { return x.kind === k; }).map(function (x) { return h("option", { value: x.name, text: x.name + (x.role ? " · " + x.role : "") }); }); };
      var own = P.list.some(function (x) { return x.name === c.owner; }) || !c.owner ? null : h("option", { value: c.owner, text: c.owner });
      form = formBox(ctx, pick("Owner of “" + c.title + "”", [h("option", { value: "", text: P.state === "wait" ? "Loading people…" : "Nobody" }), own, group("Staff", of("staff")), group("Vendors", of("vendor"))], true).concat([
        P.state === "error" ? h("p", { cls: "hdb-fail", role: "status" }, ["Couldn't load your people ", btn("hdbOwRetry", "Try again", function () { loadOwners(ctx.quoteId); repaint(ctx.quoteId, true); })]) : null,
        h("p", { cls: "ep-hint", id: "hdbHint", text: "Optional. A name on the line only - nobody is e-mailed." })].filter(Boolean)), "Save owner", function () { if (P.state === "ok") save("hdbGo", { owner: UI.form.val || null }, "save the owner"); });
    }
    function setDone() { save(tid, { status: c.status === "done" ? "open" : "done" }, "update the line"); }
    var guests = c.section === "guests" && c.qty != null ? plural(c.qty, "guest") : "", due = c.due_date ? dateWords(c.due_date) : "", own2 = c.owner ? "Owner: " + c.owner : "";
    return { key: key, sec: "logistics", done: done, na: c.status === "na", hand: true, title: c.title, fact: dots([guests, own2, due && !done ? "Due " + due : ""]), who: c.status === "done" && mk && mk.done ? byWords(mk.by, mk.at, ctx) : "", chip: over ? ["Overdue", "bad"] : c.status === "na" ? [words.na, ""] : null,
      urg: over ? { rank: 1, why: "Overdue", rest: dots(["due " + due, c.owner]), say: c.title.replace(/\s*\/\s*\S+/, "") + " overdue", due: c.due_date } : null,
      tick: c.status === "na" ? null : { id: tid, on: c.status === "done", can: can, fn: setDone, box: true }, lead: c.status === "na" ? icon("–", "") : null,
      more: [can && c.status !== "done" ? { id: nid, text: c.status === "na" ? "Reopen" : "Mark " + (c.section === "guests" ? "declined" : "N/A"), label: (c.status === "na" ? "Reopen: " : "Mark " + words.na + ": ") + c.title, fn: function () { save(nid, { status: c.status === "na" ? "open" : "na" }, "update the line"); } } : null,
        can && c.status === "open" && c.section !== "guests" ? { id: oid, text: c.owner ? "Change owner" : "Pick an owner", label: (c.owner ? "Change owner of: " : "Pick an owner for: ") + c.title, fn: function (back) { openForm(ctx, { key: fk, need: "owners", back: back, val: c.owner }); } } : null],
      detail: [c.detail || null, done && due ? "Due " + due : null], form: form };
  }

  /* ---- your own lines (0442) ---- */
  function uuid() { try { if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID(); } catch (e) {} return null; }
  function ownItems(ctx) {
    var d = marksOf(ctx), st = stepOf(ctx); if (!d) return [];
    return d.lines.filter(function (l) { return l && l.step === st; }).map(function (l) {
      var rid = "hdbOwnX-" + l.id;
      return handLine(ctx, { key: "own:" + l.id, sec: "own", title: String(l.title || ""), own: true, more: [canMark(ctx) ? { id: rid, text: "Take it off the list", label: "Take off the list: " + l.title, fn: function () { run(ctx, rid, "take the line off", async function () {
        if (global.BPUI && global.BPUI.confirm && !(await global.BPUI.confirm("Take “" + l.title + "” off the checklist? What was ticked stays in the history.", { title: "Take this line off?", okLabel: "Take it off" }))) return;
        await store().ops.checks.cancelLine(l.id); await loadGroup(ctx.quoteId, "marks"); }); } } : null], detail: [byWords(l.by, l.at, ctx, "Added")] });
    });
  }
  function ownForm(ctx) {
    if (!canMark(ctx) || ctx.closed) return null; var st = stepOf(ctx), k = ctx.quoteId + ":" + st, iid = "hdbOwn" + sfx(ctx), gid = "hdbOwnGo" + sfx(ctx);
    var inp = h("input", { id: iid, cls: "ep-inp hdb-inp", type: "text", maxlength: "120", autocomplete: "off", placeholder: st === "pre" ? "e.g. Cake table ready" : "e.g. Return gifts collected", "aria-label": "Add your own line" }); inp.value = UI.own[k] || "";
    inp.addEventListener("input", function () { UI.own[k] = inp.value; });
    return h("form", { cls: "hdb-own", novalidate: "", on: { submit: function (e) {
      e.preventDefault(); var t = nlTitle(inp.value); if (!t) { say(ctx, "Type the line first.", "err"); return; } if (/[<>]/.test(t)) { say(ctx, "Leave out < and >.", "err"); return; }
      var id = UI.ownId && UI.ownId.k === k && UI.ownId.t === t ? UI.ownId.id : uuid(); UI.ownId = { k: k, t: t, id: id };   // a second try of the same line is the same line
      run(ctx, gid, "add the line", async function () { var r = await store().ops.checks.addLine(ctx.quoteId, st, t, id); UI.own[k] = ""; UI.ownId = null; if (r && r.same) say(ctx, "That line is on the list already.", "ok"); await loadGroup(ctx.quoteId, "marks"); });
    } } }, [inp, h("button", { type: "submit", id: gid, cls: "tc-btn sm hdb-btn", text: "+ Add line", "aria-disabled": UI.busy[gid] ? "true" : null })]);
  }
  var ACT = { done: "Done", undo: "Undone", add: "Line added", cancel: "Line taken off" };
  function historyBox(ctx, titles) {
    var d = marksOf(ctx), pre = stepOf(ctx) + ":"; if (!d) return null; var names = {};
    d.log.forEach(function (g) { if (g.action === "add" || g.action === "cancel") names[g.key] = g.note; });
    var l = d.log.filter(function (g) { return String(g.key || "").indexOf(pre) === 0; }); if (!l.length) return null;
    return fold("hist" + sfx(ctx), "Who ticked what (" + l.length + ")", [h("ul", { cls: "hdb-hist" }, l.slice(0, 40).map(function (g) {
      var k = String(g.key).slice(pre.length), t = titles[k] || titles["line-" + k] || names[g.key] || "A line";
      return h("li", {}, [h("b", { text: t }), " - " + byWords(g.by || "someone", g.at, ctx, ACT[g.action] || g.action)]);
    }))]);
  }

  /* ---------------- the card ---------------- */
  function sigOf(ctx, s) {
    var T = TS(), tk = (ctx.tasks || []).map(function (t) { return t && [t.id, t.title, t.category, t.status, t.step, t.planned_start, t.crew_id, t.vendor_id, t.assignee_name, T.isLate && T.isLate(t, ctx.now)]; }), f = floorOf(ctx.quoteId);
    try { return JSON.stringify([ctx.quoteId, ctx.step, ctx.noReady, ctx.compact, ctx.closed, ctx.eventDate, ctx.plan && [ctx.plan.can_edit, ctx.plan.checks], ctx.sheet, f && [f.version_no, f.guests, (f.items || []).length], tk, s.loading, s.at, s.perms, s.ready, s.vendors, s.stock, s.logistics, s.marks, s.arrivals, s.people, s.owners, UI.form, UI.busy, UI.open, UI.menu, UI.flash && UI.flash.key, startFor(ctx), !!global.HelmStockVendor, TS().ymdIn ? TS().ymdIn(ctx.tz, ctx.now) : ""]); } catch (e) { return ""; }
  }
  function flat(items) { return items.reduce(function (a, x) { return a.concat(x, x.kids || []); }, []); }
  function floorOf(q) { try { var c = global.HelmEventFloor && global.HelmEventFloor._cache && global.HelmEventFloor._cache()[q]; return (c && c.floor) || null; } catch (e) { return null; } }
  function planHref(q) { try { if (global.HelmUrl && global.HelmUrl.build) return global.HelmUrl.build("floor-plan", { id: q }); } catch (e) {} return "builder.html?quote=" + enc(q); }
  // { seats, guests } when the saved plan is known here
  function seatsFact(q) { var f = floorOf(q), EF = global.HelmEventFloor; if (!f || !EF || !EF.measure) return null; try { var m = EF.measure(f); return m.guests && m.items ? { seats: m.seats, guests: m.guests } : null; } catch (e) { return null; } }
  function waits(g) { return g.state === "wait" ? h("p", { cls: "hdb-note", text: "Checking…" }) : null; }
  // the steps' sections: add(key, title, items, o)
  function buildDay(ctx, s, add, fails) {
    var enq = enc(ctx.quoteId), q = ctx.quoteId, vr = vendorItems(ctx, s), realOk = s.vendors.state === "ok" && s.vendors.data ? vendorRows(s.vendors.data.bookings, s.vendors.data.vendors) : [], vc = realOk.filter(function (v) { return v.done; }).length, no = realOk.length - vc;
    var sees = { vend: realOk.length ? vc + " of " + realOk.length + " confirmed" : "", vendWhy: no > 0 ? isAre(no, "vendor", "", "not confirmed") : "" };
    var R = !ctx.noReady && s.ready.state !== "hidden" ? readyItems(ctx, s, sees) : {}, rd = function (k) { return R[k] || []; };
    function tick(key, fact) { return lineItem(ctx, key, null, null, fact); }
    var readyFail = !ctx.noReady && s.ready.state === "error" && !s.ready.data ? fails(s.ready, "the plan", "ready") : null;
    // vendors
    add("vendors", "Vendors", [].concat(rd("vendors"), vr, tick("vendors", sees.vend)), { g: s.vendors, fail: fails(s.vendors, "the vendors", "vendors"), tops: [waits(s.vendors), s.vendors.state === "ok" && !vr.length ? h("p", { cls: "hdb-note", text: "No vendors booked." }) : null, s.vendors.state === "hidden" ? h("p", { cls: "hdb-note", text: "Vendor bookings are not visible to you." }) : null],
      links: [s.vendors.state === "ok" && s.perms && s.perms.resources ? link("resources.html?quote=" + enq, "Resource plan →") : null] });
    // menu + guest count (the Logistics guest list sits under its tick)
    var ck = s.logistics.state === "ok" && s.logistics.data ? s.logistics.data.rows : [], canL = s.perms && s.perms.logisticsEdit, seeL = s.logistics.state === "ok";
    var rowsOf = function (x) { return ck.filter(function (c) { return c.section === x; }).map(function (c) { return checkItem(ctx, s, c); }); }, guestRows = ck.filter(function (c) { return c.section === "guests"; });
    var gAll = guestRows.reduce(function (n, c) { return n + (c.status === "na" ? 0 : n0(c.qty)); }, 0), gYes = guestRows.reduce(function (n, c) { return n + (c.status === "done" ? n0(c.qty) : 0); }, 0);
    var LW = { compliance: function (d, n) { return d + " of " + n + " in hand"; }, logistics: function (d, n) { return d + " of " + n + " ready"; }, guests: function (d, n) { return gAll ? fmt(gYes) + " of " + plural(gAll, "guest") + " confirmed" : d + " of " + n + " confirmed"; } };
    add("menu", "Menu and guest count", rd("menu").concat(lineItem(ctx, "headcount", rowsOf("guests").map(function (x) { x.sec = "menu"; return x; }), LW.guests)), { g: s.logistics });
    // plan and floor layout
    var sm = stockModel(s), types = sm ? sm.types : s.stock.data && s.stock.data.floor, bh = planHref(q), seats = (types || []).reduce(function (n, t) { return n + t.seats; }, 0), sf = seatsFact(q), pi = [];
    if (types) pi.push(autoLine(ctx, { key: "plan-layout", sec: "plan", done: types.length > 0, title: "2D / 3D layout saved", fact: types.length ? planWords(types) : "Nothing on the floor plan yet", lead: icon(types.length ? "✓" : "!", types.length ? "ok" : "warn"), go: [bh, "Open 2D / 3D plan"] }));
    if (sf) pi.push(autoLine(ctx, { key: "plan-seats", sec: "plan", done: sf.seats >= sf.guests, title: "A seat for every guest", fact: plural(sf.seats, "seat") + " for " + plural(sf.guests, "guest") + (sf.seats < sf.guests ? " - " + fmt(sf.guests - sf.seats) + " short" : ""), why: fmt(Math.max(sf.guests - sf.seats, 0)) + " seats are short", lead: icon(sf.seats >= sf.guests ? "✓" : "!", sf.seats >= sf.guests ? "ok" : "warn"), go: [bh, "Open 2D / 3D plan"] }));
    add("plan", "Plan and floor layout", pi.concat(rd("plan").filter(function (x) { return !(types && x.key === "rd-layout"); })), { g: s.stock, tops: [!types && s.stock.state === "wait" ? waits(s.stock) : null, !types && s.stock.state === "hidden" ? h("p", { cls: "hdb-note", text: "The floor plan is not visible to you." }) : null], end: [unlinkedBox(ctx, s, sm)], links: [link(bh, "2D / 3D plan →")] });
    // stock
    var heldAll = sm ? sm.rows.reduce(function (n, r) { return n + r.reserved; }, 0) : 0, outAll = sm ? sm.rows.reduce(function (n, r) { return n + Math.min(r.out, r.reserved || r.out); }, 0) : 0, st = stockItems(ctx, s, sm), shown = st, cov = st.filter(function (x) { return x.done && !x.byHand; });
    if (cov.length > 6) shown = st.filter(function (x) { return cov.indexOf(x) < 0; });   // a long list of covered items folds away; what is open never does
    add("stock", "Inventory and stock", [].concat(rd("stock"), shown, tick("load_list", heldAll ? fmt(outAll) + " of " + fmt(heldAll) + " pieces given out" : "")), { g: s.stock, more: cov.length > 6 ? cov : [], fail: s.stock.state === "hidden" && !s.stock.data ? null : fails(s.stock, "the stock", "stock"),
      links: [sm ? link("inventory.html?quote=" + enq, "Stock →", "Stock for this event") : null],
      tops: [s.stock.state === "hidden" && !s.stock.data ? null : waits(s.stock),
        s.stock.state === "hidden" ? h("p", { cls: "hdb-note" }, s.perms && s.perms.inventory ? ["Not counted against stock here. ", link("inventory.html?quote=" + enq, "Open Inventory →")] : ["Stock numbers are not visible to you."]) : null,
        sm && sm.short && s.vendors.state !== "ok" && s.vendors.state !== "wait" ? h("p", { cls: "hdb-note", text: "Vendor bookings are not counted here, so a vendor may already be asked for what is missing." }) : null],
      end: [sm && sm.extra ? h("p", { cls: "hdb-note", text: plural(sm.extra, "more item") + " reserved for this event (not on the plan)." }) : null, cov.length > 6 ? fold("stock", "Show " + cov.length + " covered", [list(ctx, cov)], "Hide " + cov.length + " covered") : null] });
    // logistics: a tick and the rows about the same thing are one line with its rows under it
    var li = [], comms = rowsOf("comms");
    SECTIONS_L.forEach(function (x) { li.push(x[1] ? lineItem(ctx, x[0], rowsOf(x[1]), LW[x[1]]) : lineItem(ctx, x[0])); });
    if (comms.length) li.push({ key: "grp-comms", sec: "logistics", quiet: true, done: comms.every(function (k) { return k.done; }), title: "Who tells whom", fact: comms.filter(function (k) { return k.done && !k.na; }).length + " of " + comms.filter(function (k) { return !k.na; }).length + " told", lead: icon("–", ""), kids: comms });
    add("logistics", "Logistics", li.filter(Boolean), { g: s.logistics, fail: fails(s.logistics, "logistics", "logistics"), tops: [waits(s.logistics)], links: [seeL ? link("logistics.html?quote=" + enq, canL ? "Open Logistics, add a line →" : "Open Logistics →") : null] });
    // people
    var T = TS(), tn = null, pe = [];
    if (Array.isArray(ctx.tasks) && T.baseKey && !(s.perms && !s.perms.staff)) { tn = { n: 0, un: 0, wait: 0 }; ctx.tasks.forEach(function (t) { if (!t || t.status === "cancelled") return; tn.n++; var k = T.baseKey(t); if (k === "unassigned" || k === "rejected") tn.un++; else if (k === "waiting") tn.wait++; }); }
    var toOps = onOps() ? null : ["ops.html?quote=" + enq, "Open Tasks & Crew"];
    if (tn) {
      pe.push(autoLine(ctx, { key: "tasks", sec: "people", done: tn.n > 0 && !tn.un, title: "Tasks given out", fact: tn.n ? tn.n - tn.un + " of " + tn.n + " given out" : "No tasks on this event yet", why: tn.un ? plural(tn.un, "task") + (tn.un === 1 ? " has" : " have") + " nobody on it" : "there are no tasks", lead: icon(tn.n && !tn.un ? "✓" : "!", tn.n && !tn.un ? "ok" : "warn"), urg: tn.un ? { rank: 4, why: plural(tn.un, "task") + " not given out" } : null, go: toOps }));
      if (tn.n) pe.push(autoLine(ctx, { key: "tasks-yes", sec: "people", done: !tn.un && !tn.wait, title: "Tasks accepted", fact: tn.n - tn.un - tn.wait + " of " + tn.n + " accepted", why: isAre(tn.un + tn.wait, "task", "", "not accepted"), lead: icon(!tn.un && !tn.wait ? "✓" : "!", !tn.un && !tn.wait ? "ok" : "warn"), go: toOps }));
    }
    add("people", "People", [].concat(pe, rd("people"), tick("crew_call")), { links: [] });
    add("final", "Final checks", [].concat(rd("final"), tick("runsheet"), tick("client")), { g: ctx.noReady ? null : s.ready, fail: readyFail, tops: [!ctx.noReady && s.ready.state === "wait" ? waits(s.ready) : null] });
  }
  var SECTIONS_L = [["transport", "logistics"], ["venue_access", ""], ["power", ""], ["permits", "compliance"], ["weather", ""]];
  function slug(v) { return nl(v).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "other"; }
  function buildPre(ctx, s, add, fails) {
    var enq = enc(ctx.quoteId), T = TS(), ES = global.HelmEventSteps, a = [], set = [], ch = [], o = { eventDate: ctx.eventDate, eventTime: ctx.eventTime, tz: ctx.tz };
    // who has come
    var sm = ES && ES._pure && ES._pure.preSummary ? ES._pure.preSummary({ quoteId: ctx.quoteId, quote: { eventDate: ctx.eventDate, eventTime: ctx.eventTime }, tasks: ctx.tasks, tz: ctx.tz, sheet: ctx.sheet, noLines: true }) : null;
    var goCi = ctx.goCheckin ? [ctx.goCheckin, "Open check-in"] : ["ops.html?quote=" + enq, "Open Tasks & Crew"];
    if (sm && sm.checkedIn != null && sm.people) a.push(autoLine(ctx, { key: "crew", sec: "who", done: sm.checkedIn >= sm.people, title: "Crew checked in", fact: sm.checkedIn + " of " + sm.people + " checked in", why: isAre(sm.people - sm.checkedIn, "person", "people", "not checked in"), lead: icon(sm.checkedIn >= sm.people ? "✓" : "!", sm.checkedIn >= sm.people ? "ok" : "warn"), go: goCi }));
    else a.push(handLine(ctx, { key: "crew", sec: "who", title: "Crew checked in", fact: sm && sm.checkedIn != null ? "Nobody has pre-event work yet" : "", go: goCi }));
    var ar = s.arrivals.state === "ok" && s.arrivals.data ? s.arrivals.data.rows : null, goV = ctx.goVendors ? [ctx.goVendors, "Open vendors"] : ["command.html?quote=" + enq, "Open event-day command"];
    if (s.vendors.state === "ok" && s.vendors.data && ar) {
      var at = {}; ar.forEach(function (x) { if (x.ref) at[x.ref] = x.status; });
      var due = s.vendors.data.bookings.filter(function (b) { return b.status !== "cancelled" && b.status !== "enquiry"; }), here = due.filter(function (b) { return b.status === "delivered" || at[b.id] === "arrived" || at[b.id] === "left"; }).length;
      var vi = s.arrivals.data.items, viT = vi && global.HelmVendorItems ? global.HelmVendorItems.inLine(vi) : "", viN = vi ? vi.open.length : 0, all = here >= due.length && !viN;   // R260: items count too
      if (due.length) a.push(autoLine(ctx, { key: "vendors", sec: "who", done: all, title: "Vendors arrived", fact: here + " of " + due.length + " arrived" + (viT ? " · " + viT : ""), why: here < due.length ? isAre(due.length - here, "vendor", "", "not here yet") : isAre(viN, "vendor", "", "not checked in with all items"), lead: icon(all ? "✓" : "!", all ? "ok" : "warn"), go: goV }));
      else a.push(autoLine(ctx, { key: "vendors", sec: "who", quiet: true, done: true, title: "Vendors arrived", fact: "No vendors booked", chip: null, lead: icon("–", "") }));
    } else if (s.vendors.state !== "wait") a.push(handLine(ctx, { key: "vendors", sec: "who", title: "Vendors arrived", go: goV }));
    add("who", "People and vendors", a, { g: s.vendors, fail: fails(s.vendors, "the vendors", "vendors"), tops: [waits(s.vendors)] });
    // set-up: stock + one line per department with pre-event tasks
    var d = s.stock.data, goS = ["inventory.html?quote=" + enq, "Open stock"];
    if (d && d.reservations) {
      var by = {}; d.reservations.forEach(function (r) { if (r && (r.status === "reserved" || r.status === "allocated")) { var x = by[r.item_id] || (by[r.item_id] = { went: false }); if (r.status === "allocated") x.went = true; } });
      (d.checkouts || []).forEach(function (c) { if (c && c.status !== "cancelled") (by[c.item_id] || (by[c.item_id] = {})).went = true; });
      var ids = Object.keys(by), went = ids.filter(function (k) { return by[k].went; }).length;
      if (ids.length) set.push(autoLine(ctx, { key: "stock", sec: "set", done: went >= ids.length, title: "Stock on site", fact: went + " of " + ids.length + " items given out for this event", why: isAre(ids.length - went, "item", "", "not given out"), lead: icon(went >= ids.length ? "✓" : "!", went >= ids.length ? "ok" : "warn"), go: goS }));
      else set.push(handLine(ctx, { key: "stock", sec: "set", title: "Stock on site", fact: "Nothing is reserved from stock", go: goS }));
    } else if (s.stock.state !== "wait") set.push(handLine(ctx, { key: "stock", sec: "set", title: "Stock on site" }));
    var dep = {}, order = [];
    (ctx.tasks || []).forEach(function (t) {
      if (!t || t.status === "cancelled" || nl(t.category) === nl(CAT) || !T.taskStep || T.taskStep(t, o) !== "pre") return;
      var c = String(t.category || "Other").trim() || "Other", k = slug(c); if (!dep[k]) { dep[k] = { name: c, n: 0, done: 0 }; order.push(k); } dep[k].n++; if (T.baseKey(t) === "done") dep[k].done++;
    });
    order.forEach(function (k) {
      var x = dep[k], ok = x.done >= x.n;
      set.push(autoLine(ctx, { key: "dep-" + k, sec: "set", done: ok, title: x.name + (/set.?up$/i.test(x.name) ? " done" : " set up"), fact: x.done + " of " + plural(x.n, "task") + " done", why: isAre(x.n - x.done, "task", "", "not done"), lead: icon(ok ? "✓" : "!", ok ? "ok" : "warn"), go: onOps() ? null : ["ops.html?quote=" + enq, "Open Tasks & Crew"] }));
    });
    add("set", "Set-up", set, { g: s.stock, tops: [waits(s.stock), order.length ? null : h("p", { cls: "hdb-note", text: "No pre-event tasks yet. Each department with pre-event tasks gets its line here." })] });
    // checks on site
    var types = (stockModel(s) || {}).types || (d && d.floor), sf = seatsFact(ctx.quoteId), bf = s.ready.data && s.ready.data.r ? (s.ready.data.r.checks || []).filter(function (c) { return c && c.key === "briefing"; })[0] : null;
    ch.push(handLine(ctx, { key: "safety", sec: "checks", title: "Safety and power", detail: ["Fire exits clear, extinguishers in place, generator and cables checked, nothing to trip over."] }));
    ch.push(handLine(ctx, { key: "soundlight", sec: "checks", title: "Sound and light check", detail: ["Mics, music, screens and lights tried with the crew who run them."] }));
    ch.push(handLine(ctx, { key: "seating", sec: "checks", title: "Seating matches the plan", fact: sf ? plural(sf.seats, "seat") + " on the plan for " + plural(sf.guests, "guest") : types && types.length ? planWords(types) : "", go: [planHref(ctx.quoteId), "Open 2D / 3D plan"] }));
    ch.push(handLine(ctx, { key: "food", sec: "checks", title: "Food tasting and counters ready", detail: ["Counters, chafing dishes, crockery and labels ready; the food tasted."] }));
    ch.push(handLine(ctx, { key: "walk", sec: "checks", title: "Walk-through with the client", detail: ["Show the client the hall before guests come, note what they want changed."] }));
    ch.push(bf && !bf.hidden ? autoLine(ctx, { key: "briefed", sec: "checks", done: !!bf.ok, title: "Team briefed", fact: bf.ok ? "" : "Not marked on the Readiness page", why: "it is not marked on the Readiness page", lead: icon(bf.ok ? "✓" : "!", bf.ok ? "ok" : "warn"), go: ["ready.html?quote=" + enq, "Open Readiness"] }) : handLine(ctx, { key: "briefed", sec: "checks", title: "Team briefed" }));
    add("checks", "Checks before guests", ch, { links: [] });
  }
  function paint(host, force) {
    var st = host._hdb; if (!st) return; var ctx = st.ctx, q = ctx.quoteId, s = S(q), pre = stepOf(ctx) === "pre";
    if (!force && host.firstChild && st.q === q && inUse(host)) return;
    var sig = sigOf(ctx, s); if (sig && st.sig === sig && host.firstChild) return; st.q = q;
    var a = doc.activeElement, focusId = a && host.contains(a) ? a.id : "", gKey = "", up = focusId ? a : null, sel = a && focusId && a.tagName === "INPUT" ? [a.selectionStart, a.selectionEnd] : null;
    while (up && up !== host && !gKey) { gKey = up.getAttribute ? up.getAttribute("data-g") || "" : ""; up = up.parentNode; }
    var G = [];
    function add(key, title, items, o) {
      items = items.filter(Boolean); var all = flat(items.concat((o && o.more) || [])), c = all.filter(function (r) { return !r.quiet && !r.na; });
      G.push(Object.assign({ key: key, title: title, items: items, all: all, done: c.filter(function (r) { return r.done; }).length, of: c.length, tops: [], end: [], links: [] }, o));
    }
    function fails(g, what, k) { return g.state === "error" ? againBox(q, what, function () { s[k] = blank(); repaint(q, true); loadGroup(q, k, true); }) : null; }
    (pre ? buildPre : buildDay)(ctx, s, add, fails);
    var own = ownItems(ctx), form = ownForm(ctx);
    if (own.length || form || oldDb(ctx)) add("own", "Your own lines", own, { end: [form, !own.length && !form && !oldDb(ctx) ? h("p", { cls: "hdb-note", text: "None." }) : null, oldDb(ctx) ? h("p", { cls: "hdb-note", text: (pre ? "Ticks on this list and lines of your own need" : "Ticking the lines Helm checks, and lines of your own, need") + " database update 0442." }) : null] });
    s.left[stepOf(ctx)] = marksOf(ctx) ? G.reduce(function (n, g) { return n.concat(g.all); }, []).filter(function (x) { return !x.done && !x.quiet && !x.na && x.hand; }).map(function (x) { return x.title; }) : null;

    /* ---- the count ---- */
    var total = G.reduce(function (n, g) { return n + g.of; }, 0), doneN = G.reduce(function (n, g) { return n + g.done; }, 0), left = total - doneN, first = !s.at, bad = G.map(function (g) { return g.fail; }).filter(Boolean);
    if (s.marks.state === "error") bad.push(againBox(q, "the ticks", function () { s.marks = blank(); repaint(q, true); loadGroup(q, "marks", true); }));
    var failed = bad.length > 0 || (s.ready.state === "ok" && (s.vendors.state === "error" || s.stock.state === "error"));
    var sure = (ctx.noReady || pre || s.ready.state === "ok") && ["vendors", "stock"].concat(pre ? [] : ["logistics"]).every(function (k) { return s[k].state === "ok"; });   // what this role cannot see never counts as fine
    var all = G.reduce(function (n, g) { return n.concat(g.all); }, []), firsts = pre ? [] : all.filter(function (x) { return x.urg && !x.done; }).map(function (x, i) { return { x: x, i: i }; })
      .sort(function (m, n) { return m.x.urg.rank - n.x.urg.rank || String(m.x.urg.due || "9").localeCompare(String(n.x.urg.due || "9")) || m.i - n.i; }).map(function (z) { return z.x; });
    st.sig = sigOf(ctx, s);

    clear(host); host.classList.add("hdb"); host.setAttribute("aria-busy", s.loading ? "true" : "false");
    var wrap = h("div", { cls: "hdb-in" }); host.appendChild(wrap);
    wrap.appendChild(h("div", { cls: "hdb-head" }, [h("h3", { cls: "tc-h2", id: host.id + "H", tabindex: "-1", text: pre ? "Pre-event checklist" : "Day before checklist" }),
      h("span", { cls: "hdb-at", role: "status", text: s.loading ? "Checking…" : s.at ? "Checked " + clock(s.at, ctx.tz) : "" }),
      btn("hdbRefresh" + sfx(ctx), "Refresh", function () { if (!s.loading) load(q, ctx, true); }, { cls: "hdb-refresh", label: "Refresh the " + (pre ? "Pre-event" : "Day before") + " checklist" })]));
    wrap.appendChild(h("p", { cls: "hdb-sum", id: host.id + "Tot", text: first ? "Checking this event…" : left > 0 ? doneN + " of " + total + " done - " + left + " to go" + (failed ? ". Some parts could not be checked." : "") : failed ? doneN + " of " + total + " done. Some parts could not be checked." : sure ? "All " + total + " done" : "Everything you can see is done (" + doneN + " of " + total + ")" }));
    wrap.appendChild(h("progress", { cls: "hdb-bar" + (left <= 0 && !failed && !first ? " ok" : ""), max: String(total || 1), value: first ? "0" : String(doneN), "aria-labelledby": host.id + "Tot" }));
    var may = canMark(ctx) || (!pre && ctx.plan && ctx.plan.can_edit); if (!first && !may && !(pre && oldDb(ctx))) wrap.appendChild(h("p", { cls: "hdb-note", text: "Someone who can give out work (Assign & send tasks) ticks the lines." }));
    if (bad.length) wrap.appendChild(h("div", { cls: "hdb-fails" }, bad));

    /* ---- do these first ---- */
    if (!first && firsts.length) {
      wrap.appendChild(h("section", { cls: "hdb-first", "aria-labelledby": host.id + "G-first", "data-g": "first" }, [h("h4", { cls: "hdb-h", id: host.id + "G-first", tabindex: "-1", text: "Do these first" }),
        h("ol", { cls: "hdb-list" }, firsts.slice(0, 5).map(function (x) {
          var tk = x.tick && x.tick.can ? tickNodes(ctx, x, true).btn : null, act = (x.acts ? x.acts(true) : []).filter(Boolean), show = btn("hdbTop-show-" + x.key, "Show", function () { jump(ctx, x); }, { label: "Show the line: " + x.title });
          return h("li", { cls: "hdb-row top" }, [h("button", { type: "button", cls: "hdb-main", id: "hdbTopT-" + x.key, title: "Show the line", on: { click: function () { jump(ctx, x); } } }, [h("span", { cls: "hdb-t" }, [h("b", { text: x.title })]),
            h("span", { cls: "hdb-sub" }, [x.urg.why ? h("span", { cls: x.urg.rank < 3 || /^Turned/.test(x.urg.why) ? "bad" : "warn", text: x.urg.why }) : null, x.urg.why && x.urg.rest ? " · " : "", x.urg.rest || ""])]), h("div", { cls: "hdb-act" }, [tk, act[0] || goNode(ctx, x, true), show].filter(Boolean))]);
        })), firsts.length > 5 ? h("p", { cls: "hdb-note", text: firsts.length - 5 + " more below." }) : null]));
    }

    /* ---- the sections: always open ---- */
    var acc = h("div", { cls: "hdb-acc" }); wrap.appendChild(acc);
    G.forEach(function (g) {
      var full = g.of > 0 && g.done >= g.of && !g.fail && !(g.g && g.g.state !== "ok");
      acc.appendChild(h("section", { cls: "hdb-grp" + (full ? " ok" : ""), "data-g": g.key, "aria-labelledby": host.id + "G-" + g.key }, [
        h("h4", { cls: "hdb-sec-h", id: host.id + "G-" + g.key, tabindex: "-1" }, [g.title, g.of ? h("span", { cls: "hdb-cnt" + (full ? " ok" : ""), text: (full ? "✓ " : "") + g.done + " of " + g.of + " done" }) : null, g.fail ? h("span", { cls: "hdb-cnt", text: "Couldn't check" }) : null]),
        h("div", { cls: "hdb-body" }, g.tops.filter(Boolean).concat([list(ctx, g.items)], g.end, [g.links.some(Boolean) ? h("p", { cls: "hdb-links" }, g.links) : null]))]));
    });
    var titles = {}; all.forEach(function (x) { titles[String(x.key).toLowerCase()] = x.title; }); var hist = historyBox(ctx, titles); if (hist) wrap.appendChild(hist);

    if (focusId) {   // the same control again; when it is gone, the section's own heading
      [focusId, gKey && host.id + "G-" + gKey, host.id + "H"].some(function (i) {
        var b = i && doc.getElementById(i); if (!b) return false;
        try { b.focus({ preventScroll: true }); if (i === focusId && sel && b.setSelectionRange) b.setSelectionRange(sel[0], sel[1]); } catch (e) {}
        return doc.activeElement === b;
      });
    }
  }
  function render(host, ctx) {
    if (!host) return; ctx = ctx || {}; var q = ctx.quoteId;
    if (!host._hdb) { host._hdb = { ctx: ctx }; }
    if (host._hdb.ctx.quoteId !== q) { UI.menu = null; if (UI.form && UI.form.q !== q) UI.form = null; }   // another event: a half-filled form does not travel
    host._hdb.ctx = ctx; if (HOSTS.indexOf(host) < 0) HOSTS.push(host);
    var s = S(q), now = Date.now();
    if (q && onScreen(host) && !s.loading) {
      if (now - s.at > KEEP_MS) load(q, ctx, false);
      else {
        if (now - s.markAt > MARK_MS && !oldDb(ctx)) { s.markAt = now; loadGroup(q, "marks"); }   // what a teammate ticked
        if (ctx.step === "pre" && now - s.arrAt > ARR_MS) { s.arrAt = now; loadGroup(q, "arrivals"); }
      }
    }
    paint(host, false);
  }
  function renderPre(host, ctx) { return render(host, Object.assign({}, ctx || {}, { step: "pre" })); }
  // what a person still has to tick on that step's list (titles); null = not known (not read yet, or before 0442)
  function openLines(q, step) { var s = ST[q]; return s && s.left[step] ? s.left[step].slice() : null; }
  function reset(q) { if (q) delete ST[q]; else { ST = {}; UI.open = {}; UI.own = {}; } UI.form = null; UI.menu = null; UI.busy = {}; UI.flash = null; }
  // R260: a vendor was marked or their items were checked in on this page: the line "Vendors arrived" follows at once
  if (doc && doc.addEventListener) doc.addEventListener("helm:vendors", function () { Object.keys(ST).forEach(function (q) { if (ST[q].arrAt && ST[q].perms) loadGroup(q, "arrivals"); }); });
  // a press anywhere else closes the More menu
  if (doc && doc.addEventListener) doc.addEventListener("click", function (e) { if (UI.menu && !(e.target && e.target.closest && e.target.closest(".hdb-more"))) shut(null, false); });

  global.HelmDayBefore = { render: render, renderPre: renderPre, openLines: openLines, reset: reset, startFor: startFor, lineTask: lineTask, stockRows: stockRows, stockWords: stockWords, vendorRows: vendorRows, sourcedFor: sourcedFor, floorTypes: floorTypes, planWords: planWords,
    cleanBooking: cleanBooking, refused: refused, groupOf: groupOf, byWords: byWords, KEEP_MS: KEEP_MS, CAT: CAT, _ui: UI, _state: S };
})(typeof window !== "undefined" ? window : globalThis);
