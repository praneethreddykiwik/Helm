/* stage-needs.js - R255: what a blocked stage still needs, in plain words, each with the way to do it. One list for the event workspace's
 * stage panel and Event Ready. The server says what is missing (lifecycle_stage_blockers / the HL409, HL428 refusal, 0198); this only words it.
 *
 *   HelmStageNeeds.list(gate, o) -> [{ text, label, href | act, quiet }]     no label = nothing to press
 *     o { id, code, date (YYYY-MM-DD or ""), dateText, plan (event_plan row), chosen, stale, canEditPlan, label (the stage) }
 *     act: "lock" (lock the menu) | "recheck" | "price" (the price change) | "date" (set the event date); quiet = not the filled button
 *   HelmStageNeeds.fromError(e)  -> the gates in a refused stage move, null when it was another error
 * Pure: no reads, no DOM. */
(function (global) {
  "use strict";
  function list(g, o) {
    if (!g) return []; o = o || {}; var q = encodeURIComponent(o.id || ""), quote = "quotes.html?focus=" + encodeURIComponent(o.code || o.id || ""), plan = o.plan || {};
    if (g.gate === "planning" && !g.stale) {
      var l = Array.isArray(g.needs) ? g.needs : String(g.message || "").replace(/^[^:]*:\s*/, "").split(/,\s*/);
      return l.filter(Boolean).map(function (n) {
        n = String(n);
        if (/menu/i.test(n)) {
          if (plan.menu_locked) return { text: "The menu is locked now.", label: "Check again", act: "recheck" };
          if (o.stale) return { text: "The menu is not locked, and it can't be until the client approves the new price.", label: "See the price change", act: "price" };
          if (!o.canEditPlan) return { text: "The menu is not locked yet. Someone who can change Venue & menu locks it.", label: "Open Venue & menu", href: "plan.html?quote=" + q + "#menu", quiet: true };
          if (!o.chosen) return { text: "No menu chosen yet. Pick a package or add dishes, then lock it.", label: "Choose the menu", href: "plan.html?quote=" + q + "#menu" };
          return { text: "The menu is not locked yet" + (plan.package ? " (" + plan.package + " is chosen)." : "."), label: "🔒 Lock the menu", act: "lock" };
        }
        if (/layout/i.test(n)) return { text: "No floor plan with items on it is saved yet.", label: "Draw the floor plan", href: "builder.html?quote=" + q };
        return { text: n.charAt(0).toUpperCase() + n.slice(1) + "." };
      });
    }
    if (g.stale) return [{ text: "The price changed after the client approved. The client must approve again.", label: "Open this quote", href: quote }];
    if (g.gate === "confirmed") return [{ text: "The client has not approved the quote yet.", label: "Open this quote", href: quote }];
    if (g.gate === "event_day" || g.gate === "settlement") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(o.date || ""))) return [{ text: "The event has no date yet.", label: "Set the event date", act: "date" }];
      return [{ text: (o.label || "This stage") + " opens on " + (o.dateText || o.date) + ", the event date. Nothing to do before then." }];
    }
    if (g.hard) return [];
    var m = String(g.message || "").trim(); return m ? [{ text: m.charAt(0).toUpperCase() + m.slice(1).replace(/\.$/, "") + "." }] : [];
  }
  function fromError(e) {
    var c = String((e && e.code) || ""); if (c !== "HL409" && c !== "HL428") return null;
    var a = null; try { a = JSON.parse(e.details || e.detail || ""); } catch (x) { a = null; }
    return Array.isArray(a) && a.length ? a : [{ gate: "other", message: String(e.message || "").replace(/^Can't move to [^-]*- /, "") }];
  }
  var api = { list: list, fromError: fromError };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else global.HelmStageNeeds = api;
})(typeof window !== "undefined" ? window : this);
