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
 *   R186 (0369): special tasks not started climb an escalation ladder (event lead -> manager -> admin / owner); each step is
 *   in the timeline (kind "escalated") and the Late panel shows the latest one as a badge ("Escalated to manager 3:10 PM").
 * Gate: BPStore.auth.requireView("staff") - same as Tasks & staff. Crew never see this page.
 * R194 layout (owner: "organise this page properly, the header and all"): one header band shared with Tasks & Crew
 * (ops-board.css .tc-ev: event switcher as the title, date / venue / guests, countdown tile, actions), then the summary
 * (big % + bar, status chips in one row, the other facts in one muted line), tabs, filters in one row (a Filters button on a
 * phone), then the views with the activity rail beside them. "Wall screen" = big text for a TV, full screen when allowed.
 * R250 (owner: "can't tell before / during / after the event"): a step strip (Before the event / Day before / On the day /
 * Wrap-up) with a green "Now" dot; the step you look at decides what shows (readiness + what needs action before; checklist,
 * floor plan the day before; a slim live strip, Late panel and the work on the day; still open, hours and next
 * steps at wrap-up). Three tabs (People / Work / Activity); status is a row of filter chips; no hover tooltips.
 * R251 (owner, 24 Nov: "the day before first, then pre event, then on the event and then wrap up"): the same steps as Tasks & Crew
 * (task-status.js WINDOWS / STEPS): Day before / Pre-event / On the event. Wrap-up is no step but a closed section at the very bottom
 * (HelmEventWrap, event-steps.js); Pre-event ends with "Mark pre-event complete" (HelmEventSteps, the quote's stage -> Event Day).
 * The header badge is the REAL step (autoWin). People and Work list Day before, Pre-event, On the event, Wrap-up work in that order
 * (TS.taskStep). On the event also has the run-sheet now / next; Pre-event and On the event the issues (BPStore.issues + issue-assign.js,
 * as on Tasks & Crew: view with Issues view; log, assign and resolve with Issues edit). "All events today" has no steps and no wrap-up: one flat list, as before.
 * Built with DOM calls only (textContent), never HTML strings. Refreshes every 30 s while the tab is visible
 * (event_tasks is not in a realtime publication, so polling is the cheap, safe choice). */
(function () {
  "use strict";
  var doc = document, REFRESH_MS = 30000, LS_KEY = "helm.monitor.quote", LS_TAB = "helm.monitor.tab", LS_WALL = "helm.monitor.wall", LS_SIZE = "helm.monitor.size";
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
    // R226: any other attribute (aria-*, target, rel, alt, loading ...); hidden = the property
    Object.keys(o).forEach(function (k) {
      if (/^(cls|text|href|title|role|label|type|data)$/.test(k) || o[k] == null || o[k] === false) return;
      if (k === "hidden") n.hidden = !!o[k]; else n.setAttribute(k, String(o[k]));
    });
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
  // R254: the event time (studio wall clock HH:MM) in the same style as every other time here
  function guestWord(t) { var m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(t || "").trim()); if (!m || +m[1] > 23) return String(t || "");
    try { return new Intl.DateTimeFormat(loc(), { timeZone: "UTC", hour: "numeric", minute: "2-digit" }).format(new Date(Date.UTC(2026, 0, 1, +m[1], +m[2]))); } catch (e) { return String(t); } }
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
  var S = { events: [], quote: null, tasks: [], crew: {}, sheet: {}, off: {}, offAsk: {}, acts: null, actType: "", canEdit: false, tab: "staff", lastLoad: 0, loading: false, evInfo: {}, timer: null,
    // R226 / R251: the steps (same rule as Tasks & Crew), the event day plan (0396; null = not there), the run-sheet (for the
    // window rule), proof photos (task_evidence, signed 5-minute links), whether Remind -> Bell exists, the open drawer
    win: "onday", autoWin: "onday", manualWin: null, plan: null, planAt: 0, has396: false, rs: null, rsAt: 0, rsView: false,
    proof: {}, proofUrl: {}, proofAt: 0, drawer: null, lastFocus: null,
    // R230 (0399): the departments I supervise, per event ({ quote_id: ["Catering"] }; empty before 0399)
    mine: {}, mineAt: 0, mineKey: "",
    // R250: the status chip that is on ("" = all; "open" = still open)
    st: "", stpSeen: "",
    // R251: issues of the event (null = may not read them), what this role may do there, admin, folded work groups (per event + step),
    // when the quote (stage, date) was last read again; dlyMin = the minute the delay card shows
    iss: null, issErr: false, issQ: "", issView: false, issEdit: false, issOpen: false, admin: false, fold: {}, quoteAt: 0 };

  /* ---- R184: attendance (check-in / check-out) + "can't work" reasons ---- */
  // first start time of a person's tasks on the day they check in (else the event day): the time they should be there by. A job the
  // day before never makes an event-day check-in "1320 min late" (R251); no task that day = their first task
  function firstStart(crewId) {
    var e = S.sheet[crewId], day = String((e && e.in && e.day) || (S.quote !== "all" && (S.evInfo[S.quote] || {}).event_date) || "").slice(0, 10), v = firstOf(crewId, day);
    return day && !isFinite(v) ? firstOf(crewId, "") : v;
  }
  function firstOf(crewId, day) {
    var best = NaN;
    S.tasks.forEach(function (t) { if (t.crew_id !== crewId || t.status === "cancelled" || !t.planned_start) return; if (day && (parts(t.planned_start) || {}).day !== day) return; var v = new Date(t.planned_start).getTime(); if (isFinite(v) && (!isFinite(best) || v < best)) best = v; });
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
  var ACT_TYPES = [["", "All updates"], ["work", "Work given out / moved"], ["reply", "Accepted / turned down"], ["progress", "Started / done"], ["check", "Sent back / approved"],
                   ["time", "Start time changes"], ["checkin", "Check-in / check-out"], ["email", "E-mails sent"], ["escalation", "Escalations"], ["special", "Special / cancelled"],
                   ["dayoff", "Days off asked / approved"]];   // R187 (0370)
  var actGroup = TS.actGroup;   // R192: shared wording (task-status.js)
  var ACT_ICON = { assigned: "📋", reassigned: "🔁", unassigned: "➖", time_changed: "🕒", step_changed: "↔️", special_on: "🔔", special_off: "🔕",
                   accepted: "✅", rejected: "✋", started: "▶️", completed: "🎉", cancelled: "✖️", reopened: "↩️",
                   check_in: "📍", check_out: "🏁", check_edit: "✏️", email_sent: "✉️", escalated: "🚨", dayoff_asked: "🗓️", dayoff_approved: "🗓️" };
  // R186: "event lead" / "manager" / "admin / owner" - R192: the shared ladder (task-status.js)
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
    var base = TS.withChecks(S.acts || fallbackActs(), S.tasks), extra = dayoffActs();
    return extra.length ? base.concat(extra).sort(function (a, b) { return new Date(b.at) - new Date(a.at); }) : base;
  }

  function filtered() {
    var q = ($("#monQ").value || "").trim().toLowerCase(), who = $("#monWho").value, sec = $("#monSec").value, st = S.st || "", now = Date.now();
    var out = S.tasks.filter(function (t) {
      if (t.status === "cancelled") return false;
      var s = stateOf(t, now);
      if (who && personKey(t) !== who) return false;
      if (sec === "__mine") { if ((S.mine[t.quote_id] || []).indexOf(String(t.category || "Other")) < 0) return false; }
      else if (sec && String(t.category || "Other") !== sec) return false;
      if (st && !(st === "late" ? s.late : st === "open" ? s.key !== "done" : s.key === st)) return false;
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
      var cls = "mon-step" + (s.key === "rejected" ? " is-off" : i <= lvl ? " is-on" : "") + (s.late && lateOn() && i === lvl + 1 ? " is-late" : "");
      wrap.appendChild(h("span", { cls: cls, "data-step": lb }));
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
    if (!t.planned_start) return h("span", { cls: "mon-time is-none", text: "No time" });
    var s = stateOf(t), p = parts(t.planned_start), w = h("span", { cls: "mon-time" + (s.late && lateOn() ? " is-late" : "") });
    w.appendChild(h("b", { text: fmtClock(t.planned_start) }));
    if (p) w.appendChild(h("small", { text: p.hour < 6 ? "night of " + fmtDayIso(prevDay(p.day)) : fmtDayIso(p.day) }));
    if ((s.key === "waiting" || s.key === "accepted") && (!s.late || lateOn())) w.appendChild(h("small", { cls: "mon-time-rel", text: s.late ? lateWords(TS.lateMin(t)) : until(t.planned_start) }));
    return w;
  }
  function lateWords(m) { return m < 60 ? m + " min late" : m < 1440 ? Math.floor(m / 60) + " h " + (m % 60 ? (m % 60) + " min " : "") + "late" : Math.floor(m / 1440) + " d late"; }
  function opsHref(t) { return "ops.html?quote=" + encodeURIComponent(t.quote_id || S.quote) + "#task-" + encodeURIComponent(t.id); }
  function canRemind(t) { var s = stateOf(t); return S.canEdit && t.crew_id && t.assignee_kind !== "outsourced" && (s.key === "waiting" || s.key === "accepted" || s.key === "started"); }
  function actions(t) {
    var box = h("span", { cls: "mon-acts" });
    // R226: Open shows the task in a drawer on this page (Tasks & Crew is one link away inside it)
    var o = h("button", { cls: "mon-btn mon-sm", type: "button", text: "Open", "aria-haspopup": "dialog" });
    o.addEventListener("click", function () { openDrawer(t, o); });
    box.appendChild(o);
    if (canRemind(t)) box.appendChild(remindBtn(t));
    return box;
  }
  /* R226: Remind -> a small menu: Bell (their own Helm login, 0396), E-mail (0361), WhatsApp (0362, the studio's number).
     Each option says what will happen; nothing is sent without the click. */
  function remindBtn(t) {
    var wrap = h("span", { cls: "mon-remind" });
    var b = h("button", { cls: "mon-btn mon-sm", type: "button", text: "Remind ▾", "aria-label": "Remind " + (nameOf(t) || "them") + " (bell, e-mail or WhatsApp)", "aria-haspopup": "menu", "aria-expanded": "false" });
    var menu = h("span", { cls: "mon-menu", role: "menu", hidden: true });
    function close() { menu.hidden = true; b.setAttribute("aria-expanded", "false"); doc.removeEventListener("click", away, true); }
    function away(e) { if (!wrap.contains(e.target)) close(); }
    var crew = t.crew_id && S.crew[t.crew_id];
    var opts = [];
    if (S.has396) opts.push(["bell", "🔔 Bell in Helm", crew && crew.profile_id ? "On their Helm login" : "Only if they sign in to Helm"]);
    if (BPStore.ops && BPStore.ops.emailTasks) opts.push(["email", "✉ E-mail", "The task to their staff e-mail"]);
    if (BPStore.ops && BPStore.ops.whatsappTasks) opts.push(["wa", "WhatsApp", "From the studio's WhatsApp number"]);
    opts.forEach(function (x) {
      var it = h("button", { type: "button", cls: "mon-menu-it", role: "menuitem" }, [h("b", { text: x[1] }), h("small", { text: x[2] })]);
      it.addEventListener("click", function () { close(); remind(t, x[0], b); });
      menu.appendChild(it);
    });
    b.addEventListener("click", function (e) {
      e.stopPropagation(); var open = menu.hidden; menu.hidden = !open; b.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) { doc.addEventListener("click", away, true); var f = menu.querySelector("button"); if (f) f.focus(); } else close();
    });
    menu.addEventListener("keydown", function (e) {
      var items = Array.prototype.slice.call(menu.querySelectorAll("button")), i = items.indexOf(doc.activeElement);
      if (e.key === "Escape") { e.preventDefault(); close(); b.focus(); }
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); var n = items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]; if (n) n.focus(); }
    });
    wrap.appendChild(b); wrap.appendChild(menu);
    return wrap;
  }
  async function remind(t, how, btn) {
    if (how === "email") return nudge(t, btn);
    var who = nameOf(t) || "this person";
    if (how === "wa") {
      var ok = true;
      try { ok = window.BPUI && BPUI.confirm ? await BPUI.confirm("Send “" + (t.title || "this task") + "” to " + who + " on WhatsApp now?", { title: "Send on WhatsApp?", okLabel: "Send WhatsApp" }) : window.confirm("Send this task to " + who + " on WhatsApp now?"); } catch (e) { ok = false; }
      if (!ok) return;
      btn.disabled = true;
      try {
        var r = await BPStore.ops.whatsappTasks(t.id), why = r && r.reason;
        toast(r && r.ok ? "WhatsApp on its way to " + (r.name || who) + "." :
          why === "wa_not_set_up" ? "The studio's WhatsApp is not set up yet (Settings → Integrations), so nothing was sent." :
          why === "no_phone" ? who + " has no phone number on their staff record." :
          why === "just_sent" ? "A WhatsApp went to " + who + " a moment ago." :
          why === "trial" ? "In the free trial nothing leaves Helm, so no WhatsApp was sent." : "Nothing was sent for this task.");
      } catch (e) { toast((window.BPUI && BPUI.friendlyError) ? BPUI.friendlyError(e, { action: "send the WhatsApp" }) : "Could not send the WhatsApp."); }
      finally { btn.disabled = false; }
      return;
    }
    btn.disabled = true;
    try {
      var b = await BPStore.ops.dayPlan.bell(t.id), w2 = b && b.reason;
      toast(b && b.ok ? "Bell reminder sent to " + (b.name || who) + "'s Helm login." :
        w2 === "no_login" ? who + " does not sign in to Helm - use E-mail or WhatsApp." :
        w2 === "just_sent" ? "A bell reminder went to " + who + " a moment ago." : "Nothing was sent for this task.");
    } catch (e) { toast((window.BPUI && BPUI.friendlyError) ? BPUI.friendlyError(e, { action: "send the bell reminder" }) : "Could not send the bell reminder."); }
    finally { btn.disabled = false; }
  }
  /* R226: proof photo beside Done (task_evidence proof_photo, signed 5-minute links; nothing when there is none) */
  function proofThumb(t, big) {
    var paths = S.proof[t.id] || [], urls = paths.map(function (p) { return S.proofUrl[p]; }).filter(Boolean);
    if (!urls.length) return null;
    var list = big ? urls : urls.slice(-1);
    var box = h("span", { cls: "mon-proof" + (big ? " is-big" : "") });
    list.forEach(function (u, i) {
      var a = h("a", { href: u, target: "_blank", rel: "noopener", "aria-label": "Proof photo " + (i + 1) + " for " + (t.title || "task") });
      var img = h("img", { alt: "", loading: "lazy", decoding: "async" }); img.src = u; img.width = big ? 160 : 40; img.height = big ? 120 : 40;
      a.appendChild(img); box.appendChild(a);
    });
    if (!big && urls.length > 1) box.appendChild(h("small", { text: "+" + (urls.length - 1) }));
    return box;
  }
  /* R226: the task drawer - everything about one task without leaving the monitor */
  function drawerRow(dl, k, v) { if (v == null || v === "") return; dl.appendChild(h("dt", { text: k })); var dd = h("dd"); if (typeof v === "string") dd.textContent = v; else dd.appendChild(v); dl.appendChild(dd); }
  function latestStartOf(t) {
    var EP = window.HelmEventPlan; if (!EP || !S.plan || S.quote === "all") return null;
    var e = S.evInfo[S.quote] || {}, sc = EP.schedule(S.tasks, { readyAt: EP.readyAt(S.plan, e.event_date, e.event_time, tz()), venueAt: EP.venueAt(S.plan, e.event_date, tz()),
      bufPct: S.plan.settings && S.plan.settings.buffer_pct, remindMin: S.plan.settings && S.plan.settings.remind_before_min });
    return (sc.rows || []).filter(function (r) { return r.t.id === t.id; })[0] || null;
  }
  function openDrawer(t, from) {
    var d = $("#monDrawer"), b = $("#monDrawerB"); if (!d || !b) return;
    S.drawer = t.id; S.lastFocus = from || doc.activeElement;
    fillDrawer(t);
    $("#monScrim").hidden = false; d.hidden = false; doc.body.classList.add("mon-drawer-open");
    try { $("#monDrawerX").focus(); } catch (e) {}
  }
  function fillDrawer(t) {
    var b = $("#monDrawerB"); clear(b); var s = stateOf(t);
    $("#monDrawerH").textContent = t.title || "Task";
    var head = h("div", { cls: "mon-drawer-st" }); head.appendChild(steps(t)); head.appendChild(chip(s)); if (t.is_special) head.appendChild(h("span", { cls: "mon-chip is-special", text: "🔔 Special" }));
    b.appendChild(head);
    var dl = h("dl", { cls: "mon-dl" }), c = t.crew_id && S.crew[t.crew_id], who = nameOf(t);
    var wv = who || TS.LABEL.unassigned;
    if (c && c.phone && S.canEdit) { var ph = String(c.phone).replace(/[^\d+]/g, ""); if (ph) wv = h("span", {}, [who + " · ", h("a", { href: "tel:" + ph, text: "Call" })]); }
    drawerRow(dl, "Who", wv);
    drawerRow(dl, "Section", t.category || "Other");
    if (t._code) drawerRow(dl, "Event", t._code);
    drawerRow(dl, "Starts", t.planned_start ? fmtWhen(t.planned_start) + (s.late ? " · " + lateWords(TS.lateMin(t)) : "") : "No start time");
    if (t.planned_end) drawerRow(dl, "Ends", fmtWhen(t.planned_end));
    var ls = latestStartOf(t);
    if (ls) drawerRow(dl, "Latest start", fmtClock(new Date(ls.ls).toISOString()) + " to be ready by " + fmtClock(new Date(ls.lf).toISOString()) + " · takes " + window.HelmEventPlan.durWords(ls.dur));
    var need = t.depends_on && S.tasks.filter(function (x) { return x.id === t.depends_on; })[0];
    if (need) drawerRow(dl, "Needs first", (need.title || "a task") + " (" + stateOf(need).label + ")");
    var lk = linkOf(t); if (lk) drawerRow(dl, lk.kind === "go" ? "Can start" : lk.kind === "early" ? "Note" : lk.kind === "rework" ? "On hold" : lk.bad ? "Blocked" : "Waiting", lk.text);   // R253
    if (t.responded_at) drawerRow(dl, t.status === "rejected" ? "Turned down" : "Accepted", fmtWhen(t.responded_at));
    if (t.started_at) drawerRow(dl, "Started", fmtWhen(t.started_at));
    if (t.completed_at) drawerRow(dl, "Done", fmtWhen(t.completed_at));
    if (["pending", "passed", "rejected"].indexOf(t.verify_status) >= 0) drawerRow(dl, "Approval", t.verify_status === "passed" ? "Approved" + (t.verified_at ? " · " + fmtWhen(t.verified_at) : "") : t.verify_status === "pending" ? (s.key === "done" ? h("a", { href: "approvals.html?quote=" + encodeURIComponent(t.quote_id || S.quote), text: "Waiting - open Approvals" }) : "Waiting for a check") : "Sent back for rework" + (t.verify_note ? ": " + t.verify_note : ""));   // R253
    if (t.note) drawerRow(dl, "Note", String(t.note));
    b.appendChild(dl);
    var ph2 = proofThumb(t, true);
    b.appendChild(h("h3", { cls: "mon-h3", text: "Proof photo" }));
    b.appendChild(ph2 || h("p", { cls: "mon-muted", text: s.key === "done" ? "No photo was added when this was marked done." : "Shows here when the work is marked done with a photo." }));
    var acts = (allActs() || []).filter(function (a) { return a && a.task_id === t.id; }).slice(0, 8);
    b.appendChild(h("h3", { cls: "mon-h3", text: "Updates" }));
    if (!acts.length) b.appendChild(h("p", { cls: "mon-muted", text: "No updates yet." }));
    else { var ol = h("ol", { cls: "mon-feed" }); acts.forEach(function (a) { ol.appendChild(h("li", {}, [h("span", { text: actText(a) }), h("small", { cls: "mon-muted", text: " · " + ago(a.at) })])); }); b.appendChild(ol); }
    var foot = h("div", { cls: "mon-drawer-f" });
    if (canRemind(t)) foot.appendChild(remindBtn(t));
    foot.appendChild(h("a", { cls: "tc-btn tc-primary", href: opsHref(t), text: "Edit in Tasks & Crew →" }));
    b.appendChild(foot);
    b.appendChild(h("p", { cls: "mon-hint", text: "Reassign, change the time or cancel it there." }));
  }
  function closeDrawer() {
    var d = $("#monDrawer"); if (!d || d.hidden) return;
    d.hidden = true; $("#monScrim").hidden = true; doc.body.classList.remove("mon-drawer-open"); S.drawer = null;
    var f = S.lastFocus; S.lastFocus = null; if (f && doc.contains(f)) { try { f.focus(); } catch (e) {} }
  }
  function drawerKeys(e) {
    var d = $("#monDrawer"); if (!d || d.hidden) return;
    if (e.key === "Escape") { if (e.target && e.target.closest && e.target.closest(".mon-menu")) return; e.preventDefault(); closeDrawer(); return; }
    if (e.key !== "Tab") return;
    var f = Array.prototype.filter.call(d.querySelectorAll("a[href],button:not([disabled]),[tabindex]:not([tabindex='-1'])"), function (n) { return n.offsetParent !== null || n === doc.activeElement; });
    if (!f.length) return; var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first.focus(); }
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
  // R255: one person, two works at the same time - the same tag as Tasks & Crew (task-clash.js; other events: one small read a minute)
  function sameText(t) {
    var TC = window.HelmTaskClash; if (!TC || !TC.board || !single() || t.status === "completed") return "";
    if (S.same === undefined) { try { S.same = TC.board({ quoteId: S.quote, tasks: S.tasks, onChange: function () { S.same = undefined; if (S.lastLoad) render(); } }); } catch (e) { S.same = null; } }
    return (S.same && S.same.byTask[t.id]) || "";
  }
  function afterReady(t) { var EP = window.HelmEventPlan, e = S.evInfo[S.quote] || {}; return single() && EP && EP.afterReady && S.plan ? EP.afterReady(t, { plan: S.plan, eventDate: e.event_date ? String(e.event_date).slice(0, 10) : "", eventTime: String(e.event_time || "").trim(), tz: tz() }) : ""; }
  // R257: a check sent the work back and it is not done again yet (the same rule as Tasks & Crew)
  function sentBack(t) { return !!t && t.verify_status === "rejected" && t.status !== "completed" && t.status !== "cancelled"; }
  function taskRow(t, opts) {
    opts = opts || {};
    var s = stateOf(t);
    var row = h("div", { cls: "mon-row" + (s.late && lateOn() ? " is-late" : "") + (s.key === "done" ? " is-done" : ""), role: "listitem" });
    row.appendChild(timeCell(t));
    var main = h("div", { cls: "mon-row-main" });
    var tt = h("div", { cls: "mon-row-title" }, [h("span", { text: t.title || "Task" })]);
    if (t.is_special) tt.appendChild(h("span", { cls: "mon-chip is-special", text: "🔔 Special" }));
    main.appendChild(tt);
    var meta = h("div", { cls: "mon-row-meta" });
    if (opts.showWho !== false) { var nm = nameOf(t); meta.appendChild(h("span", { cls: nm ? "" : "mon-warn", text: nm || TS.LABEL.unassigned })); }
    if (opts.showSec !== false) meta.appendChild(h("span", { cls: "mon-muted", text: t.category || "Other" }));
    var lk = linkOf(t); if (lk) meta.appendChild(h("span", { cls: "mon-waits" + (lk.bad ? " is-bad" : ""), text: "↳ " + lk.text }));   // R252
    var sm = sameText(t); if (sm) meta.appendChild(h("span", { cls: "mon-chip is-same", text: sm, title: "This person has two works at the same time" }));
    var arx = afterReady(t); if (arx) meta.appendChild(h("span", { cls: "mon-chip is-same", text: arx }));   // R257
    if (sentBack(t)) meta.appendChild(h("span", { cls: "mon-waits is-bad", text: "Sent back" + (t.verify_note ? ": " + String(t.verify_note).slice(0, 160) : "") }));
    if (t._code) meta.appendChild(h("span", { cls: "mon-code", text: t._code }));
    main.appendChild(meta);
    row.appendChild(main);
    var st = h("div", { cls: "mon-row-st" }); st.appendChild(steps(t)); st.appendChild(chip(lateOn() ? s : { key: s.key, label: s.label, late: false }));
    if (sentBack(t)) st.appendChild(h("span", { cls: "mon-chip is-rejected", text: "Sent back" }));   // R257
    if (s.key === "done" && t.verify_status === "pending") st.appendChild(h("span", { cls: "mon-chip is-appr", text: "To approve" }));   // R253
    if (s.key === "done") { var pt = proofThumb(t, false); if (pt) st.appendChild(pt); }   // R226: the proof photo beside Done
    row.appendChild(st);
    row.appendChild(actions(t));
    return row;
  }

  /* ---- views ---- */
  /* R251: People and Work show the work in the order it happens - Day before, Pre-event, On the event, Wrap-up - each under its own
     heading with a done count. "All events" (no steps) keeps one flat list. A group folds: Wrap-up starts closed until the event is
     over, a finished earlier step starts closed too; with a filter or a search on, every group with a match is open. */
  function stepO(q) { var e = S.evInfo[q] || {}; return { eventDate: e.event_date ? String(e.event_date).slice(0, 10) : "", eventTime: String(e.event_time || "").trim(), tz: tz() }; }
  function single() { return !!S.quote && S.quote !== "all"; }
  function foldDefault(w, g) { return w === "wrapup" ? S.autoWin !== "wrapup" : !g.open && stepIdx(w) < stepIdx(S.win); }
  function byStep(list, draw) {
    if (!single()) return draw(list);
    var o = stepO(S.quote), all = TS.bySteps(S.tasks, o), got = TS.bySteps(list, o), wrap = h("div", { cls: "mon-steps-list" });
    var filtering = !!(S.st || $("#monWho").value || $("#monSec").value || ($("#monQ").value || "").trim());
    var preLeft = all.daybefore.unassigned + all.pre.unassigned, hinted = false;
    TS.WINDOWS.forEach(function (x) {
      var w = x[0], g = all[w], ts = got[w].tasks; if (!ts.length) return;
      if (preLeft && !hinted && (S.autoWin === "daybefore" || S.autoWin === "pre") && (w === "onday" || w === "wrapup")) { hinted = true; wrap.appendChild(h("p", { cls: "mon-allochint", text: "Allocate pre-event work first - " + preLeft + " left" })); }
      var key = S.quote + "|" + S.win + "|" + w, open = filtering || (key in S.fold ? !S.fold[key] : !foldDefault(w, g));
      var sec = h("section", { cls: "mon-stepgrp is-" + w, "aria-label": x[1] + " work" }), id = "monGrp-" + w;
      var btn = h("button", { type: "button", cls: "mon-stepgrp-b", id: id + "-b", "aria-expanded": String(open), "aria-controls": id }, [
        h("span", { cls: "mon-stepgrp-t", text: w === "wrapup" ? "Wrap-up tasks" : x[1] }), h("span", { cls: "mon-stepgrp-n", text: g.done + " of " + g.total + " done" }),
        g.unassigned ? h("span", { cls: "mon-chip is-unassigned", text: g.unassigned + " to assign" }) : null, h("span", { cls: "mon-stepgrp-c", "aria-hidden": "true" })]);
      var body = h("div", { id: id, hidden: !open }); body.appendChild(draw(ts));
      btn.addEventListener("click", function () { var o2 = body.hidden; body.hidden = !o2; btn.setAttribute("aria-expanded", String(o2)); S.fold[key] = !o2; });
      sec.appendChild(h("h3", { cls: "mon-stepgrp-h" }, [btn])); sec.appendChild(body); wrap.appendChild(sec);
    });
    return wrap.firstChild ? wrap : empty("No tasks match these filters.");
  }
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
      var ts = groups[k], first = ts[0], sm = summarize(ts, now), nm = k === "none" ? TS.LABEL.unassigned : nameOf(first);
      var card = h("section", { cls: "mon-card mon-person" + (sm.late && lateOn() ? " has-late" : ""), label: nm });
      var head = h("div", { cls: "mon-person-head" });
      head.appendChild(avatar(nm, first));
      var who = h("div", { cls: "mon-person-who" }, [h("b", { text: nm })]);
      var c = first.crew_id && S.crew[first.crew_id], line = [];
      if (c && (c.department || c.role)) line.push(c.department || c.role);
      var last = lastAct(ts); if (last) line.push(last);
      who.appendChild(h("small", { text: line.join(" · ") || (k === "none" ? "Give these tasks to someone in Tasks & Crew" : "") }));
      // R184: attendance line (check-in / check-out) + the day they said they can't work, with their reason
      if (first.crew_id && liveOn()) {   // R250: check-in from the event day on (not the day before)
        var at = attendance(first.crew_id);
        var att = h("small", { cls: "mon-att is-" + at.state + (at.late ? " is-late" : "") }, [h("span", { text: (at.state === "none" ? "○ " : "📍 ") + at.text + (at.hours ? " · " + at.hours + " h" : "") })]);
        if (at.late) att.appendChild(h("span", { cls: "mon-chip is-late", text: "Late check-in" + (at.lateMin ? " · " + at.lateMin + " min" : "") }));
        who.appendChild(att);
      }
      if (first.crew_id) {
        var off = offReason(first.crew_id);
        // R187 (0370): a day still waiting for the office's approval says so
        if (off != null) who.appendChild(h("small", { cls: "mon-offnote", text: S.offAsk[first.crew_id] ? "⏳ Asked for this day off - waiting for approval · " + (off || "no reason given")
          : "⛔ Marked this day as can’t work · " + (off || "no reason given") }));
      }
      head.appendChild(who);
      var pr = h("div", { cls: "mon-person-pr" });
      pr.appendChild(h("b", { text: sm.done + "/" + sm.total + " done" }));
      if (sm.late && lateOn()) pr.appendChild(h("span", { cls: "mon-chip is-late", text: sm.late + " late" }));
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
      var card = h("section", { cls: "mon-card mon-sec" + (sm.late && lateOn() ? " has-late" : ""), label: k });
      var head = h("div", { cls: "mon-sec-head" }, [h("h3", { cls: "mon-sec-title", text: k })]);
      var pr = h("div", { cls: "mon-person-pr" });
      pr.appendChild(h("b", { text: sm.done + "/" + sm.total + " done" }));
      if (sm.late && lateOn()) pr.appendChild(h("span", { cls: "mon-chip is-late", text: sm.late + " late" }));
      if (sm.unassigned) pr.appendChild(h("span", { cls: "mon-chip is-unassigned", text: sm.unassigned + " not assigned" }));
      pr.appendChild(bar(sm.pct, "small"));
      head.appendChild(pr); card.appendChild(head);
      var rows = h("div", { cls: "mon-rows", role: "list" });
      ts.forEach(function (t) { rows.appendChild(taskRow(t, { showSec: false })); });
      card.appendChild(rows); wrap.appendChild(card);
    });
    return order.length ? wrap : empty("No tasks match these filters.");
  }
  /* R184: Activity - every update, newest first, grouped by day; filter by person (top filter) and by type */
  function actPersonKey(a) { return a.crew_id ? "c:" + a.crew_id : (a.name ? "n:" + String(a.name).toLowerCase() : ""); }
  /* R184 Check-in list (R251: back as its own tab - the owner missed it): who is not here first, in / out times, late, hours */
  function viewCheckin(list) {
    if (!S.hasSheet) return empty(S.quote === "all" ? "Pick one event to see who has checked in." : "Check-in times can’t be read here.");
    var ppl = {}, order = [];
    list.forEach(function (t) { if (!t.crew_id || t.status === "rejected") return; if (!ppl[t.crew_id]) { ppl[t.crew_id] = []; order.push(t.crew_id); } ppl[t.crew_id].push(t); });
    if (!order.length) return empty(S.tasks.length ? "No one matches these filters." : "No one has work on this event yet.");
    var rank = function (id) { var a = attendance(id); return a.state === "none" ? (isFinite(firstStart(id)) && firstStart(id) < Date.now() ? 0 : 1) : a.state === "in" ? 2 : 3; };
    order.sort(function (a, b) { return rank(a) - rank(b) || nameOf(ppl[a][0]).localeCompare(nameOf(ppl[b][0])); });
    var ac = attendanceCounts();
    var card = h("section", { cls: "mon-card mon-ci", label: "Check-in" });
    card.appendChild(h("p", { cls: "mon-muted", text: ac.checkedIn + " of " + ac.people + " checked in" + (ac.late ? " · " + ac.late + " late" : "") +
      ". Staff check in and out on their task page (their link); the office can correct times in Tasks & Crew → Timesheet." }));
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
      var li = h("li", { cls: "mon-tl-i is-" + actGroup(a.kind) + (a.kind === "rejected" || a.kind === "cancelled" || a.kind === "sent_back" ? " is-warn" : "") });
      li.appendChild(h("span", { cls: "mon-tl-ic", text: ACT_ICON[a.kind] || "•" }));
      var body = h("div", { cls: "mon-tl-b" }, [h("span", { text: actText(a) })]);
      var meta = [fmtClock(a.at)];
      if (a.by_name && (a.kind === "assigned" || a.kind === "reassigned" || a.kind === "unassigned" || a.kind === "time_changed" || a.kind === "step_changed" || a.kind === "special_on" || a.kind === "special_off" || a.kind === "cancelled" || a.kind === "check_edit")) meta.push("by " + a.by_name);
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
  /* ---- R250: what each step shows ---- */
  // "late" only means something while the event day is running (days early or after it, a passed start time is no red alert)
  function lateOn() { return (S.win === "pre" || S.win === "onday") && (S.autoWin === "pre" || S.autoWin === "onday"); }
  function liveOn() { return S.win !== "daybefore"; }
  function fact(label, value, cls) { return h("div", { cls: "mon-fact" + (cls ? " " + cls : "") }, [h("span", { cls: "mon-fact-l", text: label }), h("b", { cls: "mon-fact-v", text: value })]); }
  function hoursIn() {
    var sum = 0, n = 0;
    Object.keys(S.sheet).forEach(function (id) { var v = Number(S.sheet[id] && S.sheet[id].hours); if (isFinite(v) && v > 0) { sum += v; n++; } });
    return { hours: Math.round(sum * 10) / 10, people: n };
  }
  // Day before: is everyone assigned and has everyone said yes? (no %, no late, no check-in)
  function readiness(tasks) {
    var o = { total: 0, assigned: 0, accepted: 0, noTime: 0, noDur: 0, hasDur: false, need: [] };
    (tasks || []).forEach(function (t) {
      if (!t || t.status === "cancelled") return; var s = stateOf(t); o.total++;
      if (Object.prototype.hasOwnProperty.call(t, "duration_min")) o.hasDur = true;
      if (s.key !== "unassigned" && s.key !== "rejected") o.assigned++;
      if (s.key === "accepted" || s.key === "started" || s.key === "done") o.accepted++;
      if (s.key !== "done" && !t.planned_start) o.noTime++;
      if (s.key !== "done" && (t.duration_min == null || t.duration_min === "")) o.noDur++;
      if (s.key === "unassigned" || s.key === "waiting" || s.key === "rejected") o.need.push(t);
    });
    var rank = { rejected: 0, unassigned: 1, waiting: 2 };
    o.need.sort(function (a, b) {
      var x = rank[stateOf(a).key] - rank[stateOf(b).key]; if (x) return x;
      var pa = a.planned_start ? new Date(a.planned_start).getTime() : Infinity, pb = b.planned_start ? new Date(b.planned_start).getTime() : Infinity;
      return pa - pb || String(a.title || "").localeCompare(String(b.title || ""));
    });
    return o;
  }
  function renderSummary() {
    var box = $("#monSummary"); clear(box);
    var sm = summarize(S.tasks), now = Date.now();
    box.className = "mon-summary is-" + S.win;
    box.hidden = !S.tasks.length || S.win === "daybefore";   // R257: Day before starts with the checklist; its numbers are in the closed card (renderPrep)
    if (box.hidden) { renderAlerts(now); renderPrep(); return; }
    if (S.autoWin === "wrapup" && S.win === "onday") {
      // the event is over: what is still open + the hours (the rest is in Wrap-up, closed, at the bottom)
      var left = leftover(S.tasks).length, hi = hoursIn(), row2 = h("div", { cls: "mon-facts" });
      row2.appendChild(fact("Done", sm.done + " of " + sm.total, "is-ok"));
      row2.appendChild(fact("Still open", String(left), left ? "is-warn" : "is-ok"));
      if (hi.people) row2.appendChild(fact("Hours checked in", hi.hours + " h · " + hi.people + (hi.people === 1 ? " person" : " people")));
      box.appendChild(row2);
      if (left) {
        var b = h("button", { cls: "tc-btn sm", type: "button", text: "Show the " + left + " still open" });
        b.addEventListener("click", function () { S.st = "open"; if (S.tab === "activity") setTab("staff"); render(); try { $("#monWork").scrollIntoView({ behavior: "smooth", block: "start" }); } catch (e) {} });
        box.appendChild(h("div", { cls: "mon-sum-acts" }, [b]));
      }
    } else {
      // one slim live strip - % done, late, checked in, next task (Pre-event: of the work before guests only)
      if (S.win === "pre") sm = summarize(preTasks());
      var strip = h("div", { cls: "mon-live" });
      strip.appendChild(h("div", { cls: "mon-pct" }, [h("b", { text: sm.pct + "%" }), h("span", { text: (S.win === "pre" ? " of pre-event done · " : " done · ") + sm.done + " of " + sm.total })]));
      strip.appendChild(bar(sm.pct));
      var facts = h("div", { cls: "mon-facts" });
      if (lateOn()) facts.appendChild(fact("Late", String(sm.late), sm.late ? "is-bad" : "is-ok"));
      var ac = attendanceCounts();
      if (ac.people) facts.appendChild(fact("Checked in", ac.checkedIn + " of " + ac.people + (ac.late ? " · " + ac.late + " late" : ""), ac.late ? "is-warn" : ""));
      if (sm.next) facts.appendChild(fact("Next", (sm.next.title || "task") + " " + until(sm.next.planned_start, now), "is-next"));
      strip.appendChild(facts);
      box.appendChild(strip);
    }
    renderAlerts(now);
    renderPrep();
  }
  // the work that has to be done before guests arrive (Pre-event, and what was left from the day before)
  function preTasks() { var o = stepO(S.quote); return S.tasks.filter(function (t) { var w = TS.taskStep(t, o); return w === "pre" || w === "daybefore"; }); }
  // R253: finished work nobody has checked yet -> the Approvals page
  function apprN() { return S.tasks.filter(function (t) { return t.status === "completed" && t.verify_status === "pending"; }).length; }
  function apprLink(q) { var n = apprN(); return n ? [["To approve · " + n, "approvals.html?quote=" + q]] : []; }
  // R251: the same "Get set up" shortcuts as Tasks & Crew (each page checks its own permission)
  function setupLinks() {
    var q = encodeURIComponent(S.quote), floor = "builder.html?quote=" + q, row = h("nav", { cls: "mon-setup", label: "Get set up" });
    try { if (window.HelmUrl && HelmUrl.build) floor = HelmUrl.build("floor-plan", { id: S.quote }) || floor; } catch (e) {}
    var n = Array.isArray(S.rs) ? S.rs.length : null;
    [["Crew", "staff.html"], ["Stock", "resources.html?quote=" + q], ["Vendors", "vendors.html?tab=requests&quote=" + q], ["Run-sheet" + (n == null ? "" : n ? " · " + n : " · empty"), "runsheet.html?quote=" + q],
      ["Floor layout", floor], ["Ready check", "ready.html?quote=" + q]].concat(apprLink(q)).forEach(function (l) { row.appendChild(h("a", { cls: "tc-chip mon-setup-a", href: l[1], text: l[0] })); });
    return row;
  }
  /* R250: Day before - "Needs action before the day": not assigned / not accepted yet / turned down. R252: a task made for a line of the
     Day-before card shows there (who has it, how it is going), so it is not listed a second time here. */
  function inDayCard(t) {
    var D = window.HelmDayBefore, card = $("#monDayBefore"), cat = D && D.CAT ? String(D.CAT).toLowerCase() : "";
    return !!(cat && card && !card.hidden && String((t && t.category) || "").trim().toLowerCase() === cat);
  }
  // R257 (owner: "the day before: why do these actions come there?"): below the checklist, in one closed card - the numbers, the set-up links, tasks that need someone
  var PREP = { open: false };
  function renderPrep() {
    var box = $("#monPrep"); if (!box) return;
    var had = doc.activeElement && box.contains(doc.activeElement) && doc.activeElement.tagName === "SUMMARY"; clear(box);
    if (S.win !== "daybefore" || !single()) { box.hidden = true; return; }
    var rr = readiness(S.tasks), need = rr.need.filter(function (t) { return !inDayCard(t); }), an = apprN(), n = need.length;
    box.hidden = false;
    var bits = []; if (rr.total) { bits.push(rr.assigned + " of " + rr.total + " assigned", rr.accepted + " of " + rr.total + " accepted"); if (rr.noTime) bits.push(rr.noTime + " without a start time"); }
    var d = h("details", { cls: "mon-prepd" }), sm = h("summary", { id: "monPrepH" }, ["Tasks that need action ", h("span", { cls: "mon-n" + (n ? " is-warn" : ""), text: String(n) }), h("small", { text: bits.join(" · ") })]);
    d.open = PREP.open; d.addEventListener("toggle", function () { PREP.open = d.open; }); d.appendChild(sm); box.appendChild(d);
    if (rr.hasDur && rr.noDur) d.appendChild(h("p", { cls: "mon-hint", text: rr.noDur + (rr.noDur === 1 ? " task has" : " tasks have") + " no duration. A task with a duration gets a latest start time in Ready by (Pre-event). Add durations in Tasks & Crew." }));
    if (an) d.appendChild(h("p", { cls: "mon-hint mon-appr" }, [an + " finished task" + (an === 1 ? " waits" : "s wait") + " for approval. ", h("a", { href: "approvals.html?quote=" + encodeURIComponent(S.quote), text: "Open Approvals" })]));   // R253
    if (!n) d.appendChild(h("p", { cls: "mon-hint", text: rr.total ? "Nothing - no task is waiting for a person or a yes." : "No tasks on this event yet." }));
    else {
      d.appendChild(h("p", { cls: "mon-hint", text: "Tasks without a person, not accepted yet or turned down. Open shows the task; reassign in Tasks & Crew." }));
      var rows = h("div", { cls: "mon-rows", role: "list" }), MAX = 12;
      need.slice(0, MAX).forEach(function (t) { rows.appendChild(taskRow(t)); });
      d.appendChild(rows);
      if (n > MAX) d.appendChild(h("p", { cls: "mon-hint", text: "And " + (n - MAX) + " more - use the Not assigned / Not accepted yet chips below." }));
    }
    d.appendChild(setupLinks());
    if (had) try { sm.focus({ preventScroll: true }); } catch (e) {}
  }
  /* R184: red LATE panel - every task whose start time has passed and is not started (task, person, was due, how long ago, Nudge) */
  function lateTasks(now) {
    return S.tasks.filter(function (t) { return t && t.status !== "cancelled" && stateOf(t, now).late; })
      .sort(function (a, b) { return new Date(a.planned_start) - new Date(b.planned_start); });
  }
  function renderAlerts(now) {
    var box = $("#monAlerts"); if (!box) return; clear(box);
    if (!lateOn()) { box.hidden = true; return; }   // R250: the red Late panel only while the event day runs (Pre-event: set-up jobs)
    var late = lateTasks(now);
    if (S.win === "pre") { var o = stepO(S.quote); late = late.filter(function (t) { var w = TS.taskStep(t, o); return w === "pre" || w === "daybefore"; }); }
    if (!late.length) { box.hidden = true; return; }
    box.hidden = false;
    box.appendChild(h("h3", { cls: "mon-alerts-h" }, [h("span", { text: S.win === "pre" ? "⚠ Late set-up jobs — start time passed, not started" : "⚠ Late — start time passed, not started" }), h("span", { cls: "mon-n", text: String(late.length) })]));
    var list = h("div", { cls: "mon-alerts-list", role: "list" });
    late.forEach(function (t) {
      var row = h("div", { cls: "mon-alert", role: "listitem" });
      row.appendChild(h("div", { cls: "mon-alert-main" }, [
        h("b", { text: t.title || "Task" }),
        h("span", { text: [nameOf(t) || TS.LABEL.unassigned, t._code].filter(Boolean).join(" · ") }),
        h("small", { text: "was due " + fmtClock(t.planned_start) + " (" + ago(t.planned_start, now) + ")" + (stateOf(t, now).key === "waiting" ? " · not accepted yet" : "") })]));
      // R186 (0369): where the escalation ladder is now (special tasks)
      var esc = lastEscalation(t, S.acts);
      if (esc) row.appendChild(h("span", { cls: "mon-chip mon-esc is-esc-" + ({ manager: "manager", admin: "admin" }[esc.detail && esc.detail.level] || "lead"), text: "🚨 " + escBadge(esc) }));
      else if (t.is_special) row.appendChild(h("span", { cls: "mon-chip is-special", text: "🔔 Special" }));
      row.appendChild(actions(t));
      list.appendChild(row);
    });
    box.appendChild(list);
  }
  /* R250: status = filter chips with counts (they filter the list; they never switch the tab) */
  function renderChips() {
    var box = $("#monChips"); if (!box) return; clear(box);
    box.hidden = S.tab === "activity" || S.tab === "checkin";
    var sm = summarize(S.tasks), open = leftover(S.tasks).length;
    var list = [["", "All", sm.total], ["late", "Late", sm.late], ["unassigned", TS.LABEL.unassigned, sm.unassigned], ["waiting", TS.LABEL.waiting, sm.waiting],
      ["accepted", TS.LABEL.accepted, sm.accepted], ["started", TS.LABEL.started, sm.started], ["done", TS.LABEL.done, sm.done], ["rejected", TS.LABEL.rejected, sm.rejected], ["open", "Still open", open]];
    if (S.st === "late" && !lateOn()) S.st = "";
    list.forEach(function (c) {
      if (c[0] === "late" && !lateOn()) return;
      if (c[0] && !c[2] && S.st !== c[0]) return;   // a status nobody is in stays out of the way
      var on = (S.st || "") === c[0];
      var b = h("button", { cls: "mon-count is-" + (c[0] || "all") + (on ? " is-on" : ""), type: "button", "aria-pressed": on ? "true" : "false", data: { st: c[0] } });
      b.appendChild(h("span", { text: c[1] })); b.appendChild(h("b", { text: String(c[2]) }));
      box.appendChild(b);
    });
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
  // R194: filters - how many are on (the phone's Filters button shows it) and Clear only when something is on
  function filterCount() {
    var n = 0; ["#monWho", "#monSec"].forEach(function (s) { if ($(s).value) n++; });
    if ($("#monSort").value !== "time") n++;
    return n;
  }
  function paintFilters() {
    var n = filterCount(), q = ($("#monQ").value || "").trim();
    $("#monFiltersN").textContent = n ? String(n) : "";
    $("#monClear").hidden = !(n || q || S.st);
  }
  function fillFilters() {
    var who = $("#monWho"), sec = $("#monSec"), wv = who.value, sv = sec.value, people = {}, secs = {};
    S.tasks.forEach(function (t) { if (t.status === "cancelled") return; var k = personKey(t); if (k) people[k] = nameOf(t); secs[t.category || "Other"] = 1; });
    clear(who); who.appendChild(opt("", "Everyone"));
    Object.keys(people).sort(function (a, b) { return people[a].localeCompare(people[b]); }).forEach(function (k) { who.appendChild(opt(k, people[k], k === wv)); });
    clear(sec); sec.appendChild(opt("", "All sections"));
    // R230: "My departments" for a department supervisor (only when I supervise one on the shown events)
    var mineN = []; Object.keys(S.mine).forEach(function (q) { (S.mine[q] || []).forEach(function (d) { if (mineN.indexOf(d) < 0) mineN.push(d); }); });
    if (mineN.length) sec.appendChild(opt("__mine", "My departments (" + mineN.sort().join(", ") + ")", sv === "__mine"));
    else if (sv === "__mine") sv = "";
    Object.keys(secs).sort().forEach(function (k) { sec.appendChild(opt(k, k, k === sv)); });
  }
  /* ---- R226 / R251: the steps + the shared cards (event-plan.js, event-steps.js), the same as Tasks & Crew ---- */
  function modeFor() {
    var e = S.evInfo[S.quote] || {};
    return TS.opsMode({ eventDate: e.event_date, eventTime: e.event_time, stage: e.stage, status: e.status, tasks: S.tasks, runsheet: S.rs || [], now: Date.now(), tz: tz() });
  }
  function closedStage() { var st = (S.evInfo[S.quote] || {}).stage; return st === "settlement" || st === "closed"; }
  function setWin() {
    if (!single()) { S.win = S.autoWin = "onday"; S.manualWin = null; S.mode = null; return; }
    S.mode = modeFor(); var e = S.evInfo[S.quote] || {};
    S.autoWin = TS.opsWindow(S.mode, { eventDate: e.event_date, eventTime: e.event_time, stage: e.stage, now: Date.now(), tz: tz() });
    // studio time only (owner): a tap just looks at a step; another event, a reload or a new step by the clock goes back to the real one
    var now = TS.stepOf(S.autoWin), k = S.quote + ":" + now;
    if (S.winAt !== k || S.manualWin === now) S.manualWin = null; S.winAt = k;
    S.win = S.manualWin || now;
  }
  /* R251: the header badge = where the event really is (never the step someone is looking at) */
  function renderPill() {
    var p = $("#monPill"); if (!p) return;
    var w = S.autoWin, txt = !single() ? "Event day - live" : S.mode && S.mode.step === "cancelled" ? "Cancelled" :
      w === "pre" ? "Pre-event" : w === "onday" ? "Event day - live" : w === "wrapup" ? (closedStage() ? "Complete" : "Event over") : "Planning";
    p.hidden = false; p.textContent = txt; p.className = "tc-pill" + (w === "onday" ? "" : " plan");
  }
  /* R250: the step strip - the dot + "Now" marks where the event is (studio clock) */
  function renderWins() {
    renderPill();
    var row = $("#monWins"); if (!row) return;
    row.hidden = !single();
    if (row.hidden) return;
    var cur = null;
    Array.prototype.forEach.call(row.querySelectorAll("[data-win]"), function (b) {
      var w = b.getAttribute("data-win"), isNow = w === S.autoWin, seen = w === S.win;   // over: no step is Now (Wrap-up carries it)
      b.setAttribute("aria-pressed", String(seen));
      if (isNow) { b.setAttribute("aria-current", "step"); cur = b; } else b.removeAttribute("aria-current");
      b.classList.toggle("is-now", isNow); b.classList.toggle("is-seen", seen);
      var li = b.parentNode; if (li && li.classList) { li.classList.toggle("is-now", isNow); li.classList.toggle("is-past", stepIdx(w) < stepIdx(S.autoWin)); }
    });
    // a phone: the strip scrolls sideways; keep the Now step in view when it changes
    var list = $("#monStpList");
    if (list && cur && S.stpSeen !== S.quote + ":" + S.autoWin) {
      S.stpSeen = S.quote + ":" + S.autoWin;
      try { if (list.scrollWidth > list.clientWidth) list.scrollLeft = Math.max(0, cur.parentNode.offsetLeft - 16); } catch (e) {}
    }
  }
  function stepIdx(w) { var i = -1; (TS.WINDOWS || []).forEach(function (x, k) { if (x[0] === w) i = k; }); return i; }
  function planCtx() {
    var e = S.evInfo[S.quote] || {};
    return { plan: S.plan, tasks: S.tasks, quoteId: S.quote, eventDate: e.event_date ? String(e.event_date).slice(0, 10) : "", eventTime: String(e.event_time || "").trim(), tz: tz(), now: Date.now(),
      nameOf: nameOf, compact: true, status: String(e.status || ""), closed: planClosed(), sheet: S.hasSheet ? S.sheet : undefined, goCheckin: function () { setTab("checkin"); render(); goCard("#monWork"); }, goVendors: function () { goCard("#monVendors"); }, toast: function (m, t) { toast(m, t === "err" ? "err" : "ok"); },
      onChanged: async function () { await loadPlan(true); await loadTasks(true); } };
  }
  function renderCards() {
    var EP = window.HelmEventPlan, ui = EP && EP._ui, one = single(), e = S.evInfo[S.quote] || {}, cancelled = e.status === "cancelled";
    var dh = $("#monDayBefore"), rh = $("#monReady");
    var app = $("#monApp"); if (app) app.setAttribute("data-win", S.win);   // CSS: what shows per step and in what order
    dh.hidden = !(EP && S.plan && one && S.win === "daybefore");
    rh.hidden = !(EP && S.plan && one && (S.win === "daybefore" || S.win === "pre"));   // R251: Ready by + latest starts: planned before, used on Pre-event
    var ph = $("#monPreList"), DB = window.HelmDayBefore; if (ph) ph.hidden = !(DB && DB.renderPre && S.plan && one && S.win === "pre" && !cancelled);
    // R227 (0397, event-floor.js): the saved floor plan (every step; On the event it sits below the work). R257: no lock.
    var EF = window.HelmEventFloor, lh = $("#monLock"), fh = $("#monFloor");
    if (EF && one && !cancelled) EF.panel({ quoteId: S.quote, lockHost: lh, floorHost: fh, showFloor: true, compact: true, eventType: e.event_type || "",
      onChange: function () { renderCards(); } });
    else [lh, fh].forEach(function (n) { if (n) n.hidden = true; });
    renderRun(); renderDelay(); renderIssues(); renderSteps(); renderApprove();
    if (!EP || !S.plan || (ui && (ui.edit || ui.times || ui.settings))) return;   // a form is open: keep what is being typed
    if (!dh.hidden) EP.renderDayBefore(dh, planCtx());
    if (ph && !ph.hidden) DB.renderPre(ph, planCtx());
    if (!rh.hidden) EP.renderReady(rh, planCtx());
  }
  // R265: the Approvals list of this event, on Pre-event (approvals.js decides who sees it and what each role may do)
  function renderApprove() {
    var A = window.HelmApprovals, box = $("#monApprove"), e = S.evInfo[S.quote] || {}; if (!A || !A.embed || !box) return;
    if (!(single() && e._read && S.win === "pre" && e.status !== "cancelled") || doc.body.classList.contains("mon-wall")) { A.hide(); return; }
    A.embed(box, { quote: S.quote, count: apprN(), onChanged: function () { loadTasks(true); },
      openTask: function (id) { var t = S.tasks.filter(function (x) { return x.id === id; })[0]; if (!t) return false; openDrawer(t); return true; } });
  }
  /* R251 (event-steps.js, shared with Tasks & Crew): "Mark pre-event complete" at the end of Pre-event, Wrap-up closed at the bottom */
  function stepsCtx() {
    var e = S.evInfo[S.quote] || {}, one = single();
    return { quoteId: one ? S.quote : "", quote: one ? { code: e.code || "", title: e.title || "", status: e.status || "", stage: e.stage || "", eventDate: e.event_date ? String(e.event_date).slice(0, 10) : "", eventTime: String(e.event_time || "").trim() } : null,
      tasks: one ? S.tasks : [], autoWin: S.autoWin, win: S.win, tz: tz(), now: Date.now(), nameOf: nameOf, admin: S.admin, plan: S.plan || undefined, sheet: S.hasSheet ? S.sheet : undefined,
      toast: function (m, t) { toast(m, t === "err" ? "err" : "ok"); },
      onChanged: async function () { await readQuote(S.quote, true); await loadTasks(true); },
      onIssues: async function () { await loadIssues(); renderIssues(); }, onTask: function () { loadTasks(true); },
      openTask: function (id) { var t = S.tasks.filter(function (x) { return x.id === id; })[0]; if (t) openDrawer(t); } };
  }
  function renderSteps() {
    var ES = window.HelmEventSteps, EW = window.HelmEventWrap, box = $("#monPreDoneBox"), e = S.evInfo[S.quote] || {};
    var pre = !!(ES && single() && e._read && S.win === "pre");   // the stage is known
    box.hidden = !pre;
    if (pre) ES.renderPreDone($("#monPreDone"), stepsCtx());
    renderPreCheck();
    if (window.HelmWrapDo) window.HelmWrapDo.vendorCard($("#monVendors"), Object.assign(stepsCtx(), { show: single() && !!e._read && issStep() && S.autoWin !== "wrapup" }));   // R253
    if (window.HelmEventExtras && window.HelmEventExtras.card) window.HelmEventExtras.card($("#monExtras"), Object.assign(stepsCtx(), { show: single() && !!e._read && S.win === "onday" }));   // R255 (0440)
    if (EW && (e._read || e._tried || !single())) EW.render($("#monWrapUp"), stepsCtx()); else $("#monWrapUp").hidden = true;
    var btn = $("#monOpenOps");   // one filled button per screen: Pre-event has "Mark pre-event complete", a finished event has Wrap-up
    if (btn) btn.classList.toggle("tc-primary", S.win !== "pre" && S.autoWin !== "wrapup");
  }
  // R252 (pre-check.js, the same as Tasks & Crew): the pre-event check under the step strip; every minute, no read
  function renderPreCheck() {
    var PC = window.HelmPreCheck, host = $("#monPreCheck"), e = S.evInfo[S.quote] || {}; if (!PC || !host) return;
    if (!single() || !e._read) { PC.render(host, { quoteId: "" }, $("#monPreTop")); return; }
    var c = stepsCtx(); c.card = $("#monPreDone"); c.goPre = function () { var b = doc.querySelector('#monWins [data-win="pre"]'); if (b) b.click(); };
    c.phoneOf = function (t) { var p = t.crew_id && S.crew[t.crew_id]; return S.canEdit && p && p.phone ? String(p.phone).replace(/[^\d+]/g, "") : ""; };
    try { PC.how($("#monHow")); PC.render(host, c, $("#monPreTop")); } catch (x) { host.hidden = true; }
  }
  /* R251: On the event - the run-sheet's now / next. R264 (owner: "the run sheet should be shown complete, at least a dropdown"): the whole list under it,
     open until it is closed here (remembered on this page); read-only, changes stay on the Run-sheet page */
  function renderRun() {
    var box = $("#monRun"), e = S.evInfo[S.quote] || {}, ev = e.event_date ? String(e.event_date).slice(0, 10) : "";
    if (!box) return; var hadFocus = !!(doc.activeElement && box.contains(doc.activeElement) && doc.activeElement.tagName === "SUMMARY"), keepTop = (box.querySelector(".mon-run-all ol") || {}).scrollTop || 0; clear(box);
    box.hidden = !(single() && S.win === "onday" && S.autoWin !== "wrapup" && Array.isArray(S.rs) && ev);
    if (box.hidden) return;
    var now = Date.now(), rows = S.rs.map(function (r) { var d = Number(r && r.duration_min); return { r: r, s: TS.wallMs(ev, TS.hmMin(r && r.start_time), tz()), d: isFinite(d) && d > 0 ? d * 60000 : 900000 }; })
      .filter(function (x) { return x.r && isFinite(x.s) && isFinite(TS.hmMin(x.r.start_time)); }).sort(function (a, b) { return a.s - b.s; });
    var cur = rows.filter(function (x) { return now >= x.s && now < x.s + x.d; }), next = rows.filter(function (x) { return x.s > now; }).slice(0, 1);
    box.appendChild(h("div", { cls: "mon-mini-h" }, [h("h3", { cls: "tc-h2", id: "monRunH", text: "Run-sheet" }), h("a", { cls: "tc-mini-link", href: "runsheet.html?quote=" + encodeURIComponent(S.quote), text: "Open run-sheet →" })]));
    var noTime = S.rs.filter(function (r) { return r && !isFinite(TS.hmMin(r.start_time)); });
    if (!rows.length && !noTime.length) { box.appendChild(h("p", { cls: "mon-hint", text: "No run-sheet yet." })); return; }
    if (!cur.length && !next.length && rows.length) box.appendChild(h("p", { cls: "mon-hint", text: "Every run-sheet item is past." }));
    var ol = h("ol", { cls: "mon-run" });
    function line(x, isNow) {
      ol.appendChild(h("li", { cls: isNow ? "is-now" : "is-next" }, [h("span", { cls: "mon-run-k", text: isNow ? "Now" : "Next" }), h("b", { cls: "mon-run-t", text: fmtClock(new Date(x.s).toISOString()) }),
        h("span", { cls: "mon-run-n" }, [x.r.title || "Item", h("small", { text: [isNow ? "" : until(x.s, now), x.r.owner, x.r.location].filter(Boolean).join(" · ") })])]));
    }
    cur.forEach(function (x) { line(x, true); }); next.forEach(function (x) { line(x, false); });
    if (ol.firstChild) box.appendChild(ol);
    var all = h("ol", { cls: "mon-run" });
    rows.concat(noTime.map(function (r) { return { r: r, s: NaN, d: 0 }; })).forEach(function (x) {
      var st = !isFinite(x.s) ? "none" : cur.indexOf(x) >= 0 ? "now" : x === next[0] ? "next" : x.s > now ? "later" : "past";
      all.appendChild(h("li", { cls: "is-" + st }, [h("span", { cls: "mon-run-k", text: st === "now" ? "Now" : st === "next" ? "Next" : st === "past" ? "Past" : "" }), h("b", { cls: "mon-run-t", text: isFinite(x.s) ? fmtClock(new Date(x.s).toISOString()) : "No time" }),
        h("span", { cls: "mon-run-n" }, [x.r.title || "Item", h("small", { text: [Number(x.r.duration_min) > 0 ? Number(x.r.duration_min) + " min" : "", x.r.owner, x.r.location].filter(Boolean).join(" · ") })])]));
    });
    var n = rows.length + noTime.length, det = h("details", { cls: "mon-run-all" }, [h("summary", { text: "Full run-sheet (" + n + (n === 1 ? " item)" : " items)") }), all]);
    det.open = S.runOpen !== false; det.addEventListener("toggle", function () { S.runOpen = det.open; });
    box.appendChild(det); all.scrollTop = keepTop;
    if (hadFocus) { try { det.firstChild.focus({ preventScroll: true }); } catch (e2) {} }
  }
  /* R252 (event-delay.js, the same card as Tasks & Crew): what is running late and what that affects. From what the page already has -
     no extra read; redrawn every minute. Moving times stays on Tasks & Crew (Open task). */
  var DLY = null;
  function delayRes() {   // one calculation per redraw (render / the minute clock clear it)
    var HD = window.HelmDelay; if (!HD || !single()) return null; if (DLY && DLY.q === S.quote && DLY.ts === S.tasks && DLY.w === S.autoWin) return DLY.r;
    var e = S.evInfo[S.quote] || {}, r = null;
    try { r = HD.compute({ tasks: S.tasks, runsheet: Array.isArray(S.rs) ? S.rs : [], plan: S.plan, eventDate: e.event_date ? String(e.event_date).slice(0, 10) : "", eventTime: String(e.event_time || "").trim(), tz: tz(), now: Date.now(), live: S.autoWin === "pre" || S.autoWin === "onday" }); } catch (x) { r = null; }
    DLY = { q: S.quote, ts: S.tasks, w: S.autoWin, r: r }; return r;
  }
  function atClock(m) { return fmtClock(new Date(m).toISOString()); }
  // R253: released / hold / waits - the same words as Tasks & Crew and the worker page (event-delay.js)
  function linkOf(t) { var HD = window.HelmDelay, d = t && t.depends_on ? S.tasks.filter(function (x) { return x.id === t.depends_on; })[0] : null; return d && HD && HD.link ? HD.link(t, d, delayRes(), atClock) : null; }
  function renderDelay() {
    var HD = window.HelmDelay, host = $("#monDelay"), e = S.evInfo[S.quote] || {}; if (!HD || !host) return;
    var r = delayRes(), on = !!r && e.status !== "cancelled" && S.autoWin !== "wrapup" && (S.win !== "daybefore" || S.autoWin === "daybefore");
    HD.render(host, { quoteId: S.quote, result: on ? r : null, clock: atClock, nameOf: nameOf,
      phoneOf: function (t) { var c = t.crew_id && S.crew[t.crew_id]; return S.canEdit && c && c.phone ? String(c.phone).replace(/[^\d+]/g, "") : ""; },
      canNudge: canRemind, nudgeEl: remindBtn, open: function (t, b) { openDrawer(t, b); } });
  }
  /* R251 / R252: Pre-event + On the event - the event's issues (the same list, read, "log" and "assign" as Tasks & Crew and the Issues
     page: issue-assign.js; the server checks the Issues area). Not redrawn while a new one is typed or a person is being chosen. */
  function issStep() { return S.win === "onday" || S.win === "pre"; }
  var SEV = { low: "Low", medium: "Medium", high: "High" };
  async function loadIssues() {
    var I = BPStore.issues, q = S.quote, IA = window.HelmIssueAssign; if (!I || !I.list || !S.issView || !single() || !issStep()) { if (S.issQ !== q) { S.iss = null; S.issErr = false; } return; }
    if (S.issQ !== q) { S.iss = null; S.issErr = false; S.issOpen = false; }
    try { var r = await I.list(q); if (S.quote === q) { S.iss = Array.isArray(r) ? r : []; S.issErr = false; S.issQ = q; } }
    catch (e) { if (S.quote === q) { S.issErr = !(IA && IA.refused(e)); if (!S.issErr) S.iss = null; S.issQ = q; } }   // refused = hidden; no answer = "Couldn't check"
  }
  // R257: no event-day lock - only a closed event takes no plan changes
  function planClosed() { return (S.evInfo[S.quote] || {}).stage === "closed"; }
  function goCard(sel) { var n = $(sel); if (!n || n.hidden) { toast("That card has nothing to show yet.", "ok"); return; } if (!n.hasAttribute("tabindex")) n.setAttribute("tabindex", "-1"); try { n.scrollIntoView({ block: "start", behavior: "smooth" }); n.focus({ preventScroll: true }); } catch (e) {} }
  function issHref() { return "issues.html?quote=" + encodeURIComponent(S.quote) + "&from=monitor"; }
  function renderIssues() {
    var box = $("#monIssues"), IA = window.HelmIssueAssign; if (!box) return;
    if (!IA || !single() || !issStep() || S.issQ !== S.quote || !(Array.isArray(S.iss) || S.issErr)) { box.hidden = true; return; }
    box.hidden = false; if (S.issOpen) return;
    var n = IA._pure.organise(S.iss || []).open.length, sig = JSON.stringify([S.quote, S.issEdit, n, !S.iss]), lst = $("#monIssList");
    if (box._sig !== sig || !lst || box.querySelector(".mon-issform")) {
      if (lst && box._q !== S.quote) lst = null;   // another event: a fresh list
      box._sig = sig; box._q = S.quote; if (!lst) lst = h("div", { id: "monIssList" });
      var act = doc.activeElement, had = act && box.contains(act) && !lst.contains(act) ? act.id : "";
      Array.prototype.slice.call(box.childNodes).forEach(function (c) { if (c !== lst) box.removeChild(c); });
      var head = h("div", { cls: "mon-mini-h" }, [h("h3", { cls: "tc-h2", id: "monIssuesH" }, ["Issues ", h("span", { cls: "mon-n" + (n ? " is-warn" : ""), text: !S.iss ? "not checked" : n ? n + " open" : "none open" })])]);
      var acts = h("span", { cls: "mon-mini-acts" });
      if (S.issEdit) { var lg = h("button", { type: "button", cls: "tc-btn sm", id: "monIssLog", text: "+ Log an issue" }); lg.addEventListener("click", function () { issueForm(box, lg); }); acts.appendChild(lg); }
      acts.appendChild(h("a", { cls: "tc-mini-link", id: "monIssAll", href: issHref(), text: "All issues →" }));
      head.appendChild(acts); box.insertBefore(head, box.firstChild); if (lst.parentNode !== box) box.appendChild(lst);
      if (had) { var f = doc.getElementById(had); if (f) try { f.focus(); } catch (e) {} }
    }
    IA.list(lst, { items: S.iss || [], quoteId: S.quote, canEdit: S.issEdit, err: S.issErr, max: 5, allHref: issHref(), tasks: function () { return S.tasks; }, closed: planClosed,
      empty: S.iss ? "Nothing open. Something wrong on site? Log it so someone owns it." : "", toast: function (m, k) { toast(m, k); },
      reload: async function () { await loadIssues(); renderIssues(); }, onTask: function () { loadTasks(true); }, resolve: resolveIssue });
  }
  async function resolveIssue(i, btn) {
    btn.disabled = true;
    try { await BPStore.issues.setStatus(i.id, "resolved"); toast("Resolved: " + (i.title || "issue") + ".", "ok"); await loadIssues(); renderIssues(); }
    catch (x) { toast((window.BPUI && BPUI.friendlyError) ? BPUI.friendlyError(x, { action: "resolve the issue" }) : "Could not resolve the issue.", "err"); btn.disabled = false; }
  }
  function issueForm(box, btn) {
    if (S.issOpen) return; S.issOpen = true; btn.disabled = true; var q = S.quote, IA = window.HelmIssueAssign;
    var title = h("input", { cls: "tc-inp", id: "monIssTitle", maxlength: "500", placeholder: "e.g. Generator not delivered", autocomplete: "off" });
    var sev = h("select", { cls: "mon-select", id: "monIssSev" }); ["low", "medium", "high"].forEach(function (k) { sev.appendChild(opt(k, SEV[k], k === "medium")); });
    var pk = IA.picker({ quoteId: q, tasks: function () { return S.tasks; }, closed: planClosed, ids: "monIssWho" });
    var err = h("p", { cls: "mon-hint mon-warn", role: "alert", hidden: true });
    var go = h("button", { type: "submit", cls: "tc-btn", text: "Log it" }), no = h("button", { type: "button", cls: "tc-btn ghost", text: "Cancel" });
    var form = h("form", { cls: "mon-issform", "aria-label": "Log an issue", novalidate: "" }, [
      h("label", { cls: "mon-lbl", for: "monIssTitle", text: "What is wrong?" }), title,
      h("label", { cls: "mon-lbl", for: "monIssSev", text: "How serious" }), sev, pk.el, err, h("div", { cls: "mon-issform-f" }, [go, no])]);
    function done() { S.issOpen = false; box._sig = ""; renderIssues(); var b = $("#monIssLog"); if (b) try { b.focus(); } catch (e) {} }
    no.addEventListener("click", done);
    form.addEventListener("keydown", function (e) { if (e.key === "Escape") { e.preventDefault(); if (!go.disabled) done(); } });
    form.addEventListener("submit", async function (e) {
      e.preventDefault(); if (go.disabled) return;
      var t = String(title.value || "").replace(/\s+/g, " ").trim(), w = pk.value();
      if (!t) { err.textContent = "Say what is wrong."; err.hidden = false; title.focus(); return; }
      if (w.error) { err.textContent = w.error; err.hidden = false; pk.focus(); return; }
      err.hidden = true; go.disabled = no.disabled = true;
      try { await BPStore.issues.add(q, { kind: "issue", title: t, severity: sev.value, owner: w.name || null }); }
      catch (x) { err.textContent = (window.BPUI && BPUI.friendlyError) ? BPUI.friendlyError(x, { action: "log the issue" }) : "Could not log the issue."; err.hidden = false; go.disabled = no.disabled = false; return; }
      var r = await IA.withTask(q, t, w, "Issue logged" + (w.name ? " - " + w.name + " has it" : "") + ".");   // the issue is saved whatever happens to the task
      toast(r.msg, r.ok ? "ok" : "err");
      if (S.quote !== q) { if (S.issOpen && form.isConnected) done(); return; }
      if (r.task && r.task.ok) loadTasks(true); await loadIssues(); done();
    });
    box.insertBefore(form, box.children[1] || null);
    try { title.focus(); } catch (e) {}
  }
  function render() {
    DLY = null; setWin(); renderWins(); renderCards();
    renderSummary(); renderChips(); paintFilters();
    var list = filtered(), v = $("#monView"), fa = doc.activeElement, fid = fa && v.contains(fa) ? fa.id : ""; clear(v);
    if (S.tab === "activity") v.appendChild(viewActivity());   // R184: the timeline shows even before any task exists (check-ins, e-mails)
    else if (!S.tasks.length) v.appendChild(empty("No tasks for this event yet. Give work out in Tasks & staff and it shows here live."));
    else if (S.tab === "checkin") v.appendChild(viewCheckin(list));
    else v.appendChild(byStep(list, S.tab === "work" ? viewWork : viewStaff));
    if (fid) { var ff = doc.getElementById(fid); if (ff) try { ff.focus({ preventScroll: true }); } catch (e) {} }   // a group heading keeps focus over the 30 s redraw
    renderFeed();
    try { if (BPStore.presence && BPStore.presence.paint) BPStore.presence.paint(v); } catch (e) {}
    if (S.drawer) {   // keep the open drawer fresh, unless its Remind menu is open
      var dt = S.tasks.filter(function (x) { return x.id === S.drawer; })[0], dr = $("#monDrawer"), ae = doc.activeElement;
      if (dt && !dr.querySelector(".mon-menu:not([hidden])")) { var had = ae && dr.contains(ae); fillDrawer(dt); if (had) try { $("#monDrawerX").focus(); } catch (e) {} }
    }
  }
  function setTab(tab) {
    // R250 / R251: People / Work / Check-in / Activity; an old saved By status / Leftover opens People (the status chips do that job)
    S.tab = /^(staff|work|checkin|activity)$/.test(tab) ? tab : "staff";
    Array.prototype.forEach.call(doc.querySelectorAll(".mon-tab"), function (b) {
      var on = b.getAttribute("data-tab") === S.tab; b.setAttribute("aria-selected", on ? "true" : "false"); b.tabIndex = on ? 0 : -1;
      if (on) $("#monView").setAttribute("aria-labelledby", b.id);
    });
    try { localStorage.setItem(LS_TAB, S.tab); } catch (e) {}
  }

  /* ---- data ---- */
  function todayIso() { var p = parts(new Date().toISOString()); return p ? p.day : new Date().toISOString().slice(0, 10); }
  function addDays(iso, n) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso); return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n, 12)).toISOString().slice(0, 10); }
  /* R255: which event comes first. The server lists them by their first task, so yesterday's event (with a late task) came before
     today's. Today, then tomorrow and on by date, then what is over (the newest first). Before 6 am yesterday's event is still the
     night that is running, so it stays first. pure: list [{ event_date }], today YYYY-MM-DD, hour 0-23 */
  function orderEvents(list, today, hour) {
    var y = prevDay(today);
    function rank(e) { var d = String((e && e.event_date) || "").slice(0, 10); if (!d) return 3; if (Number(hour) < 6 && d === y) return -1; return d === today ? 0 : d > today ? 1 : 2; }
    return (list || []).map(function (e, i) { return { e: e, i: i, r: rank(e), d: String((e && e.event_date) || "").slice(0, 10) }; }).sort(function (a, b) {
      return a.r - b.r || (a.r === 2 ? b.d.localeCompare(a.d) : a.d.localeCompare(b.d)) || a.i - b.i; }).map(function (x) { return x.e; });
  }
  // the event to open with no event in the address: the one opened last only while it is today's (or the next day's with nothing today)
  function firstEvent(list, saved, today, hour) {
    var l = orderEvents(list, today, hour), first = l[0]; if (!first) return "";
    var d = String(first.event_date || "").slice(0, 10), keep = saved === "all" ? (d === today && l.filter(function (e) { return e.is_today; }).length > 1) : l.some(function (e) { return e.quote_id === saved && String(e.event_date || "").slice(0, 10) === d; });
    return keep ? saved : first.quote_id;
  }
  function nowHour() { return (parts(new Date().toISOString()) || {}).hour; }
  async function loadEvents() {
    var soon = [], later = {}, seen = {};
    try { var r = await BPStore.ops.live.today(72); ((r && r.events) || []).forEach(function (e) { if (e && e.quote_id && !seen[e.quote_id]) { seen[e.quote_id] = 1; soon.push(e); } }); } catch (e) {}
    try {
      var t0 = todayIso(), rows = await BPStore.ops.crew.schedule(t0, addDays(t0, 30));
      (rows || []).forEach(function (x) { if (x && x.quote_id && !seen[x.quote_id] && !later[x.quote_id]) later[x.quote_id] = { quote_id: x.quote_id, code: x.event_code, title: x.event_title, event_date: x.event_date || x.sched_date }; });
    } catch (e) {}
    var rest = Object.keys(later).map(function (k) { return later[k]; }).sort(function (a, b) { return String(a.event_date).localeCompare(String(b.event_date)); });
    soon = orderEvents(soon, todayIso(), nowHour());
    S.events = orderEvents(soon.concat(rest), todayIso(), nowHour());
    S.evInfo = {}; S.events.forEach(function (e) { S.evInfo[e.quote_id] = e; });
    var sel = $("#monEvent"); clear(sel);
    var todays = soon.filter(function (e) { return e.is_today; });
    if (todays.length > 1) sel.appendChild(opt("all", "All events today (" + todays.length + ")"));
    function label(e) { return [e.code, e.title].filter(Boolean).join(" · ") + " - " + fmtDayIso(e.event_date) + (e.is_today ? " (today)" : ""); }
    var isOver = function (e) { var d = String(e.event_date || "").slice(0, 10); return !!d && d < t1 && !(nowHour() < 6 && d === prevDay(t1)); }, t1 = todayIso(), past = soon.filter(isOver), next = soon.filter(function (e) { return !isOver(e); });
    if (next.length) { var g1 = h("optgroup"); g1.label = "Today and the next 3 days"; next.forEach(function (e) { g1.appendChild(opt(e.quote_id, label(e))); }); sel.appendChild(g1); }
    if (rest.length) { var g2 = h("optgroup"); g2.label = "Later this month"; rest.forEach(function (e) { g2.appendChild(opt(e.quote_id, label(e))); }); sel.appendChild(g2); }
    if (past.length) { var g3 = h("optgroup"); g3.label = "Earlier, with open work"; past.forEach(function (e) { g3.appendChild(opt(e.quote_id, label(e))); }); sel.appendChild(g3); }
  }
  async function loadCrew() {
    try { var list = await BPStore.ops.listCrew(); S.crew = {}; (list || []).forEach(function (c) { if (c && c.id) S.crew[c.id] = c; }); } catch (e) { S.crew = {}; }
  }
  async function loadSheet(quoteIds) {
    S.sheet = {}; S.hasSheet = false;
    var T = BPStore.ops.shifts && BPStore.ops.shifts.timesheet; if (!T) return;
    await Promise.all(quoteIds.map(function (q) { return T(q).then(function (r) {
      if (r) S.hasSheet = true;   // null = no timesheet here: "checked in" is unknown, not nobody
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
  // R226 (0396): the event day plan (null before 0396 -> the cards stay hidden, Remind has no Bell)
  async function loadPlan(force) {
    var D = BPStore.ops && BPStore.ops.dayPlan, q = S.quote === "all" ? ((S.events.filter(function (e) { return e.is_today; })[0] || {}).quote_id) : S.quote;
    if (!D || !q) { S.plan = null; return; }
    if (!force && Date.now() - S.planAt < 60000 && S.planQ === S.quote) return;
    try { var r = await D.get(q); S.has396 = S.has396 || r != null; S.plan = S.quote === "all" ? null : r; } catch (e) { S.plan = null; }
    S.planAt = Date.now(); S.planQ = S.quote;
  }
  // R230 (0399): which departments I supervise on the shown events (read once a minute; nothing before 0399)
  async function loadMine(ids) {
    var D = BPStore.ops && BPStore.ops.deptSupervisors, key = ids.join(","); if (!D) { S.mine = {}; return; }
    if (S.mineKey === key && Date.now() - S.mineAt < 60000) return;
    var m = {};
    await Promise.all(ids.map(function (q) { return D.get(q).then(function (r) {
      var me = r && r.me; if (!me) return;
      var d = (r.rows || []).filter(function (x) { return x && String(x.profile_id) === String(me); }).map(function (x) { return x.department; });
      if (d.length) m[q] = d;
    }).catch(function () {}); }));
    S.mine = m; S.mineAt = Date.now(); S.mineKey = key;
  }
  // the run-sheet decides when the event day starts (same rule as Tasks & Crew); read once, then every 5 min, only with Run-sheet view
  async function loadRs() {
    if (!S.rsView || !BPStore.runsheet || !BPStore.runsheet.list || S.quote === "all" || !S.quote) { if (S.rsQ !== S.quote) S.rs = null; return; }
    if (S.rsQ === S.quote && Date.now() - S.rsAt < 300000) return;
    try { var r = await BPStore.runsheet.list(S.quote); S.rs = Array.isArray(r) ? r : []; } catch (e) { S.rs = null; }
    S.rsAt = Date.now(); S.rsQ = S.quote;
  }
  // proof photos of done tasks (re-read every 2 min; the links last 5 min and are signed again every 4)
  async function loadProof(ids) {
    var O = BPStore.ops; if (!O || !O.listEvidence || !O.evidenceUrls) return;
    var key = ids.join(","); if (S.proofKey === key && Date.now() - S.proofAt < 120000) return;
    try {
      var lists = await Promise.all(ids.map(function (q) { return O.listEvidence(q).catch(function () { return []; }); }));
      var m = {}, paths = [];
      [].concat.apply([], lists).forEach(function (r) { if (r && r.kind === "proof_photo" && r.storage_path && r.task_id) { (m[r.task_id] = m[r.task_id] || []).push(r.storage_path); paths.push(r.storage_path); } });
      S.proof = m; paths = paths.slice(-40);
      var urls = paths.length ? await O.evidenceUrls(paths, 300) : {};
      S.proofUrl = urls || {}; S.proofAt = Date.now(); S.proofKey = key;
    } catch (e) { S.proof = {}; S.proofUrl = {}; }
  }
  async function loadTasks(silent) {
    if (S.loading || !S.quote) return; S.loading = true; var q0 = S.quote;
    if (!silent) $("#monView").setAttribute("aria-busy", "true");
    try {
      var ids = S.quote === "all" ? S.events.filter(function (e) { return e.is_today; }).map(function (e) { return e.quote_id; }) : [S.quote];
      if (TS.loadAuto) TS.loadAuto().then(function (ch) { if (ch && S.tasks.length) { render(); tick(); } });   // R254: steps picked by people or worked out (one small read a minute)
      var lists = await Promise.all(ids.map(function (q) { return BPStore.ops.listTasks(q).then(function (ts) {
        var code = S.quote === "all" ? ((S.evInfo[q] && S.evInfo[q].code) || "") : "";
        return (ts || []).map(function (t) { t.quote_id = t.quote_id || q; if (code) t._code = code; return t; }); }); }));
      if (S.quote !== q0) return;   // another event was picked meanwhile: never show (or hand on) the old event's tasks under its name
      S.tasks = [].concat.apply([], lists); S.same = undefined;
      await Promise.all([loadSheet(ids), loadOff(ids), loadActivity(ids), loadPlan(false), loadRs(), loadProof(ids), loadMine(ids), readQuote(S.quote, false)]);
      if (S.quote !== q0) return;
      setWin(); await loadIssues(); if (S.quote !== q0) return;
      S.lastLoad = Date.now(); $("#monErr").hidden = true;
      fillFilters(); render(); tick();
    } catch (e) {
      var er = $("#monErr"); er.hidden = false;
      er.textContent = (window.BPUI && BPUI.friendlyError) ? BPUI.friendlyError(e, { action: "load the event's tasks" }) : "Could not load the tasks. Check your connection and press Refresh.";
      return false;   // R235: tells the 30 s refresher to wait longer before the next try
    } finally { S.loading = false; $("#monView").removeAttribute("aria-busy"); if (S.quote !== q0) { S.tasks = []; loadTasks(false); } }
  }
  /* R194: the header band - code (the badge beside it = renderPill, R251), the event name as the switcher, date · venue · guests, and the
     time tiles (Guests arrive + the countdown: "Event in 9 days", on the day a live clock) */
  function headFor() {
    var e = S.quote === "all" ? null : S.evInfo[S.quote];
    if (S.quote === "all") {
      $("#monCode").textContent = "Today"; $("#monTitle").textContent = "All events today";
      $("#monSub").textContent = S.events.filter(function (x) { return x.is_today; }).map(function (x) { return [x.code, x.title].filter(Boolean).join(" · "); }).join("  |  ");
      $("#monOpenOps").hidden = true; renderTimes(null); return;
    }
    $("#monOpenOps").hidden = false; $("#monOpenOps").setAttribute("href", "ops.html?quote=" + encodeURIComponent(S.quote));
    backTo(S.quote);
    if (!e) { $("#monCode").textContent = ""; $("#monTitle").textContent = "Event"; $("#monSub").textContent = ""; renderTimes(null); return; }
    $("#monCode").textContent = e.code || "";
    $("#monTitle").textContent = e.title || e.code || "Event";
    $("#monSub").textContent = [e.event_date ? fmtDayIso(e.event_date, true) : "No event date yet", e.venue, e.guests ? e.guests + " guests" : ""].filter(Boolean).join(" · ");
    renderTimes(e);
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
    if (e && e.event_time) tile("Guests arrive", guestWord(e.event_time), "key");
    var cd = S.quote === "all" ? ["Now", fmtClock(new Date().toISOString())] : countdown(e);
    tile(cd[0], cd[1], "count", "monClock");
    dl.setAttribute("data-live", cd[0] === "Now" ? "1" : "");
  }
  // the venue, guests, time and the lifecycle stage come from the quote (not in the live list): read when the event is picked, again
  // every 2 min (someone may have moved the stage) and at once after a step changed here (force)
  async function readQuote(q, force) {
    var e = S.evInfo[q]; if (!e || q === "all" || !BPStore.quotes || !BPStore.quotes.get) return;
    if (!force && e._readAt && Date.now() - e._readAt < 120000) return;
    e._readAt = Date.now();
    try {
      var x = await BPStore.quotes.get(q); if (!x) return;
      var c = x.client || {};
      e.code = x.code || e.code; e.title = x.title || e.title; e.event_date = x.eventDate || x.event_date || e.event_date;
      e.event_time = x.eventTime || x.event_time || e.event_time; e.event_type = x.eventType || x.event_type || e.event_type || ""; e.venue = e.venue || x.venue || c.venue || "";
      e.guests = x.guests || (x.pricing && x.pricing.guests) || c.guests || "";
      e.stage = x.lifecycleStage || x.lifecycle_stage || ""; e.status = x.status || ""; e._read = true;
      if (S.quote === q) headFor();
    } catch (err) { e._tried = true; }   // may not read the quote: Wrap-up still shows its links (the server checks every step)
  }
  async function choose(q, push) {
    S.quote = q; $("#monPill").hidden = true; headFor(); S.issOpen = false;
    if (q !== "all" && S.evInfo[q]) S.evInfo[q]._readAt = 0;   // picked again: read the stage afresh
    try { localStorage.setItem(LS_KEY, q); } catch (e) {}
    if (push) { try { var u = new URL(location.href); u.searchParams.set("quote", q); history.replaceState(null, "", u.pathname + u.search); } catch (e) {} }
    S.tasks = []; await loadTasks(false);
  }
  function tick() {
    var mn = Math.floor(Date.now() / 60000); if (S.lastLoad && !doc.hidden && mn !== S.dlyMin) { S.dlyMin = mn; DLY = null; renderDelay(); renderPreCheck(); }   // R252: the delay card's minutes + the pre-event check
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
  // another step: draw it, then fetch what only these show (the issues: Pre-event and On the event)
  async function goStep() { render(); if (issStep() && S.issQ !== S.quote) { await loadIssues(); renderIssues(); } }
  function wire() {
    $("#monEvent").addEventListener("change", function () { choose(this.value, true); });
    $("#monRefresh").addEventListener("click", function () { loadTasks(false); });
    ["#monQ", "#monWho", "#monSec", "#monSort"].forEach(function (s) { $(s).addEventListener(s === "#monQ" ? "input" : "change", render); });
    $("#monClear").addEventListener("click", function () { $("#monQ").value = ""; $("#monWho").value = ""; $("#monSec").value = ""; S.st = ""; $("#monSort").value = "time"; render(); });
    // R250: the status chips filter the list in place (tap again = all)
    $("#monChips").addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("[data-st]"); if (!b) return;
      var k = b.getAttribute("data-st") || ""; S.st = S.st === k ? "" : k; render();
      var nb = $("#monChips").querySelector('[data-st="' + (S.st || "") + '"]') || $("#monChips").querySelector("[data-st]"); if (nb) try { nb.focus(); } catch (x) {}
    });
    // R194: phone - the four menus fold behind one Filters button
    $("#monFiltersBtn").addEventListener("click", function () {
      var tools = $("#monTools"), open = !tools.classList.contains("is-open");
      tools.classList.toggle("is-open", open); this.setAttribute("aria-expanded", open ? "true" : "false");
    });
    $("#monFeedAll").addEventListener("click", openActivity);
    // R226 / R251: the steps (a tap only looks at a step) + the task drawer
    Array.prototype.forEach.call(doc.querySelectorAll("#monWins [data-win]"), function (b) { b.addEventListener("click", function () {
      var w = TS.normWin(b.getAttribute("data-win")); S.manualWin = w === TS.stepOf(S.autoWin) ? null : w;
      goStep(); }); });
    $("#monDrawerX").addEventListener("click", closeDrawer);
    $("#monScrim").addEventListener("click", closeDrawer);
    doc.addEventListener("keydown", drawerKeys);
    $("#monWall").addEventListener("click", function () { var on = !doc.body.classList.contains("mon-wall"); setWall(on, true); var x = on && $("#monWallX"); if (x) try { x.focus(); } catch (e) {} });
    $("#monWallX").addEventListener("click", function () { setWall(false, true); try { $("#monWall").focus(); } catch (e) {} });
    doc.addEventListener("keydown", wallKeys);
    // the browser's own way out of full screen (Esc) takes the big text off too - it used to stay, and to come back next time
    doc.addEventListener("fullscreenchange", function () { if (doc.fullscreenElement) S.wallFull = doc.body.classList.contains("mon-wall"); else if (S.wallFull) { S.wallFull = false; if (doc.body.classList.contains("mon-wall")) setWall(false, false); } });
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
  // R255: "Back to event" in the header and on the wall bar (the event workspace; "all events" goes to the calendar of today)
  function backTo(q) {
    var href = q && q !== "all" ? "event.html?id=" + encodeURIComponent(q) : "calendar.html?cv=live"; try { if (window.HelmUrl && HelmUrl.upgrade) href = HelmUrl.upgrade(href); } catch (e) {}
    ["#monBack", "#monWallBack"].forEach(function (s) { var a = $(s); if (!a) return; a.setAttribute("href", href); a.hidden = false; a.textContent = q === "all" ? "Back to calendar" : "Back to event"; });
  }
  // Esc leaves the wall screen when nothing else is open (the task drawer, a dialog or a list closes first)
  function wallKeys(e) {
    if (e.key !== "Escape" || e.defaultPrevented || !doc.body.classList.contains("mon-wall") || S.drawer || doc.fullscreenElement) return;
    if (doc.querySelector(".bpui-overlay,[role=dialog]:not([hidden]):not(#monDrawer)")) return;
    var t = e.target || {}; if (/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName || "")) return;
    setWall(false, true);
  }
  /* R194: wall-screen mode - bigger text, filters out of the way; full screen when the browser allows it (the button press
     is the user gesture). R255 (owner: "I feel this page is too zoomed in", "took time to figure out" how to leave): its own bar is
     always on top with "Exit full screen" and "Back to event"; Esc / leaving full screen also leaves it, and it is remembered only
     in this tab (a TV that reloads) - opening the page again starts at the normal size. */
  function setWall(on, ask) {
    doc.body.classList.toggle("mon-wall", !!on); if (S.lastLoad) renderPreCheck();
    var b = $("#monWall"); if (b) { b.setAttribute("aria-pressed", on ? "true" : "false"); b.textContent = on ? "Exit full screen" : "Wall screen"; }
    var bar = $("#monWallBar"); if (bar) bar.hidden = !on;
    try { if (on) sessionStorage.setItem(LS_WALL, "1"); else sessionStorage.removeItem(LS_WALL); localStorage.removeItem(LS_WALL); } catch (e) {}
    if (ask) {
      try {
        if (on && doc.documentElement.requestFullscreen && !doc.fullscreenElement) doc.documentElement.requestFullscreen().catch(function () {});
        else if (!on && doc.fullscreenElement && doc.exitFullscreen) doc.exitFullscreen().catch(function () {});
      } catch (e) {}
    }
  }
  async function start() {
    await BPStore.init(); await renderAccount();
    try { await BPStore.bell.mount($("#bell")); } catch (e) {}
    var A = BPStore.auth;
    if (A.enabled() && A.required() && !A.user()) { location.replace("login.html?next=" + encodeURIComponent(location.pathname + location.search)); return; }
    if (!(await A.requireView("staff"))) { $("#monBoot").hidden = true; return; }
    // R208 (0385): Nudge = "Assign & send tasks" (no row for the role = Staff - Can change, as before)
    try { S.canEdit = !!(await (A.canAssignTasks ? A.canAssignTasks() : A.canEditArea("staff"))); } catch (e) { S.canEdit = false; }
    try { S.rsView = !!(await A.canView("runsheet")); } catch (e) { S.rsView = false; }
    try { S.issView = !!(await A.canView("issues")); S.issEdit = S.issView && !!(await A.canEditArea("issues")); } catch (e) { S.issEdit = false; }
    try { S.admin = (await A.role()) === "admin"; } catch (e) { S.admin = false; }
    await Promise.all([loadEvents(), loadCrew()]);
    $("#monBoot").hidden = true; $("#monApp").hidden = false;
    var want = null; try { want = new URLSearchParams(location.search).get("quote"); } catch (e) {}
    try { if (!want && window.HelmUrl && HelmUrl.get) want = await HelmUrl.get("quote", null); } catch (e) {}
    var saved = null; try { saved = localStorage.getItem(LS_KEY); } catch (e) {}
    var tabSaved = null; try { tabSaved = localStorage.getItem(LS_TAB); } catch (e) {}
    setTab(tabSaved || "staff");
    try { localStorage.removeItem(LS_SIZE); } catch (e) {}   // R258 (owner: no A- / A+): a size saved by the old buttons is forgotten
    var wallSaved = null; try { wallSaved = sessionStorage.getItem(LS_WALL); localStorage.removeItem(LS_WALL); } catch (e) {}
    if (wallSaved === "1") setWall(true, false);
    var sel = $("#monEvent");
    var pick = (want && (want === "all" || UUID.test(want))) ? want : firstEvent(S.events, saved, todayIso(), nowHour());
    if (want && UUID.test(want) && !S.evInfo[want]) { sel.insertBefore(opt(want, "This event"), sel.firstChild); S.evInfo[want] = { quote_id: want }; }
    if (!pick) { $("#monView").appendChild(empty("No events with work today or this month. Give out tasks in an event's Tasks & staff page.")); $("#monSummary").hidden = true; $("#monWins").hidden = true; return; }
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
    _orderEvents: orderEvents, _firstEvent: firstEvent, _setWall: setWall, _countdown: countdown, _stepO: stepO, _setWin: setWin, _lateWords: lateWords, _todayIso: todayIso, _openDrawer: openDrawer, _closeDrawer: closeDrawer };
})();
