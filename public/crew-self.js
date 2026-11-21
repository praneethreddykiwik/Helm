/* crew-self.js - r23 (0265): the crew member's own side of the crew link (work.html).
   Three cards, each shown only when the studio switched it on (Settings -> Crew) and the database has 0265:
     #crewCheck  - event-day Check in / Check out (server time; the phone's location only when the studio asks for it,
                   and then only the distance to the venue is saved)
     #crewShifts - open shifts of the studio this person may take (one tap; first come or "needs approval")
     #crewAvail  - my availability: tap a day to mark it off / free (today .. 60 days shown)
                   R187 (0370): a day off is a REQUEST the office approves (waiting / approved / not approved), days inside
                   the studio's notice (default 7 days, studio time zone) can't be asked for here (the server refuses too),
                   and each decision is shown until the person taps "OK, got it"
   Every call is the work-link token (the same one the page already uses); nothing is kept in the browser.
   DOM API only (no HTML strings). Dates "12 Nov 2026" (R243), the studio's currency in its own number style. */
(function (global) {
  "use strict";
  if (typeof document === "undefined") return;
  var doc = document, S = function () { return global.BPStore; };
  var LINK = null, token = null, home = null, busy = false, timer = null;

  function h(tag, attrs, kids) {
    var el = doc.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k]; if (v === null || v === undefined || v === false) return;
      if (k === "text") el.textContent = String(v); else if (k === "cls") el.className = v; else el.setAttribute(k, v === true ? "" : String(v));
    });
    (kids || []).forEach(function (c) { if (c === null || c === undefined || c === false) return; el.appendChild(typeof c === "string" ? doc.createTextNode(c) : c); });
    return el;
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  function errText(e) {
    // R187: the server's "Too close ... call your manager" sentence is already written for the staff member - show it as is
    if (e && (e.hint === "cantwork_buffer" || /^Too close - /.test(String(e.message || "")))) return String(e.message).slice(0, 240);
    var B = global.BPUI; try { if (B && B.friendlyError) return B.friendlyError(e, { action: "save that" }); } catch (x) {}
    return (e && e.message) ? String(e.message).slice(0, 240) : "Something went wrong - try again.";
  }
  function ymd(s) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || "")); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)) : null; }
  function addDays(s, n) { var d = ymd(s); if (!d) return ""; d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  // R243 (P11 LOC-04): "12 Nov 2026" - reads the same for India, UAE and US crews (dd/mm vs mm/dd never confuses)
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function fmtDay(s) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || "")); return m && +m[2] >= 1 && +m[2] <= 12 ? (+m[3]) + " " + MON[+m[2] - 1] + " " + m[1] : ""; }
  function weekday(s) { var d = ymd(s); try { return d ? d.toLocaleDateString("en-IN", { weekday: "short", timeZone: "UTC" }) : ""; } catch (e) { return ""; } }
  function money(n, cur) {
    var v = Number(n); if (!isFinite(v)) return "";
    // R243 (LOC-04): the studio's own number style (India 1,00,000 / UAE + USA 100,000), like the server messages
    var loc = cur === "USD" ? "en-US" : cur === "AED" ? "en-AE" : "en-IN";
    try { return new Intl.NumberFormat(loc, { style: "currency", currency: cur || "INR", maximumFractionDigits: 0 }).format(v); }
    catch (e) { return (cur === "INR" || !cur ? "₹" : cur + " ") + Math.round(v).toLocaleString("en-IN"); }
  }
  function linkFor(tok) {
    if (!tok) return null;
    if (LINK && LINK.studio) return "/" + encodeURIComponent(LINK.studio) + "/work/" + encodeURIComponent(tok);
    return "/work.html?token=" + encodeURIComponent(tok);
  }
  function note(host, text, kind) {
    var old = host.querySelector(".cs-msg"); if (old) old.parentNode.removeChild(old);
    if (!text) return;
    host.appendChild(h("p", { cls: "cs-msg " + (kind || "err"), role: kind === "ok" ? "status" : "alert", text: text }));
  }

  // ---------------- check in / out ----------------
  function where() {
    return new Promise(function (res) {
      if (!navigator.geolocation) { res(null); return; }
      var done = false, fin = function (v) { if (!done) { done = true; res(v); } };
      try {
        navigator.geolocation.getCurrentPosition(function (p) { fin({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }); },
          function () { fin(null); }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
      } catch (e) { fin(null); }
      setTimeout(function () { fin(null); }, 14000);
    });
  }
  function renderCheck() {
    var box = doc.getElementById("crewCheck"); if (!box) return;
    var ci = home && home.checkin;
    if (!ci || !home.settings || home.settings.selfCheckin === false || ci.event_live === false) { box.hidden = true; clear(box); return; }
    clear(box); box.hidden = false;
    box.appendChild(h("div", { cls: "cat", text: "📍 Event-day check-in" }));
    var card = h("div", { cls: "task cs-check" });
    box.appendChild(card);
    // R243 (P11 OPS-03): a check-in / out pressed with no signal waits on this phone until it is sent
    var Q = global.HelmCrewQueue, qIn = !!(Q && Q.has("check", "in")), qOut = !!(Q && Q.has("check", "out"));
    if ((qIn && !ci.check_in) || (qOut && !ci.check_out)) {
      card.appendChild(h("div", { cls: "tt", text: qOut ? "Check-out saved offline" : "Check-in saved offline" }));
      card.appendChild(h("p", { cls: "rsl", text: "📶 Saved offline - will send when connected. The office sees the time it arrives." }));
      if (!qOut) {   // checked in offline: checking out offline later the same day is saved too (sent after the check-in)
        var out2 = h("button", { type: "button", cls: "btn primary cs-big", text: "Check out" });
        out2.addEventListener("click", function () { doCheck("out", out2, card); });
        card.appendChild(h("div", { cls: "acts" }, [out2]));
      }
      return;
    }
    if (ci.check_in && ci.check_out) {
      card.appendChild(h("div", { cls: "tt", text: "Thank you - your day is recorded" }));
      card.appendChild(h("p", { cls: "rsl", text: "Checked in " + ci.check_in + " · checked out " + ci.check_out }));
      return;
    }
    if (ci.check_in) {
      card.appendChild(h("div", { cls: "tt", text: "You checked in at " + ci.check_in }));
      if (ci.late_min > 0) card.appendChild(h("p", { cls: "rsl", text: ci.late_min + " min after the start time" }));
      var out = h("button", { type: "button", cls: "btn primary cs-big", text: "Check out" });
      out.addEventListener("click", function () { doCheck("out", out, card); });
      card.appendChild(h("div", { cls: "acts" }, [out]));
      return;
    }
    if (!ci.today_ok) {
      var days = (ci.days || []).map(fmtDay).filter(Boolean);
      card.appendChild(h("div", { cls: "tt", text: "Check-in opens on the event day" }));
      if (days.length) card.appendChild(h("p", { cls: "rsl", text: "Your day" + (days.length > 1 ? "s" : "") + ": " + days.join(", ") }));
      return;
    }
    card.appendChild(h("div", { cls: "tt", text: "Reached the venue? Check in" }));
    var bits = [];
    if (ci.expected_start) bits.push("Start time " + ci.expected_start);
    if (ci.opens_at) bits.push("opens " + ci.opens_at);
    if (ci.needs_location) bits.push("your phone's location is checked against the venue (only the distance is saved)");
    if (bits.length) card.appendChild(h("p", { cls: "rsl", text: bits.join(" · ") }));
    var go = h("button", { type: "button", cls: "btn primary cs-big", text: "Check in now" });
    go.addEventListener("click", function () { doCheck("in", go, card); });
    card.appendChild(h("div", { cls: "acts" }, [go]));
  }
  async function doCheck(action, btn, card) {
    if (busy) return; busy = true; btn.disabled = true; var label = btn.textContent;
    note(card, "");
    try {
      var loc = null;
      if (home.checkin && home.checkin.needs_location) { btn.textContent = "Finding your location…"; loc = await where(); }
      var Q = global.HelmCrewQueue;
      if (Q && !Q.online()) { saveCheck(action, loc, card); return; }   // R243: no signal - save it, send it later
      btn.textContent = action === "in" ? "Checking in…" : "Checking out…";
      var r;
      try { r = await S().ops.shifts.check(token, action, loc); }
      catch (e1) { if (Q && Q.shouldQueue(e1)) { saveCheck(action, loc, card); return; } throw e1; }
      try { global.BPUI.toast(action === "in" ? ("Checked in at " + (r && r.check_in || "now") + (r && r.late ? " - the office knows you are late" : "")) : ("Checked out at " + (r && r.check_out || "now")), { type: "ok" }); } catch (e) {}
      await load(true);
    } catch (e) {
      btn.disabled = false; btn.textContent = label; note(card, errText(e));
    } finally { busy = false; }
  }

  function saveCheck(action, loc, card) {
    try { global.HelmCrewQueue.add({ kind: "check", action: action, loc: loc }); }
    catch (e) { note(card, (e && e.message) || "Couldn't save that on this phone - try again when connected."); return; }
    try { global.BPUI.toast("Saved offline — will send when connected.", { type: "ok" }); } catch (e) {}
    renderCheck();
  }
  // R243: the saved check-in / out is sent with a fresh look first: already in (or out) = nothing to send again
  function qSender() {
    var Q = global.HelmCrewQueue; if (!Q || qSender.done) return; qSender.done = true;
    Q.sender("check", async function (it) {
      var B = S(); await B.init();
      var hm = await B.ops.shifts.home(token), ci = hm && hm.checkin;
      if (ci && it.action === "in" && ci.check_in) return;
      if (ci && it.action === "out" && ci.check_out) return;
      await B.ops.shifts.check(token, it.action, it.loc || null);
    });
    Q.onChange(function () { if (home) renderCheck(); });
  }

  // ---------------- open shifts ----------------
  function shiftWhen(s) {
    var t = s.start ? (s.start + (s.end ? "–" + s.end : "")) : "";
    return weekday(s.date) + " " + fmtDay(s.date) + (t ? " · " + t : "");
  }
  function renderShifts() {
    var box = doc.getElementById("crewShifts"); if (!box) return;
    var list = (home && home.shifts) || [];
    if (!home || !home.settings || home.settings.openShifts === false || !list.length) { box.hidden = true; clear(box); return; }
    clear(box); box.hidden = false;
    box.appendChild(h("div", { cls: "cat", text: "🙋 Open shifts you can take" }));
    list.forEach(function (s) {
      var card = h("div", { cls: "task cs-shift", "data-id": s.id });
      var st = s.my_status, pill = null;
      if (st === "approved") pill = h("span", { cls: "st accepted", text: "You're on it" });
      else if (st === "pending") pill = h("span", { cls: "st assigned", text: "Waiting for the office" });
      else if (st === "declined") pill = h("span", { cls: "st rejected", text: "Not given" });
      else if (s.status === "filled") pill = h("span", { cls: "st completed", text: "Full" });
      if (pill) card.appendChild(pill);
      card.appendChild(h("div", { cls: "tt", text: s.title }));
      card.appendChild(h("p", { cls: "rsl", text: shiftWhen(s) }));
      card.appendChild(h("p", { cls: "rsl", text: [s.event_title, s.venue ? "📍 " + s.venue : null].filter(Boolean).join(" · ") }));
      var facts = [];
      if (s.wage != null) facts.push(money(s.wage, home.currency) + (s.basis === "hour" ? " / hour" : " / day"));
      facts.push((Number(s.filled) || 0) + " of " + (Number(s.needed) || 1) + " taken");
      facts.push(s.mode === "approval" ? "the office picks" : "first come, first served");
      var f = h("p", { cls: "rsl cs-facts", text: facts.join(" · ") }); if (s.wage != null) f.setAttribute("data-money", "");
      card.appendChild(f);
      if (s.note) card.appendChild(h("p", { cls: "rsl", text: s.note }));
      if (st === "declined" && s.my_reason) card.appendChild(h("p", { cls: "rsl", text: "Reason: " + s.my_reason }));
      var acts = h("div", { cls: "acts" });
      if (st === "approved") {
        var l = linkFor(s.my_link);
        if (l) acts.appendChild(h("a", { cls: "btn", href: l, text: "Open that event's tasks" }));
      } else if (st === "pending") {
        var w = h("button", { type: "button", cls: "btn no", text: "Withdraw" });
        w.addEventListener("click", function () { act(w, card, function () { return S().ops.shifts.withdraw(token, s.id); }, "Withdrawn."); });
        acts.appendChild(w);
      } else if (st !== "declined" && s.status === "open") {
        if (s.unavailable) acts.appendChild(h("p", { cls: "rsl", text: "You marked this day unavailable - change it below to take the shift." }));
        else if (s.on_event && !st) acts.appendChild(h("p", { cls: "rsl", text: "You already work at this event." }));
        else {
          var c = h("button", { type: "button", cls: "btn ok", text: s.mode === "approval" ? "Ask for this shift" : "Take this shift" });
          c.addEventListener("click", function () {
            act(c, card, function () { return S().ops.shifts.claim(token, s.id); },
              s.mode === "approval" ? "Asked - the office will confirm." : "It's yours - it's now in your tasks.");
          });
          acts.appendChild(c);
        }
      }
      if (acts.firstChild) card.appendChild(acts);
      box.appendChild(card);
    });
  }
  async function act(btn, card, fn, okText) {
    if (busy) return; busy = true; btn.disabled = true; note(card, "");
    try { await fn(); try { global.BPUI.toast(okText, { type: "ok" }); } catch (e) {} await load(true);
      var rb = doc.getElementById("refreshBtn"); if (rb && !rb.disabled) rb.click(); }   // a shift on this event shows in the task list at once
    catch (e) { btn.disabled = false; note(card, errText(e)); }
    finally { busy = false; }
  }

  // ---------------- my availability ----------------
  function renderAvail() {
    var box = doc.getElementById("crewAvail"); if (!box) return;
    if (!home || !home.crew || !home.settings || home.settings.availability === false) { box.hidden = true; clear(box); return; }
    clear(box); box.hidden = false;
    var off = {}, work = {};
    (home.availability || []).forEach(function (a) { if (a && a.status === "unavailable") off[String(a.day).slice(0, 10)] = a; });
    (home.busy || []).forEach(function (d) { work[String(d).slice(0, 10)] = true; });
    var cw = home.cantwork || null, buf = cw ? Math.max(0, Number(cw.buffer_days) || 0) : 0;
    var firstDay = buf ? addDays(String(home.today || "").slice(0, 10), buf) : "";
    box.appendChild(h("div", { cls: "cat", text: "📅 My availability" }));
    renderDecisions(box, cw && cw.decisions);
    var card = h("div", { cls: "task cs-avail" });
    card.appendChild(h("p", { cls: "rsl", text: cw
      ? "Tap a day you can't work to ask for it off - the office approves it. Tap again when you're free."
      : "Tap a day you can't work. Tap again when you're free. The office sees it before giving out work." }));
    if (buf) card.appendChild(h("p", { cls: "rsl cs-buffer", text: "Days off need " + buf + " day" + (buf === 1 ? "" : "s") + "' notice - for a day before "
      + weekday(firstDay) + " " + fmtDay(firstDay) + ", please call your manager." }));
    var legend = h("p", { cls: "rsl cs-legend" }, [h("span", { cls: "cs-key off" }), " day off  ",
      cw ? h("span", { cls: "cs-key ask" }) : null, cw ? " waiting for approval  " : null, h("span", { cls: "cs-key work" }), " working"]);
    card.appendChild(legend);
    var grid = h("div", { cls: "cs-days", role: "group", "aria-label": "Next 60 days" });
    var today = String(home.today || "").slice(0, 10), month = "";
    for (var i = 0; i < 60; i++) {
      var d = addDays(today, i); if (!d) break;
      var mlabel = (function () { var x = ymd(d); try { return x.toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }); } catch (e) { return d.slice(0, 7); } })();
      if (mlabel !== month) {
        month = mlabel; grid.appendChild(h("div", { cls: "cs-month", text: mlabel }));
        var lead = (ymd(d).getUTCDay() + 6) % 7;   // Monday-first columns: blank cells before the first day shown
        for (var k = 0; k < lead; k++) grid.appendChild(h("span", { cls: "cs-pad", "aria-hidden": "true" }));
      }
      var isOff = !!off[d], isWork = !!work[d], isAsk = isOff && off[d].approval === "pending", isLock = !isOff && !!firstDay && d < firstDay;
      var b = h("button", { type: "button", cls: "cs-day" + (isOff ? (isAsk ? " ask" : " off") : "") + (isWork ? " work" : "") + (isLock ? " lock" : ""), "data-day": d,
        "aria-pressed": isOff ? "true" : "false",
        title: isOff ? ((isAsk ? "Asked off - waiting for approval" : "Day off") + (off[d].note ? ": " + off[d].note : "") + " - tap to mark free")
          : (isLock ? "Too close to ask here - please call your manager" : "Tap if you can't work this day"),
        "aria-label": weekday(d) + " " + fmtDay(d) + (isOff ? (isAsk ? ", asked off, waiting for approval" : ", day off") + (off[d].note ? ", reason: " + off[d].note : "") : ", free")
          + (isWork ? ", you are working" : "") + (isOff && off[d].by_office ? ", set by the office" : "") + (isLock ? ", too close to ask here" : "") }, [
        h("span", { cls: "w", text: weekday(d) }), h("b", { text: String(+d.slice(8, 10)) })]);
      b.addEventListener("click", (function (day, wasOff, isW, btn, lock) { return function () {
        if (lock) { note(card, tooClose(buf), "err"); try { global.BPUI.toast(tooClose(buf), { type: "err" }); } catch (e) {} return; }
        toggleDay(day, wasOff, isW, btn, card); }; })(d, isOff, isWork, b, isLock));
      grid.appendChild(b);
    }
    card.appendChild(grid);
    // R184: the days I marked, each with its reason (the office sees it on the Team calendar) - change the reason or free the day
    var mine = Object.keys(off).sort();
    if (mine.length) {
      var lst = h("div", { cls: "cs-offlist", role: "list", "aria-label": "Days you can't work" });
      lst.appendChild(h("p", { cls: "cs-offlist-h", text: "Days you can't work" }));
      mine.forEach(function (d) {
        var a = off[d], row = h("div", { cls: "cs-offrow", role: "listitem" });
        row.appendChild(h("div", { cls: "cs-offrow-d" }, [h("b", { text: weekday(d) + " " + fmtDay(d) }),
          cw ? h("span", { cls: "cs-ap " + (a.approval === "pending" ? "wait" : "yes"), text: a.approval === "pending" ? "Waiting for approval" : "Approved" }) : null,
          h("span", { cls: a.note ? "cs-offrow-r" : "cs-offrow-r none", text: a.note ? a.note : "No reason given" }),
          a.by_office ? h("small", { text: "set by the office" }) : null]));
        var acts = h("div", { cls: "cs-offrow-a" });
        if (!a.by_office) {
          var eb = h("button", { type: "button", cls: "cs-btn", text: a.note ? "Change reason" : "Add a reason" });
          eb.addEventListener("click", function () { editReason(d, a.note || "", eb, card); });
          acts.appendChild(eb);
        }
        var fb = h("button", { type: "button", cls: "cs-btn ghost", text: "I can work" });
        fb.addEventListener("click", function () { toggleDay(d, true, !!work[d], fb, card); });
        acts.appendChild(fb);
        row.appendChild(acts); lst.appendChild(row);
      });
      card.appendChild(lst);
    }
    box.appendChild(card);
  }
  function tooClose(buf) {
    return buf === 7 ? "Too close - days within a week can't be blocked here. Please call your manager."
      : "Too close - days within the next " + buf + " days can't be blocked here. Please call your manager.";
  }
  // R187: the office's answers, shown until the person taps "OK, got it" (the time is recorded)
  function renderDecisions(box, list) {
    list = (list || []).filter(function (x) { return x && (x.approval === "approved" || x.approval === "rejected"); });
    if (!list.length) return;
    var wrap = h("div", { cls: "cs-decisions", role: "list", "aria-label": "Answers to your day-off requests" });
    list.forEach(function (x) {
      var ok = x.approval === "approved", d = String(x.day).slice(0, 10);
      var row = h("div", { cls: "task cs-decision " + (ok ? "yes" : "no"), role: "listitem" });
      row.appendChild(h("div", { cls: "tt", text: (ok ? "✅ Day off approved: " : "❌ Day off not approved: ") + weekday(d) + " " + fmtDay(d) }));
      row.appendChild(h("p", { cls: "rsl", text: ok ? "You have this day off." : "Please plan to work this day - call your manager if you can't." }));
      if (x.decision_note) row.appendChild(h("p", { cls: "rsl cs-dnote", text: "Note from the office: " + x.decision_note }));
      var got = h("button", { type: "button", cls: "btn primary", text: "OK, got it" });
      got.addEventListener("click", function () { ack(d, got, row); });
      row.appendChild(h("div", { cls: "acts" }, [got]));
      wrap.appendChild(row);
    });
    box.appendChild(wrap);
  }
  async function ack(day, btn, row) {
    if (busy) return; busy = true; btn.disabled = true; note(row, "");
    try { await S().ops.shifts.ack(token, day); await load(true); }
    catch (e) { btn.disabled = false; note(row, errText(e)); }
    finally { busy = false; }
  }
  function cleanReason(r) { return String(r == null ? "" : r).replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120); }
  async function askReason(day, isWork, current) {
    var B = global.BPUI; if (!(B && B.prompt)) return current || "";
    var r = await B.prompt((isWork ? "You are already working on " + fmtDay(day) + " - the office will be told. " : "") +
      "Why can't you work? (optional - e.g. Family function, exam, travelling; the office sees it)",
      { title: "Can't work on " + fmtDay(day) + "?", label: "Reason", value: current || "", required: false,
        okLabel: current != null && current !== "" ? "Save reason" : (home && home.cantwork ? "Ask for this day off" : "Mark as can't work") });
    return r === null ? null : cleanReason(r);
  }
  async function editReason(day, current, btn, card) {
    if (busy) return;
    var reason = await askReason(day, false, current); if (reason === null) return;
    busy = true; btn.disabled = true; note(card, "");
    try {
      await S().ops.shifts.setAvailability(token, day, "unavailable", reason || null);
      try { global.BPUI.toast(reason ? "Reason saved for " + fmtDay(day) : "Reason removed for " + fmtDay(day), { type: "ok" }); } catch (e) {}
      await load(true);
    } catch (e) { btn.disabled = false; note(card, errText(e)); }
    finally { busy = false; }
  }
  async function toggleDay(day, wasOff, isWork, btn, card) {
    if (busy) return;
    var want = wasOff ? "available" : "unavailable", reason = null;
    if (!wasOff) {
      reason = await askReason(day, isWork, "");
      if (reason === null) return;
      reason = reason || null;
    }
    busy = true; btn.disabled = true; note(card, "");
    try {
      var r = await S().ops.shifts.setAvailability(token, day, want, reason);
      try { global.BPUI.toast(want === "unavailable"
        ? (r && r.approval === "pending" ? "Asked for " + fmtDay(day) + " off - the office will approve it" : "Marked " + fmtDay(day) + " as can't work")
          + (r && r.booked_that_day ? " (you are working that day - the office has been told)" : "")
        : (fmtDay(day) + " is free again"), { type: "ok" }); } catch (e) {}
      await load(true);
    } catch (e) {
      btn.disabled = false; note(card, errText(e));
      if (e && e.hint === "cantwork_buffer") { try { global.BPUI.toast(errText(e), { type: "err" }); } catch (x) {} }   // R187: the note sits below the long grid
    }
    finally { busy = false; }
  }

  // ---------------- load ----------------
  function hideAll() { ["crewCheck", "crewShifts", "crewAvail"].forEach(function (id) { var b = doc.getElementById(id); if (b) { b.hidden = true; clear(b); } }); }
  async function load(force) {
    var B = S(); if (!B || !B.ops || !B.ops.shifts || !token) return;
    if (busy && !force) return;
    try {
      await B.init();
      home = await B.ops.shifts.home(token);
      if (!home || !home.crew) { hideAll(); return; }
      renderCheck(); renderShifts(); renderAvail();
    } catch (e) {
      // older database (no 0265) / expired link / offline: the page's own task list handles the message
      if (!home) hideAll();
    }
  }
  function start() {
    var B = S(); if (!B || !B.links) return;
    try { LINK = B.links.parse("work"); } catch (e) { LINK = null; }
    token = LINK ? LINK.ref : new URLSearchParams(location.search).get("token");
    // R179: an event opened inside the permanent staff link (work.html?staff=..&event=..) hands its task link over
    if (!token && typeof global.__helmWorkToken === "string") token = global.__helmWorkToken;
    if (!token) return;
    try { if (global.HelmCrewQueue) { global.HelmCrewQueue.use(token); qSender(); } } catch (e) {}
    load(false);
    if (!timer) timer = setInterval(function () { if (doc.visibilityState === "visible" && navigator.onLine !== false) load(false); }, 90000);
  }
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", start); else start();
  global.HelmCrewSelf = {
    reload: function () { return load(true); },
    // R179: set the task link after the page found it (permanent link -> event view); starts the sections once
    useToken: function (t) { if (!t || token) return; global.__helmWorkToken = String(t); start(); },
  };
})(window);
