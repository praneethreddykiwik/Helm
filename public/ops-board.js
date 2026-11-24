/* ops-board.js - R192 Tasks & Crew page (ops.html), the owner-approved redesign (TASKS-CREW-PAGE-PLAN.md phases 1-6,
 * mockups/tasks-crew). The page script in ops.html keeps the data and every action (assign, reminders, special, e-mail /
 * WhatsApp, permanent links, QC, cancel, schedule, proof photos); this file only lays the page out around two questions:
 * "Are we ready?" (before the event) and "What needs me right now?" (on the day).
 *
 *   header       event, date, venue, Guests arrive (event time), countdown, one progress bar. "Venue opens" / "Ready by" show
 *                only when the event already carries them (no new database fields in this round).
 *   steps        R251 (owner 24 Nov): Day before / Pre-event / On the event, right under the header - the same three as the monitor,
 *                picked from the STUDIO's clock and the stage (HelmTaskStatus.opsMode + opsWindow; the note says why), can be
 *                flipped by hand in this tab. Each step shows its own cards, in its own order (ORDER); the header badge is always
 *                the REAL step. Wrap-up is no step: one closed section at the bottom (HelmEventWrap, event-steps.js), and the
 *                last card of Pre-event is "Mark pre-event complete" (HelmEventSteps, event-steps.js).
 *   Day before   "Get set up" shortcuts, "Tasks to sort out" with Fix ->, the Day-before checklist, the plan lock, the floor plan
 *   Pre-event    Ready by + latest starts, check-in, late set-up jobs, Issues, the floor plan, tasks, "Mark pre-event complete"
 *   On the event run-sheet now / next, late work (with the R186 escalation ladder), check-in, Issues (event_issues, Issues area;
 *                R252: list + "Assign to" = issue-assign.js, the same on the monitor and the Issues page) beside the activity log, tasks, the floor plan. Crew: Free that day / Busy elsewhere / Day off.
 *   views        By department / Timeline (lanes + Now line; phone = hour-by-hour agenda) / By person - each split by step first:
 *                Day before, Pre-event, On the event, Wrap-up (HelmTaskStatus.taskStep), with a done count per step
 *   task panel   one panel per task with only the actions that make sense right now
 *   sheet        "+ Add & assign": when is this work / what / who / start time / tell them, bulk bar (Assign, Set time = move by, Special,
 *                Send, Cancel)
 * Redraws only what changed: list rows are keyed and patched; the other blocks are rebuilt only when their content changed.
 * ONE refresh clock (30 s + at once when you come back to the tab), shared vocabulary + late rules from task-status.js.
 * Built with DOM calls only (textContent), never HTML strings. Pure helpers are exported for tests (OpsBoard._pure). */
(function (global) {
  "use strict";
  var doc = global.document;
  var TS = global.HelmTaskStatus;

  /* ======================= pure helpers (unit-tested) ======================= */
  var CANCELLABLE = ["assigned", "accepted", "in_progress"];
  var REASSIGNABLE = ["unassigned", "assigned", "rejected"];
  function ms(v) { if (v == null || v === "") return NaN; var t = new Date(v).getTime(); return isFinite(t) ? t : NaN; }
  function isOpen(t) { return t && ["assigned", "accepted", "in_progress"].indexOf(t.status) >= 0; }
  function inHouse(t) { return t && t.assignee_kind !== "outsourced"; }
  function noOne(t) { var k = TS.baseKey(t); return k === "unassigned" || k === "rejected"; }
  // move an ISO time by n minutes
  function moveBy(iso, n) { var t = ms(iso); return isFinite(t) ? new Date(t + n * 60000).toISOString() : null; }
  // the suggested "move by" for a bulk Set time: the biggest lateness among the ticked tasks rounded up to 15 min, else +30
  function suggestShift(tasks, now) {
    var worst = 0; (tasks || []).forEach(function (t) { var m = TS.lateMin(t, now); if (m > worst) worst = m; });
    return worst ? Math.min(240, Math.ceil(worst / 15) * 15) : 30;
  }
  // where a task sits against the event day (studio calendar): before | day | night (after midnight, before 6 AM) | after | none
  function slot(t, evDate, wallFn) {
    var w = t && t.planned_start ? wallFn(t.planned_start) : null; if (!w) return { where: "none" };
    var d = evDate ? TS.dayDiff(evDate, w.ymd) : 0;
    if (!isFinite(d)) d = 0;
    var where = d < 0 ? "before" : d === 0 ? "day" : (d === 1 && w.min < 360) ? "night" : "after";
    return { where: where, off: d, min: w.min, ymd: w.ymd };
  }
  var CHIPS = [
    ["", "All"], ["late", "Late"], ["special", "Special"], ["none", "Not assigned"], ["down", "Turned down"], ["wait", "Not accepted yet"],
    ["notime", "No time"], ["qc", "QC to check"], ["clash", "Can’t-work clash"], ["done", "Done"], ["cancelled", "Cancelled"]
  ];
  function chipTest(key, t, now, clash) {
    if (key === "cancelled") return t.status === "cancelled";
    if (t.status === "cancelled") return false;
    switch (key) {
      case "": return true;
      case "late": return TS.isLate(t, now);
      case "special": return !!t.is_special;
      case "none": return noOne(t);
      case "down": return TS.baseKey(t) === "rejected";
      case "wait": return TS.baseKey(t) === "waiting" && !TS.isLate(t, now);
      case "notime": return !t.planned_start && t.status !== "completed";
      case "qc": return t.verify_status === "pending";
      case "clash": return !!(clash && clash(t)) && t.status !== "completed";
      case "done": return t.status === "completed";
    }
    return true;
  }
  // "Ready for the day?" lines: [ok, done text, todo text, fix chip | "people" | ""]
  function readyChecks(tasks, o) {
    o = o || {}; var live = (tasks || []).filter(function (t) { return t && t.status !== "cancelled"; });
    var n = function (f) { return live.filter(f).length; }, pl = function (k, w) { return k + " " + (k === 1 ? w : w === "person" ? "people" : w + "s"); };
    var none = n(function (t) { return TS.baseKey(t) === "unassigned"; }), down = n(function (t) { return TS.baseKey(t) === "rejected"; });
    var notime = n(function (t) { return !t.planned_start && t.status !== "completed" && inHouse(t); });
    var clash = o.clash ? n(function (t) { return t.status !== "completed" && o.clash(t); }) : 0;
    var wait = n(function (t) { return TS.baseKey(t) === "waiting"; });
    var spNo = n(function (t) { return t.is_special && !t.planned_start && t.status !== "completed"; });
    var unsent = o.unsent == null ? null : o.unsent;
    var items = [
      [none === 0, "Every task has a person", pl(none, "task") + " not assigned", "none"],
      [notime === 0, "Every task has a start time", pl(notime, "task") + " with no start time (no reminders)", "notime"],
      [clash === 0, "No one is booked on a day they can’t work", pl(clash, "task") + " clash with a can’t-work day", "clash"],
      [wait === 0, "Everyone accepted", pl(wait, "task") + " not accepted yet", "wait"],
      [spNo === 0, "Special tasks have a time (so they can escalate)", pl(spNo, "special task") + " without a start time", "special"],
      [down === 0, "No one turned work down", pl(down, "task") + " turned down - give " + (down === 1 ? "it" : "them") + " to someone else", "down"]
    ];
    if (unsent != null) items.push([unsent === 0, "Everyone has been sent their tasks", pl(unsent, "person") + " not sent their tasks yet (Email / WhatsApp)", "people"]);
    if (!live.length) items = [[false, "", "No tasks yet - add the work for this event", "add"]];
    return items;
  }
  // people who should be on site and have not checked in: first task started (or starts within 30 min)
  function notCheckedIn(tasks, sheet, now) {
    var first = {};
    (tasks || []).forEach(function (t) {
      if (!t || !t.crew_id || !inHouse(t) || ["cancelled", "rejected", "completed"].indexOf(t.status) >= 0) return;
      var s = ms(t.planned_start); if (!isFinite(s)) return;
      if (first[t.crew_id] == null || s < first[t.crew_id]) first[t.crew_id] = s;
    });
    return Object.keys(first).filter(function (id) { var e = sheet && sheet[id]; return !(e && e.in) && first[id] <= now + 30 * 60000; })
      .map(function (id) { return { crew_id: id, first: first[id], late: first[id] < now }; })
      .sort(function (a, b) { return a.first - b.first; });
  }
  // stack overlapping blocks of one lane into extra rows so none hide behind another
  function stackRows(items) {
    var ends = [], rowOf = {};
    items.slice().sort(function (a, b) { return a.s - b.s; }).forEach(function (x) {
      for (var r = 0; r < ends.length && ends[r] > x.s; r++);
      ends[r] = x.e; rowOf[x.id] = r;
    });
    return { rows: Math.max(1, ends.length), rowOf: rowOf };
  }
  // R222: is this person free on the day(s) they work on THIS event? The same rules as the server's checks, so the crew card
  // and the "No one is booked on a day they can't work" readiness line can never disagree:
  //   days    = the studio-calendar day of each of their open tasks here (not cancelled / turned down / done - the same tasks
  //             crew_unavailable_conflicts and the readiness line count), else the event day (multi-day events: every day)
  //   off     = a can't-work day on one of those days (crew_availability_range, 0370: approved = Day off, pending = Asked off)
  //   busy    = crew_day_status (0265/0370) "booked": a task on ANOTHER live event that same studio day (codes = which events)
  //   dayOf(t) -> "YYYY-MM-DD" (studio zone); off(id, day) -> {pending, note} | null; booked(id, day) -> [codes] | null (unknown)
  function crewDay(crewId, tasks, evDate, dayOf, off, booked) {
    var days = [];
    (tasks || []).forEach(function (t) {
      if (!t || t.crew_id !== crewId || !inHouse(t) || ["cancelled", "rejected", "completed"].indexOf(t.status) >= 0) return;
      var d = dayOf(t); if (d && days.indexOf(d) < 0) days.push(d);
    });
    if (!days.length && evDate) days.push(evDate);
    days.sort();
    for (var i = 0; i < days.length; i++) { var o = off(crewId, days[i]); if (o) return { state: o.pending ? "asked" : "off", day: days[i], days: days, note: o.note || "" }; }
    var codes = [], unknown = false, bday = "";
    days.forEach(function (d) { var b = booked(crewId, d); if (b == null) { unknown = true; return; }
      if (b.length && !bday) bday = d;
      b.forEach(function (c) { if (c && codes.indexOf(c) < 0) codes.push(c); }); });
    if (bday) return { state: "busy", day: bday, days: days, codes: codes };
    return { state: "free", days: days, unknown: unknown };
  }
  // the words (owner: "what does Free mean"): Free that day / Busy elsewhere / Day off / Asked for the day off
  function availWord(info, evDate, dayFmt) {
    info = info || { state: "free", days: [] }; var fmt = dayFmt || function (d) { return d; };
    var other = info.day && evDate && info.day !== evDate ? " (" + fmt(info.day) + ")" : "";
    if (info.state === "off") return { cls: "late", text: "Day off" + other, short: "Day off" + other, title: "Approved can't-work day" + (info.note ? ": " + info.note : "") };
    if (info.state === "asked") return { cls: "late", text: "Asked for the day off" + other, short: "Day off - asked" + other, title: "Asked for this day off - waiting for an answer" + (info.note ? ": " + info.note : "") };
    if (info.state === "busy") { var c = info.codes || [], nm = c.length ? " · " + c[0] + (c.length > 1 ? " +" + (c.length - 1) : "") : "";
      return { cls: "busy", text: "Busy elsewhere" + nm + other, short: "Busy elsewhere" + nm, title: "Also has work that day on " + (c.join(", ") || "another event") }; }
    var many = (info.days || []).length > 1;
    return { cls: "in", text: many ? "Free those days" : "Free that day", short: many ? "Free those days" : "Free that day",
      title: "No other event and no day off " + (many ? "on the days they work here" : "that day") };
  }
  // R222: run-sheet rows with done / now / next against the studio clock (start minutes on the event day)
  function runRows(items, nowMin) {
    var rows = (items || []).map(function (r) {
      var s = TS.hmMin(r && r.start_time), d = Number(r && r.duration_min);
      return { r: r, s: s, e: isFinite(s) ? s + (isFinite(d) && d > 0 ? d : 0) : NaN };
    }).sort(function (a, b) { return (isFinite(a.s) ? a.s : 1e9) - (isFinite(b.s) ? b.s : 1e9) || (a.r.seq || 0) - (b.r.seq || 0); });
    var next = -1;
    rows.forEach(function (x, i) {
      if (!isFinite(x.s) || nowMin == null) { x.state = "none"; return; }
      if (nowMin >= x.s && (nowMin < x.e || (x.e === x.s && nowMin < x.s + 15))) x.state = "now";
      else if (nowMin >= x.e && nowMin >= x.s) x.state = "done";
      else { x.state = "later"; if (next < 0) next = i; }
    });
    if (next >= 0) { rows[next].state = "next"; rows[next].inMin = rows[next].s - nowMin; }
    return rows;
  }
  // R251: where a new task's start time begins for a step: minutes on the event day + how many days off (never past midnight "by hand")
  //   daybefore 6 PM the evening before; pre Venue opens, else 2 h before Ready by, else 3 h before guests (always before guests);
  //   onday Guests arrive; wrapup after the last run-sheet item, else 3 h after guests.  o: { guests, venue, ready, runEnd } minutes / NaN
  function stepStart(step, o) {
    o = o || {}; var g = +o.guests, v = +o.venue, r = +o.ready, e = +o.runEnd, G0 = o.guests != null && isFinite(g), m;
    if (step === "daybefore") return { off: -1, min: 1080 };
    if (step === "onday") return { off: 0, min: G0 ? g : 1080 };
    if (step === "wrapup") { m = o.runEnd != null && isFinite(e) && (!G0 || e > g) ? e : G0 ? g + 180 : 1320; m = Math.ceil(m / 5) * 5; return { off: Math.floor(m / 1440), min: m % 1440 }; }
    m = o.venue != null && isFinite(v) && (!G0 || v < g) ? v : o.ready != null && isFinite(r) && (!G0 || r <= g) ? r - 120 : G0 ? g - 180 : 540;
    if (G0 && m >= g) m = g - 60;
    return { off: 0, min: Math.max(0, m) };
  }
  // when the last run-sheet item ends, in minutes from midnight of the event day (an item before 6 AM after an afternoon start = after midnight)
  function runEnd(items, guests) {
    var late = guests != null && isFinite(guests) && guests >= 720, best = NaN;
    (items || []).forEach(function (x) { var st = TS.hmMin(x && x.start_time); if (!isFinite(st)) return; if (late && st < 360) st += 1440;
      var d = Number(x.duration_min), e = st + (isFinite(d) && d > 0 ? d : 0); if (!isFinite(best) || e > best) best = e; });
    return best;
  }
  // which step groups start folded on a step's tab (a filter or search opens all of them): while planning (Day before) everything is open;
  // on the event day only the step's own work (and Wrap-up once the event is over) - a folded head still says done / to give out / late
  function foldDefault(win, step, autoWin) { return !(win === "daybefore" || step === win || (step === "wrapup" && autoWin === "wrapup")); }
  // what the header badge says: the REAL step, never the one somebody is looking at
  function badgeOf(autoWin, stage) {
    if (autoWin === "wrapup") return stage === "settlement" || stage === "closed" ? { text: "Complete", cls: "over" } : { text: "Event over", cls: "over" };
    return autoWin === "onday" ? { text: "Event day - live", cls: "live" } : autoWin === "pre" ? { text: "Pre-event", cls: "pre" } : { text: "Planning", cls: "plan" };
  }
  function rowSig(o) { try { return JSON.stringify(o); } catch (e) { return String(Math.random()); } }

  /* ======================= the page ======================= */
  if (!doc || !doc.getElementById) { global.OpsBoard = { _pure: { moveBy: moveBy, suggestShift: suggestShift, slot: slot, chipTest: chipTest, readyChecks: readyChecks, notCheckedIn: notCheckedIn, stackRows: stackRows, CHIPS: CHIPS, availWord: availWord, crewDay: crewDay, runRows: runRows, stepStart: stepStart, runEnd: runEnd, foldDefault: foldDefault, badgeOf: badgeOf } }; return; }

  var S = {
    started: false, phase: null, manual: null, view: "list", chip: "", q: "", sel: {}, openId: null, folded: {},
    acts: null, sheet: {}, hasSheet: false, avail: {}, req: null, escCfg: null, preset: null, sendIds: null,
    sigs: {}, rows: {}, groups: {}, viewKey: "", timer: null, lastFocus: null, layer: null, deepDone: false,
    // R222: run-sheet (null = can't read it), issues (null = can't read), what this role may do, the mode and why
    rs: null, rsAt: 0, iss: null, issErr: false, perm: null, mode: null,
    dayStat: {}, dayAt: 0, dayKey: "",  // crew_day_status per studio day: { crew_id: [codes] } | null (server without it)
    // R251: the step on screen (win), the real one (autoWin: also "wrapup"), its tab (autoStep); R226 (0396) the event day plan (null = no 0396)
    win: null, autoWin: null, autoStep: null, plan: null, planAt: 0, steps: {}, stepFold: {}, addStep: null,
    // R230 (0399): the department supervisors of this event (null = server without 0399 -> no supervisor UI at all)
    sup: null, supAt: 0
  };
  var $ = function (s, r) { return (r || doc).querySelector(s); };
  function P() { return global.OpsPage; }
  function G() { return (P() && P().get()) || {}; }
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
  function addTo(p, c) { if (p && c) p.appendChild(c); }
  function toast(t, type, timeout) { try { global.BPUI.toast(t, { type: type || "ok", timeout: timeout || 5000 }); } catch (e) {} }
  function errText(e, action) { try { return global.BPUI.friendlyError(e, { action: action }); } catch (x) { return "Couldn't " + action + " - try again."; } }
  function lsGet(k) { try { return global.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { global.localStorage.setItem(k, v); } catch (e) {} }

  /* ---- studio clock ---- */
  function tz() { try { return B().studioTimezone(); } catch (e) { return "Asia/Kolkata"; } }
  function loc() { try { return B().studioLocale(); } catch (e) { return "en-IN"; } }
  // per-redraw memo (cleared at the start of every update): 100+ tasks x many lookups stay cheap
  var M = { wall: {}, clock: {}, crew: null, live: null, step: {}, by: null, dly: undefined };
  function memoReset() { M = { wall: {}, clock: {}, crew: null, live: null, step: {}, by: null, dly: undefined }; }
  function wall(iso) { var k = String(iso); if (Object.prototype.hasOwnProperty.call(M.wall, k)) return M.wall[k]; return (M.wall[k] = wall0(iso)); }
  function wall0(iso) {
    var d = new Date(iso); if (!iso || isNaN(d.getTime())) return null;
    var T = global.HelmStudioTime;
    if (T && T.utcToWall) { try { var w = T.utcToWall(d, tz()); return { ymd: w.ymd, min: w.h * 60 + w.mi }; } catch (e) {} }
    try { var f = new Intl.DateTimeFormat("en-GB", { timeZone: tz(), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }), o = {};
      f.formatToParts(d).forEach(function (p) { o[p.type] = p.value; }); return { ymd: o.year + "-" + o.month + "-" + o.day, min: (Number(o.hour) % 24) * 60 + Number(o.minute) }; } catch (e) { return null; }
  }
  function clock(iso) { var k = String(iso); if (Object.prototype.hasOwnProperty.call(M.clock, k)) return M.clock[k]; return (M.clock[k] = clock0(iso)); }
  function clock0(iso) { var d = new Date(iso); if (!iso || isNaN(d.getTime())) return ""; try { return new Intl.DateTimeFormat(loc(), { timeZone: tz(), hour: "numeric", minute: "2-digit" }).format(d); } catch (e) { return d.toLocaleTimeString(); } }
  function hourLabel(m) { m = ((m % 1440) + 1440) % 1440; var hh = Math.floor(m / 60), ap = hh >= 12 ? "pm" : "am", h12 = hh % 12 || 12, mi = m % 60; return h12 + (mi ? ":" + (mi < 10 ? "0" : "") + mi : "") + ap; }
  function dayWords(ymd, withYear) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || "")); if (!m) return ""; var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
    var o = { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }; if (withYear) o.year = "numeric"; try { return new Intl.DateTimeFormat(loc(), o).format(d); } catch (e) { return ymd; } }
  function when(iso) { var w = wall(iso); return w ? dayWords(w.ymd) + ", " + clock(iso) : ""; }
  function today() { return TS.ymdIn(tz(), Date.now()); }
  function dur(m) { m = Math.round(m); if (m < 60) return m + " min"; var hh = Math.floor(m / 60), r = m % 60; return hh + "h" + (r ? " " + r + "m" : ""); }

  /* ---- data views ---- */
  function evDate() {
    var g = G(), e = P() && P().evDateStr ? P().evDateStr() : "";
    if (e) return e;
    var n = {}; (g.tasks || []).forEach(function (t) { var w = t.planned_start && wall(t.planned_start); if (w) n[w.ymd] = (n[w.ymd] || 0) + 1; });
    var best = "", bn = 0; Object.keys(n).forEach(function (k) { if (n[k] > bn) { bn = n[k]; best = k; } }); return best;
  }
  function crewById(id) { if (!M.crew) { M.crew = {}; (G().crew || []).forEach(function (x) { if (x && x.id) M.crew[x.id] = x; }); } return M.crew[id] || null; }
  function nameOf(t) { var c = t.crew_id && crewById(t.crew_id); return (c && c.name) || t.assignee_name || ""; }
  function liveTasks() { if (!M.live) M.live = (G().tasks || []).filter(function (t) { return t && t.status !== "cancelled"; }); return M.live; }
  function taskById(id) { return (G().tasks || []).filter(function (t) { return String(t.id) === String(id); })[0] || null; }
  function taskDay(t) { var w = t.planned_start && wall(t.planned_start); return w ? w.ymd : evDate(); }
  // day-off of a person on a day: { note, pending } | null (R174 data; R187 adds "pending" = asked off, waiting)
  function offOn(crewId, day) { var a = crewId && S.avail[crewId]; return a && day ? a[day] || null : null; }
  function clashOf(t) { return t && t.crew_id && inHouse(t) && !noOne(t) ? offOn(t.crew_id, taskDay(t)) : null; }
  // first start on the check-in's own day (a set-up task the evening before must not make today's check-in "late")
  function firstStartOn(crewId, day) { var best = NaN; liveTasks().forEach(function (t) { if (t.crew_id !== crewId || !t.planned_start) return; var w = wall(t.planned_start); if (!w || (day && w.ymd !== day)) return; var v = ms(t.planned_start); if (!isFinite(best) || v < best) best = v; }); return best; }
  // first start of the work still to do (not done) - for "should be here by"
  function firstOpen(crewId) { var best = NaN; liveTasks().forEach(function (t) { if (t.crew_id !== crewId || !t.planned_start || t.status === "completed" || t.status === "rejected") return; var v = ms(t.planned_start); if (isFinite(v) && (!isFinite(best) || v < best)) best = v; }); return best; }
  function att(crewId) { var e = S.sheet[crewId]; return TS.attendance(e, e ? firstStartOn(crewId, e.day) : NaN); }
  function evidenceOf(t) { return (G().evidence || []).filter(function (e) { return e.task_id === t.id; }); }
  function people() {
    var ids = [], seen = {};
    liveTasks().forEach(function (t) { if (t.crew_id && inHouse(t) && !seen[t.crew_id]) { seen[t.crew_id] = 1; ids.push(t.crew_id); } });
    return ids.map(function (id) { return crewById(id) || { id: id, name: (liveTasks().filter(function (t) { return t.crew_id === id; })[0] || {}).assignee_name || "Staff" }; });
  }
  function canEdit() { return !!G().canEdit; }
  function initials(n) { return String(n || "?").trim().split(/\s+/).slice(0, 2).map(function (w) { return w.charAt(0); }).join("").toUpperCase() || "?"; }
  function presState(crewId) {
    if (!crewId || !S.hasSheet) return "";
    var a = att(crewId); if (a.state === "in") return a.late ? "late" : "in"; if (a.state === "out") return "out";
    var fs = firstOpen(crewId); return isFinite(fs) && fs < Date.now() ? "late" : "";
  }
  function avatar(name, crewId, lg) {
    var a = h("span", { cls: "tc-av" + (lg ? " lg" : ""), "aria-hidden": "true", text: initials(name) });
    var c = crewId && crewById(crewId), m = c && c.profile_id && G().memberDir ? G().memberDir[c.profile_id] : null;
    if (m && m.avatar_path) a.setAttribute("data-avatar-path", m.avatar_path);
    var ps = presState(crewId); if (ps) a.appendChild(h("i", { cls: "pres " + ps }));
    return a;
  }
  function stPill(t) { var k = TS.shown(t); return h("span", { cls: "tc-st " + k, text: TS.LABEL[k] }); }
  function ladderEl(step) {
    var L = TS.ladder(S.escCfg), w = h("span", { cls: "tc-ladder", role: "img", "aria-label": "Escalation: " + (L[Math.max(0, step)] || L[0]) + " told so far" });
    L.forEach(function (r, i) {
      if (i) w.appendChild(h("i", { cls: "tc-rung-sep", "aria-hidden": "true" }));
      w.appendChild(h("span", { cls: "tc-rung" + (i < step ? " hit" : i === step ? " now" : ""), text: r, "aria-hidden": "true" }));
    });
    return w;
  }
  function remText(t) { try { return P().remSummary(t) || ""; } catch (e) { return ""; } }
  function depOf(t) { return t.depends_on ? taskById(t.depends_on) : null; }
  function tags(t) {
    var a = [];
    if (t.is_special) a.push(h("span", { cls: "tc-tag special" + (TS.isLate(t) ? " pulse" : ""), title: "Special (P1) task: extra reminders and step-by-step escalation", text: "▲ Special" }));
    if (!inHouse(t)) a.push(h("span", { cls: "tc-tag box", title: "Done by a vendor: they get a checklist link, no reminders", text: "Vendor" }));
    var r = remText(t); if (r) a.push(h("span", { cls: "tc-tag", title: "Reminders (e-mail; WhatsApp once connected)", text: "Reminders " + r }));
    var d = depOf(t), wt = waitsOf(t);   // R252: what it waits for and when that should be done (event-delay.js)
    if (wt) a.push(h("span", { cls: "tc-tag tc-tag-wrap" + (wt.bad ? " warn" : ""), text: "↳ " + wt.text }));
    else if (d && d.status !== "completed" && !global.HelmDelay) a.push(h("span", { cls: "tc-tag", title: "Waits for: " + (d.title || "task"), text: "↳ after " + String(d.title || "task").split(/\s+/).slice(0, 3).join(" ") }));
    if (t.verify_status === "pending") a.push(h("span", { cls: "tc-tag warn", text: "QC to check" }));
    else if (t.verify_status === "rejected") a.push(h("span", { cls: "tc-tag warn", title: t.verify_note || "", text: "QC: rework" }));
    else if (t.verify_status === "passed") a.push(h("span", { cls: "tc-tag ok", text: "QC passed" }));
    var c = clashOf(t); if (c && t.status !== "completed") a.push(h("span", { cls: "tc-tag warn", title: c.note || "", text: c.pending ? "! asked for this day off" : "! approved day off - needs a new person" }));
    var ev = evidenceOf(t); if (ev.length) a.push(h("span", { cls: "tc-tag", text: "Notes & photos (" + ev.length + ")" }));
    var wa = null; try { wa = P().waChip(t); } catch (e) {}
    if (wa && wa.text) a.push(h("span", { cls: "tc-tag", title: wa.title || "", text: "WhatsApp: " + wa.text }));
    if (t.status === "cancelled") a.push(h("span", { cls: "tc-tag", text: "Cancelled" + (t.cancel_reason ? ": " + t.cancel_reason : "") }));
    return a;
  }
  function timeCell(t) {
    if (!t.planned_start) return h("span", { cls: "tc-r-time none", text: "No time" });
    var sl = slot(t, evDate(), wall), small = "";
    if (sl.where === "before") small = sl.off === -1 ? "Day before" : (-sl.off) + " days before";
    else if (sl.where === "night") small = "After midnight";
    else if (sl.where === "after") small = sl.off === 1 ? "Next day" : sl.off + " days after";
    else { var e = ms(t.planned_end), s = ms(t.planned_start); if (isFinite(e) && e > s) { var we = wall(t.planned_end); small = we && we.ymd !== sl.ymd ? "Runs past midnight" : dur((e - s) / 60000); } }
    return h("span", { cls: "tc-r-time" }, [clock(t.planned_start), small ? h("small", { text: small }) : null]);
  }

  /* ---- R251: which step a task belongs to (Day before / Pre-event / On the event / Wrap-up) ---- */
  function stepO() { return { eventDate: evDate(), eventTime: (G().quote || {}).eventTime, tz: tz() }; }
  function stepOfTask(t) { var k = String(t.id); if (!M.step[k]) M.step[k] = TS.taskStep(t, stepO()); return M.step[k]; }
  function byStep() { if (!M.by) M.by = TS.bySteps(G().tasks, stepO()); return M.by; }
  function preLeft() { return S.autoWin === "daybefore" || S.autoWin === "pre" ? byStep().pre.unassigned : 0; }   // a hint for planning, gone once the event is on
  function allocHint() { var n = preLeft(); return n ? "Allocate pre-event work first - " + n + " left" : ""; }

  /* ---- filters ---- */
  function matchQ(t, q) { if (!q) return true; return [t.title, t.category, nameOf(t)].join(" ").toLowerCase().indexOf(q) >= 0; }
  function sortKey(t) { var s = ms(t.planned_start); return isFinite(s) ? s : 9e15; }
  function filtered() {
    var q = S.q.trim().toLowerCase(), now = Date.now();
    return (G().tasks || []).filter(function (t) { return t && chipTest(S.chip, t, now, clashOf) && matchQ(t, q); })
      .sort(function (a, b) { return sortKey(a) - sortKey(b) || (a.seq || 0) - (b.seq || 0) || String(a.title || "").localeCompare(String(b.title || "")); });
  }

  /* ======================= render ======================= */
  function modeNow() {
    var q = G().quote || {};
    return TS.opsMode({ eventDate: evDate(), eventTime: q.eventTime, stage: q.lifecycleStage || q.lifecycle_stage, status: q.status,
      tasks: G().tasks, runsheet: S.rs, now: Date.now(), tz: tz() });
  }
  // R251: the step is the studio's clock + the stage (TS.opsWindow), nothing else (owner: studio time only). Tapping another tab only looks
  // at it: nothing is stored, a reload - or the clock reaching a new step - goes back to the real one.
  function setPhaseAuto() {
    S.mode = modeNow(); var q = G().quote || {}, was = S.autoStep;
    S.autoWin = TS.opsWindow(S.mode, { eventDate: evDate(), eventTime: q.eventTime, stage: stageOf(), now: Date.now(), tz: tz() });
    S.autoStep = TS.stepOf(S.autoWin);
    if (S.manual === S.autoStep || (was && was !== S.autoStep)) S.manual = null;
    S.win = S.manual || S.autoStep; S.phase = TS.WIN_PHASE[S.win]; S.auto = TS.WIN_PHASE[S.autoWin];
  }
  function pickWin(w) {
    w = TS.normWin(w); if (!w) return;
    S.manual = w === S.autoStep ? null : w; S.win = w; S.phase = TS.WIN_PHASE[w]; S.sigs = {}; update();
    if ((S.phase === "live" || issStep()) && S.iss === null) loadExtras().then(update);
  }
  function winWord(w) { var r = (TS.WINDOWS || []).filter(function (x) { return x[0] === w; })[0]; return r ? r[1] : ""; }
  function renderHeader() {
    var g = G(), q = g.quote || {}, host = $("#evhead"); if (!host) return;
    var sm = TS.summarize(g.tasks), ev = evDate(), live = S.auto === "live";   // R251: the real step, never the tab on screen
    var c = q.client || {};
    var venue = q.venue || c.venue || c.address || "", guests = q.guests || (q.pricing && q.pricing.guests) || c.guests || "";
    // owner hasn't approved "Venue opens" / "Ready by" fields yet: show them only when the event already has them
    var pick = function (keys) { for (var i = 0; i < keys.length; i++) { var v = q[keys[i]] != null ? q[keys[i]] : c[keys[i]]; if (v != null && String(v).trim()) return String(v).trim(); } return ""; };
    var venueOpens = pick(["venueOpens", "venue_opens", "venueAccess", "venue_access"]), readyBy = pick(["readyBy", "ready_by"]);
    if (S.plan && global.HelmEventPlan) {   // R226 (0396): the saved day plan
      var EPx = global.HelmEventPlan, va = EPx.venueAt(S.plan, ev, tz()), rb = S.plan.ready_by ? EPx.readyAt(S.plan, ev, "", tz()) : NaN;
      if (!venueOpens && isFinite(va)) venueOpens = clock(new Date(va).toISOString());
      if (!readyBy && isFinite(rb)) readyBy = clock(new Date(rb).toISOString());
    }
    var guestsAt = String(q.eventTime || "").trim();
    var bd = badgeOf(S.autoWin, stageOf()), pill = h("span", { cls: "tc-pill " + bd.cls, id: "tcBadge", text: bd.text });
    var main = h("div", { cls: "tc-ev-main" }, [
      h("div", { cls: "tc-ev-id" }, [h("span", { cls: "tc-ev-code", text: q.code || "" }), pill, q.status && q.status !== "confirmed" ? h("span", { cls: "tc-tag box", text: q.status }) : null]),
      h("h2", { cls: "tc-ev-title", id: "evTitle", text: q.title || q.code || "Event" }),
      h("p", { cls: "tc-ev-sub", text: [ev ? dayWords(ev, true) : "No event date yet", venue, guests ? guests + " guests" : "", q.eventType || ""].filter(Boolean).join(" · ") })
    ]);
    var mine = mineDepts();   // R230 (0399): what I supervise on this event
    if (mine.length) main.appendChild(h("p", { cls: "tc-ev-mine" }, ["You supervise: ", h("b", { text: mine.join(", ") })]));
    var dl = h("dl", { cls: "tc-times" });
    function tile(lbl, val, cls, id) { dl.appendChild(h("div", { cls: "tc-t" + (cls ? " " + cls : "") }, [h("dt", { text: lbl }), h("dd", { text: val, id: id || null })])); }
    if (venueOpens) tile("Venue opens", venueOpens);
    if (readyBy) tile("Ready by", readyBy, "key");
    if (guestsAt) tile("Guests arrive", guestsAt, readyBy ? "" : "key");
    var cd = countdown(ev, readyBy || guestsAt, live, !!readyBy);
    tile(cd[0], cd[1], "count", "tcCountdown");
    var bar = h("div", { cls: "tc-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(sm.pct), "aria-label": sm.pct + "% of tasks done" }, [h("span")]);
    bar.firstChild.style.width = sm.pct + "%";
    var txt = h("span", { cls: "tc-progress-txt" }, [h("b", { text: sm.done + " of " + sm.total }), " done · " + sm.started + " started" + (sm.waiting ? " · " + sm.waiting + " not accepted yet" : "")]);
    if (sm.late) { txt.appendChild(doc.createTextNode(" · ")); txt.appendChild(h("b", { cls: "bad", text: sm.late + " late" })); }
    var foot = h("div", { cls: "tc-ev-foot" }, [h("div", { cls: "tc-progress" }, [bar, txt])]);
    var tzN = tzNote(); if (tzN) foot.appendChild(h("p", { cls: "tc-tznote", text: tzN }));
    var sig = rowSig([q.code, q.title, q.status, ev, venue, guests, guestsAt, venueOpens, readyBy, bd, sm, cd, tzN, mine]);
    if (S.sigs.head === sig) return; S.sigs.head = sig;
    clear(host); host.appendChild(main); host.appendChild(dl); host.appendChild(foot);
    host.setAttribute("aria-labelledby", "evTitle");
  }
  function tzNote() { try { var T = global.HelmStudioTime, z = tz(); if (T && !T.sameClock(z, new Date())) { var lb = T.zoneLabel(z); return "Times are in the studio’s time zone (" + lb.long + ", " + lb.abbr + ") - it’s " + T.fmt(new Date(), z) + " there now."; } } catch (e) {} return ""; }
  // the time tile: before the day "Event in 4 days"; on the day count down to Ready by (else Guests arrive)
  function countdown(ev, hm, live, isReady) {
    if (!ev) return ["Countdown", "No date yet"];
    var d = TS.dayDiff(today(), ev);
    if (S.autoWin === "wrapup" && d === 0) return ["Event", "Over"];
    if (S.autoWin === "onday" && d === -1) return ["Event day", "On now"];   // after midnight, still running
    if (!live || d !== 0) {
      if (d > 1) return ["Event in", d + " days"]; if (d === 1) return ["Event", "Tomorrow"];
      if (d < 0) return ["Event was", (-d) + (d === -1 ? " day ago" : " days ago")];
    }
    var m = /^(\d{1,2})[:.](\d{2})\s*([AaPp][Mm])?/.exec(String(hm || ""));
    if (!m) return ["Event day", "Today"];
    var hh = +m[1], mi = +m[2]; if (m[3]) { var pm = /p/i.test(m[3]); if (hh === 12) hh = pm ? 12 : 0; else if (pm) hh += 12; }
    var T = global.HelmStudioTime, at = T && T.wallToUtc ? T.wallToUtc(ev, (hh < 10 ? "0" : "") + hh + ":" + (mi < 10 ? "0" : "") + mi, tz()) : null;
    var left = at && !isNaN(at.getTime()) ? Math.round((at.getTime() - Date.now()) / 60000) : NaN;
    var lbl = isReady ? "Ready-by in" : "Guests arrive in";
    if (!isFinite(left)) return ["Event day", "Today"];
    if (left <= 0) return [isReady ? "Ready by" : "Guests arrived", left > -60 ? (-left) + " min ago" : "On now"];
    return [lbl, dur(left)];
  }
  // the three step tabs: the picked one, a "now" mark on the real one, and each step's done count
  function renderPhase() {
    var row = $("#tcPhase"); if (!row) return; var by = byStep();
    Array.prototype.forEach.call(row.querySelectorAll("[data-win]"), function (b) {
      var w = b.getAttribute("data-win"), now = w === S.autoWin, st = by[w] || { done: 0, total: 0 };
      b.setAttribute("aria-pressed", String(w === S.win));
      b.classList.toggle("is-now", now); if (now) b.setAttribute("aria-current", "step"); else b.removeAttribute("aria-current");
      var n = b.querySelector(".tc-seg-n"); if (!n) { n = h("span", { cls: "tc-seg-n" }); b.appendChild(n); }
      var txt = st.total ? st.done + "/" + st.total : "", sr = (st.total ? ", " + st.done + " of " + st.total + " tasks done" : "") + (now ? ", now" : "");
      if (n._sig !== txt + sr) { n._sig = txt + sr; clear(n); if (txt) n.appendChild(h("span", { "aria-hidden": "true", text: txt })); n.appendChild(h("span", { cls: "tc-sr", text: sr })); }
    });
  }
  /* R251: each step's cards, top to bottom. The nodes are MOVED (not hidden behind order:), so reading and tabbing follow the eye.
     While the plan is locked the lock bar goes first in every step ("bar above"); unlocked it sits just above the floor plan. */
  var ORDER = {
    daybefore: ["tcPrep", "tcDayBefore", "tcDelay", "attn", "tcReady", "work", "tcLock", "tcFloor", "tcCrewCard", "tcActCard", "trmCardOps"],
    pre: ["tcReady", "tcDelay", "attn", "tcLate", "tcIssues", "tcCrewCard", "tcLock", "tcFloor", "work", "tcPreDone", "tcActCard", "trmCardOps"],
    onday: ["tcRun", "tcDelay", "tcLate", "tcIssues", "tcActCard", "attn", "work", "tcLock", "tcFloor", "tcCrewCard", "trmCardOps"]
  };
  function renderFlow() {
    var f = $("#tcFlow"); if (!f) return; var ids = (ORDER[S.win] || ORDER.daybefore).slice();
    if (planLocked()) { ids.splice(ids.indexOf("tcLock"), 1); ids.unshift("tcLock"); }
    f.setAttribute("data-win", S.win);
    var want = ids.map(function (id) { return doc.getElementById(id); }).filter(Boolean);
    var rest = Array.prototype.filter.call(f.children, function (n) { return want.indexOf(n) < 0; });   // the cards of the other steps (hidden) stay last
    var fk = doc.activeElement && f.contains(doc.activeElement) ? doc.activeElement : null;
    want.concat(rest).forEach(function (n, i) { if (f.children[i] !== n) f.insertBefore(n, f.children[i] || null); });
    if (fk && fk !== doc.activeElement && fk.isConnected) try { fk.focus({ preventScroll: true }); } catch (e) {}
    // half-width cards come in pairs; one left alone takes the whole row, so no empty half page is left
    var half = function (n) { return n.classList.contains("tc-half") || n.id === "tcIssues" || (n.id === "attn" && S.win === "pre"); }, run = [];
    function flush() { run.forEach(function (n, i) { n.classList.toggle("is-half", !(run.length % 2 && i === run.length - 1)); }); run = []; }
    want.concat(rest).forEach(function (n) {
      if (n.hidden || (n.classList.contains("tc-attn") && !n.firstChild)) { n.classList.remove("is-half"); return; }
      if (half(n)) run.push(n); else { flush(); n.classList.remove("is-half"); }
    });
    flush();
  }
  // one filled button per step: Day before = Add & assign, Pre-event = Mark pre-event complete, On the event = Log an issue
  function renderPrimary() {
    var add = $("#addBtn"); if (!add) return;
    var pd = $("#tcPreDone"), st = stageOf(), other = S.win === "pre" ? !!(pd && !pd.hidden && S.perm && S.perm.stageEdit && ["event_day", "settlement", "closed"].indexOf(st) < 0) : S.win === "onday" ? !!$("#tcLogIssue") && !$("#tcIssues").hidden : false;
    add.classList.toggle("tc-primary", !other);
  }

  /* ---- needs attention ---- */
  // R187 (0370): can't-work requests of the people on this event (hidden when the server doesn't have the approval step).
  // always = show "No requests waiting" too (the event-day steps); Day before shows the box only when somebody asked
  function requestBox(ts, sigParts, always) {
    var shifts = B() && B().ops && B().ops.shifts;
    if (S.req && shifts && typeof shifts.decide === "function") {
      var onEvent = {}; ts.forEach(function (t) { if (t.crew_id) onEvent[t.crew_id] = 1; });
      var days = {}; ts.forEach(function (t) { days[taskDay(t)] = 1; }); days[evDate()] = 1;
      var items = (S.req.items || []).filter(function (r) { return r && r.approval === "pending" && onEvent[r.crew_id] && days[String(r.day).slice(0, 10)]; });
      sigParts.push(items.map(function (r) { return r.id; }), !!S.req.can_decide);
      if (!items.length && !always) return null;
      var rb = h("div", { cls: "tc-box " + (items.length ? "warn" : "ok"), role: "region", "aria-label": "Can't-work requests" }, [h("h3", {}, ["Can’t-work requests ", h("span", { cls: "tc-n", text: String(items.length) })])]);
      if (!items.length) rb.appendChild(h("p", { cls: "tc-aempty", text: "No requests waiting." }));
      items.forEach(function (r) {
        var n = ts.filter(function (t) { return t.crew_id === r.crew_id && t.status !== "completed" && taskDay(t) === String(r.day).slice(0, 10); }).length;
        var row = h("div", { cls: "tc-arow" }, [h("span", { cls: "grow" }, [h("b", { text: r.name || "Staff" }), " asked for " + dayWords(r.day) + " off",
          h("span", { cls: "tc-sub", text: (r.note ? "“" + r.note + "” · " : "") + "has " + n + " task" + (n === 1 ? "" : "s") + " here that day" })])]);
        if (S.req.can_decide) {
          row.appendChild(h("button", { type: "button", cls: "tc-btn sm green", text: "Approve", on: { click: function (e) { decide(e.currentTarget, r, "approve", n); } } }));
          row.appendChild(h("button", { type: "button", cls: "tc-btn sm", text: "Reject", on: { click: function (e) { decide(e.currentTarget, r, "reject", n); } } }));
        } else row.appendChild(h("span", { cls: "tc-sub", text: "An admin or someone who can edit Staff decides" }));
        rb.appendChild(row);
      });
      return rb;
    }
    return null;
  }
  function renderAttn() {
    var host = $("#attn"); if (!host) return;
    var now = Date.now(), g = G(), ts = liveTasks();
    var out = [], sigParts = [S.phase, S.win, Math.floor(now / 60000)];
    if (S.phase === "live") {
      var lateHost = $("#tcLate"), lateSig = [Math.floor(now / 60000)];
      var late = ts.filter(function (t) { return TS.isLate(t, now); }).sort(function (a, b) { return ms(a.planned_start) - ms(b.planned_start); });
      announce(late.length);
      lateSig.push(canEdit(), late.map(function (t) { return [t.id, t.status, t.planned_start, t.is_special, TS.escStep(t, S.acts, S.escCfg, now)]; }));
      var box = h("div", { cls: "tc-box bad", role: "region", "aria-label": "Late - not started" }, [h("h3", {}, ["Late - not started ", h("span", { cls: "tc-n", text: String(late.length) })])]);
      if (!late.length) { box.className = "tc-box ok"; box.appendChild(h("p", { cls: "tc-aempty", text: "Nothing late. Good." })); }
      late.slice(0, 12).forEach(function (t) {
        var step = TS.escStep(t, S.acts, S.escCfg, now), esc = TS.lastEscalation(t, S.acts);
        var info = h("span", { cls: "grow" }, [h("b", { text: t.title || "Task" }),
          h("span", { cls: "tc-sub", text: (nameOf(t) || "No one") + " · due " + clock(t.planned_start) + " · " + dur(TS.lateMin(t, now)) + " late" + (TS.baseKey(t) === "waiting" ? " · not accepted yet" : "") + (esc ? " · " + TS.escBadge(esc, clock) : "") })]);
        if (step >= 0) info.appendChild(ladderEl(step));
        var row = h("div", { cls: "tc-arow" }, [info]);
        if (canEdit() && t.crew_id && inHouse(t)) row.appendChild(h("button", { type: "button", cls: "tc-btn sm", "data-key": "nudge:" + t.id, text: "Nudge", title: "E-mail this task to " + (nameOf(t) || "them") + " again now", on: { click: function (e) { P().mail(e.currentTarget, t.id, false); } } }));
        row.appendChild(h("button", { type: "button", cls: "tc-btn sm", "data-key": "late:" + t.id, text: "Open", "aria-label": "Open " + (t.title || "task"), on: { click: function () { openTask(t.id); } } }));
        box.appendChild(row);
      });
      if (late.length > 12) box.appendChild(h("button", { type: "button", cls: "tc-btn sm ghost", text: "See all " + late.length + " late tasks", on: { click: function () { setChip("late"); toWork(); } } }));
      if (lateHost) { var ls = rowSig(lateSig); if (S.sigs.late !== ls) { S.sigs.late = ls; var lk = focusKey(lateHost); clear(lateHost); lateHost.appendChild(box); restoreFocus(lateHost, lk); } lateHost.hidden = false; }
      var rb = requestBox(ts, sigParts, true); if (rb) out.push(rb);   // R251: check-in comes first (below)
      if (S.hasSheet) {
        var nci = notCheckedIn(ts, S.sheet, now);
        sigParts.push(nci);
        var cb = h("div", { cls: "tc-box " + (nci.length ? "warn" : "ok"), role: "region", "aria-label": "Not checked in" }, [h("h3", {}, ["Not checked in ", h("span", { cls: "tc-n", text: String(nci.length) })])]);
        if (!nci.length) cb.appendChild(h("p", { cls: "tc-aempty", text: "Everyone due so far has checked in." }));
        nci.forEach(function (x) {
          var c = crewById(x.crew_id) || {}, ph = String(c.phone || "").replace(/[^\d+]/g, "");
          var row = h("div", { cls: "tc-arow" }, [avatar(c.name, x.crew_id), h("span", { cls: "grow" }, [h("b", { text: c.name || "Staff" }),
            h("span", { cls: "tc-sub", text: (x.late ? "Should be here since " : "First task at ") + clock(new Date(x.first).toISOString()) })])]);
          if (ph) row.appendChild(h("a", { cls: "tc-btn sm", href: "tel:" + ph, text: "Call", "aria-label": "Call " + (c.name || "them") }));
          cb.appendChild(row);
        });
        out.unshift(cb);
      }
    } else {
      var items2 = readyChecks(g.tasks, { clash: clashOf, unsent: unsentCount() });
      sigParts.push(items2);
      var todo = items2.filter(function (i) { return !i[0]; }).length;
      var rbox = h("div", { cls: "tc-box wide " + (todo ? "warn" : "ok"), role: "region", "aria-label": "Tasks to sort out" }, [h("h3", {}, ["Tasks to sort out ", h("span", { cls: "tc-n", text: (items2.length - todo) + " / " + items2.length })])]);
      var grid = h("div", { cls: "tc-checks" });
      items2.forEach(function (i) {
        var b = h("button", { type: "button", cls: "tc-check " + (i[0] ? "done" : "todo"), disabled: i[0] || (i[3] === "add" && !canEdit()) ? true : null },
          [h("span", { cls: "tick", "aria-hidden": "true", text: i[0] ? "✓" : "!" }), h("span", { cls: "grow", text: i[0] ? i[1] : i[2] }), i[0] ? null : h("span", { cls: "go", text: "Fix →" })]);
        if (!i[0]) b.addEventListener("click", function () { fix(i[3]); });
        grid.appendChild(b);
      });
      rbox.appendChild(grid); out.push(rbox);
      var rq = requestBox(ts, sigParts, false); if (rq) out.push(rq);
      var lh = $("#tcLate"); if (lh) lh.hidden = true;
    }
    if (out.length === 1) out[0].classList.add("wide");
    var sig = rowSig(sigParts); if (S.sigs.attn === sig) return; S.sigs.attn = sig;
    var keep = focusKey(host); clear(host); out.forEach(function (n) { host.appendChild(n); }); restoreFocus(host, keep);
  }
  // "3 late" changes are read out politely (the boxes themselves are not a live region, so nothing is shouted)
  function announce(n) { if (S.lastLate === n) return; var first = S.lastLate == null; S.lastLate = n; if (first) return; var a = $("#tcAnnounce"); if (a) a.textContent = n ? n + " task" + (n === 1 ? "" : "s") + " late" : "Nothing late"; }
  // people with open in-house tasks who got no task e-mail yet (from the activity timeline, 0368); null = can't tell
  function unsentCount() {
    if (!S.acts) return null;
    var sent = {}; S.acts.forEach(function (a) { if (a && a.kind === "email_sent" && a.crew_id) sent[a.crew_id] = 1; });
    var ppl = {}; liveTasks().forEach(function (t) { if (t.crew_id && inHouse(t) && isOpen(t)) ppl[t.crew_id] = 1; });
    return Object.keys(ppl).filter(function (id) { return !sent[id]; }).length;
  }
  function fix(k) {
    if (k === "add") { openSheet(null); return; }
    if (k === "people") setView("people"); else { S.chip = k; if (S.view === "people") S.view = "list"; }
    update(); toWork();
  }
  function toWork() { try { $("#work").scrollIntoView({ behavior: "smooth", block: "start" }); } catch (e) {} }
  async function decide(btn, r, what, n) {
    var B0 = B(), note = null;
    if (what === "reject") {
      try { note = await global.BPUI.prompt("Tell " + (r.name || "them") + " why (optional - they see this):", { title: "Turn down the day off?", label: "Note to the staff member", okLabel: "Turn down", multiline: true }); } catch (e) { note = ""; }
      if (note === null) return;
    }
    btn.disabled = true;
    try {
      await B0.ops.shifts.decide(r.id, what, note || null);
      toast(what === "approve" ? "Approved. " + (r.name || "They") + (n ? " has " + n + " open task" + (n === 1 ? "" : "s") + " here that day - give " + (n === 1 ? "it" : "them") + " to someone else (see Can’t-work clash)." : " is off that day.")
        : "Turned down. " + (r.name || "They") + " is told by e-mail.", "ok", 8000);
      await reload(true);
    } catch (e) { toast(errText(e, "save the answer"), "err"); btn.disabled = false; }
  }

  /* ---- chips + search ---- */
  function renderChips() {
    var host = $("#chips"); if (!host) return;
    var all = G().tasks || [], now = Date.now(), counts = {};
    CHIPS.forEach(function (c) { counts[c[0]] = all.filter(function (t) { return chipTest(c[0], t, now, clashOf); }).length; });
    var shown = CHIPS.filter(function (c) { return !c[0] || counts[c[0]] || c[0] === S.chip; });
    var sig = rowSig([shown.map(function (c) { return c[0]; }), counts, S.chip]); if (S.sigs.chips === sig) return; S.sigs.chips = sig;
    var keep = focusKey(host); clear(host);
    shown.forEach(function (c) {
      host.appendChild(h("button", { type: "button", cls: "tc-chip", "data-key": "chip:" + c[0], "aria-pressed": String(S.chip === c[0]),
        on: { click: function () { setChip(S.chip === c[0] && c[0] ? "" : c[0]); } } }, [c[1] + " ", h("b", { text: String(counts[c[0]]) })]));
    });
    restoreFocus(host, keep);
  }
  function setChip(k) { S.chip = k; if (S.view === "people" && k) S.view = "list"; update(); }

  /* ---- views ---- */
  function setView(v) { S.view = v; lsSet("helm.tc.view2", v); update(); }
  function renderViewBtns() { Array.prototype.forEach.call(doc.querySelectorAll("#tcViews [data-view]"), function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-view") === S.view)); }); }
  function emptyBox() {
    if (S.q || S.chip) return h("div", { cls: "tc-empty" }, [h("b", { text: "Nothing matches" }), "Try another word, or clear the filter.", h("br"),
      h("button", { type: "button", cls: "tc-btn", text: "Clear filters", on: { click: function () { S.q = ""; S.chip = ""; var i = $("#tcQ"); if (i) i.value = ""; update(); } } })]);
    return h("div", { cls: "tc-empty" }, [h("b", { text: "No tasks yet for this event" }), "Start from your studio’s checklist (stage, flowers, lighting...) and give each task to a person.", h("br"),
      canEdit() && planLocked() ? h("span", { cls: "tc-sub", text: "The plan is locked for the event day - unlock it (bar above) to add tasks." }) : canEdit() ? h("button", { type: "button", cls: "tc-btn", text: "+ Add & assign", on: { click: function () { openSheet(null); } } }) : h("span", { cls: "tc-sub", text: "Your role can view this page only. To give out work, an admin switches on \u201cAssign & send tasks\u201d for your role (Settings \u2192 Users & invites \u2192 Access control)." })]);
  }
  function narrow() { try { return global.matchMedia("(max-width:760px)").matches; } catch (e) { return false; } }
  /* R251: every view is split by step first (Day before, Pre-event, On the event, Wrap-up) with a done count each; inside a step the view
     keeps its own grouping. A step's head folds it; on a step's tab its own work is open, later work starts folded (foldDefault). */
  function renderView() {
    var v = $("#view"); if (!v) return;
    var key = S.view + (S.view === "timeline" ? (narrow() ? ":phone" : ":wide") : "");
    if (S.viewKey !== key) { clear(v); S.rows = {}; S.groups = {}; S.steps = {}; S.sigs.empty = ""; S.sigs.more = ""; S.viewKey = key; }
    var ts = filtered();
    v.setAttribute("aria-busy", "false");
    if (!ts.length) {
      S.rows = {}; S.groups = {}; S.steps = {};
      var esig = rowSig([S.q, S.chip, canEdit(), planLocked()]);
      if (!v.querySelector(".tc-empty") || S.sigs.empty !== esig) { clear(v); v.appendChild(emptyBox()); S.sigs.empty = esig; }
      return;
    }
    var em = v.querySelector(".tc-empty"); if (em) em.remove();
    var by = {}, stats = byStep(), hint = allocHint(), keepRows = {}, keepGrps = {}, at = 0;
    ts.forEach(function (t) { var w = stepOfTask(t); (by[w] = by[w] || []).push(t); });
    TS.WINDOWS.forEach(function (W) {
      var w = W[0], list = by[w], sec = S.steps[w];
      if (!list) { if (sec) { sec.el.remove(); delete S.steps[w]; } return; }
      if (!sec) sec = S.steps[w] = stepSec(W);
      var st = stats[w], late = st.tasks.filter(function (t) { return TS.isLate(t); }).length, open = !stepFolded(w), hs = rowSig([st.done, st.total, st.unassigned, late, open, w === S.win, list.length, S.q, S.chip]);
      if (sec.sig !== hs) {
        sec.sig = hs;
        sec.el.classList.toggle("is-here", w === S.win); sec.el.classList.toggle("is-folded", !open);
        clear(sec.head);
        [h("span", { cls: "fold", "aria-hidden": "true", text: "\u25be" }), h("b", { text: W[1] }), h("span", { cls: "mini", text: st.done + " of " + st.total + " done" }),
          st.unassigned ? h("span", { cls: "tc-st unassigned", text: st.unassigned + " to give out" }) : null,
          late ? h("span", { cls: "tc-st late", text: late + " late" }) : null,
          S.q || S.chip ? h("span", { cls: "mini", text: list.length + " shown" }) : null].forEach(function (n) { if (n) sec.head.appendChild(n); });
        sec.head.setAttribute("aria-expanded", String(open)); sec.body.hidden = !open;
      }
      // hint only, never blocks: pre-event work is given out before the on-event work
      var ht = w === "onday" && canEdit() ? hint : "";
      if (sec.hint.textContent !== ht) sec.hint.textContent = ht; sec.hint.hidden = !ht;
      if (S.view === "list") renderGroups(sec, w, list, keepRows, keepGrps);
      else {
        var bs = rowSig([key, list.map(rowData), S.sel, Math.floor(Date.now() / 300000), S.phase, S.view === "timeline" ? Math.round(v.clientWidth / 40) : 0, S.view === "people" ? personSig() : 0]);
        if (sec.bsig !== bs) { sec.bsig = bs; var keep = focusKey(sec.body); clear(sec.body); sec.body.appendChild(S.view === "timeline" ? viewTimeline(list, w) : viewPeople(list, w)); restoreFocus(sec.body, keep); paint(sec.body); }
      }
      if (v.children[at] !== sec.el) v.insertBefore(sec.el, v.children[at] || null);
      at++;
    });
    if (S.view === "list") {
      Object.keys(S.groups).forEach(function (k) { if (!keepGrps[k]) { var g = S.groups[k]; if (g.el.parentNode) g.el.remove(); delete S.groups[k]; } });
      Object.keys(S.rows).forEach(function (id) { if (!keepRows[id]) { var r = S.rows[id]; if (r.el.parentNode) r.el.remove(); delete S.rows[id]; } });
      renderMore(v);
    } else if (S.view === "timeline") {
      var lg = v.querySelector(".tc-legend"), any = !!v.querySelector(".tc-tl");
      if (any && !lg) v.appendChild(h("div", { cls: "tc-legend", "aria-hidden": "true" }, [
        h("span", {}, [h("i", { cls: "tc-lg-done" }), "Done"]), h("span", {}, [h("i", { cls: "tc-lg-started" }), "Started"]), h("span", {}, [h("i", { cls: "tc-lg-accepted" }), "Accepted"]),
        h("span", {}, [h("i", { cls: "tc-lg-waiting" }), "Not accepted yet"]), h("span", {}, [h("i", { cls: "tc-lg-late" }), "Late"]), h("span", { text: "▲ Special" })]));
      else if (!any && lg) lg.remove();
    }
  }
  function personSig() { return people().map(function (c) { return [c.id, S.sheet[c.id], dayInfo(c.id)]; }); }
  function stepFolded(w) { if (S.q || S.chip) return false; var k = S.win + ":" + w; return k in S.stepFold ? S.stepFold[k] : foldDefault(S.win, w, S.autoWin); }
  function stepSec(W) {
    var id = "tcs" + W[0], head = h("button", { type: "button", cls: "tc-stp-h", "data-key": "stp:" + W[0], "aria-controls": id }), hintEl = h("p", { cls: "tc-stp-hint", role: "note", hidden: true }), body = h("div", { cls: "tc-stp-b", id: id });
    head.addEventListener("click", function () { S.stepFold[S.win + ":" + W[0]] = !stepFolded(W[0]); update(); });
    return { el: h("section", { cls: "tc-stp", "data-step-of": W[0], "aria-label": W[1] + " tasks" }, [hintEl, h("h3", { cls: "tc-stp-t" }, [head]), body]), head: head, hint: hintEl, body: body, sig: "", bsig: "" };
  }
  function paint(n) { try { B().chat.paintAvatars(n); } catch (e) {} }
  function rowData(t) {
    var c = clashOf(t), ev = evidenceOf(t).length, wa = null; try { wa = P().waChip(t); } catch (e) {}
    return [t.id, t.title, t.category, t.status, t.crew_id, nameOf(t), t.assignee_kind, t.planned_start, t.planned_end, t.is_special, t.verify_status,
      t.depends_on, (waitsOf(t) || {}).text, TS.isLate(t), remText(t), c && [c.pending, c.note], ev, wa && wa.text, presState(t.crew_id), !!S.sel[t.id], t.cancel_reason];
  }
  /* ---- R230 (0399): one supervisor per department (department = the task section, t.category) ---- */
  var LOCK_ADD = "The plan is locked for the event day - unlock it (bar above) to add tasks.";
  var ROLE_WORD = { supervisor: "Supervisor", manager: "Event manager", admin: "Admin" };
  function roleWord(r) { return ROLE_WORD[String(r || "").toLowerCase()] || ""; }
  function supOf(cat) { return S.sup && (S.sup.rows || []).filter(function (r) { return r && r.department === cat && r.profile_id; })[0] || null; }
  function mineDepts() { var me = S.sup && S.sup.me; return me ? (S.sup.rows || []).filter(function (r) { return r && String(r.profile_id) === String(me); }).map(function (r) { return r.department; }) : []; }
  async function loadSup(force) {
    var D = B() && B().ops && B().ops.deptSupervisors, q = qid(); if (!D || !q) { S.sup = null; return; }
    if (!force && S.supAt && Date.now() - S.supAt < 60000) return;
    try { var r = await D.get(q); S.sup = r && typeof r === "object" ? r : null; } catch (e) { S.sup = null; }
    S.supAt = Date.now();
  }
  async function setSup(sel, cat) {
    var D = B() && B().ops && B().ops.deptSupervisors; if (!D || sel.getAttribute("aria-busy") === "true") return;
    var pid = sel.value || null, cur = supOf(cat);
    sel.setAttribute("aria-busy", "true"); sel.disabled = true;
    try {
      var r = await D.set(qid(), cat, pid);
      toast(!r || !r.changed ? "No change." : pid ? (r.name || "They") + " now supervises " + cat + (r.name ? " - they get a bell notice." : ".") : cat + " has no supervisor now.", "ok", 6000);
      await loadSup(true);
    } catch (e) {
      var m = String((e && e.message) || "");
      toast(/invalid_person/.test(m) ? "Pick a Supervisor, Event manager or Admin login of your studio." : /invalid_department/.test(m) ? "That department has no tasks on this event yet." : errText(e, "set the supervisor"), "err", 8000);
      sel.value = cur ? String(cur.profile_id) : "";
    } finally { sel.removeAttribute("aria-busy"); sel.disabled = false; Object.keys(S.groups).forEach(function (c) { S.groups[c].tsig = ""; }); update(); }
  }
  // the supervisor control of one department card: a picker for "Assign & send tasks", else the name (or nothing)
  function supTools(cat) {
    var row = supOf(cat), wrap = h("span", { cls: "tc-sup" + (row && S.sup && String(row.profile_id) === String(S.sup.me) ? " me" : "") });
    if (!S.sup) return wrap;
    var id = "sup" + Math.random().toString(36).slice(2, 8);
    if (S.sup.can_edit) {
      var sel = h("select", { cls: "tc-sup-sel", id: id, "data-key": "sup:" + cat, "aria-label": "Supervisor of " + cat });
      sel.appendChild(h("option", { value: "", text: "No supervisor" }));
      var cands = (S.sup.candidates || []).slice(), seen = {};
      cands.forEach(function (c) { seen[c.id] = 1; });
      if (row && !seen[row.profile_id]) cands.push({ id: row.profile_id, name: row.name, role: row.role });
      cands.forEach(function (c) { var o = h("option", { value: String(c.id), text: (c.name || "Team member") + (roleWord(c.role) ? " · " + roleWord(c.role) : "") }); if (row && String(row.profile_id) === String(c.id)) o.selected = true; sel.appendChild(o); });
      sel.addEventListener("change", function () { setSup(sel, cat); });
      wrap.appendChild(h("label", { cls: "tc-sup-l", "for": id, text: "Supervisor" })); wrap.appendChild(sel);
    } else if (row) {
      wrap.appendChild(h("span", { cls: "tc-sup-l", text: "Supervisor" }));
      wrap.appendChild(h("b", { cls: "tc-sup-nm", text: row.name || "Team member" }));
      if (roleWord(row.role)) wrap.appendChild(h("span", { cls: "tc-sup-role", text: roleWord(row.role) }));
    } else return wrap;
    return wrap;
  }
  // "+ Add task" inside a department: the Add & assign sheet opened on that section
  function addIn(cat) {
    if (!canEdit()) return;
    // R227 (0397): adding tasks changes the task plan - refused while the plan is locked (the supervisor stays changeable)
    if (planLocked()) { toast(LOCK_ADD, "err", 8000); return; }
    openSheet(null);
    var hit = Array.prototype.filter.call(doc.querySelectorAll("#catTabs [data-c]"), function (b) { return b.getAttribute("data-c") === cat; })[0];
    if (hit && hit.getAttribute("aria-pressed") !== "true") hit.click();
  }
  function supLogActs() {
    return ((S.sup && S.sup.log) || []).slice(0, 8).map(function (l) {
      var by = l.by || "Someone";
      return { at: l.at, kind: "supervisor", _t: l.action === "cleared" ? by + " removed " + (l.prev_name || "the") + " as " + l.department + " supervisor"
        : by + " set " + (l.name || "someone") + " as " + l.department + " supervisor" };
    });
  }
  /* List = Tasks by department inside one step: one card per section, rows keyed by task id; only rows whose content changed are redrawn */
  function renderGroups(sec, step, ts, keepRows, keepGrps) {
    var v = sec.body, cats = (G().CATS || []).slice(); ts.forEach(function (t) { var c = t.category || "Other"; if (cats.indexOf(c) < 0) cats.push(c); });
    var by = {}; ts.forEach(function (t) { var c = t.category || "Other"; (by[c] = by[c] || []).push(t); });
    var order = cats.filter(function (c) { return by[c]; });
    var many = liveTasks().length > 80, mine = mineDepts(), stepTasks = byStep()[step].tasks;
    order.forEach(function (cat, gi) {
      var gk = step + "|" + cat, g = S.groups[gk]; keepGrps[gk] = 1;
      if (!g) {
        var id = "tcg" + Math.random().toString(36).slice(2, 8);
        var head = h("button", { type: "button", cls: "tc-grp-h", "data-key": "grp:" + gk, "aria-expanded": "true", "aria-controls": id });
        var tools = h("div", { cls: "tc-grp-tools" });
        var rows = h("div", { cls: "tc-grp-rows", id: id, role: "list", "aria-label": cat });
        g = S.groups[gk] = { el: h("section", { cls: "tc-grp tc-dept", "data-cat": cat, "aria-label": cat }, [h("div", { cls: "tc-grp-top" }, [head, tools]), rows]), head: head, tools: tools, rows: rows, sig: "", tsig: "" };
        if (many && S.folded[gk] == null) S.folded[gk] = !by[cat].some(function (t) { return TS.isLate(t) || noOne(t); });
        head.addEventListener("click", function () { S.folded[gk] = !S.folded[gk]; S.groups[gk].sig = ""; update(); });
      }
      var all = stepTasks.filter(function (t) { return (t.category || "Other") === cat; }), done = all.filter(function (t) { return t.status === "completed"; }).length;
      var late = all.filter(function (t) { return TS.isLate(t); }).length;
      var folded = !!S.folded[gk] && !S.q && !S.chip;
      var gs = rowSig([cat, done, all.length, late, folded]);
      if (g.sig !== gs) {
        g.sig = gs; clear(g.head);
        var gb = h("span", { cls: "tc-gbar", "aria-hidden": "true" }, [h("span")]); gb.firstChild.style.width = (all.length ? Math.round(done / all.length * 100) : 0) + "%";
        g.head.appendChild(h("span", { cls: "fold", "aria-hidden": "true", text: "\u25be" }));
        g.head.appendChild(h("b", { text: cat })); g.head.appendChild(gb); g.head.appendChild(h("span", { cls: "mini", text: done + "/" + all.length + " done" }));
        if (late) g.head.appendChild(h("span", { cls: "tc-st late", text: late + " late" }));
        g.head.setAttribute("aria-expanded", String(!folded)); g.head.setAttribute("aria-label", cat + ", " + done + " of " + all.length + " done" + (late ? ", " + late + " late" : "") + (folded ? ", folded" : ""));
        g.rows.hidden = folded;
        g.el.classList.toggle("is-folded", folded);
      }
      // R230: the department's supervisor + "+ Add task" (rebuilt only when they change; never while its picker has focus)
      var sr = supOf(cat), ts2 = rowSig([cat, !!S.sup, S.sup && S.sup.can_edit, sr && [sr.profile_id, sr.name, sr.role], S.sup && (S.sup.candidates || []).map(function (c) { return c.id + c.name + c.role; }), canEdit(), mine.indexOf(cat) >= 0, planLocked()]);
      if (g.tsig !== ts2 && !(doc.activeElement && g.tools.contains(doc.activeElement) && doc.activeElement.tagName === "SELECT")) {
        g.tsig = ts2; clear(g.tools);
        if (mine.indexOf(cat) >= 0) g.tools.appendChild(h("span", { cls: "tc-tag box tc-you", text: "You supervise" }));
        g.tools.appendChild(supTools(cat));
        if (canEdit()) g.tools.appendChild(h("button", { type: "button", cls: "tc-btn sm tc-add-in" + (planLocked() ? " is-locked" : ""), "data-key": "add:" + gk, text: planLocked() ? "\ud83d\udd12 Add task" : "+ Add task",
          "aria-label": planLocked() ? "Add a task in " + cat + " - locked: unlock the plan first" : "Add a task in " + cat, "aria-disabled": planLocked() ? "true" : null, title: planLocked() ? LOCK_ADD : null, on: { click: function () { S.addStep = step; addIn(cat); S.addStep = null; } } }));
        g.el.classList.toggle("is-mine", mine.indexOf(cat) >= 0);
      }
      // rows
      var ids = [];
      by[cat].forEach(function (t) {
        var sig = rowSig(rowData(t)), r = S.rows[t.id]; keepRows[t.id] = 1;
        if (!r || r.sig !== sig) {
          var el = rowEl(t), old = r && r.el;
          if (old && old.parentNode) { var fk = focusKey(old); old.parentNode.replaceChild(el, old); restoreFocus(el, fk); }
          S.rows[t.id] = r = { el: el, sig: sig };
          paint(el);
        }
        ids.push(t.id);
      });
      // order (only touch the DOM when the order changed)
      var cur = Array.prototype.map.call(g.rows.children, function (n) { return n.getAttribute("data-id"); });
      if (cur.join("|") !== ids.map(String).join("|")) { var fk2 = focusKey(g.rows); ids.forEach(function (id) { g.rows.appendChild(S.rows[id].el); }); restoreFocus(g.rows, fk2); }
      // group order
      if (v.children[gi] !== g.el) v.insertBefore(g.el, v.children[gi] || null);
    });
  }
  // R230: the departments of the checklist with no task on this event yet - one quiet line, "+ name" adds a task there
  function renderMore(v) {
    var rest = (S.q || S.chip || !canEdit() || planLocked()) ? [] : (G().CATS || []).filter(function (c) { return !liveTasks().some(function (t) { return (t.category || "Other") === c; }); });
    var es = rowSig(rest), strip = v.querySelector(".tc-dept-more");
    if (!rest.length) { if (strip) strip.remove(); S.sigs.more = ""; return; }
    if (!strip || S.sigs.more !== es) {
      if (strip) strip.remove();
      strip = h("div", { cls: "tc-dept-more" }, [h("span", { cls: "tc-sub", text: "No tasks yet:" })]);
      rest.forEach(function (c) { strip.appendChild(h("button", { type: "button", cls: "tc-chip", "data-key": "more:" + c, text: "+ " + c, "aria-label": "Add a task in " + c, on: { click: function () { addIn(c); } } })); });
      S.sigs.more = es;
    }
    if (strip.parentNode !== v || v.lastChild !== strip) v.appendChild(strip);
  }
  function rowEl(t) {
    var cb = canEdit() && t.status !== "cancelled", nm = nameOf(t), k = TS.shown(t);
    var row = h("div", { cls: "tc-row" + (cb ? "" : " nocheck") + (S.sel[t.id] ? " sel" : "") + (k === "late" ? " is-late" : "") + (t.status === "cancelled" ? " is-cancelled" : ""), "data-id": String(t.id), role: "listitem", id: "task-" + t.id });
    if (cb) {
      var box = h("input", { type: "checkbox", "data-key": "sel:" + t.id, "aria-label": "Select " + (t.title || "task") });
      box.checked = !!S.sel[t.id];
      box.addEventListener("change", function () { if (box.checked) S.sel[t.id] = 1; else delete S.sel[t.id]; row.classList.toggle("sel", box.checked); renderBulk(); });
      row.appendChild(box);
    }
    var who = h("span", { cls: "tc-r-who" + (nm ? "" : " none") }, nm ? [avatar(nm, t.crew_id), h("span", { cls: "nm", text: nm })] : ["Not assigned"]);
    var main = h("button", { type: "button", cls: "tc-r-main", "data-key": "open:" + t.id, "aria-label": (t.title || "Task") + ", " + TS.LABEL[k] + (nm ? ", " + nm : ", not assigned") + (t.planned_start ? ", " + when(t.planned_start) : ", no start time"),
      on: { click: function () { openTask(t.id); } } }, [
      timeCell(t),
      h("span", { cls: "tc-r-title" }, [h("b", { text: t.title || "Task" }), h("span", { cls: "tc-r-meta" }, tags(t))]),
      who, h("span", { cls: "tc-r-st" }, [stPill(t)]), h("span", { cls: "tc-chev", "aria-hidden": "true", text: "›" })]);
    row.appendChild(main);
    // R230: the quick links of the old direct layout - send this task again (e-mail / WhatsApp) or give it to someone
    if (canEdit() && t.status !== "cancelled") {
      var acts = [];
      if (isOpen(t) && inHouse(t) && (t.crew_id || t.assignee_phone)) {
        acts.push(h("button", { type: "button", cls: "tc-lnk", "data-key": "mail:" + t.id, text: "Email", title: "E-mail this task to " + (nm || "the person") + " now", "aria-label": "Email " + (t.title || "this task") + " to " + (nm || "the person"), on: { click: function (e) { P().mail(e.currentTarget, t.id, false); } } }));
        acts.push(h("button", { type: "button", cls: "tc-lnk", "data-key": "wa:" + t.id, text: "WhatsApp", title: "Send this task on WhatsApp (the studio number)", "aria-label": "Send " + (t.title || "this task") + " on WhatsApp", on: { click: function (e) { P().wa(e.currentTarget, t.id); } } }));
      } else if (noOne(t)) acts.push(h("button", { type: "button", cls: "tc-lnk strong", "data-key": "give:" + t.id, text: "Assign", "aria-label": "Give " + (t.title || "this task") + " to someone", on: { click: function () { openSheet([String(t.id)]); } } }));
      if (acts.length) { row.classList.add("has-acts"); row.appendChild(h("span", { cls: "tc-r-acts" }, acts)); }
    }
    return row;
  }
  /* Timeline of one step: one lane per section, hours along the top, the Now / Guests arrive labels in their own strip above the lanes
     (R251: they used to sit on top of the blocks) and their lines behind the blocks. A block is never narrower than its words: short
     jobs get a readable width and the lane makes room (extra rows). Phone / narrow: hour-by-hour agenda (no sideways scroll). */
  var BLK_PX = 168, BLK_ROW = 74;
  function viewTimeline(ts, step) {
    var wrap = h("div", { cls: "tc-tlwrap" });
    var ev = evDate(), groups = { before: [], day: [], after: [], none: [] };
    ts.forEach(function (t) { var s = slot(t, ev, wall), w = s.where === "night" ? "day" : s.where; if (s.where === "night") s.min += 1440; (groups[w] || groups.none).push({ t: t, s: s }); });
    function rowsOf(list) { var rows = h("div", { role: "list" }); list.forEach(function (x) { rows.appendChild(rowEl(x.t)); }); return rows; }
    function fold(lbl, list) {
      if (!list.length) return null;
      var d = h("details", { cls: "tc-fold" }); d.open = true;
      d.appendChild(h("summary", { text: lbl + " (" + list.length + ")" })); d.appendChild(rowsOf(list));
      return d;
    }
    if (groups.before.length) wrap.appendChild(rowsOf(groups.before));
    var day = groups.day, nowW = wall(new Date().toISOString()), dd = nowW && ev ? TS.dayDiff(ev, nowW.ymd) : NaN, nowMin = dd === 0 ? nowW.min : dd === 1 && nowW.min < 360 ? nowW.min + 1440 : null;
    var q = G().quote || {}, gm = P() && P().evTimeHM ? P().evTimeHM() : null, guestMin = gm ? (+gm.slice(0, 2)) * 60 + (+gm.slice(3, 5)) : null;
    if (day.length && narrow()) {
      var hrs = {}, order = [];
      day.forEach(function (x) { var hh = Math.floor(x.s.min / 60); if (!hrs[hh]) { hrs[hh] = []; order.push(hh); } hrs[hh].push(x); });
      order.sort(function (a, b) { return a - b; });
      var first = order[0] * 60, last = order[order.length - 1] * 60 + 60, nowShown = nowMin == null || nowMin < first || nowMin > last;
      order.forEach(function (hh) {
        if (!nowShown && hh * 60 > nowMin) { wrap.appendChild(h("div", { cls: "tc-agenda-h now", text: "Now " + clock(new Date().toISOString()) })); nowShown = true; }
        wrap.appendChild(h("div", { cls: "tc-agenda-h", text: hourLabel(hh * 60) + (guestMin != null && guestMin >= hh * 60 && guestMin < hh * 60 + 60 ? " · Guests arrive " + (q.eventTime || "") : "") }));
        wrap.appendChild(rowsOf(hrs[hh]));
      });
      if (!nowShown) wrap.appendChild(h("div", { cls: "tc-agenda-h now", text: "Now " + clock(new Date().toISOString()) }));
    } else if (day.length) {
      var lo = Infinity, hi = -Infinity, lastStart = -Infinity;
      day.forEach(function (x) { var e = ms(x.t.planned_end), d = isFinite(e) && e > ms(x.t.planned_start) ? (e - ms(x.t.planned_start)) / 60000 : 60; x.e = Math.min(1800, x.s.min + d); if (x.s.min < lo) lo = x.s.min; if (x.e > hi) hi = x.e; if (x.s.min > lastStart) lastStart = x.s.min; });
      // Now widens the picture only by an hour or two (never a half-empty day); Guests arrive closes Pre-event and opens On the event
      if (nowMin != null && nowMin > lo - 120 && nowMin < hi + 120) { lo = Math.min(lo, nowMin); hi = Math.max(hi, nowMin + 15); }
      if (guestMin != null && ((step === "pre" && guestMin < hi + 360) || (step === "onday" && guestMin > lo - 360))) { lo = Math.min(lo, guestMin); hi = Math.max(hi, guestMin + 15); }
      var start = Math.max(0, Math.floor(lo / 60) * 60), end = Math.ceil(hi / 60) * 60; if (end - start < 240) end = start + 240;
      var px = Math.max(360, (($("#view") || {}).clientWidth || 900) - 136);
      for (var k = 0; k < 8 && lastStart + (end - start) * BLK_PX / px > end; k++) end += 60;      // the last block's words fit too
      var span = end - start, H = span / 60, minMin = span * BLK_PX / px, step2 = H > 16 ? 3 : H > 10 ? 2 : 1;
      var pct = function (m) { return ((Math.max(start, Math.min(end, m)) - start) / span * 100).toFixed(2) + "%"; };
      var tl = h("div", { cls: "tc-tl" }), hours = h("div", { cls: "tc-tl-hours", "aria-hidden": "true" });
      for (var i = 0; i <= H; i += step2) { var sp = h("span", { text: hourLabel(start + i * 60) }); sp.style.left = (i / H * 100) + "%"; if (i === H) sp.style.transform = "translateX(-100%)"; hours.appendChild(sp); }
      tl.appendChild(h("div", { cls: "tc-tl-axis" }, [h("span"), hours]));
      var marks = [];
      if (guestMin != null && guestMin >= start && guestMin <= end) marks.push(["guests", guestMin, "Guests arrive " + (q.eventTime || "")]);
      if (nowMin != null && nowMin >= start && nowMin <= end) marks.push(["now", nowMin, "Now " + clock(new Date().toISOString())]);
      if (marks.length) {
        var mk = h("div", { cls: "tc-tl-marks" + (marks.length > 1 ? " two" : "") });
        marks.forEach(function (m, n) { var el = h("i", { cls: m[0], text: m[2] }); el.style.left = pct(m[1]); el.style.top = (n * 20) + "px";
          if (m[1] > start + span * .8) el.style.transform = "translateX(-100%)"; mk.appendChild(el); });
        tl.appendChild(h("div", { cls: "tc-tl-axis" }, [h("span"), mk]));
      }
      var body = h("div", { cls: "tc-tl-body" }), ov = h("div", { cls: "tc-tl-overlay", "aria-hidden": "true" });
      marks.forEach(function (m) { var ln = h("span", { cls: "tc-tl-line " + m[0] }); ln.style.left = pct(m[1]); ov.appendChild(ln); });
      body.appendChild(ov);
      var lanes = [], by = {};
      day.forEach(function (x) { var c = x.t.category || "Other"; if (!by[c]) { by[c] = []; lanes.push(c); } by[c].push(x); });
      var cats = G().CATS || []; lanes.sort(function (a, b) { var ia = cats.indexOf(a), ib = cats.indexOf(b); return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib); });
      lanes.forEach(function (c) {
        var st = stackRows(by[c].map(function (x) { return { id: x.t.id, s: x.s.min, e: Math.max(x.e, x.s.min + minMin) }; }));
        var track = h("div", { cls: "tc-tl-track", role: "list", "aria-label": c });
        track.style.minHeight = (st.rows * BLK_ROW + 8) + "px";
        for (var g2 = step2; g2 < H; g2 += step2) { var gl = h("span", { cls: "tc-tl-grid", "aria-hidden": "true" }); gl.style.left = (g2 / H * 100) + "%"; track.appendChild(gl); }
        by[c].forEach(function (x) {
          var t = x.t, kk = TS.shown(t), nm = nameOf(t), w = (Math.min(end, x.e) - Math.max(start, x.s.min)) / span * 100;
          var b = h("button", { type: "button", cls: "tc-blk " + kk, "data-key": "blk:" + t.id,
            title: [t.title, clock(t.planned_start), nm || "not assigned", TS.LABEL[kk]].join(" - "),
            "aria-label": (t.title || "Task") + ", " + clock(t.planned_start) + ", " + (nm || "not assigned") + ", " + TS.LABEL[kk],
            on: { click: function () { openTask(t.id); } } }, [h("b", { text: (t.is_special ? "▲ " : "") + (t.title || "Task") }), h("span", { text: clock(t.planned_start) + (nm ? " · " + nm.split(/\s+/)[0] : "") }), h("span", { text: TS.LABEL[kk] })]);
          var li = h("div", { cls: "tc-blk-li", role: "listitem" }, [b]);
          li.style.top = (5 + st.rowOf[t.id] * BLK_ROW) + "px"; li.style.left = pct(x.s.min); li.style.width = "max(" + (BLK_PX - 4) + "px, calc(" + Math.max(1, w).toFixed(2) + "% - 4px))";
          track.appendChild(li);
        });
        body.appendChild(h("div", { cls: "tc-tl-lane" }, [h("div", { cls: "tc-tl-name", title: c, text: c }), track]));
      });
      tl.appendChild(body);
      wrap.appendChild(tl);
    }
    addTo(wrap, fold(step === "wrapup" ? "The next day" : "After the event day", groups.after));
    addTo(wrap, fold("No start time yet - these get no reminders", groups.none));
    return wrap;
  }
  /* By person: check-in, workload, their tasks in time order, Email / WhatsApp / permanent link */
  function viewPeople(ts, step) {
    var ppl = people();
    var loads = ppl.map(function (c) { return liveTasks().filter(function (t) { return t.crew_id === c.id; }).reduce(function (a, t) { var e = ms(t.planned_end), s = ms(t.planned_start); return a + (isFinite(e) && isFinite(s) && e > s ? (e - s) / 60000 : 60); }, 0); });
    var avg = loads.length ? loads.reduce(function (a, b) { return a + b; }, 0) / loads.length : 0, max = Math.max.apply(null, loads.concat([0]));
    var grid = h("div", { cls: "tc-ppl" });
    ppl.forEach(function (c, i) {
      var mine = ts.filter(function (t) { return t.crew_id === c.id; });
      if (!mine.length) return;   // R251: nothing in this step (they show under the step they work in)
      var all = liveTasks().filter(function (t) { return t.crew_id === c.id; }), done = all.filter(function (t) { return t.status === "completed"; }).length;
      var heavy = ppl.length > 2 && loads[i] === max && loads[i] > avg * 1.4;
      var io;
      if (S.phase === "plan") io = availPill(c.id);
      else io = ioPill(c.id);
      var card = h("section", { cls: "tc-pc" + (heavy ? " heavy" : ""), "aria-label": c.name || "Staff" }, [
        h("div", { cls: "tc-pc-h" }, [avatar(c.name, c.id, true), h("span", { cls: "grow" }, [h("b", { text: c.name || "Staff" }), h("small", { text: [c.department, c.phone].filter(Boolean).join(" · ") })]), io])]);
      var di = dayInfo(c.id), off = di.state === "off" || di.state === "asked" ? di : null;
      if (off) card.appendChild(h("div", { cls: "tc-offnote", text: (off.state === "asked" ? "Asked for " + (off.day === evDate() ? "this day" : dayWords(off.day)) + " off - waiting for an answer" : "Day off approved" + (off.day === evDate() ? "" : " for " + dayWords(off.day))) + (off.note ? " · “" + off.note + "”" : "") }));
      else if (di.state === "busy") card.appendChild(h("div", { cls: "tc-offnote", text: "Also working on " + di.codes.filter(Boolean).join(", ") + (di.day && di.day !== evDate() ? " on " + dayWords(di.day) : " that day") }));
      var gb = h("span", { cls: "tc-gbar", "aria-hidden": "true" }, [h("span")]); gb.firstChild.style.width = (all.length ? Math.round(done / all.length * 100) : 0) + "%";
      card.appendChild(h("div", { cls: "tc-load" }, [h("span", { text: all.length + " task" + (all.length === 1 ? "" : "s") + " in all · " + (loads[i] / 60).toFixed(1) + " h" }), gb, h("span", { text: done + " done" }), heavy ? h("span", { cls: "tc-tag warn", text: "Most work" }) : null]));
      var ul = h("ul");
      mine.forEach(function (t) { ul.appendChild(h("li", {}, [h("button", { type: "button", "data-key": "pt:" + t.id, "aria-label": (t.title || "Task") + ", " + TS.LABEL[TS.shown(t)], on: { click: function () { openTask(t.id); } } },
        [h("span", { cls: "t", text: t.planned_start ? clock(t.planned_start) : "no time" }), h("span", { cls: "grow", text: t.title || "Task" }), stPill(t)])])); });
      card.appendChild(ul);
      if (canEdit()) {
        var open = all.filter(function (t) { return isOpen(t) && inHouse(t); })[0];
        var acts = h("div", { cls: "tc-pc-acts" });
        if (open) {
          acts.appendChild(h("button", { type: "button", cls: "tc-btn sm", "data-key": "pm:" + c.id, text: "Email tasks", "aria-label": "Send " + c.name + " their tasks by e-mail", on: { click: function (e) { P().mail(e.currentTarget, open.id, true); } } }));
          acts.appendChild(h("button", { type: "button", cls: "tc-btn sm", "data-key": "pw:" + c.id, text: "WhatsApp", "aria-label": "Send " + c.name + " their tasks on WhatsApp", on: { click: function (e) { P().wa(e.currentTarget, open.id); } } }));
        }
        if (c.id) { try { P().permLink(c.id); } catch (e) {}
          acts.appendChild(h("button", { type: "button", cls: "tc-btn sm", "data-key": "pl:" + c.id, text: "Copy permanent link", title: "One link for this person that always shows all their tasks on every event", on: { click: function (e) { P().copyLink(e.currentTarget, c.id); } } })); }
        var link = null; try { link = P().workerLink(c.phone || (all[0] && all[0].assignee_phone)); } catch (e) {}
        if (link) acts.appendChild(h("button", { type: "button", cls: "tc-btn sm ghost", "data-key": "pe:" + c.id, text: "Copy event-only link", title: "This person's link for this event only", on: { click: function () { if (P().copyNow(link, null)) toast("Event link copied.", "ok", 2500); else global.BPUI.prompt("Copy this link:", { title: "Event-only link", label: "Event-only link", value: link, okLabel: "Done" }); } } }));
        if (acts.firstChild) card.appendChild(acts);
      }
      grid.appendChild(card);
    });
    // vendors and tasks with no one, so nothing is hidden in this view
    var rest = ts.filter(function (t) { return !t.crew_id || !inHouse(t); });
    if (rest.length) {
      var rc = h("section", { cls: "tc-pc", "aria-label": "Vendors and not assigned" }, [h("div", { cls: "tc-pc-h" }, [h("span", { cls: "tc-av lg", "aria-hidden": "true", text: "?" }), h("span", { cls: "grow" }, [h("b", { text: "Vendors and not assigned" }), h("small", { text: rest.length + " task" + (rest.length === 1 ? "" : "s") })])])]);
      var ul2 = h("ul"); rest.forEach(function (t) { ul2.appendChild(h("li", {}, [h("button", { type: "button", "data-key": "pt:" + t.id, on: { click: function () { openTask(t.id); } } }, [h("span", { cls: "t", text: t.planned_start ? clock(t.planned_start) : "no time" }), h("span", { cls: "grow", text: (t.title || "Task") + (t.assignee_name ? " - " + t.assignee_name : "") }), stPill(t)])])); });
      rc.appendChild(ul2); grid.appendChild(rc);
    }
    return grid;
  }
  // before the event: is this person free on the event day (day off / other event / free)
  function bookedOn(crewId, day) {
    var m = S.dayStat[day]; if (m === undefined || m === null) {
      // no crew_day_status answer for that day: the staff suggestions know the event day only
      if (day !== evDate()) return null; var s = (G().suggest || {})[crewId]; return s ? (s.available === false && !offOn(crewId, day) ? [""] : []) : null; }
    return m[crewId] || [];
  }
  function dayInfo(crewId) { return crewDay(crewId, G().tasks, evDate(), taskDay, offOn, bookedOn); }
  function busyOther(crewId) { return dayInfo(crewId).state === "busy"; }
  function availPill(crewId) {
    var a = availWord(dayInfo(crewId), evDate(), function (d) { return dayWords(d); });
    return h("span", { cls: "tc-io " + a.cls, text: a.short, title: a.title || null });
  }
  function ioPill(crewId) {
    if (!S.hasSheet) return null;
    var a = att(crewId), e = S.sheet[crewId] || {}, fs = firstOpen(crewId);
    if (a.state === "in") return h("span", { cls: "tc-io " + (a.late ? "late" : "in"), text: "In " + (e.inAt ? clock(e.inAt) : e.in) + (a.late ? " · " + dur(a.lateMin) + " late" : "") });
    if (a.state === "out") return h("span", { cls: "tc-io out", text: "Out " + (e.outAt ? clock(e.outAt) : e.out) });
    if (isFinite(fs) && fs < Date.now()) return h("span", { cls: "tc-io late", text: "Not in - late" });
    return h("span", { cls: "tc-io none", text: isFinite(fs) ? "Due " + clock(new Date(fs).toISOString()) : "Not in yet" });
  }

  /* ---- right column: Crew today + Latest ---- */
  function renderSide() {
    var crewHost = $("#crewList"), feed = $("#feed"); if (!crewHost || !feed) return;
    var ppl = people(), live = S.phase === "live";
    var rank = function (c) { var p = presState(c.id); return p === "late" ? 0 : (!S.hasSheet || att(c.id).state === "none") ? 1 : att(c.id).state === "in" ? 2 : 3; };
    var sorted = ppl.slice().sort(function (a, b) { return (live ? rank(a) - rank(b) : 0) || String(a.name || "").localeCompare(String(b.name || "")); });
    var sig = rowSig([live, sorted.map(function (c) { var o = offOn(c.id, evDate()); return [c.id, c.name, presState(c.id), S.sheet[c.id], o, dayInfo(c.id), liveTasks().filter(function (t) { return t.crew_id === c.id && isOpen(t); }).length]; }), (S.acts || []).slice(0, 8).map(function (a) { return [a.at, a.kind, a.task_id]; }), supLogActs()]);
    if (S.sigs.side === sig) return; S.sigs.side = sig;
    $("#crewH").firstChild.nodeValue = live ? "Crew today " : "Crew on this event ";
    var inN = ppl.filter(function (c) { return S.hasSheet && att(c.id).state === "in"; }).length;
    $("#crewCount").textContent = live && S.hasSheet ? inN + " of " + ppl.length + " in" : ppl.length + (ppl.length === 1 ? " person" : " people");
    clear(crewHost);
    if (!sorted.length) crewHost.appendChild(h("li", { cls: "tc-sub", text: "No staff on this event yet. Add staff on the Staff page, then give them tasks here." }));
    sorted.forEach(function (c) {
      var open = liveTasks().filter(function (t) { return t.crew_id === c.id && isOpen(t); }).length, io;
      if (!live) io = availPill(c.id);
      else io = ioPill(c.id);
      crewHost.appendChild(h("li", {}, [avatar(c.name, c.id), h("span", { cls: "grow" }, [h("b", { text: c.name || "Staff" }), h("small", { text: open + " open" + (c.department ? " · " + c.department : "") })]), io]));
    });
    paint(crewHost);
    clear(feed);
    var acts = (S.acts || []).slice(0, 8).concat(supLogActs()).sort(function (a, b) { return ms(b.at) - ms(a.at); }).slice(0, 8);
    if (!acts.length) feed.appendChild(h("li", { cls: "tc-sub", text: S.acts ? "Nothing yet - starts, replies, check-ins and e-mails show here." : "Updates show here once the latest database update is in." }));
    acts.forEach(function (a) {
      var tone = a.kind === "escalated" || a.kind === "rejected" || a.kind === "cancelled" ? "bad" : a.kind === "time_changed" || a.kind === "check_edit" || a.kind === "dayoff_asked" ? "warn" : "";
      var ic = { completed: "✓", started: "▶", accepted: "✓", rejected: "✕", escalated: "!", check_in: "→", check_out: "←", email_sent: "@", assigned: "+", reassigned: "↻", cancelled: "–", time_changed: "◷", special_on: "▲", dayoff_asked: "?", dayoff_approved: "✓" }[a.kind] || "•";
      if (a.kind === "supervisor") ic = "★";
      feed.appendChild(h("li", {}, [h("span", { cls: "tc-fi " + tone, "aria-hidden": "true", text: ic }), h("span", {}, [a._t || TS.actText(a, when), h("time", { text: when(a.at) })])]));
    });
  }

  /* ======================= the steps' cards: Day before = get set up, On the event = run-sheet / issues; Wrap-up (event-steps.js) ======================= */
  function qid() { return G().quoteId || ""; }
  function enc(v) { return encodeURIComponent(v || ""); }
  function builderHref() { try { if (global.HelmUrl && global.HelmUrl.build) return global.HelmUrl.build("floor-plan", { id: qid() }); } catch (e) {} return "builder.html?quote=" + enc(qid()); }
  function stageOf() { var q = G().quote || {}; return String(q.lifecycleStage || q.lifecycle_stage || ""); }
  function card(id, show) { var n = $("#" + id); if (n) n.hidden = !show; return show ? n : null; }
  // Day before: shortcuts to everything that has to be set up (each page checks its own permission)
  function renderPrep() {
    var host = card("tcPrep", S.win === "daybefore" && G().quote && G().quote.status !== "cancelled"); if (!host) return;
    var rsN = Array.isArray(S.rs) ? S.rs.length : null;
    var EPx = global.HelmEventPlan, ra = EPx && S.plan && S.plan.ready_by ? EPx.readyAt(S.plan, evDate(), "", tz()) : NaN, rdy = EPx && S.plan ? (isFinite(ra) ? clock(new Date(ra).toISOString()) : "not set") : "";
    var sig = rowSig([rsN, qid(), rdy]); if (S.sigs.prep === sig) return; S.sigs.prep = sig;
    var links = [
      ["Crew", "staff.html", "Add people, departments and logins"],
      ["Stock", "resources.html?quote=" + enc(qid()), "What this event needs from Inventory and what is still missing"],
      ["Vendors", "vendors.html", "Vendors you can give work to"],
      ["Run-sheet" + (rsN == null ? "" : rsN ? " · " + rsN : " · empty"), "runsheet.html?quote=" + enc(qid()), "The minute-by-minute plan for the day"],
      ["Floor layout", builderHref(), "Open the 2D / 3D layout and the measure tool"],
      ["Ready check", "ready.html?quote=" + enc(qid()), "Is the event ready? Staff, stock, vendors, payments and the run-sheet"]
    ];
    clear(host);
    host.appendChild(h("h3", { cls: "tc-prep-h", text: "Get set up" }));
    var row = h("div", { cls: "tc-prep-links" });
    links.forEach(function (l) { row.appendChild(h("a", { cls: "tc-chip tc-link", href: l[1], title: l[2], text: l[0] })); });
    // Venue opens / Ready by are set on the Ready-by card, which lives in the Pre-event step - one tap away while planning
    if (rdy) row.appendChild(h("button", { type: "button", cls: "tc-chip", "data-key": "prep:ready", text: "Ready by · " + rdy, title: "Venue opens, Ready by and how long each set-up job takes (Pre-event step)",
      on: { click: function () { try { $("#tcReady").scrollIntoView({ block: "start" }); } catch (e) {} } } }));
    host.appendChild(row);
  }
  // R226 (0396, event-plan.js - the same cards as the monitor): Day before = the checklist; Pre-event = Ready by + the latest start
  // of each set-up job. Hidden before 0396 (no plan). Not redrawn while one of its forms is open.
  function planCtx() {
    var q = G().quote || {};
    return { plan: S.plan, tasks: G().tasks, quoteId: qid(), eventDate: evDate(), eventTime: String(q.eventTime || "").trim(), tz: tz(), now: Date.now(),
      nameOf: nameOf, toast: function (m, t) { toast(m, t === "err" ? "err" : "ok"); }, onChanged: planChanged, status: String(q.status || ""), locked: planLocked() };
  }
  async function planChanged() { await loadPlan(true); try { if (P() && P().reload) await P().reload(); } catch (e) {} S.sigs.dayb = S.sigs.ready = ""; update(); }
  async function loadPlan(force) {
    var D = B() && B().ops && B().ops.dayPlan; if (!D || !qid()) { S.plan = null; return; }
    if (!force && Date.now() - S.planAt < 60000) return;
    try { S.plan = await D.get(qid()); } catch (e) { S.plan = null; } S.planAt = Date.now();
  }
  function renderPlan() {
    var EP = global.HelmEventPlan, cancelled = (G().quote || {}).status === "cancelled", ui = EP && EP._ui;
    var dHost = card("tcDayBefore", !!(EP && S.plan) && !cancelled && S.win === "daybefore");
    var rHost = card("tcReady", !!(EP && S.plan) && !cancelled && (S.win === "daybefore" || S.win === "pre"));
    if (ui && (ui.edit || ui.times || ui.settings)) return;   // a form is open: keep what the person is typing
    var tsig = (G().tasks || []).map(function (t) { return [t.id, t.title, t.status, t.duration_min, t.depends_on, t.planned_start, t.started_at, t.completed_at, t.crew_id]; });
    var sig = rowSig([S.plan, tsig, Math.floor(Date.now() / 60000), S.win, planLocked()]);
    if (dHost && S.sigs.dayb !== sig) { S.sigs.dayb = sig; EP.renderDayBefore(dHost, planCtx()); }
    if (rHost && S.sigs.ready !== sig) { S.sigs.ready = sig; EP.renderReady(rHost, planCtx()); }
  }
  // R227 (0397, event-floor.js): the plan lock bar + the saved floor plan (R251: every step - below the work on the event). Hidden before
  // 0397. While locked the task plan is frozen (the database refuses it): "+ Add & assign" and the Ready-by edits are hidden;
  // status, reassigning, check-ins, proof, issues and reminders keep working.
  /* R252 (event-delay.js, the same card on the monitor): what is running late and what that affects. Worked out from what the page already
     has - no extra read; the one-minute clock redraws it. "Move the later tasks" opens the bulk Set time panel (its button is the confirm). */
  function delayRes() {
    var HD = global.HelmDelay; if (!HD) return null; if (M.dly !== undefined) return M.dly;
    var q = G().quote || {};
    try { M.dly = HD.compute({ tasks: G().tasks, runsheet: Array.isArray(S.rs) ? S.rs : [], plan: S.plan, eventDate: evDate(), eventTime: String(q.eventTime || "").trim(), tz: tz(), now: Date.now(), live: S.autoWin === "pre" || S.autoWin === "onday" }); } catch (e) { M.dly = null; }
    return M.dly;
  }
  function atClock(m) { return clock(new Date(m).toISOString()); }
  function waitsOf(t) { var HD = global.HelmDelay, r = t && t.depends_on ? delayRes() : null; return r ? HD.waits(t, r, atClock) : null; }
  function renderDelay() {
    var HD = global.HelmDelay, host = $("#tcDelay"); if (!HD || !host) return;
    var r = delayRes(), q = G().quote || {}, on = !!r && q.status !== "cancelled" && S.autoWin !== "wrapup" && (S.win !== "daybefore" || S.autoWin === "daybefore");
    HD.render(host, { quoteId: qid(), result: on ? r : null, clock: atClock, nameOf: nameOf,
      phoneOf: function (t) { var c = t.crew_id && crewById(t.crew_id); return String((c && c.phone) || t.assignee_phone || "").replace(/[^\d+]/g, ""); },
      canNudge: function (t) { return canEdit() && !!t.crew_id && inHouse(t) && isOpen(t); }, nudge: function (t, b) { P().mail(b, t.id, false); },
      assign: canEdit() ? function (t) { openSheet([String(t.id)]); } : null, open: function (t) { openTask(t.id); },
      move: canEdit() ? function (ids, m) { var ts = ids.map(taskById).filter(Boolean); if (ts.length && !planLocked()) openMove(ts, m); } : null, locked: planLocked() });
  }
  function planLocked() { var EF = global.HelmEventFloor; return !!(EF && qid() && EF.isLocked(qid())); }
  function renderFloor() {
    var EF = global.HelmEventFloor; if (!EF || !qid()) return;
    var cancelled = (G().quote || {}).status === "cancelled";
    EF.panel({ quoteId: qid(), lockHost: cancelled ? null : $("#tcLock"), floorHost: $("#tcFloor"), showFloor: !cancelled,
      canEditPlan: canEdit(), onChange: function () { S.sigs.dayb = S.sigs.ready = ""; update(); } });
    if (cancelled) { var lh = $("#tcLock"); if (lh) lh.hidden = true; }
  }
  // On the event: the run-sheet as a now / next timeline (read-only here; editing stays on the Run-sheet page)
  function nowMinOnDay() {
    var ev = evDate(); if (!ev) return null; var d = TS.dayDiff(ev, today());
    if (d > 0) return 100000; if (d < 0) return -1;
    var w = wall(new Date(Math.floor(Date.now() / 60000) * 60000).toISOString()); return w ? w.min : null;
  }
  function renderRun() {
    var host = card("tcRun", S.win === "onday" && Array.isArray(S.rs)); if (!host) return;
    var nm = nowMinOnDay(), rows = runRows(S.rs, nm);
    var sig = rowSig([nm, rows.map(function (x) { return [x.r.id, x.r.title, x.r.start_time, x.r.duration_min, x.r.owner, x.r.location, x.state]; })]);
    if (S.sigs.run === sig) return; S.sigs.run = sig;
    clear(host);
    var nowTxt = nm != null && nm >= 0 && nm < 100000 ? " · now " + clock(new Date().toISOString()) : "";
    host.appendChild(h("div", { cls: "tc-side-h" }, [h("h3", { cls: "tc-h2", id: "tcRunH" }, ["Run-sheet", h("span", { cls: "tc-count", text: nowTxt })]),
      h("a", { cls: "tc-mini-link", href: "runsheet.html?quote=" + enc(qid()), text: "Open run-sheet →" })]));
    if (!rows.length) { host.appendChild(h("p", { cls: "tc-aempty", text: "No run-sheet yet - plan the day minute by minute (arrivals, speeches, cake cutting) on the Run-sheet page." })); return; }
    var ol = h("ol", { cls: "tc-run", "aria-labelledby": "tcRunH" });
    rows.forEach(function (x) {
      var r = x.r, t = isFinite(x.s) ? hourLabel(x.s) : "—", end = isFinite(x.e) && x.e > x.s ? hourLabel(x.e) : "";
      var badge = x.state === "now" ? h("span", { cls: "tc-tag ok", text: "Now" }) : x.state === "next" ? h("span", { cls: "tc-tag warn", text: "Next" + (x.inMin > 0 ? " in " + dur(x.inMin) : "") }) : null;
      ol.appendChild(h("li", { cls: "tc-run-row " + x.state }, [
        h("span", { cls: "tc-run-t" }, [x.state === "done" ? "✓ " : "", t, end ? h("small", { text: "to " + end }) : null]),
        h("span", { cls: "grow" }, [h("b", { text: r.title || "Item" }), badge,
          h("span", { cls: "tc-sub", text: [r.owner ? "👤 " + r.owner : "", r.location ? "📍 " + r.location : "", r.note || ""].filter(Boolean).join(" · ") })])
      ]));
    });
    host.appendChild(ol);
  }
  // Pre-event + On the event: the event's issues (event_issues, same as the Issues page; the server checks the Issues area).
  // R252: the list, "Assign to" and the optional task are issue-assign.js - the same on the monitor and the Issues page.
  function issStep() { return S.win === "onday" || S.win === "pre"; }
  function issHref() { return "issues.html?quote=" + enc(qid()) + "&from=ops"; }
  function renderIssues() {
    var p = S.perm || {}, IA = global.HelmIssueAssign, host = card("tcIssues", issStep() && (Array.isArray(S.iss) || S.issErr)); if (!host) return;
    var org = IA ? IA._pure.organise(S.iss || []) : { open: (S.iss || []).filter(function (i) { return i && i.status !== "resolved"; }) }, n = org.open.length, main = S.win === "onday";
    var sig = rowSig([n, !!p.issEdit, main, !S.iss, qid()]), box = $("#tcIssList");
    if (S.sigs.iss !== sig || !box) {
      S.sigs.iss = sig; var keep = focusKey(host); if (!box) box = h("div", { id: "tcIssList" });
      Array.prototype.slice.call(host.childNodes).forEach(function (c) { if (c !== box) host.removeChild(c); });   // the list stays: someone may be choosing a person in it
      var head = h("div", { cls: "tc-side-h" }, [h("h3", { cls: "tc-h2" }, ["Issues ", h("span", { cls: "tc-count", text: !S.iss ? "not checked" : n ? n + " open" : "none open" })])]), acts = h("span", { cls: "tc-iss-acts" });
      if (p.issEdit) acts.appendChild(h("button", { type: "button", cls: "tc-btn sm" + (main ? " tc-primary" : ""), id: "tcLogIssue", "data-key": "iss:log", text: "+ Log an issue", on: { click: openIssue } }));   // one filled button per step
      acts.appendChild(h("a", { cls: "tc-mini-link", href: issHref(), text: "All issues →" }));
      head.appendChild(acts); host.insertBefore(head, host.firstChild); if (box.parentNode !== host) host.appendChild(box);
      restoreFocus(host, keep);
    }
    if (!IA) { clear(box); box.appendChild(h("p", { cls: "tc-aempty", text: "Open All issues to see and sort them." })); return; }
    IA.list(box, { items: S.iss || [], quoteId: qid(), canEdit: !!p.issEdit, err: S.issErr, max: 6, allHref: issHref(), tasks: function () { return G().tasks; }, locked: planLocked,
      empty: S.iss ? "Nothing open. Something wrong on site (a late delivery, a broken light)? Log it so someone owns it." : "", toast: function (m, k) { toast(m, k, 8000); },
      reload: async function () { await loadIssues(); renderIssues(); }, onTask: tasksChanged, resolve: function (i, btn) { resolveIssue(btn, i); } });
  }
  async function tasksChanged() { try { if (P() && P().reload) await P().reload(); } catch (e) {} update(); }
  // refused = the card goes away; no answer = what was read stays and the card says "Couldn't check - Try again"
  async function loadIssues() {
    var B0 = B(), p = S.perm || {}, IA = global.HelmIssueAssign; if (!B0 || !B0.issues || !p.issView || !qid()) { S.iss = null; S.issErr = false; return; }
    try { var r = await B0.issues.list(qid()); S.iss = Array.isArray(r) ? r : []; S.issErr = false; } catch (e) { S.issErr = !(IA && IA.refused(e)); if (!S.issErr) S.iss = null; }
  }
  async function resolveIssue(btn, i) {
    btn.disabled = true;
    try { await B().issues.setStatus(i.id, "resolved"); toast("Resolved: " + (i.title || "issue") + ".", "ok"); await loadIssues(); renderIssues(); }
    catch (e) { toast(errText(e, "resolve the issue"), "err"); btn.disabled = false; }
  }
  function openIssue() {
    var IA = global.HelmIssueAssign; if (!(S.perm || {}).issEdit) return;
    if (S.layer && S.layer.id === "sheet") layerClose();
    S.openId = null;
    var title = h("input", { cls: "tc-inp", id: "tcIssTitle", maxlength: "500", placeholder: "e.g. Generator not delivered", "data-autofocus": true, autocomplete: "off" });
    var kind = "issue", sev = "medium";
    var kindRow = h("div", { cls: "tc-optrow", role: "group", "aria-label": "Issue or incident" }), sevRow = h("div", { cls: "tc-optrow", role: "group", "aria-label": "How serious" });
    function opts(row, list, cur, set) { clear(row); list.forEach(function (o) { row.appendChild(h("button", { type: "button", cls: "tc-opt", "aria-pressed": String(o[0] === cur), text: o[1], on: { click: function () { set(o[0]); var b = row.querySelector('[aria-pressed="true"]'); if (b) try { b.focus(); } catch (e) {} } } })); }); }
    function draw() { opts(kindRow, [["issue", "Issue - a problem to fix"], ["incident", "Incident - something happened"]], kind, function (v) { kind = v; draw(); });
      opts(sevRow, [["low", "Low"], ["medium", "Medium"], ["high", "High"]], sev, function (v) { sev = v; draw(); }); }
    draw();
    var pk = IA ? IA.picker({ quoteId: qid(), tasks: function () { return G().tasks; }, locked: planLocked, ids: "tcIssWho" }) : null;
    var err = h("p", { cls: "tc-note warn", role: "alert", hidden: true });
    var go = h("button", { type: "button", cls: "tc-btn tc-primary push", text: "Log it" });
    async function submit() {
      if (go.disabled) return;   // Enter + a tap: one issue, one task
      var t = String(title.value || "").replace(/\s+/g, " ").trim(), w = pk ? pk.value() : { name: null }, o = w.name || "";
      if (!t) { err.textContent = "Say what is wrong."; err.hidden = false; title.focus(); return; }
      if (t.length > 500) { err.textContent = "Keep it under 500 characters."; err.hidden = false; return; }
      if (w.error) { err.textContent = w.error; err.hidden = false; pk.focus(); return; }
      err.hidden = true; go.disabled = true; var q = qid();
      try {
        await B().issues.add(qid(), { kind: kind, title: t, severity: sev, owner: o || null });
      } catch (e) { err.textContent = errText(e, "log the " + kind); err.hidden = false; go.disabled = false; return; }
      var saved = (kind === "incident" ? "Incident" : "Issue") + " logged" + (o ? " - " + o + " has it" : "") + ".";
      var r = pk ? await IA.withTask(q, t, w, saved) : { ok: true, msg: saved };   // the issue is saved whatever happens to the task
      toast(r.msg, r.ok ? "ok" : "err", 8000); if (S.layer && S.layer.id === "drawer" && go.isConnected) layerClose();
      if (r.task && r.task.ok) await tasksChanged();
      await loadIssues(); renderIssues();
    }
    go.addEventListener("click", submit);
    title.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); submit(); } });
    drawer("Issues", "Log an issue", [
      h("label", { cls: "tc-lbl", for: "tcIssTitle", text: "What is wrong?" }), title,
      lbl("Kind"), kindRow, lbl("How serious"), sevRow,
      pk ? pk.el : null, err,
      h("p", { cls: "tc-hint", text: "It goes on this event's Issues list (the same one as the Issues page). Resolve it here or there when it is sorted." })
    ], [h("button", { type: "button", cls: "tc-btn", text: "Cancel", on: { click: layerClose } }), go]);
  }
  /* R251: "Mark pre-event complete" (last card of Pre-event) and the closed Wrap-up section at the bottom of every step - both in
     event-steps.js, the same on the monitor; stage moves, gates and their permission checks live there (setStageGuided only) */
  function stepsCtx() {
    var q = G().quote || {}, p = S.perm;
    return { quoteId: qid(), quote: { code: q.code, title: q.title, status: q.status, stage: stageOf(), eventDate: evDate(), eventTime: String(q.eventTime || "").trim() },
      tasks: G().tasks, autoWin: S.autoWin, win: S.win, tz: tz(), now: Date.now(), nameOf: nameOf, canStage: !!p.stageEdit, admin: !!p.admin,
      plan: S.plan, sheet: S.hasSheet ? S.sheet : undefined,
      toast: function (m, t) { toast(m, t === "err" ? "err" : t || "ok", 7000); }, onChanged: stageChanged, openTask: openTask };
  }
  // after a stage move: the quote itself (its stage decides the real step) + the tasks
  async function stageChanged() {
    var q = G().quote; try { var fresh = await B().quotes.get(qid()); if (fresh && q) Object.assign(q, fresh); } catch (e) {}
    try { if (P() && P().reload) await P().reload(); } catch (e) {}
    S.sigs = {}; await loadExtras(); update();
  }
  function renderSteps() {
    if (!S.perm || !qid()) return; var ctx = stepsCtx(), ph = $("#tcPreDone"), wh = $("#tcWrap");
    if (global.HelmEventSteps && ph) try { global.HelmEventSteps.renderPreDone(ph, ctx); } catch (e) { ph.hidden = true; }
    renderPreCheck(ctx);
    if (global.HelmEventWrap && wh) try { global.HelmEventWrap.render(wh, ctx); } catch (e) { wh.hidden = true; }
  }
  // R252 (pre-check.js, the same on the monitor): "Guests arrive at 6:00 PM - ... Pre-event check by 5:00 PM: 3 tasks open"; every minute, no read
  function renderPreCheck(ctx) {
    var PC = global.HelmPreCheck; if (!PC || !S.perm || !qid()) return; ctx = ctx || stepsCtx(); ctx.card = $("#tcPreDone"); ctx.goPre = function () { pickWin("pre"); };
    ctx.phoneOf = function (t) { var c = t.crew_id && crewById(t.crew_id); return String((c && c.phone) || t.assignee_phone || "").replace(/[^\d+]/g, ""); };
    try { PC.how($("#tcHow")); PC.render($("#tcPreCheck"), ctx, $("#tcPreTop")); } catch (e) { var n = $("#tcPreCheck"); if (n) n.hidden = true; }
  }
  async function loadPerm() {
    if (S.perm) return; var A = B() && B().auth; if (!A) { S.perm = {}; return; }
    var f = function (p) { return Promise.resolve().then(function () { return p(); }).then(function (v) { return !!v; }, function () { return false; }); };
    var r = await Promise.all([f(function () { return A.canView("runsheet"); }), f(function () { return A.canView("issues"); }), f(function () { return A.canEditArea("issues"); }),
      f(function () { return A.canEditArea("quotes"); }), Promise.resolve().then(function () { return A.role(); }).catch(function () { return ""; })]);
    S.perm = { rsView: r[0], issView: r[1], issEdit: r[1] && r[2], stageEdit: r[3], admin: r[4] === "admin" };
  }

  /* ---- bulk bar ---- */
  function selIds() { var all = {}; (G().tasks || []).forEach(function (t) { all[t.id] = t; }); return Object.keys(S.sel).filter(function (id) { return all[id] && all[id].status !== "cancelled"; }); }
  function renderBulk() {
    var bar = $("#bulk"); if (!bar) return; var ids = selIds();
    Object.keys(S.sel).forEach(function (id) { if (ids.indexOf(id) < 0) delete S.sel[id]; });
    bar.hidden = !ids.length || !canEdit(); $("#bulkN").textContent = String(ids.length);
  }
  async function bulk(kind) {
    var ids = selIds(), ts = ids.map(taskById).filter(Boolean); if (!ts.length) return;
    if (kind === "assign") return openSheet(ids);
    if (kind === "time") return openMove(ts);
    if (kind === "send") return openSend(ts);
    var B0 = B(), ok = 0, skip = 0, fail = "";
    if (kind === "special") {
      for (var i = 0; i < ts.length; i++) { var t = ts[i]; if (t.is_special || t.status === "completed") { skip++; continue; } try { await B0.ops.setSpecial(t.id, true, 5); ok++; } catch (e) { fail = errText(e, "mark the tasks special"); } }
      toast(ok + " task" + (ok === 1 ? "" : "s") + " marked special" + (skip ? " (" + skip + " already special or done)" : "") + "." + (fail ? " " + fail : "") + (ts.some(function (x) { return !x.planned_start; }) ? " Give them a start time so they can escalate." : ""), fail ? "err" : "ok", 7000);
    }
    if (kind === "cancel") {
      var can = ts.filter(function (t) { return CANCELLABLE.indexOf(t.status) >= 0; });
      if (!can.length) { toast("None of these can be cancelled (only given, accepted or started tasks).", "info"); return; }
      var reason = await global.BPUI.prompt("Why cancel " + (can.length === 1 ? "this task" : "these " + can.length + " tasks") + "? The crew member sees this.", { title: "Cancel tasks", label: "Reason (required)", multiline: true, required: true, requiredMessage: "Give a reason (at least 3 characters).", okLabel: "Cancel tasks" });
      if (reason === null) return; reason = String(reason).replace(/\s+/g, " ").trim();
      if (reason.length < 3 || reason.length > 300) { toast("The reason must be 3 to 300 characters.", "err"); return; }
      for (var j = 0; j < can.length; j++) { try { await B0.ops.cancel(can[j].id, reason); ok++; } catch (e) { fail = errText(e, "cancel the tasks"); } }
      toast(ok + " task" + (ok === 1 ? "" : "s") + " cancelled - kept on the list, greyed out." + (ts.length - can.length ? " " + (ts.length - can.length) + " could not be cancelled (done or not given yet)." : "") + (fail ? " " + fail : ""), fail ? "err" : "ok", 7000);
    }
    S.sel = {}; await reload(false);
  }

  /* ---- generic side panel (task panel, bulk Set time / Send) ---- */
  function layerOpen(el) {
    S.lastFocus = doc.activeElement; $("#tcScrim").hidden = false; el.hidden = false; S.layer = el;
    var f = el.querySelector("[data-autofocus]") || el.querySelector("button,input,select,textarea,a[href]"); if (f) try { f.focus(); } catch (e) {}
  }
  function layerClose() {
    var was = S.layer; S.layer = null; S.openId = null;
    ["#drawer", "#sheet"].forEach(function (s) { var e = $(s); if (e) e.hidden = true; });
    $("#tcScrim").hidden = true;
    if (was && was.id === "sheet") { S.preset = null; try { P().sheetClosed && P().sheetClosed(); } catch (e) {} }
    if (S.lastFocus && S.lastFocus.isConnected) try { S.lastFocus.focus(); } catch (e) {}
    else { var w = $("#tcViews [aria-pressed=true]"); if (w) try { w.focus(); } catch (e) {} }
  }
  function trap(e) {
    if (!S.layer) return;
    if (e.key === "Escape") {
      // the page's own pop-ups (schedule / cancel / evidence / BPUI dialogs) sit above and close first
      if (Array.prototype.some.call(doc.querySelectorAll(".lmodal"), function (m) { return !m.hidden; })) return;
      e.preventDefault(); layerClose(); return;
    }
    if (e.key !== "Tab") return;
    var f = Array.prototype.filter.call(S.layer.querySelectorAll("button,input,select,textarea,a[href],[tabindex]"), function (n) { return !n.disabled && n.offsetParent !== null && n.tabIndex >= 0; });
    if (!f.length) return; var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  function drawer(sec, title, body, foot) {
    var d = $("#drawer"); $("#dSec").textContent = sec; $("#dTitle").textContent = title;
    clear($("#dBody")); body.forEach(function (n) { if (n) $("#dBody").appendChild(n); });
    clear($("#dFoot")); foot.forEach(function (n) { if (n) $("#dFoot").appendChild(n); });
    if (d.hidden) layerOpen(d);
  }
  function lbl(t) { return h("div", { cls: "tc-lbl", text: t }); }

  /* ---- the task panel: only the actions that make sense right now ---- */
  function openTask(id) {
    memoReset(); var t = taskById(id); if (!t) return;
    S.openId = t.id; S.sigs.panel = "";
    renderPanel(true);
  }
  function renderPanel(force) {
    if (S.openId == null) return; var t = taskById(S.openId);
    if (!t) { layerClose(); return; }
    var sig = rowSig([rowData(t), planLocked(), t.responded_at, t.started_at, t.completed_at, t.verify_note, (S.acts || []).filter(function (a) { return a.task_id === t.id; }).length]);
    if (!force && S.sigs.panel === sig) return; S.sigs.panel = sig;
    var keep = focusKey($("#drawer"));
    var g = G(), k = TS.shown(t), base = TS.baseKey(t), nm = nameOf(t), c = t.crew_id ? crewById(t.crew_id) : null, now = Date.now(), edit = canEdit();
    var stepI = { unassigned: -1, waiting: 0, accepted: 1, started: 2, done: 3, rejected: 0, cancelled: -1 }[base];
    var steps = h("div", { cls: "tc-steps", role: "list", "aria-label": "Progress: " + TS.LABEL[base] });
    ["Given", "Accepted", "Started", "Done"].forEach(function (x, i) { steps.appendChild(h("span", { cls: "tc-step" + (i <= stepI ? " on" : ""), role: "listitem", text: (i <= stepI ? "✓ " : "") + x })); });
    var body = [h("div", {}, [lbl("Progress"), steps])];
    if (k === "late") body.push(h("div", { cls: "tc-note bad" }, [h("b", { text: "Late. " }), "Start time " + clock(t.planned_start) + " has passed and " + (nm || "no one") + " has not started (" + dur(TS.lateMin(t, now)) + ")."]));
    if (base === "rejected") body.push(h("div", { cls: "tc-note bad", text: "Turned down by " + (nm || "the person") + " - give it to someone else." }));
    var cl = clashOf(t); if (cl && t.status !== "completed") body.push(h("div", { cls: "tc-note warn", text: (nm || "This person") + (cl.pending ? " asked for this day off (waiting for an answer)" : " has an approved day off this day - give the task to someone else") + (cl.note ? ": “" + cl.note + "”" : "") + "." }));
    if (t.verify_status === "rejected") body.push(h("div", { cls: "tc-note warn", text: "QC rejected - rework" + (t.verify_note ? ": " + t.verify_note : "") }));
    if (t.status === "cancelled") body.push(h("div", { cls: "tc-note info", text: "Cancelled" + (t.cancel_reason ? ": " + t.cancel_reason : "") + (t.cancelled_at ? " · " + when(t.cancelled_at) : "") }));
    var kv = h("dl", { cls: "tc-kv" });
    function row(a, b) { kv.appendChild(h("dt", { text: a })); kv.appendChild(h("dd", {}, [b])); }
    row("Person", nm ? nm + (c && c.phone ? " · " + c.phone : t.assignee_phone ? " · " + t.assignee_phone : "") + (!inHouse(t) ? " (vendor)" : "") : "Not assigned");
    if (c && S.hasSheet && inHouse(t)) { var io = ioPill(c.id); if (io) row("Check-in", io); }
    row("Start", t.planned_start ? when(t.planned_start) + (slot(t, evDate(), wall).where === "before" ? " (before the event day)" : "") : "No start time - no reminders");
    var r = remText(t); row("Reminders", r || (!inHouse(t) ? "Vendors get no reminders" : t.planned_start ? "None for this task" : "-"));
    var d = depOf(t); row("Waits for", h("span", { cls: "tc-waits" }, [d ? (d.title || "task") + " (" + TS.LABEL[TS.shown(d)] + ") " : "Nothing ",
      canEdit() && t.status !== "completed" && t.status !== "cancelled" ? h("button", { type: "button", cls: "tc-lnk", "data-key": "a:waits", text: "Change", "aria-label": "Change what this task waits for", on: { click: function () { P().schedule(t.id); } } }) : null]));
    var next = liveTasks().filter(function (x) { return x.depends_on && String(x.depends_on) === String(t.id); });   // R251: the other direction
    var wt = waitsOf(t); if (wt) row(wt.bad ? "Blocked" : "Expected", h("span", { cls: wt.bad ? "tc-waits bad" : "tc-waits", text: wt.text }));
    if (next.length) row("Waiting for this", next.map(function (x) { return x.title || "task"; }).join(", "));
    var wa = null; try { wa = P().waChip(t); } catch (e) {} if (wa && wa.text) row("WhatsApp", wa.text);
    if (t.verify_status === "passed" || t.verify_status === "pending" || t.verify_status === "rejected") row("QC", t.verify_status === "passed" ? "Passed" : t.verify_status === "pending" ? "Waiting for a check" : "Rework");   // "unverified" = not checked yet: no line
    body.push(kv);
    // special (P1): what it means, in the current words (R186 escalation ladder, not the old "every 5 min" rule)
    var spBox = h("div", {}, [lbl("Special (P1)")]);
    var expl = ""; try { expl = global.HelmTaskReminders && global.HelmTaskReminders.escExplain ? global.HelmTaskReminders.escExplain(S.escCfg) : ""; } catch (e) {}
    if (t.is_special) {
      var n = h("div", { cls: "tc-note info" }, [expl || "If it is not started on time Helm tells the worker, then the event lead, then the manager, then the admin / owner."]);
      if (!t.planned_start) n.appendChild(h("p", { cls: "tc-hint", text: "This task has no start time, so it can’t escalate - use Change time." }));
      var st = TS.escStep(t, S.acts, S.escCfg, now); if (st >= 0) n.appendChild(ladderEl(st));
      spBox.appendChild(n);
      if (edit && t.status !== "completed" && t.status !== "cancelled") spBox.appendChild(h("button", { type: "button", cls: "tc-btn sm", "data-key": "a:unspecial", text: "Remove the special mark", on: { click: function (e) { P().special(e.currentTarget, t.id); } } }));
    } else if (edit && t.status !== "completed" && t.status !== "cancelled") {
      spBox.appendChild(h("div", { cls: "tc-inline" }, [h("button", { type: "button", cls: "tc-btn sm", "data-key": "a:special", text: "▲ Make special", on: { click: function (e) { P().special(e.currentTarget, t.id); } } }), h("span", { cls: "tc-hint", text: "Extra reminders before the start + step-by-step escalation if it isn’t started." })]));
    } else spBox.appendChild(h("p", { cls: "tc-hint", text: "Not special." }));
    body.push(spBox);
    var ev = evidenceOf(t);
    if (ev.length) body.push(h("div", {}, [lbl("Notes & photos from crew"), h("button", { type: "button", cls: "tc-btn sm", "data-key": "a:ev", text: "Open " + ev.length + " note" + (ev.length === 1 ? "" : "s") + " / photo" + (ev.length === 1 ? "" : "s"), on: { click: function () { P().evidence(t.id); } } })]));
    // history: the activity timeline (0368), else the task's own step times
    var hist = (S.acts || []).filter(function (a) { return a.task_id === t.id; }).slice(0, 12), ol = h("ol", { cls: "tc-feed" });
    if (!hist.length) [["created_at", "Given to " + (nm || "-")], ["responded_at", base === "rejected" ? "Turned down" : "Accepted"], ["started_at", "Started"], ["completed_at", "Done"]].forEach(function (p) { if (t[p[0]]) hist.push({ at: t[p[0]], _t: p[1] }); });
    hist.forEach(function (a) { ol.appendChild(h("li", {}, [h("span", { cls: "tc-fi", "aria-hidden": "true", text: "•" }), h("span", {}, [a._t || TS.actText(a, when), h("time", { text: when(a.at) })])])); });
    if (hist.length) body.push(h("div", {}, [lbl("History"), ol]));
    // actions
    var foot = [];
    if (edit) {
      if (g.canVerify && t.status === "completed" && t.verify_status === "pending") {
        foot.push(h("button", { type: "button", cls: "tc-btn green", "data-key": "a:qcok", text: "Pass QC", on: { click: function (e) { P().verify(e.currentTarget, t.id, true); } } }));
        foot.push(h("button", { type: "button", cls: "tc-btn", "data-key": "a:qcno", text: "Reject QC", on: { click: function (e) { P().verify(e.currentTarget, t.id, false); } } }));
      }
      if (k === "late" && t.crew_id && inHouse(t)) foot.push(h("button", { type: "button", cls: "tc-btn tc-primary", "data-key": "a:nudge", text: "Nudge now", title: "E-mail this task to " + (nm || "them") + " again now", on: { click: function (e) { P().mail(e.currentTarget, t.id, false); } } }));
      if (isOpen(t) && inHouse(t) && (t.crew_id || t.assignee_phone)) {
        foot.push(h("button", { type: "button", cls: "tc-btn", "data-key": "a:mail", text: "Email", "aria-label": "Email this task to " + (nm || "the person"), on: { click: function (e) { P().mail(e.currentTarget, t.id, false); } } }));
        foot.push(h("button", { type: "button", cls: "tc-btn", "data-key": "a:wa", text: "WhatsApp", "aria-label": "Send this task on WhatsApp", on: { click: function (e) { P().wa(e.currentTarget, t.id); } } }));
      }
      if (noOne(t) && t.status !== "cancelled") foot.push(h("button", { type: "button", cls: "tc-btn tc-primary", "data-key": "a:give", text: "Give to someone", on: { click: function () { openSheet([String(t.id)]); } } }));
      if (t.status !== "completed" && t.status !== "cancelled") foot.push(h("button", { type: "button", cls: "tc-btn", "data-key": "a:time", text: t.planned_start ? "Change time" : "Set a time", title: "Start time, the task it waits for, reminders", on: { click: function () { P().schedule(t.id); } } }));
      if (t.status !== "cancelled" && !planLocked()) foot.push(h("button", { type: "button", cls: "tc-btn", "data-key": "a:after", text: "+ Task after this", title: "Give out work that waits for this task", on: { click: function () { openSheet(null, String(t.id)); } } }));
      if (t.status === "assigned" && !noOne(t)) foot.push(h("button", { type: "button", cls: "tc-btn", "data-key": "a:re", text: "Reassign", on: { click: function () { openSheet([String(t.id)]); } } }));
      if (CANCELLABLE.indexOf(t.status) >= 0) foot.push(h("button", { type: "button", cls: "tc-btn danger push", "data-key": "a:cancel", text: "Cancel task", on: { click: function () { P().cancel(t.id); } } }));
      if (["accepted", "in_progress"].indexOf(t.status) >= 0) body.push(h("p", { cls: "tc-hint", text: "Accepted tasks stay with their person - to move one, cancel it (a reason is required) and give it out again." }));
    } else foot.push(h("span", { cls: "tc-viewonly", text: "View only" }));
    drawer(t.category || "Task", t.title || "Task", body, foot);
    restoreFocus($("#drawer"), keep);
  }

  /* ---- bulk: Set time = move by minutes ---- */
  // m (R252): how far, when the caller knows it ("Move the later tasks by 40 min"); else the suggestion
  function openMove(ts, m) {
    var withTime = ts.filter(function (t) { return t.planned_start && t.status !== "completed"; }), sug = m > 0 ? Math.min(720, m) : suggestShift(withTime, Date.now());
    var val = sug, inp = h("input", { type: "number", cls: "tc-inp", id: "tcMoveMin", min: "-720", max: "720", step: "5", inputmode: "numeric", "aria-describedby": "tcMoveHint" });
    inp.value = String(sug);
    var opts = h("div", { cls: "tc-moveby", role: "group", "aria-label": "Move by" });
    [-60, -30, -15, 15, 30, 60, 120].forEach(function (m) { opts.appendChild(h("button", { type: "button", cls: "tc-opt", "aria-pressed": String(m === sug), text: (m > 0 ? "+" : "−") + Math.abs(m) + " min", on: { click: function () { inp.value = String(m); sync(); } } })); });
    function sync() { val = Math.round(Number(inp.value)); Array.prototype.forEach.call(opts.children, function (b, i) { b.setAttribute("aria-pressed", String([-60, -30, -15, 15, 30, 60, 120][i] === val)); }); go.textContent = isFinite(val) && val ? "Move " + withTime.length + " task" + (withTime.length === 1 ? "" : "s") + " " + (val > 0 ? "later" : "earlier") + " by " + dur(Math.abs(val)) : "Pick how far"; go.disabled = !isFinite(val) || !val || !withTime.length; }
    inp.addEventListener("input", sync);
    var go = h("button", { type: "button", cls: "tc-btn tc-primary push", "data-key": "mv:go" });
    go.addEventListener("click", function () { applyMove(withTime, val, go); });
    var body = [h("p", { cls: "tc-hint", id: "tcMoveHint", text: "Every ticked task keeps its own time and moves by the same amount (reminders at an exact clock time move too). Suggested: " + (sug > 0 ? "+" : "") + sug + " min." }), opts,
      h("label", { cls: "tc-lbl", for: "tcMoveMin", text: "Or minutes (minus = earlier)" }), inp];
    if (ts.length - withTime.length) body.push(h("div", { cls: "tc-note warn", text: (ts.length - withTime.length) + " ticked task" + (ts.length - withTime.length === 1 ? " has" : "s have") + " no start time or is done - set those one by one with Change time." }));
    drawer("Set time", "Move " + ts.length + " task" + (ts.length === 1 ? "" : "s"), body, [h("button", { type: "button", cls: "tc-btn", text: "Cancel", on: { click: layerClose } }), go]);
    sync();
  }
  async function applyMove(ts, m, btn) {
    if (!m) return; btn.disabled = true; var B0 = B(), ok = 0, past = 0, fail = "", now = Date.now();
    for (var i = 0; i < ts.length; i++) {
      var t = ts[i], ns = moveBy(t.planned_start, m);
      if (!ns || ms(ns) < now - 5 * 60000) { past++; continue; }
      try {
        await B0.ops.setSchedule(t.id, ns, t.planned_end ? moveBy(t.planned_end, m) : null, t.depends_on || null);
        if (Array.isArray(t.remind_at) && t.remind_at.length) await B0.ops.setReminderTimes(t.id, t.remind_at.map(function (x) { return moveBy(x, m); }).filter(function (x) { return x && ms(x) > now; }));
        ok++;
      } catch (e) { fail = errText(e, "move the tasks"); }
    }
    toast(ok + " task" + (ok === 1 ? "" : "s") + " moved " + (m > 0 ? "later" : "earlier") + " by " + dur(Math.abs(m)) + "." + (past ? " " + past + " would start in the past - left as they were." : "") + (fail ? " " + fail : ""), fail ? "err" : "ok", 7000);
    layerClose(); S.sel = {}; await reload(false);
  }
  /* ---- bulk: Send = one message per person with all their ticked tasks ---- */
  function openSend(ts) {
    var by = {}; ts.forEach(function (t) { if (t.crew_id && inHouse(t) && isOpen(t) && !by[t.crew_id]) by[t.crew_id] = t; });
    var ids = Object.keys(by), mail = h("input", { type: "checkbox", id: "tcSendMail" }), wa = h("input", { type: "checkbox", id: "tcSendWa" });
    mail.checked = true;
    var go = h("button", { type: "button", cls: "tc-btn tc-primary push", text: ids.length ? "Send to " + ids.length + " " + (ids.length === 1 ? "person" : "people") : "Nothing to send", disabled: ids.length ? null : true });
    go.addEventListener("click", async function () {
      go.disabled = true; var B0 = B(), m = 0, w = 0, notes = [];
      for (var i = 0; i < ids.length; i++) {
        var t = by[ids[i]];
        if (mail.checked) { try { var r = await B0.ops.emailTasks(t.id, true); if (r && r.ok) m++; else if (r && r.reason) notes.push(nameOf(t) + ": " + r.reason.replace(/_/g, " ")); } catch (e) { notes.push(errText(e, "send the e-mail")); } }
        if (wa.checked) { try { var r2 = await B0.ops.whatsappTasks(t.id); if (r2 && r2.ok) w++; else if (r2 && r2.reason === "wa_not_set_up") { notes.push("WhatsApp is not set up - connect your studio number in Integrations"); wa.checked = false; } } catch (e) { notes.push(errText(e, "send the WhatsApp")); } }
      }
      toast((mail.checked || m ? m + " e-mail" + (m === 1 ? "" : "s") : "") + (w ? (m ? " and " : "") + w + " WhatsApp" : "") + " on the way." + (notes.length ? " " + notes.slice(0, 3).join(" · ") : ""), notes.length && !m && !w ? "info" : "ok", 9000);
      layerClose();
    });
    drawer("Send", "Send their tasks", [
      h("p", { cls: "tc-hint", text: "Each person gets one message with all their open tasks on this event." + (ts.length > ids.length ? " " + (ts.length - ids.length) + " ticked task" + (ts.length - ids.length === 1 ? " has" : "s have") + " no staff member, is done or is a vendor task (vendors use their own link)." : "") }),
      h("label", { cls: "tc-chk" }, [mail, "Send by e-mail"]), h("label", { cls: "tc-chk" }, [wa, "WhatsApp from the studio number (needs it connected in Integrations)"])
    ], [h("button", { type: "button", cls: "tc-btn", text: "Cancel", on: { click: layerClose } }), go]);
  }

  /* ---- "+ Add & assign" sheet (static form in ops.html; the page script assigns) ---- */
  // depId (R251): "+ Task after this" - the new work waits for that task
  function openSheet(ids, depId) {
    if (!canEdit()) return;
    if (S.layer && S.layer.id === "drawer") { $("#drawer").hidden = true; S.layer = null; S.openId = null; }
    S.preset = ids && ids.length ? ids.map(String) : null;
    var sh = $("#sheet"), pre = $("#sPreset");
    $("#sWhat").hidden = !!S.preset; pre.hidden = !S.preset;
    if (S.preset) {
      var ts = S.preset.map(taskById).filter(Boolean), can = ts.filter(function (t) { return REASSIGNABLE.indexOf(t.status) >= 0; });
      clear(pre); pre.appendChild(lbl("Tasks"));
      pre.appendChild(h("div", { cls: "tc-note info", text: can.length + " task" + (can.length === 1 ? "" : "s") + ": " + can.map(function (t) { return t.title; }).join(", ") }));
      if (ts.length > can.length) pre.appendChild(h("div", { cls: "tc-note warn", text: (ts.length - can.length) + " ticked task" + (ts.length - can.length === 1 ? " is" : "s are") + " accepted, started or done and stay with their person." }));
      var kind = $("#assignKind"); if (kind) { kind.value = "in_house"; kind.dispatchEvent(new Event("change", { bubbles: true })); }
    }
    $("#sTitle").textContent = S.preset ? "Give to someone" : "Give work to someone";
    var stepFs = $("#sStep"); if (stepFs) stepFs.hidden = !!S.preset;   // tasks already on the list keep their own step
    var no = 0; Array.prototype.forEach.call(sh.querySelectorAll("[data-step]"), function (n) { var fs = n.closest("fieldset"); if (!fs || !fs.hidden || fs.id === "assignTime") no++; n.textContent = no + ". "; });
    var keepOpt = $("#as_keep"); if (keepOpt) keepOpt.hidden = !S.preset;
    try { P().sheetOpened(S.preset, typeof depId === "string" ? depId : ""); } catch (e) {}
    picks(); sheetLabel();
    if (sh.hidden) { layerOpen(sh); var sb = $("#sBody"); if (sb) sb.scrollTop = 0; }
  }
  /* ---- R251: "When is this work?" in the sheet ---- */
  // the step the sheet opens on: the one whose "+ Add task" was pressed, else Pre-event (On the event once guests are in)
  function sheetStep() { return S.addStep || (S.autoWin === "onday" || S.autoWin === "wrapup" ? "onday" : "pre"); }
  // the default start of a step, "YYYY-MM-DDTHH:MM" on the studio's clock ("" = no event date)
  function stepTime(step) {
    var ev = evDate(); if (!ev) return ""; var g = TS.hmMin((G().quote || {}).eventTime), pl = S.plan || {}, rd = pl.ready_by ? TS.hmMin(pl.ready_by) : isFinite(g) ? g - 60 : NaN;
    var r = stepStart(step, { guests: g, venue: pl.venue_access ? TS.hmMin(pl.venue_access) : NaN, ready: rd, runEnd: runEnd(S.rs, g) });
    var p2 = function (n) { return (n < 10 ? "0" : "") + n; };
    return (r.off ? addDays(ev, r.off) : ev) + "T" + p2(Math.floor(r.min / 60)) + ":" + p2(r.min % 60);
  }
  var STEP_WORDS = { pre: "Set-up work, finished before guests arrive.", onday: "Work while guests are there.", wrapup: "Pack down, returns and handover after the event.", daybefore: "Work finished before the event day." };
  // the line under the choice: what the step means, "pre-event first" while some is not given out, and where the work will really be listed
  // (the list reads the step from the start time, else from the words of the task - there is no separate field)
  function stepNote() {
    var hintEl = $("#asStepHint"), noteEl = $("#asStepNote"); if (!hintEl || !noteEl || !P() || !P().sheetPick || S.preset) return;
    var pk = P().sheetPick(), left = preLeft(), words = STEP_WORDS[pk.step] || "";
    if ((pk.step === "onday" || pk.step === "wrapup") && left) words += " " + allocHint() + ".";
    if (hintEl.textContent !== words) hintEl.textContent = words;
    var titles = Array.prototype.map.call(doc.querySelectorAll("#taskList .tk:checked"), function (c) { return c.value; }), o = stepO(), cat = G().activeCat || "";
    var off = titles.map(function (t) { return { t: t, w: TS.taskStep({ title: t, category: cat, planned_start: pk.start }, o) }; }).filter(function (x) { return x.w !== pk.step; });
    var msg = "";
    if (off.length) {
      var who = off.length === 1 ? "“" + off[0].t + "”" : off.length + " of these tasks", will = who + " will be listed under " + winWord(off[0].w) + ".";
      msg = !pk.start ? will + (pk.vendor ? " Vendor work has no start time here - set one later with Change time." : " Give a start time to place it.")
        : pk.step === "wrapup" ? will + " To list it under Wrap-up, use a word like “pack up” or “return” in its name, or start it the next morning."
        : pk.step === "onday" && !isFinite(TS.hmMin(o.eventTime)) ? will + " This event has no Guests arrive time yet." : will + " That is where its start time puts it.";
    }
    if (noteEl.textContent !== msg) noteEl.textContent = msg; noteEl.hidden = !msg;
  }
  function presetIds() { return S.preset ? S.preset.slice() : null; }
  // the person list: free / N open tasks / asked off / day off, star when the department matches; sorted free first
  function picks() {
    var host = $("#assignPick"); if (!host) return; memoReset();
    var g = G(), vendor = $("#assignKind") && $("#assignKind").value === "outsourced", q = String(($("#pickQ") || {}).value || "").trim().toLowerCase();
    var sel = vendor ? $("#assignVendor") : $("#assignCrew"), cur = sel ? sel.value : "";
    var keep = focusKey(host); clear(host);
    if (vendor) {
      var vs = (g.vendors || []).filter(function (v) { return !q || [v.name, v.category, v.phone].join(" ").toLowerCase().indexOf(q) >= 0; });
      if (!vs.length) host.appendChild(h("p", { cls: "tc-hint", text: (g.vendors || []).length ? "No vendor matches." : "No vendors yet - add them on the Vendors page." }));
      vs.forEach(function (v) { host.appendChild(pickBtn(v.id, v.name, [v.category, v.phone || "no phone"].filter(Boolean).join(" · "), h("span", { cls: "tc-avail", text: "checklist link, no reminders" }), cur === v.id, sel)); });
      restoreFocus(host, keep); return;
    }
    var cat = g.activeCat || "", sug = g.suggest || {}, offIds = g.offIds || new Map(), now = Date.now();
    var list = (g.crew || []).map(function (c) {
      var open = (g.tasks || []).filter(function (t) { return t.crew_id === c.id && isOpen(t); }).length;
      var s = sug[c.id] || {}, off = offIds.has ? offIds.has(c.id) : false, dept = String(c.department || "").toLowerCase() === String(cat).toLowerCase() || !!s.match;
      var rank = off ? 3 : ((g.booked ? g.booked.has(c.id) : s.available === false) ? 2 : open >= 3 ? 1 : 0);
      var bk = g.booked && g.booked.get ? g.booked.get(c.id) : null;
      return { c: c, open: open, off: off, pending: off && !!(offIds.get(c.id) || {}).pending, busy: g.booked ? !!bk : s.available === false, codes: bk || [], dept: dept, rank: rank };
    }).filter(function (x) { return !q || [x.c.name, x.c.department, x.c.phone].join(" ").toLowerCase().indexOf(q) >= 0; })
      .sort(function (a, b) { return a.rank - b.rank || (b.dept - a.dept) || String(a.c.name || "").localeCompare(String(b.c.name || "")); });
    if (!(g.crew || []).length) host.appendChild(h("p", { cls: "tc-hint" }, ["No staff yet - ", h("a", { href: "staff.html", cls: "tc-mini-link", text: "add people on the Staff page" }), "."]));
    else if (!list.length) host.appendChild(h("p", { cls: "tc-hint", text: "Nobody matches." }));
    list.forEach(function (x) {
      var a = x.off ? h("span", { cls: "tc-avail off", text: x.pending ? "asked for the day off" : "day off" }) : x.busy ? h("span", { cls: "tc-avail busy", text: "busy elsewhere" + (x.codes.length ? " · " + x.codes[0] + (x.codes.length > 1 ? " +" + (x.codes.length - 1) : "") : ""), title: "Has work on another event that day" + (x.codes.length ? ": " + x.codes.join(", ") : "") }) : x.open >= 1 ? h("span", { cls: "tc-avail busy", text: x.open + " open task" + (x.open === 1 ? "" : "s") }) : h("span", { cls: "tc-avail free", text: "● free that day", title: "No other event and no day off that day" });
      host.appendChild(pickBtn(x.c.id, x.c.name, [x.c.department, x.dept ? "★ matches" : "", noMail(x.c) ? "no e-mail on file" : ""].filter(Boolean).join(" · "), a, cur === x.c.id, sel, x.c));
    });
    restoreFocus(host, keep);
    paint(host);
  }
  function noMail(c) { return !!c && !String(c.email || "").trim() && !c.profile_id; }
  function pickBtn(id, name, sub, right, on, sel, crew) {
    return h("button", { type: "button", cls: "tc-pick", "data-key": "pick:" + id, "aria-pressed": String(!!on), on: { click: function () {
      if (sel) { sel.value = on ? "" : id; sel.dispatchEvent(new Event("change", { bubbles: true })); } picks(); sheetLabel(); } } },
      [crew ? avatar(name, id) : h("span", { cls: "tc-av", "aria-hidden": "true", text: "V" }), h("span", { cls: "grow" }, [h("b", { text: name || "" }), h("small", { text: sub })]), right]);
  }
  // the button says exactly what will happen: "Assign 2 tasks to Karthik"
  function sheetLabel() {
    var btn = $("#assignBtn"); if (!btn || btn.getAttribute("aria-busy") === "true") return;
    var vendor = $("#assignKind") && $("#assignKind").value === "outsourced", sel = vendor ? $("#assignVendor") : $("#assignCrew");
    var g = G(), id = sel ? sel.value : "", who = "";
    if (id) { var x = (vendor ? g.vendors : g.crew || []).filter(function (c) { return c.id === id; })[0]; who = x ? String(x.name || "").split(/\s+/)[0] : ""; }
    var n = S.preset ? S.preset.map(taskById).filter(function (t) { return t && REASSIGNABLE.indexOf(t.status) >= 0; }).length : ($("#taskList") ? $("#taskList").querySelectorAll(".tk:checked").length : 0);
    stepNote();
    btn.disabled = !canEdit() || !id || !n;
    btn.textContent = !n ? "Tick at least one task" : !id ? "Pick a " + (vendor ? "vendor" : "person") : "Assign " + n + " task" + (n === 1 ? "" : "s") + " to " + who;
  }
  function assigned(text) { layerClose(); S.sel = {}; if (text) toast(text, "ok", 9000); }

  /* ---- focus keeping across redraws ---- */
  function focusKey(root) { var a = doc.activeElement; if (!a || !root || !root.contains(a)) return null; return a.getAttribute("data-key") || null; }
  function restoreFocus(root, key) { if (!key || !root) return; var n = root.querySelector('[data-key="' + String(key).replace(/"/g, "") + '"]'); if (n && doc.activeElement !== n) try { n.focus({ preventScroll: true }); } catch (e) {} }

  /* ======================= data + clock ======================= */
  async function loadExtras() {
    var B0 = B(), g = G(), q = g.quoteId; if (!B0 || !q) return;
    await loadPerm();
    var ev = evDate(), from = ev ? addDays(ev, -1) : today(), to = ev ? addDays(ev, 1) : today();
    // R222: multi-day events - the can't-work days are read for every day this event has work on (max 92 days, the RPC limit)
    var wdays = workDays();
    wdays.forEach(function (d) { if (d < from) from = d; if (d > to) to = d; });
    if (TS.dayDiff(from, to) > 92) to = addDays(from, 92);
    var sh = B0.ops && B0.ops.shifts, lv = B0.ops && B0.ops.live;
    var jobs = [
      lv && lv.activity ? lv.activity(q, 200).then(function (r) { S.acts = Array.isArray(r) ? r.slice().sort(function (a, b) { return ms(b.at) - ms(a.at); }) : null; }).catch(function () {}) : null,
      sh && sh.timesheet ? sh.timesheet(q).then(function (r) {
        S.hasSheet = !!r; S.sheet = {};
        ((r && r.rows) || []).forEach(function (x) {
          if (!x || !x.crew_id) return;
          var es = (x.entries || []).filter(function (k) { return k && k.in; });
          var e = es.filter(function (k) { return r.today && k.day === r.today; })[0] || es.slice().sort(function (a, b) { return String(b.day).localeCompare(String(a.day)); })[0];
          if (e) S.sheet[x.crew_id] = { day: e.day, in: e.in, out: e.out || "", inAt: e.in_at || null, outAt: e.out_at || null, late_min: e.late_min || 0, hours: x.hours || null };
        });
      }).catch(function () { S.hasSheet = false; }) : null,
      sh && sh.availability ? sh.availability(from, to, null).then(function (rows) {
        S.avail = {};
        (rows || []).forEach(function (a) { if (!a || !a.crew_id || a.status !== "unavailable") return; (S.avail[a.crew_id] = S.avail[a.crew_id] || {})[String(a.day).slice(0, 10)] = { note: a.note || "", pending: a.approval === "pending" }; });
      }).catch(function () {}) : null,
      // R187 (0370): Approve / Reject here - feature-detected: without the server functions the box stays hidden
      sh && typeof sh.requests === "function" && typeof sh.decide === "function" ? sh.requests("open").then(function (r) { S.req = r && typeof r === "object" ? r : null; }).catch(function () { S.req = null; }) : null,
      S.escCfg == null && B0.taskReminders && B0.taskReminders.escalation ? B0.taskReminders.escalation().then(function (c) { S.escCfg = c || {}; }).catch(function () { S.escCfg = {}; }) : null,
      // R222: the run-sheet (once, then every 5 min) decides when the day starts and draws the timeline; issues on the day only
      sh && sh.dayStatus && (Date.now() - S.dayAt > 120000 || S.dayKey !== wdays.join(",")) ? loadDayStat(sh, q, wdays) : null,
      S.perm.rsView && B0.runsheet && Date.now() - S.rsAt > 300000 ? B0.runsheet.list(q).then(function (r) { S.rs = Array.isArray(r) ? r : []; S.rsAt = Date.now(); }).catch(function () { S.rs = null; S.rsAt = Date.now(); }) : null,
      issStep() || S.auto === "live" || S.autoStep === "pre" ? loadIssues() : null,
      loadPlan(false),
      loadSup(false)
    ].filter(Boolean);
    await Promise.all(jobs);
  }
  // the studio days with open work on this event for an in-house person (+ the event day), at most 7
  function workDays() {
    var ev = evDate(), d = ev ? [ev] : [];
    liveTasks().forEach(function (t) { if (!t.crew_id || !inHouse(t) || ["rejected", "completed"].indexOf(t.status) >= 0) return; var x = taskDay(t); if (x && d.indexOf(x) < 0) d.push(x); });
    return d.sort().slice(0, 7);
  }
  function loadDayStat(sh, q, days) {
    S.dayAt = Date.now(); S.dayKey = days.join(",");
    return Promise.all(days.map(function (d) {
      return sh.dayStatus(d, q).then(function (rows) {
        if (!Array.isArray(rows)) { S.dayStat[d] = null; return; }
        var m = {}; rows.forEach(function (x) { if (!x || !x.crew_id) return; var c = (Array.isArray(x.booked) ? x.booked : []).map(function (b) { return (b && b.code) || ""; });
          if (c.length) m[x.crew_id] = c.filter(Boolean).length ? c.filter(Boolean) : [""]; });
        S.dayStat[d] = m;
      }).catch(function () { S.dayStat[d] = null; });
    }));
  }
  function addDays(ymd, n) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd); return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n, 12)).toISOString().slice(0, 10); }
  async function reload(quiet) {
    var failed = false;
    try { if (P() && P().reload && (await P().reload()) === false) failed = true; } catch (e) { failed = true; }
    await loadExtras(); update();
    if (!quiet) { var u = $("#tcUpdated"); if (u) u.textContent = "Updated " + clock(new Date().toISOString()); }
    if (failed) return false;   // R235: the 30 s refresher then waits longer (2x, 4x ... 8 min) while the database is not answering
  }
  function busyElsewhere() { return Array.prototype.some.call(doc.querySelectorAll(".lmodal"), function (m) { return !m.hidden; }) || !!doc.querySelector("#app [aria-busy=true]:not(#view)"); }

  function update() {
    if (!S.started) return;
    memoReset();
    setPhaseAuto();   // R251: always - the badge and the "now" mark follow the real step even while a step is picked by hand
    renderHeader(); renderPhase(); renderPrep(); renderFloor(); renderPlan(); renderRun(); renderDelay(); renderAttn(); renderIssues(); renderSteps(); renderFlow(); renderChips(); renderViewBtns(); renderView(); renderSide(); renderBulk(); renderPrimary();
    var cnt = $("#taskCount"); if (cnt) cnt.textContent = String(liveTasks().length);
    var vo = $("#tcViewOnly"); if (vo) vo.hidden = canEdit();
    var add = $("#addBtn"); if (add) add.hidden = !canEdit();
    if (add && planLocked()) add.hidden = true;   // R227: the task plan is locked for the event day
    if (S.layer && S.layer.id === "drawer" && S.openId != null) renderPanel(false);
    if (S.layer && S.layer.id === "sheet") { picks(); sheetLabel(); }
    deepLink();
  }
  // notifications (ops.html?quote=..&task=..) and the monitor ("Open" -> #task-<id>) open the task panel once
  function deepLink() {
    if (S.deepDone || !(G().tasks || []).length) return; S.deepDone = true;
    var id = null; try { id = new URLSearchParams(global.location.search).get("task"); } catch (e) {}
    var m = /^#task-([0-9a-f-]{8,40})$/i.exec(global.location.hash || ""); if (m) id = m[1];
    if (global.location.hash === "#live") { try { ($("#tcSteps") || $("#attn")).scrollIntoView({ block: "start" }); } catch (e) {} }
    if (id && taskById(id)) setTimeout(function () { openTask(id); }, 0);
  }

  function init() {
    if (S.started) { update(); return; }
    S.started = true;
    // R222: the monitor's "Open" (#live) opens On the event and it stays there (before, the next refresh flipped it back)
    if (global.location.hash === "#live" && G().quoteId && modeNow().mode !== "live") S.manual = TS.normWin("live");
    // R230: the page opens on Tasks by department (the old direct layout); a pick made after R230 is kept (new key)
    var v = lsGet("helm.tc.view2"); S.view = v === "timeline" || v === "people" || v === "list" ? v : "list";
    var mon = $("#toMonitor"); if (mon) mon.setAttribute("href", "monitor.html?quote=" + encodeURIComponent(G().quoteId || ""));
    var all = $("#allActivity"); if (all) all.setAttribute("href", "monitor.html?quote=" + encodeURIComponent(G().quoteId || ""));
    Array.prototype.forEach.call(doc.querySelectorAll("#tcViews [data-view]"), function (b) { b.addEventListener("click", function () { setView(b.getAttribute("data-view")); }); });
    // R251: three steps; a tap only looks at a step (the real one carries the now mark)
    Array.prototype.forEach.call(doc.querySelectorAll("#tcPhase [data-win]"), function (b) { b.addEventListener("click", function () { pickWin(b.getAttribute("data-win")); }); });
    var qi = $("#tcQ"); if (qi) qi.addEventListener("input", function () { S.q = String(qi.value || "").slice(0, 80); update(); });
    doc.addEventListener("keydown", function (e) {
      trap(e);
      var a = doc.activeElement, typing = a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable);
      if (e.key === "/" && !typing && !S.layer && !e.metaKey && !e.ctrlKey && qi) { e.preventDefault(); qi.focus(); }
    });
    $("#addBtn").addEventListener("click", function () { openSheet(null); });
    $("#tcScrim").addEventListener("click", layerClose);
    Array.prototype.forEach.call(doc.querySelectorAll(".tc-layer [data-close]"), function (b) { b.addEventListener("click", layerClose); });
    $("#bulkClear").addEventListener("click", function () { S.sel = {}; S.sigs.view = ""; Object.keys(S.rows).forEach(function (k) { S.rows[k].sig = ""; }); update(); });
    Array.prototype.forEach.call(doc.querySelectorAll("[data-bulk]"), function (b) { b.addEventListener("click", function () { bulk(b.getAttribute("data-bulk")); }); });
    var pq = $("#pickQ"); if (pq) pq.addEventListener("input", picks);
    ["#assignKind", "#assignCrew", "#assignVendor"].forEach(function (s) { var e = $(s); if (e) e.addEventListener("change", function () { picks(); sheetLabel(); }); });
    var tl = $("#taskList"); if (tl) tl.addEventListener("change", sheetLabel);
    // the timeline's lanes are stacked for the width on screen: redraw it when that changes
    var rz = null; global.addEventListener("resize", function () { if (S.view !== "timeline") return; clearTimeout(rz); rz = setTimeout(update, 200); });
    // ONE refresh clock for the page, shared rules with /monitor (30 s + at once when you come back to the tab).
    // Skipped while a pop-up is open or an action is in flight, so nothing redraws under the user.
    S.timer = TS.refresher(function () { if (busyElsewhere()) return; return reload(true); }, TS.REFRESH_MS);
    setInterval(function () { if (!doc.hidden) { memoReset(); var was = S.win + S.autoWin; setPhaseAuto(); if (was !== S.win + S.autoWin) { update(); return; } renderHeader(); renderPhase(); renderAttn(); renderRun(); renderDelay(); renderFloor(); renderPlan(); renderPreCheck(); renderFlow(); } }, 60000);   // countdown / "late" minutes / run-sheet now
    loadExtras().then(update);
    update();
  }

  global.OpsBoard = { init: init, update: update, openTask: openTask, openSheet: openSheet, picks: picks, sheetLabel: sheetLabel, assigned: assigned,
    presetIds: presetIds, reload: reload, close: layerClose, sheetStep: sheetStep, stepTime: stepTime, stepNote: stepNote,
    _pure: { winWord: winWord, moveBy: moveBy, suggestShift: suggestShift, slot: slot, chipTest: chipTest, readyChecks: readyChecks, notCheckedIn: notCheckedIn, stackRows: stackRows, CHIPS: CHIPS, availWord: availWord, crewDay: crewDay, runRows: runRows, stepStart: stepStart, runEnd: runEnd, foldDefault: foldDefault, badgeOf: badgeOf }, _S: S };
})(typeof window !== "undefined" ? window : globalThis);
