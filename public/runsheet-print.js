/* R272 (owner, 27 Nov 2026): the run-sheet Print showed only the app's top bar and an empty list, and there was no
   download. Print now uses a clean sheet of its own (event, date, a table of every line).
   R273 (owner, 28 Nov): no page link / date line from the browser on the paper (page margins 0, our own spacing), empty
   Location / Note columns left out, and Download saves the same sheet as a PDF file (was a CSV) - made in the browser by
   the self-hosted jsPDF (public/vendor, SRI), nothing sent anywhere. Text only (textContent). */
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

  // Location / Note only when some line has one (they were empty columns on most sheets)
  function colsOf(rows) {
    return COLS.filter(function (c) { return (c[0] !== "where" && c[0] !== "note") || rows.some(function (r) { return r[c[0]]; }); });
  }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

  // the sheet printed: lives straight under <body>, hidden on screen, the only thing shown on paper. The page has no
  // margin (so the browser prints no link / date line); a repeated empty head / foot row gives every page its spacing.
  function buildSheet(ev, items) {
    var old = document.getElementById("rsPrintSheet"); if (old) old.remove();
    var rows = rowsOf(items), cols = colsOf(rows);
    var box = el("section", "rsp-sheet"); box.id = "rsPrintSheet"; box.setAttribute("aria-hidden", "true");
    var frame = el("table", "rsp-frame"), fh = el("thead"), ff = el("tfoot"), fb = el("tbody");
    var sp1 = el("tr"), sp1d = el("td", "rsp-gap"); sp1.appendChild(sp1d); fh.appendChild(sp1);
    var sp2 = el("tr"), sp2d = el("td", "rsp-gap"); sp2.appendChild(sp2d); ff.appendChild(sp2);
    var main = el("tr"), cell0 = el("td", "rsp-main"); main.appendChild(cell0); fb.appendChild(main);
    frame.appendChild(fh); frame.appendChild(fb); frame.appendChild(ff); box.appendChild(frame);
    cell0.appendChild(el("h1", "rsp-h", "Event-day run-sheet"));
    cell0.appendChild(el("p", "rsp-ev", titleOf(ev)));
    cell0.appendChild(el("p", "rsp-meta", metaOf(ev, rows)));
    var tb = el("table", "rsp-t"), th = el("thead"), hr = el("tr");
    cols.forEach(function (c) { hr.appendChild(el("th", null, c[1])); });
    th.appendChild(hr); tb.appendChild(th);
    var body = el("tbody");
    if (!rows.length) { var tr0 = el("tr"), td0 = el("td", null, "No run-sheet items yet."); td0.colSpan = cols.length; tr0.appendChild(td0); body.appendChild(tr0); }
    rows.forEach(function (r) {
      var tr = el("tr");
      cols.forEach(function (c) { tr.appendChild(el("td", "rsp-" + c[0], r[c[0]] || "")); });
      body.appendChild(tr);
    });
    tb.appendChild(body); cell0.appendChild(tb);
    document.body.appendChild(box);
    return box;
  }
  function metaOf(ev, rows) {
    var meta = [];
    if (ev && ev.eventDate) meta.push("Date: " + ev.eventDate);
    meta.push(rows.length + (rows.length === 1 ? " item" : " items"));
    return meta.join(" · ");
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

  function fileName(ev) {
    var base = ("run-sheet " + titleOf(ev) + (ev && ev.eventDate ? " " + ev.eventDate : "")).replace(/[^A-Za-z0-9 _-]+/g, " ").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    return (base || "run-sheet").slice(0, 80) + ".pdf";
  }

  // Download = a PDF of the same sheet. The PDF library (about 450 KB) loads only on the first press, from our own
  // origin with SRI. Its built-in font has Latin letters only: a sheet with other scripts (e.g. Telugu names) or a
  // library that cannot load falls back to the print box, where "Save as PDF" keeps every letter.
  var PDF_LIBS = [
    { file: "jspdf-4.2.1.umd.min.js", integrity: "sha384-qovJwSBbRDPP5cEjCp8S0UP66wrvnjaa60XMOGzTNanrThcrGfXfnZkvgY8N1KT3", ready: function () { return !!(window.jspdf && window.jspdf.jsPDF); } },
    { file: "jspdf-autotable-5.0.8.min.js", integrity: "sha384-5jk55M0XWoAw7LyhlXJe19ErOr3doBAPzxw9vahPFbvolqWa2yDk4fhHa2zuYeOa", ready: function () { return !!(window.jspdf && window.jspdf.jsPDF && window.jspdf.jsPDF.API && window.jspdf.jsPDF.API.autoTable); } }
  ];
  function loadOne(lib) {
    return new Promise(function (resolve) {
      if (lib.ready()) return resolve(true);
      var s = document.createElement("script"), done = false;
      var finish = function (ok) { if (done) return; done = true; clearTimeout(t); resolve(ok && lib.ready()); };
      var t = setTimeout(function () { finish(false); }, 15000);
      s.src = "/vendor/" + lib.file; s.integrity = lib.integrity; s.crossOrigin = "anonymous";
      s.onload = function () { finish(true); }; s.onerror = function () { finish(false); };
      document.head.appendChild(s);
    });
  }
  var libsP = null;
  function loadPdfLibs() {
    if (!libsP) libsP = loadOne(PDF_LIBS[0]).then(function (ok) { return ok ? loadOne(PDF_LIBS[1]) : false; }).then(function (ok) { if (!ok) libsP = null; return ok; });
    return libsP;
  }
  // only characters the PDF's built-in font can draw (Latin-1 + the few extra Windows-1252 marks)
  function latinOnly(str) { return /^[\u0000-\u00ff\u2013\u2014\u2018\u2019\u201c\u201d\u2022\u2026\u20ac]*$/.test(str); }
  function pdfOf(ev, items) {
    var rows = rowsOf(items), cols = colsOf(rows);
    var doc = new window.jspdf.jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
    var L = 40, y = 48;
    doc.setProperties({ title: "Event-day run-sheet - " + titleOf(ev), creator: "Helm" });
    doc.setFont("helvetica", "bold"); doc.setFontSize(18); doc.text("Event-day run-sheet", L, y);
    y += 20; doc.setFontSize(12); doc.text(titleOf(ev), L, y);
    y += 16; doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(80); doc.text(metaOf(ev, rows), L, y); doc.setTextColor(0);
    var widths = { start: 58, end: 58, mins: 34 };
    var colStyles = {}; cols.forEach(function (c, i) { if (widths[c[0]]) colStyles[i] = { cellWidth: widths[c[0]] }; });
    doc.autoTable({
      startY: y + 10, margin: { left: L, right: L, top: 40, bottom: 40 },
      head: [cols.map(function (c) { return c[1]; })],
      body: rows.length ? rows.map(function (r) { return cols.map(function (c) { return r[c[0]] || ""; }); }) : [[{ content: "No run-sheet items yet.", colSpan: cols.length }]],
      theme: "grid", columnStyles: colStyles,
      styles: { font: "helvetica", fontSize: 10, cellPadding: 5, lineColor: [150, 150, 150], lineWidth: 0.5, textColor: [0, 0, 0], valign: "top", overflow: "linebreak" },
      headStyles: { fillColor: [235, 235, 235], textColor: [40, 40, 40], fontStyle: "bold" },
      rowPageBreak: "avoid"
    });
    var n = doc.getNumberOfPages();
    for (var i = 1; i <= n; i++) { doc.setPage(i); doc.setFontSize(8); doc.setTextColor(120); doc.text("Page " + i + " of " + n, doc.internal.pageSize.getWidth() - L, doc.internal.pageSize.getHeight() - 20, { align: "right" }); }
    return doc;
  }
  function download(ev, items) {
    var rows = rowsOf(items), all = [titleOf(ev)].concat(rows.map(function (r) { return COLS.map(function (c) { return r[c[0]]; }).join(" "); })).join(" ");
    if (!latinOnly(all)) { print(); return Promise.resolve("print"); }
    return loadPdfLibs().then(function (ok) {
      if (!ok) { print(); return "print"; }
      pdfOf(ev, items).save(fileName(ev));
      return "pdf";
    });
  }

  window.HelmRunsheetPrint = { attach: attach, print: print, download: download, pdfOf: pdfOf, rowsOf: rowsOf, colsOf: colsOf, fileName: fileName, buildSheet: buildSheet, latinOnly: latinOnly };
})();
