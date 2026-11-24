/* event-date-move.js - R252: the event date changed -> ask to move the task times with it (owner: "everything must sync").
 * Task start times are real instants; changing the date of the event never moved them, so reminders went out on the old date.
 *   HelmDateMove.plan(tasks, from, to, tz)   pure: { days, rows: [{ id, title, start, end, remindAt, depends }] }
 *                                            open tasks with a start time (not done / started / cancelled / turned down); the same
 *                                            wall clock on the studio's clock, D calendar days later or earlier
 *   HelmDateMove.ask({ quoteId, from, to, label })   after the date was SAVED: asks first (nothing moves by itself), then uses the
 *                                            existing calls (ops.setSchedule keeps "Waits for"; ops.setReminderTimes for exact times).
 *                                            Only with Assign & send tasks. Resolves { asked, moved, failed, locked }; never throws.
 * Needs studio-time.js (DST-safe wall clock). DOM-free: BPUI.confirm / toast only. */
(function (global) {
  "use strict";
  var OPEN = { assigned: 1, accepted: 1, unassigned: 1 };
  function ymd(v) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || "")); return m ? m[0] : ""; }
  function dayNo(v) { var t = Date.parse(v + "T00:00:00Z"); return isFinite(t) ? Math.round(t / 86400000) : NaN; }
  function addDays(v, d) { return new Date((dayNo(v) + d) * 86400000).toISOString().slice(0, 10); }
  function shift(iso, d, tz) {
    if (!iso) return null; var T = global.HelmStudioTime, w = T && T.utcToWall ? T.utcToWall(new Date(iso), tz) : null;
    if (!w) return null; var x = T.wallToUtc(addDays(w.ymd, d), w.hm, tz);
    return isNaN(x.getTime()) ? null : x.toISOString();
  }
  function plan(tasks, from, to, tz) {
    var a = ymd(from), b = ymd(to), days = a && b ? dayNo(b) - dayNo(a) : NaN;
    if (!isFinite(days) || days === 0) return { days: 0, rows: [] };
    var rows = (tasks || []).filter(function (t) { return t && OPEN[t.status] && t.planned_start && !t.started_at && !t.completed_at; }).map(function (t) {
      var s = shift(t.planned_start, days, tz), e = t.planned_end ? shift(t.planned_end, days, tz) : null;
      return s ? { id: t.id, title: t.title || "Task", start: s, end: e, depends: t.depends_on || null,
        remindAt: Array.isArray(t.remind_at) && t.remind_at.length ? t.remind_at.map(function (x) { return shift(x, days, tz); }).filter(Boolean) : null } : null;
    }).filter(Boolean);
    return { days: days, rows: rows };
  }
  function words(d) { var n = Math.abs(d); return n + (n === 1 ? " day " : " days ") + (d > 0 ? "later" : "earlier"); }
  async function ask(o) {
    o = o || {}; var B = global.BPStore, U = global.BPUI, out = { asked: false, moved: 0, failed: 0, locked: false };
    try {
      if (!B || !U || !ymd(o.from) || !ymd(o.to) || ymd(o.from) === ymd(o.to)) return out;
      if (!(await B.auth.canAssignTasks())) return out;
      var tz = B.studioTimezone ? B.studioTimezone() : "Asia/Kolkata", tasks = await B.ops.listTasks(o.quoteId), p = plan(tasks, o.from, o.to, tz);
      if (!p.rows.length) return out;
      out.asked = true;
      var k = p.rows.length, ok = await U.confirm((k === 1 ? "1 task has a start time" : k + " tasks have start times") + " for the old date. Move " + (k === 1 ? "it " : "them ") + words(p.days) +
        " (same time of day)? Reminders follow the new time, and people already given the work may get a message about the change. If you don't, reminders go out for the old date.",
        { title: "Move the task times too?", okLabel: "Move " + (k === 1 ? "1 task" : k + " tasks"), cancelLabel: "Leave them" });
      if (!ok) { U.toast("The task times were left on the old date. Change them on Tasks & Crew.", { type: "info", timeout: 8000 }); return out; }
      // the earlier task first when moving forward would put it after the one that waits for it - the server has no order rule, so plain order is fine
      for (var i = 0; i < p.rows.length; i++) {
        var r = p.rows[i];
        try {
          await B.ops.setSchedule(r.id, r.start, r.end, r.depends);
          if (r.remindAt && r.remindAt.length) { try { await B.ops.setReminderTimes(r.id, r.remindAt); } catch (e) { /* a time that cannot be kept (already past): the start still moved */ } }
          out.moved++;
        } catch (e) {
          out.failed++;
          if (B.ops.planLock && B.ops.planLock.isLockError && B.ops.planLock.isLockError(e)) { out.locked = true; out.failed = k - out.moved; break; }
        }
      }
      if (out.locked) U.toast("The plan is locked, so " + (out.moved ? out.failed + " task times were" : "the task times were") + " not moved. Unlock it on Tasks & Crew, then change the times there.", { type: "err", timeout: 10000 });
      else if (out.failed) U.toast("Moved " + out.moved + " of " + k + " tasks. Check the rest on Tasks & Crew.", { type: "err", timeout: 10000 });
      else U.toast("Moved " + (k === 1 ? "1 task" : k + " tasks") + " " + words(p.days) + ".", { type: "ok" });
    } catch (e) { try { if (out.asked) U.toast("The task times could not be checked. Look at them on Tasks & Crew.", { type: "err" }); } catch (x) {} }
    return out;
  }
  global.HelmDateMove = { plan: plan, ask: ask };
})(typeof window !== "undefined" ? window : globalThis);
