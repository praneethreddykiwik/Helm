// r171-staff-reminders.test.mjs - R171 (0362): reminder e-mails say "Due in 10 min" / "Due now"; "Send on WhatsApp" beside
// every "Send by email" (task row, worker-link row, assign form) with a clear not-set-up answer; "no email" hint in the
// staff picker; reminder wording says email + WhatsApp; migration 0362 is additive, editor-safe and wired everywhere.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { staffEmailMessage } from "../supabase/functions/comms-dispatch/staff-email.mjs";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n       " + e.message); } };

const M = read("supabase/migrations/0362_r171_staff_reminders.sql");
const A = read("supabase/APPLY-0362.sql");
const OPS = read("public/ops.html");
const API = read("public/store-api.js");
const TR = read("public/task-reminders-ui.js");
const ORIGIN = "https://www.helm.events";
const base = { kind: "task_reminder", name: "Guest Desk", task: "Receive guests", event: "Rao Wedding", start: "6:00 PM", studio: "ABCD Studios",
  link_path: "work.html?token=11111111-2222-4333-8444-555555555555" };

t("e-mail: 10 / 5 minutes before -> 'Due in N min' subject and body", () => {
  const r10 = staffEmailMessage({ ...base, minutes: 10 }, ORIGIN);
  assert.equal(r10.subject, "Due in 10 min: Receive guests at 6:00 PM - Rao Wedding");
  assert.ok(r10.text.includes("Receive guests for Rao Wedding is due in 10 min, at 6:00 PM."));
  assert.ok(r10.text.includes(ORIGIN + "/work.html?token="), "the person's own task link");
  assert.equal(staffEmailMessage({ ...base, minutes: 5 }, ORIGIN).subject, "Due in 5 min: Receive guests at 6:00 PM - Rao Wedding");
});
t("e-mail: at the start time -> 'Due now'", () => {
  const r = staffEmailMessage({ ...base, minutes: 0 }, ORIGIN);
  assert.equal(r.subject, "Due now: Receive guests at 6:00 PM - Rao Wedding");
  assert.ok(r.text.includes("is due now, at 6:00 PM."));
});

t("0362: additive, guarded, editor-safe (ASCII, no apostrophes in comments, no temp tables, no drop/delete of data)", () => {
  assert.ok(/^[\x00-\x7f]*$/.test(M), "ASCII only");
  for (const line of M.split("\n")) if (/^\s*--/.test(line)) assert.ok(!line.includes("'"), "apostrophe in comment: " + line);
  assert.doesNotMatch(M, /\btemp(orary)?\s+table\b/i);
  assert.doesNotMatch(M.replace(/^--.*$/gm, ""), /\bdrop\s+(table|function|trigger|index)\b|\btruncate\b|\bdelete\s+from\b/i);
  assert.match(M, /raise exception 'STOP 0362: run 0361/);
});
t("0362: Send on WhatsApp = the studio number only, the 0132 queue, signed-in staff only", () => {
  assert.match(M, /create or replace function public\.staff_whatsapp_send\(p_task uuid\)/);
  assert.match(M, /if not coalesce\(public\._r337_wa_ready\(v_org\), false\) then\s+return jsonb_build_object\('ok', false, 'reason', 'wa_not_set_up'\)/);
  assert.match(M, /public\.has_area\('staff', 'edit'\)/);
  assert.match(M, /public\._assign132_enqueue__pre0274\(v_org, t\.quote_id, 'task', t\.id, v_phone/);
  assert.match(M, /grant execute on function public\.staff_whatsapp_send\(uuid\) to authenticated/);
});
t("0362: claim wrapped once; a before-the-start reminder 5+ min after the start is skipped", () => {
  assert.match(M, /alter function public\.staff_email_claim\(integer\) rename to staff_email_claim__pre0362/);
  assert.match(M, /kind = 'task_reminder' and status = 'pending'[\s\S]{0,120}ref_start < now\(\) - interval '5 minutes'/);
  assert.match(M, /return public\.staff_email_claim__pre0362\(p_limit\)/);
});
t("APPLY-0362 + MANIFEST + DB suite + prod checker", () => {
  assert.match(A, /^-- APPLY-0362 \([^\n]*\)\. Run on STAGING first, then production\. Safe to run twice\.\n/);
  assert.match(A, /\nbegin;\n/); assert.match(A, /\ncommit;\n/);
  assert.ok(A.indexOf("-- VERIFY every line") > A.indexOf("\ncommit;\n"), "VERIFY after commit");
  assert.ok(read("supabase/migrations/MANIFEST").includes("forward  supabase/migrations/0362_r171_staff_reminders.sql"));
  assert.match(read("scripts/db-test/run-all.sh"), /R171-STAFF-REMINDERS-0362: ALL PASS \\\(25\/25\\\)/);
  assert.ok(read("supabase/CHECK-PROD-MIGRATIONS.sql").includes("0362"));
});

t("Operations page: 💬 next to every ✉ (task row + worker-link row), assign-form box, clear not-set-up text", () => {
  // R192: WhatsApp right after Email in the task panel and on each By person card (ops-board.js)
  const BRD = read("public/ops-board.js");
  assert.match(BRD, /P\(\)\.mail\(e\.currentTarget, t\.id, false\); \} \} \}\)\);\n\s*foot\.push\(h\("button", \{ type: "button", cls: "tc-btn", "data-key": "a:wa", text: "WhatsApp"/);
  assert.match(BRD, /P\(\)\.mail\(e\.currentTarget, open\.id, true\); \} \} \}\)\);\n\s*acts\.appendChild\(h\("button", \{ type: "button", cls: "tc-btn sm", "data-key": "pw:" \+ c\.id, text: "WhatsApp", "aria-label": "Send " \+ c\.name \+ " their tasks on WhatsApp"/);
  assert.match(OPS, /id="assignWaWrap"[^>]*><input type="checkbox" id="assignWa">/);
  assert.match(OPS, /const WA_NOT_SET_UP="WhatsApp is not set up yet - connect your studio's WhatsApp number in Integrations\. Nothing was sent\.";/);
  assert.match(OPS, /if\(\(await waConnected\(\)\)===false\)\{ BPUI\.toast\(WA_NOT_SET_UP/);
  assert.match(OPS, /wa:\(b,id\)=>sendWa\(b,id\)/);
  assert.match(API, /whatsappTasks: \(taskId\) => rpc\("staff_whatsapp_send", \{ p_task: taskId \}\)/);
});
t("Operations page: the WhatsApp box is ticked only when the studio number is connected (never flips a manual choice)", () => {
  assert.match(OPS, /HelmWaSetupNote\.mount\(\$\("#waSetupNote"\)[^\n]*\.then\(ok=>\{/);
  assert.match(OPS, /if\(x && ok===true && !x\.dataset\.touched\) x\.checked=true;/);
});
t("staff picker: 'no email' when there is no staff e-mail and no linked login; Send by email says so", () => {
  assert.match(OPS, /function noMail\(c\)\{ return !!c && !String\(c\.email\|\|""\)\.trim\(\) && !c\.profile_id; \}/);
  assert.match(OPS, /\$\{noMail\(c\)\?" · no email":""\}<\/option>/);
  assert.match(OPS, /no email on file/);
  assert.match(OPS, /if\(why==="no_email"\) return `\$\{who\} has no email on their staff record/);
});
t("reminder wording: email + WhatsApp, 'At the start time' explained as due now", () => {
  assert.match(TR, /"Reminders \(email \+ WhatsApp\)"/);
  assert.match(TR, /gets a reminder by email \(to the address on their staff record\) and on WhatsApp \(once your studio number is connected\)/);   // R173 wording
  assert.match(TR, /Tick \\"At the start time\\" for a \\"due now\\" reminder/);
  assert.match(TR, /var CHOICES = \[30, 15, 10, 5, 3, 1, 0\];/);
});
t("page tour explains the WhatsApp box (one step with e-mail, ops stays at 8 steps)", () => {
  assert.match(read("public/page-tours.js"), /\{ sel: "#assignEmailWrap", title: "Send by email or WhatsApp", desc: "[^"]*Tick Send on WhatsApp[^"]*nothing is sent/);
});

console.log(`\nr171-staff-reminders: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
