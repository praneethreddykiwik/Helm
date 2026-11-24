/* payment-schedule.js - r23 (0264) payment schedule card for staff pages (quote flow payment step, event workspace,
   Budget, Logistics -> Payments). Shows every payment of the event with Paid / Part paid / Due / Overdue, the
   automatic-reminder cadence, a "Pause automatic reminders" switch for this event, and - when the event has no
   schedule yet - "Add a payment schedule" from a template (preview first, then apply). Reads / writes ONLY through
   BPStore.paySchedule (payment_schedule_for_quote / _apply / _pause - the database checks Finance view / edit and the
   studio). Hidden when the server is older than 0264 or the role can't see money. Amounts carry data-money (masked by
   "Hide amounts"). DOM via createElement + textContent only. The pure helpers (compute, cleanLines, stateLabel,
   reminderLine) are unit-tested and mirror the SQL (_pst_compute / _pst_lines_clean). */
(function (global) {
  "use strict";
  // R116: "step 8" is the quote FLOW's numbering; on the event page the stage bar numbers Quote as stage 4,
  // so outside the flow the hint names the step instead (clean URLs: /flow, /<studio>/flow, /flow.html)
  function onFlowPage() { try { return /(^|\/)flow(\.html)?\/?$/.test(String(location.pathname || "")); } catch (e) { return false; } }
  var BUILTINS = [
    { key: "builtin:30-50-20", name: "30 / 50 / 20", lines: [
      { label: "Advance (30%)", kind: "percent", value: 30, anchor: "approval", offset_days: 0 },
      { label: "Second payment (50%)", kind: "percent", value: 50, anchor: "event", offset_days: -15 },
      { label: "Final balance (20%)", kind: "percent", value: 20, anchor: "event", offset_days: 0 }] },
    { key: "builtin:50-50", name: "50 / 50", lines: [
      { label: "Advance (50%)", kind: "percent", value: 50, anchor: "approval", offset_days: 0 },
      { label: "Balance (50%)", kind: "percent", value: 50, anchor: "event", offset_days: -7 }] },
    { key: "builtin:100-upfront", name: "100% upfront", lines: [
      { label: "Full payment (100%)", kind: "percent", value: 100, anchor: "approval", offset_days: 0 }] }
  ];

  // ---- pure helpers (no DOM) ---------------------------------------------------------------------------------------
  function addDays(iso, n) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || "")); if (!m) return null;
    var t = Date.UTC(+m[1], +m[2] - 1, +m[3]) + n * 86400000; return new Date(t).toISOString().slice(0, 10);
  }
  function round2(n) { return Math.round(n * 100) / 100; }
  // same rules as public._pst_lines_clean: -> { ok, lines, error }
  function cleanLines(lines) {
    if (!Array.isArray(lines) || !lines.length) return { ok: false, error: "Add at least one payment to the schedule." };
    if (lines.length > 10) return { ok: false, error: "A schedule can have at most 10 payments." };
    var out = [], pct = 0, bal = 0, fixed = 0;
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i] || {}, n = i + 1, label = String(l.label == null ? "" : l.label).trim();
      if (!label || label.length > 80 || /[<>\u0000-\u001f]/.test(label)) return { ok: false, error: "Payment " + n + ": enter a name of up to 80 characters (no < or >)." };
      var kind = l.kind || "percent";
      if (["percent", "fixed", "balance"].indexOf(kind) < 0) return { ok: false, error: "Payment " + n + ": choose percent, fixed amount or balance." };
      var val = null;
      if (kind !== "balance") {
        var raw = String(l.value == null ? "" : l.value).trim();
        if (!/^\d{1,10}(\.\d{1,2})?$/.test(raw)) return { ok: false, error: "Payment " + n + ": enter the amount as a number (up to 2 decimals)." };
        val = Number(raw);
        if (kind === "percent" && (val <= 0 || val > 100)) return { ok: false, error: "Payment " + n + ": the percentage must be more than 0 and at most 100." };
        if (kind === "fixed" && val <= 0) return { ok: false, error: "Payment " + n + ": the amount must be more than 0." };
      }
      var anchor = l.anchor || "approval";
      if (anchor !== "approval" && anchor !== "event") return { ok: false, error: "Payment " + n + ": the due date counts from the approval or from the event day." };
      var off = String(l.offset_days == null || l.offset_days === "" ? "0" : l.offset_days).trim();
      if (!/^-?\d{1,3}$/.test(off) || Math.abs(Number(off)) > 365) return { ok: false, error: "Payment " + n + ": days must be a whole number from -365 to 365." };
      off = Number(off);
      if (anchor === "approval" && off < 0) return { ok: false, error: "Payment " + n + ": a payment can't be due before the approval." };
      if (kind === "percent") pct += val; else if (kind === "fixed") fixed++; else bal++;
      out.push({ label: label, kind: kind, value: val, anchor: anchor, offset_days: off });
    }
    if (bal > 1) return { ok: false, error: 'Use at most one "Balance" payment.' };
    if (pct > 100.001) return { ok: false, error: "The percentages add up to more than 100%." };
    if (!bal && (fixed > 0 || Math.abs(pct - 100) > 0.001)) return { ok: false, error: 'The payments must add up to 100% - or add a "Balance" payment that takes whatever is left.' };
    return { ok: true, lines: out, error: "" };
  }
  // same arithmetic as public._pst_compute: [{seq,label,amount,due_date}] adding up to the total
  function compute(lines, total, fromIso, eventIso) {
    total = Number(total); if (!(total > 0) || !Array.isArray(lines)) return [];
    var rows = [], run = 0, balIdx = -1;
    lines.forEach(function (l, i) {
      var due = l.anchor === "event" ? (eventIso ? addDays(eventIso, Number(l.offset_days) || 0) : null) : (fromIso ? addDays(fromIso, Number(l.offset_days) || 0) : null);
      if (due && fromIso && due < fromIso) due = fromIso;
      var left = Math.max(total - run, 0), amt = null;
      if (l.kind === "fixed") amt = Math.min(round2(Number(l.value)), left);
      else if (l.kind === "percent") amt = Math.min(Math.round(total * Number(l.value) / 100), left);
      else balIdx = i;
      run += amt || 0;
      rows.push({ seq: i + 1, label: l.label, amount: amt, due_date: due });
    });
    if (!rows.length) return [];
    if (balIdx >= 0) rows[balIdx].amount = round2(Math.max(total - run, 0));
    else if (Math.abs(total - run) > 0) { var last = rows[rows.length - 1]; last.amount = round2(Math.max((last.amount || 0) + (total - run), 0)); }
    return rows.filter(function (r) { return (r.amount || 0) > 0; });
  }
  function stateLabel(state, days) {
    if (state === "paid") return "Paid";
    if (state === "part_paid") return "Part paid";
    if (state === "waived") return "Waived";
    if (state === "invoiced") return "Invoiced";
    if (state === "overdue") return days != null && days < 0 ? "Overdue " + (-days) + (days === -1 ? " day" : " days") : "Overdue";
    if (days === 0) return "Due today";
    if (days != null && days > 0 && days <= 7) return "Due in " + days + (days === 1 ? " day" : " days");
    return "Due";
  }
  function plural(n, w) { return n + " " + w + (n === 1 ? "" : "s"); }
  // r61: "30%" / "12.5%"
  function pctText(n) { var v = Math.round(Number(n) * 10) / 10; return (isFinite(v) ? v : 0) + "%"; }
  // r61: when a template payment is due, in words ("On approval", "15 days before the event", ...)
  function dueWhen(l) {
    var n = Number(l && l.offset_days) || 0, ev = l && l.anchor === "event";
    if (!ev) return n > 0 ? plural(n, "day") + " after approval" : "On approval";
    if (n === 0) return "On the event day";
    return n < 0 ? plural(-n, "day") + " before the event" : plural(n, "day") + " after the event";
  }
  function builtin(key) { for (var i = 0; i < BUILTINS.length; i++) if (BUILTINS[i].key === key) return BUILTINS[i]; return null; }
  // "Automatic reminders: 3 days before, on the due day, 3 days after" | "... off" | "... paused for this event"
  var TRIAL_SIM_REMIND = "Trial simulation - reminders are not sent to your client in the free trial.";
  function reminderLine(rem, paused) {
    if (!rem) return "";
    if (!rem.enabled) return "Automatic client reminders are off (Settings > Reminders & client messages).";
    if (paused) return "Automatic client reminders are paused for this event.";
    var parts = [];
    if (rem.before_days > 0) parts.push(plural(rem.before_days, "day") + " before");
    if (rem.on_due) parts.push("on the due day");
    if (rem.max_overdue > 0) parts.push(rem.max_overdue === 1 ? plural(rem.every_days, "day") + " after" : "every " + plural(rem.every_days, "day") + " after (up to " + rem.max_overdue + ")");
    var s = "Automatic client reminders: " + (parts.length ? parts.join(", ") : "none") + ".";
    if (rem.client_reachable === false) s += " Add the client's e-mail to send them.";
    return s;
  }

  // R252: what happens by itself when the client approves and no plan was chosen. on: true | false | null (not known) -> { on, name, text }
  function autoPlan(d, on) {
    var name = ""; ((d && d.templates) || []).forEach(function (t) { if (t && t.key === d.default_template) name = String(t.name || ""); });
    if (on === true && name) return { on: true, name: name, text: "If you choose nothing, Helm adds \u201c" + name + "\u201d when the client approves." };
    if (on === false) return { on: false, name: "", text: "Nothing is added by itself when the client approves - the automatic plan is off in Settings." };
    return { on: null, name: name, text: "" };
  }
  function refused(e) { return /not authori[sz]ed|42501|permission denied/i.test(String((e && (e.code || "")) + " " + ((e && e.message) || ""))); }

  // ---- R252: the payments of a plan as someone edits them (pure) -----------------------------------------------------
  // part = { label, auto (the name follows the %), unit: percent | fixed, value, when, days, date }
  var MAX_PARTS = 8, CHOICE_KEYS = { full: "builtin:100-upfront", "2": "builtin:50-50", "3": "builtin:30-50-20" }, DAYS = /^(before|after|after_approval)$/;
  var WHENS = [["approval", "On approval"], ["after_approval", "Days after approval"], ["before", "Days before the event"], ["event", "On the event day"], ["after", "Days after the event"], ["date", "On a date"]];
  var FOUR = [{ label: "Advance (25%)", kind: "percent", value: 25, anchor: "approval", offset_days: 0 }, { label: "Second payment (25%)", kind: "percent", value: 25, anchor: "event", offset_days: -30 },
    { label: "Third payment (25%)", kind: "percent", value: 25, anchor: "event", offset_days: -15 }, { label: "Final balance (25%)", kind: "percent", value: 25, anchor: "event", offset_days: 0 }];
  function todayIso() { try { var t = global.BPStore && global.BPStore.todayLocal ? global.BPStore.todayLocal() : ""; if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t; } catch (e) {} return new Date().toISOString().slice(0, 10); }
  function isoMs(s) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || "")); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; }
  function dayDiff(a, b) { var n = (isoMs(b) - isoMs(a)) / 86400000; return isFinite(n) ? Math.round(n) : null; }
  // the built-in with four payments (0435), whatever its key is; "" = the server has none
  function fourKey(tpls) { var k = ""; (tpls || []).forEach(function (t) { if (t && !k && /^builtin:/.test(String(t.key)) && !builtin(t.key)) k = t.key; }); return k; }
  function customReady(d) { return !!(d && (d.can_custom === true || fourKey(d.templates))); }
  function builtinFor(choice, tpls) { return choice === "4" ? fourKey(tpls) : CHOICE_KEYS[choice] || ""; }
  function choiceOf(key, tpls) { for (var c in CHOICE_KEYS) if (CHOICE_KEYS[c] === key) return c; return key && key === fourKey(tpls) ? "4" : key ? "tpl:" + key : "3"; }
  function choiceList(d) {
    var ok = customReady(d), out = [{ value: "full", name: "Full payment" }, { value: "2", name: "2 payments" }, { value: "3", name: "3 payments" }, { value: "4", name: "4 payments", off: !ok }, { value: "custom", name: "Custom", off: !ok }];
    ((d && d.templates) || []).forEach(function (t) { if (t && t.key && !/^builtin:/.test(String(t.key))) out.push({ value: "tpl:" + t.key, name: t.name || "Saved plan" }); });
    return out;
  }
  function linesFor(choice, d, st) {
    var key = choice.indexOf("tpl:") === 0 ? choice.slice(4) : builtinFor(choice, d && d.templates), hit = null;
    ((d && d.templates) || []).concat((st && st.builtins) || [], (st && st.templates) || []).forEach(function (t) { if (key && t && (t.key === key || t.id === key) && Array.isArray(t.lines) && t.lines.length) hit = t.lines; });
    if (hit) return hit;
    var b = key ? builtin(key) : null; return b ? b.lines : choice === "4" ? FOUR : null;
  }
  function trim2(n) { return Math.round(Number(n) * 100) / 100; }
  function autoLabel(label, v) { return String(label || "").replace(/\s*\(\d+(\.\d+)?%\)\s*$/, "") + (Number(v) > 0 ? " (" + trim2(v) + "%)" : ""); }
  function partsFrom(lines, total) {
    var used = 0; total = Number(total) || 0;
    (lines || []).forEach(function (l) { if (l.kind === "percent") used += Number(l.value) || 0; else if (l.kind === "fixed" && total > 0) used += Number(l.value) / total * 100; });
    return (lines || []).map(function (l) {
      var n = Number(l.offset_days) || 0, evn = l.anchor === "event", lab = String(l.label || "Payment");
      return { label: lab, auto: /\(\d+(\.\d+)?%\)\s*$/.test(lab), unit: l.kind === "fixed" ? "fixed" : "percent", value: l.kind === "balance" ? trim2(Math.max(0, 100 - used)) : Number(l.value),
        when: evn ? (n < 0 ? "before" : n > 0 ? "after" : "event") : n > 0 ? "after_approval" : "approval", days: Math.abs(n) || "", date: "" };
    });
  }
  function partPct(x, total) { var v = Number(x && x.value); if (!x || String(x.value == null ? "" : x.value).trim() === "" || !isFinite(v)) return null; return x.unit === "fixed" ? (Number(total) > 0 ? v / Number(total) * 100 : null) : v; }
  function sumPct(parts, total) { var s = 0; parts.forEach(function (x) { s += partPct(x, total) || 0; }); return s; }
  function leftPct(parts, total) { return Math.max(0, trim2(100 - sumPct(parts, total))); }
  function checkParts(parts, total, today) {
    if (!parts.length) return { ok: false, error: "Add at least one payment." };
    if (parts.length > MAX_PARTS) return { ok: false, error: "A plan can have at most " + MAX_PARTS + " payments." };
    for (var i = 0; i < parts.length; i++) {
      var x = parts[i], n = "Payment " + (i + 1) + ": ";
      if (!String(x.label || "").trim()) return { ok: false, error: n + "give it a name." };
      if (partPct(x, total) == null || !(Number(x.value) > 0)) return { ok: false, error: n + "enter " + (x.unit === "fixed" ? "an amount" : "a percent") + " more than 0." };
      if (DAYS.test(x.when) && (!/^\d{1,3}$/.test(String(x.days).trim()) || Number(x.days) < 1 || Number(x.days) > 365)) return { ok: false, error: n + "days must be a whole number from 1 to 365." };
      if (x.when === "date") { var df = dayDiff(today, x.date); if (df == null) return { ok: false, error: n + "choose a date." }; if (df < 0) return { ok: false, error: n + "the date is in the past." }; if (df > 365) return { ok: false, error: n + "the date must be within a year from today." }; }
    }
    var s = sumPct(parts, total), fixed = parts.some(function (y) { return y.unit === "fixed"; }), tol = fixed && Number(total) > 0 ? Math.max(0.006, 0.5 / Number(total) * 100) : 0.005;
    if (Math.abs(100 - s) > tol) return { ok: false, error: "The payments add up to " + trim2(s) + "% - " + (trim2(Math.abs(100 - s)) || 0.01) + "% " + (s < 100 ? "is missing." : "too much.") };
    return { ok: true, error: "" };
  }
  // what the server is sent: a date becomes days from the event (it stays put when "on approval" dates move to the approval day, 0435), from today
  // while the event has no date; with an amount in the plan the last payment takes the rest
  function partLines(parts, total, today, ev) {
    var fixed = parts.some(function (x) { return x.unit === "fixed"; });
    return parts.map(function (x, i) {
      var n = Number(x.days) || 0, l = { label: String(x.label || "").trim(), kind: x.unit === "fixed" ? "fixed" : "percent", value: trim2(x.value), anchor: /^(before|event|after)$/.test(x.when) ? "event" : "approval",
        offset_days: x.when === "before" ? -n : x.when === "after" || x.when === "after_approval" ? n : x.when === "date" ? Math.max(0, dayDiff(today, x.date) || 0) : 0 };
      if (x.when === "date" && ev) { l.anchor = "event"; l.offset_days = dayDiff(ev, x.date) || 0; }
      if (fixed && i === parts.length - 1) { l.kind = "balance"; l.value = null; }
      return l;
    });
  }
  function dueOf(x, today, ev) { var l = partLines([x], 0, today, ev)[0], r = l.anchor === "event" ? (ev ? addDays(ev, l.offset_days) : null) : addDays(today, l.offset_days); return r && r < today ? today : r; }
  function whenText(x) { return dueWhen(partLines([{ label: x.label, unit: "percent", value: 1, when: x.when === "date" ? "approval" : x.when, days: x.days }], 0, "")[0]); }
  function copyPart(x, v) { var o = {}; for (var k in x) o[k] = x[k]; o.unit = "percent"; o.value = v; if (o.auto) o.label = autoLabel(o.label, v); return o; }
  function makeEqual(parts) { var n = parts.length || 1, b = Math.floor(100 / n), extra = 100 - b * n; return parts.map(function (x, i) { return copyPart(x, b + (i >= n - extra ? 1 : 0)); }); }
  function canFit(parts, total) { if (parts.length < 2) return false; var s = sumPct(parts.slice(0, -1), total); return s > 0 && s < 100; }
  function fitLast(parts, total) { if (!canFit(parts, total)) return parts; var out = parts.slice(); out[out.length - 1] = copyPart(parts[parts.length - 1], trim2(100 - sumPct(parts.slice(0, -1), total))); return out; }
  // the first payment becomes the advance %, the others keep their proportion (whole numbers, the last takes the rest)
  function withAdvance(parts, pct) {
    if (parts.length < 2 || !(pct > 0) || !(pct < 100) || Number(parts[0].value) === Number(pct)) return parts;
    var rest = 0, left = trim2(100 - pct), run = 0; parts.slice(1).forEach(function (x) { rest += Number(x.value) || 0; }); if (!(rest > 0)) return parts;
    var out = parts.map(function (x, i) {
      if (i === 0) return copyPart(x, trim2(pct)); if (i === parts.length - 1) return copyPart(x, trim2(left - run));
      var v = Math.max(1, Math.round((Number(x.value) || 0) / rest * left)); run += v; return copyPart(x, v);
    });
    return out.every(function (x) { return Number(x.value) > 0; }) ? out : parts;
  }
  function switchUnit(x, unit, total) {
    if (unit === x.unit) return x;
    var t = Number(total) || 0, pv = partPct(x, total), ok = pv != null && t > 0, o = copyPart(x, ok ? trim2(pv) : "");
    if (unit === "fixed") { o.unit = "fixed"; o.value = ok ? Math.round(t * pv / 100) : ""; if (o.auto) o.label = autoLabel(o.label, 0); }
    return o;
  }
  function sameParts(a, b) {
    return a.length === b.length && a.every(function (x, i) { var y = b[i];
      return String(x.label).trim() === String(y.label).trim() && x.unit === y.unit && Number(x.value) === Number(y.value) && x.when === y.when && (!DAYS.test(x.when) || Number(x.days) === Number(y.days)) && (x.when !== "date" || x.date === y.date); });
  }
  function planName(parts) { return parts.map(function (x) { return x.unit === "fixed" ? "amount" : trim2(x.value); }).join(" / ").slice(0, 80); }

  // ---- DOM -----------------------------------------------------------------------------------------------------------
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function money(n, cur) {
    var B = global.BPStore, v = Number(n) || 0;
    try { if (B && B.studioMoney) return B.studioMoney(v); } catch (e) {}
    return "₹" + Math.round(v).toLocaleString("en-IN");
  }
  function moneyEl(tag, cls, n, cur) { var e = el(tag, cls, money(n, cur)); e.setAttribute("data-money", ""); return e; }
  function fmtDate(iso) { var B = global.BPStore; return iso ? (B && B.fmtDateIN ? B.fmtDateIN(iso) : iso) : "-"; }
  function toast(t, kind) { var U = global.BPUI; if (U && U.toast) U.toast(t, { type: kind || "ok" }); }
  function errText(e) {
    var s = String((e && (e.message || e.code)) || "");
    if (/not authori[sz]ed|42501/i.test(s)) return "You don't have permission to change this event's payments.";
    return s || "Something went wrong - please try again.";
  }

  function mount(box, quoteId, opts) {
    opts = opts || {};
    if (!box || !quoteId) return null;
    var B = global.BPStore; if (!B || !B.paySchedule) return null;
    var state = { data: null, busy: false, auto: null };   // .settings / .adv are asked once, only when someone picks a plan
    // R252 (owner: the plan is made with the quote): title / intro / early() / approved() may be functions - asked again at every paint, so one mounted
    // card follows the event's stage. early() = the client has not approved yet. All optional: without them the card is as before.
    function ask(v) { try { return typeof v === "function" ? v(state.data) : v; } catch (e) { return null; } }
    function early() { return ask(opts.early) === true; }
    function trial() { try { return !!(global.HelmTrialLock && global.HelmTrialLock.isTrial && global.HelmTrialLock.isTrial()); } catch (e) { return false; } }
    function clear() { while (box.firstChild) box.removeChild(box.firstChild); }
    async function load() {
      var d = null, fail = null;
      try { d = await B.paySchedule.forQuote(quoteId); } catch (e) { d = null; fail = e; }
      state.data = d;
      if (!d) {
        box.hidden = true; clear();
        // R252: not allowed = hidden, as before; no answer = the page that asked (opts.onFail) may say so
        if (fail && !refused(fail) && typeof opts.onFail === "function") { try { opts.onFail(fail); } catch (e) {} }
        else if (typeof opts.onNone === "function") { try { opts.onNone(); } catch (e) {} }
        return null;
      }
      // R252: no plan and not approved yet - will the automation add one on approval, and which? (one more read, only then; null = unknown)
      if (early() && !(Array.isArray(d.rows) && d.rows.length) && B.paySchedule.settings && state.auto === null) {
        try { var st = await B.paySchedule.settings(); state.settings = st || null; if (st && typeof st.auto_apply === "boolean") state.auto = st.auto_apply; } catch (e) { state.auto = null; }
      }
      // R116 (0324, display only): in a free-trial studio, the client's simulated TEST payments (never the ledger)
      state.sim = null;
      try {
        var TS = global.HelmTrialSim, TL = global.HelmTrialLock;
        if (TS && TS.simList && TL && TL.isTrial && TL.isTrial() && B.approval && B.approval.trialSimRows) {
          var sl = TS.simList(await B.approval.trialSimRows(quoteId)); if (sl && sl.rows.length) state.sim = sl;
        }
      } catch (e) { state.sim = null; }
      paint(); box.hidden = false;
      if (typeof opts.onLoad === "function") { try { opts.onLoad(d, autoPlan(d, state.auto)); } catch (e) {} }
      return d;
    }
    function paint() {
      var d = state.data; clear();
      box.classList.add("psch");
      if (opts.compact) box.classList.add("psch-compact");
      var rows = Array.isArray(d.rows) ? d.rows : [];
      // controlsOnly (Logistics -> Payments has its own table): the template picker, the cadence line and the pause switch
      if (!opts.controlsOnly || !rows.length) {
        var head = el("div", "psch-head");
        head.appendChild(el(opts.heading || "h3", "psch-title", opts.controlsOnly ? "Add a payment schedule" : ask(opts.title) || "Payment schedule"));
        if (d.applied && d.applied.template) head.appendChild(el("span", "psch-tag", d.applied.template + (d.applied.source === "auto" ? " (added on approval)" : "")));
        box.appendChild(head);
        var intro = ask(opts.intro); if (intro) box.appendChild(el("p", "psch-empty psch-intro", intro));
      }
      if (opts.controlsOnly && rows.length) {
        // nothing more: the page lists the payments itself
      } else if (!rows.length) {
        var ap = early() ? autoPlan(d, state.auto) : null;
        box.appendChild(el("p", "psch-empty", "No payment schedule yet." + (d.can_edit ? " Choose how the client pays - the amounts are worked out from the quote total." : ap && ap.on === false ? "" : " It is added automatically when the client approves.")));
        if (ap && ap.text && opts.autoLine !== false) box.appendChild(el("p", "psch-empty psch-auto", ap.text));
        if (d.can_edit) box.appendChild(applyForm(d));
      } else {
        var wrap = el("div", "psch-scroll"), t = el("table", "psch-table"), th = el("thead"), hr = el("tr");
        ["Payment", "Due", "Amount", "Paid", "Status"].forEach(function (h, i) { var c = el("th", i >= 2 && i <= 3 ? "num" : "", h); c.scope = "col"; hr.appendChild(c); });
        th.appendChild(hr); t.appendChild(th);
        var tb = el("tbody");
        var TSm = global.HelmTrialSim, marks = TSm && TSm.simMarks && state.sim ? TSm.simMarks(rows, state.sim) : [];
        rows.forEach(function (r, ri) {
          var tr = el("tr", "psch-row psch-" + r.state);
          tr.appendChild(el("td", "psch-lbl", r.label || "Payment"));
          tr.appendChild(el("td", "psch-due", fmtDate(r.due_date)));
          tr.appendChild(moneyEl("td", "num", r.amount, d.currency));
          var pd = Number(r.paid) > 0 ? moneyEl("td", "num", r.paid, d.currency) : el("td", "num", "-");
          tr.appendChild(pd);
          var st = el("td"); var chip = marks[ri]
            ? el("span", "psch-chip psch-chip-paid", TSm.PAID_TEST + " \u00b7 " + marks[ri])   // R116: simulated by the client (TEST)
            : el("span", "psch-chip psch-chip-" + r.state, stateLabel(r.state, r.days));
          st.appendChild(chip);
          if (r.state === "part_paid" || (r.state === "overdue" && Number(r.paid) > 0)) {
            var rem = el("span", "psch-rem"); rem.appendChild(document.createTextNode(" ")); rem.appendChild(moneyEl("span", "", r.remaining, d.currency));
            rem.appendChild(document.createTextNode(" left")); st.appendChild(rem);
          }
          tr.appendChild(st); tb.appendChild(tr);
        });
        t.appendChild(tb); wrap.appendChild(t); box.appendChild(wrap);
        var tot = el("div", "psch-tot");
        [["Total", d.total], ["Paid", d.paid], ["Outstanding", d.outstanding]].forEach(function (x) {
          var s = el("span"); s.appendChild(document.createTextNode(x[0] + ": ")); s.appendChild(moneyEl("b", "", x[1], d.currency)); tot.appendChild(s);
        });
        box.appendChild(tot);
        if (marks.length && state.sim && TSm.simReceivedLine) { var sline = TSm.simReceivedLine(state.sim); if (sline) { var sp = el("p", "psch-note trial-sim-received", sline); sp.setAttribute("role", "note"); box.appendChild(sp); } }
        // R112 (0321): Outstanding is the closure balance (invoice total - payments). When the quote total changed after
        // the schedule was made, say so - and Finance edit can re-split the open payments to the new total.
        if (d.mismatch) box.appendChild(mismatchNote(d));
      }
      var line = reminderLine(d.reminders, d.paused);
      // R114 (0323): a free trial is a simulation - reminders are recorded as skipped, never sent to the client
      try { if (line && window.HelmTrialLock && window.HelmTrialLock.isTrial && window.HelmTrialLock.isTrial()) line += " " + TRIAL_SIM_REMIND; } catch (e) {}
      var foot = el("div", "psch-foot");
      if (line) foot.appendChild(el("p", "psch-note", line));
      if (d.can_pause && rows.length && d.reminders && d.reminders.enabled) {
        var lab = el("label", "psch-pause"), cb = el("input"); cb.type = "checkbox"; cb.checked = !!d.paused;
        cb.id = "psch_pause_" + String(quoteId).replace(/[^A-Za-z0-9_-]/g, "");
        // R252: the dates count from the day the plan was added, so a reminder could reach a client who has not approved yet - say it both ways
        if (early() && !d.paused && !trial() && d.held === true) foot.appendChild(el("p", "psch-note psch-hold", "No payment reminder is sent before the client approves or the booking is confirmed. Payments due on approval are dated that day."));
        else if (early() && !d.paused && !trial()) foot.appendChild(el("p", "psch-soft psch-hold", "The client has not approved yet. Dates count from the day the plan was added, so they could get a payment reminder before they approve - pause the reminders until then."));
        else if (ask(opts.approved) === true && d.paused) foot.appendChild(el("p", "psch-soft psch-hold", "The client approved, but payment reminders are still paused - untick to send them again."));
        lab.htmlFor = cb.id; lab.appendChild(cb); lab.appendChild(document.createTextNode(" Pause automatic reminders for this event"));
        cb.addEventListener("change", async function () {
          if (state.busy) return; state.busy = true; cb.disabled = true;
          try { await B.paySchedule.pause(quoteId, cb.checked); toast(cb.checked ? "Automatic reminders paused for this event." : "Automatic reminders are back on for this event."); await load(); }
          catch (e) { cb.checked = !cb.checked; toast(errText(e), "err"); }
          finally { state.busy = false; cb.disabled = false; }
        });
        foot.appendChild(lab);
      }
      if (opts.manageLink !== false && !opts.controlsOnly && rows.length) {
        var a = el("a", "psch-link", d.can_edit ? "Change payments in Logistics" : "Open payments");
        a.href = "logistics.html?quote=" + encodeURIComponent(quoteId) + "#payments"; foot.appendChild(a);
      }
      box.appendChild(foot);
    }
    function mismatchNote(d) {
      var w = el("div", "psch-mismatch"); w.setAttribute("role", "status");
      var p = el("p", "psch-soft"), t = el("span");
      t.appendChild(document.createTextNode("The quote total is now "));
      t.appendChild(moneyEl("b", "", d.total, d.currency));
      t.appendChild(document.createTextNode(", but these payments add up to "));
      t.appendChild(moneyEl("b", "", d.scheduled, d.currency));
      t.appendChild(document.createTextNode(" (the price changed after the schedule was made). Outstanding uses the quote total."));
      p.appendChild(t); w.appendChild(p);
      if (d.can_resync && B.paySchedule.resync) {
        var b = el("button", "btn psch-resync", "Re-split the open payments to the new total"); b.type = "button";
        b.addEventListener("click", async function () {
          if (state.busy) return; state.busy = true; b.disabled = true;
          try {
            var r = await B.paySchedule.resync(quoteId);
            toast(r && r.changed ? "Payment schedule updated to the new total." : (r && r.reason === "below_paid"
              ? "The new total is below what is already paid - record a refund or change the payments in Logistics." : "Nothing to change."), r && r.changed ? "ok" : "info");
            await load(); if (typeof opts.onChange === "function") opts.onChange();
          } catch (e) { toast(errText(e), "err"); }
          finally { state.busy = false; if (b.isConnected) b.disabled = false; }
        });
        w.appendChild(b);
      }
      return w;
    }
    // r61 / R252: "How will the client pay?" (a dropdown) + "Add this schedule" on one aligned line, then the split: one row per
    // payment that can be changed (name, percent or amount, when), a bar, and a total that must be 100%. An untouched choice is
    // added with payment_schedule_apply as before; a changed one or Custom with payment_schedule_apply_custom (0435).
    function applyForm(d) {
      var f = el("div", "psch-apply"), sel = el("select", "psch-sel"), uid = String(quoteId).replace(/[^A-Za-z0-9_-]/g, ""), id = "psch_tpl_" + uid;
      sel.id = id;
      var custom = customReady(d), priced = Number(d.total) > 0, today = d.today || todayIso(), ev = d.event_date || null;
      var P = { choice: choiceOf(d.default_template, d.templates), parts: [], base: null, seq: 0, server: null, refused: "" }, rowEls = [];
      var fld = el("div", "psch-fld"), lab = el("label", "psch-sel-lbl", "How will the client pay?"); lab.htmlFor = id;
      choiceList(d).forEach(function (c) {
        var o = el("option", "", c.name + (c.off ? " (needs a database update)" : "")); o.value = c.value;
        if (c.off) o.disabled = true; if (c.value === P.choice) o.selected = true; sel.appendChild(o);
      });
      fld.appendChild(lab); fld.appendChild(sel);
      var go = el("button", "btn primary psch-go", "Add this schedule"); go.type = "button";
      var row = el("div", "psch-apply-row"); row.appendChild(fld); row.appendChild(go);
      // R252: before the client approves - hold the automatic reminders with the same press (the existing Pause, saved BEFORE the plan)
      var hold = null, holdLab = null;
      if (early() && d.can_pause && d.reminders && d.reminders.enabled && !d.paused && !trial()) {
        holdLab = el("label", "psch-pause psch-holdbox"); hold = el("input"); hold.type = "checkbox"; hold.checked = true; hold.id = "psch_hold_" + uid;
        holdLab.htmlFor = hold.id; holdLab.appendChild(hold);
        if (d.held === true) hold.checked = false;   // 0435: the server sends no automatic reminder before the client approves or the booking is confirmed
        holdLab.appendChild(document.createTextNode(d.held === true ? " Also keep automatic payment reminders paused after the client approves. Before that, nothing is sent."
          : " Pause payment reminders for now - the first payment is dated today and the client has not approved yet. Switch them on after they approve."));
      }
      var bar = el("div", "psch-bar"); bar.setAttribute("aria-hidden", "true");
      var prev = el("div", "psch-prev"); prev.setAttribute("role", "list"); prev.setAttribute("aria-label", "How the payments split");
      var tot = el("p", "psch-total"); tot.setAttribute("role", "status");
      var acts = el("div", "psch-acts");
      var note = el("p", "psch-soft"); note.hidden = true; note.setAttribute("role", "status");
      function btn(text, fn) { var b = el("button", "btn sm", text); b.type = "button"; b.addEventListener("click", fn); acts.appendChild(b); return b; }
      var addB = btn("+ Add a payment", function () { if (P.parts.length < MAX_PARTS) addPart(); });
      var eqB = btn("Make equal", function () { P.parts = makeEqual(P.parts); touched(true); });
      var fitB = btn("Fit the last payment to 100%", function () { P.parts = fitLast(P.parts, d.total); touched(true); });
      var resB = btn("Back to the standard split", function () { P.parts = clone(P.base); touched(true); });
      acts.hidden = !custom;
      // "Save as my studio's plan": only for someone who may change the studio's plans (Settings - Can change), only for a changed plan
      var saveBox = el("div", "psch-save"), saveLab = el("label", "psch-pause"), saveCb = el("input"), nameIn = el("input", "psch-in psch-name");
      var saveNote = el("p", "psch-empty", "A plan with a fixed date can't be saved - choose days before or after instead.");
      saveCb.type = "checkbox"; saveCb.id = "psch_save_" + uid; saveLab.htmlFor = saveCb.id; saveLab.appendChild(saveCb); saveLab.appendChild(document.createTextNode(" Save as my studio's plan"));
      nameIn.type = "text"; nameIn.maxLength = 80; nameIn.setAttribute("aria-label", "Name of the plan"); nameIn.placeholder = "Name of the plan"; nameIn.hidden = true;
      saveCb.addEventListener("change", function () { nameIn.hidden = !saveCb.checked; if (saveCb.checked && !nameIn.value) nameIn.value = planName(P.parts); });
      saveBox.appendChild(saveLab); saveBox.appendChild(nameIn); saveBox.appendChild(saveNote); saveBox.hidden = true;
      function soft(t) { note.textContent = t || ""; note.hidden = !t; }
      function clone(a) { return (a || []).map(function (x) { var o = {}; for (var k in x) o[k] = x[k]; return o; }); }
      function isChanged() { return P.choice === "custom" || !P.base || !sameParts(P.parts, P.base); }
      function key() { return P.choice.indexOf("tpl:") === 0 ? P.choice.slice(4) : builtinFor(P.choice, d.templates); }

      // ---- the rows -------------------------------------------------------------------------------------------------
      function part(i) {
        var x = P.parts[i], n = i + 1, r = el("div", "psch-prow psch-erow"); r.setAttribute("role", "listitem");
        function aria(e, t) { e.setAttribute("aria-label", "Payment " + n + ": " + t); return e; }
        var nm = aria(el("input", "psch-in psch-e-name"), "name"); nm.type = "text"; nm.maxLength = 80; nm.value = x.label;
        nm.addEventListener("input", function () { x.label = nm.value; x.auto = false; touched(false); });
        var vw = el("div", "psch-e-val"), val = aria(el("input", "psch-in"), x.unit === "fixed" ? "amount" : "percent");
        val.type = "number"; val.min = "0"; val.step = "0.01"; val.inputMode = "decimal"; val.value = x.value == null ? "" : String(x.value);
        if (x.unit === "fixed") val.setAttribute("data-money", "");
        val.addEventListener("input", function () { x.value = val.value; x.bal = undefined; if (x.auto && x.unit !== "fixed") { x.label = autoLabel(x.label, val.value); nm.value = x.label; } touched(false); });
        var un = aria(el("select", "psch-in psch-e-unit"), "percent or amount");
        [["percent", "%"], ["fixed", "Amount"]].forEach(function (o) { var e = el("option", "", o[1]); e.value = o[0]; if (o[0] === x.unit) e.selected = true; if (o[0] === "fixed" && !priced) e.disabled = true; un.appendChild(e); });
        un.addEventListener("change", function () { P.parts[i] = switchUnit(x, un.value, d.total); touched(true); });
        vw.appendChild(val); vw.appendChild(un);
        var ww = el("div", "psch-e-when"), wh = aria(el("select", "psch-in"), "when it is due");
        WHENS.forEach(function (o) { var e = el("option", "", o[1]); e.value = o[0]; if (o[0] === x.when) e.selected = true; wh.appendChild(e); });
        wh.addEventListener("change", function () { x.when = wh.value; if (DAYS.test(x.when) && !(Number(x.days) > 0)) x.days = 7; if (x.when === "date" && !x.date) x.date = dueOf({ when: "approval" }, today, ev); touched(true); });
        ww.appendChild(wh);
        if (DAYS.test(x.when)) {
          var dy = aria(el("input", "psch-in psch-e-days"), "number of days"); dy.type = "number"; dy.min = "1"; dy.max = "365"; dy.inputMode = "numeric"; dy.value = String(x.days == null ? "" : x.days);
          dy.addEventListener("input", function () { x.days = dy.value; touched(false); }); ww.appendChild(dy);
        } else if (x.when === "date") {
          var dt = aria(el("input", "psch-in psch-e-date"), "date"); dt.type = "date"; dt.min = today; dt.value = x.date || "";
          dt.addEventListener("change", function () { x.date = dt.value; touched(false); }); ww.appendChild(dt);
        }
        var out = el("div", "psch-e-out"), rm = aria(el("button", "btn sm psch-e-rm", "Remove"), "remove"); rm.type = "button"; rm.disabled = P.parts.length < 2;
        rm.addEventListener("click", function () { if (P.parts.length < 2) return; P.parts.splice(i, 1); toCustom(); touched(true); });
        r.appendChild(nm); r.appendChild(vw); r.appendChild(ww); r.appendChild(out); r.appendChild(rm); rowEls.push(out); return r;
      }
      function plain(i) {
        var x = P.parts[i], r = el("div", "psch-prow"); r.setAttribute("role", "listitem");
        r.appendChild(el("span", "psch-pct", x.unit === "fixed" ? "-" : pctText(x.value)));
        var pl = el("span", "psch-pl"); pl.appendChild(el("b", "", x.label || "Payment")); pl.appendChild(el("span", "", whenText(x))); r.appendChild(pl);
        var out = el("span", "psch-e-out"); r.appendChild(out); rowEls.push(out); return r;
      }
      function rows() {
        while (prev.firstChild) prev.removeChild(prev.firstChild);
        rowEls = [];
        for (var i = 0; i < P.parts.length; i++) prev.appendChild(custom ? part(i) : plain(i));
      }
      // the figures only (never rebuilds a box someone types in)
      function figures() {
        var ck = checkParts(P.parts, d.total, today), lines = ck.ok ? cleanLines(partLines(P.parts, d.total, today, ev)) : ck, calc = null, bad = ck.ok && !lines.ok ? lines.error : "";
        if (priced && ck.ok && lines.ok) calc = P.server && P.server.length === P.parts.length ? P.server : compute(lines.lines, d.total, today, ev);
        rowEls.forEach(function (out, i) {
          while (out.firstChild) out.removeChild(out.firstChild);
          var x = P.parts[i], c = calc && calc.length === P.parts.length ? calc[i] : null, pv = partPct(x, d.total);
          var amt = c ? c.amount : priced && pv != null ? Math.round(Number(d.total) * pv / 100) : null, due = c ? c.due_date : dueOf(x, today, ev);
          if (amt != null) out.appendChild(moneyEl("span", "psch-amt", amt, d.currency));
          else { var a = el("span", "psch-amt is-blank", "-"); a.title = "Worked out once the quote is priced"; out.appendChild(a); }
          out.appendChild(el("span", "psch-e-due", due ? fmtDate(due) : "Set the event date first"));
        });
        while (bar.firstChild) bar.removeChild(bar.firstChild);
        P.parts.forEach(function (x) { var pv = partPct(x, d.total); if (pv > 0) bar.appendChild(el("span", "psch-w" + Math.min(100, Math.max(5, Math.round(pv / 5) * 5)))); });   // width class in 5% steps (no inline style - CSP)
        bar.hidden = !bar.firstChild;
        tot.className = "psch-total" + (ck.ok && !bad ? " is-ok" : " is-off");
        tot.textContent = ck.ok && !bad ? "Total 100%" : bad || ck.error; tot.hidden = !custom && ck.ok;
        addB.disabled = P.parts.length >= MAX_PARTS; eqB.hidden = P.parts.length < 2; fitB.hidden = ck.ok || !canFit(P.parts, d.total); resB.hidden = P.choice === "custom" || !P.base || !isChanged();
        var may = custom && isChanged() && !!(state.settings && state.settings.can_edit), dated = P.parts.some(function (x) { return x.when === "date"; });
        saveBox.hidden = !may; saveNote.hidden = !dated; saveCb.disabled = dated; if (dated && saveCb.checked) { saveCb.checked = false; nameIn.hidden = true; }
        if (!priced) { soft("Price the quote first " + (onFlowPage() ? "(step 8)" : "(Quotation in the quote flow)") + " - the amounts are worked out from its total. You can still pick the plan now."); go.disabled = true; return; }
        go.disabled = !ck.ok || !!bad || !P.parts.length || !!P.refused;
        soft(P.refused);
      }
      function touched(redraw) { P.server = null; P.refused = ""; P.seq++; if (redraw) rows(); figures(); if (redraw && !isChanged()) serverCheck();
        if (state.settings === undefined && isChanged()) need().then(function () { if (rowEls.length) figures(); }); }
      function toCustom() { P.choice = "custom"; P.base = null; sel.value = "custom"; }
      function addPart() { P.parts.push({ label: "Payment " + (P.parts.length + 1), auto: false, unit: "percent", value: leftPct(P.parts, d.total), when: ev ? "before" : "after_approval", days: 7, date: "" }); toCustom(); touched(true); }

      // ---- what a choice starts as ------------------------------------------------------------------------------------
      async function need() {   // asked once, only when someone picks: the studio's own plans (lines) + may this person save one
        if (state.settings !== undefined || !B.paySchedule.settings) return state.settings || null;
        try { state.settings = (await B.paySchedule.settings()) || null; } catch (e) { state.settings = null; }
        return state.settings;
      }
      async function advPct() {   // the first payment of a fresh plan = the advance % of this quote / studio (null = not set)
        if (state.adv !== undefined) return state.adv;
        var v = null;
        try { if (typeof opts.advancePct === "function") v = await opts.advancePct(); else if (d.advance) v = d.advance.pct; else if (B.paySchedule.advanceGet) { var g = await B.paySchedule.advanceGet(quoteId); v = g ? g.pct : null; } } catch (e) { v = null; }
        v = v == null || v === "" ? null : Number(v);
        var out = v != null && isFinite(v) && v > 0 && v < 100 ? v : null; if (typeof opts.advancePct !== "function") state.adv = out; return out;
      }
      async function choose(v, byUser) {
        var my = ++P.seq; P.choice = v; P.server = null; P.refused = "";
        var st = state.settings || null;
        if (byUser || (v.indexOf("tpl:") === 0 && !linesFor(v, d, st))) { st = await need(); if (my !== P.seq) return; }
        var lines = linesFor(v === "custom" ? "2" : v, d, st);
        P.base = v === "custom" || !lines ? null : partsFrom(lines, d.total);
        P.parts = P.base ? clone(P.base) : lines ? partsFrom(lines, d.total) : [];
        if (byUser && custom && /^(2|3|4|custom)$/.test(v)) { var a = await advPct(); if (my !== P.seq) return; if (a != null) P.parts = withAdvance(P.parts, a); }
        rows(); figures();
        if (!P.parts.length) { prev.appendChild(el("p", "psch-empty", "The payments of this plan are worked out when it is added.")); tot.hidden = true; acts.hidden = true; go.disabled = !priced || !key(); }
        else acts.hidden = !custom;
        serverCheck();
      }
      // an untouched choice: the database's own figures (payment_schedule_apply, preview)
      async function serverCheck() {
        if (!priced || (P.parts.length && isChanged())) return;
        var my = P.seq, k = key(); if (!k) return;
        try {
          var r = await B.paySchedule.apply(quoteId, k, true); if (my !== P.seq) return;
          var rs = (r && r.schedule) || [];
          if (!P.parts.length && rs.length) {   // a saved plan whose lines this person can't read: shown as the database works it out
            while (prev.firstChild) prev.removeChild(prev.firstChild);
            rs.forEach(function (x) {
              var q = el("div", "psch-prow"); q.setAttribute("role", "listitem"); q.appendChild(el("span", "psch-pct", pctText(Number(x.amount) / Number(d.total) * 100)));
              var pl = el("span", "psch-pl"); pl.appendChild(el("b", "", x.label || "Payment")); pl.appendChild(el("span", "", x.due_date ? fmtDate(x.due_date) : "")); q.appendChild(pl); q.appendChild(moneyEl("span", "psch-amt", x.amount, d.currency)); prev.appendChild(q);
            });
          } else if (rs.length && rs.length === P.parts.length) { P.server = rs; figures(); }
        } catch (e) {
          if (my !== P.seq) return;
          var t = errText(e);
          if (/price the quote/i.test(t)) priced = false; else P.refused = t;
          figures(); if (P.refused) { soft(t); go.disabled = true; }
        }
      }
      sel.addEventListener("change", function () { return choose(sel.value, true); });
      go.addEventListener("click", async function () {
        if (state.busy || go.disabled) return;
        var changed = P.parts.length > 0 && isChanged(), lines = null, nm = "", done = false;
        if (changed) { var c = cleanLines(partLines(P.parts, d.total, today, ev)); if (!c.ok) { soft(c.error); return; } lines = c.lines; }
        if (changed && saveCb.checked && !saveBox.hidden) { nm = String(nameIn.value || "").trim(); if (!nm) { soft("Give the plan a name, or untick “Save as my studio's plan”."); return; } }
        state.busy = true; go.disabled = true;
        try {
          if (hold && hold.checked) await B.paySchedule.pause(quoteId, true);
          try {
            if (!changed) await B.paySchedule.apply(quoteId, key(), false);
            else {
              var r = B.paySchedule.applyCustom ? await B.paySchedule.applyCustom(quoteId, lines, false) : null;
              if (!r) throw new Error("Changing the payments needs a database update. Choose one of the fixed plans for now.");
            }
            done = true;
          } catch (e) { if (hold && hold.checked) { try { await B.paySchedule.pause(quoteId, false); } catch (x) {} } throw e; }   // no plan: the reminders stay as they were
          var saved = "";
          if (nm) { try { await B.paySchedule.saveTemplate(null, nm, lines); saved = " Saved as your studio's plan “" + nm + "”."; } catch (e) { toast("The plan was added to this event, but it was not saved for the studio: " + errText(e), "err"); } }
          toast("Payment schedule added." + saved + (hold && hold.checked ? " Reminders are paused for this event." : "")); await load(); if (typeof opts.onChange === "function") opts.onChange();
        } catch (e) { var t = errText(e); if (!done && /price the quote/i.test(t)) priced = false; else toast(t, "err"); }
        finally { state.busy = false; if (!done) { if (P.parts.length) figures(); else go.disabled = !priced; } }
      });
      f.appendChild(row); if (holdLab) f.appendChild(holdLab); f.appendChild(bar); f.appendChild(prev); f.appendChild(tot); f.appendChild(acts); f.appendChild(saveBox); f.appendChild(note);
      setTimeout(function () { choose(P.choice, false); }, 0);
      return f;
    }
    load();
    return { reload: load, get data() { return state.data; } };
  }

  var api = { mount: mount, compute: compute, cleanLines: cleanLines, stateLabel: stateLabel, reminderLine: reminderLine, BUILTINS: BUILTINS, addDays: addDays,
              dueWhen: dueWhen, pctText: pctText, autoPlan: autoPlan, partsFrom: partsFrom, partLines: partLines, checkParts: checkParts, makeEqual: makeEqual,
              fitLast: fitLast, withAdvance: withAdvance, switchUnit: switchUnit, sameParts: sameParts, choiceOf: choiceOf, choiceList: choiceList, customReady: customReady, linesFor: linesFor };
  global.HelmPaySchedule = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
