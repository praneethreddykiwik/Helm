/* event-plan.js - R226 (EVENT-OPS-PLAN-V2.md): the parts of the event day that Tasks & Crew (ops.html) and the Event-day
 * monitor (monitor.html) show THE SAME WAY, so the two pages never disagree:
 *
 *   HelmEventPlan.DAYBEFORE                 the Day-before checklist lines (keys = the server's _r396_check_keys, 0396)
 *   HelmEventPlan.schedule(tasks, o)        the backward schedule (pure): every timed set-up job (duration set, not
 *                                           cancelled) gets latest finish = the earliest latest start of the jobs that need
 *                                           it first (depends_on), else Ready by; latest start = latest finish - duration x
 *                                           (1 + buffer %) rounded up to the minute (the SAME sum as _r396_schedule). A loop
 *                                           in the links -> those jobs are timed from Ready by. Plus a forward pass from
 *                                           Venue opens / real start times: "at this pace ready around 4:40 PM".
 *                                           o: { readyAt ms, venueAt ms, bufPct, remindMin, now }
 *   HelmEventPlan.readyAt(plan, ev, gt, tz) Ready by as an instant: the plan's Ready by, else 1 h before Guests arrive
 *   HelmEventPlan.learnedFor(plan, title)   how long a task with this name really took before (0396 learned list)
 *   HelmEventPlan.renderReady(host, ctx)    the "Ready by" card (times, status line, jobs with latest start, edit forms,
 *                                           alert settings)
 *   HelmEventPlan.renderDayBefore(host, ctx) the Day-before checklist card (tick = who + when; untick kept)
 *   ctx: { plan (event_day_plan_get answer), tasks, quoteId, eventDate, eventTime, tz, now, nameOf(t), toast(msg, type),
 *          onChanged() (reload the plan + tasks), compact (monitor: fewer words) }
 * Before 0396 is applied plan is null and both cards stay hidden (the callers check). DOM calls only (textContent), never
 * HTML strings. Money is never read or shown. */
(function (global) {
  "use strict";
  var doc = global.document;

  /* ---------------- pure ---------------- */
  var DAYBEFORE = [
    ["vendors", "Every vendor called", "arrival time, set-up window, who is in charge on site", "vendors.html"],
    ["headcount", "Final guest count sent to the caterer", "most caterers need it 3-7 days before; it can go up, rarely down", "event"],
    ["crew_call", "Crew call times sent", "who comes when - the task e-mail / WhatsApp has each person's start time", "ops"],
    ["load_list", "Load list packed and checked", "against the stock list for this event; trucks load in reverse of set-up order", "resources"],
    ["transport", "Trucks / tempo booked", "driver names and numbers saved, pick-up time fixed", "logistics"],
    ["venue_access", "Venue access confirmed", "gate, lift, parking and the load-in time - put it in Venue opens", ""],
    ["power", "Power and generator confirmed", "load, diesel, a backup plan if the venue supply fails", ""],
    ["permits", "Permits in hand", "police / loudspeaker permission (no loudspeakers 10 PM - 6 AM), fire NOC where needed", ""],
    ["weather", "Rain / weather plan checked", "forecast, covers for the mandap and food counters, the backup space", ""],
    ["runsheet", "Run-sheet final and shared", "with the client, the venue and every vendor", "runsheet"],
    ["client", "Client confirmed the final timings", "and any last-minute changes", "event"]
  ];
  function num(v) { var n = Number(v); return isFinite(n) ? n : NaN; }
  function ms(v) { if (v == null || v === "") return NaN; var t = typeof v === "number" ? v : new Date(v).getTime(); return isFinite(t) ? t : NaN; }
  function padMin(d, buf) { return Math.ceil(d * (100 + buf) / 100); }
  function schedule(tasks, o) {
    o = o || {}; var ready = ms(o.readyAt), buf = isFinite(num(o.bufPct)) ? num(o.bufPct) : 15, now = o.now == null ? Date.now() : o.now;
    var remind = isFinite(num(o.remindMin)) ? num(o.remindMin) : 30, venue = ms(o.venueAt);
    var jobs = (tasks || []).filter(function (t) { return t && t.status !== "cancelled" && num(t.duration_min) > 0; });
    var byId = {}; jobs.forEach(function (t) { byId[t.id] = { t: t, dur: Math.round(num(t.duration_min)), ls: NaN, lf: NaN }; });
    var untimed = (tasks || []).filter(function (t) { return t && t.status !== "cancelled" && t.status !== "completed" && !(num(t.duration_min) > 0); });
    if (!isFinite(ready)) return { rows: jobs.map(function (t) { return { t: t, dur: Math.round(num(t.duration_min)), state: "noready" }; }), untimed: untimed, ready: NaN };
    var ids = Object.keys(byId), pass = 0, changed = true;
    while (changed && pass <= ids.length + 1) {
      pass++; changed = false;
      ids.forEach(function (id) {
        var j = byId[id]; if (isFinite(j.ls)) return;
        var okAll = true, m = NaN;
        ids.forEach(function (k) { if (k === id || byId[k].t.depends_on !== id) return; if (!isFinite(byId[k].ls)) okAll = false; else if (!isFinite(m) || byId[k].ls < m) m = byId[k].ls; });
        if (!okAll) return;
        j.lf = isFinite(m) ? m : ready; j.ls = j.lf - padMin(j.dur, buf) * 60000; changed = true;
      });
    }
    ids.forEach(function (id) { var j = byId[id]; if (!isFinite(j.ls)) { j.lf = ready; j.ls = ready - padMin(j.dur, buf) * 60000; j.loop = true; } });
    // forward pass: when would each job finish at this pace (real start / done times win; never before Venue opens or now)
    var ef = {}, seen = {};
    function finish(id, depth) {
      if (ef[id] != null) return ef[id]; var j = byId[id]; if (!j || depth > ids.length + 1 || seen[id]) return NaN; seen[id] = 1;
      var t = j.t, done = ms(t.completed_at), st = ms(t.started_at);
      if (t.status === "completed") { ef[id] = isFinite(done) ? done : now; return ef[id]; }
      var es = isFinite(st) ? st : Math.max(now, isFinite(venue) ? venue : -Infinity);
      if (!isFinite(st) && t.depends_on && byId[t.depends_on]) { var pf = finish(t.depends_on, depth + 1); if (isFinite(pf) && pf > es) es = pf; }
      ef[id] = es + padMin(j.dur, buf) * 60000; return ef[id];
    }
    var est = -Infinity;
    var rows = ids.map(function (id) {
      var j = byId[id], t = j.t, f = finish(id, 0); if (isFinite(f) && f > est) est = f;
      var state = t.status === "completed" ? "done" : t.status === "in_progress" ? "started" : now >= j.ls ? "late" : now >= j.ls - remind * 60000 ? "soon" : "ok";
      var planned = ms(t.planned_start);
      return { t: t, dur: j.dur, ls: j.ls, lf: j.lf, loop: !!j.loop, state: state, finish: f, need: t.depends_on && byId[t.depends_on] ? byId[t.depends_on].t : null,
        plannedLate: isFinite(planned) && planned > j.ls && t.status !== "completed" && t.status !== "in_progress",
        tooEarly: isFinite(venue) && j.ls < venue };
    }).sort(function (a, b) { return a.ls - b.ls || String(a.t.title || "").localeCompare(String(b.t.title || "")); });
    return { rows: rows, untimed: untimed, ready: ready, estimate: isFinite(est) ? est : NaN, behindMin: isFinite(est) && est > ready ? Math.ceil((est - ready) / 60000) : 0,
      late: rows.filter(function (r) { return r.state === "late"; }).length, done: rows.filter(function (r) { return r.state === "done"; }).length };
  }
  function hmMin(v) { var T = global.HelmTaskStatus; return T && T.hmMin ? T.hmMin(v) : NaN; }
  function readyAt(plan, ev, guestsAt, tz) {
    var T = global.HelmTaskStatus; if (!T || !/^\d{4}-\d{2}-\d{2}/.test(String(ev || ""))) return NaN;
    var d = String(ev).slice(0, 10), rb = plan && plan.ready_by ? hmMin(plan.ready_by) : NaN;
    if (isFinite(rb)) return T.wallMs(d, rb, tz);
    var g = hmMin(guestsAt); return isFinite(g) ? T.wallMs(d, g, tz) - 3600000 : NaN;
  }
  function venueAt(plan, ev, tz) {
    var T = global.HelmTaskStatus, v = plan && plan.venue_access ? hmMin(plan.venue_access) : NaN;
    return T && isFinite(v) && /^\d{4}-\d{2}-\d{2}/.test(String(ev || "")) ? T.wallMs(String(ev).slice(0, 10), v, tz) : NaN;
  }
  function learnedFor(plan, title) {
    var k = String(title || "").trim().toLowerCase(); if (!k || !plan || !Array.isArray(plan.learned)) return null;
    for (var i = 0; i < plan.learned.length; i++) if (plan.learned[i] && plan.learned[i].title === k) return plan.learned[i];
    return null;
  }
  function durWords(m) { m = Math.round(m); if (!(m > 0)) return "0 min"; var hh = Math.floor(m / 60), mm = m % 60; return hh ? hh + " h" + (mm ? " " + mm + " min" : "") : mm + " min"; }

  /* ---------------- DOM ---------------- */
  function h(tag, o, kids) {
    var n = doc.createElement(tag); o = o || {};
    Object.keys(o).forEach(function (k) {
      var v = o[k]; if (v == null || v === false) return;
      if (k === "cls") n.className = v; else if (k === "text") n.textContent = v;
      else if (k === "on") Object.keys(v).forEach(function (e) { n.addEventListener(e, v[e]); });
      else if (k === "value") n.value = v; else if (k === "checked") n.checked = !!v;
      else n.setAttribute(k, v === true ? "" : String(v));
    });
    (kids || []).forEach(function (c) { if (c != null && c !== false) n.appendChild(typeof c === "string" ? doc.createTextNode(c) : c); });
    return n;
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  function clock(t, tz) {
    if (!isFinite(t)) return "-";
    try { return new Intl.DateTimeFormat("en-IN", { timeZone: tz || "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(t)).replace(/\s?([ap])m$/i, function (x, a) { return " " + a.toUpperCase() + "M"; }); }
    catch (e) { return new Date(t).toISOString().slice(11, 16); }
  }
  function hhmm(t, tz) { if (!isFinite(t)) return ""; try { var p = new Intl.DateTimeFormat("en-GB", { timeZone: tz || "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(t)); return p; } catch (e) { return ""; } }
  function api() { return global.BPStore && global.BPStore.ops && global.BPStore.ops.dayPlan; }
  function errText(e, what) { try { if (global.BPUI && global.BPUI.friendlyError) return global.BPUI.friendlyError(e, { action: what }); } catch (x) {} return "Could not " + what + "."; }
  var REASON = { invalid_time: "That time is not clear - use a time like 17:00 or 5:00 PM.", invalid_minutes: "Minutes must be between 1 and 1440.",
    needs_loop: "That would make a loop - the other task already needs this one first.", invalid_needs: "Pick a task of this event.",
    invalid_settings: "One of the numbers is out of range.", invalid_key: "That checklist line is not known." };
  function why(e, what) { var m = String((e && e.message) || ""); for (var k in REASON) if (m.indexOf(k) >= 0) return REASON[k]; return errText(e, what); }
  function say(ctx, msg, type) { if (ctx && typeof ctx.toast === "function") ctx.toast(msg, type); }
  var STATE = { done: ["Done", "ok"], started: ["Started", "ok"], late: ["Start now - late", "bad"], soon: ["Start soon", "warn"], ok: ["On time", ""], noready: ["", ""] };

  // the forms keep their state across the 30 s redraws (the card is rebuilt only when its content changed)
  var UI = { edit: null, times: false, settings: false };

  function timesForm(ctx, host) {
    var p = ctx.plan || {}, tz = ctx.tz;
    var va = h("input", { type: "time", cls: "ep-inp", id: "epVenue", value: p.venue_access || "" });
    var rb = h("input", { type: "time", cls: "ep-inp", id: "epReady", value: p.ready_by || hhmm(readyAt(null, ctx.eventDate, ctx.eventTime, tz), tz) });
    var err = h("p", { cls: "ep-err", role: "alert", hidden: true });
    var save = h("button", { type: "button", cls: "tc-btn sm tc-primary", text: "Save times" });
    save.addEventListener("click", async function () {
      save.disabled = true; err.hidden = true;
      try { await api().setTimes(ctx.quoteId, va.value, rb.value); UI.times = false; say(ctx, "Times saved.", "ok"); if (ctx.onChanged) await ctx.onChanged(); }
      catch (e) { err.textContent = why(e, "save the times"); err.hidden = false; save.disabled = false; }
    });
    return h("div", { cls: "ep-form", role: "group", "aria-label": "Event day times" }, [
      h("label", { cls: "ep-lbl", for: "epVenue" }, ["Venue opens ", h("small", { text: "when the crew can get in (load-in)" })]), va,
      h("label", { cls: "ep-lbl", for: "epReady" }, ["Ready by ", h("small", { text: "every set-up job finished - usually 1 h before guests" })]), rb, err,
      h("div", { cls: "ep-acts" }, [h("button", { type: "button", cls: "tc-btn sm", text: "Cancel", on: { click: function () { UI.times = false; ctx._redraw(); } } }), save])
    ]);
  }
  function settingsForm(ctx) {
    var s = (ctx.plan && ctx.plan.settings) || {}, roles = Array.isArray(s.notify_roles) ? s.notify_roles : [];
    var on = h("input", { type: "checkbox", id: "epAlOn", checked: s.enabled !== false });
    var hb = h("input", { type: "number", cls: "ep-inp sm", id: "epAlHour", min: "10", max: "240", step: "5", value: String(s.hour_before_min || 60), inputmode: "numeric" });
    var la = h("input", { type: "checkbox", id: "epAlLate", checked: s.latest_alerts !== false });
    var rm = h("input", { type: "number", cls: "ep-inp sm", id: "epAlRem", min: "0", max: "180", step: "5", value: String(s.remind_before_min == null ? 30 : s.remind_before_min), inputmode: "numeric" });
    var bf = h("input", { type: "number", cls: "ep-inp sm", id: "epAlBuf", min: "0", max: "100", step: "5", value: String(s.buffer_pct == null ? 15 : s.buffer_pct), inputmode: "numeric" });
    var boxes = [["manager", "Managers"], ["supervisor", "Supervisors"], ["coordinator", "Coordinators"], ["admin", "Admins"]].map(function (r) {
      return [r[0], h("input", { type: "checkbox", id: "epAlR-" + r[0], checked: roles.indexOf(r[0]) >= 0 }), r[1]]; });
    var err = h("p", { cls: "ep-err", role: "alert", hidden: true });
    var save = h("button", { type: "button", cls: "tc-btn sm tc-primary", text: "Save alert settings" });
    save.addEventListener("click", async function () {
      save.disabled = true; err.hidden = true;
      try {
        await api().saveSettings({ enabled: on.checked, hour_before_min: Number(hb.value), latest_alerts: la.checked, remind_before_min: Number(rm.value),
          buffer_pct: Number(bf.value), notify_roles: boxes.filter(function (b) { return b[1].checked; }).map(function (b) { return b[0]; }) });
        UI.settings = false; say(ctx, "Alert settings saved for the studio.", "ok"); if (ctx.onChanged) await ctx.onChanged();
      } catch (e) { err.textContent = why(e, "save the alert settings"); err.hidden = false; save.disabled = false; }
    });
    return h("div", { cls: "ep-form", role: "group", "aria-label": "Alert settings" }, [
      h("p", { cls: "ep-hint", text: "For the whole studio. Alerts are bell notices inside Helm only (no e-mail or WhatsApp). The event's manager always gets them." }),
      h("label", { cls: "ep-chk", for: "epAlOn" }, [on, " Tell the team before the event starts"]),
      h("label", { cls: "ep-lbl", for: "epAlHour", text: "How many minutes before guests arrive" }), hb,
      h("div", { cls: "ep-roles", role: "group", "aria-label": "Who gets the alerts" }, boxes.map(function (b) { return h("label", { cls: "ep-chk", for: b[1].id }, [b[1], " " + b[2]]); })),
      h("label", { cls: "ep-chk", for: "epAlLate" }, [la, " Remind before a job's latest start, red alert if it has not started"]),
      h("label", { cls: "ep-lbl", for: "epAlRem", text: "Remind how many minutes before the latest start" }), rm,
      h("label", { cls: "ep-lbl", for: "epAlBuf", text: "Safety buffer added to every job (%)" }), bf, err,
      h("div", { cls: "ep-acts" }, [h("button", { type: "button", cls: "tc-btn sm", text: "Cancel", on: { click: function () { UI.settings = false; ctx._redraw(); } } }), save])
    ]);
  }
  function jobForm(ctx, t) {
    var cur = num(t.duration_min) > 0 ? Math.round(num(t.duration_min)) : "";
    var mins = h("input", { type: "number", cls: "ep-inp sm", id: "epJobMin", min: "1", max: "1440", step: "5", value: String(cur), inputmode: "numeric", "aria-describedby": "epJobHint" });
    var lr = learnedFor(ctx.plan, t.title);
    var sel = h("select", { cls: "ep-inp", id: "epJobNeed" }, [h("option", { value: "", text: "Nothing - it can start any time" })]);
    (ctx.tasks || []).filter(function (x) { return x && x.id !== t.id && x.status !== "cancelled"; })
      .sort(function (a, b) { return String(a.title || "").localeCompare(String(b.title || "")); })
      .forEach(function (x) { var o = h("option", { value: x.id, text: (x.title || "Task") + (x.category ? " · " + x.category : "") }); if (x.id === t.depends_on) o.selected = true; sel.appendChild(o); });
    var err = h("p", { cls: "ep-err", role: "alert", hidden: true });
    var save = h("button", { type: "button", cls: "tc-btn sm tc-primary", text: "Save" });
    save.addEventListener("click", async function () {
      var v = String(mins.value || "").trim(), n = v === "" ? null : Number(v);
      if (n != null && !(n >= 1 && n <= 1440)) { err.textContent = REASON.invalid_minutes; err.hidden = false; mins.focus(); return; }
      save.disabled = true; err.hidden = true;
      try { await api().duration(t.id, n, sel.value || null); UI.edit = null; say(ctx, "Saved: " + (t.title || "task") + (n ? " takes " + durWords(n) : "") + ".", "ok"); if (ctx.onChanged) await ctx.onChanged(); }
      catch (e) { err.textContent = why(e, "save the job"); err.hidden = false; save.disabled = false; }
    });
    var kids = [h("p", { cls: "ep-form-h" }, [h("b", { text: t.title || "Task" })]),
      h("label", { cls: "ep-lbl", for: "epJobMin", text: "How long it takes (minutes)" }), mins];
    kids.push(h("p", { cls: "ep-hint", id: "epJobHint", text: lr ? "Last " + lr.n + " time" + (lr.n === 1 ? "" : "s") + " this took about " + durWords(lr.minutes) + "." : "Helm learns this from the start and done times of your past events." }));
    if (lr) kids.push(h("button", { type: "button", cls: "tc-btn sm ghost", text: "Use " + durWords(lr.minutes), on: { click: function () { mins.value = String(lr.minutes); } } }));
    kids.push(h("label", { cls: "ep-lbl", for: "epJobNeed", text: "Needs first (must be done before this starts)" }), sel, err,
      h("div", { cls: "ep-acts" }, [h("button", { type: "button", cls: "tc-btn sm", text: "Cancel", on: { click: function () { UI.edit = null; ctx._redraw(); } } }), save]));
    return h("div", { cls: "ep-form", role: "group", "aria-label": "Set-up job" }, kids);
  }

  function renderReady(host, ctx) {
    if (!host) return; ctx = ctx || {}; ctx._redraw = function () { renderReady(host, ctx); };
    var p = ctx.plan || {}, tz = ctx.tz, now = ctx.now == null ? Date.now() : ctx.now, set = p.settings || {};
    var rAt = readyAt(p, ctx.eventDate, ctx.eventTime, tz), vAt = venueAt(p, ctx.eventDate, tz);
    var sc = schedule(ctx.tasks, { readyAt: rAt, venueAt: vAt, bufPct: set.buffer_pct, remindMin: set.remind_before_min, now: now });
    var canEdit = !!p.can_edit, focusId = doc.activeElement && host.contains(doc.activeElement) ? doc.activeElement.id : "";
    clear(host);
    var head = h("div", { cls: "ep-head" }, [h("h3", { cls: "tc-h2", id: host.id + "H" }, ["Ready by ", h("span", { cls: "ep-big", text: isFinite(rAt) ? clock(rAt, tz) : "not set" })])]);
    var facts = [];
    if (!p.ready_by && isFinite(rAt)) facts.push("1 h before guests (" + String(ctx.eventTime || "") + ")");
    if (isFinite(vAt)) facts.push("Venue opens " + clock(vAt, tz));
    if (ctx.eventTime && p.ready_by) facts.push("Guests " + String(ctx.eventTime));
    head.appendChild(h("span", { cls: "ep-facts", text: facts.join(" · ") }));
    if (canEdit && !UI.times) head.appendChild(h("button", { type: "button", cls: "tc-btn sm", id: host.id + "Times", text: isFinite(vAt) || p.ready_by ? "Edit times" : "Set times", on: { click: function () { UI.times = true; UI.edit = null; ctx._redraw(); var f = doc.getElementById("epVenue"); if (f) f.focus(); } } }));
    host.appendChild(head);
    if (UI.times && canEdit) host.appendChild(timesForm(ctx, host));
    // the one-line answer
    var line, cls = "";
    if (!isFinite(rAt)) { line = "Set Ready by (or Guests arrive on the event) to see when each set-up job must start."; cls = "warn"; }
    else if (!sc.rows.length) { line = "Say how long each set-up job takes (Set time on a job below) and Helm works out the latest start for each, " + (set.buffer_pct == null ? 15 : set.buffer_pct) + "% buffer included."; }
    else if (sc.done === sc.rows.length) { line = "Every set-up job is done."; cls = "ok"; }
    else if (sc.behindMin > 0) { line = "Behind: at this pace ready around " + clock(sc.estimate, tz) + " - " + durWords(sc.behindMin) + " after Ready by." + (sc.late ? " " + sc.late + " job" + (sc.late === 1 ? "" : "s") + " past the latest start." : ""); cls = "bad"; }
    else if (sc.late) { line = sc.late + " job" + (sc.late === 1 ? " is" : "s are") + " past the latest start - start now."; cls = "bad"; }
    else { line = "On track" + (isFinite(sc.estimate) ? ": ready around " + clock(sc.estimate, tz) : "") + " · " + sc.done + " of " + sc.rows.length + " set-up jobs done."; cls = "ok"; }
    host.appendChild(h("p", { cls: "ep-status " + cls, role: cls === "bad" ? "alert" : null, text: line }));
    if (sc.rows.length) {
      var ol = h("ol", { cls: "ep-jobs", "aria-labelledby": host.id + "H" });
      sc.rows.forEach(function (r) {
        var st = STATE[r.state] || STATE.ok, who = ctx.nameOf ? ctx.nameOf(r.t) : (r.t.assignee_name || "");
        var sub = [who || "No one yet", durWords(r.dur) + " + " + (set.buffer_pct == null ? 15 : set.buffer_pct) + "%", r.need ? "needs " + (r.need.title || "a task") + " first" : ""];
        if (r.plannedLate) sub.push("planned start is after the latest start");
        if (r.tooEarly) sub.push("would have to start before the venue opens");
        if (r.loop) sub.push("loop in 'needs first' - timed from Ready by");
        var li = h("li", { cls: "ep-job " + r.state }, [
          h("span", { cls: "ep-job-t" }, [h("small", { text: r.state === "done" || r.state === "started" ? "" : "Start by" }), r.state === "done" ? "✓" : clock(r.ls, tz)]),
          h("span", { cls: "grow" }, [h("b", { text: r.t.title || "Task" }), st[0] ? h("span", { cls: "tc-tag " + st[1], text: st[0] }) : null,
            h("span", { cls: "tc-sub", text: sub.filter(Boolean).join(" · ") })])]);
        if (canEdit && r.state !== "done") li.appendChild(h("button", { type: "button", cls: "tc-btn sm ghost", id: "epEdit-" + r.t.id, text: "Edit", "aria-label": "Edit " + (r.t.title || "job"), on: { click: function () { UI.edit = r.t.id; UI.times = false; ctx._redraw(); var f = doc.getElementById("epJobMin"); if (f) f.focus(); } } }));
        ol.appendChild(li);
        if (UI.edit === r.t.id && canEdit) ol.appendChild(h("li", { cls: "ep-job-form" }, [jobForm(ctx, r.t)]));
      });
      host.appendChild(ol);
    }
    if (canEdit && sc.untimed.length) {
      var box = h("div", { cls: "ep-untimed" }, [h("span", { cls: "tc-sub", text: sc.untimed.length + " task" + (sc.untimed.length === 1 ? " has" : "s have") + " no duration yet (not counted):" })]);
      sc.untimed.slice(0, ctx.compact ? 4 : 8).forEach(function (t) {
        box.appendChild(h("button", { type: "button", cls: "tc-chip", id: "epSet-" + t.id, text: "+ " + (t.title || "Task"), title: "Set how long it takes", on: { click: function () { UI.edit = t.id; UI.times = false; ctx._redraw(); var f = doc.getElementById("epJobMin"); if (f) f.focus(); } } }));
      });
      host.appendChild(box);
      var ed = UI.edit && sc.untimed.filter(function (t) { return t.id === UI.edit; })[0];
      if (ed) host.appendChild(jobForm(ctx, ed));
    }
    // who gets told
    var roles = Array.isArray(set.notify_roles) ? set.notify_roles : [], rw = roles.length ? roles.join(" + ") : "admins";
    var foot = h("p", { cls: "ep-foot" }, [set.enabled === false ? "Alerts are off for the studio." :
      "Bell alerts: “starts in " + durWords(set.hour_before_min || 60) + " - ready?” to the event manager + " + rw + (set.latest_alerts === false ? "." : "; a reminder " + durWords(set.remind_before_min == null ? 30 : set.remind_before_min) + " before a job's latest start and a red alert if it has not started.")]);
    if (p.can_settings && !UI.settings) foot.appendChild(h("button", { type: "button", cls: "tc-mini-link ep-linkbtn", id: host.id + "Alerts", text: "Alert settings", on: { click: function () { UI.settings = true; ctx._redraw(); var f = doc.getElementById("epAlOn"); if (f) f.focus(); } } }));
    host.appendChild(foot);
    if (UI.settings && p.can_settings) host.appendChild(settingsForm(ctx));
    if (focusId) { var back = doc.getElementById(focusId); if (back) try { back.focus(); } catch (e) {} }
  }

  function renderDayBefore(host, ctx) {
    if (!host) return; ctx = ctx || {};
    var p = ctx.plan || {}, checks = p.checks || {}, canEdit = !!p.can_edit, q = encodeURIComponent(ctx.quoteId || "");
    var focusId = doc.activeElement && host.contains(doc.activeElement) ? doc.activeElement.id : "";
    var done = DAYBEFORE.filter(function (d) { return checks[d[0]] && checks[d[0]].done; }).length;
    clear(host);
    host.appendChild(h("div", { cls: "ep-head" }, [h("h3", { cls: "tc-h2", id: host.id + "H" }, ["Day before ", h("span", { cls: "tc-n", text: done + " / " + DAYBEFORE.length })]),
      h("span", { cls: "ep-facts", text: done === DAYBEFORE.length ? "All set for tomorrow." : "Call, confirm and pack - tick each line when it is done." })]));
    var ul = h("ul", { cls: "ep-checks", "aria-labelledby": host.id + "H" });
    DAYBEFORE.forEach(function (d) {
      var c = checks[d[0]] || {}, on = !!c.done, href = "";
      if (d[3] === "event") href = "event.html?id=" + q; else if (d[3] === "ops") href = "ops.html?quote=" + q;
      else if (d[3] === "vendors.html") href = "vendors.html"; else if (d[3]) href = d[3] + ".html?quote=" + q;
      var by = c.by ? (on ? "✓ " : "Unticked by ") + c.by + (c.at ? " · " + clock(ms(c.at), ctx.tz) + (String(c.at).slice(0, 10) !== new Date(ctx.now || Date.now()).toISOString().slice(0, 10) ? " " + String(c.at).slice(8, 10) + "/" + String(c.at).slice(5, 7) : "") : "") : "";
      var btn = h("button", { type: "button", cls: "ep-tick" + (on ? " on" : ""), id: "epChk-" + d[0], "aria-pressed": on ? "true" : "false", disabled: canEdit ? null : true,
        "aria-label": (on ? "Done: " : "Not done: ") + d[1] }, [h("span", { cls: "ep-box", "aria-hidden": "true", text: on ? "✓" : "" })]);
      if (canEdit) btn.addEventListener("click", async function () {
        btn.disabled = true;
        try { await api().check(ctx.quoteId, d[0], !on); if (ctx.onChanged) await ctx.onChanged(); }
        catch (e) { say(ctx, why(e, "save the tick"), "err"); btn.disabled = false; }
      });
      ul.appendChild(h("li", { cls: "ep-check" + (on ? " on" : "") }, [btn, h("span", { cls: "grow" }, [h("b", { text: d[1] }), h("span", { cls: "tc-sub", text: d[2] }), by ? h("span", { cls: "ep-by", text: by }) : null]),
        href ? h("a", { cls: "tc-mini-link", href: href, text: "Open →", "aria-label": "Open for: " + d[1] }) : null]));
    });
    host.appendChild(ul);
    if (!canEdit) host.appendChild(h("p", { cls: "ep-hint", text: "Someone who can give out work (Assign & send tasks) ticks these." }));
    if (focusId) { var back = doc.getElementById(focusId); if (back) try { back.focus(); } catch (e) {} }
  }

  global.HelmEventPlan = { DAYBEFORE: DAYBEFORE, schedule: schedule, readyAt: readyAt, venueAt: venueAt, learnedFor: learnedFor, durWords: durWords,
    renderReady: renderReady, renderDayBefore: renderDayBefore, _ui: UI };
})(typeof window !== "undefined" ? window : globalThis);
