/* task-status.js - R192: ONE status vocabulary + ONE late / escalation / check-in calculation, shared by the Tasks & Crew
 * page (ops.html + ops-board.js) and the Event-day monitor (monitor.js), so the same task never has two names or two
 * "late" answers on two pages (plan section 5).
 *
 *   HelmTaskStatus.LABEL                  key -> words: No one yet / Waiting for a yes / Accepted / Started / Done / Turned down / Late
 *   HelmTaskStatus.stateOf(t, now)        { key, late, label }  key: unassigned | waiting | accepted | started | done | rejected | cancelled
 *   HelmTaskStatus.shown(t, now)          the one word to show (late wins over waiting / accepted)
 *   HelmTaskStatus.isLate(t, now)         start time passed, not started (waiting or accepted)
 *   HelmTaskStatus.lateMin(t, now)        how many minutes late (0 when not late)
 *   HelmTaskStatus.summarize(tasks, now)  counts for headers / progress bars (cancelled left out)
 *   HelmTaskStatus.leftover(tasks, now)   not done yet: late first, then by start time
 *   HelmTaskStatus.ladder(cfg)            the escalation steps as words (R186 / 0369): Worker, Coordinator, Manager +5 min, Admin +10 min
 *   HelmTaskStatus.lastEscalation(t, acts) the latest "escalated" activity row for the task's current start time
 *   HelmTaskStatus.escStep(t, acts, cfg, now) 0..3 = where the ladder is now (recorded step, else what the clock says), -1 = none
 *   HelmTaskStatus.escLevel(level) / escBadge(row, clockFn)
 *   HelmTaskStatus.actText(row, fmtWhen) / actGroup(kind)  activity wording (0368), the monitor feed and the "Latest" column
 *   HelmTaskStatus.attendance(entry, firstStartMs) { state: in|out|none, late, lateMin }  (entry from event_timesheet, 0265)
 *   HelmTaskStatus.ymdIn(tz, date)        the studio's calendar day ("YYYY-MM-DD") in organizations.timezone, never the device's
 *   HelmTaskStatus.phase(o)               "plan" (before the event) | "live" (on the day), from the studio clock
 *   HelmTaskStatus.refresher(fn, ms)      ONE refresh clock: every ms (30 s) while the tab is visible + at once on return
 * Pure (no DOM) except refresher (document.hidden / visibilitychange). Unit-tested in test/r192-tasks-crew.test.mjs. */
(function (global) {
  "use strict";
  var LABEL = { unassigned: "No one yet", waiting: "Waiting for a yes", accepted: "Accepted", started: "Started", done: "Done",
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
    // r20: a row saved as "unassigned" that already names someone reads "Waiting for a yes" (the row is never rewritten)
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
  function ladder(cfg) { var s = steps(cfg); return ["Worker", "Coordinator" + plus(s[0]), "Manager" + plus(s[1]), "Admin" + plus(s[2])]; }
  function escLevel(l) { return l === "admin" ? "admin / owner" : l === "manager" ? "manager" : "coordinator"; }
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
  // 0 = the worker has been reminded, 1 = coordinator told, 2 = manager, 3 = admin / owner; -1 = not special / not late / ladder off
  function escStep(t, acts, cfg, now) {
    if (!t || !t.is_special || !isLate(t, now) || (cfg && cfg.enabled === false)) return -1;
    var a = lastEscalation(t, acts), rec = a ? ({ coordinator: 1, manager: 2, admin: 3 })[(a.detail && a.detail.level) || "coordinator"] || 1 : 0;
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

  /* ---- ONE refresh clock (30 s, both pages) ---- */
  function refresher(fn, every) {
    every = every || 30000; var last = Date.now(), busy = false, stopped = false, doc = global.document;
    function run(force) {
      if (stopped || busy) return; if (doc && doc.hidden && !force) return;
      busy = true; last = Date.now();
      Promise.resolve().then(fn).catch(function () {}).then(function () { busy = false; });
    }
    var id = setInterval(function () { if (Date.now() - last >= every) run(false); }, Math.min(5000, every));
    function onVis() { if (doc && !doc.hidden && Date.now() - last > 10000) run(true); }
    if (doc && doc.addEventListener) doc.addEventListener("visibilitychange", onVis);
    return { now: function () { run(true); }, stop: function () { stopped = true; clearInterval(id); if (doc && doc.removeEventListener) doc.removeEventListener("visibilitychange", onVis); },
      last: function () { return last; } };
  }

  global.HelmTaskStatus = { LABEL: LABEL, RANK: RANK, stateOf: stateOf, shown: shown, isLate: isLate, lateMin: lateMin, baseKey: baseKey,
    personKey: personKey, summarize: summarize, leftover: leftover, ladder: ladder, escSteps: steps, escLevel: escLevel,
    lastEscalation: lastEscalation, escBadge: escBadge, escStep: escStep, attendance: attendance, ymdIn: ymdIn, dayDiff: dayDiff,
    phase: phase, refresher: refresher, actGroup: actGroup, actText: actText, emailWhat: emailWhat, REFRESH_MS: 30000 };
})(typeof window !== "undefined" ? window : globalThis);
