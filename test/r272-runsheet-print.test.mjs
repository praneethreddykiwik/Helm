// R272 (owner, 27 Nov 2026): run-sheet Print printed only the app's top bar and an empty list; no Download.
// Print / Ctrl+P now print a clean sheet of their own; Download saves a spreadsheet file (CSV).
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
test("CSV: Excel BOM, header, quotes doubled, formula cells neutralised", () => {
  const c = P.csvOf(EV, ITEMS);
  assert.ok(c.startsWith("﻿"));
  assert.match(c, /"Start","Ends","Mins","Activity","Owner","Location","Note"/);
  assert.match(c, /"'=HYPERLINK\(""x""\) ""quoted"""/);
  assert.match(c, /"HS-1 · Rao wedding","2026-11-28"/);
});
test("file name is safe", () => {
  assert.equal(P.fileName(EV), "run-sheet-HS-1-Rao-wedding-2026-11-28.csv");
  assert.equal(P.fileName({ title: "../../x<>" }), "run-sheet-x.csv");
});
test("paper shows only the sheet; screen never shows it; Ctrl+P covered", () => {
  assert.match(css, /^\.rsp-sheet \{ display: none; \}/m);
  assert.match(css, /html\.rsp-printing body > \*:not\(#rsPrintSheet\) \{ display: none !important; \}/);
  assert.match(js, /addEventListener\("beforeprint", prep\)/);
  assert.match(js, /addEventListener\("afterprint", after\)/);
  assert.doesNotMatch(js, /innerHTML/);
});
