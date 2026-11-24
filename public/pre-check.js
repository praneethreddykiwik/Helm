/* pre-check.js - R252 (owner, 24 Nov: "where is it telling that everything should be ready before an hour"): the pre-event check, the same on
 * Tasks & Crew (ops-board.js) and the Event-day monitor (monitor.js). Nothing is read and nothing is saved here.
 *
 *   HelmPreCheck.state(ctx)         pure -> null | { level, readyAt, guestsAt, now, parts, open, started }
 *   HelmPreCheck.items(ctx)         pure -> what is open, most important first: [{ kind, text, task, crew }]
 *   HelmPreCheck.words(s, tz)       { title, text, left: { label, at, mmss } | null } in plain words
 *   HelmPreCheck.render(host, ctx, top)  host = the banner under the step strip (Pre-event); top = the red one pinned at the top of the page
 *   HelmPreCheck.bell(o)            pure -> { on, at, text }: when the "Event starts in 1 hour - ready?" bell goes and who gets it
 *   HelmPreCheck.how(host)          "How the steps work" (closed until somebody opens it)
 *   ctx = the event-steps.js ctx (quoteId, quote, tasks, plan, sheet, autoWin, win, tz, now, nameOf) + card: the Mark pre-event complete card,
 *         goPre(): show the Pre-event step, phoneOf(task): a phone already on the page ("" = none)
 *
 * The rules:
 *   Ready by   HelmEventPlan.readyAt: the plan's Ready by, else 1 hour before Guests arrive; neither = no banner.
 *   shown      from 1 hour before Ready by until the event is marked pre-event complete (its stage is Event Day or later), it is cancelled, or
 *              the day is over. Before Ready by: on the Pre-event step. From Ready by: red, pinned at the top, whatever step is looked at.
 *   level      calm  before Ready by, nothing open (only the mark is missing)
 *              amber before Ready by, something open
 *              red   Ready by has passed, or guests are due (started = true)
 *   hide       the pinned one can be hidden for 10 minutes (this browser tab, this event); meanwhile the Pre-event step keeps a red one in place.
 *              Never hidden on the wall screen, and back at once when guests are due.
 *   timer      "1 h 40 min" far out; mm:ss in the last 15 minutes before Ready by and, from Ready by, in the last hour before guests arrive
 *              (whole minutes with reduced motion). It ticks in place (role=timer, aria-live off): a screen reader hears only a new level.
 *   what       HelmEventSteps' own preSummary, so the banner and the "Before guests arrive" card never disagree.
 *   mark       presses the card's own button: its permission, checks, confirm and messages. No permission = no button.
 *   bell       0396 event_ready_alert_tick: hour_before_min before Guests arrive (no Guests arrive: before Ready by), bell only, to the
 *              event manager + the roles in the alert settings (admins when that is nobody); none without a task or for a draft quote.
 * DOM calls only (textContent). */
(function (global) {
  "use strict";
  var HOUR = 3600000, TICK15 = 900000, HIDE = 600000, MAX = 4, MARKED = ["event_day", "settlement", "closed"], NOBELL = ["draft", "cancelled", "lost", "rejected"];
  var doc = global.document;
  function fin(v) { return typeof v === "number" && isFinite(v); }
  function pl(n, one, many) { return n + " " + (n === 1 ? one : many); }
  function ymd(v) { var s = String(v || "").slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ""; }
  function clock(t, tz) {
    if (!fin(t)) return "-"; var loc = "en-IN"; try { loc = global.BPStore.studioLocale() || loc; } catch (e) {}
    try { return new Intl.DateTimeFormat(typeof loc === "string" ? loc : "en-IN", { timeZone: tz || "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(t)).replace(/\s?([ap])\.?m\.?$/i, function (x, a) { return " " + a.toUpperCase() + "M"; }); }
    catch (e) { return new Date(t).toISOString().slice(11, 16); }
  }
  function dur(ms) { var m = Math.max(1, Math.round(Math.abs(ms) / 60000)), hh = Math.floor(m / 60), mm = m % 60; return hh ? hh + " h" + (mm ? " " + mm + " min" : "") : mm + " min"; }
  function guestsAt(ev, time, tz) { var T = global.HelmTaskStatus, g = T ? T.hmMin(time) : NaN; return T && ev && isFinite(g) ? T.wallMs(ev, g, tz) : NaN; }

  function state(ctx) {
    ctx = ctx || {}; var q = ctx.quote || {}, EP = global.HelmEventPlan, ES = global.HelmEventSteps, now = ctx.now == null ? Date.now() : Number(ctx.now), ev = ymd(q.eventDate);
    if (!ctx.quoteId || ctx.quoteId === "all" || !ev || !EP || !ES || q.status === "cancelled") return null;
    if (ctx.autoWin !== "pre" && ctx.autoWin !== "onday") return null;
    var stage = ES.stageOf ? ES.stageOf(ctx) : String(q.stage || ""); if (MARKED.indexOf(stage) >= 0) return null;
    var ready = EP.readyAt(ctx.plan, ev, q.eventTime, ctx.tz); if (!fin(ready) || now < ready - HOUR) return null;
    var g = guestsAt(ev, q.eventTime, ctx.tz), started = fin(g) && now >= g, red = started || now >= ready; if (!red && ctx.win !== "pre") return null;
    var s = ES._pure.preSummary(ctx), parts = [], tasks = s.pre.length + s.day.length, out = s.checkedIn == null ? 0 : s.people - s.checkedIn;
    if (tasks) parts.push(pl(tasks, "task", "tasks") + " open");
    if (out > 0) parts.push(pl(out, "person", "people") + " not checked in");
    if (s.checks.length) parts.push(pl(s.checks.length, "day-before check", "day-before checks") + " not ticked");
    return { level: red ? "red" : parts.length ? "amber" : "calm", started: started, readyAt: ready, guestsAt: g, now: now, parts: parts, open: parts.length, win: ctx.win };
  }
  // what is open, the most important first: turned down, nobody on it, late, not checked in, day-before checks, the rest of the tasks
  function items(ctx) {
    var T = global.HelmTaskStatus, ES = global.HelmEventSteps; if (!T || !ES) return [];
    var s = ES._pure.preSummary(ctx), now = ctx.now == null ? Date.now() : Number(ctx.now), all = s.day.concat(s.pre), r = [[], [], [], [], [], []], seen = {};
    var who = function (t) { var n = ""; try { n = ctx.nameOf ? ctx.nameOf(t) : t.assignee_name; } catch (e) {} n = String(n || "").trim(); return /^(not assigned|unassigned|nobody)$/i.test(n) ? "" : n; };
    var put = function (i, kind, t, words) { r[i].push({ kind: kind, text: (t.title || "Task") + " - " + words, task: t }); };
    all.forEach(function (t) {
      var k = T.baseKey(t), n = who(t), m = T.lateMin(t, now);
      if (k === "rejected") put(0, "down", t, "turned down" + (n ? " by " + n : ""));
      else if (k === "unassigned") put(1, "nobody", t, "nobody on it");
      else if (m) put(2, "late", t, (m >= 1440 ? pl(Math.floor(m / 1440), "day", "days") : dur(m * 60000)) + " late" + (n ? ", " + n : ""));
      else put(5, "open", t, "not done yet" + (n ? ", " + n : ""));
    });
    r[2].sort(function (x, y) { return T.lateMin(y.task, now) - T.lateMin(x.task, now); });
    if (s.checkedIn != null) (ctx.tasks || []).forEach(function (t) {
      if (!t || t.status === "cancelled" || !t.crew_id || t.vendor_id || seen[t.crew_id] || T.baseKey(t) === "rejected") return;
      if (T.taskStep(t, { eventDate: ctx.quote.eventDate, eventTime: ctx.quote.eventTime, tz: ctx.tz }) !== "pre") return;
      seen[t.crew_id] = 1; if (!(ctx.sheet[t.crew_id] && ctx.sheet[t.crew_id]["in"])) r[3].push({ kind: "away", text: (who(t) || "Someone") + " - not checked in", task: t });
    });
    s.checks.forEach(function (c) { r[4].push({ kind: "check", text: c + " - not ticked", task: null }); });
    return [].concat.apply([], r);
  }
  function mmss(ms) { var t = Math.max(0, Math.floor(ms / 1000)), m = Math.floor(t / 60), x = t % 60; return m + ":" + (x < 10 ? "0" : "") + x; }
  /* title = the sentence before the timer; left = { label (words before the time, "" = none), at (what it counts to), mmss (ticks every second) } */
  function words(s, tz) {
    var g = s.guestsAt, what = s.parts.join(", "), red = s.level === "red", title, text, left = null;
    if (red) {
      if (s.started) title = "Guests are due - the event has started without pre-event being marked complete";
      else if (fin(g)) { title = "Pre-event is not complete - guests arrive in"; left = { label: "", at: g, mmss: g - s.now < HOUR }; }
      else title = "Pre-event is not complete - it was due by " + clock(s.readyAt, tz);
      text = (s.started ? "Guests were due at " + clock(g, tz) + (s.now - g < 60000 ? "" : ", " + dur(s.now - g) + " ago") + ". " : fin(g) ? "The pre-event check was due by " + clock(s.readyAt, tz) + ". " : "") + (what ? what + "." : "Nothing is open - only the mark is missing.");
      return { title: title, text: text, left: left };
    }
    title = fin(g) ? "Guests arrive at " + clock(g, tz) + " - in " + dur(g - s.now) + "." : "Everything should be ready by " + clock(s.readyAt, tz) + ".";
    text = "Pre-event check by " + clock(s.readyAt, tz) + ": " + (what ? what + "." : "nothing is open - mark it complete.");
    return { title: title, text: text, left: { label: "Ready by in", at: s.readyAt, mmss: s.readyAt - s.now < TICK15 } };
  }
  function spoken(s, tz) { var w = words(s, tz); return w.title + (w.left && !w.left.label ? " " + dur(w.left.at - s.now) : "") + (/\.$/.test(w.title) ? " " : ". ") + w.text; }

  /* when the 0396 bell goes and to whom: o = { plan, eventDate, eventTime, tz, tasks, status } */
  function bell(o) {
    o = o || {}; var set = (o.plan && o.plan.settings) || {}, EP = global.HelmEventPlan, ev = ymd(o.eventDate), n = Number(set.hour_before_min) || 60;
    var none = function (t) { return { on: false, at: NaN, text: "Pre-event check: " + t }; };
    if (set.enabled === false) return none("the bell is off for the studio.");
    if (NOBELL.indexOf(String(o.status || "")) >= 0) return none("no bell while this event is " + (o.status === "draft" ? "a draft" : o.status) + ".");
    var g = guestsAt(ev, o.eventTime, o.tz), start = fin(g) ? g : EP && ev ? EP.readyAt(o.plan, ev, "", o.tz) : NaN;
    if (!fin(start)) return none("no bell yet - set Guests arrive or Ready by first.");
    if (o.tasks && !o.tasks.filter(function (t) { return t && t.status !== "cancelled"; }).length) return none("no bell yet - this event has no tasks.");
    var roles = Array.isArray(set.notify_roles) ? set.notify_roles.filter(Boolean).map(function (r) { return String(r).replace(/_/g, " "); }) : ["manager", "supervisor"];
    var at = start - n * 60000;
    return { on: true, at: at, text: "Pre-event check: a bell goes at " + clock(at, o.tz) + " to the event manager" + (roles.length ? " + " + roles.join(" + ") : " (admins when there is none)") + "." };
  }

  /* ---------------- DOM ---------------- */
  function mk(tag, cls, text) { var n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function setText(n, t) { if (n.textContent !== t) n.textContent = t; }
  var SAID = {}, live = null;
  function announce(t) {
    if (!live || !live.isConnected) { live = mk("span", "pc-sr"); live.setAttribute("role", "status"); live.setAttribute("aria-live", "polite"); doc.body.appendChild(live); }
    live.textContent = ""; setTimeout(function () { live.textContent = t; }, 60);
  }
  function goBtn(card) { return card && card.querySelector ? card.querySelector('[data-key="pre:go"]') : null; }
  function calmMotion() { try { return global.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; } }
  // to the "Before guests arrive" card (on the Pre-event step): the focus goes to the card, never its button - one Enter too many must not mark anything
  function openList(ctx) {
    if (ctx.win !== "pre" && ctx.goPre) ctx.goPre();
    var card = ctx.card; if (!card) return;
    try { card.scrollIntoView({ block: "center", behavior: calmMotion() ? "auto" : "smooth" }); } catch (e) {}
    if (!card.hasAttribute("tabindex")) card.setAttribute("tabindex", "-1");
    try { card.focus({ preventScroll: true }); } catch (e) {}
  }
  // the card's own button; it may still be asking the server whether the stage can move (3 s at most, then the card says why not)
  function mark(ctx, n) {
    if (!n) openList(ctx); n = n || 1; var b = goBtn(ctx.card);
    if (b && !b.disabled) { b.click(); return; }
    if (n < 30 && (!b || !/anyway/.test(b.textContent))) setTimeout(function () { mark(ctx, n + 1); }, 100);
  }
  function mayMark(ctx) { var ES = global.HelmEventSteps, w = ctx.canStage === undefined && ES && ES.mayStage ? ES.mayStage(ctx, again) : ctx.canStage; return w === true; }
  var HIDDEN = {};
  function hiddenFor(q, now) { var t = HIDDEN[q]; if (t == null) { try { t = Number(global.sessionStorage.getItem("helm.prechk." + q)) || 0; } catch (e) { t = 0; } HIDDEN[q] = t; } return now < t; }
  function hide(q, now) { HIDDEN[q] = now + HIDE; try { global.sessionStorage.setItem("helm.prechk." + q, String(HIDDEN[q])); } catch (e) {} }
  function unhide(q) { if (!HIDDEN[q]) return; HIDDEN[q] = 0; try { global.sessionStorage.removeItem("helm.prechk." + q); } catch (e) {} }

  function btn(cls, text, fn) { var b = mk("button", "tc-btn " + cls, text); b.type = "button"; b.addEventListener("click", function (e) { if (e.detail > 1) return; fn(b); }); return b; }
  function timerEl() { var n = mk("span", "pc-time"); n.setAttribute("role", "timer"); n.setAttribute("aria-live", "off"); return n; }
  // the banner under the step strip
  function buildIn(host, box) {
    var P = { title: mk("b", "pc-t"), text: mk("span", "pc-x"), lbl: mk("small", "pc-lbl"), time: timerEl(), clock: mk("div", "pc-clock"), main: mk("div", "pc-main") };
    P.main.appendChild(P.title); P.main.appendChild(P.text); P.clock.appendChild(P.lbl); P.clock.appendChild(P.time);
    P.go = btn("pc-go", "Check now", function () { var c = box.ctx; if (box.mark) mark(c); else openList(c); }); P.go.id = (host.id || "pc") + "Go";
    host.textContent = ""; [P.main, P.clock, P.go].forEach(function (n) { host.appendChild(n); });
    host.setAttribute("role", "region"); host.setAttribute("aria-label", "Pre-event check"); return P;
  }
  // the pinned red one: a bar that stays under the page header, and the list under it (scrolls away with the page)
  function buildTop(host, box) {
    var P = { bar: mk("div", "pc-bar"), title: mk("b", "pc-t"), words: mk("span", ""), time: timerEl(), acts: mk("div", "pc-acts"), body: mk("div", "pc-body"), text: mk("p", "pc-x"), list: mk("ul", "pc-list") };
    P.title.appendChild(P.words); P.title.appendChild(P.time);
    P.open = btn("pc-open", "Open the list", function () { openList(box.ctx); }); P.mark = btn("pc-mark", "Mark pre-event complete", function () { mark(box.ctx); });
    P.hide = btn("ghost pc-hide", "Hide 10 min", function () { hide(String(box.ctx.quoteId), Date.now()); again(); openAfterHide(box.ctx); });
    P.hide.setAttribute("aria-label", "Hide this for 10 minutes");
    [P.open, P.mark, P.hide].forEach(function (n) { P.acts.appendChild(n); });
    P.bar.appendChild(P.title); P.bar.appendChild(P.acts); P.body.appendChild(P.text); P.body.appendChild(P.list);
    host.textContent = ""; host.appendChild(P.bar); host.appendChild(P.body);
    host.setAttribute("role", "region"); host.setAttribute("aria-label", "Pre-event is not complete"); return P;
  }
  function openAfterHide(ctx) { var h = doc.getElementById("main"); if (!h) return; if (!h.hasAttribute("tabindex")) h.setAttribute("tabindex", "-1"); try { h.focus({ preventScroll: true }); } catch (e) {} }   // the pressed button is gone: focus stays on the page
  function paintTime(n, left, now) {
    if (!left) { n.hidden = true; return; } n.hidden = false;
    var ms = left.at - now; setText(n, left.mmss && !calmMotion() ? mmss(ms) : dur(ms));
  }
  function paintList(P, ctx) {
    var all = items(ctx), sig = JSON.stringify(all.slice(0, MAX).map(function (x) { return [x.text, x.task && x.task.id, x.task && ctx.phoneOf ? ctx.phoneOf(x.task) : ""]; })) + all.length;
    if (P.sig === sig) return; P.sig = sig; var keep = doc.activeElement && P.list.contains(doc.activeElement) ? doc.activeElement.getAttribute("href") : "";
    P.list.textContent = ""; P.list.hidden = !all.length;
    all.slice(0, MAX).forEach(function (x) {
      var li = mk("li", "pc-it"); li.appendChild(mk("span", "pc-it-t", x.text));
      var ph = ""; try { ph = x.task && x.kind !== "down" && x.kind !== "nobody" && ctx.phoneOf ? String(ctx.phoneOf(x.task) || "") : ""; } catch (e) {}
      if (ph) { var a = mk("a", "tc-btn pc-call", "Call"), w = ""; try { w = ctx.nameOf ? ctx.nameOf(x.task) : ""; } catch (e) {} a.href = "tel:" + ph.replace(/[^\d+]/g, ""); a.setAttribute("aria-label", "Call " + (w || "them")); li.appendChild(a); }
      P.list.appendChild(li);
    });
    if (all.length > MAX) P.list.appendChild(mk("li", "pc-it pc-more", "and " + (all.length - MAX) + " more"));
    if (keep) Array.prototype.forEach.call(P.list.querySelectorAll("a"), function (a) { if (a.getAttribute("href") === keep) try { a.focus({ preventScroll: true }); } catch (e) {} });
  }
  /* one clock for the page: every second while a mm:ss timer shows, stopped otherwise; nothing while the tab is hidden */
  var LAST = null, tickId = null;
  function again() { if (LAST) render(LAST.host, Object.assign({}, LAST.ctx, { now: Date.now() }), LAST.top); }
  function tick() {
    if (!LAST || (doc && doc.hidden)) return; var s = LAST.s, now = Date.now();
    if (!s || (now >= s.readyAt && s.level !== "red") || (fin(s.guestsAt) && now >= s.guestsAt && !s.started) || Math.floor(now / 60000) !== Math.floor(s.now / 60000)) { again(); return; }
    var w = words(Object.assign({}, s, { now: now }), LAST.ctx.tz);
    [LAST.host, LAST.top].forEach(function (h) { if (h && !h.hidden && h._pc) paintTime(h._pc.P.time, w.left, now); });
  }
  function arm(on) {
    if (on && tickId == null) tickId = setInterval(tick, 1000);
    else if (!on && tickId != null) { clearInterval(tickId); tickId = null; }
  }
  // the banner comes back by itself (10 min over, Ready by reached, the mm:ss stretch begins): one timeout to the next such moment
  var wakeId = null;
  function wake(s, q) {
    if (wakeId != null) { clearTimeout(wakeId); wakeId = null; } if (!s) return;
    var next = [s.readyAt - TICK15, s.readyAt, s.guestsAt, HIDDEN[q] || NaN].filter(function (t) { return fin(t) && t > s.now; }); if (!next.length) return;
    wakeId = setTimeout(again, Math.min(Math.min.apply(null, next) - s.now + 50, 2147000000));
  }

  function render(host, ctx, top) {
    if (!host || !doc) return; ctx = ctx || {};
    var s = state(ctx), q = String(ctx.quoteId || ""), seen = Object.prototype.hasOwnProperty.call(SAID, q), was = SAID[q] || "", lv = s ? s.level + (s.started ? "!" : "") : "";
    var wall = !!(doc.body && doc.body.classList.contains("mon-wall")), red = !!s && s.level === "red";
    if (red && s.started && seen && was !== lv) unhide(q);   // guests are due: back at once
    var hid = red && !wall && hiddenFor(q, s.now), pin = red && !!top && !hid, inl = !!s && ctx.win === "pre" && !pin;
    if (ctx.win === "pre" || s) SAID[q] = lv;
    host.hidden = !inl; if (top) top.hidden = !pin; LAST = { host: host, top: top, ctx: ctx, s: s };
    wake(s, q);
    if (!s) { arm(false); return; }
    var w = words(s, ctx.tz), can = red || inl ? mayMark(ctx) : false, b = goBtn(ctx.card);
    if (inl) {
      var bx = host._pc || (host._pc = {}); bx.ctx = ctx; if (!bx.P) bx.P = buildIn(host, bx); var P = bx.P;
      bx.mark = can && !s.open && !(b && b.disabled);
      host.className = "pc is-" + s.level; setText(P.title, w.title + (w.left && !w.left.label ? " " + dur(w.left.at - s.now) + "." : "")); setText(P.text, w.text);
      P.clock.hidden = !(w.left && w.left.label); setText(P.lbl, w.left ? w.left.label : ""); paintTime(P.time, w.left, s.now);
      setText(P.go, bx.mark ? "Mark pre-event complete" : "Check now");
    }
    if (pin) {
      var tx = top._pc || (top._pc = {}); tx.ctx = ctx; if (!tx.P) tx.P = buildTop(top, tx); var O = tx.P;
      top.className = "pc-top"; setText(O.words, w.title + (w.left ? " " : "")); paintTime(O.time, w.left, s.now); setText(O.text, w.text);
      O.mark.hidden = !can; paintList(O, ctx);
    }
    arm(!!(w.left && w.left.mmss && !calmMotion() && (inl || pin)));
    if (seen && was !== lv) announce(spoken(s, ctx.tz));
  }

  var STEPS = [
    ["Day before", "Any day up to the event."],
    ["Pre-event", "From midnight of the event day, studio time."],
    ["On the event", "When someone marks pre-event complete, or when guests are due."],
    ["Wrap-up", "After the day is over, at the bottom of the page."],
    ["Tasks", "A task goes to a step by its start time: before guests arrive = Pre-event, after = On the event, an earlier day = Day before, clearing up = Wrap-up. No start time = by the kind of work. Run-sheet lines never move. A task that waits for another starts when the earlier one is done, and its reminders wait too (Settings can turn that off)."]
  ];
  function how(host) {
    if (!host || !doc || host._pcHow) return; host._pcHow = true;
    var id = (host.id || "pcHow") + "P", b = mk("button", "pc-how-b", "How the steps work"), p = mk("dl", "pc-how-p");
    b.type = "button"; b.setAttribute("aria-expanded", "false"); b.setAttribute("aria-controls", id); p.id = id; p.hidden = true;
    STEPS.forEach(function (x) { var r = mk("div", "pc-how-r"); r.appendChild(mk("dt", "", x[0])); r.appendChild(mk("dd", "", x[1])); p.appendChild(r); });
    b.addEventListener("click", function () { p.hidden = !p.hidden; b.setAttribute("aria-expanded", String(!p.hidden)); });
    b.addEventListener("keydown", function (e) { if (e.key === "Escape" && !p.hidden) { p.hidden = true; b.setAttribute("aria-expanded", "false"); } });
    host.appendChild(b); host.appendChild(p);
  }

  var api = { state: state, words: words, items: items, mmss: mmss, bell: bell, render: render, how: how, STEPS: STEPS, _reset: function () { SAID = {}; HIDDEN = {}; LAST = null; arm(false); } };
  global.HelmPreCheck = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
