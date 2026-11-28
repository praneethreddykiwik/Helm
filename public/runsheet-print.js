/* R272 (owner, 27 Nov 2026): the run-sheet Print showed only the app's top bar and an empty list, and there was no
   download. Print now uses a clean sheet of its own (event, date, a table of every line) and Download saves the same
   sheet as a file that opens in Excel / Google Sheets. Text only (textContent), nothing sent anywhere. */
(function () {
  "use strict";
  function hhmm(t) { return t ? String(t).slice(0, 5) : ""; }
  function addMin(t, m) {
    if (!t || m == null || m === "") return "";
    var p = hhmm(t).split(":").map(Number), d = new Date(2000, 0, 1, p[0], p[1] + Number(m));
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }
  function clock(t) {
    if (!t) return "";
    var s = hhmm(t);
    return (window.BPStore && typeof window.BPStore.clock12 === "function") ? window.BPStore.clock12(s) : s;
  }
  // one plain row per run-sheet line
  function rowsOf(items) {
    return (Array.isArray(items) ? items : []).map(function (i) {
      var end = addMin(i.start_time, i.duration_min);
      return {
        start: clock(i.start_time),
        end: end ? clock(end) : "",
        mins: i.duration_min != null && i.duration_min !== "" ? String(i.duration_min) : "",
        what: String(i.title || ""),
        owner: String(i.owner || ""),
        where: String(i.location || ""),
        note: String(i.note || "")
      };
    });
  }
  function titleOf(ev) {
    ev = ev || {};
    var parts = [];
    if (ev.code) parts.push(String(ev.code));
    if (ev.title && ev.title !== ev.code) parts.push(String(ev.title));
    return parts.join(" · ") || "Event";
  }
  var COLS = [["start", "Start"], ["end", "Ends"], ["mins", "Mins"], ["what", "Activity"], ["owner", "Owner"], ["where", "Location"], ["note", "Note"]];

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

  // the sheet printed: lives straight under <body>, hidden on screen, the only thing shown on paper
  function buildSheet(ev, items) {
    var old = document.getElementById("rsPrintSheet"); if (old) old.remove();
    var rows = rowsOf(items);
    var box = el("section", "rsp-sheet"); box.id = "rsPrintSheet"; box.setAttribute("aria-hidden", "true");
    box.appendChild(el("h1", "rsp-h", "Event-day run-sheet"));
    box.appendChild(el("p", "rsp-ev", titleOf(ev)));
    var meta = [];
    if (ev && ev.eventDate) meta.push("Date: " + ev.eventDate);
    meta.push(rows.length + (rows.length === 1 ? " item" : " items"));
    box.appendChild(el("p", "rsp-meta", meta.join(" · ")));
    var tb = el("table", "rsp-t"), th = el("thead"), hr = el("tr");
    COLS.forEach(function (c) { hr.appendChild(el("th", null, c[1])); });
    th.appendChild(hr); tb.appendChild(th);
    var body = el("tbody");
    if (!rows.length) { var tr0 = el("tr"), td0 = el("td", null, "No run-sheet items yet."); td0.colSpan = COLS.length; tr0.appendChild(td0); body.appendChild(tr0); }
    rows.forEach(function (r) {
      var tr = el("tr");
      COLS.forEach(function (c) { tr.appendChild(el("td", "rsp-" + c[0], r[c[0]] || "")); });
      body.appendChild(tr);
    });
    tb.appendChild(body); box.appendChild(tb);
    box.appendChild(el("p", "rsp-foot", "Printed " + new Date().toLocaleString()));
    document.body.appendChild(box);
    return box;
  }

  // Print button and Ctrl+P both get the clean sheet: built just before printing from what the page shows now
  var SRC = null;
  function prep() {
    if (!SRC) return;
    buildSheet(SRC.ev(), SRC.items());
    document.documentElement.classList.add("rsp-printing");
  }
  function after() { document.documentElement.classList.remove("rsp-printing"); }
  function attach(getEv, getItems) {
    SRC = { ev: getEv, items: getItems };
    window.addEventListener("beforeprint", prep);
    window.addEventListener("afterprint", after);
  }
  function print() { prep(); window.print(); }

  // Excel-friendly CSV: BOM for the rupee sign / Telugu names, quotes doubled, formula-looking cells made plain text
  function cell(v) {
    var s = String(v == null ? "" : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function csvOf(ev, items) {
    var lines = [];
    lines.push([cell("Event-day run-sheet"), cell(titleOf(ev)), cell(ev && ev.eventDate ? ev.eventDate : "")].join(","));
    lines.push("");
    lines.push(COLS.map(function (c) { return cell(c[1]); }).join(","));
    rowsOf(items).forEach(function (r) { lines.push(COLS.map(function (c) { return cell(r[c[0]]); }).join(",")); });
    return "﻿" + lines.join("\r\n") + "\r\n";
  }
  function fileName(ev) {
    var base = ("run-sheet " + titleOf(ev) + (ev && ev.eventDate ? " " + ev.eventDate : "")).replace(/[^A-Za-z0-9 _-]+/g, " ").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    return (base || "run-sheet").slice(0, 80) + ".csv";
  }
  function download(ev, items) {
    var blob = new Blob([csvOf(ev, items)], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = fileName(ev); a.rel = "noopener";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  window.HelmRunsheetPrint = { attach: attach, print: print, download: download, csvOf: csvOf, rowsOf: rowsOf, fileName: fileName, buildSheet: buildSheet };
})();
