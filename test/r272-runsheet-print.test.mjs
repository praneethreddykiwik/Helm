// R272 (owner, 27 Nov 2026): run-sheet Print printed only the app's top bar and an empty list; no Download.
// Print / Ctrl+P now print a clean sheet of their own. R273: Download saves a PDF; no link line on paper.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const js = fs.readFileSync("public/runsheet-print.js", "utf8");
const css = fs.readFileSync("public/runsheet-print.css", "utf8");
const page = fs.readFileSync("public/runsheet.html", "utf8");
const win = {}; vm.runInNewContext(js, { window: win, document: {}, Blob: class {}, URL: {}, setTimeout });
const P = win.HelmRunsheetPrint;
const EV = { code: "HS-1", title: "Rao wedding", eventDate: "2026-11-28" };
const ITEMS = [{ start_time: "04:30:00", duration_min: 10, title: "Hall cleaning", owner: "Tharun", location: "stage" }, { start_time: null, duration_min: null, title: '=HYPERLINK("x") "quoted"' }];

test("page loads the print helper and has Download + Print buttons", () => {
  assert.match(page, /<script src="\/runsheet-print\.js\?v=\d+"><\/script>/);
  assert.match(page, /<link rel="stylesheet" href="\/runsheet-print\.css\?v=\d+">/);
  assert.match(page, /id="dlBtn"/); assert.match(page, /id="printBtn"/);
  assert.match(page, /HelmRunsheetPrint\.attach\(\(\)=>EV,\(\)=>items\)/);
  assert.match(page, /EV=ev;/);
});
test("rows: times, end time, minutes, every field", () => {
  const r = P.rowsOf(ITEMS);
  assert.equal(r.length, 2);
  assert.deepEqual([r[0].start, r[0].end, r[0].mins, r[0].what, r[0].owner, r[0].where], ["04:30", "04:40", "10", "Hall cleaning", "Tharun", "stage"]);
  assert.equal(r[1].start, ""); assert.equal(r[1].end, "");
});
test("R273: Download is a PDF (self-hosted jsPDF with SRI), falls back to the print box", () => {
  assert.match(js, /file: "jspdf-4\.2\.1\.umd\.min\.js", integrity: "sha384-/);
  assert.match(js, /file: "jspdf-autotable-5\.0\.8\.min\.js", integrity: "sha384-/);
  assert.match(js, /s\.src = "\/vendor\/" \+ lib\.file; s\.integrity = lib\.integrity;/);
  assert.match(js, /\.save\(fileName\(ev\)\)/);
  assert.match(js, /if \(!latinOnly\(all\)\) \{ print\(\);/);
  assert.match(js, /if \(!ok\) \{ print\(\); return "print"; \}/);
  assert.doesNotMatch(js, /text\/csv/);
  assert.equal(P.latinOnly("Mahalakshmi · 6:30 pm"), true);
  assert.equal(P.latinOnly("మహాలక్ష్మి"), false);
  for (const f of ["jspdf-4.2.1.umd.min.js", "jspdf-autotable-5.0.8.min.js"]) assert.ok(fs.existsSync("public/vendor/" + f), f);
});
test("R273: empty Location / Note columns are left out", () => {
  assert.equal(JSON.stringify(P.colsOf(P.rowsOf([{ start_time: "18:30:00", title: "Welcome" }])).map((c) => c[1])), JSON.stringify(["Start", "Ends", "Mins", "Activity", "Owner"]));
  assert.equal(JSON.stringify(P.colsOf(P.rowsOf(ITEMS)).map((c) => c[1])), JSON.stringify(["Start", "Ends", "Mins", "Activity", "Owner", "Location"]));
});
test("file name is safe", () => {
  assert.equal(P.fileName(EV), "run-sheet-HS-1-Rao-wedding-2026-11-28.pdf");
  assert.equal(P.fileName({ title: "../../x<>" }), "run-sheet-x.pdf");
});
test("paper shows only the sheet; no browser link / date line; screen never shows it; Ctrl+P covered", () => {
  assert.match(css, /@page \{ margin: 0; \}/); assert.match(css, /\.rsp-gap \{ height: 12mm;/);
  assert.match(css, /^\.rsp-sheet \{ display: none; \}/m);
  assert.match(css, /html\.rsp-printing body > \*:not\(#rsPrintSheet\) \{ display: none !important; \}/);
  assert.match(js, /addEventListener\("beforeprint", prep\)/);
  assert.match(js, /addEventListener\("afterprint", after\)/);
  assert.doesNotMatch(js, /innerHTML/);
});
