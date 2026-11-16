/* staff-home.js - R172 (0363): the staff member's PERMANENT task link (work.html?staff=<64 hex>).
   One link per staff member (the office copies it from the Staff page or the Operations worker links; it is also in every
   task e-mail). It shows that person's open tasks on all their upcoming events, grouped by event, and each event opens
   the existing per-event task page (work.html?token=...) where they accept / start / mark done - the same checked worker
   functions as before. The server (staff_link_view) answers only for a live link of an active staff member, rate limited.
   Nothing is kept in the browser. DOM API only (no HTML strings). */
(function (global) {
  "use strict";
  if (typeof document === "undefined") return;
  var doc = document;
  var raw = null;
  try { raw = new URLSearchParams(global.location.search).get("staff"); } catch (e) { raw = null; }
  var TOKEN = raw && /^[0-9a-f]{64}$/.test(raw) ? raw : null;
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
  function when(t) { var s = String((t && t.start) || ""), d = String((t && t.day) || ""); return s ? (d ? s + " on " + d : s) : (d ? "on " + d : ""); }

  function render(v) {
    show("#loading", false); show("#badlink", false); show("#offlineFirst", false); show("#prog", false);
    show("#content", true);
    var title = $("#title"), sub = $("#sub"), host = $("#tasks");
    if (title) title.textContent = "Your tasks" + (v.studio ? " - " + String(v.studio) : "");
    if (sub) {
      clear(sub);
      sub.appendChild(doc.createTextNode("Hi "));
      sub.appendChild(h("b", { text: String(v.name || "there") }));
      sub.appendChild(doc.createTextNode(" - this link always shows your current tasks. Open an event to accept, start and finish them."));
    }
    clear(host);
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
        card.appendChild(h("div", { cls: "task" }, [
          h("span", { cls: "st " + (STATUS[st] ? st : "assigned"), text: STATUS[st] || "New" }),
          h("div", { cls: "tt", text: String(t.title || "Task") }),
          when(t) ? h("div", { cls: "rsl", text: "Starts " + when(t) }) : null,
          t.category ? h("div", { cls: "muted", text: String(t.category) }) : null,
        ]));
      });
      if (e.link && /^[0-9a-f-]{36}$/i.test(String(e.link))) {
        card.appendChild(h("div", { cls: "acts" }, [
          h("a", { cls: "btn primary", href: "work.html?token=" + encodeURIComponent(String(e.link)), text: "Open this event to accept / start / finish" }),
        ]));
      } else {
        card.appendChild(h("p", { cls: "muted", text: "Ask the office for this event's task link to mark your progress." }));
      }
      host.appendChild(card);
    });
  }

  async function start() {
    if (!TOKEN) { bad(); return; }
    try {
      await global.BPStore.init();
      var v = await global.BPStore.ops.worker.staffHome(TOKEN);
      if (!v || v.ok !== true) { bad(); return; }
      render(v);
    } catch (e) {
      if (global.navigator && global.navigator.onLine === false) { show("#loading", false); show("#offlineFirst", true); return; }
      var m = String((e && e.message) || "");
      if (/too many requests/i.test(m)) bad("Please wait a moment", "Too many requests from your network. Please wait a few minutes and try again.");
      else bad();
    }
  }

  global.HelmStaffHome = { wants: function () { return raw !== null; }, start: start };
})(typeof window !== "undefined" ? window : globalThis);
