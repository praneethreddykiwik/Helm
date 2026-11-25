/* staff-home.js - R172 (0363): the staff member's PERMANENT task link (work.html?staff=<64 hex>).
   One link per staff member (the office copies it from the Staff page or the Operations worker links; it is also in every
   task e-mail). It shows that person's open tasks on all their upcoming events, grouped by event.
   R179 (0367): an event opens INSIDE the same permanent link - work.html?staff=<link>&event=<event id> - with an
   "All my tasks" button back; the page then uses that event's own task link behind the scenes, so accept / start / mark
   done are the same checked worker functions as before (the person never gets a second link to keep). Before 0367 (no
   event id in the answer) the event opens its own task page as before.
   The server (staff_link_view) answers only for a live link of an active staff member, rate limited.
   R187 (0370): above the events, the office's answers to the person's day-off requests (approved / not approved, with
   the office's note) until they tap "OK, got it" (staff_link_cantwork / staff_link_cantwork_ack), and the days still
   waiting for approval. Hidden before 0370.
   Nothing is kept in the browser. DOM API only (no HTML strings). */
(function (global) {
  "use strict";
  if (typeof document === "undefined") return;
  var doc = document;
  var raw = null;
  try { raw = new URLSearchParams(global.location.search).get("staff"); } catch (e) { raw = null; }
  var TOKEN = raw && /^[0-9a-f]{64}$/.test(raw) ? raw : null;
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var evRaw = null;
  try { evRaw = new URLSearchParams(global.location.search).get("event"); } catch (e) { evRaw = null; }
  var EVENT = TOKEN && evRaw && UUID.test(evRaw) ? evRaw.toLowerCase() : null;
  function homeHref() { return "work.html?staff=" + encodeURIComponent(TOKEN || ""); }
  function eventHref(id) { return homeHref() + "&event=" + encodeURIComponent(String(id)); }
  var STATUS = { assigned: "New", accepted: "Accepted", in_progress: "In progress" };

  function $(s) { return doc.querySelector(s); }
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
  function show(id, on) { var n = $(id); if (n) n.hidden = !on; }
  function bad(title, sub) {
    show("#loading", false); show("#content", false);
    var b = $("#badlink"); if (!b) return;
    var t = b.querySelector("h1"), s = b.querySelector(".sub");
    if (t) t.textContent = title || "This link isn't available";
    if (s) s.textContent = sub || "Please ask the person who sent it to you for a new one.";
    b.hidden = false;
  }
  // R243 (P11 LOC-04): "12 Nov 2026" - the same on the task link (crew-self.js) and in the e-mails, in every country
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function fmtDay(s) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || "")); return m && +m[2] >= 1 && +m[2] <= 12 ? (+m[3]) + " " + MON[+m[2] - 1] + " " + m[1] : ""; }
  function weekday(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || "")); if (!m) return "";
    try { return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)).toLocaleDateString("en-IN", { weekday: "short", timeZone: "UTC" }); } catch (e) { return ""; }
  }
  // R187: day-off answers + days waiting (null / error = nothing shown)
  async function renderCantwork(host) {
    var W = global.BPStore && global.BPStore.ops && global.BPStore.ops.worker;
    if (!W || !W.staffCantwork || !host) return;
    var v = null; try { v = await W.staffCantwork(TOKEN); } catch (e) { v = null; }
    var old = $("#staffCantwork"); if (old && old.parentNode) old.parentNode.removeChild(old);
    if (!v || v.ok !== true) return;
    var dec = (Array.isArray(v.decisions) ? v.decisions : []).filter(function (x) { return x && (x.approval === "approved" || x.approval === "rejected"); });
    var wait = Array.isArray(v.waiting) ? v.waiting : [];
    if (!dec.length && !wait.length) return;
    var card = h("div", { cls: "card staff-ev", id: "staffCantwork" }, [h("h1", { text: "Your days off" })]);
    dec.forEach(function (x) {
      var ok = x.approval === "approved", d = String(x.day).slice(0, 10);
      var row = h("div", { cls: "task" }, [
        h("span", { cls: "st " + (ok ? "accepted" : "rejected"), text: ok ? "Approved" : "Not approved" }),
        h("div", { cls: "tt", text: weekday(d) + " " + fmtDay(d) }),
        h("div", { cls: "rsl", text: ok ? "You have this day off." : "Please plan to work this day - call your manager if you can't." }),
        x.decision_note ? h("div", { cls: "rsl", text: "Note from the office: " + String(x.decision_note) }) : null,
      ]);
      var got = h("button", { type: "button", cls: "btn primary", text: "OK, got it" });
      got.addEventListener("click", async function () {
        got.disabled = true;
        try { await W.staffCantworkAck(TOKEN, d); await renderCantwork(host); }
        catch (e) { got.disabled = false; try { global.BPUI.toast("Couldn't save that - try again.", { type: "err" }); } catch (x2) {} }
      });
      row.appendChild(h("div", { cls: "acts" }, [got]));
      card.appendChild(row);
    });
    if (wait.length) card.appendChild(h("p", { cls: "sub", text: "Waiting for the office to approve: " + wait.map(function (w) { var d = String(w.day).slice(0, 10); return weekday(d) + " " + fmtDay(d); }).join(", ") }));
    host.insertBefore(card, host.firstChild);
  }
  function when(t) { var s = String((t && t.start) || ""), d = String((t && t.day) || ""); return s ? (d ? s + " on " + d : s) : (d ? "on " + d : ""); }

  function render(v) {
    show("#loading", false); show("#badlink", false); show("#offlineFirst", false); show("#prog", false);
    show("#content", true);
    var title = $("#title"), sub = $("#sub"), host = $("#tasks");
    if (title) title.textContent = "Your tasks" + (v.studio ? " - " + String(v.studio) : "");
    if (global.BPStore && global.BPStore.paintStudio) global.BPStore.paintStudio(v.studio);   // R257: the studio's name in the header
    if (sub) {
      clear(sub);
      sub.appendChild(doc.createTextNode("Hi "));
      sub.appendChild(h("b", { text: String(v.name || "there") }));
      sub.appendChild(doc.createTextNode(" - this link always shows your current tasks on today's and upcoming events. Open an event to accept, start and finish them. Keep this one link - it never changes."));
    }
    clear(host);
    renderCantwork(host).catch(function () {});
    var events = Array.isArray(v.events) ? v.events : [];
    if (!events.length) {
      host.appendChild(h("div", { cls: "card" }, [h("p", { cls: "sub", text: "You have no open tasks right now. New work will show up here." })]));
      return;
    }
    events.forEach(function (e) {
      var head = [h("h1", { text: String(e.event || "Event") })];
      var line = [e.date, e.time, e.venue].filter(Boolean).map(String).join(" - ");
      if (line) head.push(h("p", { cls: "sub", text: line }));
      var card = h("div", { cls: "card staff-ev" }, head);
      (Array.isArray(e.tasks) ? e.tasks : []).forEach(function (t) {
        var st = String(t.status || "assigned");
        var box = h("div", { cls: "task" }, [
          h("span", { cls: "st " + (STATUS[st] ? st : "assigned"), text: STATUS[st] || "New" }),
          h("div", { cls: "tt", text: String(t.title || "Task") }),
          when(t) ? h("div", { cls: "rsl", text: "Starts " + when(t) }) : null,
          t.category ? h("div", { cls: "muted", text: String(t.category) }) : null,
        ]);
        // R253 (0436): what it waits for / "You can start now"
        if (global.HelmTaskWaits) global.HelmTaskWaits.decorate(box, t.waits_for, st);
        card.appendChild(box);
      });
      if (e.quote_id && UUID.test(String(e.quote_id))) {
        // R179: open the event inside this same permanent link
        card.appendChild(h("div", { cls: "acts" }, [
          h("a", { cls: "btn primary", href: eventHref(e.quote_id), text: "Open this event to accept / start / finish" }),
        ]));
      } else if (e.link && /^[0-9a-f-]{36}$/i.test(String(e.link))) {
        card.appendChild(h("div", { cls: "acts" }, [
          h("a", { cls: "btn primary", href: "work.html?token=" + encodeURIComponent(String(e.link)), text: "Open this event to accept / start / finish" }),
        ]));
      } else {
        card.appendChild(h("p", { cls: "muted", text: "Ask the office for this event's task link to mark your progress." }));
      }
      host.appendChild(card);
    });
  }

  // R253: read again when the person comes back to this tab (at most every 15 s, no timer)
  var lastRead = 0, reading = false, wired = false;
  function wireReturn() {
    if (wired) return; wired = true;
    doc.addEventListener("visibilitychange", function () {
      if (doc.hidden || reading || EVENT || Date.now() - lastRead < 15000) return;
      reading = true; lastRead = Date.now();
      Promise.resolve(global.BPStore.ops.worker.staffHome(TOKEN)).then(function (v) { if (v && v.ok === true) render(v); }, function () {}).then(function () { reading = false; });
    });
  }
  async function start() {
    if (!TOKEN) { bad(); return; }
    try {
      await global.BPStore.init();
      lastRead = Date.now();
      var v = await global.BPStore.ops.worker.staffHome(TOKEN);
      if (!v || v.ok !== true) { bad(); return; }
      render(v); if (!EVENT) wireReturn();
    } catch (e) {
      if (global.navigator && global.navigator.onLine === false) { show("#loading", false); show("#offlineFirst", true); return; }
      var m = String((e && e.message) || "");
      if (/too many requests/i.test(m)) bad("Please wait a moment", "Too many requests from your network. Please wait a few minutes and try again.");
      else bad();
    }
  }

  // R179: work.html?staff=<link>&event=<id> -> that event's task link (used behind the scenes by work.html), or null
  async function resolveEvent() {
    if (!TOKEN || !EVENT) return null;
    await global.BPStore.init();
    var v = await global.BPStore.ops.worker.staffHome(TOKEN);
    if (!v || v.ok !== true) return null;
    var ev = (Array.isArray(v.events) ? v.events : []).find(function (e) { return String(e.quote_id || "").toLowerCase() === EVENT; });
    return ev && ev.link && UUID.test(String(ev.link)) ? String(ev.link) : null;
  }
  // the "All my tasks" button above the event view
  function backBar() {
    var host = $("#content"); if (!host || $("#staffBack")) return;
    var bar = h("div", { cls: "backbar", id: "staffBack" }, [
      h("a", { cls: "btn back", href: homeHref(), text: "\u2190 All my tasks" }),
      h("span", { cls: "muted", text: "Same link for all your events - keep it." }),
    ]);
    host.insertBefore(bar, host.firstChild);
  }
  global.HelmStaffHome = {
    wants: function () { return raw !== null; },
    inEvent: function () { return !!EVENT; },
    start: start, resolveEvent: resolveEvent, backBar: backBar,
  };
})(typeof window !== "undefined" ? window : globalThis);
