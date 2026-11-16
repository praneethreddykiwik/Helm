/* when-picker.js - R179: a clear date + time picker for task start times and exact reminder times.
 *
 * HelmWhen.attach(input, opts) turns an <input type="datetime-local"> into
 *   [ date field ]   [ 3 : 57 ]            <- the date field is a normal type=date (ui-pickers.js gives it the rounded
 *                    [ AM | PM ]               calendar). R183: the time is two big segments (hour, minutes: tap, type digits,
 *                    :00 :15 :30 :45           arrows / wheel; typing "6:32 pm" or "1832" fills both) + an AM | PM toggle
 *   (Today) (Tomorrow) (Event day) ...
 *   "Mon 16 Nov, 2:30 PM"                   <- the result in words
 * The original input stays the source of truth: it becomes type=hidden and keeps the STUDIO wall clock "YYYY-MM-DDTHH:MM"
 * (or "" when empty), so every caller that reads input.value keeps working. When a caller sets input.value and fires
 * input/change, the picker shows it. A hidden input is never part of browser form validation, so a min/max can not
 * silently block a submit any more (R179 schedule bug class).
 * opts: chips      [{ label, title?, ymd: () => "YYYY-MM-DD" | "" , time?: "HH:MM" }]   quick date buttons
 *       adopt      [button elements] existing quick buttons moved into the chip row (their own click handlers stay)
 *       compact    smaller layout (exact reminder rows)
 *       label      accessible name prefix, e.g. "Start" or "Reminder"
 *       defaultTime "HH:MM" used when a date is picked and no time is set yet (default "09:00")
 *       tz         studio IANA zone (string or function); default BPStore.studioTimezone()
 *       zoneNote   false = no "times are in the studio's time zone" note (exact-reminder rows: the modal shows one already)
 * R182: when the device's clock differs from the studio's, a note under the picker says which zone the times are in and
 * what time it is there now, and the words line adds the zone + the device-time equivalent ("= 3:00 AM, Mon 16 Nov on
 * your device"). Needs studio-time.js (HelmStudioTime); without it the picker behaves as before.
 * CSP: DOM API only (no HTML strings), no inline styles; classes live in when-picker.css.
 */
(function (global) {
  "use strict";
  if (typeof document === "undefined") return;
  var doc = document;
  var uid = 0;
  var pad = function (n) { return (n < 10 ? "0" : "") + n; };

  // "6:32 pm" "6.32pm" "18:32" "1832" "632p" "6pm" "6 PM" "12am" -> "HH:MM" | null
  function parseTime(v) {
    var s = String(v == null ? "" : v).trim().toLowerCase().replace(/\s+/g, "");
    if (!s) return null;
    var m = /^(\d{1,2})(?:[:.]?(\d{2}))?(a|am|p|pm)?$/.exec(s);
    if (!m) return null;
    var h = +m[1], mi = m[2] != null ? +m[2] : 0, ap = m[3];
    if (m[2] == null && !ap && m[1].length > 2) return null;
    if (mi > 59) return null;
    if (ap) {
      if (h < 1 || h > 12) return null;
      var pm = ap.charAt(0) === "p";
      if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12;
    } else if (h > 23) return null;
    return pad(h) + ":" + pad(mi);
  }
  // also take "1832" / "0632" (4 digits, 24-hour) when no am/pm
  function parseTimeLoose(v) {
    var s = String(v == null ? "" : v).trim();
    var m4 = /^(\d{2})(\d{2})$/.exec(s);
    if (m4 && +m4[1] <= 23 && +m4[2] <= 59) return m4[1] + ":" + m4[2];
    return parseTime(v);
  }
  function label12(hm) {
    var m = /^(\d{2}):(\d{2})$/.exec(String(hm || "")); if (!m) return "";
    var h = +m[1], ap = h >= 12 ? "PM" : "AM", h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + ":" + m[2] + " " + ap;
  }
  function words(value) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(String(value || ""));
    if (!m) return "";
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    var day = "";
    try { day = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).replace(",", ""); }
    catch (e) { day = m[3] + "/" + m[2]; }
    return day + ", " + label12(m[4]);
  }
  function el(tag, cls, text) { var n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function fire(node, type) { node.dispatchEvent(new Event(type, { bubbles: true })); }
  // R182: task times are the STUDIO's wall clock (BPStore.studioTimezone), not the device's. When the device shows a different
  // clock (an owner abroad), the picker says so plainly and spells out the time in both zones - never silent.
  function zoneOf(opts) {
    var tz = "";
    try { tz = typeof opts.tz === "function" ? opts.tz() : (opts.tz || ""); } catch (e) { tz = ""; }
    if (!tz) { try { tz = global.BPStore && typeof global.BPStore.studioTimezone === "function" ? global.BPStore.studioTimezone() : ""; } catch (e) { tz = ""; } }
    var T = global.HelmStudioTime;
    return T && T.validTz(tz) ? tz : "";
  }
  function zoneDiffers(tz) { var T = global.HelmStudioTime; return !!(tz && T && !T.sameClock(tz, new Date())); }
  function attach(input, opts) {
    if (!input || input.__helmWhen) return input && input.__helmWhen;
    opts = opts || {};
    uid += 1;
    var base = input.id || ("hw" + uid);
    var start = String(input.value || "");
    var minDate = String(input.min || "").slice(0, 10), maxDate = String(input.max || "").slice(0, 10);
    try { input.type = "hidden"; } catch (e) { /* very old browsers: leave it */ }
    input.value = start;
    var wrap = el("div", "whenp" + (opts.compact ? " whenp-compact" : ""));
    var row = el("div", "whenp-row");
    var who = opts.label ? String(opts.label) + " " : "";
    var date = el("input", "whenp-date"); date.type = "date"; date.id = base + "_d"; date.setAttribute("aria-label", who + "date");
    if (/^\d{4}-\d{2}-\d{2}$/.test(minDate)) date.min = minDate;
    if (/^\d{4}-\d{2}-\d{2}$/.test(maxDate)) date.max = maxDate;
    // R183: iOS-style time: big hour : minute segments (tap, type digits, arrows / wheel) + an AM | PM toggle + quick :00 :15 :30 :45.
    var tp = el("div", "whenp-tp"); tp.setAttribute("role", "group"); tp.setAttribute("aria-label", who + "time");
    var clock = el("div", "whenp-clock");
    function seg(cls, id, name, lo, hi) {
      var s = el("input", "whenp-seg " + cls); s.type = "text"; s.id = id; s.autocomplete = "off"; s.spellcheck = false;
      s.inputMode = "numeric"; s.maxLength = 2; s.placeholder = "--";
      s.setAttribute("role", "spinbutton"); s.setAttribute("aria-label", who + name);
      s.setAttribute("aria-valuemin", String(lo)); s.setAttribute("aria-valuemax", String(hi));
      return s;
    }
    var hh = seg("whenp-hh", base + "_t", "hour", 1, 12), mm = seg("whenp-mm", base + "_m", "minutes", 0, 59);
    var colon = el("span", "whenp-colon", ":"); colon.setAttribute("aria-hidden", "true");
    clock.appendChild(hh); clock.appendChild(colon); clock.appendChild(mm);
    var apBox = el("div", "whenp-ampm"); apBox.setAttribute("role", "group"); apBox.setAttribute("aria-label", who + "AM or PM");
    var bAM = el("button", "whenp-ap", "AM"), bPM = el("button", "whenp-ap", "PM");
    bAM.type = "button"; bPM.type = "button"; apBox.appendChild(bAM); apBox.appendChild(bPM);
    var quick = el("div", "whenp-quick");
    [0, 15, 30, 45].forEach(function (q) {
      var b = el("button", "whenp-q", ":" + pad(q)); b.type = "button"; b.setAttribute("aria-label", "Minutes " + pad(q));
      b.addEventListener("click", function () { mm.value = pad(q); if (!hourOk()) { var dt = opts.defaultTime || "09:00"; setHM(dt.slice(0, 2) + ":" + pad(q)); } commit(); });
      quick.appendChild(b);
    });
    tp.appendChild(clock); tp.appendChild(apBox); tp.appendChild(quick);
    var time = hh;   // focus target + "is a time set" checks below
    var pm = false;
    function setAp(isPm) { pm = !!isPm; bAM.setAttribute("aria-pressed", String(!pm)); bPM.setAttribute("aria-pressed", String(pm));
      bAM.classList.toggle("on", !pm); bPM.classList.toggle("on", pm); }
    setAp(false);
    function hourOk() { var h = +hh.value; return /^\d{1,2}$/.test(hh.value) && h >= 1 && h <= 12; }
    function minOk() { var m = +mm.value; return /^\d{1,2}$/.test(mm.value) && m >= 0 && m <= 59; }
    function getHM() {
      if (!hourOk() || !minOk()) return null;
      var h = +hh.value % 12; if (pm) h += 12;
      return pad(h) + ":" + pad(+mm.value);
    }
    function aria() {
      hh.setAttribute("aria-valuenow", hourOk() ? String(+hh.value) : ""); mm.setAttribute("aria-valuenow", minOk() ? String(+mm.value) : "");
      hh.setAttribute("aria-valuetext", hourOk() ? String(+hh.value) + (pm ? " PM" : " AM") : "not set");
      mm.setAttribute("aria-valuetext", minOk() ? pad(+mm.value) : "not set");
    }
    function setHM(hm) {
      var m = /^(\d{2}):(\d{2})$/.exec(String(hm || "")); if (!m) return;
      var h = +m[1]; setAp(h >= 12); hh.value = String(h % 12 === 0 ? 12 : h % 12); mm.value = m[2]; aria();
    }
    function timeTyped() { return !!(String(hh.value).trim() || String(mm.value).trim()); }
    row.appendChild(date); row.appendChild(tp);
    wrap.appendChild(row);
    var chipsRow = null;
    var chips = Array.isArray(opts.chips) ? opts.chips : [];
    var adopt = Array.isArray(opts.adopt) ? opts.adopt.filter(Boolean) : [];
    if (chips.length || adopt.length) {
      chipsRow = el("div", "whenp-chips");
      chips.forEach(function (c) {
        var b = el("button", "btn sm whenp-chip", String(c.label || "")); b.type = "button"; if (c.title) b.title = String(c.title);
        b.addEventListener("click", function () {
          var ymd = typeof c.ymd === "function" ? c.ymd() : "";
          if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || ""))) return;
          date.value = ymd;
          if (!getHM()) setHM(c.time || opts.defaultTime || "09:00");
          commit(); time.focus();
        });
        chipsRow.appendChild(b);
      });
      adopt.forEach(function (b) { b.classList.add("whenp-chip"); chipsRow.appendChild(b); });
      wrap.appendChild(chipsRow);
    }
    var out = el("p", "whenp-words"); out.setAttribute("aria-live", "polite"); out.id = base + "_w";
    wrap.appendChild(out);
    var zone = null, zoneTimer = null;
    if (opts.zoneNote !== false && global.HelmStudioTime) {
      zone = el("p", "whenp-zone"); zone.id = base + "_z"; zone.hidden = true;
      wrap.appendChild(zone);
    }
    function zoneUpdate() {
      if (!zone) return;
      if (!doc.contains(wrap)) { if (zoneTimer) { clearInterval(zoneTimer); zoneTimer = null; } }
      var tz = zoneOf(opts), T = global.HelmStudioTime;
      if (!zoneDiffers(tz)) { zone.hidden = true; zone.textContent = ""; return; }
      var lb = T.zoneLabel(tz), now = new Date();
      zone.textContent = "\uD83C\uDF10 Times here are in the studio's time zone - " + lb.long + " (" + lb.abbr + "). It's " +
        T.fmt(now, tz) + " there now (your device: " + T.fmtDevice(now) + ").";
      zone.hidden = false;
    }
    input.parentNode.insertBefore(wrap, input.nextSibling);
    var lbl = input.id ? doc.querySelector('label[for="' + input.id + '"]') : null;
    if (lbl) lbl.htmlFor = date.id;
    var desc = input.getAttribute("aria-describedby");
    if (desc) { date.setAttribute("aria-describedby", desc); hh.setAttribute("aria-describedby", desc); mm.setAttribute("aria-describedby", desc); }

    var busy = false;
    function show() {
      var v = String(input.value || "");
      var m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(v);
      if (m) { if (date.value !== m[1]) date.value = m[1]; if (getHM() !== m[2]) setHM(m[2]); }
      else if (!v) { /* keep a half-typed value in the fields */ }
      var w = words(v);
      if (w) {
        var tz = zoneOf(opts), T = global.HelmStudioTime;
        if (zoneDiffers(tz) && m) {
          var at = T.wallToUtc(m[1], m[2], tz);
          w += " " + T.zoneLabel(tz, at).abbr + (isNaN(at.getTime()) ? "" : " (= " + T.fmtDevice(at) + " on your device)");
        }
      }
      out.textContent = w ? w : (date.value && !getHM() ? "Pick a time" : "");
      out.classList.toggle("whenp-need", !w && !!date.value);
      clock.classList.toggle("whenp-bad", timeTyped() && !getHM() && doc.activeElement !== hh && doc.activeElement !== mm);
      aria();
    }
    function commit() {
      var hm = getHM();
      var d = /^\d{4}-\d{2}-\d{2}$/.test(date.value) ? date.value : "";
      var next = d && hm ? d + "T" + hm : "";   // a half-filled picker means "no time yet" (the words line says what is missing)
      if (next !== input.value) { busy = true; input.value = next; fire(input, "input"); fire(input, "change"); busy = false; }
      show();
    }
    date.addEventListener("change", commit);
    date.addEventListener("input", commit);
    // typing a whole time into either box ("6:32 pm", "1832", "632p") fills both + AM/PM
    function takeWhole(seg) {
      var raw = String(seg.value || "");
      if (!/[^0-9]/.test(raw) && raw.length <= 2) return false;
      var hm = parseTimeLoose(raw); if (!hm) { seg.value = raw.replace(/\D/g, "").slice(0, 2); return false; }
      setHM(hm); commit(); mm.focus(); return true;
    }
    hh.addEventListener("input", function () {
      if (takeWhole(hh)) return;
      var v = hh.value.replace(/\D/g, "").slice(0, 2);
      if (v.length === 2 && +v > 12) v = v.charAt(0) === "0" ? v.charAt(1) : v.charAt(0);
      hh.value = v;
      if (v.length === 2 || (v.length === 1 && +v > 1)) { mm.focus(); try { mm.select(); } catch (e) {} }
      commit();
    });
    mm.addEventListener("input", function () {
      if (takeWhole(mm)) return;
      var v = mm.value.replace(/\D/g, "").slice(0, 2);
      if (v.length === 2 && +v > 59) v = v.charAt(0);
      if (v.length === 1 && +v > 5) v = "0" + v;
      mm.value = v; commit();
    });
    hh.addEventListener("blur", function () { if (hh.value === "0" || hh.value === "00") hh.value = "12"; show(); });
    mm.addEventListener("blur", function () { if (/^\d$/.test(mm.value)) { mm.value = pad(+mm.value); commit(); } else show(); });
    function stepH(n) { var h = hourOk() ? +hh.value : 9; h = ((h - 1 + n) % 12 + 12) % 12 + 1; hh.value = String(h); if (!minOk()) mm.value = "00"; commit(); }
    function stepM(n) { var m = minOk() ? +mm.value : 0; m = ((m + n) % 60 + 60) % 60; mm.value = pad(m); if (!hourOk()) hh.value = String(+((opts.defaultTime || "09:00").slice(0, 2)) % 12 || 12); commit(); }
    function keys(e, isH) {
      var k = e.key, sg = isH ? hh : mm;
      // a digit typed into a full box (no selection) starts it over - like a phone clock, never "blocked by maxLength"
      if (/^\d$/.test(k) && !e.ctrlKey && !e.metaKey && !e.altKey && sg.selectionStart === sg.selectionEnd && String(sg.value).length >= 2) {
        e.preventDefault(); sg.value = k; sg.dispatchEvent(new Event("input", { bubbles: true })); return;
      }
      if (k === "ArrowUp" || k === "ArrowDown") { e.preventDefault(); var n = k === "ArrowUp" ? 1 : -1; if (isH) stepH(n); else stepM(e.shiftKey ? n * 15 : n); return; }
      if (k === "PageUp" || k === "PageDown") { e.preventDefault(); if (isH) stepH(k === "PageUp" ? 3 : -3); else stepM(k === "PageUp" ? 15 : -15); return; }
      if (k === "a" || k === "A") { e.preventDefault(); setAp(false); commit(); return; }
      if (k === "p" || k === "P") { e.preventDefault(); setAp(true); commit(); return; }
      if (isH && (k === ":" || k === "." || (k === "ArrowRight" && hh.selectionStart === hh.value.length))) { e.preventDefault(); mm.focus(); try { mm.select(); } catch (er) {} return; }
      if (!isH && ((k === "Backspace" && !mm.value) || (k === "ArrowLeft" && mm.selectionStart === 0))) { e.preventDefault(); hh.focus(); return; }
      if (k === "Enter") { commit(); }
    }
    hh.addEventListener("keydown", function (e) { keys(e, true); });
    mm.addEventListener("keydown", function (e) { keys(e, false); });
    // the mouse wheel changes a box only while that box has the focus (it never hijacks page scrolling)
    hh.addEventListener("wheel", function (e) { if (doc.activeElement !== hh) return; e.preventDefault(); stepH(e.deltaY < 0 ? 1 : -1); }, { passive: false });
    mm.addEventListener("wheel", function (e) { if (doc.activeElement !== mm) return; e.preventDefault(); stepM(e.deltaY < 0 ? 1 : -1); }, { passive: false });
    // tap / click selects the whole box, so the next digits replace it (a click would otherwise drop the selection)
    [hh, mm].forEach(function (sgm) {
      sgm.addEventListener("focus", function () { try { sgm.select(); } catch (e) {} });
      sgm.addEventListener("mouseup", function (e) { if (sgm.selectionStart === sgm.selectionEnd) { e.preventDefault(); try { sgm.select(); } catch (er) {} } });
    });
    bAM.addEventListener("click", function () { setAp(false); commit(); });
    bPM.addEventListener("click", function () { setAp(true); commit(); });
    // a caller set input.value (Event day / Day before / reset): show it
    input.addEventListener("input", function () { if (!busy) show(); });
    input.addEventListener("change", function () { if (!busy) show(); });
    var api = {
      wrap: wrap, date: date, time: time, hour: hh, minute: mm,
      refresh: show,
      setMinMax: function (min, max) {
        var a = String(min || "").slice(0, 10), b = String(max || "").slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(a)) date.min = a; else date.removeAttribute("min");
        if (/^\d{4}-\d{2}-\d{2}$/.test(b)) date.max = b; else date.removeAttribute("max");
      },
      focus: function () { (date.value ? hh : date).focus(); },
    };
    input.__helmWhen = api;
    // a caller's input.focus() (it is hidden now) lands on the picker
    try { input.focus = function () { api.focus(); }; } catch (e) { /* read-only in some engines */ }
    show();
    zoneUpdate();
    if (zone) zoneTimer = setInterval(zoneUpdate, 30000);
    return api;
  }

  global.HelmWhen = { attach: attach, parseTime: parseTimeLoose, words: words, label12: label12 };
})(typeof window !== "undefined" ? window : globalThis);
