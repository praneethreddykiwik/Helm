/* task-status.js - R192: ONE status vocabulary + ONE late / escalation / check-in calculation, shared by the Tasks & Crew
 * page (ops.html + ops-board.js) and the Event-day monitor (monitor.js), so the same task never has two names or two
 * "late" answers on two pages (plan section 5).
 *
 *   HelmTaskStatus.LABEL                  key -> words: Not assigned / Not accepted yet / Accepted / Started / Done / Turned down / Late
 *   HelmTaskStatus.stateOf(t, now)        { key, late, label }  key: unassigned | waiting | accepted | started | done | rejected | cancelled
 *   HelmTaskStatus.shown(t, now)          the one word to show (late wins over waiting / accepted)
 *   HelmTaskStatus.isLate(t, now)         start time passed, not started (waiting or accepted)
 *   HelmTaskStatus.lateMin(t, now)        how many minutes late (0 when not late)
 *   HelmTaskStatus.summarize(tasks, now)  counts for headers / progress bars (cancelled left out)
 *   HelmTaskStatus.leftover(tasks, now)   not done yet: late first, then by start time
 *   HelmTaskStatus.ladder(cfg)            the escalation steps as words (R186 / 0369): Worker, Event lead, Manager +5 min, Admin +10 min
 *   HelmTaskStatus.lastEscalation(t, acts) the latest "escalated" activity row for the task's current start time
 *   HelmTaskStatus.escStep(t, acts, cfg, now) 0..3 = where the ladder is now (recorded step, else what the clock says), -1 = none
 *   HelmTaskStatus.escLevel(level) / escBadge(row, clockFn)
 *   HelmTaskStatus.actText(row, fmtWhen) / actGroup(kind)  activity wording (0368), the monitor feed and the "Latest" column
 *   HelmTaskStatus.attendance(entry, firstStartMs) { state: in|out|none, late, lateMin }  (entry from event_timesheet, 0265)
 *   HelmTaskStatus.ymdIn(tz, date)        the studio's calendar day ("YYYY-MM-DD") in organizations.timezone, never the device's
 *   HelmTaskStatus.phase(o)               "plan" (before the event) | "live" (on the day), from the studio clock (R192, kept)
 *   HelmTaskStatus.opsMode(o)             R222: the mode + WHY (EVENT-OPS-PLAN.md section 2): { mode: plan|live, step, from, to }
 *                                         step: cancelled | done | nodate | before | soon | on | over (studio clock, run-sheet,
 *                                         tasks, Guests arrive and the lifecycle stage)
 *   HelmTaskStatus.opsWindow(m, o)        R251: daybefore | pre | onday | wrapup (WINDOWS words, WIN_PHASE -> plan | live)
 *   HelmTaskStatus.STEPS / stepOf(w) / normWin(v)   the three step tabs; Wrap-up is a closed section, not a tab
 *   HelmTaskStatus.taskStep(t, o) / bySteps(tasks, o)   which step a task belongs to, and the tasks per step with counts
 *   HelmTaskStatus.refresher(fn, ms)      ONE refresh clock: every ms (30 s) while the tab is visible + at once on return
 * Pure (no DOM) except refresher (document.hidden / visibilitychange). Unit-tested in test/r192-tasks-crew.test.mjs. */
(function (global) {
  "use strict";
  var LABEL = { unassigned: "Not assigned", waiting: "Not accepted yet", accepted: "Accepted", started: "Started", done: "Done",
    rejected: "Turned down", cancelled: "Cancelled", late: "Late" };
  var RANK = { unassigned: 0, waiting: 1, accepted: 2, started: 3, rejected: 4, done: 5, cancelled: 6 };

  function ms(v) { if (v == null || v === "") return NaN; var t = typeof v === "number" ? v : new Date(v).getTime(); return isFinite(t) ? t : NaN; }
  function hasPerson(t) { return !!(t && (t.crew_id || String(t.assignee_name || "").trim() || t.vendor_id)); }
  function baseKey(t) {
    var s = String((t && t.status) || "");
    if (s === "completed") return "done";
    if (s === "in_progress") return "started";
    if (s === "accepted") return "accepted";
    if (s === "rejected") return "rejected";
    if (s === "cancelled") return "cancelled";
    // r20: a row saved as "unassigned" that already names someone reads "Not accepted yet" (the row is never rewritten)
    return (s === "assigned" || s === "unassigned") && hasPerson(t) ? "waiting" : "unassigned";
  }
  function isLate(t, now) {
    var k = baseKey(t); if (k !== "waiting" && k !== "accepted") return false;
    var ps = ms(t.planned_start); return isFinite(ps) && ps < (now == null ? Date.now() : now);
  }
  function lateMin(t, now) { if (!isLate(t, now)) return 0; return Math.max(1, Math.round(((now == null ? Date.now() : now) - ms(t.planned_start)) / 60000)); }
  function stateOf(t, now) { var k = baseKey(t); return { key: k, late: isLate(t, now), label: LABEL[k] }; }
  function shown(t, now) { return isLate(t, now) ? "late" : baseKey(t); }
  function personKey(t) { return t.crew_id ? "c:" + t.crew_id : (t.assignee_name ? "n:" + String(t.assignee_name).toLowerCase() : ""); }

  function summarize(tasks, now) {
    now = now == null ? Date.now() : now;
    var o = { total: 0, done: 0, started: 0, accepted: 0, waiting: 0, rejected: 0, unassigned: 0, late: 0, people: 0, confirmed: 0, next: null, firstLate: null };
    var ppl = {}, conf = {};
    (tasks || []).forEach(function (t) {
      if (!t || t.status === "cancelled") return;
      var s = stateOf(t, now); o.total++; o[s.key]++;
      if (s.late) { o.late++; if (!o.firstLate || ms(t.planned_start) < ms(o.firstLate.planned_start)) o.firstLate = t; }
      var k = personKey(t);
      if (k) { ppl[k] = 1; if (s.key === "accepted" || s.key === "started" || s.key === "done") conf[k] = 1; }
      var ps = ms(t.planned_start);
      if ((s.key === "waiting" || s.key === "accepted") && isFinite(ps) && ps >= now && (!o.next || ps < ms(o.next.planned_start))) o.next = t;
    });
    o.people = Object.keys(ppl).length; o.confirmed = Object.keys(conf).length;
    o.pct = o.total ? Math.round(o.done * 100 / o.total) : 0;
    return o;
  }
  function leftover(tasks, now) {
    now = now == null ? Date.now() : now;
    return (tasks || []).filter(function (t) { return t && t.status !== "cancelled" && t.status !== "completed"; })
      .map(function (t) { return { t: t, l: isLate(t, now) }; })
      .sort(function (a, b) {
        if (a.l !== b.l) return a.l ? -1 : 1;
        var pa = ms(a.t.planned_start), pb = ms(b.t.planned_start); pa = isFinite(pa) ? pa : Infinity; pb = isFinite(pb) ? pb : Infinity;
        if (pa !== pb) return pa - pb;
        return String(a.t.title || "").localeCompare(String(b.t.title || ""));
      }).map(function (x) { return x.t; });
  }

  /* ---- R186 (0369) escalation ladder for special tasks not started ---- */
  function steps(cfg) { var s = cfg && Array.isArray(cfg.steps) && cfg.steps.length === 3 ? cfg.steps.map(Number) : [0, 5, 10]; return s.every(isFinite) ? s : [0, 5, 10]; }
  function plus(m) { return m > 0 ? " +" + m + " min" : ""; }
  function ladder(cfg) { var s = steps(cfg); return ["Worker", "Event lead" + plus(s[0]), "Manager" + plus(s[1]), "Admin" + plus(s[2])]; }
  // R232 (0400): the first step is "lead" (older rows say the old name) - every other value reads as the event lead
  function escLevel(l) { return l === "admin" ? "admin / owner" : l === "manager" ? "manager" : "event lead"; }
  function lastEscalation(t, acts) {
    if (!t || !t.id) return null;
    var ps = ms(t.planned_start), best = null;
    (acts || []).forEach(function (a) {
      if (!a || a.kind !== "escalated" || a.task_id !== t.id) return;
      var rs = a.detail && a.detail.ref_start ? ms(a.detail.ref_start) : NaN;
      if (isFinite(ps) && isFinite(rs) && rs !== ps) return;   // an older start time: not this ladder
      if (!best || ms(a.at) > ms(best.at)) best = a;
    });
    return best;
  }
  function escBadge(a, clock) { return a ? "Escalated to " + escLevel(a.detail && a.detail.level) + (clock ? " " + clock(a.at) : "") : ""; }
  // 0 = the worker has been reminded, 1 = event lead told, 2 = manager, 3 = admin / owner; -1 = not special / not late / ladder off
  function escStep(t, acts, cfg, now) {
    if (!t || !t.is_special || !isLate(t, now) || (cfg && cfg.enabled === false)) return -1;
    var a = lastEscalation(t, acts), rec = a ? ({ manager: 2, admin: 3 })[(a.detail && a.detail.level) || "lead"] || 1 : 0;
    if (acts && acts.length) return Math.max(rec, 0);   // the timeline is there: show what really happened
    var s = steps(cfg), m = ((now == null ? Date.now() : now) - ms(t.planned_start)) / 60000, by = 0;
    if (m >= s[0]) by = 1; if (m >= s[1]) by = 2; if (m >= s[2]) by = 3;
    return Math.max(rec, by);
  }


  /* ---- R184 activity wording (0368 timeline rows), shared so the monitor feed and the "Latest" column read the same ---- */
  function actGroup(k) {
    return k === "assigned" || k === "reassigned" || k === "unassigned" ? "work" : k === "accepted" || k === "rejected" ? "reply"
      : k === "started" || k === "completed" || k === "reopened" ? "progress" : k === "time_changed" ? "time"
      : k === "check_in" || k === "check_out" || k === "check_edit" ? "checkin" : k === "email_sent" ? "email" : k === "escalated" ? "escalation"
      : k === "dayoff_asked" || k === "dayoff_approved" ? "dayoff" : "special";
  }
  function emailWhat(k) {
    return k === "task_reminder" ? "Reminder e-mail" : k === "task_late" ? "“Not started yet” e-mail" : k === "task_update" ? "“Your tasks were updated” e-mail"
      : k === "office_alert" ? "Office alert e-mail" : k === "task_escalation" ? "Escalation e-mail" : "Task e-mail";
  }
  function actText(a, when) {
    when = when || function (x) { return String(x || ""); };
    var who = a.name || "Someone", task = a.title ? "“" + a.title + "”" : "a task", d = a.detail || {};
    switch (a.kind) {
      case "assigned": return task + " given to " + (d.to || a.name || "someone");
      case "reassigned": return task + " moved from " + (d.from || "someone") + " to " + (d.to || a.name || "someone");
      case "unassigned": return task + " no longer has anyone on it";
      case "time_changed": return task + ": start time " + (d.from ? when(d.from) : "not set") + " → " + (d.to ? when(d.to) : "not set");
      case "special_on": return task + " marked special (extra reminders)";
      case "special_off": return task + " is no longer special";
      case "accepted": return who + " accepted " + task;
      case "rejected": return who + " turned down " + task;
      case "started": return who + " started " + task;
      case "completed": return who + " finished " + task;
      case "cancelled": return task + " was cancelled" + (d.reason ? " (" + d.reason + ")" : "");
      case "reopened": return task + " was reopened";
      case "check_in": return who + " checked in" + ((+d.late_min || 0) > 0 ? " · " + d.late_min + " min late" : "") + (d.within === false ? " · away from the venue" : "");
      case "check_out": return who + " checked out";
      case "check_edit": return "Office corrected " + who + "’s check-in times" + (d.note ? " (" + d.note + ")" : "");
      case "email_sent": return emailWhat(d.email_kind) + " sent to " + who + (a.title ? " — " + a.title : "");
      case "escalated": return task + " not started - escalated to " + escLevel(d.level) + (Array.isArray(d.to) && d.to.length ? " (" + d.to.slice(0, 6).join(", ") + (d.to.length > 6 ? " +" + (d.to.length - 6) : "") + ")" : "");
      // R187 (0370): a day off on the event day - asked for on the staff link / approved by the office
      case "dayoff_asked": return who + " asked for the event day off" + (d.note ? " (" + d.note + ")" : "") + (d.pending ? " - waiting for approval" : "");
      case "dayoff_approved": return "Day off approved for " + who + (d.by ? " by " + d.by : "");
      default: return who + ": " + String(a.kind || "update");
    }
  }

  /* ---- R184 attendance (check-in / check-out) ---- */
  function attendance(e, firstStart) {
    if (!e || !e.in) return { state: "none", late: false, lateMin: 0 };
    var inAt = ms(e.inAt), late = (e.late_min || 0) > 0 || (isFinite(firstStart) && isFinite(inAt) && inAt > firstStart + 60000);
    var lm = e.late_min || (isFinite(firstStart) && isFinite(inAt) ? Math.round((inAt - firstStart) / 60000) : 0);
    return { state: e.out ? "out" : "in", late: late, lateMin: late ? Math.max(1, lm) : 0 };
  }

  /* ---- the studio's clock (organizations.timezone via BPStore.studioTimezone), never the device zone ---- */
  function ymdIn(tz, date) {
    var d = date instanceof Date ? date : new Date(date == null ? Date.now() : date);
    try {
      var f = new Intl.DateTimeFormat("en-GB", { timeZone: tz || "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }), o = {};
      f.formatToParts(d).forEach(function (p) { o[p.type] = p.value; });
      return o.year + "-" + o.month + "-" + o.day;
    } catch (e) { return d.toISOString().slice(0, 10); }
  }
  function dayDiff(a, b) { var x = Date.parse(a + "T00:00:00Z"), y = Date.parse(b + "T00:00:00Z"); return isFinite(x) && isFinite(y) ? Math.round((y - x) / 86400000) : NaN; }
  /* "live" on the event day (studio calendar), and while tasks are running around it (set-up the evening before that has
     started, a strike after midnight). Otherwise "plan". o: { eventDate, tasks, now, tz } */
  function phase(o) {
    o = o || {}; var now = o.now == null ? Date.now() : o.now, today = ymdIn(o.tz, now), ev = String(o.eventDate || "").slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(ev) && today === ev) return "live";
    var lo = Infinity, hi = -Infinity;
    (o.tasks || []).forEach(function (t) { if (!t || t.status === "cancelled") return; var s = ms(t.planned_start); if (!isFinite(s)) return; var e = ms(t.planned_end); if (!isFinite(e) || e < s) e = s + 3600000; if (s < lo) lo = s; if (e > hi) hi = e; });
    if (isFinite(lo) && now >= lo - 2 * 3600000 && now <= hi + 6 * 3600000) return "live";
    return "plan";
  }

  /* ---- R222: which mode, and why (EVENT-OPS-PLAN.md section 2) ----
     o: { eventDate "YYYY-MM-DD", eventTime "19:00" | "7:00 PM", stage (lifecycle_stage), status, tasks, runsheet, now, tz }
     On the day starts LEAD (1 h) before the earliest of: the first run-sheet item, the first task ON the event day,
     Guests arrive - else at midnight of the event day. It ends at the later of: the end of the event day, or 6 h after the
     last run-sheet item / task end on the event day or the night after (before 6 AM). The stage Event Day = on the day;
     Settlement / Closed = done (wrap-up); cancelled = plan. Set-up work the day before stays "before". */
  var LEAD_MS = 3600000, AFTER_MS = 6 * 3600000;
  function hmMin(v) {
    var m = /^\s*(\d{1,2})[:.](\d{2})(?::\d{2})?\s*([AaPp][Mm])?/.exec(String(v == null ? "" : v)); if (!m) return NaN;
    var hh = +m[1], mi = +m[2]; if (m[3]) { var pm = /p/i.test(m[3]); if (hh === 12) hh = pm ? 12 : 0; else if (pm) hh += 12; }
    return hh < 24 && mi < 60 ? hh * 60 + mi : NaN;
  }
  // the zone's offset (ms) at instant t: wall clock read as UTC minus the instant
  function zoneOff(tz, t) {
    try {
      var f = new Intl.DateTimeFormat("en-GB", { timeZone: tz || "Asia/Kolkata", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }), o = {};
      f.formatToParts(new Date(t)).forEach(function (p) { o[p.type] = p.value; });
      return Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour % 24, +o.minute, +o.second) - Math.floor(t / 1000) * 1000;
    } catch (e) { return 0; }
  }
  // the instant of a wall clock (ymd + minutes) in tz (two passes = DST-safe enough for a start-of-day rule)
  function wallMs(ymd, min, tz) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || "")); if (!m) return NaN;
    var guess = Date.UTC(+m[1], +m[2] - 1, +m[3], 0, min || 0), t = guess - zoneOff(tz, guess);
    return guess - zoneOff(tz, t);
  }
  function opsMode(o) {
    o = o || {}; var now = o.now == null ? Date.now() : o.now, tz = o.tz, ev = String(o.eventDate || "").slice(0, 10), stage = String(o.stage || "");
    if (String(o.status || "") === "cancelled") return { mode: "plan", step: "cancelled", from: null, to: null };
    if (stage === "settlement" || stage === "closed") return { mode: "live", step: "done", from: null, to: null };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ev)) return { mode: "plan", step: "nodate", from: null, to: null };
    var day0 = wallMs(ev, 0, tz), next = ymdIn(tz, day0 + 36 * 3600000), day1 = wallMs(next, 0, tz);
    var starts = [], ends = [];
    (o.runsheet || []).forEach(function (r) {
      var mn = hmMin(r && r.start_time); if (!isFinite(mn)) return; var s = wallMs(ev, mn, tz); starts.push(s);
      var d = Number(r.duration_min); ends.push(s + (isFinite(d) && d > 0 ? d * 60000 : 0));
    });
    (o.tasks || []).forEach(function (t) {
      if (!t || t.status === "cancelled") return; var s = ms(t.planned_start); if (!isFinite(s)) return;
      var e = ms(t.planned_end); if (!isFinite(e) || e < s) e = s + 3600000;
      if (s >= day0 && s < day1) { starts.push(s); ends.push(e); }
      else if (s >= day1 && s < day1 + 6 * 3600000) ends.push(e);          // strike after midnight: keeps the day open
    });
    var g = hmMin(o.eventTime); if (isFinite(g)) { var gs = wallMs(ev, g, tz); starts.push(gs); ends.push(gs); }
    var from = starts.length ? Math.min.apply(null, starts) - LEAD_MS : day0;
    var to = ends.length ? Math.max(day1, Math.max.apply(null, ends) + AFTER_MS) : day1;
    if (stage === "event_day" && now >= day0 && now < from) from = day0;   // the stage was moved to Event Day by hand
    var r = { mode: "plan", step: "before", from: from, to: to };
    if (now < from) { r.step = ymdIn(tz, now) === ev ? "soon" : "before"; return r; }
    r.mode = "live"; r.step = now <= to ? "on" : "over"; return r;
  }

  /* ---- R251 (owner 24 Nov): the steps BOTH pages show, in this order - Day before / Pre-event / On the event - and Wrap-up, which
     is no step but a closed section at the bottom of the page (HelmEventWrap). Same keys everywhere:
       daybefore  any time up to the event day (also: no date, cancelled)
       pre        the event day until "Pre-event complete" = the quote workflow's stage moves to Event Day (no second switch), or
                  Guests arrive has passed (nobody pressed it - the page must not sit on set-up while guests are in)
       onday      the event itself, until the day is over
       wrapup     over by the clock, or the stage is Settlement / Closed
     o: { eventDate, eventTime (Guests arrive), stage (lifecycle_stage), now, tz }. WIN_PHASE -> the R222 plan | live switch. */
  var WINDOWS = [["daybefore", "Day before"], ["pre", "Pre-event"], ["onday", "On the event"], ["wrapup", "Wrap-up"]];
  var STEPS = WINDOWS.slice(0, 3);
  var WIN_PHASE = { daybefore: "plan", pre: "live", onday: "live", wrapup: "live" };
  function guestsMs(ev, time, tz) { var g = hmMin(time); return isFinite(g) ? wallMs(ev, g, tz) : NaN; }
  function opsWindow(m, o) {
    o = o || {}; if (!m) return "daybefore";
    if (m.step === "done" || m.step === "over") return "wrapup";
    if (m.step !== "on" && m.step !== "before" && m.step !== "soon") return "daybefore";
    var ev = String(o.eventDate || "").slice(0, 10), now = o.now == null ? Date.now() : o.now;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ev)) return "daybefore";
    if (m.step === "on") {
      var g = guestsMs(ev, o.eventTime, o.tz);
      return String(o.stage || "") === "event_day" || (isFinite(g) && now >= g) ? "onday" : "pre";
    }
    return dayDiff(ymdIn(o.tz, now), ev) === 0 ? "pre" : "daybefore";
  }
  // the step tab that shows for a window (Wrap-up has no tab: On the event stays open above it)
  function stepOf(w) { return w === "wrapup" ? "onday" : w; }
  // a hand pick kept in the tab: the old names (R222 plan / live, R226 before / wrapup) still land on the right step; else null
  function normWin(v) {
    v = v === "plan" || v === "before" ? "daybefore" : v === "live" || v === "wrapup" ? "onday" : v;
    return STEPS.some(function (x) { return x[0] === v; }) ? v : null;
  }
  function winOk(w) { return normWin(w) === w && w != null; }
  /* R251: which step a task belongs to (no new column - read from its time, else its words). o: { eventDate, eventTime, tz }
       timed    before the event day -> daybefore; on the day before Guests arrive -> pre; after -> onday, and clearing-up work after
                Guests arrive, or anything from 6 AM the next day -> wrapup
       no time  clearing-up words -> wrapup; work done while guests are in -> onday; everything else is set-up -> pre */
  var WRAP_RE = /\b(tear ?down|dismantl\w*|strike|strik(?:e|ing) down|pack(?:ing)?[ -]?(?:up|down)|pack and load|load[ -]?out|clear(?:ing)?[ -]?(?:up|out)|clean[ -]?up|wrap[ -]?up|returns?|return stock|handover|hand over|settle\w*)\b/i;
  var LIVE_RE = /\b(service|serving|buffet|refill|host(?:ess)?|mc|emcee|anchor|usher\w*|valet|welcome drinks|guest (?:reception|assist\w*)|performance|photograph\w*|videograph\w*|live counter|entry)\b/i;
  function taskStep(t, o) {
    o = o || {}; if (!t) return "pre";
    var txt = String(t.category || "") + " " + String(t.title || ""), wrap = WRAP_RE.test(txt);
    var ev = String(o.eventDate || "").slice(0, 10), s = ms(t.planned_start);
    if (isFinite(s) && /^\d{4}-\d{2}-\d{2}$/.test(ev)) {
      var day0 = wallMs(ev, 0, o.tz), day1 = wallMs(ymdIn(o.tz, day0 + 36 * 3600000), 0, o.tz), g = guestsMs(ev, o.eventTime, o.tz);
      if (s < day0) return "daybefore";
      if (s >= day1 + 6 * 3600000) return "wrapup";
      if (isFinite(g) ? s < g : s < day1 && !wrap) return "pre";
      return wrap ? "wrapup" : "onday";
    }
    return wrap ? "wrapup" : LIVE_RE.test(txt) ? "onday" : "pre";
  }
  // tasks split by step, each with its own counts: { daybefore|pre|onday|wrapup: { tasks, open, done, total, unassigned } } (cancelled out)
  function bySteps(tasks, o) {
    var r = {}; WINDOWS.forEach(function (x) { r[x[0]] = { tasks: [], open: 0, done: 0, total: 0, unassigned: 0 }; });
    (tasks || []).forEach(function (t) {
      if (!t || t.status === "cancelled") return; var b = r[taskStep(t, o)], k = baseKey(t);
      b.tasks.push(t); b.total++; if (k === "done") b.done++; else b.open++; if (k === "unassigned" || k === "rejected") b.unassigned++;
    });
    return r;
  }

  /* ---- ONE refresh clock (30 s, both pages) ---- */
  /* R235 (prod: the wall screen asks ~8 reads per event every 30 s): it backs off when the database is struggling - after a
     failed refresh (fn throws or answers false) it waits 2x, 4x, 8x, 16x the normal time (max 8 min), after a slow one
     (> 5 s) 2x; the first good, quick refresh goes back to normal. Hidden tabs still never refresh; Refresh (now()) always runs. */
  function refresher(fn, every) {
    every = every || 30000; var last = Date.now(), busy = false, stopped = false, doc = global.document, wait = every, fails = 0;
    function run(force) {
      if (stopped || busy) return; if (doc && doc.hidden && !force) return;
      busy = true; last = Date.now(); var t0 = last;
      Promise.resolve().then(fn).then(function (r) { return r !== false; }, function () { return false; }).then(function (ok) {
        busy = false; var took = Date.now() - t0;
        fails = ok ? 0 : Math.min(fails + 1, 4);
        wait = fails ? Math.min(480000, every * Math.pow(2, fails)) : (took > 5000 ? every * 2 : every);
      });
    }
    var id = setInterval(function () { if (Date.now() - last >= wait) run(false); }, Math.min(5000, every));
    function onVis() { if (doc && !doc.hidden && Date.now() - last > Math.max(10000, fails ? wait : 0)) run(true); }
    if (doc && doc.addEventListener) doc.addEventListener("visibilitychange", onVis);
    return { now: function () { run(true); }, stop: function () { stopped = true; clearInterval(id); if (doc && doc.removeEventListener) doc.removeEventListener("visibilitychange", onVis); },
      last: function () { return last; }, wait: function () { return wait; } };
  }

  global.HelmTaskStatus = { LABEL: LABEL, RANK: RANK, stateOf: stateOf, shown: shown, isLate: isLate, lateMin: lateMin, baseKey: baseKey,
    personKey: personKey, summarize: summarize, leftover: leftover, ladder: ladder, escSteps: steps, escLevel: escLevel,
    lastEscalation: lastEscalation, escBadge: escBadge, escStep: escStep, attendance: attendance, ymdIn: ymdIn, dayDiff: dayDiff,
    phase: phase, opsMode: opsMode, opsWindow: opsWindow, WINDOWS: WINDOWS, STEPS: STEPS, WIN_PHASE: WIN_PHASE, winOk: winOk, normWin: normWin, stepOf: stepOf, taskStep: taskStep, bySteps: bySteps, hmMin: hmMin, wallMs: wallMs, refresher: refresher, actGroup: actGroup, actText: actText, emailWhat: emailWhat, REFRESH_MS: 30000 };
})(typeof window !== "undefined" ? window : globalThis);
