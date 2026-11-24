/* event-date-move.js - R252: the event date changed -> ask to move the task times with it (owner: "everything must sync").
 * Task start times are real instants; changing the date of the event never moved them, so reminders went out on the old date.
 *   HelmDateMove.plan(tasks, from, to, tz)   pure: { days, rows: [{ id, title, start, end, remindAt, depends }] }
 *                                            open tasks with a start time (also started or sent back; not done / cancelled / turned down); the same
 *                                            wall clock on the studio's clock, D calendar days later or earlier
 *   HelmDateMove.ask({ quoteId, from, to, label })   after the date was SAVED: asks first (nothing moves by itself), then uses the
 *                                            existing calls (ops.setSchedule keeps "Waits for"; ops.setReminderTimes for exact times).
 *                                            Only with Assign & send tasks. Resolves { asked, moved, failed, locked }; never throws.
 * Needs studio-time.js (DST-safe wall clock). DOM-free: BPUI.confirm / toast only. */
(function (global) {
  "use strict";
  // R253: started work and work sent back for rework move too (left behind, they fell under Wrap-up on the new date)
  var OPEN = { assigned: 1, accepted: 1, unassigned: 1, in_progress: 1 };
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
    var rows = (tasks || []).filter(function (t) { return t && OPEN[t.status] && t.planned_start; }).map(function (t) {
      var s = shift(t.planned_start, days, tz), e = t.planned_end ? shift(t.planned_end, days, tz) : null;
      return s ? { id: t.id, title: t.title || "Task", start: s, end: e, depends: t.depends_on || null,
        remindAt: Array.isArray(t.remind_at) && t.remind_at.length ? t.remind_at.map(function (x) { return shift(x, days, tz); }).filter(Boolean) : null } : null;
    }).filter(Boolean);
    return { days: days, rows: rows };
  }
  function words(d) { var n = Math.abs(d); return n + (n === 1 ? " day " : " days ") + (d > 0 ? "later" : "earlier"); }
  // R253 (owner: yes): the unpaid payment dates follow the event date too - asked first, one list, existing calls only.
  //   never: paid / invoiced / waived / voided rows, amounts, the advance (due on approval), a date before today (today instead).
  //   a plan row made "N days before / after the event" gets that day again; another row moves by the same number of days.
  function planPay(sched, from, to) {
    var a = ymd(from), b = ymd(to), days = a && b ? dayNo(b) - dayNo(a) : NaN, today = ymd(sched && sched.today);
    if (!sched || !sched.can_edit || !today || !isFinite(days) || days === 0) return { days: 0, rows: [] };
    var rows = (sched.rows || []).filter(function (r) {
      if (!r || !r.id || r.status !== "due" || !ymd(r.due_date) || !(Number(r.remaining == null ? r.amount : r.remaining) > 0)) return false;
      if (r.rule) return r.rule.anchor === "event";
      return !(r.on_approval || /\b(advance|booking|token|deposit)\b/i.test(String(r.label || "")));
    }).map(function (r) {
      var off = r.rule ? Number(r.rule.offset_days || 0) : NaN, to2 = isFinite(off) ? addDays(b, off) : addDays(ymd(r.due_date), days);
      if (dayNo(to2) < dayNo(today)) to2 = today;
      return { id: r.id, label: r.label || "Payment", from: ymd(r.due_date), to: to2 };
    }).filter(function (r) { return r.from !== r.to; });
    return { days: days, rows: rows };
  }
  async function askPay(o) {
    var B = global.BPStore, U = global.BPUI, out = { asked: false, moved: 0, failed: 0 };
    try {
      if (!B || !U || !B.paySchedule || !B.milestones || !ymd(o.from) || !ymd(o.to)) return out;
      var p = planPay(await B.paySchedule.forQuote(o.quoteId), o.from, o.to), k = p.rows.length; if (!k) return out;
      var day = function (d) { try { return (B.fmtStudioDate && B.fmtStudioDate(d, { style: "medium" })) || d; } catch (e) { return d; } };
      out.asked = true;
      var ok = await U.confirm((k === 1 ? "1 unpaid payment has" : k + " unpaid payments have") + " a due date set for the old event date. Change " + (k === 1 ? "it" : "them") + "? " +
        p.rows.map(function (r) { return r.label + ": " + day(r.from) + " \u2192 " + day(r.to); }).join("; ") +
        ". Amounts and paid payments don't change. Payment reminders follow the new dates.",
        { title: "Move the payment dates too?", okLabel: k === 1 ? "Move 1 payment" : "Move " + k + " payments", cancelLabel: "Leave them" });
      if (!ok) { U.toast("The payment dates were left as they are. Change them in Logistics, Payments.", { type: "info", timeout: 8000 }); return out; }
      // read again: somebody may have paid or changed a date while the question was open - those rows are left alone
      var now = planPay(await B.paySchedule.forQuote(o.quoteId), o.from, o.to).rows, same = {};
      now.forEach(function (r) { same[r.id + "|" + r.from + "|" + r.to] = 1; });
      for (var i = 0; i < k; i++) {
        var r = p.rows[i]; if (!same[r.id + "|" + r.from + "|" + r.to]) { out.failed++; continue; }
        try { await B.milestones.update(r.id, { due_date: r.to }); out.moved++; } catch (e) { out.failed++; }
      }
      if (out.failed) U.toast("Moved " + out.moved + " of " + k + " payment dates. Check the rest in Logistics, Payments.", { type: "err", timeout: 10000 });
      else U.toast("Moved " + (k === 1 ? "1 payment date." : k + " payment dates."), { type: "ok" });
    } catch (e) { try { if (out.asked) U.toast("The payment dates could not be checked. Look at them in Logistics, Payments.", { type: "err" }); } catch (x) {} }
    return out;
  }
  // both questions, one after the other (task times, then payment dates); never throws
  async function ask(o) {
    o = o || {}; var t = await askTasks(o); t.pay = await askPay(o); return t;
  }
  async function askTasks(o) {
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
  global.HelmDateMove = { plan: plan, planPay: planPay, ask: ask };
})(typeof window !== "undefined" ? window : globalThis);
