/* task-waits.js - R253 (0434 / 0436): what a task waits for, on the staff member's own task pages (work.html task link, the permanent
 * link staff-home.js, "My tasks for this event" on the run-sheet).
 *   waits_for = null | { title, done, state: "waiting"|"rework"|"done"|"cancelled", done_at } (state is missing before 0436: done decides)
 *   HelmTaskWaits.info(w, status)        null | { kind: "waiting"|"rework"|"released", text }
 *   HelmTaskWaits.decorate(card, w, st)  adds the line as the last line above the buttons and marks the card
 *   HelmTaskWaits.okToStart(w, action)   Promise<boolean>: asks "Stage set-up is not done yet. Start anyway?" before Start, only then
 * Never blocks a start. DOM by createElement / textContent only. No reads, no timers. */
(function (global) {
  "use strict";
  var doc = global.document;
  function name(w) { return String((w && w.title) || "another task").slice(0, 120); }
  function info(w, status) {
    if (!w || typeof w !== "object" || !w.title) return null;
    var st = String(status || ""), s = w.state || (w.done ? "done" : "waiting");
    if (st !== "unassigned" && st !== "assigned" && st !== "accepted" && st !== "in_progress") return null;
    if (s === "rework") return { kind: "rework", text: name(w) + " needs rework - please hold" };
    if (s === "waiting") return { kind: "waiting", text: "Waits for " + name(w) + " (not done yet)" };
    if (st === "in_progress") return null;
    return { kind: "released", text: "You can start now - " + name(w) + (s === "cancelled" ? " was cancelled" : " is done") };
  }
  function decorate(card, w, status) {
    var i = info(w, status); if (!card || !doc) return i;
    var old = card.querySelector(".tw-line"); if (old) old.remove();
    card.classList.remove("tw-waiting", "tw-rework", "tw-released");
    if (!i) return null;
    card.classList.add("tw-" + i.kind);
    var n = doc.createElement("div"); n.className = "tw-line"; n.textContent = i.text;
    var what = card.querySelector(".what"), acts = card.querySelector(".acts");
    if (what) what.appendChild(n); else if (acts && acts.parentNode === card) card.insertBefore(n, acts); else card.appendChild(n);
    return i;
  }
  function okToStart(w, action, status) {
    if (action !== "start") return Promise.resolve(true);
    var i = info(w, status || "accepted");
    if (!i || i.kind === "released") return Promise.resolve(true);
    var msg = i.kind === "rework" ? name(w) + " needs rework. Start anyway?" : name(w) + " is not done yet. Start anyway?";
    if (global.BPUI && typeof global.BPUI.confirm === "function")
      return Promise.resolve(global.BPUI.confirm(msg, { title: "This task waits for another one", okLabel: "Start anyway", cancelLabel: "Not yet" })).then(function (v) { return v === true; });
    return Promise.resolve(global.confirm ? global.confirm(msg) : true);
  }
  var api = { info: info, decorate: decorate, okToStart: okToStart };
  global.HelmTaskWaits = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
