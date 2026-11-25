/* task-clash.js - R254 (owner, 25 Nov): one person, two works at the same time. It never blocks: it ASKS.
 *
 *   HelmTaskClash.find(items, o)   -> Promise<{ rows: [[clash]], any, failed }>   what each item overlaps
 *   HelmTaskClash.ask(items, o)    -> Promise<true | false>   true = go on (no clash, "Give it anyway", or the check could not be made)
 *   HelmTaskClash.give(items, o, dayCheck) the same + the old "busy that day" question, never both for the same event (the time clash wins)
 *   HelmTaskClash.board(o)         the tags of one event: own tasks at once, other events from one batched read a minute
 *   HelmTaskClash.people(crewIds, start, o) the sheet's list: crew id -> "same time: Sharma wedding 5:00-7:00 pm" (debounced by the caller)
 *
 *   item  { crew_id, start (ISO), end?, duration_min?, depends_on?, id? (an existing task), title?, name? (the person) }
 *   o     { quoteId, tasks (this event's loaded tasks), exclude? (task ids being moved), question?, ok?, cancel?, toast?(text), nameOf?(crewId) }
 *   clash { task_id, quote_id, code, title, start, end, about, same_event }
 *
 * The rule (the same in SQL, crew_time_clashes in 0438): tasks of the same person (crew_id, in house), status assigned / accepted / in_progress.
 * Interval [start, end): end = planned_end, else start + duration_min, else start + 60 min (about). Overlap only: end == start is no clash, no start
 * = never. A task that waits for the other (directly or through a chain) is no clash with it. Real instants: midnight and DST just work.
 * Other events come from BPStore.ops.timeClashes (null = a database without it: this event only). Reads only. DOM: none. */
(function (global) {
  "use strict";
  var OPEN = { assigned: 1, accepted: 1, in_progress: 1 }, MAX = 5, BATCH = 60, HOUR = 3600000;
  function ms(v) { if (v == null || v === "") return NaN; var t = new Date(v).getTime(); return isFinite(t) ? t : NaN; }
  function same(a, b) { return a != null && b != null && String(a) === String(b); }
  /* ---- the rule (pure) ---- */
  function interval(t) {
    var s = ms(t && (t.start != null ? t.start : t.planned_start)); if (!isFinite(s)) return null;
    var e = ms(t.end != null ? t.end : t.planned_end), d = Number(t.duration_min);
    if (isFinite(e) && e > s) return { s: s, e: e, about: !!t.about };
    if (isFinite(d) && d > 0) return { s: s, e: s + d * 60000, about: false };
    return { s: s, e: s + HOUR, about: true };
  }
  function counts(t) { return !!(t && t.crew_id && t.assignee_kind !== "outsourced" && !t.vendor_id && OPEN[t.status]); }
  function overlap(a, b) { return !!(a && b && a.s < b.e && b.s < a.e); }
  // does `from` wait for `id` (itself, directly or through a chain)? a circle in the data ends
  function waitsFor(by, from, id) { var seen = {}, cur = from == null ? "" : String(from); while (cur && !seen[cur]) { if (cur === String(id)) return true; seen[cur] = 1; cur = by[cur] ? String(by[cur]) : ""; } return false; }
  function links(tasks, items) {
    var by = {}; (tasks || []).forEach(function (t) { if (t) by[String(t.id)] = t.depends_on ? String(t.depends_on) : ""; });
    (items || []).forEach(function (i) { if (i && i.id != null && "depends_on" in i) by[String(i.id)] = i.depends_on ? String(i.depends_on) : ""; }); return by;
  }
  function chained(by, item, t) { return waitsFor(by, item.id != null ? by[String(item.id)] : item.depends_on, t.id) || (item.id != null && waitsFor(by, by[String(t.id)], item.id)); }
  function clashOf(t, o) { var iv = interval(t); return { task_id: t.id == null ? null : t.id, quote_id: t.quote_id || (o && o.quoteId) || null, code: "", title: t.title || "a task", start: new Date(iv.s).toISOString(), end: new Date(iv.e).toISOString(), about: iv.about, same_event: true }; }
  // this event's loaded tasks + the other items given in the same go (equal starts in one go are no question: the sheet says it in a line)
  function local(items, o) {
    o = o || {}; var ex = {}, by = links(o.tasks, items); (o.exclude || []).forEach(function (x) { ex[String(x)] = 1; });
    return (items || []).map(function (it, i) {
      var a = it && it.crew_id ? interval(it) : null; if (!a) return [];
      var r = (o.tasks || []).filter(function (t) { return counts(t) && !ex[String(t.id)] && !same(t.id, it.id) && same(t.crew_id, it.crew_id) && overlap(a, interval(t)) && !chained(by, it, t); }).map(function (t) { return clashOf(t, o); });
      (items || []).forEach(function (x, k) { var b = k !== i && x && same(x.crew_id, it.crew_id) ? interval(x) : null; if (b && b.s !== a.s && overlap(a, b) && !(x.id != null && it.id != null && chained(by, it, x))) r.push(clashOf({ id: x.id, title: x.title, start: x.start, end: x.end, duration_min: x.duration_min, quote_id: o.quoteId }, o)); });
      return r;
    });
  }
  function perItem(r, n) {   // the RPC's answer: [[...]] or [{ i | item, clashes }] or { items: ... }
    var a = Array.isArray(r) ? r : r && Array.isArray(r.items) ? r.items : [], out = []; for (var i = 0; i < n; i++) out.push([]);
    a.forEach(function (x, k) { if (Array.isArray(x)) { if (k < n) out[k] = x; return; } if (!x) return; var at = x.i != null ? x.i : x.item != null ? x.item : x.index != null ? x.index : k; if (at >= 0 && at < n && Array.isArray(x.clashes)) out[at] = x.clashes; });
    return out;
  }
  function api() { return global.BPStore && global.BPStore.ops && typeof global.BPStore.ops.timeClashes === "function" ? global.BPStore.ops.timeClashes : null; }
  // other events only (this event is worked out from what is loaded). -> { rows, failed, old }
  function remote(items, o) {
    var f = api(), n = items.length, out = items.map(function () { return []; }), at = []; if (!f) return Promise.resolve({ rows: out, failed: false, old: true });
    var req = []; items.forEach(function (it, i) { var iv = it && it.crew_id ? interval(it) : null; if (iv) { at.push(i); req.push({ crew_id: it.crew_id, start: new Date(iv.s).toISOString(), end: new Date(iv.e).toISOString(), depends_on: it.depends_on || null, id: it.id || null, quote_id: (o && o.quoteId) || it.quote_id || null }); } });
    if (!req.length) return Promise.resolve({ rows: out, failed: false });
    var ex = (o && o.exclude ? o.exclude.slice() : []); if (o && o.tasks) o.tasks.forEach(function (t) { if (t && ex.length < 500 && ex.indexOf(t.id) < 0) ex.push(t.id); });   // this event's own tasks never use up the 5 places
    var jobs = []; for (var k = 0; k < req.length; k += BATCH) (function (from) { jobs.push(Promise.resolve().then(function () { return f(req.slice(from, from + BATCH), ex); }).then(function (r) { if (r === null) return "old"; perItem(r, Math.min(BATCH, req.length - from)).forEach(function (c, j) { out[at[from + j]] = (c || []).filter(function (x) { return x && !x.same_event; }); }); return ""; }, function () { return "failed"; })); })(k);
    return Promise.all(jobs).then(function (r) { return { rows: out, failed: r.indexOf("failed") >= 0, old: r.indexOf("old") >= 0 }; });
  }
  function find(items, o) {
    items = (items || []).filter(function (i) { return i && i.crew_id && isFinite(ms(i.start)); }); if (!items.length) return Promise.resolve({ rows: [], items: items, any: false, failed: false });
    var mine = local(items, o);
    return remote(items, o).then(function (r) { var rows = mine.map(function (a, i) { return a.concat(r.rows[i]); }); return { rows: rows, items: items, any: rows.some(function (x) { return x.length; }), failed: r.failed }; });
  }
  /* ---- words ---- */
  function tz() { try { return global.BPStore.studioTimezone(); } catch (e) { return "Asia/Kolkata"; } }
  function loc() { try { return global.BPStore.studioLocale() || "en-IN"; } catch (e) { return "en-IN"; } }
  function fmt(t, o) { try { return new Intl.DateTimeFormat(loc(), Object.assign({ timeZone: tz() }, o)).format(new Date(t)); } catch (e) { return new Date(t).toISOString().slice(11, 16); } }
  function hm(t) { return fmt(t, { hour: "numeric", minute: "2-digit" }); }
  function day(t) { return fmt(t, { weekday: "short", day: "numeric", month: "short" }); }
  // "5:00-7:00 pm", "11:30 pm-1:00 am", "5:00-about 6:00 pm"; + the day when it is not the day asked about
  function span(c, ref) {
    var s = ms(c.start), e = ms(c.end), a = hm(s), b = hm(e), ap = / ?([ap]\.?m\.?)$/i, x = ap.exec(a), y = ap.exec(b);
    if (x && y && x[1].toLowerCase() === y[1].toLowerCase()) a = a.replace(ap, "");
    return (isFinite(ms(ref)) && day(ms(ref)) !== day(s) ? day(s) + ", " : "") + a + "-" + (c.about ? "about " : "") + b;
  }
  function eventOf(c) { return c.same_event ? "this event" : c.event_title || c.code || ""; }
  function what(c, ref) { return [c.same_event || c.title ? c.title || "a task" : "other work", eventOf(c), span(c, ref)].filter(Boolean).join(", "); }
  // every clash once, with the person
  function list(f, o) {
    var seen = {}, out = []; f.items.forEach(function (it, i) { (f.rows[i] || []).forEach(function (c) { var k = it.crew_id + "|" + (c.task_id || c.start + c.end); if (seen[k]) return; seen[k] = 1; out.push({ who: it.name || (o && o.nameOf && o.nameOf(it.crew_id)) || "This person", c: c, ref: it.start }); }); });
    return out;
  }
  function text(f, o) {
    var l = list(f, o), q = (o && o.question) || "Give this one too?"; if (!l.length) return "";
    var one = l.every(function (x) { return x.who === l[0].who; });
    if (l.length === 1) return l[0].who + " already has " + what(l[0].c, l[0].ref) + ". " + q;
    return (one ? l[0].who + " already has: " : "At the same time: ") + l.slice(0, MAX).map(function (x) { return (one ? "" : x.who + " has ") + what(x.c, x.ref); }).join("; ") + (l.length > MAX ? "; and " + (l.length - MAX) + " more" : "") + ". " + q;
  }
  function say(o, t) { try { if (o && o.toast) o.toast(t); else global.BPUI.toast(t, { type: "info" }); } catch (e) {} }
  function put(f, o) { return Promise.resolve(global.BPUI.confirm(text(f, o), { title: "Two works at the same time", okLabel: (o && o.ok) || "Give it anyway", cancelLabel: (o && o.cancel) || "Not now" })).then(function (v) { return v === true; }); }
  function checked(items, o) { return find(items, o).catch(function () { return { rows: [], items: [], any: false, failed: true }; }); }
  function ask(items, o) { return checked(items, o).then(function (f) { if (f.failed) say(o, "Couldn’t check other events."); return f.any ? put(f, o) : true; }); }
  // dayCheck() -> the old wouldClash answer; o.dayText(clash) -> its question. The time clash wins for the same event
  function give(items, o, dayCheck) {
    return checked(items, o).then(function (f) {
      if (f.failed) say(o, "Couldn’t check other events.");
      return (f.any ? put(f, o) : Promise.resolve(true)).then(function (ok) {
        if (!ok) return false; if (!dayCheck) return true;
        return Promise.resolve().then(dayCheck).catch(function () { return null; }).then(function (c) {
          if (!c || !c.clash) return true; var d = String(c.detail || "");
          if (c.type === "staff" && f.rows.some(function (r) { return r.some(function (x) { return x.code && d.indexOf(x.code) >= 0; }); })) return true;
          return Promise.resolve(global.BPUI.confirm(o.dayText(c), { title: "Scheduling clash", okLabel: o.dayOk || "Assign anyway", danger: true })).then(function (v) { return v === true; });
        });
      });
    });
  }
  /* ---- the sheet's person list ---- */
  function people(ids, start, o) {
    var items = (ids || []).map(function (id) { return { crew_id: id, start: start, duration_min: o && o.duration_min, depends_on: (o && o.depends_on) || null }; });
    return find(items, o).then(function (f) { var m = {}; f.items.forEach(function (it, i) { var c = f.rows[i][0]; if (c) m[it.crew_id] = "same time: " + (c.same_event ? c.title : eventOf(c) || "other work") + " " + span(c, start); }); return m; });
  }
  /* ---- the tags of one event ---- */
  var BD = {};
  // o: { quoteId, tasks, onChange } -> { byTask: { id: text }, people: n, crew: {id:1} }; other events at most once a minute, when the tasks' times changed at once
  function board(o) {
    var act = (o.tasks || []).filter(function (t) { return counts(t) && interval(t); }), q = o.quoteId, b = BD[q] || (BD[q] = { at: 0, sig: "", rows: {}, busy: false });
    var items = act.map(function (t) { return { id: t.id, crew_id: t.crew_id, start: t.planned_start, end: t.planned_end, duration_min: t.duration_min, depends_on: t.depends_on || null, title: t.title }; });
    var mine = items.map(function (it) { return local([it], o)[0]; });
    var sig = JSON.stringify(items.map(function (i) { return [i.id, i.crew_id, i.start, i.end, i.duration_min]; }));
    if (items.length && !b.busy && (Date.now() - b.at > 60000 || (b.sig !== sig && Date.now() - b.at > 5000))) {
      b.busy = true; b.at = Date.now(); b.sig = sig;
      remote(items, o).then(function (r) { b.busy = false; var was = JSON.stringify(b.rows); if (!r.failed) { b.rows = {}; items.forEach(function (it, i) { if (r.rows[i].length) b.rows[it.id] = r.rows[i]; }); } if (was !== JSON.stringify(b.rows) && o.onChange) o.onChange(); });
    }
    var out = { byTask: {}, crew: {}, people: 0 };
    items.forEach(function (it, i) { var c = mine[i].concat((b.rows[it.id] || []).filter(function (x) { var iv = interval({ start: x.start, end: x.end }); return overlap(interval(it), iv); })); if (!c.length) return;
      out.byTask[it.id] = "Same time as " + (c[0].same_event ? c[0].title : [c[0].title || "other work", eventOf(c[0])].filter(Boolean).join(", ")) + (c.length > 1 ? " +" + (c.length - 1) : ""); out.crew[it.crew_id] = 1; });
    out.people = Object.keys(out.crew).length; return out;
  }
  // several tasks in one go, one start, one person: a quiet line, no question
  function sameStartLine(n, start, who, chain) { return n > 1 && !chain && isFinite(ms(start)) && who ? "All " + n + " start at " + hm(ms(start)) + " for " + who + " - tick One after another, or change the times later." : ""; }

  /* R257: the same task given to the same person (or vendor) twice on one event -> the words that are there already ([] = none). who = { crew } | { vendor };
     skip = task ids that do not count (the ones being given now). Cancelled and turned down ones do not count. */
  function already(tasks, who, titles, skip) {
    function k(v) { return String(v == null ? "" : v).trim().toLowerCase().replace(/\s+/g, " "); }
    var sk = {}, out = []; (skip || []).forEach(function (i) { sk[String(i)] = 1; });
    (titles || []).forEach(function (t) {
      if (k(t) && out.indexOf(t) < 0 && (tasks || []).some(function (x) { return x && !sk[String(x.id)] && x.status !== "cancelled" && x.status !== "rejected" && k(x.title) === k(t) && (who && who.vendor ? String(x.vendor_id || "") === String(who.vendor) : !x.vendor_id && who && who.crew && String(x.crew_id || "") === String(who.crew)); })) out.push(t);
    });
    return out;
  }
  // asks, never blocks: "Suresh already has Build stage and dance floor here - give it again?"
  function askSame(tasks, who, name, titles, skip) {
    var l = already(tasks, who, titles, skip); if (!l.length || !global.BPUI || !global.BPUI.confirm) return Promise.resolve(true);
    return Promise.resolve(global.BPUI.confirm(String(name || "They").split(/\s+/)[0] + " already has " + (l.length < 3 ? l.join(" and ") : l.slice(0, 2).join(", ") + " and " + (l.length - 2) + " more") + " here - give " + (l.length === 1 ? "it" : "them") + " again?", { title: "Already given", okLabel: "Give again", cancelLabel: "Not now" })).then(Boolean, function () { return true; });
  }
  var A = { already: already, askSame: askSame, find: find, ask: ask, give: give, people: people, board: board, sameStartLine: sameStartLine, _pure: { interval: interval, counts: counts, overlap: overlap, waitsFor: waitsFor, local: local, perItem: perItem, span: span, text: text, remote: remote }, _reset: function () { BD = {}; } };
  global.HelmTaskClash = A; if (typeof module !== "undefined" && module.exports) module.exports = A;
})(typeof window !== "undefined" ? window : globalThis);
