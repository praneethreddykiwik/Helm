/* monitor.js - R181 Event-day monitor (owner, 16 Nov 2026: "instead of just this section I want a web page just like
 * Tasks & crew - sort by staff, sort by work - monitor everything: this work is done, what else is leftover").
 *
 * One page, four views of the same task list: By staff / By work (section) / By status (columns) / Leftover.
 * Data (all existing, nothing new in the database):
 *   BPStore.ops.live.today(72)        live_events_today (0365): today's + next-3-days events with counts (office roles only)
 *   BPStore.ops.crew.schedule(a, b)   crew_schedule (0161/0365): the rest of the month's events that have work on them
 *   BPStore.ops.listTasks(quote)      event_tasks for one event (RLS: own studio, Staff area)
 *   BPStore.ops.listCrew()            names / departments / linked logins (for the online dot)
 *   BPStore.ops.shifts.timesheet(q)   event_timesheet (0265): who checked in (null without 0265)
 *   BPStore.ops.emailTasks(task,false) staff_email_send (0361): "Send by email" nudge (Staff edit only, server-checked)
 *   R184: BPStore.ops.live.activity(q)  event_day_activity (0368): every update, newest first (null before 0368: the page then
 *         builds the timeline from the task step times it already has); BPStore.ops.shifts.availability(day, day)
 *         crew_availability_range (0265): who marked the event day "can't work", with their reason.
 *   R184 tabs: "Check-in" (each person: in / out times, late, hours) and "Activity" (the full timeline, filter by person / type).
 *   R186 (0369): special tasks not started climb an escalation ladder (coordinator -> manager -> admin / owner); each step is
 *   in the timeline (kind "escalated") and the Late panel shows the latest one as a badge ("Escalated to manager 3:10 PM").
 * Gate: BPStore.auth.requireView("staff") - same as Tasks & staff. Crew never see this page.
 * R194 layout (owner: "organise this page properly, the header and all"): one header band shared with Tasks & Crew
 * (ops-board.css .tc-ev: event switcher as the title, date / venue / guests, countdown tile, actions), then the summary
 * (big % + bar, status chips in one row, the other facts in one muted line), tabs, filters in one row (a Filters button on a
 * phone), then the views with the activity rail beside them. "Wall screen" = big text for a TV, full screen when allowed.
 * Built with DOM calls only (textContent), never HTML strings. Refreshes every 30 s while the tab is visible
 * (event_tasks is not in a realtime publication, so polling is the cheap, safe choice). */
(function () {
  "use strict";
  var doc = document, REFRESH_MS = 30000, LS_KEY = "helm.monitor.quote", LS_TAB = "helm.monitor.tab", LS_WALL = "helm.monitor.wall";
  var $ = function (s) { return doc.querySelector(s); };
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /* ---- tiny DOM helper ---- */
  function h(tag, o, kids) {
    var n = doc.createElement(tag); o = o || {};
    if (o.cls) n.className = o.cls;
    if (o.text != null) n.textContent = String(o.text);
    if (o.href) n.setAttribute("href", o.href);
    if (o.title) n.setAttribute("title", o.title);
    if (o.role) n.setAttribute("role", o.role);
    if (o.label) n.setAttribute("aria-label", o.label);
    if (o.type) n.setAttribute("type", o.type);
    if (o.data) Object.keys(o.data).forEach(function (k) { n.setAttribute("data-" + k, String(o.data[k])); });
    (kids || []).forEach(function (k) { if (k) n.appendChild(typeof k === "string" ? doc.createTextNode(k) : k); });
    return n;
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  function opt(value, text, sel) { var o = h("option", { text: text }); o.value = value; if (sel) o.selected = true; return o; }

  /* ---- studio time zone helpers ---- */
  function tz() { try { return (BPStore.studioTimezone && BPStore.studioTimezone()) || undefined; } catch (e) { return undefined; } }
  function loc() { try { return (BPStore.studioLocale && BPStore.studioLocale()) || "en-IN"; } catch (e) { return "en-IN"; } }
  function parts(ts) {
    var d = new Date(ts); if (!ts || isNaN(d.getTime())) return null;
    try {
      var f = new Intl.DateTimeFormat("en-GB", { timeZone: tz(), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false });
      var o = {}; f.formatToParts(d).forEach(function (p) { o[p.type] = p.value; });
      return { day: o.year + "-" + o.month + "-" + o.day, hour: Number(o.hour) % 24 };
    } catch (e) { return { day: d.toISOString().slice(0, 10), hour: d.getHours() }; }
  }
  function fmtClock(ts) {
    var d = new Date(ts); if (!ts || isNaN(d.getTime())) return "";
    try { return new Intl.DateTimeFormat(loc(), { timeZone: tz(), hour: "numeric", minute: "2-digit" }).format(d); } catch (e) { return d.toLocaleTimeString(); }
  }
  function fmtDayIso(iso, withYear) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || "")); if (!m) return String(iso || "");
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
    var o = { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }; if (withYear) o.year = "numeric";
    try { return new Intl.DateTimeFormat(loc(), o).format(d); } catch (e) { return String(iso).slice(0, 10); }
  }
  function prevDay(iso) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso); var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] - 1, 12)); return d.toISOString().slice(0, 10); }
  /* "Mon 16 Nov, 2:30 PM"; a task between midnight and 6 AM also says which night it belongs to:
     "Sun 29 Nov, 2:00 AM (night of Sat 28 Nov)" */
  function fmtWhen(ts) {
    var p = parts(ts); if (!p) return "";
    var s = fmtDayIso(p.day) + ", " + fmtClock(ts);
    if (p.hour < 6) s += " (night of " + fmtDayIso(prevDay(p.day)) + ")";
    return s;
  }
  function ago(ts, now) {
    var t = new Date(ts).getTime(); if (!isFinite(t)) return "";
    var m = Math.round(((now || Date.now()) - t) / 60000);
    if (m < 1) return "just now"; if (m < 60) return m + " min ago";
    var hh = Math.floor(m / 60); if (hh < 24) return hh + " h ago";
    return Math.floor(hh / 24) + " d ago";
  }
  function until(ts, now) {
    var t = new Date(ts).getTime(); if (!isFinite(t)) return "";
    var m = Math.round((t - (now || Date.now())) / 60000);
    if (m <= 0) return "now"; if (m < 60) return "in " + m + " min";
    var hh = Math.floor(m / 60), r = m % 60; if (hh < 48) return "in " + hh + " h" + (r ? " " + r + " min" : "");
    return "in " + Math.round(hh / 24) + " days";
  }

  /* ---- status model: R192 - ONE shared vocabulary + late calculation (task-status.js), the same on Tasks & Crew ---- */
  var TS = window.HelmTaskStatus;
  var ST = {};
  ["unassigned", "waiting", "accepted", "started", "done", "rejected"].forEach(function (k) { ST[k] = { key: k, label: TS.LABEL[k], rank: TS.RANK[k] }; });
  var stateOf = TS.stateOf, personKey = TS.personKey, summarize = TS.summarize, leftover = TS.leftover;

  /* ---- page state ---- */
  var S = { events: [], quote: null, tasks: [], crew: {}, sheet: {}, off: {}, offAsk: {}, acts: null, actType: "", canEdit: false, tab: "staff", lastLoad: 0, loading: false, evInfo: {}, timer: null };

  /* ---- R184: attendance (check-in / check-out) + "can't work" reasons ---- */
  // first start time of a person's tasks on this event (the time they should be there by)
  function firstStart(crewId) {
    var best = NaN;
    S.tasks.forEach(function (t) { if (t.crew_id !== crewId || t.status === "cancelled" || !t.planned_start) return; var v = new Date(t.planned_start).getTime(); if (isFinite(v) && (!isFinite(best) || v < best)) best = v; });
    return best;
  }
  // {state: "in"|"out"|"none", text, late, lateMin, hours}
  function attendance(crewId) {
    var e = crewId && S.sheet[crewId];
    if (!e || !e.in) return { state: "none", text: "Not checked in", late: false, lateMin: 0 };
    var a = TS.attendance(e, firstStart(crewId));   // R192: the same check-in / late rule as Tasks & Crew
    var text = "Checked in " + (e.inAt ? fmtClock(e.inAt) : e.in) + " · " + (e.out ? "Checked out " + (e.outAt ? fmtClock(e.outAt) : e.out) : "Checked out —");
    return { state: a.state, text: text, late: a.late, lateMin: a.lateMin, hours: e.hours };
  }
  function attendanceCounts() {
    var ppl = {}, inN = 0, lateN = 0;
    S.tasks.forEach(function (t) { if (t.crew_id && t.status !== "cancelled" && t.status !== "rejected") ppl[t.crew_id] = 1; });
    Object.keys(ppl).forEach(function (id) { var a = attendance(id); if (a.state !== "none") { inN++; if (a.late) lateN++; } });
    return { people: Object.keys(ppl).length, checkedIn: inN, late: lateN };
  }
  function offReason(crewId) { var v = crewId && S.off[crewId]; return v == null ? null : v; }

  /* ---- R184: the activity timeline ---- */
  var ACT_TYPES = [["", "All updates"], ["work", "Work given out / moved"], ["reply", "Accepted / turned down"], ["progress", "Started / done"],
                   ["time", "Start time changes"], ["checkin", "Check-in / check-out"], ["email", "E-mails sent"], ["escalation", "Escalations"], ["special", "Special / cancelled"],
                   ["dayoff", "Days off asked / approved"]];   // R187 (0370)
  var actGroup = TS.actGroup;   // R192: shared wording (task-status.js)
  var ACT_ICON = { assigned: "📋", reassigned: "🔁", unassigned: "➖", time_changed: "🕒", special_on: "🔔", special_off: "🔕",
                   accepted: "✅", rejected: "✋", started: "▶️", completed: "🎉", cancelled: "✖️", reopened: "↩️",
                   check_in: "📍", check_out: "🏁", check_edit: "✏️", email_sent: "✉️", escalated: "🚨", dayoff_asked: "🗓️", dayoff_approved: "🗓️" };
  // R186: "coordinator" / "manager" / "admin / owner" - R192: the shared ladder (task-status.js)
  var escLevel = TS.escLevel, lastEscalation = TS.lastEscalation;
  function escBadge(a) { return TS.escBadge(a, fmtClock); }
  function actText(a) { return TS.actText(a, fmtWhen); }
  // without 0368: the timeline from what the tasks and the check-in sheet already say
  function fallbackActs() {
    var acts = [];
    S.tasks.forEach(function (t) {
      [["created_at", (t.crew_id || t.assignee_name) ? "assigned" : ""], ["responded_at", t.status === "rejected" ? "rejected" : "accepted"],
       ["started_at", "started"], ["completed_at", "completed"]].forEach(function (p) {
        if (t[p[0]] && p[1]) acts.push({ at: t[p[0]], kind: p[1], task_id: t.id, title: t.title, crew_id: t.crew_id, name: nameOf(t), detail: { to: nameOf(t) }, _code: t._code }); });
    });
    Object.keys(S.sheet).forEach(function (id) { var e = S.sheet[id], nm = (S.crew[id] && S.crew[id].name) || "Someone";
      if (e && e.inAt) acts.push({ at: e.inAt, kind: "check_in", crew_id: id, name: nm, detail: { late_min: e.late_min } });
      if (e && e.outAt) acts.push({ at: e.outAt, kind: "check_out", crew_id: id, name: nm, detail: {} }); });
    return acts.sort(function (a, b) { return new Date(b.at) - new Date(a.at); });
  }
  // R187 (0370): day-off steps of people on the event day (from the availability rows: requested_at / decided_at)
  function dayoffActs() {
    var out = [];
    (S.offRows || []).forEach(function (a) {
      if (!S.tasks.some(function (t) { return t.crew_id === a.crew_id; })) return;   // only people working this event
      var nm = (S.crew[a.crew_id] && S.crew[a.crew_id].name) || "Someone";
      if (a.requested_at) out.push({ at: a.requested_at, kind: "dayoff_asked", crew_id: a.crew_id, name: nm, detail: { note: a.note || "", pending: a.approval === "pending" } });
      if (a.decided_at && a.approval === "approved") out.push({ at: a.decided_at, kind: "dayoff_approved", crew_id: a.crew_id, name: nm, detail: {} });
    });
    return out;
  }
  function allActs() {
    var base = S.acts || fallbackActs(), extra = dayoffActs();
    return extra.length ? base.concat(extra).sort(function (a, b) { return new Date(b.at) - new Date(a.at); }) : base;
  }

  function filtered() {
    var q = ($("#monQ").value || "").trim().toLowerCase(), who = $("#monWho").value, sec = $("#monSec").value, st = $("#monSt").value, now = Date.now();
    var out = S.tasks.filter(function (t) {
      if (t.status === "cancelled") return false;
      var s = stateOf(t, now);
      if (who && personKey(t) !== who) return false;
      if (sec && String(t.category || "Other") !== sec) return false;
      if (st && !(st === "late" ? s.late : s.key === st)) return false;
      if (q) { var hay = [t.title, t.category, nameOf(t), t._code].join(" ").toLowerCase(); if (hay.indexOf(q) < 0) return false; }
      return true;
    });
    var sort = $("#monSort").value;
    out.sort(function (a, b) {
      if (sort === "name") return String(a.title || "").localeCompare(String(b.title || ""));
      if (sort === "status") { var x = stateOf(a, now), y = stateOf(b, now); if (x.late !== y.late) return x.late ? -1 : 1; return ST[x.key].rank - ST[y.key].rank; }
      var pa = a.planned_start ? new Date(a.planned_start).getTime() : Infinity, pb = b.planned_start ? new Date(b.planned_start).getTime() : Infinity;
      return pa - pb || String(a.title || "").localeCompare(String(b.title || ""));
    });
    return out;
  }
  function nameOf(t) { var c = t.crew_id && S.crew[t.crew_id]; return (c && c.name) || t.assignee_name || ""; }

  /* ---- small UI pieces ---- */
  function chip(s) {
    var n = h("span", { cls: "mon-chip is-" + s.key, text: s.label });
    var frag = doc.createDocumentFragment(); frag.appendChild(n);
    if (s.late) frag.appendChild(h("span", { cls: "mon-chip is-late", text: "Late" }));
    return frag;
  }
  function steps(t) {
    var s = stateOf(t), lvl = s.key === "done" ? 3 : s.key === "started" ? 2 : s.key === "accepted" ? 1 : s.key === "waiting" ? 0 : -1;
    var wrap = h("span", { cls: "mon-steps", label: "Progress: " + s.label });
    ["Given", "Accepted", "Started", "Done"].forEach(function (lb, i) {
      var cls = "mon-step" + (s.key === "rejected" ? " is-off" : i <= lvl ? " is-on" : "") + (s.late && i === lvl + 1 ? " is-late" : "");
      wrap.appendChild(h("span", { cls: cls, title: lb }));
    });
    return wrap;
  }
  function presenceDot(t) {
    var c = t && t.crew_id && S.crew[t.crew_id];
    if (!c || !c.profile_id) return null;
    var d = h("span", { cls: "mon-dot" }); d.setAttribute("data-presence-uid", c.profile_id); d.hidden = true; return d;
  }
  function avatar(name, t) {
    var a = h("span", { cls: "mon-av", text: String(name || "?").trim().charAt(0).toUpperCase() || "?" });
    var d = presenceDot(t); if (d) { d.setAttribute("data-presence-corner", ""); a.appendChild(d); }
    return a;
  }
  /* R194: the time sits first in the row (as on Tasks & Crew): clock, then the day ("night of ..." after midnight), then
     "in 45 min" / "12 min late". A task with no start time says "No time" quietly in that same first column. */
  function timeCell(t) {
    if (!t.planned_start) return h("span", { cls: "mon-time is-none", title: "No start time set", text: "No time" });
    var s = stateOf(t), p = parts(t.planned_start), w = h("span", { cls: "mon-time" + (s.late ? " is-late" : ""), title: fmtWhen(t.planned_start) });
    w.appendChild(h("b", { text: fmtClock(t.planned_start) }));
    if (p) w.appendChild(h("small", { text: p.hour < 6 ? "night of " + fmtDayIso(prevDay(p.day)) : fmtDayIso(p.day) }));
    if (s.key === "waiting" || s.key === "accepted") w.appendChild(h("small", { cls: "mon-time-rel", text: s.late ? lateWords(TS.lateMin(t)) : until(t.planned_start) }));
    return w;
  }
  function lateWords(m) { return m < 60 ? m + " min late" : m < 1440 ? Math.floor(m / 60) + " h " + (m % 60 ? (m % 60) + " min " : "") + "late" : Math.floor(m / 1440) + " d late"; }
  function actions(t) {
    var box = h("span", { cls: "mon-acts" });
    var qid = t.quote_id || S.quote;
    box.appendChild(h("a", { cls: "mon-btn mon-sm", href: "ops.html?quote=" + encodeURIComponent(qid) + "#task-" + encodeURIComponent(t.id), text: "Open", title: "Open this task on Tasks & Crew (the task panel: reassign, schedule, cancel)" }));
    var s = stateOf(t);
    if (S.canEdit && t.crew_id && (s.key === "waiting" || s.key === "accepted" || s.key === "started") && BPStore.ops && BPStore.ops.emailTasks) {
      var b = h("button", { cls: "mon-btn mon-sm", type: "button", text: "✉ Nudge", title: "E-mail this task to " + (nameOf(t) || "them") + " now" });
      b.addEventListener("click", function () { nudge(t, b); });
      box.appendChild(b);
    }
    return box;
  }
  async function nudge(t, btn) {
    var who = nameOf(t) || "this person";
    var ok = true;
    try { ok = window.BPUI && BPUI.confirm ? await BPUI.confirm("E-mail “" + (t.title || "this task") + "” to " + who + " now?", { title: "Send this task by e-mail?", okLabel: "Send e-mail" }) : window.confirm("E-mail this task to " + who + " now?"); } catch (e) { ok = false; }
    if (!ok) return;
    btn.disabled = true;
    try {
      var r = await BPStore.ops.emailTasks(t.id, false);
      var why = r && r.reason;
      toast(r && r.ok ? "E-mail on its way to " + (r.masked || who) + "." :
        why === "no_email" ? who + " has no e-mail on their staff record - add one on the Staff page." :
        why === "just_sent" ? "An e-mail went to " + who + " a moment ago." :
        why === "trial" ? "In the free trial nothing leaves Helm, so no e-mail was sent." : "Nothing was sent for this task.");
    } catch (e) { toast((window.BPUI && BPUI.friendlyError) ? BPUI.friendlyError(e, { action: "send the e-mail" }) : "Could not send the e-mail."); }
    finally { btn.disabled = false; }
  }
  function toast(msg, type) { try { if (window.BPUI && BPUI.toast) return BPUI.toast(msg, { type: type || "info" }); } catch (e) {} var el = $("#monUpdated"); if (el) el.textContent = msg; }
  function empty(text) { return h("div", { cls: "mon-empty", text: text }); }
  function taskRow(t, opts) {
    opts = opts || {};
    var s = stateOf(t);
    var row = h("div", { cls: "mon-row" + (s.late ? " is-late" : "") + (s.key === "done" ? " is-done" : ""), role: "listitem" });
    row.appendChild(timeCell(t));
    var main = h("div", { cls: "mon-row-main" });
    var tt = h("div", { cls: "mon-row-title" }, [h("span", { text: t.title || "Task" })]);
    if (t.is_special) tt.appendChild(h("span", { cls: "mon-chip is-special", text: "🔔 Special" }));
    main.appendChild(tt);
    var meta = h("div", { cls: "mon-row-meta" });
    if (opts.showWho !== false) { var nm = nameOf(t); meta.appendChild(h("span", { cls: nm ? "" : "mon-warn", text: nm || "No one yet" })); }
    if (opts.showSec !== false) meta.appendChild(h("span", { cls: "mon-muted", text: t.category || "Other" }));
    if (t._code) meta.appendChild(h("span", { cls: "mon-code", text: t._code }));
    main.appendChild(meta);
    row.appendChild(main);
    var st = h("div", { cls: "mon-row-st" }); st.appendChild(steps(t)); st.appendChild(chip(s)); row.appendChild(st);
    row.appendChild(actions(t));
    return row;
  }

  /* ---- views ---- */
  function viewStaff(list) {
    var groups = {}, order = [];
    list.forEach(function (t) { var k = personKey(t) || "none"; if (!groups[k]) { groups[k] = []; order.push(k); } groups[k].push(t); });
    var now = Date.now(), wrap = h("div", { cls: "mon-cards" });
    order.sort(function (a, b) {
      if (a === "none") return 1; if (b === "none") return -1;
      var la = summarize(groups[a], now).late, lb = summarize(groups[b], now).late; if (la !== lb) return lb - la;
      return nameOf(groups[a][0]).localeCompare(nameOf(groups[b][0]));
    });
    order.forEach(function (k) {
      var ts = groups[k], first = ts[0], sm = summarize(ts, now), nm = k === "none" ? "No one yet" : nameOf(first);
      var card = h("section", { cls: "mon-card mon-person" + (sm.late ? " has-late" : ""), label: nm });
      var head = h("div", { cls: "mon-person-head" });
      head.appendChild(avatar(nm, first));
      var who = h("div", { cls: "mon-person-who" }, [h("b", { text: nm })]);
      var c = first.crew_id && S.crew[first.crew_id], line = [];
      if (c && (c.department || c.role)) line.push(c.department || c.role);
      var last = lastAct(ts); if (last) line.push(last);
      who.appendChild(h("small", { text: line.join(" · ") || (k === "none" ? "Give these tasks to someone in Tasks & staff" : "") }));
      // R184: attendance line (check-in / check-out) + the day they said they can't work, with their reason
      if (first.crew_id) {
        var at = attendance(first.crew_id);
        var att = h("small", { cls: "mon-att is-" + at.state + (at.late ? " is-late" : "") }, [h("span", { text: (at.state === "none" ? "○ " : "📍 ") + at.text })]);
        if (at.late) att.appendChild(h("span", { cls: "mon-chip is-late", text: "Late check-in" + (at.lateMin ? " · " + at.lateMin + " min" : "") }));
        who.appendChild(att);
        var off = offReason(first.crew_id);
        // R187 (0370): a day still waiting for the office's approval says so
        if (off != null) who.appendChild(h("small", { cls: "mon-offnote", text: S.offAsk[first.crew_id] ? "⏳ Asked for this day off - waiting for approval · " + (off || "no reason given")
          : "⛔ Marked this day as can’t work · " + (off || "no reason given") }));
      }
      head.appendChild(who);
      var pr = h("div", { cls: "mon-person-pr" });
      pr.appendChild(h("b", { text: sm.done + "/" + sm.total + " done" }));
      if (sm.late) pr.appendChild(h("span", { cls: "mon-chip is-late", text: sm.late + " late" }));
      pr.appendChild(bar(sm.pct, "small"));
      head.appendChild(pr);
      card.appendChild(head);
      var rows = h("div", { cls: "mon-rows", role: "list" });
      ts.forEach(function (t) { rows.appendChild(taskRow(t, { showWho: false })); });
      card.appendChild(rows); wrap.appendChild(card);
    });
    return order.length ? wrap : empty("No tasks match these filters.");
  }
  function viewWork(list) {
    var groups = {}, order = [];
    list.forEach(function (t) { var k = t.category || "Other"; if (!groups[k]) { groups[k] = []; order.push(k); } groups[k].push(t); });
    var now = Date.now(), wrap = h("div", { cls: "mon-cards" });
    order.forEach(function (k) {
      var ts = groups[k], sm = summarize(ts, now);
      var card = h("section", { cls: "mon-card mon-sec" + (sm.late ? " has-late" : ""), label: k });
      var head = h("div", { cls: "mon-sec-head" }, [h("h3", { cls: "mon-sec-title", text: k })]);
      var pr = h("div", { cls: "mon-person-pr" });
      pr.appendChild(h("b", { text: sm.done + "/" + sm.total + " done" }));
      if (sm.late) pr.appendChild(h("span", { cls: "mon-chip is-late", text: sm.late + " late" }));
      if (sm.unassigned) pr.appendChild(h("span", { cls: "mon-chip is-unassigned", text: sm.unassigned + " no one yet" }));
      pr.appendChild(bar(sm.pct, "small"));
      head.appendChild(pr); card.appendChild(head);
      var rows = h("div", { cls: "mon-rows", role: "list" });
      ts.forEach(function (t) { rows.appendChild(taskRow(t, { showSec: false })); });
      card.appendChild(rows); wrap.appendChild(card);
    });
    return order.length ? wrap : empty("No tasks match these filters.");
  }
  function viewStatus(list) {
    var now = Date.now(), cols = [["late", "Late"], ["waiting", "Waiting for a yes"], ["accepted", "Accepted"], ["started", "Started"], ["done", "Done"], ["rejected", "Turned down"], ["unassigned", "No one yet"]];
    var board = h("div", { cls: "mon-board" });
    cols.forEach(function (c) {
      var items = list.filter(function (t) { var s = stateOf(t, now); return c[0] === "late" ? s.late : (s.key === c[0] && !s.late); });
      if (!items.length && (c[0] === "rejected" || c[0] === "unassigned")) return;
      var col = h("section", { cls: "mon-col is-" + c[0], label: c[1] + ": " + items.length });
      col.appendChild(h("h3", { cls: "mon-col-h" }, [h("span", { text: c[1] }), h("span", { cls: "mon-n", text: String(items.length) })]));
      if (!items.length) col.appendChild(h("p", { cls: "mon-muted mon-col-empty", text: "Nothing here" }));
      items.forEach(function (t) {
        var k = h("article", { cls: "mon-kcard" });
        k.appendChild(h("b", { text: t.title || "Task" }));
        k.appendChild(h("small", { text: [nameOf(t) || "No one yet", t.category || "Other"].join(" · ") }));
        if (t.planned_start) k.appendChild(h("small", { cls: "mon-muted", text: fmtWhen(t.planned_start) }));
        if (t._code) k.appendChild(h("small", { cls: "mon-code", text: t._code }));
        k.appendChild(actions(t));
        col.appendChild(k);
      });
      board.appendChild(col);
    });
    return board;
  }
  function viewLeft(list) {
    var left = leftover(list);
    if (!left.length) return empty(S.tasks.length ? "Everything is done. 🎉" : "No tasks yet for this event.");
    var card = h("section", { cls: "mon-card", label: "Leftover work" });
    card.appendChild(h("p", { cls: "mon-muted", text: left.length + " still to do - late ones first, then by start time." }));
    var rows = h("div", { cls: "mon-rows", role: "list" });
    left.forEach(function (t) { rows.appendChild(taskRow(t)); });
    card.appendChild(rows);
    return card;
  }
  /* R184: Check-in - each person on the event: in / out, late, hours, and the day they said they can't work */
  function viewCheckin(list) {
    var ppl = {}, order = [];
    list.forEach(function (t) { if (!t.crew_id || t.status === "rejected") return; if (!ppl[t.crew_id]) { ppl[t.crew_id] = []; order.push(t.crew_id); } ppl[t.crew_id].push(t); });
    if (!order.length) return empty(S.tasks.length ? "No one matches these filters." : "No one has work on this event yet.");
    var rank = function (id) { var a = attendance(id); return a.state === "none" ? (isFinite(firstStart(id)) && firstStart(id) < Date.now() ? 0 : 1) : a.state === "in" ? 2 : 3; };
    order.sort(function (a, b) { return rank(a) - rank(b) || nameOf(ppl[a][0]).localeCompare(nameOf(ppl[b][0])); });
    var ac = attendanceCounts();
    var card = h("section", { cls: "mon-card mon-ci", label: "Check-in" });
    card.appendChild(h("p", { cls: "mon-muted", text: ac.checkedIn + " of " + ac.people + " checked in" + (ac.late ? " · " + ac.late + " late" : "") +
      ". Staff check in and out on their task page (their link); the office can correct times in Tasks & staff → Timesheet." }));
    var tbl = h("div", { cls: "mon-ci-list", role: "list" });
    order.forEach(function (id) {
      var t0 = ppl[id][0], nm = nameOf(t0), at = attendance(id), fs = firstStart(id), e = S.sheet[id] || {}, off = offReason(id);
      var waiting = at.state === "none" && isFinite(fs) && fs < Date.now();
      var row = h("div", { cls: "mon-ci-row is-" + at.state + (at.late || waiting ? " is-late" : ""), role: "listitem" });
      var who = h("div", { cls: "mon-ci-who" }); who.appendChild(avatar(nm, t0));
      var wb = h("div", {}, [h("b", { text: nm || "Someone" })]);
      wb.appendChild(h("small", { cls: "mon-muted", text: ppl[id].length + (ppl[id].length === 1 ? " task" : " tasks") + (isFinite(fs) ? " · first at " + fmtClock(fs) : "") }));
      if (off != null) wb.appendChild(h("small", { cls: "mon-offnote", text: (S.offAsk[id] ? "⏳ Asked off - waiting for approval · " : "⛔ Can’t work this day · ") + (off || "no reason given") }));
      who.appendChild(wb); row.appendChild(who);
      row.appendChild(h("div", { cls: "mon-ci-cell" }, [h("small", { cls: "mon-muted", text: "In" }), h("b", { text: e.inAt ? fmtClock(e.inAt) : (e.in || "—") })]));
      row.appendChild(h("div", { cls: "mon-ci-cell" }, [h("small", { cls: "mon-muted", text: "Out" }), h("b", { text: e.outAt ? fmtClock(e.outAt) : (e.out || "—") })]));
      var st = h("div", { cls: "mon-ci-st" });
      st.appendChild(h("span", { cls: "mon-chip is-" + (at.state === "none" ? (waiting ? "late" : "waiting") : at.state === "in" ? "started" : "done"),
        text: at.state === "none" ? (waiting ? "Not here yet" : "Not checked in") : at.state === "in" ? "On site" : "Checked out" }));
      if (at.late) st.appendChild(h("span", { cls: "mon-chip is-late", text: "Late" + (at.lateMin ? " · " + at.lateMin + " min" : "") }));
      if (e.hours) st.appendChild(h("small", { cls: "mon-muted", text: e.hours + " h" }));
      row.appendChild(st);
      tbl.appendChild(row);
    });
    card.appendChild(tbl);
    return card;
  }
  /* R184: Activity - every update, newest first, grouped by day; filter by person (top filter) and by type */
  function actPersonKey(a) { return a.crew_id ? "c:" + a.crew_id : (a.name ? "n:" + String(a.name).toLowerCase() : ""); }
  function viewActivity() {
    var who = $("#monWho").value, q = ($("#monQ").value || "").trim().toLowerCase();
    var acts = allActs().filter(function (a) {
      if (S.actType && actGroup(a.kind) !== S.actType) return false;
      if (who && actPersonKey(a) !== who) return false;
      if (q && (actText(a) + " " + (a._code || "")).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var card = h("section", { cls: "mon-card mon-act", label: "Activity" });
    var bar2 = h("div", { cls: "mon-act-bar" });
    var sel = h("select", { cls: "mon-select", label: "Kind of update" });
    ACT_TYPES.forEach(function (o) { sel.appendChild(opt(o[0], o[1], o[0] === S.actType)); });
    sel.addEventListener("change", function () { S.actType = sel.value; render(); });
    bar2.appendChild(sel);
    bar2.appendChild(h("small", { cls: "mon-muted", text: acts.length + (acts.length === 1 ? " update" : " updates") + (S.acts ? "" : " (from task times - every change is recorded once the latest database update is in)") }));
    card.appendChild(bar2);
    if (!acts.length) { card.appendChild(empty("Nothing here yet. Work given out, replies, starts, check-ins and e-mails show here as they happen.")); return card; }
    var list = h("ol", { cls: "mon-tl" }), day = "", today = todayIso();
    acts.forEach(function (a) {
      var p = parts(a.at), d = p ? p.day : "";
      if (d !== day) { day = d; list.appendChild(h("li", { cls: "mon-tl-day", text: d === today ? "Today" : d === addDays(today, -1) ? "Yesterday" : fmtDayIso(d, true) })); }
      var li = h("li", { cls: "mon-tl-i is-" + actGroup(a.kind) + (a.kind === "rejected" || a.kind === "cancelled" ? " is-warn" : "") });
      li.appendChild(h("span", { cls: "mon-tl-ic", text: ACT_ICON[a.kind] || "•" }));
      var body = h("div", { cls: "mon-tl-b" }, [h("span", { text: actText(a) })]);
      var meta = [fmtClock(a.at)];
      if (a.by_name && (a.kind === "assigned" || a.kind === "reassigned" || a.kind === "unassigned" || a.kind === "time_changed" || a.kind === "special_on" || a.kind === "special_off" || a.kind === "cancelled" || a.kind === "check_edit")) meta.push("by " + a.by_name);
      if (a._code) meta.push(a._code);
      body.appendChild(h("small", { cls: "mon-muted", text: meta.join(" · ") }));
      li.appendChild(body); list.appendChild(li);
    });
    card.appendChild(list);
    return card;
  }
  function lastAct(ts) {
    var best = null;
    ts.forEach(function (t) { [["completed_at", "finished"], ["started_at", "started"], ["responded_at", t.status === "rejected" ? "turned down" : "accepted"]].forEach(function (p) {
      var v = t[p[0]] ? new Date(t[p[0]]).getTime() : NaN; if (isFinite(v) && (!best || v > best.t)) best = { t: v, what: p[1] + " " + (t.title || "a task") }; }); });
    return best ? best.what + " " + ago(best.t) : "";
  }
  function bar(pct, size) {
    var b = h("span", { cls: "mon-bar" + (size ? " is-" + size : ""), role: "progressbar" });
    b.setAttribute("aria-valuemin", "0"); b.setAttribute("aria-valuemax", "100"); b.setAttribute("aria-valuenow", String(pct)); b.setAttribute("aria-label", pct + "% done");
    var f = h("span", { cls: "mon-bar-fill" }); f.style.width = Math.max(0, Math.min(100, pct)) + "%"; b.appendChild(f); return b;
  }

  /* ---- render ---- */
  function renderSummary() {
    var box = $("#monSummary"); clear(box);
    var sm = summarize(S.tasks), now = Date.now();
    // R194: row 1 = big % + "x of y tasks" + the bar, with the status chips beside it on a wide screen; row 2 = one muted line
    var top = h("div", { cls: "mon-sum-top" });
    top.appendChild(h("div", { cls: "mon-pct" }, [h("b", { text: sm.pct + "%" }), h("span", { text: " done · " + sm.done + " of " + sm.total + " tasks" })]));
    top.appendChild(bar(sm.pct));
    box.appendChild(top);
    var counts = h("div", { cls: "mon-counts", role: "group", label: "Show only" });
    [["done", sm.done, "Done"], ["started", sm.started, "Started"], ["accepted", sm.accepted, "Accepted"], ["waiting", sm.waiting, "Waiting for a yes"],
     ["late", sm.late, "Late"], ["rejected", sm.rejected, "Turned down"], ["unassigned", sm.unassigned, "No one yet"]].forEach(function (c) {
      if ((c[0] === "rejected" || c[0] === "unassigned") && !c[1]) return;
      var b = h("button", { cls: "mon-count is-" + c[0] + (c[1] ? "" : " is-zero"), type: "button", title: "Show only: " + c[2] });
      b.appendChild(h("b", { text: String(c[1]) })); b.appendChild(h("span", { text: c[2] }));
      b.addEventListener("click", function () { $("#monSt").value = c[0]; setTab(c[0] === "done" ? "work" : "left"); render(); });
      counts.appendChild(b);
    });
    top.appendChild(counts);
    var facts = h("div", { cls: "mon-facts" });
    facts.appendChild(h("span", { title: "People who accepted, started or finished their work", text: sm.confirmed + " of " + sm.people + " people confirmed" }));
    var ac = attendanceCounts();   // R184
    if (ac.people) {
      var cf = h("button", { cls: "mon-factbtn" + (ac.late ? " mon-warn" : ""), type: "button", title: "Open the Check-in view",
        text: ac.checkedIn + " of " + ac.people + " checked in" + (ac.late ? " · " + ac.late + " late" : "") });
      cf.addEventListener("click", function () { setTab("checkin"); render(); });
      facts.appendChild(cf);
    }
    if (sm.next) facts.appendChild(h("span", { title: fmtWhen(sm.next.planned_start), text: "Next: " + (sm.next.title || "task") + " " + until(sm.next.planned_start, now) }));
    // R184: the latest update (same line as the Tasks & staff progress card), from the full timeline
    var latest = allActs()[0];
    if (latest) {
      var lb = h("button", { cls: "mon-factbtn mon-latest", type: "button", title: "Open the Activity view", text: "Latest: " + actText(latest) + " · " + ago(latest.at) });
      lb.addEventListener("click", function () { setTab("activity"); render(); });
      facts.appendChild(lb);
    }
    box.appendChild(facts);
    var n = leftover(S.tasks).length; $("#monLeftN").textContent = n ? String(n) : "";
    renderAlerts(now);
    stickyOffset();
  }
  /* R184: red LATE panel - every task whose start time has passed and is not started (task, person, was due, how long ago, Nudge) */
  function lateTasks(now) {
    return S.tasks.filter(function (t) { return t && t.status !== "cancelled" && stateOf(t, now).late; })
      .sort(function (a, b) { return new Date(a.planned_start) - new Date(b.planned_start); });
  }
  function renderAlerts(now) {
    var box = $("#monAlerts"); if (!box) return; clear(box);
    var late = lateTasks(now);
    if (!late.length) { box.hidden = true; return; }
    box.hidden = false;
    box.appendChild(h("h3", { cls: "mon-alerts-h" }, [h("span", { text: "⚠ Late — start time passed, not started" }), h("span", { cls: "mon-n", text: String(late.length) })]));
    var list = h("div", { cls: "mon-alerts-list", role: "list" });
    late.forEach(function (t) {
      var row = h("div", { cls: "mon-alert", role: "listitem" });
      row.appendChild(h("div", { cls: "mon-alert-main" }, [
        h("b", { text: t.title || "Task" }),
        h("span", { text: [nameOf(t) || "No one yet", t._code].filter(Boolean).join(" · ") }),
        h("small", { text: "was due " + fmtClock(t.planned_start) + " (" + ago(t.planned_start, now) + ")" + (stateOf(t, now).key === "waiting" ? " · not accepted yet" : "") })]));
      // R186 (0369): where the escalation ladder is now (special tasks)
      var esc = lastEscalation(t, S.acts);
      if (esc) row.appendChild(h("span", { cls: "mon-chip mon-esc is-esc-" + ((esc.detail && esc.detail.level) || "coordinator"), title: "Special task: Helm tells the team step by step until it is started", text: "🚨 " + escBadge(esc) }));
      else if (t.is_special) row.appendChild(h("span", { cls: "mon-chip is-special", text: "🔔 Special" }));
      row.appendChild(actions(t));
      list.appendChild(row);
    });
    box.appendChild(list);
  }
  function renderFeed() {
    var feed = $("#monFeed"), acts = allActs(); clear(feed);   // R184: the full timeline (0368), newest first
    if (!acts.length) { feed.appendChild(h("li", { cls: "mon-muted", text: "No activity yet - work given out, replies, starts, check-ins and e-mails show here." })); return; }
    acts.slice(0, 15).forEach(function (a) {
      feed.appendChild(h("li", { cls: "mon-feed-i is-" + actGroup(a.kind) }, [
        h("span", { cls: "mon-tl-ic", text: ACT_ICON[a.kind] || "•" }), h("span", { text: actText(a) }),
        a._code ? h("span", { cls: "mon-code", text: " " + a._code }) : null,
        h("small", { text: ago(a.at) })]));
    });
    if (acts.length > 15) {
      var more = h("li", { cls: "mon-feed-more" }); var b = h("button", { cls: "mon-btn mon-sm mon-ghost", type: "button", text: "See all " + acts.length + " updates" });
      b.addEventListener("click", openActivity);
      more.appendChild(b); feed.appendChild(more);
    }
  }
  function openActivity() { setTab("activity"); render(); try { $("#monView").scrollIntoView({ behavior: "smooth", block: "start" }); } catch (e) {} }
  // R194: the activity rail sticks just under the sticky summary card, whatever its height
  function stickyOffset() {
    var sm = $("#monSummary"), app = $("#monApp"); if (!sm || !app || !app.style) return;
    try { app.style.setProperty("--mon-sum-h", Math.round(sm.getBoundingClientRect().height || 0) + "px"); } catch (e) {}
  }
  // R194: filters - how many are on (the phone's Filters button shows it) and Clear only when something is on
  function filterCount() {
    var n = 0; ["#monWho", "#monSec", "#monSt"].forEach(function (s) { if ($(s).value) n++; });
    if ($("#monSort").value !== "time") n++;
    return n;
  }
  function paintFilters() {
    var n = filterCount(), q = ($("#monQ").value || "").trim();
    $("#monFiltersN").textContent = n ? String(n) : "";
    $("#monClear").hidden = !(n || q);
  }
  function fillFilters() {
    var who = $("#monWho"), sec = $("#monSec"), wv = who.value, sv = sec.value, people = {}, secs = {};
    S.tasks.forEach(function (t) { if (t.status === "cancelled") return; var k = personKey(t); if (k) people[k] = nameOf(t); secs[t.category || "Other"] = 1; });
    clear(who); who.appendChild(opt("", "Everyone"));
    Object.keys(people).sort(function (a, b) { return people[a].localeCompare(people[b]); }).forEach(function (k) { who.appendChild(opt(k, people[k], k === wv)); });
    clear(sec); sec.appendChild(opt("", "All sections"));
    Object.keys(secs).sort().forEach(function (k) { sec.appendChild(opt(k, k, k === sv)); });
  }
  function render() {
    renderSummary(); paintFilters();
    var list = filtered(), v = $("#monView"); clear(v);
    if (S.tab === "activity") v.appendChild(viewActivity());   // R184: the timeline shows even before any task exists (check-ins, e-mails)
    else if (!S.tasks.length) v.appendChild(empty("No tasks for this event yet. Give work out in Tasks & staff and it shows here live."));
    else v.appendChild(S.tab === "work" ? viewWork(list) : S.tab === "status" ? viewStatus(list) : S.tab === "left" ? viewLeft(list)
      : S.tab === "checkin" ? viewCheckin(list) : viewStaff(list));
    renderFeed();
    try { if (BPStore.presence && BPStore.presence.paint) BPStore.presence.paint(v); } catch (e) {}
  }
  function setTab(tab) {
    S.tab = /^(staff|work|status|left|checkin|activity)$/.test(tab) ? tab : "staff";
    Array.prototype.forEach.call(doc.querySelectorAll(".mon-tab"), function (b) {
      var on = b.getAttribute("data-tab") === S.tab; b.setAttribute("aria-selected", on ? "true" : "false"); b.tabIndex = on ? 0 : -1;
      if (on) $("#monView").setAttribute("aria-labelledby", b.id);
    });
    try { localStorage.setItem(LS_TAB, S.tab); } catch (e) {}
  }

  /* ---- data ---- */
  function todayIso() { var p = parts(new Date().toISOString()); return p ? p.day : new Date().toISOString().slice(0, 10); }
  function addDays(iso, n) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso); return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n, 12)).toISOString().slice(0, 10); }
  async function loadEvents() {
    var soon = [], later = {}, seen = {};
    try { var r = await BPStore.ops.live.today(72); ((r && r.events) || []).forEach(function (e) { if (e && e.quote_id && !seen[e.quote_id]) { seen[e.quote_id] = 1; soon.push(e); } }); } catch (e) {}
    try {
      var t0 = todayIso(), rows = await BPStore.ops.crew.schedule(t0, addDays(t0, 30));
      (rows || []).forEach(function (x) { if (x && x.quote_id && !seen[x.quote_id] && !later[x.quote_id]) later[x.quote_id] = { quote_id: x.quote_id, code: x.event_code, title: x.event_title, event_date: x.event_date || x.sched_date }; });
    } catch (e) {}
    var rest = Object.keys(later).map(function (k) { return later[k]; }).sort(function (a, b) { return String(a.event_date).localeCompare(String(b.event_date)); });
    S.events = soon.concat(rest);
    S.evInfo = {}; S.events.forEach(function (e) { S.evInfo[e.quote_id] = e; });
    var sel = $("#monEvent"); clear(sel);
    var todays = soon.filter(function (e) { return e.is_today; });
    if (todays.length > 1) sel.appendChild(opt("all", "All events today (" + todays.length + ")"));
    function label(e) { return [e.code, e.title].filter(Boolean).join(" · ") + " - " + fmtDayIso(e.event_date) + (e.is_today ? " (today)" : ""); }
    if (soon.length) { var g1 = h("optgroup"); g1.label = "Today and the next 3 days"; soon.forEach(function (e) { g1.appendChild(opt(e.quote_id, label(e))); }); sel.appendChild(g1); }
    if (rest.length) { var g2 = h("optgroup"); g2.label = "Later this month"; rest.forEach(function (e) { g2.appendChild(opt(e.quote_id, label(e))); }); sel.appendChild(g2); }
  }
  async function loadCrew() {
    try { var list = await BPStore.ops.listCrew(); S.crew = {}; (list || []).forEach(function (c) { if (c && c.id) S.crew[c.id] = c; }); } catch (e) { S.crew = {}; }
  }
  async function loadSheet(quoteIds) {
    S.sheet = {};
    var T = BPStore.ops.shifts && BPStore.ops.shifts.timesheet; if (!T) return;
    await Promise.all(quoteIds.map(function (q) { return T(q).then(function (r) {
      ((r && r.rows) || []).forEach(function (x) {
        if (!x || !x.crew_id) return;
        // R184: today's check-in, else the most recent one for this event (a multi-day event / the day after)
        var es = (x.entries || []).filter(function (k) { return k && k.in; });
        var e = es.filter(function (k) { return r.today && k.day === r.today; })[0] || es.slice().sort(function (a, b) { return String(b.day).localeCompare(String(a.day)); })[0];
        if (!e) return;
        S.sheet[x.crew_id] = { day: e.day, in: e.in, out: e.out || "", inAt: e.in_at || null, outAt: e.out_at || null, late_min: e.late_min || 0, hours: x.hours || null };
      }); }).catch(function () {}); }));
  }
  // R184: who marked the event day as "can't work" (with their reason); one range call for all shown events
  async function loadOff(quoteIds) {
    S.off = {}; S.offAsk = {}; S.offRows = [];
    var A = BPStore.ops.shifts && BPStore.ops.shifts.availability; if (!A) return;
    var days = quoteIds.map(function (q) { var e = S.evInfo[q]; return e && e.event_date ? String(e.event_date).slice(0, 10) : ""; }).filter(Boolean);
    if (!days.length) days = [todayIso()];
    days.sort(); var from = days[0], to = days[days.length - 1];
    try {
      var rows = await A(from, to, null);
      (rows || []).forEach(function (a) { if (a && a.crew_id && a.status === "unavailable" && days.indexOf(String(a.day).slice(0, 10)) >= 0) {
        S.off[a.crew_id] = a.note || ""; if (a.approval === "pending") S.offAsk[a.crew_id] = true; S.offRows.push(a); } });   // R187: pending = waiting for approval
    } catch (e) { S.off = {}; S.offAsk = {}; S.offRows = []; }
  }
  // R184: the full timeline (0368); null before 0368 -> the page uses the task step times
  async function loadActivity(quoteIds) {
    var L = BPStore.ops.live && BPStore.ops.live.activity; if (!L) { S.acts = null; return; }
    var all = [], missing = false;
    await Promise.all(quoteIds.map(function (q) { return L(q, 200).then(function (r) {
      if (r == null) { missing = true; return; }
      var code = S.quote === "all" ? ((S.evInfo[q] && S.evInfo[q].code) || "") : "";
      (r || []).forEach(function (a) { if (a && a.at) { if (code) a._code = code; all.push(a); } });
    }).catch(function () { missing = true; }); }));
    S.acts = missing && !all.length ? null : all.sort(function (a, b) { return new Date(b.at) - new Date(a.at); });
  }
  async function loadTasks(silent) {
    if (S.loading || !S.quote) return; S.loading = true;
    if (!silent) $("#monView").setAttribute("aria-busy", "true");
    try {
      var ids = S.quote === "all" ? S.events.filter(function (e) { return e.is_today; }).map(function (e) { return e.quote_id; }) : [S.quote];
      var lists = await Promise.all(ids.map(function (q) { return BPStore.ops.listTasks(q).then(function (ts) {
        var code = S.quote === "all" ? ((S.evInfo[q] && S.evInfo[q].code) || "") : "";
        return (ts || []).map(function (t) { t.quote_id = t.quote_id || q; if (code) t._code = code; return t; }); }); }));
      S.tasks = [].concat.apply([], lists);
      await Promise.all([loadSheet(ids), loadOff(ids), loadActivity(ids)]);
      S.lastLoad = Date.now(); $("#monErr").hidden = true;
      fillFilters(); render(); tick();
    } catch (e) {
      var er = $("#monErr"); er.hidden = false;
      er.textContent = (window.BPUI && BPUI.friendlyError) ? BPUI.friendlyError(e, { action: "load the event's tasks" }) : "Could not load the tasks. Check your connection and press Refresh.";
    } finally { S.loading = false; $("#monView").removeAttribute("aria-busy"); }
  }
  /* R194: the header band - code + a Today / Upcoming pill, the event name as the switcher, date · venue · guests, and the
     time tiles (Guests arrive + the countdown: "Event in 9 days", on the day a live clock) */
  function headFor() {
    var e = S.quote === "all" ? null : S.evInfo[S.quote], pill = $("#monPill");
    if (S.quote === "all") {
      $("#monCode").textContent = "Today"; $("#monTitle").textContent = "All events today";
      $("#monSub").textContent = S.events.filter(function (x) { return x.is_today; }).map(function (x) { return [x.code, x.title].filter(Boolean).join(" · "); }).join("  |  ");
      $("#monOpenOps").hidden = true; pillFor(pill, 0); renderTimes(null); return;
    }
    $("#monOpenOps").hidden = false; $("#monOpenOps").setAttribute("href", "ops.html?quote=" + encodeURIComponent(S.quote));
    if (!e) { $("#monCode").textContent = ""; $("#monTitle").textContent = "Event"; $("#monSub").textContent = ""; pill.hidden = true; renderTimes(null); return; }
    $("#monCode").textContent = e.code || "";
    $("#monTitle").textContent = e.title || e.code || "Event";
    $("#monSub").textContent = [e.event_date ? fmtDayIso(e.event_date, true) : "No event date yet", e.venue, e.guests ? e.guests + " guests" : ""].filter(Boolean).join(" · ");
    pillFor(pill, e.event_date ? TS.dayDiff(todayIso(), String(e.event_date).slice(0, 10)) : NaN);
    renderTimes(e);
  }
  function pillFor(pill, d) {
    if (!isFinite(d)) { pill.hidden = true; return; }
    pill.hidden = false; pill.textContent = d === 0 ? "Event day - live" : d > 0 ? "Upcoming" : "Past";
    pill.className = "tc-pill" + (d === 0 ? "" : " plan");
  }
  function countdown(e) {
    var d = e && e.event_date ? TS.dayDiff(todayIso(), String(e.event_date).slice(0, 10)) : NaN;
    if (!isFinite(d)) return ["Countdown", "No date yet"];
    if (d > 1) return ["Event in", d + " days"]; if (d === 1) return ["Event", "Tomorrow"];
    if (d < 0) return ["Event was", (-d) + (d === -1 ? " day ago" : " days ago")];
    return ["Now", fmtClock(new Date().toISOString())];
  }
  function renderTimes(e) {
    var dl = $("#monTimes"); if (!dl) return; clear(dl);
    function tile(lbl, val, cls, id) { dl.appendChild(h("div", { cls: "tc-t" + (cls ? " " + cls : "") }, [h("dt", { text: lbl }), h("dd", { text: val })])); if (id) dl.lastChild.lastChild.id = id; }
    if (e && e.event_time) tile("Guests arrive", e.event_time, "key");
    var cd = S.quote === "all" ? ["Now", fmtClock(new Date().toISOString())] : countdown(e);
    tile(cd[0], cd[1], "count", "monClock");
    dl.setAttribute("data-live", cd[0] === "Now" ? "1" : "");
  }
  // the venue, guests and time come from the quote (not in the live list) - read once per event, quietly
  async function enrich(q) {
    var e = S.evInfo[q]; if (!e || e._full || !BPStore.quotes || !BPStore.quotes.get) return;
    e._full = true;
    try {
      var x = await BPStore.quotes.get(q); if (!x) return;
      var c = x.client || {};
      e.code = e.code || x.code; e.title = e.title || x.title; e.event_date = e.event_date || x.eventDate || x.event_date;
      e.event_time = e.event_time || x.eventTime || x.event_time; e.venue = e.venue || x.venue || c.venue || "";
      e.guests = x.guests || (x.pricing && x.pricing.guests) || c.guests || "";
      if (S.quote === q) headFor();
    } catch (err) {}
  }
  async function choose(q, push) {
    S.quote = q; headFor(); if (q !== "all") enrich(q);
    try { localStorage.setItem(LS_KEY, q); } catch (e) {}
    if (push) { try { var u = new URL(location.href); u.searchParams.set("quote", q); history.replaceState(null, "", u.pathname + u.search); } catch (e) {} }
    S.tasks = []; await loadTasks(false);
  }
  function tick() {
    var el = $("#monUpdated"); if (!el || !S.lastLoad) return;
    var s = Math.round((Date.now() - S.lastLoad) / 1000);
    el.textContent = "Updated " + (s < 5 ? "just now" : s < 60 ? s + "s ago" : Math.floor(s / 60) + " min ago");
    var ck = $("#monClock"), dl = $("#monTimes");   // R194: the live clock on the event day
    if (ck && dl && dl.getAttribute("data-live") === "1") ck.textContent = fmtClock(new Date().toISOString());
  }

  /* ---- start ---- */
  function signedIn() { try { return !!(BPStore.auth && BPStore.auth.user()); } catch (e) { return true; } }
  async function renderAccount() {
    var box = $("#account"), A = BPStore.auth; if (!A.enabled()) { box.hidden = true; return; }
    box.hidden = false; clear(box);
    var u = A.user(); if (!u) return;
    var role = await A.role();
    box.appendChild(h("span", { cls: "role", text: role || "" })); box.appendChild(h("span", { text: u.email || "" }));
    var b = h("button", { type: "button", text: "Log out" });
    b.addEventListener("click", async function () { await A.signOut(); location.href = "dashboard.html"; }); box.appendChild(b);
  }
  function wire() {
    $("#monEvent").addEventListener("change", function () { choose(this.value, true); });
    $("#monRefresh").addEventListener("click", function () { loadTasks(false); });
    ["#monQ", "#monWho", "#monSec", "#monSt", "#monSort"].forEach(function (s) { $(s).addEventListener(s === "#monQ" ? "input" : "change", render); });
    $("#monClear").addEventListener("click", function () { $("#monQ").value = ""; $("#monWho").value = ""; $("#monSec").value = ""; $("#monSt").value = ""; $("#monSort").value = "time"; render(); });
    // R194: phone - the four menus fold behind one Filters button
    $("#monFiltersBtn").addEventListener("click", function () {
      var tools = $("#monTools"), open = !tools.classList.contains("is-open");
      tools.classList.toggle("is-open", open); this.setAttribute("aria-expanded", open ? "true" : "false");
    });
    $("#monFeedAll").addEventListener("click", openActivity);
    $("#monWall").addEventListener("click", function () { setWall(!doc.body.classList.contains("mon-wall"), true); });
    window.addEventListener("resize", stickyOffset);
    var tabs = $("#monTabs");
    tabs.addEventListener("click", function (e) { var b = e.target.closest(".mon-tab"); if (!b) return; setTab(b.getAttribute("data-tab")); render(); });
    tabs.addEventListener("keydown", function (e) {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      var all = Array.prototype.slice.call(tabs.querySelectorAll(".mon-tab")), i = all.findIndex(function (b) { return b.getAttribute("aria-selected") === "true"; });
      var n = all[(i + (e.key === "ArrowRight" ? 1 : all.length - 1)) % all.length]; setTab(n.getAttribute("data-tab")); n.focus(); render(); e.preventDefault();
    });
    // R192: ONE refresh clock shared with Tasks & Crew (task-status.js): every 30 s while visible + at once when you come back
    TS.refresher(function () { if (signedIn()) return loadTasks(true); }, REFRESH_MS);
    setInterval(tick, 5000);
  }
  /* R194: wall-screen mode - bigger text, filters out of the way; full screen when the browser allows it (the button press
     is the user gesture). Remembered on this device only. Esc / leaving full screen keeps the big text until switched off. */
  function setWall(on, ask) {
    doc.body.classList.toggle("mon-wall", !!on);
    var b = $("#monWall"); if (b) { b.setAttribute("aria-pressed", on ? "true" : "false"); b.textContent = on ? "Exit wall screen" : "Wall screen"; }
    try { localStorage.setItem(LS_WALL, on ? "1" : ""); } catch (e) {}
    if (ask) {
      try {
        if (on && doc.documentElement.requestFullscreen && !doc.fullscreenElement) doc.documentElement.requestFullscreen().catch(function () {});
        else if (!on && doc.fullscreenElement && doc.exitFullscreen) doc.exitFullscreen().catch(function () {});
      } catch (e) {}
    }
    stickyOffset();
  }
  async function start() {
    await BPStore.init(); await renderAccount();
    try { await BPStore.bell.mount($("#bell")); } catch (e) {}
    var A = BPStore.auth;
    if (A.enabled() && A.required() && !A.user()) { location.replace("login.html?next=" + encodeURIComponent(location.pathname + location.search)); return; }
    if (!(await A.requireView("staff"))) { $("#monBoot").hidden = true; return; }
    // R208 (0385): Nudge = "Assign & send tasks" (no row for the role = Staff - Can change, as before)
    try { S.canEdit = !!(await (A.canAssignTasks ? A.canAssignTasks() : A.canEditArea("staff"))); } catch (e) { S.canEdit = false; }
    await Promise.all([loadEvents(), loadCrew()]);
    $("#monBoot").hidden = true; $("#monApp").hidden = false;
    var want = null; try { want = new URLSearchParams(location.search).get("quote"); } catch (e) {}
    try { if (!want && window.HelmUrl && HelmUrl.get) want = await HelmUrl.get("quote", null); } catch (e) {}
    var saved = null; try { saved = localStorage.getItem(LS_KEY); } catch (e) {}
    var tabSaved = null; try { tabSaved = localStorage.getItem(LS_TAB); } catch (e) {}
    setTab(tabSaved || "staff");
    var wallSaved = null; try { wallSaved = localStorage.getItem(LS_WALL); } catch (e) {}
    if (wallSaved === "1") setWall(true, false);
    var sel = $("#monEvent");
    var pick = (want && (want === "all" || UUID.test(want))) ? want : (saved && (saved === "all" || S.evInfo[saved])) ? saved : (S.events[0] && S.events[0].quote_id);
    if (want && UUID.test(want) && !S.evInfo[want]) { sel.insertBefore(opt(want, "This event"), sel.firstChild); S.evInfo[want] = { quote_id: want }; }
    if (!pick) { $("#monView").appendChild(empty("No events with work today or this month. Give out tasks in an event's Tasks & staff page.")); $("#monSummary").hidden = true; return; }
    sel.value = pick; wire();
    if (S.evInfo[pick] && !S.evInfo[pick].code) { try { var q = await BPStore.quotes.get(pick); if (q) { S.evInfo[pick] = { quote_id: pick, code: q.code, title: q.title, event_date: q.eventDate || q.event_date, event_time: q.eventTime || q.event_time }; sel.options[0].textContent = [q.code, q.title].filter(Boolean).join(" · "); } } catch (e) {} }
    await choose(pick, false);
  }
  function go() { if (window.BPUI && BPUI.boot) BPUI.boot(start); else start(); }
  if (typeof window !== "undefined" && typeof document !== "undefined" && document.getElementById && document.getElementById("monApp")) {
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", go); else go();
  }
  window.HelmMonitor = { stateOf: stateOf, summarize: summarize, leftover: leftover, fmtWhen: fmtWhen, _personKey: personKey,
    actText: actText, actGroup: actGroup, _S: S, _attendance: attendance, lastEscalation: lastEscalation, escBadge: escBadge,
    _countdown: countdown, _lateWords: lateWords, _todayIso: todayIso };
})();
