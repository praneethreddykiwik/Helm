// r179-reminders-links-schedule.test.mjs - R179 (owner, 16 Nov 2026, tested on production):
//   1 Schedule task: the Save / Cancel footer is always on screen (it was cut off below the reminders), errors show in it
//   2 the reminder minute ticks + custom minutes are never locked by "Use the studio default" (custom "was not working")
//   3 a clear date + time picker (when-picker.js) for start times and exact reminder times; the input stays the value holder
//   4 copy buttons work in Safari (no await before copying; textarea + execCommand first; clipboard item for async links)
//   5 the permanent staff link opens each event inside it (work.html?staff=..&event=..), e-mails deep-link to the event
//   6 special tasks get reminders (0367); 7 the APPLY file is the migration verbatim
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import vm from "node:vm";
const r = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n       " + String(e && e.message).split("\n")[0]); } }

const OPS = r("public/ops.html"), TRM = r("public/task-reminders-ui.js"), WP = r("public/when-picker.js"), WPC = r("public/when-picker.css");
const STAFF = r("public/staff.html"), HOME = r("public/staff-home.js"), WORK = r("public/work.html"), SELF = r("public/crew-self.js");
const MIG = r("supabase/migrations/0367_r179_special_reminders_staff_link_event.sql"), APPLY = r("supabase/APPLY-0367.sql");

// load when-picker.js in a tiny sandbox (no DOM needed for the pure helpers)
function loadPicker() {
  const ctx = { window: {}, document: { createElement() { return {}; } }, Event: function () {}, console };
  ctx.globalThis = ctx.window; vm.createContext(ctx);
  vm.runInContext(WP, ctx);
  return ctx.window.HelmWhen;
}

await t("1 Schedule task: body scrolls, the Save / Cancel footer stays visible, errors show in the footer", () => {
  assert.match(OPS, /<form class="lsheet form schedsheet" id="schedForm" novalidate>/);
  assert.match(OPS, /<div class="sch-body">/);
  assert.match(OPS, /<div class="foot"><div class="lerr" id="sc_err" role="alert" hidden><\/div><button type="button" class="btn" id="sc_cancel"/);
  assert.match(OPS, /\.lmodal > #schedForm\.schedsheet\{[^}]*max-height:calc\(100dvh - 32px\)[^}]*display:flex;flex-direction:column;overflow:hidden !important\}/);
  assert.match(OPS, /#schedForm \.sch-body\{flex:1 1 auto;min-height:0;overflow:auto/);
  assert.match(OPS, /#schedForm \.foot\{flex:none;position:sticky;bottom:0/);
});

await t("2 reminder ticks + custom minutes are never locked; changing them switches the studio default off", () => {
  assert.doesNotMatch(TRM, /b\.input\.disabled = off/);
  assert.doesNotMatch(TRM, /ci\.disabled = off/);
  assert.match(TRM, /function untickDefault\(\) \{ if \(dflt\.input\.checked\) dflt\.input\.checked = false; \}/);
  assert.match(TRM, /b\.input\.addEventListener\("change", untickDefault\)/);
  assert.match(TRM, /ci\.addEventListener\("input", untickDefault\)/);
  // the name must not clash with schedFields' own `var own` (it did: the listener was null and nothing happened)
  assert.doesNotMatch(TRM, /function own\(/);
});

await t("3a the picker reads times people type", () => {
  const W = loadPicker();
  const cases = { "6:32 pm": "18:32", "6.32PM": "18:32", "18:32": "18:32", "1832": "18:32", "632p": "18:32", "6pm": "18:00", "6 PM": "18:00",
    "12am": "00:00", "12:15 pm": "12:15", "0630": "06:30", "9": "09:00" };
  for (const [k, v] of Object.entries(cases)) assert.equal(W.parseTime(k), v, k);
  for (const bad of ["25:00", "6:75", "13pm", "abc", ""]) assert.equal(W.parseTime(bad), null, bad);
});
await t("3b the picker says the result in words", () => {
  const W = loadPicker();
  assert.equal(W.words("2026-11-16T14:30"), "Mon 16 Nov, 2:30 PM");
  assert.equal(W.words("2026-11-17T00:05"), "Tue 17 Nov, 12:05 AM");
  assert.equal(W.words(""), "");
});
await t("3c the picker: hidden value holder (no silent form validation), date + time fields, chips, words line", () => {
  assert.match(WP, /input\.type = "hidden"/);
  assert.match(WP, /date\.type = "date"/);
  // R183: the time is an hour : minute clock (spinbuttons) + AM | PM toggle instead of a text box with a 15-minute list
  assert.match(WP, /seg\("whenp-hh", base \+ "_t", "hour", 1, 12\)/);
  assert.match(WP, /var next = d && hm \? d \+ "T" \+ hm : "";/);
  assert.doesNotMatch(WP, /innerHTML|insertAdjacentHTML|\.style\./);
  assert.match(WPC, /\.whenp-row \{ display: grid;/);
  assert.match(OPS, /function startPicker\(inp, adopt\)/);
  assert.match(OPS, /startPicker\(\$\("#sc_when"\), \[\$\("#sc_evday"\), \$\("#sc_daybefore"\)\]\)/);
  assert.match(OPS, /startPicker\(\$\("#as_when"\), \[\]\);   \/\/ R179: date \+ time picker \(the Day before \/ Event day buttons sit above it\)/);   // R192
  assert.match(OPS, /<script src="when-picker\.js\?v=\d+"><\/script><script src="task-reminders-ui\.js\?v=\d+"><\/script>/);
  assert.match(OPS, /<link rel="stylesheet" href="when-picker\.css\?v=\d+">/);
  assert.match(TRM, /global\.HelmWhen\.attach\(inp, \{ compact: true, label: "Reminder"(, zoneNote: false)? \}\)/);
});

await t("4 copy works in Safari: no await before copying, textarea first, clipboard item for a link still loading", () => {
  assert.match(OPS, /function copyNow\(text, inp\)\{/);
  assert.match(OPS, /document\.execCommand\("copy"\)/);
  assert.match(OPS, /new ClipboardItem\(\{"text\/plain": p\.then/);
  // R192: By person "Copy event-only link" copies with the same synchronous helper (no await before the copy)
  assert.match(r("public/ops-board.js"), /on: \{ click: function \(\) \{ if \(P\(\)\.copyNow\(link, null\)\) toast\("Event link copied\."/);
  assert.doesNotMatch(OPS, /Couldn't copy — select the link and copy it manually/);
  assert.match(r("public/ops-board.js"), /if \(c\.id\) \{ try \{ P\(\)\.permLink\(c\.id\); \} catch \(e\) \{\}/);   // fetched before anyone clicks Copy
  assert.match(STAFF, /function copyTaskLink\(s,btn\)\{/);
  assert.match(STAFF, /new ClipboardItem\(\{"text\/plain": p\.then/);
  assert.match(STAFF, /\.copy-ta\{position:fixed;top:-1000px/);
  assert.match(OPS, /\.copy-ta\{position:fixed;top:-1000px/);
});

await t("5a worker links: the permanent link is the primary one, the event-only link second", () => {
  // R192: each By person card - Email tasks, WhatsApp, Copy permanent link (primary), then the event-only link (ghost)
  const B = r("public/ops-board.js"), iP = B.indexOf('text: "Copy permanent link"'), iE = B.indexOf('text: "Copy event-only link"');
  assert.ok(iP > 0 && iE > iP, "permanent link first, event-only second");
  assert.match(B, /cls: "tc-btn sm ghost", "data-key": "pe:" \+ c\.id, text: "Copy event-only link"/);
});
await t("5b the permanent link opens an event inside itself, with All my tasks back", () => {
  assert.match(HOME, /function eventHref\(id\) \{ return homeHref\(\) \+ "&event=" \+ encodeURIComponent\(String\(id\)\); \}/);
  assert.match(HOME, /h\("a", \{ cls: "btn primary", href: eventHref\(e\.quote_id\), text: "Open this event to accept \/ start \/ finish" \}\)/);
  assert.match(HOME, /async function resolveEvent\(\)/);
  assert.match(HOME, /text: "\\u2190 All my tasks"/);
  assert.match(WORK, /let token=LINK\?LINK\.ref:new URLSearchParams\(location\.search\)\.get\("token"\);/);
  assert.match(WORK, /if\(!HelmStaffHome\.inEvent\(\)\) return HelmStaffHome\.start\(\);/);
  assert.match(WORK, /token=t; HelmStaffHome\.backBar\(\);/);
  assert.match(WORK, /HelmCrewSelf\.useToken\(t\)/);
  assert.match(SELF, /useToken: function \(t\) \{ if \(!t \|\| token\) return;/);
});
await t("5c e-mails about one event deep-link into the permanent link; the update notice and office alert keep theirs", async () => {
  const m = await import("../supabase/functions/comms-dispatch/staff-email.mjs");
  const tok = "a".repeat(64), q = "11111111-2222-3333-4444-555555555555", o = "https://www.helm.events";
  for (const kind of ["task_assigned", "task_list", "task_one", "task_reminder", "task_late"])
    assert.equal(m.staffLink({ kind, quote_id: q, link_path: "work.html?staff=" + tok }, o), o + "/work.html?staff=" + tok + "&event=" + q, kind);
  assert.equal(m.staffLink({ kind: "task_update", quote_id: q, link_path: "work.html?staff=" + tok }, o), o + "/work.html?staff=" + tok);
  assert.equal(m.staffLink({ kind: "task_one", quote_id: "not-a-uuid", link_path: "work.html?staff=" + tok }, o), o + "/work.html?staff=" + tok);
  assert.equal(m.staffLink({ kind: "task_one", quote_id: q, link_path: "work.html?token=" + q }, o), o + "/work.html?token=" + q);
  assert.equal(m.staffLink({ kind: "task_one", quote_id: q, link_path: "work.html?staff=" + tok + "&event=" + q + "x" }, o), "");
});

await t("6 special tasks: legend + migration 0367 (wrap once, same slots, every 5 min up to 6, safe)", () => {
  // R192: the stale legend ("every 5 min ... up to 6") is gone; the panel explains special tasks with the R186 escalation ladder
  assert.doesNotMatch(OPS, /then every 5 min until it is started \(up to 6\)/);
  assert.match(r("public/ops-board.js"), /global\.HelmTaskReminders\.escExplain\(S\.escCfg\)/);
  assert.doesNotMatch(OPS, /it does not send anything by itself/);
  assert.match(MIG, /alter function public\.task_reminder_tick\(timestamptz\) rename to task_reminder_tick__pre0367;/);
  assert.match(MIG, /alter function public\.staff_link_view\(text\) rename to staff_link_view__pre0367;/);
  assert.match(MIG, /foreach m in array array\[10, 5\] loop/);
  assert.match(MIG, /v_every := greatest\(1, least\(60, coalesce\(\(r\.t\)\.remind_every_min, 5\)\)\);/);
  assert.match(MIG, /for k in 1 \.\. 6 loop/);
  assert.match(MIG, /trial_send_blocked/);
  assert.doesNotMatch(MIG.replace(/^--.*$/gm, ""), /\bdrop\s+(table|function|policy|index|trigger)\b|\bdelete\s+from\b|\btruncate\b/i);
  assert.ok(/^[\x00-\x7f]*$/.test(MIG), "ASCII only");
});
await t("7 APPLY-0367 = the migration verbatim between begin / commit", () => {
  assert.match(APPLY, /^-- APPLY-0367 \(R179 [^\n]*\)\. Run on STAGING first, then production\. Safe to run twice\.\n/);
  assert.equal(APPLY.slice(APPLY.indexOf("begin;\n") + 7, APPLY.indexOf("\ncommit;\n")).trim(), MIG.trim());
  assert.ok(r("supabase/migrations/MANIFEST").includes("forward  supabase/migrations/0367_r179_special_reminders_staff_link_event.sql"));
  assert.match(r("scripts/db-test/run-all.sh"), /R179-SPECIAL-REMINDERS-0367: ALL PASS \\\(20\/20\\\)/);
});

console.log(`\nr179-reminders-links-schedule: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
