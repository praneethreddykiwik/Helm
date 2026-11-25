// R173 (0364): clear task buttons, assign with a start time + reminders in one step, reminders at an exact clock time,
// light date checks, accurate reminder texts, the permanent staff page button.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const require = createRequire(import.meta.url);
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n       " + e.message); } };

const M = read("supabase/migrations/0364_r173_task_timing.sql");
const A = read("supabase/APPLY-0364.sql");
const ops = read("public/ops.html");
const TR = require("../public/task-reminders-ui.js");

t("0364: exact-time column + save RPC with the server rules (after start / 24 h / new time in the past / 8 max)", () => {
  assert.match(M, /alter table public\.event_tasks add column if not exists remind_at timestamptz\[\];/);
  assert.match(M, /create or replace function public\.set_task_reminder_times\(p_task uuid, p_at timestamptz\[\]\)/);
  for (const code of ["no_start_time", "after_start", "too_early", "in_past", "invalid_times"]) assert.match(M, new RegExp("raise exception '" + code + "'"));
  assert.match(M, /not coalesce\(public\.has_area\('staff', 'edit'\), false\)/);
  assert.match(M, /x\.id = p_task and x\.org_id = v_org for update/);
});
t("0364: timer wrapped once (old body kept), exact times once each, missed = skipped, e-mail only without a phone", () => {
  assert.match(M, /alter function public\.task_reminder_tick\(timestamptz\) rename to task_reminder_tick__pre0364;/);
  assert.match(M, /v_who := 'c' \|\| \(r\.t\)\.crew_id::text; v_st := 'skipped'; v_rs := 'email_only';/);
  assert.match(M, /v_who := v_phone; v_st := 'queued'; v_rs := null;/);   // people with a phone: same keys as before
  assert.match(M, /'skipped', 'missed'\)/);
  assert.match(M, /'skipped', 'same_time'\)/);
  assert.match(M, /create trigger zzz_r364_email_only after insert on public\.task_wa_outbox\s+for each row when \(new\.status = 'skipped' and new\.reason = 'email_only'\)/);
  assert.doesNotMatch(M.replace(/^--.*$/gm, ""), /\bdrop\s+(table|function|policy|index|trigger)\b|\bdelete\s+from\b|\btruncate\b/i);
  assert.doesNotMatch(M.replace(/'[^']*'/g, "").split("\n").filter((l) => /^\s*--/.test(l)).join("\n"), /'/);
});
t("0364: APPLY = migration verbatim, MANIFEST + checker + run-all + release lists", () => {
  assert.equal(A.slice(A.indexOf("begin;\n") + 7, A.indexOf("\ncommit;\n")).trim(), M.trim());
  assert.match(A, /^-- APPLY-0364 \(R173 [^\n]*\)\. Run on STAGING first, then production\. Safe to run twice\.\n/);
  assert.ok(read("supabase/migrations/MANIFEST").includes("forward  supabase/migrations/0364_r173_task_timing.sql"));
  assert.ok(read("supabase/CHECK-PROD-MIGRATIONS.sql").includes("0364_r173_task_timing"));
  assert.match(read("scripts/db-test/run-all.sh"), /R173-TASK-TIMING-0364: ALL PASS \\\(25\/25\\\)/);
  assert.match(read("test/release-1020.test.mjs"), /'0364'/);
  assert.ok(/^[\x00-\x7f]*$/.test(A), "APPLY is ASCII");
});
t("exact-time check: before/at the start, 24 h, new time in the past, kept old time, 8 max, sorted", () => {
  const start = Date.parse("2026-12-12T12:30:00Z"), now = Date.parse("2026-12-12T08:00:00Z");
  const iso = (ms) => new Date(ms).toISOString();
  const ok = TR.checkTimes([start - 28 * 60000, start - 60 * 60000], iso(start), [], now);
  assert.equal(ok.ok, true); assert.deepEqual(ok.times, [iso(start - 60 * 60000), iso(start - 28 * 60000)]);
  assert.match(TR.checkTimes([start + 60000], iso(start), [], now).error, /at or before the start/);
  assert.match(TR.checkTimes([start - 25 * 3600000], iso(start), [], now).error, /24 hours/);
  assert.match(TR.checkTimes([now - 10 * 60000], iso(start), [], now).error, /already passed/);
  assert.equal(TR.checkTimes([now - 10 * 60000], iso(start), [iso(now - 10 * 60000)], now).ok, true);   // saved before = may stay
  assert.match(TR.checkTimes([start - 60000], null, [], now).error, /Set a start time first/);
  assert.match(TR.checkTimes(Array.from({ length: 9 }, (_, i) => start - (i + 1) * 60000), iso(start), [], now).error, /At most 8/);
  assert.match(TR.checkTimes([NaN], iso(start), [], now).error, /Couldn't read/);
});
t("summary chip text: studio default, own minutes, at start, exact times", () => {
  const clock = () => "5:32 PM";
  assert.equal(TR.summary({ planned_start: "2026-12-12T12:30:00Z", remind_before: null, remind_at: [] }, { default_before: [10, 5] }, clock), "10 & 5 min before");
  assert.equal(TR.summary({ planned_start: "2026-12-12T12:30:00Z", remind_before: [15, 0], remind_at: ["2026-12-12T12:02:00Z"] }, {}, clock), "15 min before & at start · 5:32 PM");
  assert.equal(TR.summary({ planned_start: null }, {}, clock), "");
});
t("texts: email reminders do not need a phone; WhatsApp needs the studio number", () => {
  const ui = read("public/task-reminders-ui.js");
  assert.doesNotMatch(ui, /the person has a phone number/);
  assert.match(ui, /WhatsApp also needs a phone number on the staff record and your studio's WhatsApp number connected in Integrations/);
  assert.match(TR.explain({ default_before: [10, 5] }), /by email \(to the address on their staff record\)/);
  const c = TR.chip({ status: "skipped", reason: "email_only", what: "reminder" });
  assert.equal(c.text, "Reminder: email only (no phone)");
});
t("R192 task panel: every action has words, only the ones that make sense, special explained, reminders on the row", () => {
  const B = read("public/ops-board.js");
  // the old row of up to seven buttons + the legend paragraph are gone; one task panel instead
  assert.doesNotMatch(ops, /id="opsLegend"/); assert.doesNotMatch(ops, /class="tacts"/);
  for (const w of ['text: "Nudge now"', 'text: "Email"', 'text: "WhatsApp"', 'text: "Give to someone"', 'text: t.planned_start ? "Change time" : "Set a time"', 'text: "Reassign"', 'text: "Cancel task"', 'text: "Approve"', 'text: "Send back"', 'text: "▲ Make special"', 'text: "Remove the special mark"'])
    assert.ok(B.includes(w), "panel action: " + w);
  assert.match(B, /if \(k === "late" && t\.crew_id && inHouse\(t\)\) foot\.push/);   // Nudge only when late
  assert.match(B, /if \(CANCELLABLE\.indexOf\(t\.status\) >= 0\) foot\.push/);   // Cancel only assigned / accepted / started
  assert.match(B, /text: "Reminders " \+ r/);   // reminders shown on the row
  assert.match(ops, /function remSummary\(t\)/);
  assert.doesNotMatch(ops, /title="Toggle recurring reminder"/);
  assert.match(B, /text: "Copy event-only link"/); assert.match(B, /text: "Copy permanent link"/);
});
t("Assign work: optional start time + reminders in the same step, scheduled on the NEW tasks before the e-mail", () => {
  // R192: no tick box hiding the start time - Day before / Event day / No time yet, the picker shown right away
  assert.doesNotMatch(ops, /id="asTimeOn"/);
  assert.match(ops, /id="as_daybefore" data-day="before"/); assert.match(ops, /id="as_evday" data-day="event" aria-pressed="true"/); assert.match(ops, /id="as_none" data-day="none"/);
  assert.match(ops, /<input type="datetime-local" id="as_when"/);
  assert.match(ops, /id="as_evday"/); assert.match(ops, /id="as_daybefore"/);
  assert.match(ops, /const mine=inOrder\(\(fresh\|\|\[\]\)\.filter\(x=>!before\.has\(x\.id\) && x\.crew_id===c\.id && titles\.includes\(x\.title\)\)\);/);
  const iSched = ops.indexOf("await BPStore.ops.setSchedule(x.id, when?when.start"), iMail = ops.indexOf("R170 (0361): \"Send by email\" ticked");
  assert.ok(iSched > 0 && iMail > iSched, "the start time is saved before the e-mail is queued");
  assert.match(read("public/store-api.js"), /setReminderTimes: \(taskId, times\) => rpc\("set_task_reminder_times"/);
});
t("date checks: past refused, far from the event warned, early event -> evening before", () => {
  assert.match(ops, /function whenCheck\(v\)/);
  assert.match(ops, /This event starts early \(\$\{et\}\) - set-up tasks are usually the evening before/);
  assert.match(ops, /Check the date: this is \$\{-diff\} days before the event/);
  assert.match(ops, /dayShift\(E,-1\)\+"T18:00"/);
});
t("Schedule popup + staff page look: plain tick-box labels, wider sheet, centred link button", () => {
  assert.match(read("public/task-reminders.css"), /\.lsheet \.trm-cb\{display:flex;text-transform:none/);
  assert.match(ops, /#schedForm\.lsheet\{width:min\(520px,94vw\)/);
  assert.match(read("public/work.html"), /a\.btn\{display:inline-flex;align-items:center;justify-content:center;text-align:center;text-decoration:none/);
});
t("comms-dispatch: a reminder 6+ hours ahead names the day; page tour explains the buttons", () => {
  assert.match(read("supabase/functions/comms-dispatch/staff-email.mjs"), /const at2 = Number\(row\.minutes\) >= 360 \? when\(row\.start, row\.day\) : clip\(row\.start, 12\);/);
  const tours = read("public/page-tours.js");
  // R192: no tick box any more - the When step and the task panel's Change time
  assert.match(tours, /First the part of the job: Day before, Pre-event, On the event, Wrap-up\. Then what, who .*start time, reminders, Special/); assert.match(tours, /Change time in a task's panel sets its start time and reminders/);
});

const SE = await import("../supabase/functions/comms-dispatch/staff-email.mjs");
t("reminder e-mail text: 28 min ahead = time only; 8 hours ahead (evening before a 2 AM start) = time + day", () => {
  const base = { kind: "task_reminder", task: "Receive guests", start: "6:00 PM", day: "12 Dec 2026", studio: "ABCD Studios", event: "Rao Wedding", name: "Ravi" };
  const a = SE.staffEmailMessage(Object.assign({}, base, { minutes: 28 }), "https://www.helm.events");
  assert.equal(a.subject, "Due in 28 min: Receive guests at 6:00 PM - Rao Wedding");
  const b = SE.staffEmailMessage(Object.assign({}, base, { start: "2:00 AM", day: "13 Dec 2026", minutes: 480 }), "https://www.helm.events");
  assert.equal(b.subject, "Due in 8 hours: Receive guests at 2:00 AM on 13 Dec 2026 - Rao Wedding");
});

console.log(`\nr173-task-timing: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
