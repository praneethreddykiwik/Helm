/* task-reminders-ui.js - R130 (0338): task reminders on the Tasks & staff page and in Settings. R171 (0362): every reminder
   also goes by e-mail to the address on the staff record (R170 / 0361), so the wording says "email and WhatsApp".
   Owner rules (9 Nov 2026): ticked by default 10 and 5 minutes before (custom allowed); when a task is late, a reminder
   every 15 minutes up to 3 times, then the office is told; everything explained in Settings and the guide. Messages go
   out only from the studio's own WhatsApp number (wa-setup-note.js says when it is not set up).
   API (window.HelmTaskReminders):
     schedFields(container, task, settings[, opts]) -> { value(), times() }   Schedule task popup / Assign form:
         tick boxes + custom minutes + R173 (0364) reminders at an exact clock time
         value(): null = "use the studio default", or a list of minutes (may be [] = no reminders for this task)
         times(): the exact times as ISO strings ([] = none); throws (and shows the error) when one is not valid.
         opts: { toLocal(iso) -> "YYYY-MM-DDTHH:MM" (studio clock), fromLocal(str) -> Date, start() -> ISO | null,
                 idp: id prefix (two forms on one page) }
     summary(task, settings, clock) -> string                    Live Status: "10 & 5 min before · 5:32 PM" 
     chip(row) -> { text, state, title } | null                 Live Status: the task's latest WhatsApp line
     settingsCard(host[, { store }])                            Settings -> Notifications -> Task reminders
     explain(settings) -> string                                 the plain-words rule shown in both places
   CSP-safe: createElement / textContent only; pure helpers exported for tests. */
(function (global) {
  "use strict";
  var CHOICES = [30, 15, 10, 5, 3, 1, 0];
  function label(m) { return m === 0 ? "At the start time" : m + " min before"; }
  function sortMins(a) {
    var seen = {}, out = [];
    (Array.isArray(a) ? a : []).forEach(function (x) { var n = Number(x); if (isFinite(n) && n >= 0 && n <= 1440 && n === Math.floor(n) && !seen[n]) { seen[n] = 1; out.push(n); } });
    return out.sort(function (x, y) { return y - x; });
  }
  function parseCustom(v) {
    var s = String(v == null ? "" : v).trim();
    if (!s) return { ok: true, mins: [] };
    var parts = s.split(/[\s,]+/).filter(Boolean), out = [];
    for (var i = 0; i < parts.length; i++) {
      if (!/^[0-9]{1,4}$/.test(parts[i])) return { ok: false, error: "Type minutes as whole numbers, e.g. 45 or 20, 7." };
      var n = Number(parts[i]); if (n > 1440) return { ok: false, error: "At most 1440 minutes (one day) before." };
      out.push(n);
    }
    return { ok: true, mins: out };
  }
  function listText(mins) {
    var m = sortMins(mins); if (!m.length) return "no reminders";
    var parts = m.map(function (x) { return x === 0 ? "at the start time" : x + " min"; });
    var last = parts.pop();
    return (parts.length ? parts.join(", ") + " and " + last : last) + (m.some(function (x) { return x > 0; }) ? " before" : "");
  }
  function explain(s) {
    s = s || {};
    var before = sortMins(s.default_before == null ? [10, 5] : s.default_before);
    var every = Number(s.late_every_min) || 15, max = s.late_max == null ? 3 : Number(s.late_max);
    var t = "When a task has a start time, the person on it gets a reminder by email (to the address on their staff record) and on WhatsApp (once your studio number is connected) " + listText(before).replace(/^no reminders$/, "(no reminders)") + ", plus any exact times set on the task. ";
    t += max > 0 ? "If it hasn't started by then, a late reminder goes every " + every + " minutes, up to " + max + " time" + (max === 1 ? "" : "s") + ". " : "Late reminders are off. ";
    if (s.alert_office !== false) t += "After that, the event manager is told (bell, email + WhatsApp). ";
    if (s.hold_waiting !== false) t += "A task that waits on an unfinished task gets its reminder once the earlier task is done. ";
    t += "Done, cancelled or started tasks get nothing more. A new time or a new person starts fresh. All times are in your studio's time zone.";
    return t;
  }
  var STATE = { queued: ["Queued", "wait"], sent: ["Sent on WhatsApp", "on"], delivered: ["Delivered", "on"], read: ["Read", "on"],
    failed: ["Failed", "off"], skipped: ["Not sent", "none"], not_set_up: ["Not sent – WhatsApp not set up", "off"] };
  var WHAT = { assigned: "Task message", reminder: "Reminder", late: "Late reminder" };
  function chip(row) {
    if (!row || !row.status) return null;
    // R173 (0364): no phone number on the task -> the reminder went by e-mail only
    if (row.status === "skipped" && row.reason === "email_only") return { text: (WHAT[row.what] || "Reminder") + ": email only (no phone)", state: "none", title: "No phone number on this task, so the reminder went by email only." };
    var st = STATE[row.status] || [String(row.status), "none"];
    var text = (WHAT[row.what] || "WhatsApp") + ": " + st[0];
    var title = row.status === "failed" || row.status === "skipped" || row.status === "not_set_up" ? "Not delivered on WhatsApp - share the worker link by hand." : "";
    return { text: text, state: st[1], title: title };
  }

  var doc = global.document;
  function el(tag, cls, t) { var n = doc.createElement(tag); if (cls) n.className = cls; if (t != null) n.textContent = t; return n; }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function checkbox(id, text, on) {
    var w = el("label", "trm-cb"), c = el("input"); c.type = "checkbox"; c.id = id; c.checked = !!on;
    w.appendChild(c); w.appendChild(el("span", null, text)); return { wrap: w, input: c };
  }

  // ---- Schedule task popup ---------------------------------------------------------------------------------------------
  function schedFields(container, task, settings, opts) {
    if (!container) return { value: function () { return null; }, times: function () { return []; } };
    opts = opts || {};
    var P = /^[a-z]{1,8}$/.test(String(opts.idp || "")) ? String(opts.idp) : "trm";
    clear(container);
    var def = sortMins(settings && settings.default_before != null ? settings.default_before : [10, 5]);
    var own = task && Array.isArray(task.remind_before) ? sortMins(task.remind_before) : null;
    var useDef = own === null;
    var cur = own === null ? def : own;
    container.appendChild(el("legend", null, "Reminders (email + WhatsApp)"));
    var dflt = checkbox(P + "_def", "Use the studio default (" + listText(def) + ")", useDef);
    container.appendChild(dflt.wrap);
    var grid = el("div", "trm-grid");
    var boxes = CHOICES.map(function (m) { var b = checkbox(P + "_" + m, label(m), cur.indexOf(m) >= 0); b.input.value = String(m); grid.appendChild(b.wrap); return b; });
    container.appendChild(el("p", "trm-sub", "Minutes before the start"));
    container.appendChild(grid);
    var cw = el("div", "trm-custom"), cl = el("label", null, "Custom (minutes before)"); cl.htmlFor = P + "_custom";
    var ci = el("input"); ci.id = P + "_custom"; ci.type = "text"; ci.inputMode = "numeric"; ci.maxLength = 30; ci.placeholder = "e.g. 45 or 20, 7";
    ci.value = cur.filter(function (m) { return CHOICES.indexOf(m) < 0; }).join(", ");
    cw.appendChild(cl); cw.appendChild(ci); container.appendChild(cw);
    var err = el("div", "lerr"); err.setAttribute("role", "alert"); err.hidden = true; container.appendChild(err);
    var at = exactTimes(container, task, opts, P, err);
    container.appendChild(err);   // the error line under the exact times (it covers both parts)
    container.appendChild(el("p", "muted hint trm-hint", "Needs a start time. Email goes to the staff record address; WhatsApp also needs a phone number on the staff record and your studio's WhatsApp number connected in Integrations. Tick \"At the start time\" for a \"due now\" reminder."));
    // R179: the minute ticks and the custom box are never locked. Changing any of them switches "Use the studio default" off
    // (the owner could not type a custom time while the default was ticked); ticking the default again puts its times back.
    function untickDefault() { if (dflt.input.checked) dflt.input.checked = false; }
    boxes.forEach(function (b) { b.input.disabled = false; b.input.addEventListener("change", untickDefault); });
    ci.disabled = false; ci.addEventListener("input", untickDefault);
    dflt.input.addEventListener("change", function () {
      if (dflt.input.checked) { boxes.forEach(function (b) { b.input.checked = def.indexOf(Number(b.input.value)) >= 0; }); ci.value = def.filter(function (m) { return CHOICES.indexOf(m) < 0; }).join(", "); }
    });
    return {
      value: function () {
        err.hidden = true;
        if (dflt.input.checked) return null;
        var p = parseCustom(ci.value);
        if (!p.ok) { err.textContent = p.error; err.hidden = false; ci.focus(); throw new Error(p.error); }
        var mins = boxes.filter(function (b) { return b.input.checked; }).map(function (b) { return Number(b.input.value); }).concat(p.mins);
        mins = sortMins(mins);
        if (mins.length > 8) { err.textContent = "At most 8 reminder times."; err.hidden = false; throw new Error("too many"); }
        return mins;
      },
      times: function () { err.hidden = true; return at.read(); },
    };
  }

  // ---- R173 (0364): reminders at an exact clock time (e.g. 5:32 PM) ------------------------------------------------------------
  // rows of <input type=datetime-local> holding the STUDIO clock (opts.toLocal / opts.fromLocal convert); checked against the
  // start time read from the same form (opts.start). Server rules (set_task_reminder_times): at or before the start, at most
  // 24 hours before it, a NEW time not in the past, at most 8.
  var DAY_MS = 24 * 60 * 60 * 1000;
  function checkTimes(list, startIso, saved, nowMs) {
    var out = [], seen = {}, start = startIso ? Date.parse(startIso) : NaN, now = nowMs == null ? Date.now() : nowMs;
    var keep = {}; (Array.isArray(saved) ? saved : []).forEach(function (x) { var t = Date.parse(x); if (isFinite(t)) keep[t] = 1; });
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (t == null || !isFinite(t)) return { ok: false, error: "Couldn't read one of the reminder times - pick a date and time." };
      if (!isFinite(start)) return { ok: false, error: "Set a start time first - a reminder at an exact time needs one." };
      if (t > start) return { ok: false, error: "A reminder time must be at or before the start time." };
      if (t < start - DAY_MS) return { ok: false, error: "A reminder time can be at most 24 hours before the start." };
      if (t < now - 60000 && !keep[t]) return { ok: false, error: "One of the reminder times has already passed - pick a later time." };
      if (!seen[t]) { seen[t] = 1; out.push(t); }
    }
    if (out.length > 8) return { ok: false, error: "At most 8 reminder times at an exact time." };
    out.sort(function (a, b) { return a - b; });
    return { ok: true, times: out.map(function (t) { return new Date(t).toISOString(); }) };
  }
  function exactTimes(container, task, opts, P, err) {
    var toLocal = typeof opts.toLocal === "function" ? opts.toLocal : null, fromLocal = typeof opts.fromLocal === "function" ? opts.fromLocal : null;
    var saved = task && Array.isArray(task.remind_at) ? task.remind_at.slice() : [];
    var box = el("div", "trm-at");
    if (!toLocal || !fromLocal) return { read: function () { return saved; } };
    box.appendChild(el("p", "trm-sub", "At an exact time"));
    var list = el("div", "trm-at-list"); box.appendChild(list);
    var add = el("button", "btn sm trm-at-add", "+ Add a time"); add.type = "button";
    add.setAttribute("aria-label", "Add a reminder at an exact time");
    box.appendChild(add);
    box.appendChild(el("p", "muted hint", "For example 5:32 PM - at or before the start time, up to 24 hours before it."));
    container.appendChild(box);
    var n = 0;
    function startMs() { var s = typeof opts.start === "function" ? opts.start() : null; var t = s ? Date.parse(s) : NaN; return isFinite(t) ? t : null; }
    function row(val) {
      n += 1;
      var r = el("div", "trm-at-row"), id = P + "_at" + n;
      var lb = el("label", "trm-at-lbl", "Reminder at"); lb.htmlFor = id;
      var inp = el("input"); inp.type = "datetime-local"; inp.id = id; inp.className = "trm-at-in";
      var st = startMs();
      if (st != null) { inp.max = toLocal(new Date(st).toISOString()); inp.min = toLocal(new Date(Math.max(st - DAY_MS, Date.now())).toISOString()); }
      if (val) inp.value = val;
      var rm = el("button", "btn sm trm-at-rm", "Remove"); rm.type = "button"; rm.setAttribute("aria-label", "Remove this reminder time");
      rm.addEventListener("click", function () { list.removeChild(r); if (add) add.disabled = list.children.length >= 8; add.focus(); });
      r.appendChild(lb); r.appendChild(inp); r.appendChild(rm); list.appendChild(r);
      // R179: the clear date + time picker (when-picker.js); the input stays the value holder
      if (global.HelmWhen && typeof global.HelmWhen.attach === "function") global.HelmWhen.attach(inp, { compact: true, label: "Reminder", zoneNote: false });
      add.disabled = list.children.length >= 8;
      return inp;
    }
    saved.forEach(function (x) { var v = toLocal(x); if (v) row(v); });
    add.addEventListener("click", function () {
      var st = startMs(), v = "";
      if (st != null) { var t = st - 30 * 60000; if (t < Date.now()) t = st; v = toLocal(new Date(t).toISOString()); }
      var inp = row(v); inp.focus();
    });
    return {
      read: function () {
        // R183: only the value holders (input.trm-at-in, "YYYY-MM-DDTHH:MM" in the studio clock). Since R179 each row also
        // holds the picker's own visible date + time fields; reading those ("2026-11-17", "3") made every exact time
        // "Couldn't read one of the reminder times" and the owner could never save one.
        var vals = [], ins = list.querySelectorAll("input.trm-at-in");
        for (var i = 0; i < ins.length; i++) { var v = String(ins[i].value || "").trim(); if (!v) continue; var d = fromLocal(v); vals.push(d && isFinite(d.getTime()) ? d.getTime() : null); }
        var c = checkTimes(vals, typeof opts.start === "function" ? opts.start() : null, saved);
        if (!c.ok) { err.textContent = c.error; err.hidden = false; throw new Error(c.error); }
        return c.times;
      },
    };
  }

  // Live Status: what reminders a task has, in a few words ("10 & 5 min before · 5:32 PM"); "" = none / no start time
  function summary(task, settings, clock) {
    if (!task || !task.planned_start) return "";
    var mins = Array.isArray(task.remind_before) ? sortMins(task.remind_before) : sortMins(settings && settings.default_before != null ? settings.default_before : [10, 5]);
    var parts = [];
    var nums = mins.filter(function (x) { return x > 0; });
    var head = nums.length ? (nums.length > 1 ? nums.slice(0, -1).join(", ") + " & " + nums[nums.length - 1] : String(nums[0])) + " min before" : "";
    if (mins.indexOf(0) >= 0) head = head ? head + " & at start" : "at start";
    if (head) parts.push(head);
    (Array.isArray(task.remind_at) ? task.remind_at : []).forEach(function (x) { var t = typeof clock === "function" ? clock(x) : ""; if (t) parts.push(t); });
    return parts.join(" · ");
  }

  // ---- Settings card ----------------------------------------------------------------------------------------------------------
  function settingsCard(host, opts) {
    var S = (opts && opts.store) || global.BPStore, R = S && S.taskReminders;
    if (!host || !R || typeof R.settings !== "function") { if (host) host.hidden = true; return Promise.resolve(false); }
    return Promise.resolve().then(function () { return R.settings(); }).then(function (s) {
      if (!s || typeof s !== "object") { host.hidden = true; return false; }
      clear(host); host.hidden = false; host.classList.add("trm-card");
      host.appendChild(el("h3", null, "Task reminders (email + WhatsApp)"));
      var note = el("div"); note.hidden = true; host.appendChild(note);
      if (global.HelmWaSetupNote) global.HelmWaSetupNote.mount(note, { store: S, what: "task reminders" });
      var ex = el("p", "trm-explain", explain(s)); host.appendChild(ex);
      var can = s.can_edit === true;
      var on = checkbox("trs_on", "Send task reminders (email + WhatsApp)", s.enabled !== false); host.appendChild(on.wrap);
      host.appendChild(el("h4", null, "Ticked by default on every task"));
      var def = sortMins(s.default_before);
      var grid = el("div", "trm-grid");
      var boxes = CHOICES.map(function (m) { var b = checkbox("trs_" + m, label(m), def.indexOf(m) >= 0); b.input.value = String(m); grid.appendChild(b.wrap); return b; });
      host.appendChild(grid);
      var cw = el("div", "trm-custom"), cl = el("label", null, "Custom (minutes before)"); cl.htmlFor = "trs_custom";
      var ci = el("input"); ci.id = "trs_custom"; ci.type = "text"; ci.inputMode = "numeric"; ci.maxLength = 30; ci.placeholder = "e.g. 45 or 20, 7";
      ci.value = def.filter(function (m) { return CHOICES.indexOf(m) < 0; }).join(", "); cw.appendChild(cl); cw.appendChild(ci); host.appendChild(cw);
      host.appendChild(el("h4", null, "When a task is late (not started)"));
      var row = el("div", "trm-row");
      var el1 = el("label", null, "Every "); var ev = el("input"); ev.type = "number"; ev.min = "5"; ev.max = "120"; ev.step = "5"; ev.id = "trs_every"; ev.value = String(s.late_every_min || 15);
      el1.htmlFor = "trs_every"; row.appendChild(el1); row.appendChild(ev); row.appendChild(el("span", null, " minutes, up to "));
      var mx = el("input"); mx.type = "number"; mx.min = "0"; mx.max = "10"; mx.id = "trs_max"; mx.value = String(s.late_max == null ? 3 : s.late_max);
      mx.setAttribute("aria-label", "Number of late reminders"); row.appendChild(mx); row.appendChild(el("span", null, " times (0 = no late reminders)"));
      host.appendChild(row);
      var off = checkbox("trs_office", "Then tell the event manager (bell, email + WhatsApp)", s.alert_office !== false); host.appendChild(off.wrap);
      var hold = checkbox("trs_hold", "Hold a task's reminders while it waits on an unfinished task", s.hold_waiting !== false); host.appendChild(hold.wrap);
      host.appendChild(el("p", "muted hint", "Holding while a task waits is the suggested rule; the final rule is waiting for approval and may change."));
      var foot = el("div", "trm-foot"), save = el("button", "btn primary", "Save reminders"); save.type = "button";
      var msg = el("p", "trm-msg"); msg.setAttribute("role", "status"); msg.setAttribute("aria-live", "polite");
      foot.appendChild(save); foot.appendChild(msg); host.appendChild(foot);
      [on.input, ev, mx, off.input, hold.input, ci, save].concat(boxes.map(function (b) { return b.input; })).forEach(function (x) { x.disabled = !can; });
      if (!can) host.appendChild(el("p", "muted hint", "Only people who can edit Settings can change these."));
      save.addEventListener("click", function () {
        var p = parseCustom(ci.value); if (!p.ok) { msg.textContent = p.error; return; }
        var mins = sortMins(boxes.filter(function (b) { return b.input.checked; }).map(function (b) { return Number(b.input.value); }).concat(p.mins));
        if (mins.length > 8) { msg.textContent = "At most 8 reminder times."; return; }
        var every = Number(ev.value), max = Number(mx.value);
        if (!(every >= 5 && every <= 120)) { msg.textContent = "Late reminders: every 5 to 120 minutes."; ev.focus(); return; }
        if (!(max >= 0 && max <= 10 && max === Math.floor(max))) { msg.textContent = "Late reminders: 0 to 10 times."; mx.focus(); return; }
        save.disabled = true; msg.textContent = "Saving…";
        R.saveSettings({ enabled: on.input.checked, default_before: mins, late_every_min: every, late_max: max, alert_office: off.input.checked, hold_waiting: hold.input.checked })
          .then(function (n) { msg.textContent = "Saved."; ex.textContent = explain(n || {}); })
          .catch(function (e) { msg.textContent = (global.BPUI && global.BPUI.friendlyError) ? global.BPUI.friendlyError(e, { action: "save the reminders" }) : "Couldn't save - try again."; })
          .then(function () { save.disabled = false; });
      });
      return true;
    }, function () { host.hidden = true; return false; });
  }

  var api = { schedFields: schedFields, chip: chip, settingsCard: settingsCard, explain: explain, parseCustom: parseCustom, sortMins: sortMins, listText: listText, CHOICES: CHOICES,
    checkTimes: checkTimes, summary: summary };
  global.HelmTaskReminders = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
