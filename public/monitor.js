/* monitor.js - R181 Event-day monitor (owner, 16 Nov 2026: "instead of just this section I want a web page just like
 * Tasks & crew - sort by staff, sort by work - monitor everything: this work is done, what else is leftover").
 *
 * One page, four views of the same task list: By staff / By work (section) / By status (columns) / Leftover.
 * Data (all existing, nothing new in the database):
 *   BPStore.ops.live.today(72)        live_events_today (0365): today's + next-3-days events with counts (office roles only)
 *   BPStore.ops.crew.schedule(a, b)   crew_schedule (0161/0365): the rest of the month's events that have work on them
 *   BPStore.ops.listTasks(quote)      event_tasks for one event (RLS: own studio, Staff area)
 *   BPStore.ops.listCrew()            names / departments / linked logins (for the online dot)
 *   BPStore.ops.shifts.timesheet(q)   event_timesheet (0265): who checked in (null without 0265)
 *   BPStore.ops.emailTasks(task,false) staff_email_send (0361): "Send by email" nudge (Staff edit only, server-checked)
 * Gate: BPStore.auth.requireView("staff") - same as Tasks & staff. Crew never see this page.
 * Built with DOM calls only (textContent), never HTML strings. Refreshes every 30 s while the tab is visible
 * (event_tasks is not in a realtime publication, so polling is the cheap, safe choice). */
(function () {
  "use strict";
  var doc = document, REFRESH_MS = 30000, LS_KEY = "helm.monitor.quote", LS_TAB = "helm.monitor.tab";
  var $ = function (s) { return doc.querySelector(s); };
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /* ---- tiny DOM helper ---- */
  function h(tag, o, kids) {
    var n = doc.createElement(tag); o = o || {};
    if (o.cls) n.className = o.cls;
    if (o.text != null) n.textContent = String(o.text);
    if (o.href) n.setAttribute("href", o.href);
    if (o.title) n.setAttribute("title", o.title);
    if (o.role) n.setAttribute("role", o.role);
    if (o.label) n.setAttribute("aria-label", o.label);
    if (o.type) n.setAttribute("type", o.type);
    if (o.data) Object.keys(o.data).forEach(function (k) { n.setAttribute("data-" + k, String(o.data[k])); });
    (kids || []).forEach(function (k) { if (k) n.appendChild(typeof k === "string" ? doc.createTextNode(k) : k); });
    return n;
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  function opt(value, text, sel) { var o = h("option", { text: text }); o.value = value; if (sel) o.selected = true; return o; }

  /* ---- studio time zone helpers ---- */
  function tz() { try { return (BPStore.studioTimezone && BPStore.studioTimezone()) || undefined; } catch (e) { return undefined; } }
  function loc() { try { return (BPStore.studioLocale && BPStore.studioLocale()) || "en-IN"; } catch (e) { return "en-IN"; } }
  function parts(ts) {
    var d = new Date(ts); if (!ts || isNaN(d.getTime())) return null;
    try {
      var f = new Intl.DateTimeFormat("en-GB", { timeZone: tz(), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false });
      var o = {}; f.formatToParts(d).forEach(function (p) { o[p.type] = p.value; });
      return { day: o.year + "-" + o.month + "-" + o.day, hour: Number(o.hour) % 24 };
    } catch (e) { return { day: d.toISOString().slice(0, 10), hour: d.getHours() }; }
  }
  function fmtClock(ts) {
    var d = new Date(ts); if (!ts || isNaN(d.getTime())) return "";
    try { return new Intl.DateTimeFormat(loc(), { timeZone: tz(), hour: "numeric", minute: "2-digit" }).format(d); } catch (e) { return d.toLocaleTimeString(); }
  }
  function fmtDayIso(iso, withYear) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || "")); if (!m) return String(iso || "");
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
    var o = { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }; if (withYear) o.year = "numeric";
    try { return new Intl.DateTimeFormat(loc(), o).format(d); } catch (e) { return String(iso).slice(0, 10); }
  }
  function prevDay(iso) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso); var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] - 1, 12)); return d.toISOString().slice(0, 10); }
  /* "Mon 16 Nov, 2:30 PM"; a task between midnight and 6 AM also says which night it belongs to:
     "Sun 29 Nov, 2:00 AM (night of Sat 28 Nov)" */
  function fmtWhen(ts) {
    var p = parts(ts); if (!p) return "";
    var s = fmtDayIso(p.day) + ", " + fmtClock(ts);
    if (p.hour < 6) s += " (night of " + fmtDayIso(prevDay(p.day)) + ")";
    return s;
  }
  function ago(ts, now) {
    var t = new Date(ts).getTime(); if (!isFinite(t)) return "";
    var m = Math.round(((now || Date.now()) - t) / 60000);
    if (m < 1) return "just now"; if (m < 60) return m + " min ago";
    var hh = Math.floor(m / 60); if (hh < 24) return hh + " h ago";
    return Math.floor(hh / 24) + " d ago";
  }
  function until(ts, now) {
    var t = new Date(ts).getTime(); if (!isFinite(t)) return "";
    var m = Math.round((t - (now || Date.now())) / 60000);
    if (m <= 0) return "now"; if (m < 60) return "in " + m + " min";
    var hh = Math.floor(m / 60), r = m % 60; if (hh < 48) return "in " + hh + " h" + (r ? " " + r + " min" : "");
    return "in " + Math.round(hh / 24) + " days";
  }

  /* ---- status model (pure; unit-tested) ---- */
  var ST = {
    unassigned: { key: "unassigned", label: "No one yet", rank: 0 },
    waiting:    { key: "waiting", label: "Waiting for a yes", rank: 1 },
    accepted:   { key: "accepted", label: "Accepted", rank: 2 },
    started:    { key: "started", label: "Started", rank: 3 },
    done:       { key: "done", label: "Done", rank: 5 },
    rejected:   { key: "rejected", label: "Turned down", rank: 4 }
  };
  function stateOf(t, now) {
    var s = String((t && t.status) || "");
    var base = s === "completed" ? "done" : s === "in_progress" ? "started" : s === "accepted" ? "accepted"
      : s === "rejected" ? "rejected" : (s === "assigned" && (t.crew_id || t.assignee_name)) ? "waiting" : "unassigned";
    var ps = t && t.planned_start ? new Date(t.planned_start).getTime() : NaN;
    var late = (base === "waiting" || base === "accepted") && isFinite(ps) && ps < (now || Date.now());
    return { key: base, late: late, label: ST[base].label };
  }
  function personKey(t) { return t.crew_id ? "c:" + t.crew_id : (t.assignee_name ? "n:" + String(t.assignee_name).toLowerCase() : ""); }
  function summarize(tasks, now) {
    now = now || Date.now();
    var o = { total: 0, done: 0, started: 0, accepted: 0, waiting: 0, rejected: 0, unassigned: 0, late: 0, people: 0, confirmed: 0, next: null, firstLate: null };
    var ppl = {}, conf = {};
    (tasks || []).forEach(function (t) {
      if (!t || t.status === "cancelled") return;
      var s = stateOf(t, now); o.total++; o[s.key]++;
      if (s.late) { o.late++; if (!o.firstLate || new Date(t.planned_start) < new Date(o.firstLate.planned_start)) o.firstLate = t; }
      var k = personKey(t);
      if (k) { ppl[k] = 1; if (s.key === "accepted" || s.key === "started" || s.key === "done") conf[k] = 1; }
      var ps = t.planned_start ? new Date(t.planned_start).getTime() : NaN;
      if ((s.key === "waiting" || s.key === "accepted") && isFinite(ps) && ps >= now && (!o.next || ps < new Date(o.next.planned_start).getTime())) o.next = t;
    });
    o.people = Object.keys(ppl).length; o.confirmed = Object.keys(conf).length;
    o.pct = o.total ? Math.round(o.done * 100 / o.total) : 0;
    return o;
  }
  /* leftover = everything not done: late first, then by start time (no time last), then title */
  function leftover(tasks, now) {
    now = now || Date.now();
    return (tasks || []).filter(function (t) { return t && t.status !== "cancelled" && t.status !== "completed"; })
      .map(function (t) { return { t: t, s: stateOf(t, now) }; })
      .sort(function (a, b) {
        if (a.s.late !== b.s.late) return a.s.late ? -1 : 1;
        var pa = a.t.planned_start ? new Date(a.t.planned_start).getTime() : Infinity, pb = b.t.planned_start ? new Date(b.t.planned_start).getTime() : Infinity;
        if (pa !== pb) return pa - pb;
        return String(a.t.title || "").localeCompare(String(b.t.title || ""));
      }).map(function (x) { return x.t; });
  }

  /* ---- page state ---- */
  var S = { events: [], quote: null, tasks: [], crew: {}, sheet: {}, canEdit: false, tab: "staff", lastLoad: 0, loading: false, evInfo: {}, timer: null };

  function filtered() {
    var q = ($("#monQ").value || "").trim().toLowerCase(), who = $("#monWho").value, sec = $("#monSec").value, st = $("#monSt").value, now = Date.now();
    var out = S.tasks.filter(function (t) {
      if (t.status === "cancelled") return false;
      var s = stateOf(t, now);
      if (who && personKey(t) !== who) return false;
      if (sec && String(t.category || "Other") !== sec) return false;
      if (st && !(st === "late" ? s.late : s.key === st)) return false;
      if (q) { var hay = [t.title, t.category, nameOf(t), t._code].join(" ").toLowerCase(); if (hay.indexOf(q) < 0) return false; }
      return true;
    });
    var sort = $("#monSort").value;
    out.sort(function (a, b) {
      if (sort === "name") return String(a.title || "").localeCompare(String(b.title || ""));
      if (sort === "status") { var x = stateOf(a, now), y = stateOf(b, now); if (x.late !== y.late) return x.late ? -1 : 1; return ST[x.key].rank - ST[y.key].rank; }
      var pa = a.planned_start ? new Date(a.planned_start).getTime() : Infinity, pb = b.planned_start ? new Date(b.planned_start).getTime() : Infinity;
      return pa - pb || String(a.title || "").localeCompare(String(b.title || ""));
    });
    return out;
  }
  function nameOf(t) { var c = t.crew_id && S.crew[t.crew_id]; return (c && c.name) || t.assignee_name || ""; }

  /* ---- small UI pieces ---- */
  function chip(s) {
    var n = h("span", { cls: "mon-chip is-" + s.key, text: s.label });
    var frag = doc.createDocumentFragment(); frag.appendChild(n);
    if (s.late) frag.appendChild(h("span", { cls: "mon-chip is-late", text: "Late" }));
    return frag;
  }
  function steps(t) {
    var s = stateOf(t), lvl = s.key === "done" ? 3 : s.key === "started" ? 2 : s.key === "accepted" ? 1 : s.key === "waiting" ? 0 : -1;
    var wrap = h("span", { cls: "mon-steps", label: "Progress: " + s.label });
    ["Given", "Accepted", "Started", "Done"].forEach(function (lb, i) {
      var cls = "mon-step" + (s.key === "rejected" ? " is-off" : i <= lvl ? " is-on" : "") + (s.late && i === lvl + 1 ? " is-late" : "");
      wrap.appendChild(h("span", { cls: cls, title: lb }));
    });
    return wrap;
  }
  function presenceDot(t) {
    var c = t && t.crew_id && S.crew[t.crew_id];
    if (!c || !c.profile_id) return null;
    var d = h("span", { cls: "mon-dot" }); d.setAttribute("data-presence-uid", c.profile_id); d.hidden = true; return d;
  }
  function avatar(name, t) {
    var a = h("span", { cls: "mon-av", text: String(name || "?").trim().charAt(0).toUpperCase() || "?" });
    var d = presenceDot(t); if (d) { d.setAttribute("data-presence-corner", ""); a.appendChild(d); }
    return a;
  }
  function timeCell(t) {
    if (!t.planned_start) return h("span", { cls: "mon-muted", text: "No start time" });
    var s = stateOf(t), w = h("span", { cls: "mon-time" + (s.late ? " is-late" : "") });
    w.appendChild(h("span", { text: fmtWhen(t.planned_start) }));
    if (s.key === "waiting" || s.key === "accepted") w.appendChild(h("small", { text: s.late ? "should have started " + ago(t.planned_start) : until(t.planned_start) }));
    return w;
  }
  function actions(t) {
    var box = h("span", { cls: "mon-acts" });
    var qid = t.quote_id || S.quote;
    box.appendChild(h("a", { cls: "mon-btn mon-sm", href: "ops.html?quote=" + encodeURIComponent(qid) + "#task-" + encodeURIComponent(t.id), text: "Open", title: "Open this task in Tasks & staff (reassign, schedule, cancel)" }));
    var s = stateOf(t);
    if (S.canEdit && t.crew_id && (s.key === "waiting" || s.key === "accepted" || s.key === "started") && BPStore.ops && BPStore.ops.emailTasks) {
      var b = h("button", { cls: "mon-btn mon-sm", type: "button", text: "✉ Nudge", title: "E-mail this task to " + (nameOf(t) || "them") + " now" });
      b.addEventListener("click", function () { nudge(t, b); });
      box.appendChild(b);
    }
    return box;
  }
  async function nudge(t, btn) {
    var who = nameOf(t) || "this person";
    var ok = true;
    try { ok = window.BPUI && BPUI.confirm ? await BPUI.confirm("E-mail “" + (t.title || "this task") + "” to " + who + " now?", { title: "Send this task by e-mail?", okLabel: "Send e-mail" }) : window.confirm("E-mail this task to " + who + " now?"); } catch (e) { ok = false; }
    if (!ok) return;
    btn.disabled = true;
    try {
      var r = await BPStore.ops.emailTasks(t.id, false);
      var why = r && r.reason;
      toast(r && r.ok ? "E-mail on its way to " + (r.masked || who) + "." :
        why === "no_email" ? who + " has no e-mail on their staff record - add one on the Staff page." :
        why === "just_sent" ? "An e-mail went to " + who + " a moment ago." :
        why === "trial" ? "In the free trial nothing leaves Helm, so no e-mail was sent." : "Nothing was sent for this task.");
    } catch (e) { toast((window.BPUI && BPUI.friendlyError) ? BPUI.friendlyError(e, { action: "send the e-mail" }) : "Could not send the e-mail."); }
    finally { btn.disabled = false; }
  }
  function toast(msg, type) { try { if (window.BPUI && BPUI.toast) return BPUI.toast(msg, { type: type || "info" }); } catch (e) {} var el = $("#monUpdated"); if (el) el.textContent = msg; }
  function empty(text) { return h("div", { cls: "mon-empty", text: text }); }
  function taskRow(t, opts) {
    opts = opts || {};
    var s = stateOf(t);
    var row = h("div", { cls: "mon-row" + (s.late ? " is-late" : "") + (s.key === "done" ? " is-done" : ""), role: "listitem" });
    var main = h("div", { cls: "mon-row-main" });
    var tt = h("div", { cls: "mon-row-title" }, [h("span", { text: t.title || "Task" })]);
    if (t.is_special) tt.appendChild(h("span", { cls: "mon-chip is-special", text: "🔔 Special" }));
    main.appendChild(tt);
    var meta = h("div", { cls: "mon-row-meta" });
    if (opts.showWho !== false) { var nm = nameOf(t); meta.appendChild(h("span", { cls: nm ? "" : "mon-warn", text: nm || "No one yet" })); }
    if (opts.showSec !== false) meta.appendChild(h("span", { cls: "mon-muted", text: t.category || "Other" }));
    if (t._code) meta.appendChild(h("span", { cls: "mon-code", text: t._code }));
    main.appendChild(meta);
    row.appendChild(main);
    row.appendChild(timeCell(t));
    var st = h("div", { cls: "mon-row-st" }); st.appendChild(steps(t)); st.appendChild(chip(s)); row.appendChild(st);
    row.appendChild(actions(t));
    return row;
  }

  /* ---- views ---- */
  function viewStaff(list) {
    var groups = {}, order = [];
    list.forEach(function (t) { var k = personKey(t) || "none"; if (!groups[k]) { groups[k] = []; order.push(k); } groups[k].push(t); });
    var now = Date.now(), wrap = h("div", { cls: "mon-cards" });
    order.sort(function (a, b) {
      if (a === "none") return 1; if (b === "none") return -1;
      var la = summarize(groups[a], now).late, lb = summarize(groups[b], now).late; if (la !== lb) return lb - la;
      return nameOf(groups[a][0]).localeCompare(nameOf(groups[b][0]));
    });
    order.forEach(function (k) {
      var ts = groups[k], first = ts[0], sm = summarize(ts, now), nm = k === "none" ? "No one yet" : nameOf(first);
      var card = h("section", { cls: "mon-card mon-person" + (sm.late ? " has-late" : ""), label: nm });
      var head = h("div", { cls: "mon-person-head" });
      head.appendChild(avatar(nm, first));
      var who = h("div", { cls: "mon-person-who" }, [h("b", { text: nm })]);
      var c = first.crew_id && S.crew[first.crew_id], line = [];
      if (c && (c.department || c.role)) line.push(c.department || c.role);
      var ci = first.crew_id && S.sheet[first.crew_id];
      if (ci) line.push(ci);
      var last = lastAct(ts); if (last) line.push(last);
      who.appendChild(h("small", { text: line.join(" · ") || (k === "none" ? "Give these tasks to someone in Tasks & staff" : "") }));
      head.appendChild(who);
      var pr = h("div", { cls: "mon-person-pr" });
      pr.appendChild(h("b", { text: sm.done + "/" + sm.total + " done" }));
      if (sm.late) pr.appendChild(h("span", { cls: "mon-chip is-late", text: sm.late + " late" }));
      pr.appendChild(bar(sm.pct, "small"));
      head.appendChild(pr);
      card.appendChild(head);
      var rows = h("div", { cls: "mon-rows", role: "list" });
      ts.forEach(function (t) { rows.appendChild(taskRow(t, { showWho: false })); });
      card.appendChild(rows); wrap.appendChild(card);
    });
    return order.length ? wrap : empty("No tasks match these filters.");
  }
  function viewWork(list) {
    var groups = {}, order = [];
    list.forEach(function (t) { var k = t.category || "Other"; if (!groups[k]) { groups[k] = []; order.push(k); } groups[k].push(t); });
    var now = Date.now(), wrap = h("div", { cls: "mon-cards" });
    order.forEach(function (k) {
      var ts = groups[k], sm = summarize(ts, now);
      var card = h("section", { cls: "mon-card mon-sec" + (sm.late ? " has-late" : ""), label: k });
      var head = h("div", { cls: "mon-sec-head" }, [h("h3", { cls: "mon-sec-title", text: k })]);
      var pr = h("div", { cls: "mon-person-pr" });
      pr.appendChild(h("b", { text: sm.done + "/" + sm.total + " done" }));
      if (sm.late) pr.appendChild(h("span", { cls: "mon-chip is-late", text: sm.late + " late" }));
      if (sm.unassigned) pr.appendChild(h("span", { cls: "mon-chip is-unassigned", text: sm.unassigned + " no one yet" }));
      pr.appendChild(bar(sm.pct, "small"));
      head.appendChild(pr); card.appendChild(head);
      var rows = h("div", { cls: "mon-rows", role: "list" });
      ts.forEach(function (t) { rows.appendChild(taskRow(t, { showSec: false })); });
      card.appendChild(rows); wrap.appendChild(card);
    });
    return order.length ? wrap : empty("No tasks match these filters.");
  }
  function viewStatus(list) {
    var now = Date.now(), cols = [["late", "Late"], ["waiting", "Waiting for a yes"], ["accepted", "Accepted"], ["started", "Started"], ["done", "Done"], ["rejected", "Turned down"], ["unassigned", "No one yet"]];
    var board = h("div", { cls: "mon-board" });
    cols.forEach(function (c) {
      var items = list.filter(function (t) { var s = stateOf(t, now); return c[0] === "late" ? s.late : (s.key === c[0] && !s.late); });
      if (!items.length && (c[0] === "rejected" || c[0] === "unassigned")) return;
      var col = h("section", { cls: "mon-col is-" + c[0], label: c[1] + ": " + items.length });
      col.appendChild(h("h3", { cls: "mon-col-h" }, [h("span", { text: c[1] }), h("span", { cls: "mon-n", text: String(items.length) })]));
      if (!items.length) col.appendChild(h("p", { cls: "mon-muted mon-col-empty", text: "Nothing here" }));
      items.forEach(function (t) {
        var k = h("article", { cls: "mon-kcard" });
        k.appendChild(h("b", { text: t.title || "Task" }));
        k.appendChild(h("small", { text: [nameOf(t) || "No one yet", t.category || "Other"].join(" · ") }));
        if (t.planned_start) k.appendChild(h("small", { cls: "mon-muted", text: fmtWhen(t.planned_start) }));
        if (t._code) k.appendChild(h("small", { cls: "mon-code", text: t._code }));
        k.appendChild(actions(t));
        col.appendChild(k);
      });
      board.appendChild(col);
    });
    return board;
  }
  function viewLeft(list) {
    var left = leftover(list);
    if (!left.length) return empty(S.tasks.length ? "Everything is done. 🎉" : "No tasks yet for this event.");
    var card = h("section", { cls: "mon-card", label: "Leftover work" });
    card.appendChild(h("p", { cls: "mon-muted", text: left.length + " still to do - late ones first, then by start time." }));
    var rows = h("div", { cls: "mon-rows", role: "list" });
    left.forEach(function (t) { rows.appendChild(taskRow(t)); });
    card.appendChild(rows);
    return card;
  }
  function lastAct(ts) {
    var best = null;
    ts.forEach(function (t) { [["completed_at", "finished"], ["started_at", "started"], ["responded_at", t.status === "rejected" ? "turned down" : "accepted"]].forEach(function (p) {
      var v = t[p[0]] ? new Date(t[p[0]]).getTime() : NaN; if (isFinite(v) && (!best || v > best.t)) best = { t: v, what: p[1] + " " + (t.title || "a task") }; }); });
    return best ? best.what + " " + ago(best.t) : "";
  }
  function bar(pct, size) {
    var b = h("span", { cls: "mon-bar" + (size ? " is-" + size : ""), role: "progressbar" });
    b.setAttribute("aria-valuemin", "0"); b.setAttribute("aria-valuemax", "100"); b.setAttribute("aria-valuenow", String(pct)); b.setAttribute("aria-label", pct + "% done");
    var f = h("span", { cls: "mon-bar-fill" }); f.style.width = Math.max(0, Math.min(100, pct)) + "%"; b.appendChild(f); return b;
  }

  /* ---- render ---- */
  function renderSummary() {
    var box = $("#monSummary"); clear(box);
    var sm = summarize(S.tasks), now = Date.now();
    var top = h("div", { cls: "mon-sum-top" });
    top.appendChild(h("div", { cls: "mon-pct" }, [h("b", { text: sm.pct + "%" }), h("span", { text: " done · " + sm.done + " of " + sm.total + " tasks" })]));
    top.appendChild(bar(sm.pct));
    box.appendChild(top);
    var counts = h("div", { cls: "mon-counts" });
    [["done", sm.done, "Done"], ["started", sm.started, "Started"], ["accepted", sm.accepted, "Accepted"], ["waiting", sm.waiting, "Waiting for a yes"],
     ["late", sm.late, "Late"], ["rejected", sm.rejected, "Turned down"], ["unassigned", sm.unassigned, "No one yet"]].forEach(function (c) {
      if ((c[0] === "rejected" || c[0] === "unassigned") && !c[1]) return;
      var b = h("button", { cls: "mon-count is-" + c[0], type: "button", title: "Show only: " + c[2] });
      b.appendChild(h("b", { text: String(c[1]) })); b.appendChild(h("span", { text: c[2] }));
      b.addEventListener("click", function () { $("#monSt").value = c[0]; setTab(c[0] === "done" ? "work" : "left"); render(); });
      counts.appendChild(b);
    });
    box.appendChild(counts);
    var facts = h("div", { cls: "mon-facts" });
    facts.appendChild(h("span", { text: "👥 " + sm.confirmed + " of " + sm.people + " people confirmed (accepted, started or done)" }));
    if (sm.next) facts.appendChild(h("span", { text: "⏭ Next: " + (sm.next.title || "task") + " - " + fmtWhen(sm.next.planned_start) + " (" + until(sm.next.planned_start, now) + ")" }));
    if (sm.firstLate) facts.appendChild(h("span", { cls: "mon-warn", text: "⚠ First late: " + (sm.firstLate.title || "task") + " - " + (nameOf(sm.firstLate) || "no one") + ", due " + fmtClock(sm.firstLate.planned_start) }));
    box.appendChild(facts);
    var n = leftover(S.tasks).length; $("#monLeftN").textContent = n ? String(n) : "";
  }
  function renderFeed() {
    var feed = $("#monFeed"), acts = []; clear(feed);
    S.tasks.forEach(function (t) { [["completed_at", "finished"], ["started_at", "started"], ["responded_at", t.status === "rejected" ? "turned down" : "accepted"]].forEach(function (p) {
      if (t[p[0]]) acts.push({ at: t[p[0]], who: nameOf(t) || "Someone", what: p[1], title: t.title || "a task", code: t._code }); }); });
    acts.sort(function (a, b) { return new Date(b.at) - new Date(a.at); });
    if (!acts.length) { feed.appendChild(h("li", { cls: "mon-muted", text: "No activity yet - accepts, starts and finishes show here." })); return; }
    acts.slice(0, 15).forEach(function (a) {
      feed.appendChild(h("li", { cls: "mon-feed-i is-" + a.what.replace(/\s/g, "-") }, [
        h("b", { text: a.who }), " " + a.what + " ", h("span", { text: a.title }),
        a.code ? h("span", { cls: "mon-code", text: " " + a.code }) : null,
        h("small", { text: ago(a.at) })]));
    });
  }
  function fillFilters() {
    var who = $("#monWho"), sec = $("#monSec"), wv = who.value, sv = sec.value, people = {}, secs = {};
    S.tasks.forEach(function (t) { if (t.status === "cancelled") return; var k = personKey(t); if (k) people[k] = nameOf(t); secs[t.category || "Other"] = 1; });
    clear(who); who.appendChild(opt("", "Everyone"));
    Object.keys(people).sort(function (a, b) { return people[a].localeCompare(people[b]); }).forEach(function (k) { who.appendChild(opt(k, people[k], k === wv)); });
    clear(sec); sec.appendChild(opt("", "All sections"));
    Object.keys(secs).sort().forEach(function (k) { sec.appendChild(opt(k, k, k === sv)); });
  }
  function render() {
    renderSummary();
    var list = filtered(), v = $("#monView"); clear(v);
    if (!S.tasks.length) v.appendChild(empty("No tasks for this event yet. Give work out in Tasks & staff and it shows here live."));
    else v.appendChild(S.tab === "work" ? viewWork(list) : S.tab === "status" ? viewStatus(list) : S.tab === "left" ? viewLeft(list) : viewStaff(list));
    renderFeed();
    try { if (BPStore.presence && BPStore.presence.paint) BPStore.presence.paint(v); } catch (e) {}
  }
  function setTab(tab) {
    S.tab = /^(staff|work|status|left)$/.test(tab) ? tab : "staff";
    Array.prototype.forEach.call(doc.querySelectorAll(".mon-tab"), function (b) {
      var on = b.getAttribute("data-tab") === S.tab; b.setAttribute("aria-selected", on ? "true" : "false"); b.tabIndex = on ? 0 : -1;
      if (on) $("#monView").setAttribute("aria-labelledby", b.id);
    });
    try { localStorage.setItem(LS_TAB, S.tab); } catch (e) {}
  }

  /* ---- data ---- */
  function todayIso() { var p = parts(new Date().toISOString()); return p ? p.day : new Date().toISOString().slice(0, 10); }
  function addDays(iso, n) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso); return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n, 12)).toISOString().slice(0, 10); }
  async function loadEvents() {
    var soon = [], later = {}, seen = {};
    try { var r = await BPStore.ops.live.today(72); ((r && r.events) || []).forEach(function (e) { if (e && e.quote_id && !seen[e.quote_id]) { seen[e.quote_id] = 1; soon.push(e); } }); } catch (e) {}
    try {
      var t0 = todayIso(), rows = await BPStore.ops.crew.schedule(t0, addDays(t0, 30));
      (rows || []).forEach(function (x) { if (x && x.quote_id && !seen[x.quote_id] && !later[x.quote_id]) later[x.quote_id] = { quote_id: x.quote_id, code: x.event_code, title: x.event_title, event_date: x.event_date || x.sched_date }; });
    } catch (e) {}
    var rest = Object.keys(later).map(function (k) { return later[k]; }).sort(function (a, b) { return String(a.event_date).localeCompare(String(b.event_date)); });
    S.events = soon.concat(rest);
    S.evInfo = {}; S.events.forEach(function (e) { S.evInfo[e.quote_id] = e; });
    var sel = $("#monEvent"); clear(sel);
    var todays = soon.filter(function (e) { return e.is_today; });
    if (todays.length > 1) sel.appendChild(opt("all", "All events today (" + todays.length + ")"));
    function label(e) { return [e.code, e.title].filter(Boolean).join(" · ") + " - " + fmtDayIso(e.event_date) + (e.is_today ? " (today)" : ""); }
    if (soon.length) { var g1 = h("optgroup"); g1.label = "Today and the next 3 days"; soon.forEach(function (e) { g1.appendChild(opt(e.quote_id, label(e))); }); sel.appendChild(g1); }
    if (rest.length) { var g2 = h("optgroup"); g2.label = "Later this month"; rest.forEach(function (e) { g2.appendChild(opt(e.quote_id, label(e))); }); sel.appendChild(g2); }
  }
  async function loadCrew() {
    try { var list = await BPStore.ops.listCrew(); S.crew = {}; (list || []).forEach(function (c) { if (c && c.id) S.crew[c.id] = c; }); } catch (e) { S.crew = {}; }
  }
  async function loadSheet(quoteIds) {
    S.sheet = {};
    var T = BPStore.ops.shifts && BPStore.ops.shifts.timesheet; if (!T) return;
    await Promise.all(quoteIds.map(function (q) { return T(q).then(function (r) {
      ((r && r.rows) || []).forEach(function (x) {
        if (!x || !x.crew_id) return;
        var e = (x.entries || []).filter(function (k) { return r.today && k.day === r.today; })[0];
        S.sheet[x.crew_id] = e && e.in ? ("✅ checked in " + e.in + (e.out ? " · out " + e.out : "")) : x.roster === "arrived" ? "✅ arrived" : x.flag === "late" ? "⏰ late to check in" : "";
      }); }).catch(function () {}); }));
  }
  async function loadTasks(silent) {
    if (S.loading || !S.quote) return; S.loading = true;
    if (!silent) $("#monView").setAttribute("aria-busy", "true");
    try {
      var ids = S.quote === "all" ? S.events.filter(function (e) { return e.is_today; }).map(function (e) { return e.quote_id; }) : [S.quote];
      var lists = await Promise.all(ids.map(function (q) { return BPStore.ops.listTasks(q).then(function (ts) {
        var code = S.quote === "all" ? ((S.evInfo[q] && S.evInfo[q].code) || "") : "";
        return (ts || []).map(function (t) { t.quote_id = t.quote_id || q; if (code) t._code = code; return t; }); }); }));
      S.tasks = [].concat.apply([], lists);
      await loadSheet(ids);
      S.lastLoad = Date.now(); $("#monErr").hidden = true;
      fillFilters(); render(); tick();
    } catch (e) {
      var er = $("#monErr"); er.hidden = false;
      er.textContent = (window.BPUI && BPUI.friendlyError) ? BPUI.friendlyError(e, { action: "load the event's tasks" }) : "Could not load the tasks. Check your connection and press Refresh.";
    } finally { S.loading = false; $("#monView").removeAttribute("aria-busy"); }
  }
  function headFor() {
    var e = S.quote === "all" ? null : S.evInfo[S.quote];
    if (S.quote === "all") { $("#monTitle").textContent = "All events today"; $("#monSub").textContent = S.events.filter(function (x) { return x.is_today; }).map(function (x) { return x.code; }).join(" · "); $("#monOpenOps").hidden = true; return; }
    $("#monOpenOps").hidden = false; $("#monOpenOps").setAttribute("href", "ops.html?quote=" + encodeURIComponent(S.quote));
    if (!e) { $("#monTitle").textContent = "Event"; $("#monSub").textContent = ""; return; }
    $("#monTitle").textContent = [e.code, e.title].filter(Boolean).join(" · ");
    $("#monSub").textContent = [fmtDayIso(e.event_date, true), e.event_time, e.venue].filter(Boolean).join(" · ");
  }
  async function choose(q, push) {
    S.quote = q; headFor();
    try { localStorage.setItem(LS_KEY, q); } catch (e) {}
    if (push) { try { var u = new URL(location.href); u.searchParams.set("quote", q); history.replaceState(null, "", u.pathname + u.search); } catch (e) {} }
    S.tasks = []; await loadTasks(false);
  }
  function tick() {
    var el = $("#monUpdated"); if (!el || !S.lastLoad) return;
    var s = Math.round((Date.now() - S.lastLoad) / 1000);
    el.textContent = "Updated " + (s < 5 ? "just now" : s < 60 ? s + "s ago" : Math.floor(s / 60) + " min ago");
  }

  /* ---- start ---- */
  function signedIn() { try { return !!(BPStore.auth && BPStore.auth.user()); } catch (e) { return true; } }
  async function renderAccount() {
    var box = $("#account"), A = BPStore.auth; if (!A.enabled()) { box.hidden = true; return; }
    box.hidden = false; clear(box);
    var u = A.user(); if (!u) return;
    var role = await A.role();
    box.appendChild(h("span", { cls: "role", text: role || "" })); box.appendChild(h("span", { text: u.email || "" }));
    var b = h("button", { type: "button", text: "Log out" });
    b.addEventListener("click", async function () { await A.signOut(); location.href = "dashboard.html"; }); box.appendChild(b);
  }
  function wire() {
    $("#monEvent").addEventListener("change", function () { choose(this.value, true); });
    $("#monRefresh").addEventListener("click", function () { loadTasks(false); });
    ["#monQ", "#monWho", "#monSec", "#monSt", "#monSort"].forEach(function (s) { $(s).addEventListener(s === "#monQ" ? "input" : "change", render); });
    $("#monClear").addEventListener("click", function () { $("#monQ").value = ""; $("#monWho").value = ""; $("#monSec").value = ""; $("#monSt").value = ""; $("#monSort").value = "time"; render(); });
    var tabs = $("#monTabs");
    tabs.addEventListener("click", function (e) { var b = e.target.closest(".mon-tab"); if (!b) return; setTab(b.getAttribute("data-tab")); render(); });
    tabs.addEventListener("keydown", function (e) {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      var all = Array.prototype.slice.call(tabs.querySelectorAll(".mon-tab")), i = all.findIndex(function (b) { return b.getAttribute("aria-selected") === "true"; });
      var n = all[(i + (e.key === "ArrowRight" ? 1 : all.length - 1)) % all.length]; setTab(n.getAttribute("data-tab")); n.focus(); render(); e.preventDefault();
    });
    setInterval(function () { if (signedIn() && !doc.hidden && Date.now() - S.lastLoad >= REFRESH_MS) loadTasks(true); tick(); }, 5000);
    doc.addEventListener("visibilitychange", function () { if (!doc.hidden && signedIn() && Date.now() - S.lastLoad > 10000) loadTasks(true); });
  }
  async function start() {
    await BPStore.init(); await renderAccount();
    try { await BPStore.bell.mount($("#bell")); } catch (e) {}
    var A = BPStore.auth;
    if (A.enabled() && A.required() && !A.user()) { location.replace("login.html?next=" + encodeURIComponent(location.pathname + location.search)); return; }
    if (!(await A.requireView("staff"))) { $("#monBoot").hidden = true; return; }
    try { S.canEdit = !!(await A.canEditArea("staff")); } catch (e) { S.canEdit = false; }
    await Promise.all([loadEvents(), loadCrew()]);
    $("#monBoot").hidden = true; $("#monApp").hidden = false;
    var want = null; try { want = new URLSearchParams(location.search).get("quote"); } catch (e) {}
    try { if (!want && window.HelmUrl && HelmUrl.get) want = await HelmUrl.get("quote", null); } catch (e) {}
    var saved = null; try { saved = localStorage.getItem(LS_KEY); } catch (e) {}
    var tabSaved = null; try { tabSaved = localStorage.getItem(LS_TAB); } catch (e) {}
    setTab(tabSaved || "staff");
    var sel = $("#monEvent");
    var pick = (want && (want === "all" || UUID.test(want))) ? want : (saved && (saved === "all" || S.evInfo[saved])) ? saved : (S.events[0] && S.events[0].quote_id);
    if (want && UUID.test(want) && !S.evInfo[want]) { sel.insertBefore(opt(want, "This event"), sel.firstChild); S.evInfo[want] = { quote_id: want }; }
    if (!pick) { $("#monView").appendChild(empty("No events with work today or this month. Give out tasks in an event's Tasks & staff page.")); $("#monSummary").hidden = true; return; }
    sel.value = pick; wire();
    if (S.evInfo[pick] && !S.evInfo[pick].code) { try { var q = await BPStore.quotes.get(pick); if (q) { S.evInfo[pick] = { quote_id: pick, code: q.code, title: q.title, event_date: q.eventDate || q.event_date, event_time: q.eventTime || q.event_time }; sel.options[0].textContent = [q.code, q.title].filter(Boolean).join(" · "); } } catch (e) {} }
    await choose(pick, false);
  }
  function go() { if (window.BPUI && BPUI.boot) BPUI.boot(start); else start(); }
  if (typeof window !== "undefined" && typeof document !== "undefined" && document.getElementById && document.getElementById("monApp")) {
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", go); else go();
  }
  window.HelmMonitor = { stateOf: stateOf, summarize: summarize, leftover: leftover, fmtWhen: fmtWhen, _personKey: personKey };
})();
