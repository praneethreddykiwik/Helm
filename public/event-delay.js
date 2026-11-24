/* event-delay.js - R252 (owner, 24 Nov: "stage is 40 min late, so dinner is at risk"): one card, "Running late - what it affects", the same on
 * Tasks & Crew (ops-board.js) and the Event-day monitor (monitor.js), and the "Waits for ... - expected done 3:20 PM" words on a task.
 * Nothing is read and nothing is saved here: it works from the tasks, the run-sheet and the day plan the page already has.
 *
 *   HelmDelay.compute({ tasks, runsheet, plan, eventDate, eventTime, tz, now, live })   pure -> { live, byId, rows }
 *   HelmDelay.waits(task, result, clock)    { text, bad } for the row / drawer of a task that waits for another one, else null
 *   HelmDelay.words(row, clock, nameOf)     { cause, effects: [text] } in plain words
 *   HelmDelay.render(host, ctx)             the card (hidden when there is nothing to say)
 *
 * The rules:
 *   duration   duration_min, else planned end - planned start, else what Helm learned for that task name (plan.learned, 0396), else unknown.
 *              Unknown stays unknown: no time is worked out from it ("time unknown"). No safety buffer is added; the Ready by card
 *              adds the studio's buffer to every job, so the Ready by line names that time too.
 *   plan       a task is planned for its start, or for when the task it waits for should end when that is later.
 *   expected   done = its real times. Started = real start + duration, never before now. Not started = the latest of its planned start, now,
 *              and the expected end of the task it waits for. A cancelled (or removed) earlier task holds nobody back; a loop in the links
 *              is cut. A task with no time that nothing waits for and that waits for nothing is left out.
 *   nobody     the earlier task was turned down / not assigned: the later tasks "cannot start" and it shows as blocking (turned down: at
 *              once; not assigned: when it or the next task should start within 3 hours).
 *   hit        later tasks (moved by SLACK = 5 min or more), Ready by and Guests arrive (set-up work only, as on the Ready by card), and
 *              run-sheet lines only where the match is sure: a line with exactly the task's name, or the first line after the chain ends.
 *   severity   "risk"  Ready by / Guests arrive / a run-sheet line is missed or left with less than TIGHT = 10 min, a later task cannot
 *                      start, or a later task moves by 30 min or more
 *              "slip"  only later tasks move (5 - 29 min), a new time is unknown, or the planned order is not possible
 *              ok      anything smaller: not shown
 *   before     the day: only an impossible order (a task planned before the task it waits for ends).
 * DOM calls only (textContent), never HTML strings. Rows are patched in place, so nothing flickers. A screen reader hears a NEW risk only. */
(function (global) {
  "use strict";
  var MIN = 60000, SLACK = 5, TIGHT = 10, BIG = 30, SOON = 180, MAX = 3;

  /* ---------------- pure ---------------- */
  function ms(v) { if (v == null || v === "") return NaN; var t = typeof v === "number" ? v : new Date(v).getTime(); return isFinite(t) ? t : NaN; }
  function ok(v) { return typeof v === "number" && isFinite(v); }
  function norm(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim().toLowerCase(); }
  function ymd10(s) { var v = String(s || "").slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ""; }
  function learned(plan, title) {
    var k = norm(title), l = plan && Array.isArray(plan.learned) ? plan.learned : [];
    for (var i = 0; i < l.length; i++) if (l[i] && norm(l[i].title) === k && Number(l[i].minutes) > 0) return Math.round(Number(l[i].minutes));
    return NaN;
  }
  function durOf(t, plan) {   // minutes, NaN = unknown
    var d = Number(t.duration_min); if (d > 0) return Math.round(d);
    var s = ms(t.planned_start), e = ms(t.planned_end); if (ok(s) && ok(e) && e > s) return Math.round((e - s) / MIN);
    return learned(plan, t.title);
  }
  function hasPerson(t) { return !!(t.crew_id || String(t.assignee_name || "").trim() || t.vendor_id); }
  function nobody(t) { return t.status === "rejected" ? "down" : (t.status === "unassigned" || t.status === "assigned" || !t.status) && !hasPerson(t) ? "none" : ""; }

  function compute(o) {
    o = o || {}; var T = global.HelmTaskStatus, now = o.now == null ? Date.now() : ms(o.now), tz = o.tz, ev = ymd10(o.eventDate);
    var by = {}, kids = {}, ids = [];
    (o.tasks || []).forEach(function (t) { if (t && t.id != null && t.status !== "cancelled") { by[t.id] = { t: t, id: String(t.id) }; ids.push(String(t.id)); } });
    ids.forEach(function (id) {
      var n = by[id], t = n.t, d = t.depends_on != null ? by[t.depends_on] : null;
      n.ps = ms(t.planned_start); n.dur = durOf(t, o.plan); n.done = t.status === "completed"; n.run = t.status === "in_progress"; n.nobody = n.done || n.run ? "" : nobody(t);
      n.dep = d && d !== n ? d : null;
    });
    // cut loops: following the links from a task must never come back to it
    ids.forEach(function (id) { var n = by[id], seen = {}, x = n; seen[id] = 1; while (x && x.dep) { if (seen[x.dep.id]) { x.dep.loop = x.loop = true; x.dep = null; break; } seen[x.dep.id] = 1; x = x.dep; } });
    ids.forEach(function (id) { var d = by[id].dep; if (d) (kids[d.id] = kids[d.id] || []).push(by[id]); });
    ids.forEach(function (id) { var n = by[id]; n.skip = !n.done && !n.run && !ok(n.ps) && !n.dep && !(kids[id] || []).length; });

    // in the order of the links, the earlier task first
    var order = [], mark = {};
    ids.forEach(function (id) { var st = [], x = by[id]; while (x && !mark[x.id]) { mark[x.id] = 1; st.push(x); x = x.dep; } while (st.length) order.push(st.pop()); });
    order.forEach(function (n) {
      var t = n.t, d = n.dep, wait = d && !d.done ? d : null, dm = n.dur * MIN;
      // as planned
      var be = d ? d.baseFinish : NaN;
      n.baseStart = ok(n.ps) ? (ok(be) && be > n.ps ? be : n.ps) : ok(be) ? be : NaN;
      n.baseFinish = ok(n.baseStart) && ok(n.dur) ? n.baseStart + dm : NaN;
      // as it looks now
      n.start = n.finish = NaN; n.own = 0; n.unknown = false; n.pushed = false;
      if (n.done) { n.start = ms(t.started_at); n.finish = ms(t.completed_at); return; }
      if (n.run) {
        var sa = ms(t.started_at); n.start = ok(sa) ? sa : n.ps;
        if (ok(n.start) && ok(n.dur)) n.finish = Math.max(now, n.start + dm);
        if (ok(n.finish) && ok(n.baseFinish)) n.own = Math.round((n.finish - n.baseFinish) / MIN);
        else if (ok(n.start) && ok(n.baseStart) && n.start > n.baseStart) n.own = Math.round((n.start - n.baseStart) / MIN);
        return;
      }
      var depEnd = wait ? wait.finish : d ? d.finish : NaN;
      n.unknown = !!wait && !ok(wait.finish);
      var mine = Math.max(ok(n.ps) ? n.ps : -Infinity, wait ? -Infinity : ok(n.ps) || ok(depEnd) ? now : -Infinity);   // a waiting task is not late by itself
      n.start = Math.max(mine, ok(depEnd) ? depEnd : -Infinity); if (!isFinite(n.start)) n.start = NaN;
      if (n.unknown && ok(n.start) && now > n.start) n.start = now;
      if (ok(n.start) && n.start < now && wait) n.start = now;
      n.finish = ok(n.start) && ok(n.dur) && !n.unknown ? n.start + dm : NaN;
      n.pushed = !!wait && ok(n.start) && ok(n.baseStart) && Math.round((n.start - n.baseStart) / MIN) >= SLACK;
      if (!wait && ok(n.ps)) n.own = Math.round((now - Math.max(n.ps, ok(depEnd) ? depEnd : -Infinity)) / MIN);
      if (n.own < 0) n.own = 0;
    });
    order.forEach(function (n) { n.delta = !n.done && !n.run && ok(n.start) && ok(n.baseStart) ? Math.max(0, Math.round((n.start - n.baseStart) / MIN)) : n.own; });

    var day = T && ev ? T.ymdIn(tz, now) : "", off = T && ev && day ? T.dayDiff(ev, day) : NaN;
    var live = o.live == null ? off === 0 || (off === 1 && now < T.wallMs(day, 360, tz)) : !!o.live;
    var EP = global.HelmEventPlan, setup = {}, readyAt = NaN, guests = NaN, gMin = NaN;
    if (T && ev) { gMin = T.hmMin(o.eventTime); if (ok(gMin)) guests = T.wallMs(ev, gMin, tz); }
    if (EP && ev) { readyAt = EP.readyAt(o.plan, ev, o.eventTime, tz); EP.setupJobs(ids.map(function (id) { return by[id].t; }), { eventDate: ev, eventTime: o.eventTime, tz: tz, readyAt: readyAt }).forEach(function (t) { setup[t.id] = 1; }); }
    var lines = [];
    if (T && ev) (o.runsheet || []).forEach(function (r, i) {
      var m = T.hmMin(r && r.start_time); if (!ok(m)) return; if (ok(gMin) && gMin >= 720 && m < 360) m += 1440;
      lines.push({ r: r, at: T.wallMs(ev, m % 1440, tz) + (m >= 1440 ? 1440 * MIN : 0), key: r.id != null ? String(r.id) : "l" + i });
    });
    lines.sort(function (a, b) { return a.at - b.at; });

    function below(n) {   // every not-done task after n, nearest first
      var out = [], q = [n], seen = {}; seen[n.id] = 1;
      while (q.length) { (kids[q.shift().id] || []).forEach(function (k) { if (seen[k.id] || k.done) return; seen[k.id] = 1; out.push(k); q.push(k); }); }
      return out;
    }
    function isCause(n) { return !n.done && !n.skip && (n.run ? n.own >= SLACK : !!n.nobody ? n.own >= SLACK : n.own >= SLACK && !(n.dep && !n.dep.done)); }
    var rows = [];
    function pushMilestones(row, n, chain) {
      var known = chain.filter(function (x) { return ok(x.finish); }); if (!known.length) return;
      var inSet = known.filter(function (x) { return setup[x.id]; }), end = 0, was = 0;
      inSet.forEach(function (x) { if (x.finish > end) end = x.finish; if (ok(x.baseFinish) && x.baseFinish > was) was = x.baseFinish; });
      var later = end - was >= SLACK * MIN;
      if (end && ok(readyAt) && !(ok(guests) && guests <= now)) {   // guests are in: Ready by is history
        if (end - readyAt >= MIN) row.effects.push({ kind: "ready", was: readyAt, at: end, min: Math.round((end - readyAt) / MIN) });
        else if (later && readyAt - end < TIGHT * MIN) row.effects.push({ kind: "ready", was: readyAt, at: end, spare: Math.round((readyAt - end) / MIN) });
      }
      if (end && ok(guests) && guests > now) {
        if (end - guests >= MIN) row.effects.push({ kind: "guests", was: guests, at: end, min: Math.round((end - guests) / MIN) });
        else if (later && guests - end < TIGHT * MIN) row.effects.push({ kind: "guests", was: guests, at: end, spare: Math.round((guests - end) / MIN) });
      }
      var hit = {}, all = 0, allWas = 0;
      known.forEach(function (x) { if (x.finish > all) all = x.finish; if (ok(x.baseFinish) && x.baseFinish > allWas) allWas = x.baseFinish; });
      chain.forEach(function (x) {
        var nm = norm(x.t.title); if (!nm || !ok(x.start)) return;
        lines.forEach(function (l) { if (!hit[l.key] && l.at > now && norm(l.r.title) === nm && x.start - l.at >= SLACK * MIN) { hit[l.key] = 1; row.effects.push({ kind: "run", title: l.r.title, was: l.at, at: x.start }); } });
      });
      if (allWas) {
        var nx = lines.filter(function (l) { return l.at >= allWas; })[0];
        if (nx && !hit[nx.key] && nx.at > now && all > nx.at - TIGHT * MIN && all - allWas >= SLACK * MIN) row.effects.push({ kind: "run", title: nx.r.title, was: nx.at, at: all, next: true });
      }
    }
    if (live) order.forEach(function (n) {
      var cause = isCause(n), open = below(n), soon = false;
      if (n.nobody && !cause) {   // it has not started yet, but somebody waits for it
        if (!open.length) return;
        var first = [n].concat(open).map(function (x) { return ok(x.ps) ? x.ps : Infinity; }).reduce(function (a, b) { return Math.min(a, b); }, Infinity);
        soon = n.nobody === "down" || first - now <= SOON * MIN;
        if (!soon || (!isFinite(first) && n.nobody !== "down")) return;
      } else if (!cause) return;
      var row = { key: n.id, id: n.id, t: n.t, kind: n.nobody ? (n.own >= SLACK ? "none" : "blocked") : n.run ? "over" : "late", down: n.nobody === "down",
        min: n.run ? n.own : Math.max(n.own, ok(n.ps) ? Math.round((now - n.ps) / MIN) : 0), start: n.ps, effects: [], moveIds: [], moveMin: 0 };
      var chain = [n], inChain = {}; inChain[n.id] = 1;
      open.forEach(function (x) {
        if (!x.dep || !inChain[x.dep.id]) return;
        if (x.run) return;                                   // it started anyway: its own row says so when it runs late
        if (n.nobody && x.dep === n) { if (ok(x.ps) || x.dep) row.effects.push({ kind: "stop", id: x.id, title: x.t.title, was: x.ps }); inChain[x.id] = 1; chain.push(x); return; }
        if (x.unknown) { if (ok(x.ps)) row.effects.push({ kind: "unknown", id: x.id, title: x.t.title, was: x.ps, because: x.dep.t.title }); return; }
        if (!ok(x.start) || !ok(x.dep.finish) || x.start - x.dep.finish >= TIGHT * MIN) return;   // there is room in between: the delay stops here
        inChain[x.id] = 1; chain.push(x);
        if (n.nobody) return;                                 // after "cannot start" no new times are claimed
        var late = ok(x.ps) ? Math.round((x.start - x.ps) / MIN) : 0;
        if (x.delta >= SLACK && ok(x.ps)) { row.effects.push({ kind: "task", id: x.id, title: x.t.title, was: x.ps, at: x.start, min: late }); row.moveIds.push(x.id); if (late > row.moveMin) row.moveMin = late; }
      });
      row.moveMin = Math.ceil(row.moveMin / 5) * 5;
      var tasksN = row.effects.length;
      pushMilestones(row, n, chain);
      if (!row.effects.length) return;                        // late, but it touches nothing else: the Late list already shows it
      row.worst = row.effects.reduce(function (a, e) { return Math.max(a, e.min || 0); }, 0);
      row.hits = row.effects.length - tasksN;
      row.severity = row.hits || row.effects.some(function (e) { return e.kind === "stop" || (e.kind === "task" && e.min >= BIG); }) ? "risk" : "slip";
      rows.push(row);
    });
    // the Ready by card adds the studio's safety buffer to every job: say its time too, so the two cards never seem to disagree
    var worst = null; rows.forEach(function (x) { x.effects.forEach(function (e) { if (e.kind === "ready" && e.min && (!worst || e.at > worst.at)) worst = e; }); });
    if (worst) {
      var set0 = o.plan && o.plan.settings || {}, sc = EP.schedule(ids.filter(function (id) { return setup[id]; }).map(function (id) { return by[id].t; }), { readyAt: readyAt, venueAt: EP.venueAt(o.plan, ev, tz), bufPct: set0.buffer_pct, now: now });
      if (ok(sc.estimate) && sc.estimate - worst.at >= MIN) worst.buffered = sc.estimate;
    }
    // the planned order itself is not possible (direct links only, so one mistake is one line)
    order.forEach(function (n) {
      var d = n.dep; if (!d || n.done || n.run || d.done || !ok(n.ps) || !ok(d.ps)) return;
      var end = d.run && ok(d.finish) ? NaN : ok(d.dur) ? d.ps + d.dur * MIN : NaN, bad = ok(end) ? end - n.ps >= SLACK * MIN : !d.run && d.ps - n.ps >= SLACK * MIN;
      if (!bad) return;
      var row = { key: "order:" + n.id, id: n.id, t: n.t, kind: "order", dep: d.t, min: Math.round(((ok(end) ? end : d.ps) - n.ps) / MIN), start: n.ps, depEnd: end, depStart: d.ps, effects: [], moveIds: [], moveMin: 0, severity: "slip", worst: 0, hits: 0 };
      if (live) below(n).forEach(function (x) { if (!x.run && ok(x.ps) && ok(x.baseStart) && x.baseStart - x.ps >= SLACK * MIN) row.effects.push({ kind: "task", id: x.id, title: x.t.title, was: x.ps, at: x.baseStart, min: Math.round((x.baseStart - x.ps) / MIN) }); });
      rows.push(row);
    });
    var rank = { risk: 0, slip: 1 };
    rows.sort(function (a, b) { return rank[a.severity] - rank[b.severity] || (a.kind === "order") - (b.kind === "order") || b.hits - a.hits || b.worst - a.worst || b.effects.length - a.effects.length || b.min - a.min || String(a.t.title || "").localeCompare(String(b.t.title || "")); });
    return { live: live, now: now, byId: by, rows: rows };
  }

  function dur(m) { m = Math.round(m); if (m < 60) return m + " min"; var h = Math.floor(m / 60), r = m % 60; return h + " h" + (r ? " " + r + " min" : ""); }
  function ttl(t) { return String((t && t.title) || "Task"); }
  // "Waits for Stage set-up - expected done 3:20 PM"; a blocked one says why. null when it waits for nothing (or the earlier task is done)
  function waits(t, r, clock) {
    var n = r && t && r.byId ? r.byId[t.id] : null; if (!n || n.done || n.run || !n.dep || n.dep.done) return null;
    var d = n.dep, nm = ttl(d.t);
    if (d.nobody === "down") return { text: nm + " was turned down - nobody is doing it", bad: true };
    if (d.nobody === "none") return { text: nm + " is not assigned - nobody is doing it", bad: true };
    return { text: "Waits for " + nm + " - " + (ok(d.finish) ? "expected done " + clock(d.finish) : "time unknown"), bad: false };
  }
  function words(row, clock, nameOf) {
    var t = row.t, nm = ttl(t), who = nameOf ? nameOf(t) : t.assignee_name || "", by = who ? " (" + who + ")" : "", c;
    if (row.kind === "order") c = nm + " is planned for " + clock(row.start) + " but waits for " + ttl(row.dep) + ", which " + (ok(row.depEnd) ? "ends at " + clock(row.depEnd) : "only starts at " + clock(row.depStart)) + ".";
    else if (row.kind === "blocked") c = nm + (row.down ? " was turned down" : " is not assigned") + " - nobody is doing it.";
    else if (row.kind === "none") c = nm + (row.down ? " was turned down and nobody is doing it" : " has nobody on it") + " - it should have started at " + clock(row.start) + ".";
    else if (row.kind === "over") c = nm + " is running " + dur(row.min) + " late" + by + ".";
    else c = nm + " is " + dur(row.min) + " late" + by + " - not started.";
    return { cause: c, effects: row.effects.map(function (e) {
      if (e.kind === "task") return ttl(e) + " moves to " + clock(e.at) + " (" + dur(e.min) + " later).";
      if (e.kind === "stop") return ttl(e) + " cannot start" + (ok(e.was) ? " (planned " + clock(e.was) + ")" : "") + ".";
      if (e.kind === "unknown") return ttl(e) + ": new time unknown - " + String(e.because || "the earlier task") + " has no duration.";
      if (e.kind === "ready") return "Ready by " + clock(e.was) + (e.min ? " slips to " + clock(e.at) + (e.buffered ? " (" + clock(e.buffered) + " with the safety buffer)" : "") + "." : " is at risk - " + (e.spare > 0 ? "only " + dur(e.spare) + " to spare." : "nothing to spare."));
      if (e.kind === "guests") return "Guests arrive at " + clock(e.was) + (e.min ? " - set-up would end about " + clock(e.at) + "." : " - set-up would end only " + (e.spare > 0 ? dur(e.spare) + " before." : "just then."));
      return ttl(e) + " at " + clock(e.was) + (e.next ? " (next on the run-sheet)" : "") + " is at risk.";
    }) };
  }

  /* ---------------- DOM ---------------- */
  var doc = global.document;
  function h(tag, a, kids) {
    var n = doc.createElement(tag); a = a || {};
    Object.keys(a).forEach(function (k) { var v = a[k]; if (v == null || v === false) return;
      if (k === "cls") n.className = v; else if (k === "text") n.textContent = v; else if (k === "click") n.addEventListener("click", v); else n.setAttribute(k, v === true ? "" : String(v)); });
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); }); return n;
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  function clockIn(tz, loc) { return function (t) { try { return new Intl.DateTimeFormat(loc || "en-IN", { timeZone: tz || "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(t)).replace(/\s?([ap])m$/i, function (x, a) { return " " + a.toUpperCase() + "M"; }); } catch (e) { return ""; } }; }
  function liveNode() { var n = doc.getElementById("dlyLive"); if (!n) { n = h("span", { id: "dlyLive", cls: "dly-sr", role: "status", "aria-live": "polite" }); doc.body.appendChild(n); } return n; }
  var TAG = { risk: "At risk", slip: "Slipping", order: "Order to check" };

  /* ctx: { quoteId, result (compute), tz, loc, nameOf(t), phoneOf(t), canNudge(t), nudge(t, btn), nudgeEl(t), assign(t) | null, open(t, btn),
     move(ids, min) | null, locked }. nudgeEl = the page's own Remind control (monitor); nudge = a plain action (Tasks & Crew). */
  function render(host, ctx) {
    if (!host) return; var r = ctx.result, rows = (r && r.rows) || [], clk = ctx.clock || clockIn(ctx.tz, ctx.loc);
    var st = host._dly; if (!st || st.quote !== ctx.quoteId) { clear(host); st = host._dly = { quote: ctx.quoteId, rows: {}, seen: null, all: false, head: "" }; }
    // a new risk is read out (not the first picture: that is on the page already)
    var risks = rows.filter(function (x) { return x.severity === "risk"; }), fresh = st.seen ? risks.filter(function (x) { return !st.seen[x.key]; }) : [];
    st.seen = {}; risks.forEach(function (x) { st.seen[x.key] = 1; });
    if (fresh.length) { var w0 = words(fresh[0], clk, ctx.nameOf); liveNode().textContent = "At risk: " + w0.cause + " " + w0.effects.join(" ") + (fresh.length > 1 ? " And " + (fresh.length - 1) + " more." : ""); }
    if (!rows.length) { if (host.contains(doc.activeElement)) try { doc.activeElement.blur(); } catch (e) {} host.hidden = true; return; }
    host.hidden = false;
    if (!st.list) {
      st.h = h("h3", { cls: "tc-h2 dly-h", id: host.id + "H" }); st.t = doc.createElement("span"); st.n = h("span", { cls: "tc-count dly-n" }); st.h.appendChild(st.t); st.h.appendChild(st.n);
      st.list = h("ul", { cls: "dly-list" }); st.more = h("button", { type: "button", cls: "tc-btn sm ghost dly-more", "data-key": "dly:more" });
      st.more.addEventListener("click", function () { st.all = !st.all; render(host, host._dlyCtx); });
      host.appendChild(st.h); host.appendChild(st.list); host.appendChild(st.more); host.setAttribute("aria-labelledby", st.h.id);
    }
    host._dlyCtx = ctx;
    var only = rows.every(function (x) { return x.kind === "order"; }), title = only ? "Order to check" : "Running late - what it affects", num = " " + rows.length;
    if (st.t.textContent !== title) st.t.textContent = title; if (st.n.textContent !== num) st.n.textContent = num;
    host.classList.toggle("is-risk", risks.length > 0);
    var keep = {}, show = st.all ? rows : rows.slice(0, MAX);
    show.forEach(function (x, i) {
      keep[x.key] = 1; var e = st.rows[x.key]; if (!e) { e = st.rows[x.key] = newRow(); }
      fill(e, x, ctx, clk);
      if (st.list.children[i] !== e.li) { var fk = e.li.contains(doc.activeElement) ? doc.activeElement : null; st.list.insertBefore(e.li, st.list.children[i] || null); if (fk) try { fk.focus({ preventScroll: true }); } catch (er) {} }
    });
    Object.keys(st.rows).forEach(function (k) { if (!keep[k]) { st.rows[k].li.remove(); delete st.rows[k]; } });
    var left = rows.length - MAX; st.more.hidden = left <= 0; var mt = st.all ? "Show fewer" : "Show " + left + " more"; if (st.more.textContent !== mt) st.more.textContent = mt; st.more.setAttribute("aria-expanded", String(!!st.all));
  }
  function newRow() {
    var e = { tag: h("span", { cls: "dly-tag" }), cause: h("b", { cls: "dly-cause" }), eff: h("ul", { cls: "dly-eff" }), acts: h("div", { cls: "dly-acts" }), sig: "", esig: "" };
    e.li = h("li", { cls: "dly-row" }, [h("div", { cls: "dly-main" }, [h("div", { cls: "dly-top" }, [e.tag, e.cause]), e.eff]), e.acts]); return e;
  }
  function fill(e, x, ctx, clk) {
    var w = words(x, clk, ctx.nameOf), tg = x.kind === "order" ? TAG.order : TAG[x.severity], cls = "dly-row is-" + (x.kind === "order" ? "order" : x.severity);
    if (e.li.className !== cls) e.li.className = cls; if (e.tag.textContent !== tg) e.tag.textContent = tg; if (e.cause.textContent !== w.cause) e.cause.textContent = w.cause;
    while (e.eff.children.length > w.effects.length) e.eff.removeChild(e.eff.lastChild);
    w.effects.forEach(function (s, i) { var li = e.eff.children[i]; if (!li) { li = doc.createElement("li"); e.eff.appendChild(li); } if (li.textContent !== s) li.textContent = s; });
    e.eff.hidden = !w.effects.length;
    // the buttons are made again only when they really change
    var t = x.t, ph = ctx.phoneOf ? ctx.phoneOf(t) : "", nud = !!(ctx.canNudge && ctx.canNudge(t)), give = !!(ctx.assign && (x.kind === "blocked" || x.kind === "none")), mv = !!(ctx.move && x.moveIds.length && x.moveMin > 0), lock = mv && !!ctx.locked;
    var sig = JSON.stringify([x.id, t.title, t.crew_id, ph, nud, give, mv, lock, mv ? [x.moveIds, x.moveMin] : 0]);
    if (e.sig === sig) return; if (e.acts.querySelector('[aria-expanded="true"]')) return;   // a Remind menu is open
    e.sig = sig; var had = doc.activeElement && e.acts.contains(doc.activeElement) ? doc.activeElement.getAttribute("data-key") : null; clear(e.acts);
    var nm = ttl(t), who = ctx.nameOf ? ctx.nameOf(t) : "";
    if (x.kind !== "order" && ph && who) e.acts.appendChild(h("a", { cls: "tc-btn sm", href: "tel:" + ph, text: "Call", "aria-label": "Call " + who + " about " + nm, "data-key": "dly:call:" + x.id }));
    if (x.kind !== "order" && nud) { if (ctx.nudgeEl) e.acts.appendChild(ctx.nudgeEl(t)); else e.acts.appendChild(h("button", { type: "button", cls: "tc-btn sm", text: "Nudge", title: "E-mail this task to " + (who || "them") + " again now", "aria-label": "Nudge " + (who || "them") + " about " + nm, "data-key": "dly:nudge:" + x.id, click: function (ev) { ctx.nudge(t, ev.currentTarget); } })); }
    if (give) e.acts.appendChild(h("button", { type: "button", cls: "tc-btn sm", text: "Give to someone", "aria-label": "Give " + nm + " to someone", "data-key": "dly:give:" + x.id, click: function () { ctx.assign(t); } }));
    e.acts.appendChild(h("button", { type: "button", cls: "tc-btn sm", text: "Open task", "aria-label": "Open " + nm, "data-key": "dly:open:" + x.id, click: function (ev) { ctx.open(t, ev.currentTarget); } }));
    if (mv && !lock) e.acts.appendChild(h("button", { type: "button", cls: "tc-btn sm", text: "Move the later tasks by " + dur(x.moveMin), "data-key": "dly:move:" + x.id, click: function () { ctx.move(x.moveIds.slice(), x.moveMin); } }));
    else if (lock) e.acts.appendChild(h("span", { cls: "tc-sub dly-lock", text: "Times are locked - unlock the plan to move the later tasks." }));
    if (had) { var b = e.acts.querySelector('[data-key="' + had + '"]'); if (b) try { b.focus({ preventScroll: true }); } catch (er) {} }
  }

  var api = { compute: compute, waits: waits, words: words, render: render, clockIn: clockIn, SLACK: SLACK, TIGHT: TIGHT };
  global.HelmDelay = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
