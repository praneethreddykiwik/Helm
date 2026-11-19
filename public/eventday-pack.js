/* eventday-pack.js - R227: the printed Event-day pack (eventday-pack.html?quote=<id>). One A4 document for the crew lead:
 *   the 2D floor plan with the hall's sizes + legend + measurements (seats vs guests, stage / dance floor, aisles),
 *   the run-sheet (times, who, where), the crew call sheet (name, role, call time; the phone only when the viewer's role can
 *   see the crew list), the set-up jobs with their latest start (0396), the Day-before checklist, the venue address and
 *   access time, Ready by, and whether the plan is locked (0397).
 * NO MONEY: no price, total or payment is read for this page (the floor plan comes from event_floor_get, which strips prices;
 * the fallback before 0397 reads only the layout version's shapes). Print = window.print() with the page's print stylesheet
 * (eventday-pack.css): no app chrome, A4 margins, sections kept whole where they fit. DOM only (textContent), no HTML strings. */
(function (global) {
  "use strict";
  var doc = global.document, $ = function (s) { return doc.querySelector(s); };
  var EF = global.HelmEventFloor, EP = global.HelmEventPlan, TS = global.HelmTaskStatus;
  function h(tag, o, kids) {
    var n = doc.createElement(tag); o = o || {};
    Object.keys(o).forEach(function (k) { var v = o[k]; if (v == null || v === false) return;
      if (k === "cls") n.className = v; else if (k === "text") n.textContent = v; else n.setAttribute(k, v === true ? "" : String(v)); });
    (kids || []).forEach(function (c) { if (c == null || c === false) return; n.appendChild(typeof c === "string" ? doc.createTextNode(c) : c); });
    return n;
  }
  function tz() { try { return (global.BPStore && BPStore.studioTimezone && BPStore.studioTimezone()) || "Asia/Kolkata"; } catch (e) { return "Asia/Kolkata"; } }
  function clockMs(t) {
    if (!isFinite(t)) return "";
    try { return new Intl.DateTimeFormat("en-IN", { timeZone: tz(), hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(t)).replace(/\s?([ap])m$/i, function (x, a) { return " " + a.toUpperCase() + "M"; }); }
    catch (e) { return new Date(t).toISOString().slice(11, 16); }
  }
  function hm(s) {   // "18:30" / "18:30:00" -> "6:30 PM"
    var m = /^(\d{1,2}):(\d{2})/.exec(String(s || "")); if (!m) return String(s || "");
    var hh = +m[1], mm = m[2]; return (hh % 12 || 12) + ":" + mm + " " + (hh < 12 ? "AM" : "PM");
  }
  function addMin(s, d) { var m = /^(\d{1,2}):(\d{2})/.exec(String(s || "")); if (!m || !(+d > 0)) return ""; var t = (+m[1] * 60 + +m[2] + Math.round(+d)) % 1440; return hm(String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0")); }
  function dateWords(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || "")); if (!m) return "";
    try { return new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12))); } catch (e) { return iso; }
  }
  function nowWords() { try { return new Intl.DateTimeFormat("en-IN", { timeZone: tz(), day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date()); } catch (e) { return new Date().toISOString(); } }
  function section(id, title, sub) {
    var s = h("section", { cls: "pk-sec", id: id, "aria-labelledby": id + "H" }, [h("h2", { id: id + "H", text: title })]);
    if (sub) s.appendChild(h("p", { cls: "pk-sub", text: sub })); return s;
  }
  function table(head, rows, cls) {
    var t = h("table", { cls: "pk-tbl" + (cls ? " " + cls : "") }), th = h("tr");
    head.forEach(function (x) { th.appendChild(h("th", { scope: "col", text: x })); });
    t.appendChild(h("thead", {}, [th]));
    var tb = h("tbody"); rows.forEach(function (r) { var tr = h("tr"); r.forEach(function (c) { tr.appendChild(h("td", {}, [c == null ? "" : typeof c === "string" ? c : c])); }); tb.appendChild(tr); });
    t.appendChild(tb); return t;
  }
  function empty(text) { return h("p", { cls: "pk-empty", text: text }); }

  /* ---- pure: who comes when (crew call sheet) ---- */
  function callSheet(tasks, crew, o) {
    o = o || {}; var byCrew = {}, list = [], crewIx = {};
    (crew || []).forEach(function (c) { if (c && c.id) crewIx[c.id] = c; });
    var ls = {}; ((o.schedule && o.schedule.rows) || []).forEach(function (r) { if (r && r.t) ls[r.t.id] = r.ls; });
    (tasks || []).forEach(function (t) {
      if (!t || t.status === "cancelled" || t.status === "rejected") return;
      var key = t.crew_id || (t.vendor_id ? "v:" + t.vendor_id : t.assignee_name ? "n:" + String(t.assignee_name).toLowerCase() : "");
      if (!key) return;
      var c = t.crew_id ? crewIx[t.crew_id] : null;
      var p = byCrew[key] || (byCrew[key] = { name: (c && c.name) || t.assignee_name || "Vendor", role: (c && (c.role || c.department)) || t.category || "",
        phone: "", at: NaN, tasks: 0, vendor: t.assignee_kind === "outsourced" || !!t.vendor_id });
      if (!p.phone) p.phone = String((c && c.phone) || t.assignee_phone || "");
      p.tasks++;
      var st = Date.parse(t.planned_start || ""); if (!isFinite(st) && isFinite(ls[t.id])) st = ls[t.id];
      if (isFinite(st) && (!isFinite(p.at) || st < p.at)) p.at = st;
    });
    Object.keys(byCrew).forEach(function (k) { list.push(byCrew[k]); });
    list.sort(function (a, b) { return (isFinite(a.at) ? a.at : 9e15) - (isFinite(b.at) ? b.at : 9e15) || a.name.localeCompare(b.name); });
    return list;
  }

  async function load(id) {
    var B = global.BPStore, out = { id: id };
    var tries = [
      B.ops && B.ops.planLock ? B.ops.planLock.floor(id).then(function (f) { out.floor = f; }, function (e) { out.floorErr = e; }) : null,
      B.ops && B.ops.dayPlan ? B.ops.dayPlan.get(id).then(function (p) { out.plan = p; }, function () { out.plan = null; }) : null,
      B.runsheet ? B.runsheet.list(id).then(function (r) { out.rs = r || []; }, function () { out.rs = null; }) : null,
      B.ops && B.ops.listTasks ? B.ops.listTasks(id).then(function (t) { out.tasks = t || []; }, function () { out.tasks = null; }) : null,
      B.ops && B.ops.listCrew ? B.ops.listCrew().then(function (c) { out.crew = c || []; }, function () { out.crew = []; }) : null
    ];
    await Promise.all(tries.filter(Boolean));
    // event facts: the floor answer (0397); before it, the quote's own name / date / venue (never its prices)
    if (!out.floor) {
      try {
        var q = await B.quotes.get(id), cl = q.client || {};
        out.event = { code: q.code, title: q.title, date: q.eventDate, time: q.eventTime };
        out.venue = { name: cl.venue || "", address: [cl.address, cl.city].filter(Boolean).join(", ") };
        try { var v = await B.quotes.getVersion(id, q.currentVersion); var d = (v && v.data) || {};
          out.floor0 = { items: d.items || [], world: d.scale && d.scale.worldFt, unit: d.grid && d.grid.unit, version_no: v.versionNo,
            hall: { len: cl.hallLen, wid: cl.hallWid, venue_len: cl.venueLen, venue_wid: cl.venueWid }, guests: cl.guests, capacity: d.venue && d.venue.capacity }; } catch (e) {}
      } catch (e) { out.event = null; }
    } else { out.event = out.floor.event || {}; out.venue = out.floor.venue || {}; }
    return out;
  }

  function render(D) {
    var root = $("#pack"); while (root.firstChild) root.removeChild(root.firstChild);
    var ev = D.event || {}, fl = D.floor || D.floor0 || null, lock = D.floor && D.floor.lock, plan = D.plan;
    var title = [ev.code, ev.title && ev.title !== ev.code ? ev.title : ""].filter(Boolean).join(" · ") || "Event";
    try { doc.title = "Event-day pack · " + title; } catch (e) {}
    // ---- header ----
    var rAt = EP && plan ? EP.readyAt(plan, ev.date, ev.time, tz()) : NaN, vAt = EP && plan ? EP.venueAt(plan, ev.date, tz()) : NaN;
    var facts = h("dl", { cls: "pk-facts" });
    function fact(k, v) { if (!v) return; facts.appendChild(h("div", {}, [h("dt", { text: k }), h("dd", { text: v })])); }
    fact("Date", dateWords(ev.date)); fact("Guests arrive", ev.time ? hm(ev.time) : "");
    fact("Ready by", isFinite(rAt) ? clockMs(rAt) + (plan && !plan.ready_by ? " (1 h before guests)" : "") : "not set");
    fact("Venue opens", isFinite(vAt) ? clockMs(vAt) : "");
    var vn = D.venue || {}; fact("Venue", vn.name); fact("Address", vn.address); fact("Venue contact", vn.contact); fact("Access", vn.access_notes);
    if (fl && fl.guests) fact("Guests", String(fl.guests));
    var head = h("header", { cls: "pk-head" }, [h("p", { cls: "pk-kicker", text: "Event-day pack" }), h("h1", { text: title }), facts,
      h("p", { cls: "pk-lock " + (lock && lock.locked ? "on" : "off"), text: lock ? (lock.locked ? "🔒 Plan locked for the event day" + (lock.state === "locked" && lock.changed_by ? " by " + lock.changed_by : "") + " - this is the final plan."
        : "Plan not locked - it may still change. Lock it on Tasks & Crew when it is final.") : "" })]);
    root.appendChild(head);

    // ---- 1 floor plan ----
    var s1 = section("pkFloor", "1 · Floor plan", fl && fl.version_no ? "Layout version V" + fl.version_no : "");
    if (fl && EF && EF.normalize(fl).items.length) {
      var fig = h("figure", { cls: "pk-fig" }); fig.appendChild(EF.planSvg(doc, fl)); fig.appendChild(EF.legendEl(fl)); s1.appendChild(fig);
      var mz = EF.measure(fl); s1.appendChild(EF.factsEl(mz));
      if (mz.warnings.length) s1.appendChild(h("p", { cls: "pk-warn", text: "Check: " + mz.warnings.join("; ") + "." }));
    } else s1.appendChild(empty(D.floorErr ? "Your role can't open the floor plan." : "No floor plan saved for this event yet."));
    root.appendChild(s1);

    // ---- 2 run-sheet ----
    var s2 = section("pkRun", "2 · Run-sheet", "The minute-by-minute plan for the day.");
    if (Array.isArray(D.rs) && D.rs.length) s2.appendChild(table(["Time", "Until", "What", "Who", "Where"], D.rs.map(function (r) {
      return [r.start_time ? hm(r.start_time) : "-", addMin(r.start_time, r.duration_min), h("b", { text: r.title || "Item" }), r.owner || "", r.location || ""]; }), "pk-run"));
    else s2.appendChild(empty(D.rs === null ? "Your role can't open the run-sheet." : "No run-sheet lines yet."));
    root.appendChild(s2);

    // ---- 3 crew call sheet ----
    var sch = EP && plan && Array.isArray(D.tasks) ? EP.schedule(D.tasks, { readyAt: rAt, venueAt: vAt, bufPct: plan.settings && plan.settings.buffer_pct, now: Date.now() }) : null;
    var s3 = section("pkCrew", "3 · Crew call sheet", "Who comes when (the first start of each person's work).");
    if (Array.isArray(D.tasks)) {
      var cs = callSheet(D.tasks, D.crew, { schedule: sch }), showPhone = cs.some(function (p) { return p.phone; });
      if (cs.length) s3.appendChild(table(["Name", "Role", "Call time", "Tasks"].concat(showPhone ? ["Phone"] : []), cs.map(function (p) {
        return [h("b", { text: p.name }), p.role + (p.vendor ? " (vendor)" : ""), isFinite(p.at) ? clockMs(p.at) : (isFinite(vAt) ? "by " + clockMs(vAt) : "-"), String(p.tasks)].concat(showPhone ? [p.phone] : []); }), "pk-crew"));
      else s3.appendChild(empty("No one has work on this event yet."));
    } else s3.appendChild(empty("Your role can't see the crew list."));
    root.appendChild(s3);

    // ---- 4 set-up jobs with the latest start (0396) ----
    if (sch && sch.rows && sch.rows.length) {
      var s4 = section("pkJobs", "4 · Set-up jobs", "Latest start to be ready by " + (isFinite(rAt) ? clockMs(rAt) : "Ready by") + " (" + ((plan.settings && plan.settings.buffer_pct) == null ? 15 : plan.settings.buffer_pct) + "% buffer).");
      s4.appendChild(table(["Start by", "Job", "Who", "Takes", "Needs first"], sch.rows.map(function (r) {
        return [r.state === "done" ? "✓ done" : clockMs(r.ls), h("b", { text: r.t.title || "Task" }), r.t.assignee_name || "", EP.durWords(r.dur), r.need ? r.need.title || "" : ""]; })));
      root.appendChild(s4);
    }

    // ---- 5 day-before checklist ----
    if (plan && EP) {
      var s5 = section("pkCheck", (sch && sch.rows && sch.rows.length ? "5" : "4") + " · Day-before checklist"), ck = plan.checks || {};
      var done = EP.DAYBEFORE.filter(function (d) { return ck[d[0]] && ck[d[0]].done; }).length;
      s5.appendChild(h("p", { cls: "pk-sub", text: done + " of " + EP.DAYBEFORE.length + " done" }));
      var ul = h("ul", { cls: "pk-checks" });
      EP.DAYBEFORE.forEach(function (d) { var c = ck[d[0]] || {}, on = !!c.done;
        ul.appendChild(h("li", { cls: on ? "on" : "" }, [h("span", { cls: "pk-box", "aria-hidden": "true", text: on ? "✓" : "" }), h("span", {}, [h("b", { text: d[1] }), on && (c.by || c.at) ? h("small", { text: " - " + [c.by, c.at ? new Date(c.at).toLocaleDateString("en-IN") : ""].filter(Boolean).join(", ") }) : null])])); });
      s5.appendChild(ul); root.appendChild(s5);
    }
    root.appendChild(h("footer", { cls: "pk-foot", text: "Printed from Helm · " + nowWords() + " · no prices on this sheet" }));
    root.hidden = false;
  }

  async function start() {
    var B = global.BPStore, id = null;
    try { id = new URLSearchParams(global.location.search).get("quote"); } catch (e) {}
    $("#pkPrint").addEventListener("click", function () { global.print(); });
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) { $("#pkMsg").textContent = "Open this page from an event (Tasks & Crew → Floor plan → Print event-day pack)."; $("#pkMsg").hidden = false; return; }
    var back = $("#pkBack"); back.setAttribute("href", "ops.html?quote=" + encodeURIComponent(id));
    await B.init();
    if (B.auth.enabled() && B.auth.required() && !B.auth.user()) { global.location.replace("login.html?next=" + encodeURIComponent("eventday-pack.html?quote=" + id)); return; }
    $("#pkMsg").textContent = "Getting the event ready to print…"; $("#pkMsg").hidden = false;
    var D = await load(id);
    if (!D.event && !D.floor) { $("#pkMsg").textContent = "This event could not be opened - it may belong to another studio, or your role can't see it."; return; }
    $("#pkMsg").hidden = true; render(D);
    try { if (new URLSearchParams(global.location.search).get("print") === "1") setTimeout(function () { global.print(); }, 400); } catch (e) {}
  }

  global.HelmEventdayPack = { callSheet: callSheet, render: render, load: load, hm: hm, addMin: addMin };
  if (typeof module !== "undefined" && module.exports) module.exports = global.HelmEventdayPack;
  if (doc && !global.HELM_PACK_NO_START) {
    var go = function () { (global.BPUI && global.BPUI.boot ? global.BPUI.boot(start) : start()); };
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", go); else go();
  }
})(typeof window !== "undefined" ? window : globalThis);
