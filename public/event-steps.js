/* event-steps.js - R251 (owner 24 Nov): the two ends of the event day, shown THE SAME WAY on Tasks & Crew (ops.html) and the
 * Event-day monitor (monitor.html):
 *
 *   HelmEventSteps.renderPreDone(host, ctx)  the card "Before guests arrive": what is still open, and "Mark pre-event complete"
 *                                            = the quote workflow's stage moves to Event Day (no second switch, no new column)
 *   HelmEventWrap.render(host, ctx)          the Wrap-up section at the very bottom: closed on every page load, opens only by
 *                                            hand; open tasks, vendors, stock out and back, teardown list, crew check-out, issues,
 *                                            then "Mark event complete -> Settlement" and Teardown -> Settlement -> Closure (stock back before the money, R252)
 *
 * ctx: { quoteId, quote: { code, title, status, stage, eventDate, eventTime }, tasks, autoWin, win, tz, now, nameOf(t),
 *        canStage, admin, toast(msg,type), onChanged(), openTask(id) }
 *   canStage undefined = asked from BPStore.auth (Quotes - Can change); admin undefined = the role. Optional extras, used only
 *   when the page already has them (no read is made for them): plan (event_day_plan_get answer -> Day-before checklist),
 *   sheet ({crew_id: {in, out}} from the timesheet -> who checked in / out), preDoneAt (ISO, when pre-event was marked).
 * Both are idempotent: called on every refresh, they skip the redraw when nothing changed, keep the focus, and never open or
 * close the section by themselves. They hide the host when there is no single event or it is cancelled.
 *
 * R253: what can be DONE at the end (vendor arrived / left, stock back, teardown list, crew check-out, issues) is drawn under its row by
 * event-wrap.js (HelmWrapDo) when that script is on the page - every write lives there, none here. "6 of 9 wrap-up items done" = progress().
 *
 * Stage moves use ONLY BPStore.quotes.stageBlockers / setStageGuided (0198: the server checks every move, admin override with a
 * reason is audited). Wrap-up's reads start when it is opened the first time; each one sits behind the area its page uses
 * (vendors / inventory / plan / staff / issues / command) and a refused read hides its row. Money is never read into a row or shown.
 * DOM calls only (textContent), never HTML strings. Unit-tested in test/r251-event-steps.test.mjs. */
(function (global) {
  "use strict";
  var doc = global.document, TS = function () { return global.HelmTaskStatus; };
  var PAST_PRE = ["event_day", "settlement", "closed"], POST = ["settlement", "closed"];
  var FRESH_MS = 25000, BLK_MS = 120000;

  /* ---------------- pure ---------------- */
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function pl(n, w, many) { return n + " " + (n === 1 ? w : many || w + "s"); }
  function key(t) { return TS() ? TS().baseKey(t) : String((t && t.status) || "") === "completed" ? "done" : String((t && t.status) || ""); }
  function liveOf(tasks) { return (tasks || []).filter(function (t) { return t && t.status !== "cancelled"; }); }
  function openOf(tasks) {
    var T = TS(); if (T && T.leftover) return T.leftover(tasks);
    return liveOf(tasks).filter(function (t) { return t.status !== "completed"; });
  }
  function inHouse(t) { return !!(t && t.crew_id && !t.vendor_id); }
  // what is still open before guests arrive: { pre, day, late, unassigned, turned, waiting, started, missing[], checkedIn (null = unknown), checks[] }
  function preSummary(ctx) {
    ctx = ctx || {}; var T = TS(), q = ctx.quote || {}, o = { eventDate: q.eventDate, eventTime: q.eventTime, tz: ctx.tz };
    var b = T && T.bySteps ? T.bySteps(ctx.tasks, o) : { pre: { tasks: liveOf(ctx.tasks), open: 0, total: 0 }, daybefore: { tasks: [], open: 0 } };
    var pre = b.pre.tasks.filter(function (t) { return key(t) !== "done"; }), day = b.daybefore.tasks.filter(function (t) { return key(t) !== "done"; });
    var all = day.concat(pre), n = function (f) { return all.filter(f).length; };
    var r = { pre: pre, day: day, total: b.pre.total, unassigned: n(function (t) { return key(t) === "unassigned"; }), turned: n(function (t) { return key(t) === "rejected"; }),
      waiting: n(function (t) { return key(t) === "waiting"; }), started: b.pre.tasks.filter(function (t) { var k = key(t); return k === "started" || k === "done"; }).length,
      people: 0, checkedIn: null, checks: [], approve: (ctx.tasks || []).filter(function (t) { return t && t.status === "completed" && t.verify_status === "pending"; }).length };   // R253: finished, not checked yet
    var ppl = {}; b.pre.tasks.forEach(function (t) { if (inHouse(t) && key(t) !== "rejected") ppl[t.crew_id] = 1; });
    var ids = Object.keys(ppl); r.people = ids.length;
    if (ctx.sheet && typeof ctx.sheet === "object") r.checkedIn = ids.filter(function (id) { return ctx.sheet[id] && ctx.sheet[id]["in"]; }).length;
    var EP = global.HelmEventPlan, ck = ctx.plan && ctx.plan.checks;
    if (ck && EP && EP.DAYBEFORE) r.checks = EP.DAYBEFORE.filter(function (d) { return !(ck[d[0]] && ck[d[0]].done); }).map(function (d) { return d[1]; });
    // R257: the Pre-event checklist lines only a person can tick (day-before.js; not read yet / before 0442 = nothing said)
    var DB = global.HelmDayBefore, ol = DB && DB.openLines && ctx.quoteId && !ctx.noLines ? DB.openLines(ctx.quoteId, "pre") : null; if (ol) r.lines = ol.filter(function (x) { return x !== "Crew checked in"; });
    var VI = global.HelmVendorItems, vo = VI && VI.openVendors && ctx.quoteId && !ctx.noLines ? VI.openVendors(String(ctx.quoteId)) : null; if (vo) r.vitems = vo;   // R260 (0448): vendors whose items are not all checked in
    return r;
  }
  // the lines of the card: [tone "bad" | "warn" | "info", text]; none = nothing is open
  function preLines(s) {
    var a = [];
    if (s.pre.length) a.push(["warn", pl(s.pre.length, "pre-event task") + " not done yet"]);
    if (s.day.length) a.push(["warn", pl(s.day.length, "Day-before task") + " not done yet"]);
    if (s.unassigned) a.push(["bad", pl(s.unassigned, "task has", "tasks have") + " no one on " + (s.unassigned === 1 ? "it" : "them")]);
    if (s.turned) a.push(["bad", pl(s.turned, "task was", "tasks were") + " turned down - give " + (s.turned === 1 ? "it" : "them") + " to someone else"]);
    if (s.waiting) a.push(["warn", pl(s.waiting, "task is", "tasks are") + " not accepted yet"]);
    if (s.people && s.checkedIn === 0) a.push(["bad", "Nobody has checked in yet (" + pl(s.people, "person", "people") + " expected)"]);
    else if (s.people && s.checkedIn != null && s.checkedIn < s.people) a.push(["warn", pl(s.people - s.checkedIn, "person has", "people have") + " not checked in"]);
    else if (s.checkedIn == null && s.total && !s.started) a.push(["warn", "Nobody has started a pre-event task yet"]);
    if (s.approve) a.push(["warn", pl(s.approve, "finished task waits", "finished tasks wait") + " for approval"]);
    if (s.checks.length) a.push(["warn", pl(s.checks.length, "Day-before check") + " not ticked: " + s.checks.slice(0, 3).join(", ") + (s.checks.length > 3 ? " and " + (s.checks.length - 3) + " more" : "")]);
    if (s.lines && s.lines.length) a.push(["warn", pl(s.lines.length, "checklist line") + " not ticked: " + s.lines.slice(0, 3).join(", ") + (s.lines.length > 3 ? " and " + (s.lines.length - 3) + " more" : "")]);
    if (s.vitems && s.vitems.length) a.push(["warn", pl(s.vitems.length, "vendor") + " with items not checked in: " + s.vitems.slice(0, 3).join(", ") + (s.vitems.length > 3 ? " and " + (s.vitems.length - 3) + " more" : "")]);
    return a;
  }
  function confirmPre(name, s) {
    var n = s.pre.length + s.day.length;
    return "Mark pre-event complete for " + name + "? " + (n ? (n === 1 ? "1 pre-event task is" : n + " pre-event tasks are") + " still open. " : "All pre-event tasks are done. ") +
      (s.checks && s.checks.length ? pl(s.checks.length, "Day-before check") + " not ticked. " : "") +
      (s.lines && s.lines.length ? pl(s.lines.length, "checklist line") + " not ticked. " : "") + (s.vitems && s.vitems.length ? "Vendor items not checked in: " + names(s.vitems, 4) + ". " : "") + "The event moves to Event Day. Nothing is locked: tasks and times can still change.";
  }
  // why a stage can't start yet, in words (0198 messages): "" = free
  function whyText(blk, stageWord) {
    return (Array.isArray(blk) ? blk : []).map(function (b) { var m = String((b && b.message) || "").replace(/\.$/, ""); if (!m) return "";
      return /^[A-Z]/.test(m) ? m : stageWord + " can’t start yet - " + m; }).filter(Boolean).join(". ");
  }
  function gate(blk, admin) {
    var a = Array.isArray(blk) ? blk : [], hard = a.some(function (b) { return b && b.hard; });
    return { blocked: a.length > 0, can: !a.length || (!!admin && !hard) };
  }
  // stock out and back on this event - counts only, the same rules as HelmStockFlow (parity-tested)
  function stock(res, cos) {
    var by = {}, r = { given: 0, back: 0, out: 0, missing: 0, damaged: 0, used: 0, unused: 0, outItems: 0, items: 0, holders: [] };
    var slot = function (id) { return by[id] || (by[id] = { live: 0, alloc: 0, out: 0, went: false }); };
    (res || []).forEach(function (x) { if (!x || !x.item_id) return; var s = slot(x.item_id);
      if (x.status === "reserved" || x.status === "allocated") s.live += num(x.qty); if (x.status === "allocated") s.alloc += num(x.qty); });
    (cos || []).forEach(function (c) {
      if (!c || !c.item_id || c.status === "cancelled") return; var s = slot(c.item_id); s.went = true;
      var inn = num(c.qty_in), dmg = Math.max(num(c.qty_damaged), 0), used = Math.max(num(c.qty_used), 0); r.given += num(c.qty_out);
      if (c.status === "out") { var o = Math.max(num(c.qty_out) - inn, 0); s.out += o; r.out += o; r.back += Math.max(inn - dmg, 0); r.damaged += dmg;
        if (o > 0 && c.issued_to && r.holders.indexOf(String(c.issued_to)) < 0) r.holders.push(String(c.issued_to)); }
      else { r.back += Math.max(inn - dmg - used, 0); r.missing += Math.max(num(c.qty_out) - inn, 0); r.damaged += dmg; r.used += used; }
    });
    Object.keys(by).forEach(function (k) { var s = by[k];
      if (s.went || s.alloc > 0) r.items++;
      if (!s.went) { r.out += s.alloc; r.given += s.alloc; r.unused += Math.max(s.live - s.alloc, 0); if (s.alloc > 0) r.outItems++; }
      else if (s.out > 0) r.outItems++; });
    return r;
  }
  // R258: "12 items: 10 back, 1 missing, 1 still out" - one state per item that was given out
  function stockWords(res, cos) {
    var SF = global.HelmStockFlow, by = {}, n = { back: 0, damaged: 0, missing: 0, out: 0 }, t = 0;
    if (SF) SF.eventItems({ reservations: res, checkouts: cos }).forEach(function (r) { if (!r.history.length && r.state !== "out") return; t++; n[n[r.state] == null ? "back" : r.state]++; });
    return !t ? "" : pl(t, "item") + ": " + [["back", "back"], ["damaged", "damaged"], ["missing", "missing"], ["out", "still out"]].filter(function (k) { return n[k[0]]; }).map(function (k) { return n[k[0]] + " " + k[1]; }).join(", ");
  }
  // who has left: marked Returned / exited on Teardown (booking "delivered"), or Left on Event-day command (arrivals, ref_id = the booking)
  function vendorsOf(list, arrivals) {
    var r = { total: 0, left: 0, here: [], enquiry: 0, noShow: 0 }, at = {};
    (Array.isArray(arrivals) ? arrivals : []).forEach(function (a) { if (a && a.ref_id) at[a.ref_id] = a.status; });
    (list || []).forEach(function (b) { if (!b || b.status === "cancelled") return; if (b.status === "enquiry") { r.enquiry++; return; }
      r.total++; if (b.status === "delivered" || at[b.id] === "left") r.left++; else if (at[b.id] === "no_show") r.noShow++; else r.here.push(String(b.label || "Partner")); });
    return r;
  }
  // R258: vendors whose items were not (all) handed back, from the newest answer of each live booking
  function notBackV(list, records) { var v = records && records !== "err" && records.vendor; return v ? (list || []).filter(function (b) { var s = b && b.status !== "cancelled" && b.status !== "enquiry" && v[b.id]; return s && (s.state === "not_returned" || s.state === "problem"); }) : []; }
  // R260 (0448): items that came in and are not checked out yet (0 = none, or not used)
  function itemsOut(d) { var VI = global.HelmVendorItems; return VI && VI.outOpen && d && d.vitems ? VI.outOpen(d.vitems) : 0; }
  function crewOut(tasks, sheet) {
    if (!sheet) return null; var ids = {}, r = { came: 0, out: 0, here: [] };
    Object.keys(sheet).forEach(function (id) { if (sheet[id] && sheet[id]["in"]) ids[id] = 1; });
    Object.keys(ids).forEach(function (id) { r.came++; if (sheet[id].out) r.out++; else r.here.push(id); });
    return r;
  }
  function names(a, max) { return a.slice(0, max).join(", ") + (a.length > max ? " and " + (a.length - max) + " more" : ""); }

  /* the rows of Wrap-up (pure): [{ id, title, tone "ok"|"warn"|"muted", status, text, link, linkText, items }] */
  function rowsOf(ctx, d) {
    d = d || {}; var rows = [], q = "?quote=" + encodeURIComponent(ctx.quoteId || ""), T = TS(), qq = ctx.quote || {};
    var open = openOf(ctx.tasks), total = liveOf(ctx.tasks).length, live = ["pre", "onday", "wrapup"].indexOf(ctx.autoWin) >= 0;
    rows.push({ id: "tasks", title: "Tasks", tone: open.length ? "warn" : total ? "ok" : "muted", status: open.length ? open.length + " open" : total ? "All done" : "None",
      text: open.length ? "Close each one: done, or cancelled with a reason." : total ? "Every task is closed." : "This event has no tasks.", items: open.concat(d.vendors === undefined && !d.perm ? [] : liveOf(ctx.tasks).filter(function (t) { return key(t) === "done" && T && T.taskStep && T.taskStep(t, { eventDate: qq.eventDate, eventTime: qq.eventTime, tz: ctx.tz }) === "wrapup"; })), link: "ops.html" + q, linkText: "Open Tasks & Crew" });
    var v = d.vendors;
    if (v === "err") rows.push(errRow("vendors", "Vendors", "teardown.html" + q, d.teardownPage)); else if (v) {
      var vs = vendorsOf(v, d.arrivals), nb = notBackV(v, d.records).length, io = itemsOut(d), ns = vs.noShow ? " " + vs.noShow + " did not come." : "";
      rows.push({ id: "vendors", title: "Vendors", tone: !vs.total || !live ? "muted" : vs.here.length || nb || io ? "warn" : "ok", status: !vs.total ? "None" : !live ? vs.total + " booked" : vs.here.length ? vs.here.length + " not left yet" : nb ? nb + " not all returned" : io ? pl(io, "item") + " to check out" : "All left",
        text: !vs.total ? "No vendors or rentals are booked." : vs.here.length ? "Not marked as left yet: " + names(vs.here, 4) + "." + (vs.left ? " " + vs.left + " of " + vs.total + " left." : "") + ns : pl(vs.left, "vendor") + " left the venue." + ns,
        link: d.teardownPage ? "teardown.html" + q : "", linkText: vs.here.length ? "Mark who has left" : "See vendors" });
    }
    var s = d.stock;
    if (s === "err") rows.push(errRow("stock", "Inventory", "teardown.html" + q, d.teardownPage)); else if (s) {
      var st = stock(s.res, s.cos), bits = [];
      if (st.given) { bits.push("Given out " + st.given); bits.push("came back " + st.back); if (st.out) bits.push("still out " + st.out); if (st.used) bits.push("used " + st.used); if (st.missing) bits.push("missing " + st.missing); if (st.damaged) bits.push("damaged " + st.damaged); }
      var words = stockWords(s.res, s.cos), txt = words ? words + "." : st.given ? bits.join(" · ") + "." + (st.holders.length ? " With: " + names(st.holders, 3) + "." : "") : "Nothing was given out for this event.";
      if (st.unused && !st.given) txt += " " + st.unused + " held but never taken out (nothing to return).";
      rows.push({ id: "stock", title: "Inventory", tone: st.out ? "warn" : st.given ? (st.missing || st.damaged ? "warn" : "ok") : "muted",
        status: st.out ? (st.outItems || 1) + " still out" : st.given ? (st.missing ? st.missing + " missing" : st.damaged ? st.damaged + " damaged" : "All back") : "None",
        text: txt, link: d.teardownPage ? "teardown.html" + q : "", linkText: st.out ? "Mark stock back" : "See stock" });
    }
    var c = d.checklist;
    if (c === "err") rows.push(errRow("teardown", "Other pack-up notes", "teardown.html" + q, d.teardownPage)); else if (c && c.length) {   // R258: only when lines exist (broken / missing has its own place now); Teardown adds the first one
      var left = c.filter(function (x) { return x && x.status === "open"; }), dn = c.length - left.length;
      rows.push({ id: "teardown", title: "Other pack-up notes", tone: left.length ? "warn" : "ok", status: dn + " of " + c.length + " done",
        text: left.length ? "Still to do: " + names(left.map(function (x) { return String(x.title || "item"); }), 3) + "." : "Cleared, handed over and checked.",
        link: d.teardownPage ? "teardown.html" + q : "", linkText: "Open teardown" });
    }
    var w = d.sheet === "err" ? null : crewOut(ctx.tasks, sheetFor(ctx, d));
    if (d.sheet === "err") rows.push(errRow("crew", "Crew check-out", "ops.html" + q, true));
    if (w && (w.came || live)) {
      var nm = function (id) { var t = liveOf(ctx.tasks).filter(function (x) { return x.crew_id === id; })[0]; var n = ""; try { n = t && ctx.nameOf ? ctx.nameOf(t) : (t && t.assignee_name) || ""; } catch (e) {} return n || (d.sheetNames && d.sheetNames[id]) || "Staff"; };
      rows.push({ id: "crew", title: "Crew check-out", tone: !w.came ? "muted" : w.here.length ? "warn" : "ok", status: !w.came ? "No check-ins" : w.here.length ? w.here.length + " still in" : "All checked out",
        text: !w.came ? "Nobody has checked in for this event." : w.here.length ? "Not checked out: " + names(w.here.map(nm), 4) + "." : pl(w.came, "person", "people") + " checked out.", link: "ops.html" + q, linkText: "Open Tasks & Crew" });
    }
    var i = d.issues;
    if (i === "err") rows.push(errRow("issues", "Open issues", "issues.html" + q, true)); else if (i) {
      var io = i.filter(function (x) { return x && x.status !== "resolved"; });
      rows.push({ id: "issues", title: "Open issues", tone: io.length ? "warn" : "ok", status: io.length ? io.length + " open" : "None open",
        text: io.length ? names(io.map(function (x) { return String(x.title || "issue"); }), 3) + "." : i.length ? "All " + i.length + " sorted." : "Nothing was logged.", link: "issues.html" + q, linkText: io.length ? "Sort issues" : "See issues" });
    }
    // R255 (0440): extras made that day - a list to decide on, never money by itself; not part of the progress
    var x = d.extras;
    if (x === "err") rows.push(errRow("extras", "Extras to decide", "", false)); else if (x && x.items) {
      var xl = x.items.filter(function (e) { return e && !e.cancelled_at; }), und = xl.filter(function (e) { return !e.decision; });
      if (xl.length) rows.push({ id: "extras", title: "Extras to decide", tone: und.length ? "warn" : "ok", status: und.length ? und.length + " to decide" : "All decided",
        text: names(xl.map(function (e) { return String(e.what || "extra"); }), 3) + ". Bill to client or our cost - the bill does not change by itself." });
    }
    return rows;
  }
  /* how far Wrap-up is (pure): tasks = the Wrap-up step's tasks + anything else still open, one per vendor / stock item / teardown line / person who
     came / issue. A part that could not be read is left out and named. -> { done, total, skipped: [words] } */
  function progress(ctx, d) {
    d = d || {}; var r = { done: 0, total: 0, skipped: [] }, add = function (done, total) { r.done += done; r.total += total; }, T = TS(), q = (ctx && ctx.quote) || {};
    var open = openOf(ctx.tasks), wrap = liveOf(ctx.tasks).filter(function (t) { return T && T.taskStep && T.taskStep(t, { eventDate: q.eventDate, eventTime: q.eventTime, tz: ctx.tz }) === "wrapup"; }), dn = wrap.filter(function (t) { return key(t) === "done"; }).length;
    if (!open.length && !dn && liveOf(ctx.tasks).length) add(1, 1); else add(dn, dn + open.length);   // R257: a part that is done counts as done ("All done", "None open")
    if (d.vendors === "err" || d.arrErr) r.skipped.push("vendors"); else if (d.vendors) { var v = vendorsOf(d.vendors, d.arrivals), vt = global.HelmVendorItems && d.vitems ? global.HelmVendorItems._pure.sumOf(d.vitems) : null; add(v.left + v.noShow, v.total); if (vt) add(vt.outDone, vt.outTotal); }
    if (d.stock === "err") r.skipped.push("stock"); else if (d.stock) { var s = stock(d.stock.res, d.stock.cos); add(s.items - s.outItems, s.items); }
    if (d.checklist === "err") r.skipped.push("pack-up notes"); else if (d.checklist) add(d.checklist.filter(function (x) { return x && x.status !== "open"; }).length, d.checklist.length);
    if (d.sheet === "err") r.skipped.push("crew"); else { var w = crewOut(ctx.tasks, sheetFor(ctx, d)); if (w) add(w.out, w.came); }
    if (d.issues === "err") r.skipped.push("issues"); else if (d.issues) { if (d.issues.length) add(d.issues.filter(function (x) { return x && x.status === "resolved"; }).length, d.issues.length); else add(1, 1); }
    return r;
  }
  // the freshest check-ins: Wrap-up's own read (event-wrap.js on the page), else what the page has
  function sheetFor(ctx, d) { var own = d && d.sheet && d.sheet !== "err" ? d.sheet : null; return d && d.ts && own ? own : ctx.sheet || own; }
  // R254: the guests have not even arrived yet -> say so first (nothing is blocked)
  function early(ctx) {
    var q = ctx.quote || {}, T = TS(), ev = String(q.eventDate || "").slice(0, 10), mn = T && T.hmMin ? T.hmMin(q.eventTime) : NaN, g = ev && isFinite(mn) && T.wallMs ? T.wallMs(ev, mn, ctx.tz) : NaN, m = Math.round((g - nowMs(ctx)) / 60000);
    if (!isFinite(m) || m <= 0) return "";
    var d = Math.floor(m / 1440), hr = Math.floor(m / 60), w = d > 1 ? d + " days" : hr >= 1 ? hr + (hr === 1 ? " hour" : " hours") : m + " min";
    return "The guests have not arrived yet - they are due in " + w + ". ";
  }
  // what is still open, for the confirm text of "Mark event complete": "" = nothing known
  function openWords(ctx, d) {
    d = d || {}; var a = [], n = openOf(ctx.tasks).length; if (n) a.push(pl(n, "task"));
    if (d.vendors && d.vendors !== "err" && !d.arrErr) { var v = vendorsOf(d.vendors, d.arrivals).here.length; if (v) a.push(pl(v, "vendor") + " not left"); var nb = notBackV(d.vendors, d.records).length; if (nb) a.push(pl(nb, "vendor") + " with items not all returned"); var io = itemsOut(d); if (io) a.push(pl(io, "vendor item") + " not checked out"); }
    if (d.stock && d.stock !== "err") { var s = stock(d.stock.res, d.stock.cos).out; if (s) a.push(s + (s === 1 ? " piece" : " pieces") + " of stock out"); }
    if (d.checklist && d.checklist !== "err") { var c = d.checklist.filter(function (x) { return x && x.status === "open"; }).length; if (c) a.push(pl(c, "pack-up note")); }
    var w = crewOut(ctx.tasks, sheetFor(ctx, d)); if (w && w.here.length) a.push(pl(w.here.length, "person", "people") + " not checked out");
    if (d.issues && d.issues !== "err") { var i = d.issues.filter(function (x) { return x && x.status !== "resolved"; }).length; if (i) a.push(pl(i, "open issue")); }
    var k = progress(ctx, d).skipped; return (a.length ? "Still open: " + a.join(", ") + ". " : "") + (k.length ? "Not checked: " + k.join(", ") + ". " : "");
  }
  function errRow(id, title, link, on) { return { id: id, title: title, tone: "muted", status: "Not checked", text: "Couldn’t check this just now.", link: on ? link : "", linkText: "Open it", retry: true }; }
  function summaryLine(ctx, d, stage) {
    if (stage === "closed") return "Event complete and closed";
    if (stage === "settlement") return "Event complete - next: settlement";
    var n = openOf(ctx.tasks).length, a = [n ? pl(n, "task") + " open" : liveOf(ctx.tasks).length ? "every task closed" : "no tasks"];
    if (d) {
      if (d.vendors && d.vendors !== "err") { var v = vendorsOf(d.vendors, d.arrivals); if (v.here.length && ctx.autoWin !== "daybefore") a.push(pl(v.here.length, "vendor") + " not left yet"); }
      if (d.stock && d.stock !== "err") { var s = stock(d.stock.res, d.stock.cos); if (s.out) a.push(s.out + (s.out === 1 ? " piece" : " pieces") + " of stock out"); }
      if (d.issues && d.issues !== "err") { var i = d.issues.filter(function (x) { return x && x.status !== "resolved"; }).length; if (i) a.push(pl(i, "issue") + " open"); }
    } else a.push("vendors, stock, crew, issues");
    var t = a.join(" · "); return t.charAt(0).toUpperCase() + t.slice(1);
  }

  /* ---------------- helpers (DOM, store) ---------------- */
  function B() { return global.BPStore; }
  function h(tag, a, kids) {
    var n = doc.createElement(tag);
    Object.keys(a || {}).forEach(function (k) {
      var v = a[k]; if (v === null || v === undefined || v === false) return;
      if (k === "text") n.textContent = String(v); else if (k === "cls") n.className = v;
      else if (k === "on") Object.keys(v).forEach(function (e) { n.addEventListener(e, v[e]); });
      else n.setAttribute(k, v === true ? "" : String(v));
    });
    (kids || []).forEach(function (c) { if (c === null || c === undefined || c === false) return; n.appendChild(typeof c === "string" ? doc.createTextNode(c) : c); });
    return n;
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  function sigOf(o) { try { return JSON.stringify(o); } catch (e) { return String(Math.random()); } }
  function focusKey(root) { var a = doc.activeElement; return a && root && root.contains(a) && a.getAttribute ? a.getAttribute("data-key") || null : null; }
  function restoreFocus(root, k) { if (!k || !root) return; var n = root.querySelector('[data-key="' + String(k).replace(/["\\]/g, "") + '"]'); if (n && doc.activeElement !== n) try { n.focus({ preventScroll: true }); } catch (e) {} }
  function qid(ctx) { var q = ctx && ctx.quoteId; return q && q !== "all" ? String(q) : ""; }
  function enc(s) { return encodeURIComponent(s || ""); }
  function nameOfEvent(ctx) { var q = ctx.quote || {}; return q.code || q.title || "this event"; }
  function applies(ctx) { return !!(qid(ctx) && ctx.quote && ctx.quote.status !== "cancelled"); }
  function nowMs(ctx) { return ctx.now == null ? Date.now() : Number(ctx.now); }
  function clock(ctx, iso) {
    var d = new Date(iso); if (!iso || isNaN(d.getTime())) return "";
    var loc = "en-IN"; try { loc = B().studioLocale(); } catch (e) {}
    try { return new Intl.DateTimeFormat(loc, { timeZone: ctx.tz || "Asia/Kolkata", hour: "numeric", minute: "2-digit" }).format(d); } catch (e) { return ""; }
  }
  function say(ctx, m, type) { try { if (ctx.toast) ctx.toast(m, type); else global.BPUI.toast(m, { type: type || "ok" }); } catch (e) {} }
  function errText(e, action) { try { return global.BPUI.friendlyError(e, { action: action }); } catch (x) { return "Couldn’t " + action + " - try again."; } }
  // a move made here shows at once, until the page's own reload brings the new stage (2 min at most)
  var MOVED = {}, BUSY = {}, PERM = null;
  function rawStage(ctx) { var q = ctx.quote || {}; return String(q.stage || q.lifecycleStage || q.lifecycle_stage || "quote"); }
  function stageOf(ctx) {
    var raw = rawStage(ctx), m = MOVED[qid(ctx)];
    if (m && m.from === raw && Date.now() - m.at < 120000) return m.stage; return raw;
  }
  function ask(f) { return Promise.resolve().then(f).then(function (v) { return !!v; }, function () { return false; }); }
  // { stage, admin, vendors, inventory, plan, staff, issues, settlement, closure, command } - once per page load
  function perms() {
    if (PERM && PERM.v && !PERM.v.role && Date.now() - PERM.at > 60000) PERM = null;   // the role could not be read: ask again in a minute
    if (PERM) return PERM.p; var A = B() && B().auth; if (!A || typeof A.canView !== "function") return Promise.resolve(null);
    PERM = { v: null, at: Date.now(), p: Promise.all(["vendors", "inventory", "plan", "staff", "issues", "settlement", "closure", "command"].map(function (k) { return ask(function () { return A.canView(k); }); })
      .concat([ask(function () { return A.canEditArea("quotes"); }), Promise.resolve().then(function () { return A.role(); }).catch(function () { return ""; })])).then(function (r) {
        PERM.v = { vendors: r[0], inventory: r[1], plan: r[2], staff: r[3], issues: r[4], settlement: r[5], closure: r[6], command: r[7], stage: r[8], admin: r[9] === "admin", role: String(r[9] || "") }; return PERM.v; }) };
    return PERM.p;
  }
  function may(ctx) {
    var p = PERM && PERM.v; if (ctx.canStage === undefined && !p) return null;
    return { stage: ctx.canStage === undefined ? p.stage : !!ctx.canStage, admin: ctx.admin === undefined ? !!(p && p.admin) : !!ctx.admin };
  }
  // the same calls, checks and messages as Tasks & Crew always used (R222 markComplete): confirm, one move at a time, admin override
  // and refusals inside setStageGuided, expired sign-in handled, then the page reloads the event
  async function moveStage(ctx, o) {
    var id = qid(ctx); if (!id || BUSY[id]) return false;
    BUSY[id] = true;
    var ok = false; try { ok = await global.BPUI.confirm(o.ask, { title: o.title, okLabel: o.okLabel }); } catch (e) { ok = false; }
    if (!ok) { BUSY[id] = false; o.redraw(); return false; }
    var done = false; o.redraw();
    try {
      var r = await B().quotes.setStageGuided(id, o.stage);
      if (r) { done = true; var to = r.stage || o.stage; MOVED[id] = { from: rawStage(ctx), stage: to, at: Date.now() }; if (global.HelmEventFloor && global.HelmEventFloor.stale) global.HelmEventFloor.stale(id); say(ctx, o.said(to, r), "ok"); }
    } catch (e) {
      var handled = false; try { handled = await B().auth.handleAuthError(e); } catch (x) {}
      if (!handled) say(ctx, errText(e, o.action), "err");
    }
    BUSY[id] = false;
    try { if (done && ctx.onChanged) await ctx.onChanged(); } catch (e) {}
    o.redraw(true);
    return done;
  }
  // blockers for a stage, kept per event + stage + day (asked again every 2 minutes while the page shows them)
  function loadBlk(S, ctx, stage, redraw) {
    var st = stageOf(ctx), k = [qid(ctx), st, (ctx.quote || {}).eventDate, TS() ? TS().ymdIn(ctx.tz, nowMs(ctx)) : "", stage].join("|");
    if (S.blkBusy === k || (S.blkKey === k && Date.now() - S.blkAt < BLK_MS)) return;
    if (S.blkKey !== k) S.blk = null;
    S.blkBusy = k;
    Promise.resolve().then(function () { return B().quotes.stageBlockers(qid(ctx), stage); }).catch(function () { return null; })
      .then(function (r) { if (S.blkBusy === k) S.blkBusy = ""; S.blkKey = k; S.blkAt = Date.now(); S.blk = r; redraw(); });
  }

  /* ---------------- Pre-event complete ---------------- */
  function renderPreDone(host, ctx) {
    if (!host || !doc) return; ctx = ctx || {};
    var show = applies(ctx) && (ctx.win == null || ctx.win === "pre");
    host.hidden = !show; var S = host._hes || (host._hes = { sig: "", q: "" }); S.ctx = ctx;
    if (!show) return;
    if (!S.vring && doc.addEventListener) { S.vring = true; doc.addEventListener("helm:vendor-items", function () { if (!host.hidden && S.ctx) renderPreDone(host, S.ctx); }); }   // R260: the open vendor items
    if (S.q !== qid(ctx)) { S.q = qid(ctx); S.sig = ""; S.blk = null; S.blkKey = ""; S.blkBusy = ""; }
    var redraw = function (again) { if (again) { S.blkKey = ""; } S.sig = ""; renderPreDone(host, S.ctx); };
    var st = stageOf(ctx), done = PAST_PRE.indexOf(st) >= 0, who = may(ctx);
    if (!done) { if (!who) { perms().then(function (p) { if (p) renderPreDone(host, S.ctx); }); } else if (who.stage) loadBlk(S, ctx, "event_day", function () { renderPreDone(host, S.ctx); }); }
    var s = preSummary(ctx), lines = preLines(s), ready = !!(who && who.stage && S.blkKey), g = gate(S.blk, who && who.admin), busy = !!BUSY[qid(ctx)];
    var mv = MOVED[qid(ctx)], at = ctx.preDoneAt || (mv && mv.stage === "event_day" ? new Date(mv.at).toISOString() : "");
    var sig = sigOf([st, done, at, lines, who, ready, S.blk, busy, ctx.autoWin]); if (S.sig === sig) return; S.sig = sig;
    var keep = focusKey(host), hid = (host.id || "hesPre") + "H", whyId = (host.id || "hesPre") + "Why"; clear(host);
    host.classList.add("hes"); host.classList.toggle("is-ok", done); host.setAttribute("aria-labelledby", hid);
    if (done) {
      host.appendChild(h("h3", { cls: "tc-h2", id: hid }, [h("span", { cls: "hes-dot ok", "aria-hidden": "true" }), "Pre-event complete"]));
      host.appendChild(h("p", { cls: "hes-sub", text: (clock(ctx, at) ? "Marked at " + clock(ctx, at) + ". " : "") + (st === "event_day" ? "The event is on Event Day. Open work stays on the list below." : "The event has moved on to " + (st === "closed" ? "Closed" : "Settlement") + ".") }));
      restoreFocus(host, keep); return;
    }
    host.appendChild(h("h3", { cls: "tc-h2", id: hid, text: "Before guests arrive" }));
    host.appendChild(h("p", { cls: "hes-sub", text: lines.length ? "Still open:" : "Nothing is open - set-up is done." }));
    if (lines.length) { var ul = h("ul", { cls: "hes-lines" }); lines.forEach(function (l) { ul.appendChild(h("li", { cls: l[0] }, [h("span", { cls: "hes-dot " + l[0], "aria-hidden": "true" }), h("span", { text: l[1] })])); }); host.appendChild(ul); }
    host.appendChild(h("p", { cls: "hes-hint", text: "Marking pre-event complete moves the event to Event Day in the quote workflow. Open tasks stay open, and nothing is locked." }));
    if (!who) { restoreFocus(host, keep); return; }
    if (!who.stage) { host.appendChild(h("p", { cls: "hes-hint strong", text: "Someone whose role can change Quotes (admin or event manager) marks pre-event complete." })); restoreFocus(host, keep); return; }
    var why = ready ? whyText(S.blk, "Event Day") : "";
    if (why) host.appendChild(h("p", { cls: "tc-note warn", id: whyId, text: why + "." }));
    var over = ready && g.blocked && g.can;
    host.appendChild(h("div", { cls: "hes-acts" }, [h("button", { type: "button", cls: "tc-btn" + (over || ctx.autoWin !== "pre" ? "" : " tc-primary"), "data-key": "pre:go",
      text: busy ? "Marking…" : over ? "Mark complete anyway (admin)…" : "Mark pre-event complete", disabled: !ready || !g.can || busy ? true : null, "aria-describedby": why ? whyId : null,
      on: { click: function (e) { if (e.detail > 1) return; var c = S.ctx, sm = preSummary(c);
        moveStage(c, { stage: "event_day", title: "Mark pre-event complete?", okLabel: "Mark complete", ask: confirmPre(nameOfEvent(c), sm), action: "mark pre-event complete", redraw: redraw,
          said: function () { return "Pre-event complete - the event is on Event Day."; } }); } } })]));
    restoreFocus(host, keep);
  }

  /* ---------------- Wrap-up ---------------- */
  // one read: not allowed (no area / refused) -> null = the row is hidden; anything else that fails -> "err" (a quiet row with Try again)
  function refused(e) { var c = String((e && (e.code || e.status)) || ""), m = String((e && e.message) || ""); return c === "42501" || c === "401" || c === "403" || c === "PGRST301" || /not authori|permission denied|row-level security|JWT/i.test(m); }
  function read(ok, f) { if (!ok) return Promise.resolve(null); return Promise.resolve().then(f).then(function (r) { return r == null ? null : r; }, function (e) { return refused(e) ? null : "err"; }); }
  function sheetOf(r) {
    if (!r || r === "err") return { map: r, names: {} }; var m = {}, nm = {};
    (r.rows || []).forEach(function (x) { if (!x || !x.crew_id) return; if (x.name) nm[x.crew_id] = String(x.name);
      var es = (x.entries || []).filter(function (k) { return k && k["in"]; }); if (!es.length) return;
      // the latest day worked: "still in" = that day has a check-in and no check-out
      var e = es.slice().sort(function (a, b) { return String(b.day).localeCompare(String(a.day)); })[0]; m[x.crew_id] = { "in": e["in"], out: e.out || "" }; });
    return { map: m, names: nm };
  }
  function reader(p, ctx) {
    var store = B(), inv = store.inventory, sh = store.ops && store.ops.shifts, id = qid(ctx);
    return {
      vendors: function () { return Promise.all([read(p.vendors && store.bookings, function () { return store.bookings.list(id); }), read(p.vendors && p.command && store.dayops, function () { return store.dayops.list(id, "arrival"); }),
          read(p.vendors && store.vendors && store.vendors.listAll, function () { return store.vendors.listAll(true); }), read(p.vendors && store.vendorRequests, function () { return store.vendorRequests.list(id, null); }),
          p.vendors && p.command && global.HelmVendorItems ? global.HelmVendorItems.load(id, 3000) : null])
        .then(function (r) { var nm = {}; if (Array.isArray(r[2])) r[2].forEach(function (v) { if (v && v.id) nm[v.id] = String(v.name || ""); }); return { vendors: r[0], arrivals: r[1] === "err" ? null : r[1], arrErr: r[1] === "err", vendorNames: nm, requests: Array.isArray(r[3]) ? r[3] : null, vitems: r[4] || null }; }); },
      records: function () { return read((p.vendors || p.inventory || p.command) && store.wrapRecords, function () { return store.wrapRecords.get(id); }).then(function (r) { return { records: r }; }); },
      stock: function () { return read(p.inventory && inv && inv.checkouts, function () { return Promise.all([inv.reservations(id), inv.checkouts.list(id), inv.stock && inv.stock.story ? Promise.resolve().then(function () { return inv.stock.story(id); }).catch(function () { return null; }) : null]).then(function (r) { return { res: r[0] || [], cos: r[1] || [], story: (r[2] && r[2].lines) || null }; }); })
        .then(function (r) { return { stock: r && r !== "err" ? { res: r.res, cos: r.cos } : r, story: r && r !== "err" ? r.story : null }; }); },
      teardown: function () { return read(p.plan && store.checklist, function () { return store.checklist.list(id, "teardown"); }).then(function (r) { return { checklist: r }; }); },
      crew: function () { return (ctx.sheet && !global.HelmWrapDo ? Promise.resolve(null) : read(p.staff && sh && sh.timesheet, function () { return sh.timesheet(id); })).then(function (r) { var x = sheetOf(r); return { sheet: x.map, sheetNames: x.names, ts: r && r !== "err" ? r : null }; }); },
      issues: function () { return read(p.issues && store.issues, function () { return store.issues.list(id); }).then(function (r) { return { issues: r }; }); },
      extras: function () { return read(p.issues && store.extras, function () { return store.extras.list(id); }).then(function (r) { return { extras: r }; }); }
    };
  }
  // one block again (after something was done in it, or Try again): the others keep what they have; an older answer never replaces a newer one
  function loadPart(S, part) {
    if (part === "vendors" || part === "stock") return Promise.all([loadOne(S, part), loadOne(S, "records")]);   // R258: their answers / notes live in the records
    return loadOne(S, part);
  }
  function loadOne(S, part) {
    var ctx = S.ctx, id = qid(ctx); S.seq = S.seq || {}; var n = S.seq[part] = (S.seq[part] || 0) + 1;
    return perms().then(function (p) { return p && reader(p, ctx)[part](); }).then(function (r) { if (!r || qid(S.ctx) !== id || S.seq[part] !== n) return; S.data = Object.assign({}, S.data || {}, r); if (S.redraw) S.redraw(); });
  }
  function load(S, redraw) {
    var id = qid(S.ctx), store = B(); if (!store || S.loading === id) return; S.loading = id; S.seq = S.seq || {};
    var keys = ["vendors", "records", "stock", "teardown", "crew", "issues", "extras"], at = keys.map(function (k) { return S.seq[k] || 0; });
    perms().then(function (p) {
      p = p || {}; var rd = reader(p, S.ctx);
      return Promise.all(keys.map(function (k) { return rd[k](); })).then(function (r) {
        if (S.loading === id) S.loading = ""; if (qid(S.ctx) !== id) return;
        var d = Object.assign({}, S.data || {}, { teardownPage: !!p.inventory, perm: p }); r.forEach(function (x, i) { if ((S.seq[keys[i]] || 0) === at[i]) Object.assign(d, x); });   // a block read again meanwhile keeps its newer answer
        S.data = d; S.at = Date.now(); redraw();
      });
    }).catch(function () { if (S.loading === id) S.loading = ""; });
  }
  function isPage(re) { try { return re.test(String(global.location.pathname || "")); } catch (e) { return false; } }
  function build(host, S) {
    clear(host); host.classList.add("hes", "hes-wraphost");
    S.sumTxt = h("span", { cls: "hes-sumtxt" }); S.nowEl = h("span", { cls: "hes-now", text: "Now", hidden: true });
    var hid = (host.id || "hesWrap") + "H";
    S.det = h("details", { cls: "hes-wrap" }, [
      h("summary", { cls: "hes-sum", "data-key": "wrap:sum" }, [h("span", { cls: "hes-chev", "aria-hidden": "true" }), h("span", { cls: "hes-sumh" }, [h("span", { cls: "hes-t", id: hid, text: "Wrap-up" }), S.nowEl]), S.sumTxt]),
      S.body = h("div", { cls: "hes-body" })]);
    host.setAttribute("aria-labelledby", hid);
    S.det.addEventListener("toggle", function () { S.open = S.det.open; if (S.open) { S.sig = ""; renderWrap(host, S.ctx); } });
    host.appendChild(S.det);
  }
  function renderWrap(host, ctx) {
    if (!host || !doc) return; ctx = ctx || {};
    var show = applies(ctx); host.hidden = !show; var S = host._hes || (host._hes = { q: "" }); S.ctx = ctx; if (!show) return;
    if (S.q !== qid(ctx) || !S.det || S.det.parentNode !== host) {   // another event = a fresh, closed section
      S.q = qid(ctx); S.data = null; S.at = 0; S.sig = ""; S.head = ""; S.open = false; S.more = false; S.tab = ""; S.tdOpen = false; S.blk = null; S.blkKey = ""; S.blkBusy = ""; S.hosts = {}; S.seq = {}; build(host, S);
    }
    var redraw = S.redraw = function (again) { if (again === true) S.blkKey = ""; S.sig = ""; renderWrap(host, S.ctx); };
    var st = stageOf(ctx), line = summaryLine(ctx, S.data, st), head = sigOf([line, ctx.autoWin === "wrapup"]);
    if (S.head !== head) { S.head = head; S.sumTxt.textContent = line; S.nowEl.hidden = ctx.autoWin !== "wrapup"; S.det.classList.toggle("is-now", ctx.autoWin === "wrapup"); }
    if (!S.det.open) return;   // closed: nothing is read, nothing is drawn
    if (Date.now() - (S.at || 0) > FRESH_MS) load(S, redraw);
    var T = TS(), done = POST.indexOf(st) >= 0, who = may(ctx), win = ctx.win || ctx.autoWin;
    var live = !T || !T.WIN_PHASE || T.WIN_PHASE[win] === "live" || T.WIN_PHASE[ctx.autoWin] === "live";
    if (!who) perms().then(function (p) { if (p) redraw(); });
    else if (!done && live && who.stage) loadBlk(S, ctx, "settlement", redraw);
    var rows = rowsOf(ctx, S.data || {}), ready = !!(who && who.stage && S.blkKey), g = gate(S.blk, who && who.admin), busy = !!BUSY[qid(ctx)];
    var pg = S.data ? progress(ctx, S.data) : null;
    var tabs = S.data ? tabsOf(rows) : []; if (S.data && !tabs.some(function (t) { return t.id === S.tab; })) S.tab = tabs.length ? tabs[0].id : "";
    paintDo(S, rows.filter(function (r) { return r.id === "teardown" || tabs.some(function (t) { return t.id === S.tab && t.ids.indexOf(r.id) >= 0; }); }));   // R253: what can be done under each row - drawn on its own, so a redraw of the rows never loses what somebody is typing
    var sig = sigOf([S.tab, pg, openWords(ctx, S.data), (ctx.quote || {}).eventDate, rows.map(function (r) { return !!(S.does && S.does[r.id]); }), st, done, live, who, ready, S.blk, busy, ctx.autoWin, !!S.data, S.more, S.data && S.data.perm, rows.map(function (r) { return [r.id, r.tone, r.status, r.text, r.link, (r.items || []).map(function (t) { return [t.id, t.title, key(t)]; })]; })]);
    if (S.sig === sig) return;
    var body = S.body, ae = doc.activeElement; if (ae && body.contains && body.contains(ae) && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName) && ae.type !== "checkbox") return;   // someone is typing in a block: the next refresh draws it
    S.sig = sig; var keep = focusKey(body); clear(body);
    if (pg && pg.total) body.appendChild(h("div", { cls: "hes-prog" }, [h("b", { text: pg.done + " of " + pg.total + " wrap-up items done" }), h("progress", { max: String(pg.total), value: String(pg.done), "aria-hidden": "true" }), pg.skipped.length ? h("span", { cls: "hes-hint", text: "Not checked: " + pg.skipped.join(", ") + "." }) : null]));
    if (tabs.length) body.appendChild(tabBar(S, host, tabs));
    var cur = tabs.filter(function (t) { return t.id === S.tab; })[0], pid = (host.id || "hesWrap") + "P", pan = h("div", { cls: "hes-panel", role: "tabpanel", id: pid, "aria-labelledby": pid + (cur ? cur.id : "") });
    if (cur) { var ul = h("ul", { cls: "hes-rows" }); rows.forEach(function (r) { if (cur.ids.indexOf(r.id) >= 0) ul.appendChild(rowEl(r, S, host)); }); pan.appendChild(ul); }
    if (tabs.length) body.appendChild(pan);
    var td = rows.filter(function (r) { return r.id === "teardown"; })[0];
    if (td) { var det = h("details", { cls: "hes-more" }, [h("summary", { cls: "hwd-sumline", "data-key": "td:sum", text: td.title + " (" + td.status + ")" }), h("ul", { cls: "hes-rows" }, [rowEl(td, S, host)])]); det.open = !!S.tdOpen; det.addEventListener("toggle", function () { S.tdOpen = det.open; }); body.appendChild(det); }
    var DO = global.HelmWrapDo; if (DO && DO.notes && S.data) { S.hosts.notes = S.hosts.notes || h("div", { cls: "hwd is-notes" }); DO.notes(S.hosts.notes, envOf(S)); body.appendChild(S.hosts.notes); }
    if (!S.data) body.appendChild(h("p", { cls: "hes-hint", role: "status", text: "Checking vendors, stock, crew and issues…" }));
    body.appendChild(finish(S, st, done, live, who, ready, g, busy, redraw));
    restoreFocus(body, keep);
  }
  function envOf(S) { return { q: qid(S.ctx), ctx: S.ctx, data: S.data, redraw: S.redraw, reload: function (part) { return loadPart(S, part); } }; }
  /* R258 (owner: "add a tab like check-in inventory or check-in vendor items"): Wrap-up in tabs - one open at a time, each with its state */
  var TABS = [["stock", "Inventory", ["stock"]], ["vendors", "Vendors", ["vendors"]], ["crew", "Crew", ["crew"]], ["tasks", "Tasks & issues", ["tasks", "issues"]], ["extras", "Extras", ["extras"]]], TRANK = { warn: 0, ok: 1, muted: 2 };
  function tabsOf(rows) {
    return TABS.map(function (t) { var l = rows.filter(function (r) { return t[2].indexOf(r.id) >= 0; }); if (!l.length) return null;
      var w = l.slice().sort(function (a, b) { return TRANK[a.tone] - TRANK[b.tone]; })[0], sum = l.length > 1 && w.tone === "warn" ? l.filter(function (r) { return r.tone === "warn"; }).map(function (r) { return r.status + (r.id === "issues" ? (r.status === "1 open" ? " issue" : " issues") : ""); }).join(", ") : w.status;
      return { id: t[0], title: t[1], ids: t[2], tone: w.tone, status: sum }; }).filter(Boolean);
  }
  function tabBar(S, host, tabs) {
    var pid = (host.id || "hesWrap") + "P", bar = h("div", { cls: "hes-tabs", role: "tablist", "aria-label": "Wrap-up" });
    var go = function (id) { if (S.tab === id) return; S.tab = id; S.sig = ""; var a = doc.activeElement; if (a && S.body.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) a.blur(); renderWrap(host, S.ctx); };
    tabs.forEach(function (t, i) { var on = t.id === S.tab;
      bar.appendChild(h("button", { type: "button", role: "tab", cls: "hes-tab " + t.tone, id: pid + t.id, "data-key": "tab:" + t.id, "aria-selected": String(on), "aria-controls": pid, tabindex: on ? "0" : "-1", on: { click: function () { go(t.id); }, keydown: function (e) {
        var k = e.key, j = k === "ArrowRight" ? i + 1 : k === "ArrowLeft" ? i - 1 : k === "Home" ? 0 : k === "End" ? tabs.length - 1 : -1; if (k !== "ArrowRight" && k !== "ArrowLeft" && k !== "Home" && k !== "End") return; e.preventDefault(); j = (j + tabs.length) % tabs.length; go(tabs[j].id); var n = S.body.querySelector('[data-key="tab:' + tabs[j].id + '"]'); if (n) n.focus(); } } },
        [h("span", { cls: "hes-dot " + t.tone, "aria-hidden": "true" }), h("span", { cls: "hes-tab-t", text: t.title }), h("span", { cls: "hes-tab-s", text: t.status })])); });
    return bar;
  }
  // the doing part of each row lives in its own host, kept across redraws
  function paintDo(S, rows) {
    var DO = global.HelmWrapDo; S.does = {}; if (!DO || !S.data) return; S.hosts = S.hosts || {};
    var env = envOf(S); if (DO.notes && S.hosts.notes) DO.notes(S.hosts.notes, env);
    rows.forEach(function (r) { if (!DO.has(r.id) || r.retry) return; var n = S.hosts[r.id] || (S.hosts[r.id] = h("div", { cls: "hwd" })); S.does[r.id] = DO.paint(r.id, n, env) || !!n.firstChild; });
  }
  function rowEl(r, S, host) {
    var ctx = S.ctx, kids = [h("div", { cls: "hes-row-h" }, [h("span", { cls: "hes-dot " + r.tone, "aria-hidden": "true" }), h("strong", { cls: "hes-row-t", text: r.title }), h("span", { cls: "hes-pill " + r.tone, text: r.status })]),
      S.does && S.does[r.id] && r.id !== "stock" ? null : h("p", { cls: "hes-sub", text: r.text })];
    if (r.items && r.items.length) {
      var max = S.more ? r.items.length : 5, ul = h("ul", { cls: "hes-tasks" });
      r.items.slice(0, max).forEach(function (t) {
        var T = TS(), k = T ? T.shown(t, nowMs(ctx)) : key(t), nm = ""; try { nm = (ctx.nameOf && ctx.nameOf(t)) || t.assignee_name || ""; } catch (e) {}
        var label = [h("span", { cls: "hes-task-t", text: t.title || "Task" }), h("span", { cls: "hes-task-s", text: ((T && T.LABEL[k]) || "") + (nm ? " · " + nm : "") })];
        ul.appendChild(h("li", null, [ctx.openTask ? h("button", { type: "button", cls: "hes-task", "data-key": "task:" + t.id, on: { click: function () { var c = S.ctx; if (c.openTask) c.openTask(t.id); } } }, label)
          : h("a", { cls: "hes-task", "data-key": "task:" + t.id, href: "ops.html?quote=" + enc(qid(ctx)) + "&task=" + enc(t.id) }, label)]));
      });
      kids.push(ul);
      if (r.items.length > 5) kids.push(h("button", { type: "button", cls: "tc-btn sm", "data-key": "more", "aria-expanded": String(!!S.more), text: S.more ? "Show fewer" : "Show all " + r.items.length, on: { click: function () { S.more = !S.more; S.sig = ""; renderWrap(host, S.ctx); } } }));
    }
    var does = !!(S.does && S.does[r.id]); if (does) kids.push(S.hosts[r.id]);
    var acts = [];
    if (r.retry) acts.push(h("button", { type: "button", cls: "tc-btn sm", "data-key": "retry:" + r.id, text: "Try again", on: { click: function () { if (global.HelmWrapDo) { loadPart(S, r.id); return; } S.at = 0; S.sig = ""; renderWrap(host, S.ctx); } } }));
    if (r.link && !does && !((r.id === "tasks" || r.id === "crew") && isPage(/\/ops(\.html)?$/))) acts.push(h("a", { cls: "hes-link", "data-key": "go:" + r.id, href: r.link, text: r.linkText + " →" }));
    if (acts.length) kids.push(h("div", { cls: "hes-row-a" }, acts));
    return h("li", { cls: "hes-row " + r.tone }, kids);
  }
  function links(S, first) {
    var ctx = S.ctx, p = (S.data && S.data.perm) || (PERM && PERM.v) || {}, row = h("div", { cls: "hes-next" }), n = 0;
    [["Teardown", "teardown.html", "inventory"], ["Settlement", "settlement.html", "settlement"], ["Closure", "closure.html", "closure"]].forEach(function (l) {
      if (p[l[2]] === false) return; n++;
      row.appendChild(h("a", { cls: "tc-btn" + (first && n === 1 ? " tc-primary" : ""), "data-key": "next:" + l[2], href: l[1] + "?quote=" + enc(qid(ctx)), text: n + " " + l[0] + " →" }));
    });
    return row;
  }
  function finish(S, st, done, live, who, ready, g, busy, redraw) {
    var ctx = S.ctx, box = h("div", { cls: "hes-finish" + (done ? " ok" : "") }), over = ctx.autoWin === "wrapup", whyId = (S.det.parentNode.id || "hesWrap") + "Why";
    if (done) {
      box.appendChild(h("h4", { cls: "hes-h", text: "Event complete" + (st === "closed" ? " and closed" : "") }));
      box.appendChild(h("p", { cls: "hes-sub", text: st === "closed" ? "Everything is settled and the event is closed." : "Next: bring the stock back, settle the money, then close the event." }));
      box.appendChild(links(S, st !== "closed")); return box;
    }
    box.appendChild(h("h4", { cls: "hes-h", text: over ? "The event day is over - mark it complete" : "When the event is over" }));
    box.appendChild(h("p", { cls: "hes-sub", text: "Marking it complete moves the event to the Settlement stage. Then: bring the stock back (Teardown), settle the money (Settlement) and close the event (Closure). Tasks stay as they are." }));
    if (!live) box.appendChild(h("p", { cls: "hes-hint", text: "You can mark the event complete on the event day." }));
    else if (who && !who.stage) box.appendChild(h("p", { cls: "hes-hint strong", text: "Someone whose role can change Quotes marks the event complete." }));
    else if (who) {
      var why = ready ? whyText(S.blk, "Settlement") : "", anyway = ready && g.blocked && g.can, noDate = (ctx.quote || {}).dateSet === false || !/^\d{4}-\d{2}-\d{2}/.test(String((ctx.quote || {}).eventDate || ""));
      if (why) box.appendChild(h("p", { cls: "tc-note warn", id: whyId, text: why + "." }));
      if (noDate && who.stage) box.appendChild(h("div", { cls: "hes-acts" }, [h("a", { cls: "tc-btn tc-primary", "data-key": "wrap:date", href: "event.html?id=" + enc(qid(ctx)), text: "Set the event date" })]));   // first things first
      box.appendChild(h("div", { cls: "hes-acts" }, [h("button", { type: "button", cls: "tc-btn" + (over && !anyway && !noDate ? " tc-primary" : noDate ? " ghost" : ""), "data-key": "wrap:go",
        text: busy ? "Marking…" : anyway ? "Mark complete anyway (admin)…" : "Mark event complete → Settlement", disabled: !ready || !g.can || busy ? true : null, "aria-describedby": why ? whyId : null,
        on: { click: function (e) { if (e.detail > 1) return; var c = S.ctx;
          moveStage(c, { stage: "settlement", title: "Mark event complete?", okLabel: "Mark complete", action: "mark the event complete", redraw: redraw,
            ask: "Mark " + nameOfEvent(c) + " complete? " + early(c) + openWords(c, S.data) + "It moves to Settlement. Tasks, crew and check-ins stay as they are.",
            said: function (to) { return "Event complete - moved to " + (to === "closed" ? "Closed" : "Settlement") + "."; } }); } } })]));
    }
    box.appendChild(links(S, false));
    return box;
  }

  global.HelmEventSteps = { renderPreDone: renderPreDone, stageOf: stageOf, mayStage: function (ctx, then) { var w = may(ctx); if (!w && then) perms().then(function (p) { if (p) then(); }); return w ? w.stage : null; }, _pure: { preSummary: preSummary, preLines: preLines, confirmPre: confirmPre, whyText: whyText, gate: gate } };
  global.HelmEventWrap = { render: renderWrap, _pure: { stock: stock, vendorsOf: vendorsOf, crewOut: crewOut, rowsOf: rowsOf, tabsOf: tabsOf, stockWords: stockWords, notBackV: notBackV, progress: progress, openWords: openWords, early: early, summaryLine: summaryLine, refused: refused, sheetOf: sheetOf } };
  // a new sign-in / role on the same page starts from a clean slate (tests use it too)
  global.HelmEventSteps._reset = function () { PERM = null; MOVED = {}; BUSY = {}; };
})(typeof window !== "undefined" ? window : globalThis);
