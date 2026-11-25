/* vendor-state.js - R261 (owner: "Mark as left is not syncing: everything should be in sync in all the places"): where a booked vendor is - not arrived,
 * here, left, did not come - read and written in ONE place, for the pages outside the event day (Teardown, Resource plan, Vendors). The event day
 * (event-wrap.js) uses the same two records and the same calls:
 *   the arrival row of Event-day command (dayops "arrival", ref_id = the booking), and the booking marked delivered (an older "all returned") = left.
 *   HelmVendorState.read(quoteId)        -> { list, arr } (bookings + arrival rows; arr null = no right to see them)
 *   HelmVendorState.of(booking, arr)     -> { state, at, arr, exited, text: "Left 11:23 pm" }
 *   HelmVendorState.move(q, booking, to) -> "ok" | "changed" | "nosave" ("left" | "arrived"; read again before and after, like event-wrap.js)
 * DOM-free; the database checks every right again. Unit-tested in test/r261-b.test.mjs. */
(function (global) {
  "use strict";
  var WORD = { expected: "Not arrived yet", arrived: "Here", left: "Left", no_show: "Did not come" };
  function same(a, b) { return String(a == null ? "" : a) === String(b == null ? "" : b); }
  function arrivalOf(arr, id) {
    return (arr || []).filter(function (x) { return x && x.ref_id && same(x.ref_id, id); }).sort(function (x, y) { return String(y.updated_at || y.created_at || "").localeCompare(String(x.updated_at || x.created_at || "")); })[0] || null;
  }
  function clock(iso) {
    var d = new Date(iso || ""); if (!iso || isNaN(d)) return "";
    var z = "Asia/Kolkata"; try { z = global.BPStore.studioTimezone() || z; } catch (e) {}
    try { var t = d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: z }), day = function (x) { return x.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: z }); };
      return day(d) === day(new Date()) ? t : day(d) + ", " + t; } catch (e) { return ""; }
  }
  // the newest record wins nothing here: left on either record = left; "did not come" stays what the event day said
  function of(b, arr) {
    var a = arrivalOf(arr, b && b.id), st = a && WORD[a.status] ? a.status : "expected", exited = !!b && b.status === "delivered";
    if (exited && st !== "left" && st !== "no_show") st = "left";
    var at = a && a.status !== "expected" && a.status === st ? (st === "arrived" ? a.arrived_at : st === "left" ? a.left_at : null) || a.updated_at || null : null, t = clock(at);
    return { state: st, raw: a ? a.status : "expected", at: at, arr: a ? a.id : null, exited: exited, word: WORD[st], text: (st === "arrived" ? "Here" + (t ? " since " + t : "") : WORD[st] + (t ? " " + t : "")) };
  }
  function S() { return global.BPStore; }
  function read(q) {
    return Promise.all([S().bookings.list(q), Promise.resolve().then(function () { return S().dayops.list(q, "arrival"); }).catch(function () { return null; })])
      .then(function (r) { return { list: r[0] || [], arr: r[1] }; });
  }
  async function move(q, booking, to) {
    var was = of(booking, booking._arr), now = await read(q), b = now.list.filter(function (x) { return x.id === booking.id; })[0];
    if (!b || !now.arr) return now.arr ? "changed" : "nosave";
    var cur = of(b, now.arr); if (cur.exited !== was.exited || cur.raw !== was.raw) return "changed";
    if (cur.arr) await S().dayops.setStatus(cur.arr, to);
    else { var made = await S().dayops.add(q, { kind: "arrival", who: booking._name || b.label || "Vendor", role: "vendor", ref_id: b.id, status: to }); if (made && made.existed) return "changed"; }
    var back = await read(q), b2 = back.list.filter(function (x) { return x.id === booking.id; })[0];
    if (!b2 || !back.arr || of(b2, back.arr).raw !== to) return "nosave";
    try { global.document.dispatchEvent(new global.CustomEvent("helm:vendors")); } catch (e) {}
    return "ok";
  }
  var api = global.HelmVendorState = { of: of, read: read, move: move, WORD: WORD, arrivalOf: arrivalOf, clock: clock };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
