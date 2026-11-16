/* studio-time.js - R182: task times are always the STUDIO's wall clock, never the viewer's device zone.
 *
 * An owner travelling abroad (device in America/Chicago) planning an Indian studio's event (Asia/Kolkata) types
 * "2:30 PM": that means 2:30 PM in India. Helm already stored and showed times in the studio zone (BPStore.studioClock,
 * r20/B18) but never TOLD the viewer, so a time that had already passed in India was refused with no explanation.
 * This file is the one shared, pure helper (Intl only, no libraries, no DOM) used by when-picker.js and ops.html:
 *   offsetMin(date, tz)        minutes EAST of UTC for tz at that instant (IST = 330, CST = -360, CDT = -300)
 *   utcToWall(date, tz)        { y, mo, d, h, mi, ymd: "YYYY-MM-DD", hm: "HH:MM" } - the wall clock in tz
 *   wallToUtc(ymd, hm, tz)     Date for that wall clock in tz (DST-safe: iterates the offset; a skipped spring-forward
 *                              time resolves forward, an ambiguous fall-back time to the first occurrence)
 *   zoneLabel(tz, date)        { abbr: "IST" | "CST" | "GMT+4", long: "India Standard Time" }
 *   sameClock(tz, date)        true when the device shows the same wall clock as tz right now (same offset)
 *   fmt(date, tz)              "1:47 AM, Tue 17 Nov"
 *   deviceTz()                 the device's IANA zone name ("" when unknown)
 * Exposed as window.HelmStudioTime (and globalThis.HelmStudioTime for node tests).
 */
(function (global) {
  "use strict";
  var pad = function (n) { return (n < 10 ? "0" : "") + n; };
  var cache = {};
  function partsFmt(tz) {
    var k = "p|" + tz;
    if (!cache[k]) cache[k] = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit",
      day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    return cache[k];
  }
  function validTz(tz) {
    if (!tz || typeof tz !== "string") return false;
    try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch (e) { return false; }
  }
  function utcToWall(date, tz) {
    var d = (date && typeof date.getTime === "function") ? date : new Date(date);
    if (isNaN(d.getTime()) || !validTz(tz)) return null;
    var p = {}; partsFmt(tz).formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
    var y = +p.year, mo = +p.month, dd = +p.day, h = (+p.hour) % 24, mi = +p.minute;
    return { y: y, mo: mo, d: dd, h: h, mi: mi, ymd: y + "-" + pad(mo) + "-" + pad(dd), hm: pad(h) + ":" + pad(mi) };
  }
  function offsetMin(date, tz) {
    var d = (date && typeof date.getTime === "function") ? date : new Date(date);
    var w = utcToWall(d, tz); if (!w) return 0;
    var asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
    var instant = Math.floor(d.getTime() / 60000) * 60000;
    return Math.round((asUtc - instant) / 60000);
  }
  function wallToUtc(ymd, hm, tz) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || "")), t = /^(\d{1,2}):(\d{2})$/.exec(String(hm || ""));
    if (!m || !t || !validTz(tz)) return new Date(NaN);
    var want = Date.UTC(+m[1], +m[2] - 1, +m[3], +t[1], +t[2]);
    // first guess with the offset at "want", then correct once or twice (DST edges)
    var guess = want - offsetMin(new Date(want), tz) * 60000;
    for (var i = 0; i < 3; i++) {
      var off = offsetMin(new Date(guess), tz);
      var next = want - off * 60000;
      if (next === guess) break;
      guess = next;
    }
    // a wall time that does not exist (spring forward) lands on a different wall clock: move forward to the real one
    var w = utcToWall(new Date(guess), tz);
    if (w && (w.ymd !== m[1] + "-" + m[2] + "-" + m[3] || w.hm !== pad(+t[1]) + ":" + t[2])) {
      // in the gap the clock jumped forward: reading the wall time with the offset from BEFORE the jump moves it forward
      var later = want - offsetMin(new Date(guess - 3 * 3600000), tz) * 60000;
      if (!isNaN(later)) guess = later;
    }
    return new Date(guess);
  }
  function zoneLabel(tz, date) {
    var d = date || new Date(), abbr = "", long = "";
    var tryName = function (loc, style) {
      try {
        var x = new Intl.DateTimeFormat(loc, { timeZone: tz, timeZoneName: style }).formatToParts(d).filter(function (p) { return p.type === "timeZoneName"; })[0];
        return x ? x.value : "";
      } catch (e) { return ""; }
    };
    if (!validTz(tz)) return { abbr: "", long: "" };
    abbr = tryName("en-IN", "short");
    if (!abbr || /^(GMT|UTC)[+-]/.test(abbr)) { var us = tryName("en-US", "short"); if (us && !/^(GMT|UTC)[+-]/.test(us)) abbr = us; }
    if (!abbr) abbr = tz;
    long = tryName("en-US", "long") || tz;
    return { abbr: abbr, long: long };
  }
  function deviceTz() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) { return ""; }
  }
  function sameClock(tz, date) {
    var d = date || new Date();
    if (!validTz(tz)) return true;
    return offsetMin(d, tz) === -d.getTimezoneOffset();
  }
  function label12(h, mi) { var ap = h >= 12 ? "PM" : "AM", h12 = h % 12 === 0 ? 12 : h % 12; return h12 + ":" + pad(mi) + " " + ap; }
  function dayWords(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || "")); if (!m) return "";
    try { return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).replace(",", ""); }
    catch (e) { return m[3] + "/" + m[2]; }
  }
  function fmt(date, tz) {
    var w = utcToWall(date, tz); if (!w) return "";
    return label12(w.h, w.mi) + ", " + dayWords(w.ymd);
  }
  // the device's own wall clock for an instant (for "= 3:00 AM Mon 16 Nov on your device")
  function fmtDevice(date) {
    var d = (date && typeof date.getTime === "function") ? date : new Date(date);
    if (isNaN(d.getTime())) return "";
    return label12(d.getHours(), d.getMinutes()) + ", " + dayWords(d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()));
  }
  global.HelmStudioTime = { offsetMin: offsetMin, utcToWall: utcToWall, wallToUtc: wallToUtc, zoneLabel: zoneLabel,
    sameClock: sameClock, fmt: fmt, fmtDevice: fmtDevice, deviceTz: deviceTz, validTz: validTz, dayWords: dayWords };
})(typeof window !== "undefined" ? window : globalThis);
