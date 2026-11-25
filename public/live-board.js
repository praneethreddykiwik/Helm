/* live-board.js - R174 (owner, 16 Nov 2026: "how do I see the progress on the event day; add an ongoing events tracker on
 * the home page"). One small module, three uses:
 *   HelmLiveBoard.mountToday(el, opts)   events happening today / in the next hours, each with task progress
 *                                         (home page card: opts.compact; Calendar "Live today" tab: full)
 *   HelmLiveBoard.mountOps(el, getTasks)  the progress summary above an event's "Live status" (Tasks & staff page)
 *   HelmLiveBoard.summarize(tasks, now)   pure counts (used by mountOps; unit-tested)
 * R181: both link to the full Event-day monitor page (monitor.html?quote=<id>).
 * Data: BPStore.ops.live.today(hours) -> live_events_today (0365): office roles only, own studio only.
 * Built with DOM calls only (textContent), never HTML strings, so nothing a client or worker typed can become markup.
 * Refreshes every 60 s while the page is visible. Before 0365 (null answer) the card / tab stay hidden. */
(function () {
  "use strict";
  var REFRESH_MS = 60000;
  var S = function () { return window.BPStore; };

  /* ---- tiny DOM helper: h("div", {cls, text, href, title, aria, data}, [children]) ---- */
  function h(tag, o, kids) {
    var n = document.createElement(tag); o = o || {};
    if (o.cls) n.className = o.cls;
    if (o.text != null) n.textContent = String(o.text);
    if (o.href) n.setAttribute("href", o.href);
    if (o.title) n.setAttribute("title", o.title);
    if (o.role) n.setAttribute("role", o.role);
    if (o.label) n.setAttribute("aria-label", o.label);
    if (o.live) n.setAttribute("aria-live", o.live);
    if (o.type) n.setAttribute("type", o.type);
    (kids || []).forEach(function (k) { if (k) n.appendChild(typeof k === "string" ? document.createTextNode(k) : k); });
    return n;
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }

  /* ---- time in the studio's time zone ---- */
  function tz() { try { var B = S(); return (B && B.studioTimezone && B.studioTimezone()) || undefined; } catch (e) { return undefined; } }
  function loc() { try { var B = S(); return (B && B.studioLocale && B.studioLocale()) || "en-IN"; } catch (e) { return "en-IN"; } }
  function fmtTime(ts) {
    var d = new Date(ts); if (!ts || isNaN(d.getTime())) return "";
    try { return new Intl.DateTimeFormat(loc(), { timeZone: tz(), hour: "numeric", minute: "2-digit" }).format(d); } catch (e) { return d.toLocaleTimeString(); }
  }
  function fmtDay(iso) {
    if (!iso) return "";
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso)); if (!m) return String(iso);
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
    try { return new Intl.DateTimeFormat(loc(), { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(d); } catch (e) { return String(iso).slice(0, 10); }
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
    var hh = Math.floor(m / 60), r = m % 60; return "in " + hh + " h" + (r ? " " + r + " min" : "");
  }
  var KIND = { completed: "finished", started: "started", accepted: "accepted", rejected: "turned down" };

  /* ---- pure counts for an event's task list (ops page) ---- */
  function summarize(tasks, now) {
    now = now || Date.now();
    var o = { total: 0, waiting: 0, accepted: 0, started: 0, done: 0, rejected: 0, unassigned: 0, late: 0, lateList: [], staff: 0, staffConfirmed: 0, last: null, nextStart: null };
    var crew = {}, conf = {};
    (tasks || []).forEach(function (t) {
      if (!t || t.status === "cancelled") return;
      o.total++;
      var st = t.status;
      if (st === "completed") o.done++; else if (st === "in_progress") o.started++; else if (st === "accepted") o.accepted++;
      else if (st === "assigned") o.waiting++; else if (st === "rejected") o.rejected++; else if (st === "unassigned") o.unassigned++;
      var who = t.assignee_name || "";
      var key = t.crew_id || t.assignee_phone || "";
      if (key) { crew[key] = 1; if (st === "accepted" || st === "in_progress" || st === "completed") conf[key] = 1; }
      var ps = t.planned_start ? new Date(t.planned_start).getTime() : NaN;
      if ((st === "assigned" || st === "accepted") && isFinite(ps)) {
        if (ps < now) { o.late++; o.lateList.push({ id: t.id, title: t.title, who: who, at: t.planned_start, status: st }); }
        else if (o.nextStart == null || ps < o.nextStart) o.nextStart = ps;
      }
      [["completed_at", "completed"], ["started_at", "started"], ["responded_at", st === "rejected" ? "rejected" : "accepted"]].forEach(function (p) {
        var v = t[p[0]] ? new Date(t[p[0]]).getTime() : NaN;
        if (isFinite(v) && (!o.last || v > o.last.t)) o.last = { t: v, kind: p[1], who: who, title: t.title };
      });
    });
    o.staff = Object.keys(crew).length; o.staffConfirmed = Object.keys(conf).length;
    o.lateList.sort(function (a, b) { return new Date(a.at) - new Date(b.at); });
    o.pct = o.total ? Math.round(o.done / o.total * 100) : 0;
    return o;
  }

  /* ---- shared pieces ---- */
  function bar(done, total) {
    var pct = total ? Math.round(done / total * 100) : 0;
    var fill = h("i", { cls: "lb-fill" }); fill.style.width = pct + "%";
    var b = h("div", { cls: "lb-bar", role: "progressbar", label: done + " of " + total + " tasks done" }, [fill]);
    b.setAttribute("aria-valuemin", "0"); b.setAttribute("aria-valuemax", String(total)); b.setAttribute("aria-valuenow", String(done));
    return h("div", { cls: "lb-prog" }, [b, h("span", { cls: "lb-pct", text: total ? (done + " of " + total + " done · " + pct + "%") : "No tasks yet" })]);
  }
  function stat(n, label, cls, title) {
    return h("span", { cls: "lb-stat" + (cls ? " " + cls : "") + (n ? "" : " lb-zero"), title: title || "" }, [h("b", { text: n }), " " + label]);
  }
  function stats(c) {
    return h("div", { cls: "lb-stats" }, [
      stat(c.done, "done", "lb-s-done", "Finished tasks"),
      stat(c.started, "started", "lb-s-started", "Being worked on now"),
      stat(c.accepted, "accepted", "lb-s-acc", "The person said yes but has not started"),
      stat(c.waiting, "not accepted yet", "lb-s-wait", "Assigned - the person has not accepted yet"),
      stat(c.late, "late", "lb-s-late", "Start time has passed and the task has not started"),
      c.rejected ? stat(c.rejected, "turned down", "lb-s-rej", "Turned down - give these to someone else") : null,
      c.unassigned ? stat(c.unassigned, "not assigned", "lb-s-wait", "Nobody is on these tasks yet") : null
    ]);
  }
  function lateBox(list, now, more) {
    if (!list || !list.length) return null;
    return h("div", { cls: "lb-late" }, [h("div", { cls: "lb-late-h", text: "⚠ Late - start time passed, not started" })].concat(list.map(function (l) {
      return h("div", { cls: "lb-late-row" }, [h("b", { text: l.title || "Task" }), h("span", { text: " · " + (l.who || "no one") }),
        h("span", { cls: "lb-muted", text: " · was due " + fmtTime(l.at) + " (" + ago(l.at, now) + ")" + (l.status === "assigned" ? " · not accepted yet" : "") })]);
    })).concat(more ? [h("div", { cls: "lb-muted", text: "+" + more + " more late" })] : []));
  }
  function lastLine(last, now) {
    if (!last || !last.at && !last.t) return null;
    var at = last.at || last.t;
    return h("div", { cls: "lb-last" }, [h("span", { cls: "lb-dot", text: "●" }), " Latest: ", h("b", { text: last.who || "Someone" }),
      " " + (KIND[last.kind] || last.kind || "updated") + " ", h("b", { text: last.title || "a task" }), h("span", { cls: "lb-muted", text: " · " + ago(at, now) })]);
  }

  /* ---- one event card (live_events_today row) ---- */
  function eventCard(ev, now, compact) {
    var link = "monitor.html?quote=" + encodeURIComponent(ev.quote_id);   /* R181: the full Event-day monitor page */
    var name = (ev.code ? ev.code : "") + (ev.title && ev.title !== ev.code ? " · " + ev.title : "");
    var when = [ev.is_today ? "Today" : fmtDay(ev.event_date), ev.event_time || "", ev.venue || ""].filter(Boolean).join(" · ");
    var pill = Number(ev.late) ? h("span", { cls: "lb-pill lb-pill-late", text: ev.late + " late" })
      : Number(ev.total) && Number(ev.done) === Number(ev.total) ? h("span", { cls: "lb-pill lb-pill-ok", text: "All done" })
      : ev.started ? h("span", { cls: "lb-pill lb-pill-on", text: "In progress" })
      : h("span", { cls: "lb-pill", text: ev.is_today ? "Today" : "Upcoming" });
    var head = h("div", { cls: "lb-head" }, [h("div", { cls: "lb-titles" }, [h("a", { cls: "lb-title", href: link, text: name || "Event" }),
      h("div", { cls: "lb-sub", text: when })]), pill]);
    var people = h("div", { cls: "lb-people" }, [
      h("span", { text: "👥 " + Number(ev.staff_confirmed || 0) + " of " + Number(ev.staff || 0) + " staff confirmed" }),
      Number(ev.checked_in) ? h("span", { text: " · 📍 " + Number(ev.checked_in) + " checked in today" }) : null,
      ev.next_start ? h("span", { text: " · ⏱ next start " + fmtTime(ev.next_start) + " (" + until(ev.next_start, now) + ")" }) : null
    ]);
    var lt = (ev.late_tasks || []).map(function (l) { return { title: l.title, who: l.who, at: l.planned_start, status: l.status }; });
    var kids = [head, bar(Number(ev.done || 0), Number(ev.total || 0)), stats({ done: +ev.done || 0, started: +ev.started || 0, accepted: +ev.accepted || 0,
      waiting: +ev.waiting || 0, late: +ev.late || 0, rejected: +ev.rejected || 0, unassigned: +ev.unassigned || 0 }), people];
    if (!compact) { kids.push(lateBox(lt, now, Math.max(0, (+ev.late || 0) - lt.length))); kids.push(lastLine(ev.last, now)); }
    else if (lt.length) kids.push(h("div", { cls: "lb-late-mini", text: "⚠ " + lt[0].title + " (" + (lt[0].who || "no one") + ") was due " + fmtTime(lt[0].at) + (lt.length > 1 ? " · +" + (lt.length - 1) + " more" : "") }));
    kids.push(h("div", { cls: "lb-foot" }, [h("a", { cls: "lb-open", href: link, text: "Open event-day monitor →" }),
      h("a", { cls: "lb-open lb-sec", href: "ops.html?quote=" + encodeURIComponent(ev.quote_id) + "#live", text: "Tasks & staff" })]));
    return h("article", { cls: "lb-ev" + (Number(ev.late) ? " lb-has-late" : ""), label: name }, kids);
  }

  /* ---- events today / next hours (home card + Calendar tab) ---- */
  function mountToday(el, opts) {
    opts = opts || {}; if (!el) return null;
    var timer = null, busy = false, stopped = false;
    function render(data) {
      clear(el);
      if (data == null) { el.hidden = true; if (opts.onHide) opts.onHide(); return; }
      el.hidden = false;
      var now = Date.now(), evs = (data.events || []);
      var title = opts.title || "Live today";
      var hd = h("div", { cls: "lb-top" }, [h("div", {}, [h(opts.compact ? "h3" : "h2", { cls: "lb-h", text: title }),
        h("div", { cls: "lb-muted", text: "Events happening today and in the next " + (data.hours || 24) + " hours · updates every minute" })]),
        h("button", { cls: "lb-refresh", type: "button", text: "↻ Refresh", label: "Refresh live progress" })]);
      hd.querySelector(".lb-refresh").addEventListener("click", function () { load(true); });
      el.appendChild(hd);
      if (!evs.length) {
        el.appendChild(h("div", { cls: "lb-empty" }, [h("b", { text: "Nothing on right now." }),
          h("div", { text: "When an event is today (or its tasks start in the next " + (data.hours || 24) + " hours), its progress shows here: who accepted, who started, what is done and what is late." })]));
        return;
      }
      var lateTot = evs.reduce(function (a, e) { return a + (+e.late || 0); }, 0);
      if (lateTot) el.appendChild(h("div", { cls: "lb-alert", role: "status", text: "⚠ " + lateTot + " task" + (lateTot === 1 ? " is" : "s are") + " late across " + evs.filter(function (e) { return +e.late; }).length + " event(s)." }));
      var list = h("div", { cls: "lb-list" + (opts.compact ? " lb-compact" : "") });
      (opts.compact ? evs.slice(0, opts.max || 4) : evs).forEach(function (ev) { list.appendChild(eventCard(ev, now, !!opts.compact)); });
      el.appendChild(list);
      if (opts.compact && evs.length > (opts.max || 4)) el.appendChild(h("a", { cls: "lb-all", href: "calendar.html?cv=live", text: "See all " + evs.length + " events →" }));
      else if (opts.compact) el.appendChild(h("a", { cls: "lb-all", href: "calendar.html?cv=live", text: "Open Live today →" }));
    }
    function load(manual) {
      if (busy || stopped) return Promise.resolve(); busy = true;
      var B = S(); if (!B || !B.ops || !B.ops.live) { busy = false; render(null); return Promise.resolve(); }
      return B.ops.live.today(opts.hours || 24).then(function (d) { render(d); }).catch(function (e) {
        if (opts.compact) { el.hidden = true; return; }   // the home card stays quiet on errors
        clear(el); el.hidden = false;
        if (window.BPUI && BPUI.loadError) BPUI.loadError(el, e, function () { load(true); }, { what: "live progress" });
        else el.appendChild(h("p", { cls: "lb-empty", text: "Could not load live progress." }));
      }).then(function () { busy = false; if (manual) { try { BPUI.toast("Live progress updated.", { type: "ok", timeout: 1500 }); } catch (e) {} } });
    }
    function tick() { if (!document.hidden) load(false); }
    timer = setInterval(tick, REFRESH_MS);
    document.addEventListener("visibilitychange", function () { if (!document.hidden && !stopped) load(false); });
    var ready = load(false);
    return { refresh: function () { return load(true); }, stop: function () { stopped = true; clearInterval(timer); }, ready: ready };
  }

  /* ---- an event's own progress summary (Tasks & staff page) ---- */
  function mountOps(el, getTasks) {
    if (!el) return null;
    function render() {
      var tasks = (getTasks && getTasks()) || [];
      clear(el);
      if (!tasks.length) { el.hidden = true; return; }
      el.hidden = false;
      var now = Date.now(), c = summarize(tasks, now);
      var qid = (tasks[0] && tasks[0].quote_id) || "";
      el.appendChild(h("div", { cls: "lb-top" }, [h("div", {}, [h("h3", { cls: "lb-h", text: "Event-day progress" }),
        h("div", { cls: "lb-muted", text: "Updates on its own" + (c.nextStart ? " · next start " + fmtTime(c.nextStart) + " (" + until(c.nextStart, now) + ")" : "") })]),
        qid ? h("a", { cls: "lb-open", href: "monitor.html?quote=" + encodeURIComponent(qid), text: "Open full monitor →", title: "By staff, by work, by status and what is left - one page" }) : null]));
      el.appendChild(bar(c.done, c.total));
      el.appendChild(stats(c));
      el.appendChild(h("div", { cls: "lb-people" }, [h("span", { text: "👥 " + c.staffConfirmed + " of " + c.staff + " people confirmed (accepted, started or done)" })]));
      el.appendChild(lateBox(c.lateList.slice(0, 6), now, Math.max(0, c.lateList.length - 6)) || h("span"));
      var ll = lastLine(c.last, now); if (ll) el.appendChild(ll);
    }
    render();
    return { refresh: render };
  }

  window.HelmLiveBoard = { mountToday: mountToday, mountOps: mountOps, summarize: summarize, _ago: ago, _until: until };
})();
