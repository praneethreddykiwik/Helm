/* day-before.js - R252 (owner, 24 Nov 2026): the Day-before card as ONE readiness checklist, pulled from the real data and used by
 * Tasks & Crew (ops.html), the Event-day monitor (monitor.html) and Event Ready (ready.html).
 *
 *   HelmDayBefore.render(host, ctx)   the card. Called by HelmEventPlan.renderDayBefore (event-plan.js), the callers stay as they are.
 *   ctx: { plan (event_day_plan_get), tasks, quoteId, eventDate, eventTime, tz, now, nameOf(t), toast(msg, type), onChanged(),
 *          compact, locked (0397: plan locked), noReady (Event Ready shows part 1 itself) }
 *
 *   1 Booked and planned      the Readiness checks (HelmEventPlan.readyCheck) - Helm works these out
 *   2 Vendors                 event_resources: who brings what, call, Mark confirmed, Give a job
 *   3 Stock and floor plan    the 2D / 3D plan counted per product against stock (0430): needed, reserved, given out, missing
 *   4 Logistics               event_checklist: permits, transport, who tells whom, guest count
 *   5 People and programme    tasks not given out / not accepted yet, run-sheet, client
 * The 11 Day-before ticks (HelmEventPlan.DAYBEFORE, keys = the server's) sit in these groups, each exactly once, each with
 * "Assign" (optional, in the More menu): a real "Day before" task through assign_tasks / assign_tasks_vendor; never a second one while one is open.
 * On screen: one sentence + a bar, "Do these first" (at most 5), then five sections that open and close; a line = tick, title, one grey
 * line, one chip for trouble, one button, the rest behind the ... (More) button; helper words when the line is opened.
 *
 * Reads: only while the card is on screen, in parallel, kept 3 minutes per event (the 30 s redraw reads nothing). Each read needs the
 * permission of its page AND of its table (the database answers "no rows", not an error, to a refused read - so an unreadable
 * group is left out and never counts as fine). A failed read says "Couldn't check". A save is read back before it counts as saved.
 * DOM by createElement / textContent only; money fields are dropped as soon as a row is read. */
(function (global) {
  "use strict";
  var doc = global.document, KEEP_MS = 180000, CAT = "Day before";
  var BK = { enquiry: "Asked", booked: "Booked", confirmed: "Confirmed", delivered: "Delivered", cancelled: "Cancelled" };
  var CHK = { open: "Open", done: "Done", na: "N/A" }, GST = { open: "Pending", done: "Confirmed", na: "Declined" };
  var LINE_GROUP = { vendors: "vendors", load_list: "stock", transport: "logistics", permits: "logistics", headcount: "logistics",
    venue_access: "logistics", power: "logistics", weather: "logistics", crew_call: "people", runsheet: "people", client: "people" };
  var SECTIONS = [["compliance", "Permits & licences", ["permits"]], ["logistics", "Transport & deliveries", ["transport"]],
    ["guests", "Guest count", ["headcount"]], ["comms", "Who tells whom", []], ["", "Venue, power and weather", ["venue_access", "power", "weather"]]];

  var MARKS = { exit: 1, parking: 1 };   // floor-plan marks, not products: nothing to link or to get from a vendor

  /* ---------------- pure ---------------- */
  function nl(v) { return String(v == null ? "" : v).trim().toLowerCase().replace(/\s+/g, " "); }
  function n0(v) { var x = Number(v); return isFinite(x) ? x : 0; }
  function ms(v) { if (v == null || v === "") return NaN; var t = typeof v === "number" ? v : new Date(v).getTime(); return isFinite(t) ? t : NaN; }
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
    }).filter(Boolean);
  }
  function outBy(checkouts) { var r = {}; (checkouts || []).forEach(function (c) { if (c && (c.status === "out" || c.status === "partial")) r[c.item_id] = (r[c.item_id] || 0) + Math.max(n0(c.qty_out) - n0(c.qty_in), 0); }); return r; }
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
  var ST = {}, UI = { form: null, folds: {}, busy: {}, sec: {}, open: {}, menu: null };
  function S(q) { return ST[q] || (ST[q] = { at: 0, loading: false, perms: null, ready: blank(), vendors: blank(), stock: blank(), logistics: blank(), people: null, owners: null }); }
  function blank() { return { state: "wait", data: null }; }
  function store() { return global.BPStore || {}; }
  function ask(fn, name, area) {   // one permission, never throws, unknown = no
    var A = store().auth; if (!A || !A[fn]) return Promise.resolve(false);
    return Promise.resolve().then(function () { return A[fn](area); }).then(function (v) { return v === true; }, function () { return false; });
  }
  function askAll() {
    var A = store().auth || {}, v = function (a) { return ask("canView", "v", a); }, e = function (a) { return ask("canEditArea", "e", a); };
    var can = A.canAssignTasks ? ask("canAssignTasks") : e("staff");
    return Promise.all([v("vendors"), v("inventory"), v("command"), v("logistics"), v("plan"), v("staff"), e("vendors"), e("resources"), e("logistics"), e("plan"), can, v("resources")]).then(function (r) {
      return { vendors: r[0], inventory: r[1], command: r[2], logistics: r[3] && r[4], staff: r[5], vendorsEdit: r[0] && r[6] && r[7], logisticsEdit: r[8] && r[9], assign: r[10], resources: r[11] };
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
        return Promise.all([B.vendors.listAll(true), bk.some(function (b) { return b.need_id; }) && B.resources ? B.resources.listNeeds(q) : []]).then(function (r) {
          return { bookings: bk, vendors: (r[0] || []).map(cleanVendor), needs: (r[1] || []).map(function (x) { return { id: x.id, item_id: x.item_id || null, label: String(x.label || "") }; }) };
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
      return Promise.all(Object.keys(READ).filter(function (k) { return !(k === "ready" && ctx.noReady); }).map(function (k) { return loadGroup(q, k, force); }));
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
    if (/plan_locked/.test(m)) return "The plan is locked for the event day. Unlock it first.";
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
    UI.form = Object.assign({ q: ctx.quoteId, val: "", text: "", err: "" }, f); UI.menu = null; if (f.sec) secOf(ctx.quoteId).user[f.sec] = true; repaint(ctx.quoteId, true);
    if (f.need === "owners") loadOwners(ctx.quoteId); else if (f.need === "people") loadPeople(ctx.quoteId);
    var first = doc.getElementById("hdbPick") || doc.getElementById("hdbJob"); if (first) try { first.focus(); } catch (e) {}
  }
  function loadPeople(q) {
    var s = S(q), B = store(); if (s.people && s.people.state !== "error") return;
    s.people = { state: "wait", staff: [], vendors: [] };
    var v = B.vendors && B.vendors.listAll && s.perms && s.perms.vendors ? B.vendors.listAll(false).then(function (x) { return x || []; }, function () { return []; }) : Promise.resolve([]);
    Promise.all([B.ops.listCrew(), v]).then(function (r) {
      s.people = { state: "ok", staff: (r[0] || []).map(function (c) { return { id: c.id, name: String(c.name || ""), phone: String(c.phone || ""), dept: String(c.department || c.role || ""), mail: !!(c.email || c.profile_id) }; }).filter(function (c) { return c.name; }), vendors: r[1].map(cleanVendor) };
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
      if (isLocked(ctx)) throw new Error("plan_locked");
      var iso = startFor(ctx), fresh = await O.listTasks(q), ex = lineTask(fresh, title, line.vendorId);
      if (ex && ex.held) {   // someone gave it out meanwhile: never a second task
        say(ctx, "Already with " + nameOf(ctx, ex.t) + ".", "err"); UI.form = null; if (ctx.onChanged) await ctx.onChanged(); return;
      }
      if (ex && ex.free && parts[0] === "v") { f.err = "There is already a task for this that was turned down or has nobody on it. Reassign it on Tasks & Crew."; return; }
      if (parts[0] !== "v" && B.calendar && B.calendar.wouldClash && global.BPUI && global.BPUI.confirm) {
        var T = TS(), day = iso && T.ymdIn ? T.ymdIn(ctx.tz, ms(iso)) : String(ctx.eventDate || "").slice(0, 10);
        var c = await B.calendar.wouldClash({ date: day, crewId: who.id, excludeQuote: q }).catch(function () { return { clash: false }; });
        if (c && c.clash && !(await global.BPUI.confirm(who.name + " is " + c.detail + ". Give the task anyway?", { title: "Scheduling clash", okLabel: "Give anyway" }))) return;
      }
      var had = {}, timeBad = false, made = []; fresh.forEach(function (t) { had[t.id] = 1; });
      if (ex && ex.free) { await O.reassign(ex.t.id, who.id, who.name, who.phone); if (!ex.t.planned_start) made = [ex.t]; }
      else {
        if (parts[0] === "v") await O.assignTasksVendor(q, CAT, [title], who.id); else await O.assignTasks(q, CAT, [title], who.id, who.name, who.phone);
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
  function isLocked(ctx) { if (ctx.locked) return true; try { return !!(global.HelmEventFloor && global.HelmEventFloor.isLocked && global.HelmEventFloor.isLocked(ctx.quoteId)); } catch (e) { return false; } }
  function canGive(ctx) { var p = S(ctx.quoteId).perms; return !!(p && p.assign && p.staff && !isLocked(ctx)); }
  function isOpenForm(ctx, key) { return !!(UI.form && UI.form.q === ctx.quoteId && UI.form.key === key); }

  /* ---- lines: first as plain objects (so the sentence, "Do these first" and the closed sections can be worked out), then as rows ----
     { key, sec, done, quiet (not counted), na (not counted), title, sub, chip, lead, main(top) = the ONE button, more [menu items],
       detail [strings / nodes, shown when the line is opened], form, urg { rank, why, say }, kids [lines] } */
  function icon(t, cls) { return h("span", { cls: "hdb-i " + (cls || ""), "aria-hidden": "true", text: t }); }
  function tickBtn(id, on, title, can, fn) {
    return h("button", { type: "button", id: id, cls: "hdb-tick" + (on ? " on" : ""), "aria-pressed": on ? "true" : "false", disabled: can ? null : true, "aria-disabled": UI.busy[id] ? "true" : null, "aria-label": (on ? "Done: " : "Not done: ") + title, on: can ? { click: fn } : null },
      [h("span", { cls: "hdb-box", "aria-hidden": "true", text: on ? "✓" : "" })]);
  }
  function goLink(id, href, text, label) { return h("a", { id: id, cls: "tc-btn sm hdb-btn", href: href, text: text, "aria-label": label }); }
  function dots(list) { return list.filter(Boolean).join(" · "); }
  function topId(top, id) { return (top ? "hdbTop-" : "") + id; }
  /* open / closed: per event, kept over redraws */
  function secOf(q) { return UI.sec[q] || (UI.sec[q] = { auto: "", user: {} }); }
  function secOpen(q, g) { var x = secOf(q); return x.user[g.key] != null ? x.user[g.key] : x.auto === g.key && !g.full; }
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
    var words = [h("span", { cls: "hdb-t" }, [it.sr ? h("span", { cls: "tc-sr", text: it.sr }) : null, h("b", {}, det.length ? [it.title.slice(0, cut), h("span", { cls: "nw" }, [it.title.slice(cut), h("span", { cls: "hdb-car", "aria-hidden": "true" })])] : [it.title]), it.chip ? chip(it.chip[0], it.chip[1]) : null]), it.sub ? h("span", { cls: "hdb-sub", text: it.sub }) : null];
    var main = det.length ? h("button", { type: "button", id: tid, cls: "hdb-main", "aria-expanded": open ? "true" : "false", "aria-controls": open ? did : null, on: { click: function () { UI.open[ok] = !open; repaint(ctx.quoteId, true); } } }, words) : h("div", { id: tid, cls: "hdb-main", tabindex: "-1" }, words);
    var act = it.main ? it.main(false) : null, more = moreBox(ctx, it);
    return h("li", { cls: "hdb-row" + (it.done ? " on" : "") + (it.kids ? " par" : "") + (act ? "" : " noact") + (more ? "" : " nomore") }, [it.lead, main, act ? h("div", { cls: "hdb-act" }, [act]) : null, more,
      open ? h("div", { cls: "hdb-det", id: did }, det.map(function (x) { return typeof x === "string" ? h("p", { text: x }) : x; })) : null, it.form || null,
      it.kids && it.kids.length ? h("ul", { cls: "hdb-list hdb-kids", "aria-label": it.title }, it.kids.map(function (k) { return rowNode(ctx, k); })) : null]);
  }
  function list(ctx, rows) { return rows.length ? h("ul", { cls: "hdb-list" }, rows.map(function (r) { return rowNode(ctx, r); })) : null; }
  function fold(key, text, kids, hide) {
    var d = h("details", { cls: "ep-more hdb-fold", "data-key": key }, [h("summary", { id: "hdbF-" + key }, hide ? [h("span", { cls: "s", text: text }), h("span", { cls: "h", text: hide })] : [text])].concat(kids));
    d.open = !!UI.folds[key]; d.addEventListener("toggle", function () { UI.folds[key] = d.open; }); return d;
  }
  // "Do these first" -> the line itself: its section opens, the line is opened and gets the focus
  function jump(ctx, it) {
    secOf(ctx.quoteId).user[it.sec] = true; if ((it.detail || []).some(Boolean)) UI.open[ctx.quoteId + ":" + it.key] = true; repaint(ctx.quoteId, true);
    var n = doc.getElementById("hdbT-" + it.key); if (n) try { n.focus(); } catch (e) {}
  }

  var SHORT = { vendors: "vendor calls", headcount: "guest count", crew_call: "crew call times", load_list: "load list", transport: "trucks", venue_access: "venue access", power: "power and generator", permits: "permits", weather: "rain plan", runsheet: "run-sheet", client: "client timings" };
  // one of the 11 Day-before ticks; kids = the Logistics rows about the same thing (the tick is never set by them)
  function lineItem(ctx, key, kids, kidWords) {
    var d = lines().filter(function (x) { return x[0] === key; })[0]; if (!d) return null;
    var p = ctx.plan || {}, c = (p.checks || {})[key] || {}, on = !!c.done, q = enc(ctx.quoteId), lt = lineTask(ctx.tasks, d[1]), fk = "line:" + key, aid = "hdbAs-" + key, T = TS();
    var by = c.by ? (on ? "✓ " : "Unticked by ") + c.by + (c.at ? " · " + dayTime(ms(c.at), ctx.tz) : "") : "";
    var late = !!(lt && lt.held && T.isLate && T.isLate(lt.t, ctx.now)), who = lt ? nameOf(ctx, lt.t) : "", chp = null, urg = null, sub = "";
    var counted = (kids || []).filter(function (k) { return !k.na; }), kdone = counted.filter(function (k) { return k.done; }).length, allKids = counted.length && kdone === counted.length;
    if (on) sub = dots([by, counted.length ? kidWords(kdone, counted.length) : "", lt && lt.held ? "With " + who + " · " + ((T.LABEL && T.LABEL[lt.key]) || lt.key) : lt && lt.key === "done" ? who + " · Done" : ""]);
    else {
      var st = !lt ? "" : lt.key === "rejected" ? "By " + who : lt.key === "unassigned" ? "Task made, not given out" : lt.key === "done" ? "Their task is done - tick the line if you agree." : "With " + who + " · " + ((T.LABEL && T.LABEL[lt.key]) || lt.key);
      if (lt && lt.key === "done") st = who + " · " + st;
      sub = dots([counted.length ? kidWords(kdone, counted.length) + (allKids ? " · Rows are done - tick if you agree" : "") : "", st || (counted.length ? "" : by)]);
      if (lt && lt.free) { chp = lt.key === "rejected" ? ["Turned down", "bad"] : ["Nobody on it", "warn"]; urg = { rank: 4, why: chp[0], rest: lt.key === "rejected" ? "by " + who : "", say: SHORT[key] + (lt.key === "rejected" ? " turned down" : " has nobody on it") }; }
      else if (late) { chp = ["Late", "bad"]; urg = { rank: 1, why: "Late", rest: "with " + who, say: SHORT[key] + " late" }; }
    }
    var href = key === "headcount" || key === "client" ? "event.html?id=" + q : key === "crew_call" && !/(^|\/)ops(\.html)?$/.test(String((global.location && global.location.pathname) || "")) ? "ops.html?quote=" + q : key === "runsheet" ? "runsheet.html?quote=" + q : "";
    var can = !on && canGive(ctx) && (!lt || lt.free), giveIt = function (back) { openForm(ctx, { key: fk, sec: groupOf(key), need: "people", back: back }); };
    var L = key === "permits" || key === "transport" || key === "headcount" ? S(ctx.quoteId) : null;
    return { key: "line-" + key, sec: groupOf(key), done: on, title: d[1], sub: sub, chip: chp, urg: urg, kids: kids,
      lead: tickBtn("epChk-" + key, on, d[1], !!p.can_edit, function () {
        run(ctx, "epChk-" + key, "save the tick", async function () { await store().ops.dayPlan.check(ctx.quoteId, key, !on); if (ctx.onChanged) await ctx.onChanged(); });
      }),
      main: can && lt ? function (top) { var id = topId(top, aid); return btn(id, "Give to someone", function () { giveIt(aid); }, { label: "Give to someone: " + d[1], exp: top ? null : isOpenForm(ctx, fk) ? "true" : "false" }); } : null,
      more: [can && !lt ? { id: aid, text: "Assign", label: "Assign (optional): " + d[1], fn: giveIt } : null, href ? { id: "hdbOp-" + key, text: "Open", href: href, label: "Open for: " + d[1] } : null,
        L && L.logistics.state === "ok" && L.perms && L.perms.logisticsEdit ? { id: "hdbAd-" + key, text: "Add a line", href: "logistics.html?quote=" + q, label: "Add a line in Logistics: " + d[1] } : null],
      detail: [d[2].charAt(0).toUpperCase() + d[2].slice(1) + ".", !on && by && sub.indexOf(by) < 0 ? by : null],
      form: isOpenForm(ctx, fk) ? assignForm(ctx, { title: d[1] }, lt) : null };
  }
  function readyItems(ctx, s) {
    var EP = global.HelmEventPlan, r = s.ready.data && s.ready.data.r; if (!r || !EP || !EP.readySum) return null;
    // a list that could not be read is never shown as fine
    r = EP.readyMask ? EP.readyMask(r, { vendors: s.vendors.state !== "error", stock: s.stock.state !== "error" }, "Couldn't check") : r;
    var sum = EP.readySum(r), q = enc(ctx.quoteId), L = EP.READY_LINK || {}, out = [];
    function one(c, ok) {
      var href = !ok && L[c.key] ? L[c.key] + q : "", shown = (c.key === "vendors" && s.vendors.state === "ok") || (c.key === "stock" && s.stock.state === "ok");   // these two are listed line by line below
      return { key: "rd-" + c.key, sec: "ready", done: ok, title: c.label, sr: ok ? "Done: " : c.unchecked ? "Not checked: " : "Not done: ", sub: ok ? "" : c.detail, crit: !ok && c.critical,
        lead: icon(ok ? "✓" : c.unchecked ? "?" : c.critical ? "✕" : "!", ok ? "ok" : c.critical ? "bad" : "warn"), main: href ? function (top) { return goLink(topId(top, "hdbFix-" + c.key), href, "Fix", "Fix: " + c.label); } : null,
        urg: !ok && c.critical && !c.hidden && !shown ? { rank: 6, why: "", rest: c.detail || "Not done" } : null };
    }
    sum.open.forEach(function (c) { out.push(one(c, false)); }); sum.ok.forEach(function (c) { out.push(one(c, true)); });
    (sum.hidden || []).forEach(function (c) { out.push({ key: "rd-" + c.key, sec: "ready", done: false, quiet: true, title: c.label, sub: c.detail, lead: icon("–", "") }); });
    return { rows: out, done: sum.done, of: sum.of };
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
      out.push({ key: "vn-" + v.id, sec: "vendors", done: v.done, title: v.name, sub: dots([v.done ? "" : v.label, what, job]), chip: v.done ? (bad ? ["Job turned down", "bad"] : null) : ["Not confirmed", "warn"],
        urg: v.done ? null : { rank: 3, why: "Not confirmed", rest: what, say: "", nc: v.name }, lead: icon(v.done ? "✓" : "!", v.done ? "ok" : "warn"), sr: v.done ? v.label + ": " : "",
        main: canCf ? function (top) { return btn(topId(top, cid), "Mark confirmed", confirm, { label: "Mark " + v.name + " confirmed", busy: cid }); }
          : !v.done && canCall ? function (top) { return goLink(topId(top, "hdbCall-" + v.id), "tel:" + tel, "Call", "Call " + v.name); } : null,
        more: [canCall && (canCf || v.done) ? { id: "hdbCall-" + v.id, text: "Call", href: "tel:" + tel, label: "Call " + v.name } : null,
          v.vendorId && canGive(ctx) ? { id: jid, text: "Give a job", label: "Give " + v.name + " a job (optional)", fn: function (back) { openForm(ctx, { key: fk, sec: "vendors", need: "people", back: back, text: nlTitle("Confirm arrival and set-up time" + (v.what ? " - " + v.what : "")) }); } } : null],
        detail: [dots([v.label, v.what, v.qty ? plural(v.qty, "unit") : ""]), canCall ? "Phone " + v.phone : null].concat(mine.slice(0, 3).map(function (t) {
          var k = T.baseKey ? T.baseKey(t) : "waiting"; return "Job: " + (t.title || "task") + " · " + ((T.LABEL && T.LABEL[k]) || k); }), mine.length > 3 ? "+ " + (mine.length - 3) + " more jobs" : null),
        form: isOpenForm(ctx, fk) ? assignForm(ctx, { vendorId: v.vendorId, name: v.name }) : null });
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
  function stockModel(s) {
    var d = s.stock.data; if (!d || !d.layout) return null; var v = s.vendors.state === "ok" ? s.vendors.data : null;
    return stockRows({ layout: d.layout, reservations: d.reservations, checkouts: d.checkouts, shortages: d.shortages, needs: v ? v.needs : [], bookings: v ? v.bookings : [] });
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
      out.push({ key: "st-" + r.id, sec: "stock", done: r.done, title: r.name, sub: stockWords(r), chip: r.state === "short" ? ["Missing " + fmt(r.toGet), "bad"] : r.state === "asked" ? ["Not confirmed", "warn"] : null, sr: r.done ? "Covered: " : "",
        urg: r.state === "short" ? { rank: 2, why: "Missing " + fmt(r.toGet), rest: "need " + fmt(r.needed), short: r.name } : r.state === "reserve" ? { rank: 5, why: fmt(r.toReserve) + " to reserve", rest: "need " + fmt(r.needed), res: r.name } : null,
        lead: icon(r.done ? "✓" : r.state === "short" ? "✕" : "!", r.done ? "ok" : r.state === "short" ? "bad" : "warn"),
        main: get || (r.toReserve ? function (top) { return goLink(topId(top, "hdbRes-" + r.id), rh, rt, rt + " " + r.name); } : null),
        more: [get && r.toReserve ? { id: "hdbRes-" + r.id, text: rt, href: rh, label: rt + " " + r.name } : null],
        detail: ["Needed " + fmt(r.needed) + " · Reserved " + fmt(r.reserved) + " · Given out " + fmt(r.out) + " · Missing " + fmt(r.missing), todo.length ? todo.join("; ") + "." : null, r.sourced.length ? "From " + sourcedWords(r.sourced, vs) : null,
          r.shared && !r.done ? "Other events on the same days need " + fmt(r.shared) + " of these too." : null] });
    });
    m.otherShort.forEach(function (x) {
      out.push({ key: "sh-" + x.id, sec: "stock", done: false, title: x.label, sub: "Not on the floor plan, no vendor yet", chip: ["Missing " + fmt(x.qty), "bad"], urg: { rank: 2, why: "Missing " + fmt(x.qty), rest: "no vendor yet", short: x.label }, lead: icon("✕", "bad"),
        main: getMain(ctx, s, { id: "hdbGetS-" + x.id, label: x.label, qty: x.qty, itemId: x.itemId }), detail: [x.label + " × " + fmt(x.qty) + ". Short in stock, no vendor yet (not on the floor plan)."] });
    });
    return out;
  }
  function unlinkedBox(ctx, s, m) {
    if (!m || !m.unlinked.length) return null; var q = enc(ctx.quoteId), vs = s.vendors.data && s.vendors.data.vendors;
    return fold("stock-un", plural(m.unlinked.length, "product") + " not linked to stock", [
      h("p", { cls: "hdb-note" }, ["Link them once and Helm counts them against stock. ", link("inventory.html?quote=" + q + "&tab=layout", "Link in Inventory →")]),
      list(ctx, m.unlinked.map(function (u) {
        return { key: "un-" + u.type, sec: "stock", title: u.label, sub: dots([fmt(u.objects) + " on the plan", u.seats && u.seats !== u.objects ? plural(u.seats, "seat") : "", u.sourced.length ? "From " + sourcedWords(u.sourced, vs) : ""]), lead: icon("?", ""),
          main: u.sourced.length ? null : getMain(ctx, s, { id: "hdbGetT-" + u.type, label: u.label, qty: u.objects, layoutType: u.type }) };
      }))]);
  }
  function checkItem(ctx, s, c) {
    var can = !!(s.perms && s.perms.logisticsEdit), done = c.status !== "open", words = c.section === "guests" ? GST : CHK, tid = "hdbCk-" + c.id, nid = "hdbNa-" + c.id, oid = "hdbOw-" + c.id, fk = "owner:" + c.id;
    function save(id, patch, what) {
      return run(ctx, id, what, async function () {
        await store().checklist.update(c.id, patch); await loadGroup(ctx.quoteId, "logistics");
        var now = S(ctx.quoteId).logistics, x = now.data && now.data.rows.filter(function (y) { return y.id === c.id; })[0], k = Object.keys(patch)[0];
        if (now.state !== "ok" || !x || String(x[k] || "") !== String(patch[k] || "")) say(ctx, "That was not saved. You may not be allowed to change Logistics.", "err"); else if (patch.owner !== undefined) UI.form = null;
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
    return { key: "ck-" + c.id, sec: "logistics", done: done, na: c.status === "na", title: c.title, sub: dots([guests, own2, due && !done ? "Due " + due : ""]), chip: over ? ["Overdue", "bad"] : c.status === "na" ? [words.na, ""] : null,
      urg: over ? { rank: 1, why: "Overdue", rest: dots(["due " + due, c.owner]), say: c.title.replace(/\s*\/\s*\S+/, "") + " overdue", due: c.due_date } : null,
      lead: tickBtn(tid, c.status === "done", c.title, can, setDone), topMain: over && can ? function () { return btn("hdbTop-" + tid, "Mark done", setDone, { label: "Mark done: " + c.title, busy: tid }); } : null,
      more: [can && c.status !== "done" ? { id: nid, text: c.status === "na" ? "Reopen" : "Mark " + (c.section === "guests" ? "declined" : "N/A"), label: (c.status === "na" ? "Reopen: " : "Mark " + words.na + ": ") + c.title, fn: function () { save(nid, { status: c.status === "na" ? "open" : "na" }, "update the line"); } } : null,
        can && c.status === "open" && c.section !== "guests" ? { id: oid, text: c.owner ? "Change owner" : "Pick an owner", label: (c.owner ? "Change owner of: " : "Pick an owner for: ") + c.title, fn: function (back) { openForm(ctx, { key: fk, sec: "logistics", need: "owners", back: back, val: c.owner }); } } : null],
      detail: [c.detail || null, done && due ? "Due " + due : null], form: form };
  }

  /* ---------------- the card ---------------- */
  function sigOf(ctx, s) {
    var T = TS(), tk = (ctx.tasks || []).map(function (t) { return t && [t.id, t.title, t.category, t.status, t.crew_id, t.vendor_id, t.assignee_name, T.isLate && T.isLate(t, ctx.now)]; });
    try { return JSON.stringify([ctx.quoteId, ctx.noReady, ctx.compact, isLocked(ctx), ctx.eventDate, ctx.plan && [ctx.plan.can_edit, ctx.plan.checks], tk, s.loading, s.at, s.perms, s.ready, s.vendors, s.stock, s.logistics, s.people, s.owners, UI.form, UI.busy, UI.sec, UI.open, UI.menu, startFor(ctx), !!global.HelmStockVendor, TS().ymdIn ? TS().ymdIn(ctx.tz, ctx.now) : ""]); } catch (e) { return ""; }
  }
  function flat(items) { return items.reduce(function (a, x) { return a.concat(x, x.kids || []); }, []); }
  function cap(t) { return t ? t.charAt(0).toUpperCase() + t.slice(1) : ""; }
  function names(list, one, many) { return !list.length ? "" : list.length <= 2 ? list.join(" and ") + " " + one : list.length + " " + many; }
  // what is wrong in one section, in words; nothing wrong = what is still to do
  function wrongWords(g) {
    var all = flat(g.items), u = all.filter(function (x) { return x.urg; }), of = function (k) { return u.filter(function (x) { return x.urg[k]; }).map(function (x) { return x.urg[k]; }); };
    var out = of("say").concat([names(of("nc"), "not confirmed", "vendors not confirmed"), names(of("short"), "missing", "items missing"), names(of("res"), "to reserve", "items to reserve")]).filter(Boolean).concat(g.words || []);
    if (out.length) return cap(out.slice(0, 3).join(", ")) + (out.length > 3 ? " + " + (out.length - 3) + " more" : "");
    var left = all.filter(function (x) { return !x.done && !x.quiet && !x.na; }).map(function (x) { return x.title.replace(/\s*\(.*\)$/, ""); });
    return left.length ? "To do: " + left.slice(0, 2).join(", ") + (left.length > 2 ? " + " + (left.length - 2) + " more" : "") : "";
  }
  function paint(host, force) {
    var st = host._hdb; if (!st) return; var ctx = st.ctx, q = ctx.quoteId, s = S(q);
    if (!force && host.firstChild && st.q === q && inUse(host)) return;
    var sec = secOf(q), sig = sigOf(ctx, s); if (sig && st.sig === sig && host.firstChild) return; st.q = q;
    var a = doc.activeElement, focusId = a && host.contains(a) ? a.id : "", gKey = "", up = focusId ? a : null, sel = a && focusId && a.tagName === "INPUT" ? [a.selectionStart, a.selectionEnd] : null;
    while (up && up !== host && !gKey) { gKey = up.getAttribute ? up.getAttribute("data-g") || "" : ""; up = up.parentNode; }
    var enq = enc(q), G = [], no = ctx.noReady ? 1 : 0;

    function add(key, title, items, o) {
      var all = flat(items), c = all.filter(function (r) { return !r.quiet && !r.na; });
      var g = Object.assign({ key: key, title: title, items: items, all: all, no: ++no, done: c.filter(function (r) { return r.done; }).length, of: c.length, tops: [], end: [], links: [] }, o);
      g.full = g.of > 0 && g.done >= g.of && !all.some(function (r) { return !r.done; }) && !!g.sure; G.push(g);
    }
    function fails(g, what, k) { return g.state === "error" ? againBox(q, what, function () { s[k] = blank(); repaint(q, true); loadGroup(q, k, true); }) : null; }
    function waits(g) { return g.state === "wait" ? h("p", { cls: "hdb-note", text: "Checking…" }) : null; }
    function ticks(grp) { return lines().filter(function (d) { return groupOf(d[0]) === grp; }).map(function (d) { return lineItem(ctx, d[0]); }).filter(Boolean); }

    // 1 booked and planned
    if (!ctx.noReady && s.ready.state !== "hidden") {
      var rr = readyItems(ctx, s), some = rr && rr.rows.some(function (r) { return r.quiet; }), crit = rr ? rr.rows.filter(function (r) { return r.crit; }).map(function (r) { return r.title.replace(/\s*\(.*\)$/, ""); }) : [];
      add("ready", "Booked and planned", rr ? rr.rows : [], { done: rr ? rr.done : 0, of: rr ? rr.of : 0, sure: s.ready.state === "ok" && !some, allText: some ? "Everything you can see is booked." : "Everything is booked.", g: s.ready,
        text: crit.length ? "Not yet: " + crit.slice(0, 3).join(", ") + (crit.length > 3 ? " + " + (crit.length - 3) + " more" : "") : "",
        fail: rr ? null : fails(s.ready, "the plan", "ready"), tops: [rr ? null : waits(s.ready)], end: [rr && !ctx.compact ? h("p", { cls: "hdb-note", text: "Helm checks these from the plan. Dry run and team briefing are marked by hand." }) : null], links: [link("ready.html?quote=" + enq, "Open Readiness →")] });
    }
    // 2 vendors
    var vr = vendorItems(ctx, s), vEmpty = s.vendors.state === "ok" && !vr.length;
    add("vendors", "Vendors", vr.concat(ticks("vendors")), { sure: s.vendors.state === "ok", g: s.vendors, fail: fails(s.vendors, "the vendors", "vendors"), tops: [waits(s.vendors), vEmpty ? h("p", { cls: "hdb-note", text: "No vendors booked." }) : null],
      links: [s.vendors.state === "ok" && s.perms && s.perms.resources ? link("resources.html?quote=" + enq, "Resource plan →") : null] });
    // 3 stock and floor plan
    var sm = stockModel(s), types = sm ? sm.types : s.stock.data && s.stock.data.floor, bh = "builder.html?quote=" + enq, seats = (types || []).reduce(function (n, t) { return n + t.seats; }, 0);
    try { if (global.HelmUrl && global.HelmUrl.build) bh = global.HelmUrl.build("floor-plan", { id: q }); } catch (e) {}
    add("stock", "Stock and floor plan", stockItems(ctx, s, sm).concat(ticks("stock")), { sure: s.stock.state === "ok" && s.vendors.state !== "error", g: s.stock, fail: s.stock.state === "hidden" && !s.stock.data ? null : fails(s.stock, "the stock", "stock"),
      links: [link(bh, "2D / 3D plan →"), sm ? link("inventory.html?quote=" + enq, "Stock →", "Stock for this event") : null],
      tops: [s.stock.state === "hidden" && !s.stock.data ? null : waits(s.stock),
        s.stock.state === "hidden" && types ? h("p", { cls: "hdb-note" }, s.perms && s.perms.inventory ? ["Not counted against stock here. ", link("inventory.html?quote=" + enq, "Open Inventory →")] : ["Stock numbers are not visible to you."]) : null,
        sm && sm.short && s.vendors.state !== "ok" && s.vendors.state !== "wait" ? h("p", { cls: "hdb-note", text: "Vendor bookings are not counted here, so a vendor may already be asked for what is missing." }) : null],
      end: [unlinkedBox(ctx, s, sm), types && types.length ? fold("stock-plan", "On the plan: " + plural(types.length, "kind") + " of items" + (seats ? ", " + plural(seats, "seat") : ""), [h("p", { cls: "hdb-note", text: planWords(types) }),
        sm && sm.extra ? h("p", { cls: "hdb-note", text: plural(sm.extra, "more item") + " reserved for this event (not on the plan)." }) : null].filter(Boolean)) : types ? h("p", { cls: "hdb-note", text: "Nothing on the floor plan yet." + (sm && sm.extra ? " " + plural(sm.extra, "item") + " reserved for this event." : "") }) : null] });
    // 4 logistics: a tick and the rows about the same thing are one parent line with its rows under it
    var ck = s.logistics.state === "ok" && s.logistics.data ? s.logistics.data.rows : [], canL = s.perms && s.perms.logisticsEdit, seeL = s.logistics.state === "ok";
    var rowsOf = function (x) { return ck.filter(function (c) { return c.section === x; }).map(function (c) { return checkItem(ctx, s, c); }); }, guestRows = ck.filter(function (c) { return c.section === "guests"; });
    var gAll = guestRows.reduce(function (n, c) { return n + (c.status === "na" ? 0 : n0(c.qty)); }, 0), gYes = guestRows.reduce(function (n, c) { return n + (c.status === "done" ? n0(c.qty) : 0); }, 0);
    var LW = { compliance: function (d, n) { return d + " of " + n + " in hand"; }, logistics: function (d, n) { return d + " of " + n + " ready"; }, guests: function (d, n) { return gAll ? fmt(gYes) + " of " + plural(gAll, "guest") + " confirmed" : d + " of " + n + " confirmed"; } };
    var li = [], comms = rowsOf("comms");
    SECTIONS.forEach(function (x) {
      if (x[0] === "comms") { if (comms.length) li.push({ key: "grp-comms", sec: "logistics", quiet: true, head: true, done: comms.every(function (k) { return k.done; }), title: x[1], sub: comms.filter(function (k) { return k.done && !k.na; }).length + " of " + comms.filter(function (k) { return !k.na; }).length + " told", lead: icon("–", ""), kids: comms }); }
      else x[2].forEach(function (k) { li.push(x[0] ? lineItem(ctx, k, rowsOf(x[0]), LW[x[0]]) : lineItem(ctx, k)); });
    });
    li = li.filter(Boolean);
    add("logistics", "Logistics", li, { sure: seeL, g: s.logistics, fail: fails(s.logistics, "logistics", "logistics"), tops: [waits(s.logistics)],
      end: [seeL && !comms.length ? h("p", { cls: "hdb-note", text: "Who tells whom: no lines yet." }) : null], links: [seeL ? link("logistics.html?quote=" + enq, canL ? "Open Logistics, add a line →" : "Open Logistics →") : null] });
    // 5 people and programme
    var tn = null, T = TS(), pl = ticks("people"), pw = [];
    if (Array.isArray(ctx.tasks) && T.baseKey && !(s.perms && !s.perms.staff)) { tn = { un: 0, wait: 0, n: 0 }; ctx.tasks.forEach(function (t) { if (!t || t.status === "cancelled") return; tn.n++; var k = T.baseKey(t); if (k === "unassigned" || k === "rejected") tn.un++; else if (k === "waiting") tn.wait++; }); }
    if (tn) {
      if (tn.un) pw.push(plural(tn.un, "task") + " not given out"); if (tn.wait) pw.push(tn.wait + (tn.un ? "" : tn.wait === 1 ? " task" : " tasks") + " not accepted yet");
      pl.unshift({ key: "tasks", sec: "people", quiet: true, done: tn.n > 0 && !pw.length, title: tn.n ? pw.length ? "Tasks for the crew" : "All tasks given out and accepted" : "No tasks on this event yet", sub: pw.join(", "), lead: icon(tn.n && !pw.length ? "✓" : "!", tn.n && !pw.length ? "ok" : "warn"),
        urg: tn.un ? { rank: 4, why: plural(tn.un, "task") + " not given out" } : null, main: !tn.n || pw.length ? function (top) { return goLink(topId(top, "hdbTasks"), "ops.html?quote=" + enq, "Tasks & Crew", "Open Tasks & Crew"); } : null });
    }
    add("people", "People and programme", pl, { sure: true, words: tn && !tn.n ? ["no tasks yet"] : pw });

    /* ---- the sentence ---- */
    var total = G.reduce(function (n, g) { return n + g.of; }, 0), doneN = G.reduce(function (n, g) { return n + g.done; }, 0), left = total - doneN, first = !s.at;
    var failed = G.some(function (g) { return g.fail; }) || (s.ready.state === "ok" && (s.vendors.state === "error" || s.stock.state === "error")), sure = G.every(function (g) { return g.sure; }) && (ctx.noReady || s.ready.state !== "hidden");
    var firsts = G.reduce(function (a, g) { return a.concat(g.all); }, []).filter(function (x) { return x.urg && !x.done; }).map(function (x, i) { return { x: x, i: i }; })
      .sort(function (m, n) { return m.x.urg.rank - n.x.urg.rank || String(m.x.urg.due || "9").localeCompare(String(n.x.urg.due || "9")) || m.i - n.i; }).map(function (z) { return z.x; });
    // only the first section with something urgent opens by itself, once, when everything is read
    if (!sec.auto && s.at && !s.loading) { var hot = G.filter(function (g) { return !g.full && g.all.some(function (x) { return x.urg && !x.done && x.urg.rank < 6; }); })[0]; sec.auto = hot ? hot.key : "-"; }
    st.sig = sigOf(ctx, s);

    clear(host); host.classList.add("hdb"); host.setAttribute("aria-busy", s.loading ? "true" : "false");
    var wrap = h("div", { cls: "hdb-in" }); host.appendChild(wrap);
    wrap.appendChild(h("div", { cls: "hdb-head" }, [h("h3", { cls: "tc-h2", id: host.id + "H", tabindex: "-1", text: "Day before - are we ready?" }),
      h("span", { cls: "hdb-at", role: "status", text: s.loading ? "Checking…" : s.at ? "Checked " + clock(s.at, ctx.tz) : "" }),
      btn("hdbRefresh", "Refresh", function () { if (!s.loading) load(q, ctx, true); }, { label: "Refresh the Day before checklist" })]));
    wrap.appendChild(h("p", { cls: "hdb-sum", id: host.id + "Tot", text: first ? "Checking this event…" : left > 0 ? doneN + " of " + total + " done - " + left + " to go" + (failed ? ". Some parts could not be checked." : "") : failed ? doneN + " of " + total + " done. Some parts could not be checked." : sure ? "All " + total + " done" : "Everything you can see is done (" + doneN + " of " + total + ")" }));
    wrap.appendChild(h("progress", { cls: "hdb-bar" + (left <= 0 && !failed && !first ? " ok" : ""), max: String(total || 1), value: first ? "0" : String(doneN), "aria-labelledby": host.id + "Tot" }));
    if (ctx.plan && !ctx.plan.can_edit) wrap.appendChild(h("p", { cls: "hdb-note", text: "Someone who can give out work (Assign & send tasks) ticks the Day-before lines." }));
    else if (isLocked(ctx)) wrap.appendChild(h("p", { cls: "hdb-note", text: "The plan is locked: ticks still work, new tasks cannot be given out until it is unlocked." }));
    var bad = G.map(function (g) { return g.fail; }).filter(Boolean); if (bad.length) wrap.appendChild(h("div", { cls: "hdb-fails" }, bad));

    /* ---- do these first ---- */
    if (!first && firsts.length) {
      wrap.appendChild(h("section", { cls: "hdb-first", "aria-labelledby": host.id + "G-first", "data-g": "first" }, [h("h4", { cls: "hdb-h", id: host.id + "G-first", tabindex: "-1", text: "Do these first" }),
        h("ol", { cls: "hdb-list" }, firsts.slice(0, 5).map(function (x) {
          var act = x.topMain ? x.topMain() : x.main ? x.main(true) : btn("hdbTop-show-" + x.key, "Show", function () { jump(ctx, x); }, { label: "Show: " + x.title });
          return h("li", { cls: "hdb-row top" }, [h("button", { type: "button", cls: "hdb-main", id: "hdbTopT-" + x.key, title: "Show the line", on: { click: function () { jump(ctx, x); } } }, [h("span", { cls: "hdb-t" }, [h("b", { text: x.title })]),
            h("span", { cls: "hdb-sub" }, [x.urg.why ? h("span", { cls: x.urg.rank < 3 || /^Turned/.test(x.urg.why) ? "bad" : "warn", text: x.urg.why }) : null, x.urg.why && x.urg.rest ? " · " : "", x.urg.rest || ""])]), h("div", { cls: "hdb-act" }, [act])]);
        })), firsts.length > 5 ? h("p", { cls: "hdb-note", text: firsts.length - 5 + " more in the sections below." }) : null]));
    }

    /* ---- the five sections ---- */
    var acc = h("div", { cls: "hdb-acc" }); wrap.appendChild(acc);
    G.forEach(function (g) {
      var open = secOpen(q, g), bid = host.id + "G-" + g.key, pid = bid + "P", seen = [], fin = [];
      g.items.forEach(function (x) {
        var ko = (x.kids || []).filter(function (k) { return !k.done; }), kd = (x.kids || []).filter(function (k) { return k.done; });
        if (!x.done || ko.length) seen.push(Object.assign({}, x, { kids: x.kids ? ko : null })); else if (!x.head) fin.push(Object.assign({}, x, { kids: null }));
        fin = fin.concat(kd);
      });
      var words = g.full ? "" : first || (g.g && g.g.state === "wait") ? "Checking…" : g.fail ? "Couldn't check" : g.text || wrongWords(g);
      var btnN = h("button", { type: "button", id: bid, cls: "hdb-sec", "aria-expanded": open ? "true" : "false", "aria-controls": pid, on: { click: function () { sec.user[g.key] = !open; UI.menu = null; repaint(q, true); } } }, [
        h("span", { cls: "hdb-no" + (g.full ? " ok" : ""), "aria-hidden": g.full ? "true" : null, text: g.full ? "✓" : String(g.no) }), h("span", { cls: "hdb-sec-m" }, [h("span", { cls: "hdb-sec-l" }, [h("b", { text: g.title }), " ", g.of ? h("span", { cls: "hdb-cnt", text: g.done + " of " + g.of + " done" }) : null]),
          words && !open ? h("span", { cls: "hdb-sub", text: words }) : null]), h("span", { cls: "hdb-car", "aria-hidden": "true" })]);
      var body = h("div", { cls: "hdb-body", id: pid, role: "region", "aria-labelledby": bid, hidden: !open }, g.tops.filter(Boolean).concat([list(ctx, seen), !seen.length && fin.length && g.of ? h("p", { cls: "hdb-all", text: g.allText || (g.sure ? "All done." : "Everything you can see is done.") }) : null,
        fin.length ? fold(g.key, "Show " + fin.length + " done", [list(ctx, fin)], "Hide " + fin.length + " done") : null], g.end, [g.links.some(Boolean) ? h("p", { cls: "hdb-links" }, g.links) : null]));
      acc.appendChild(h("section", { cls: "hdb-grp" + (open ? " open" : ""), "data-g": g.key }, [h("h4", { cls: "hdb-sec-h" }, [btnN]), body]));
    });

    if (focusId) {   // the same control again; when it went into a closed part, the section's own heading
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
    var s = S(q); if (q && onScreen(host) && !s.loading && Date.now() - s.at > KEEP_MS) load(q, ctx, false);
    paint(host, false);
  }
  function reset(q) { if (q) { delete ST[q]; delete UI.sec[q]; } else { ST = {}; UI.sec = {}; UI.open = {}; } UI.form = null; UI.menu = null; UI.busy = {}; }
  // a press anywhere else closes the More menu
  if (doc && doc.addEventListener) doc.addEventListener("click", function (e) { if (UI.menu && !(e.target && e.target.closest && e.target.closest(".hdb-more"))) shut(null, false); });

  global.HelmDayBefore = { render: render, reset: reset, startFor: startFor, lineTask: lineTask, stockRows: stockRows, stockWords: stockWords, vendorRows: vendorRows, sourcedFor: sourcedFor, floorTypes: floorTypes, planWords: planWords,
    cleanBooking: cleanBooking, refused: refused, groupOf: groupOf, KEEP_MS: KEEP_MS, CAT: CAT, _ui: UI, _state: S };
})(typeof window !== "undefined" ? window : globalThis);
