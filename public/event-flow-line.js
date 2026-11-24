/* event-flow-line.js - R252 (owner, 24 Nov 2026: "everything should be syncing to the workflow of the quotation"): small shared parts
 * of the event pages Logistics, Resource plan, Run-sheet, Event-day command, Teardown, Settlement and Closure.
 *
 *   HelmFlowLine.stage(ev)            the event's stage in words ("Event Day", "Cancelled", "Closed"): the same names as the event
 *                                     workspace's strip; a client-approved quote still stored as Quote reads Confirmed there and here
 *   HelmFlowLine.mount(host, ev, o)   fills host (an empty span in the page's crumb line) with "Stage: X" and, when o.dayBefore,
 *                                     a link to the Day-before checks (Event Ready, else Tasks & Crew; no link when neither is allowed)
 *   HelmFlowLine.onReturn(fn, busy)   reads again when the person comes back to the page (another tab, the Back button), at most
 *                                     every 15 s, and never while busy() says they are in the middle of something. fn only READS.
 *   HelmFlowLine.inUse(root)          a dialog is open, a box is being typed in, or a box inside root holds something not saved
 * DOM by createElement / textContent only; no reads of its own except the two permission questions of mount. */
(function (global) {
  "use strict";
  var doc = global.document, GAP = 15000;
  var ORDER = ["lead", "discovery", "proposal", "quote", "confirmed", "planning", "resources", "ready", "event_day", "settlement", "closed"];
  var LABEL = { lead: "Lead", discovery: "Discovery", proposal: "Proposal", quote: "Quote", confirmed: "Confirmed", planning: "Planning",
    resources: "Resources", ready: "Ready", event_day: "Event Day", settlement: "Settlement", closed: "Closed" };
  function stage(ev) {
    if (!ev) return "";
    if (ev.status === "cancelled") return "Cancelled";
    var k = ev.lifecycleStage || "quote";
    if (k === "closed" || ev.closedAt) return "Closed";
    if (ORDER.indexOf(k) < ORDER.indexOf("confirmed")) {
      try { if (global.BPStore && global.BPStore.quoteStatus(ev).confirmed) k = "confirmed"; } catch (e) {}
    }
    return LABEL[k] || "";
  }
  function ask(area) {   // unknown = no
    var A = global.BPStore && global.BPStore.auth; if (!A || !A.canView) return Promise.resolve(false);
    return Promise.resolve().then(function () { return A.canView(area); }).then(function (v) { return v === true; }, function () { return false; });
  }
  // where the Day-before checks are for this person: "" = nowhere
  function dayBeforeHref(id) {
    return Promise.all([ask("ready"), ask("staff")]).then(function (r) {
      var q = "?quote=" + encodeURIComponent(id || "");
      return r[0] && r[1] ? "ready.html" + q + "#rdDay" : r[1] ? "ops.html" + q : r[0] ? "ready.html" + q : "";
    });
  }
  function mount(host, ev, o) {
    if (!host || !doc) return Promise.resolve(); o = o || {};
    while (host.firstChild) host.removeChild(host.firstChild);
    var s = stage(ev), sp;
    if (s) { sp = doc.createElement("span"); sp.className = "efl-stage"; sp.textContent = "Stage: " + s; host.appendChild(doc.createTextNode(" · ")); host.appendChild(sp); }
    if (!o.dayBefore || s === "Cancelled" || s === "Closed") return Promise.resolve();
    return dayBeforeHref(ev && ev.id ? ev.id : o.id).then(function (href) {
      if (!href) return; var a = doc.createElement("a"); a.className = "efl-link"; a.href = href; a.textContent = "Day before checks →";
      host.appendChild(doc.createTextNode(" · ")); host.appendChild(a);
    });
  }
  function shown(n) { return !!(n && n.getClientRects && n.getClientRects().length); }
  function inUse(root) {
    if (!doc) return false;
    var a = doc.activeElement; if (a && a !== doc.body && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) return true;
    var d = doc.querySelectorAll('[role="dialog"],[role="alertdialog"]'), i;
    for (i = 0; i < d.length; i++) if (!d[i].hidden && shown(d[i])) return true;
    var f = root && root.querySelectorAll ? root.querySelectorAll("input,textarea") : [];
    for (i = 0; i < f.length; i++) {
      if (f[i].type === "checkbox" || f[i].type === "radio") continue;
      if (shown(f[i]) && f[i].value !== f[i].defaultValue) return true;
    }
    return false;
  }
  function onReturn(fn, busy) {
    if (!doc || !doc.addEventListener) return; var last = Date.now(), running = false;
    function go() {
      if (doc.hidden || running || Date.now() - last < GAP) return;
      try { if (busy && busy()) return; } catch (e) { return; }
      last = Date.now(); running = true;
      Promise.resolve().then(fn).catch(function () {}).then(function () { running = false; });
    }
    doc.addEventListener("visibilitychange", go);
    if (global.addEventListener) global.addEventListener("pageshow", function (e) { if (e && e.persisted) { last = 0; go(); } });
  }
  var api = { stage: stage, mount: mount, dayBeforeHref: dayBeforeHref, onReturn: onReturn, inUse: inUse };
  global.HelmFlowLine = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
