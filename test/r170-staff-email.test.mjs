// R170 (0361): tasks, crew assignment and task reminders by e-mail to staff. Source characterization, no DB, no network.
// The behaviour is proven on a real PG17 by tests/db/r170-staff-email-0361.sql and the send lane by
// tests/edge/comms-dispatch-r170-staff.test.ts; this file pins the wiring and the e-mail wording.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { staffEmailMessage, staffLink, STAFF_KINDS, STAFF_TX_REASON, OFFICE_TX_REASON } from "../supabase/functions/comms-dispatch/staff-email.mjs";
import * as RT from "../supabase/functions/_shared/reply-to.mjs";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ok " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n    " + (e && e.message)); } };

const SQL = read("supabase/migrations/0361_r170_staff_email.sql");
const APPLY = read("supabase/APPLY-0361.sql");
const ORIGIN = "https://www.helm.events";
const TOK = "b0000000-0000-4000-8000-0000000000aa", QID = "a0000000-0000-4000-8000-00000000da01";

await t("migration: additive + idempotent, ASCII, editor-safe (no apostrophes in comments), guarded wrap of the two automation functions", () => {
  assert.ok(SQL.split("").every((c) => c.charCodeAt(0) < 128), "ASCII only");
  const code = SQL.replace(/^--.*$/gm, "");
  assert.doesNotMatch(code, /\bdrop\s+(table|function|policy|index|trigger|column)\b|\btruncate\b|\bdelete\s+from\b/i);
  for (const line of SQL.split("\n")) if (/^\s*--/.test(line)) assert.ok(!line.includes("'"), "apostrophe in a comment: " + line);
  assert.match(SQL, /create table if not exists public\.staff_email_outbox/);
  assert.match(SQL, /add column if not exists staff_email_enabled boolean not null default true/);
  assert.match(SQL, /alter function public\.automation_overview\(\) rename to automation_overview__pre0361/);
  assert.match(SQL, /position\('r170-0361' in coalesce\(v_src, ''\)\) = 0 and to_regprocedure\('public\.automation_switch__pre0361\(text,boolean\)'\) is null/);
  assert.match(SQL, /if not exists \(select 1 from pg_trigger where tgrelid = 'public\.event_tasks'::regclass and tgname = 'zzz_r361_task_email'\)/);
  assert.match(SQL, /if not exists \(select 1 from pg_trigger where tgrelid = 'public\.task_wa_outbox'::regclass and tgname = 'zzz_r361_reminder_email'\)/);
  // VERIFY lines never name an optional relation directly
  const verify = SQL.slice(SQL.indexOf("-- VERIFY every line should say true"));
  assert.doesNotMatch(verify, /from public\.\w+/);
});

await t("migration: triggers never make a save fail; the address is read server-side; trial / read-only / sample events send nothing", () => {
  assert.match(SQL, /exception when others then\s+raise warning 'r170-0361: task e-mail not queued/);
  assert.match(SQL, /exception when others then\s+raise warning 'r170-0361: reminder e-mail not queued/);
  assert.match(SQL, /public\._r361_person\(v_org, t\.crew_id, v_phone\)/, "button: address from the staff record");
  assert.doesNotMatch(SQL, /p_email|p_to\b|p_recipient/, "no RPC takes an address from the page");
  assert.match(SQL, /not coalesce\(public\._tb179_no_send\(p_org\), false\) and not coalesce\(public\._trial_locked\(p_org\), false\)/);
  assert.match(SQL, /coalesce\(q\.status, ''\) <> 'cancelled' and not coalesce\(q\.is_demo, false\)/);
  assert.match(SQL, /execute function public\._ts166_tg_outbox_skip\(\)/, "free-trial outbox gate");
  assert.match(SQL, /execute function public\._sq164_tg_outbox\(\)/, "system changes stay quiet");
  assert.match(SQL, /public\._r283_off_email\(p_org, v_email\)/, "deactivated members get nothing");
  assert.match(SQL, /if auth\.uid\(\) is null or v_org is null or not public\.has_area\('staff', 'edit'\) then/);
  assert.match(SQL, /where x\.id = p_task and x\.org_id = v_org/, "own studio only");
  assert.match(SQL, /floor\(extract\(epoch from now\(\)\) \/ 120\)/, "one manual send per 2 minutes");
});

await t("migration: grants - buttons for signed-in staff, queue functions server-only, kept bodies closed", () => {
  assert.match(SQL, /grant execute on function public\.staff_email_send\(uuid,boolean\) to authenticated/);
  assert.match(SQL, /grant execute on function public\.staff_email_hold\(uuid,uuid\) to authenticated/);
  assert.doesNotMatch(SQL, /grant execute on function public\.staff_email_claim\(integer\) to authenticated/);
  assert.match(SQL, /'public\.automation_overview__pre0361\(\)', 'public\.automation_switch__pre0361\(text,boolean\)'\] loop/);
});

await t("APPLY-0361: header, the migration body inside one transaction, VERIFY after commit", () => {
  assert.match(APPLY, /^-- APPLY-0361 \(R170 [^\n]*\)\. Run on STAGING first, then production\. Safe to run twice\.\n/);
  const body = APPLY.slice(APPLY.indexOf("begin;\n") + 7, APPLY.indexOf("\ncommit;\n")).trim();
  assert.equal(body, SQL.slice(0, SQL.indexOf("-- VERIFY every line should say true")).trim());
  assert.ok(APPLY.indexOf("-- VERIFY every line should say true") > APPLY.indexOf("\ncommit;\n"));
  assert.ok(read("supabase/migrations/MANIFEST").includes("forward  supabase/migrations/0361_r170_staff_email.sql"));
  assert.match(read("scripts/db-test/run-all.sh"), /R170-STAFF-EMAIL-0361: ALL PASS \\\(44\/44\\\)/);
});

await t("e-mail: task list in plain words, earliest first as given, work link on APP_URL only", () => {
  const m = staffEmailMessage({ kind: "task_assigned", name: "Ravi Kumar", studio: "Sparkle Events", event: "Rao Wedding", event_date: "01 Dec 2026",
    venue: "Palace Grounds", tasks: [{ title: "Sound check", category: "Stage", start: "12:00 PM", day: "01 Dec 2026" }, { title: "Flower arch" }],
    link_path: "work.html?token=" + TOK }, ORIGIN);
  assert.equal(m.subject, "New work for you: Rao Wedding (01 Dec 2026)");
  assert.ok(m.text.startsWith("Hello Ravi,\n\nSparkle Events has given you work for Rao Wedding on 01 Dec 2026 at Palace Grounds:"));
  assert.ok(m.text.includes("  - Sound check (Stage) - starts 12:00 PM on 01 Dec 2026\n  - Flower arch"));
  assert.ok(m.text.includes(ORIGIN + "/work.html?token=" + TOK));
  assert.ok(m.text.includes("Just reply to this e-mail - it goes to Sparkle Events."));
});

await t("e-mail: reminder / late / one task / office alert wording", () => {
  const base = { studio: "Sparkle Events", event: "Rao Wedding", task: "Stage lights", start: "12:30 PM", day: "01 Dec 2026", name: "Ravi Kumar",
    link_path: "work.html?token=" + TOK };
  const r = staffEmailMessage({ ...base, kind: "task_reminder", minutes: 10 }, ORIGIN);
  assert.equal(r.subject, "Due in 10 min: Stage lights at 12:30 PM - Rao Wedding");   // R171 wording
  assert.ok(r.text.includes("Stage lights for Rao Wedding is due in 10 min, at 12:30 PM."));
  assert.ok(staffEmailMessage({ ...base, kind: "task_reminder", minutes: 90 }, ORIGIN).text.includes("is due in 1 hour 30 min"));
  assert.equal(staffEmailMessage({ ...base, kind: "task_reminder", minutes: 0 }, ORIGIN).subject, "Due now: Stage lights at 12:30 PM - Rao Wedding");
  const l = staffEmailMessage({ ...base, kind: "task_late" }, ORIGIN);
  assert.equal(l.subject, "Not started yet: Stage lights - Rao Wedding");
  assert.ok(l.text.includes("was due to start at 12:30 PM on 01 Dec 2026 and is not marked as started yet."));
  assert.equal(staffEmailMessage({ ...base, kind: "task_one" }, ORIGIN).subject, "Task for you: Stage lights - Rao Wedding");
  const o = staffEmailMessage({ ...base, kind: "office_alert", worker: "Ravi Kumar", name: "Asha", link_path: "ops.html?quote=" + QID }, ORIGIN);
  assert.equal(o.subject, "Task not started: Stage lights (Ravi Kumar) - Rao Wedding");
  assert.ok(o.text.includes(ORIGIN + "/ops.html?quote=" + QID));
});

await t("e-mail: fails closed (unknown kind, no tasks, no task title, reminder without a time); never a foreign link; no markup", () => {
  assert.equal(staffEmailMessage({ kind: "boom", task: "x" }, ORIGIN).text, "");
  assert.equal(staffEmailMessage({ kind: "task_assigned", tasks: [] }, ORIGIN).text, "");
  assert.equal(staffEmailMessage({ kind: "task_one" }, ORIGIN).text, "");
  assert.equal(staffEmailMessage({ kind: "task_reminder", task: "x" }, ORIGIN).text, "");
  assert.equal(staffLink({ link_path: "https://evil.example/x" }, ORIGIN), "");
  assert.equal(staffLink({ link_path: "work.html?token=" + TOK }, "http://insecure.test"), "");
  const m = staffEmailMessage({ kind: "task_one", task: "<b>Lights</b>", event: "E<script>", studio: "S" }, ORIGIN);
  assert.doesNotMatch(m.text + m.subject, /[<>]/);
  assert.deepEqual(STAFF_KINDS, ["task_assigned", "task_list", "task_one", "task_reminder", "task_late", "office_alert"]);
  assert.ok(STAFF_TX_REASON && OFFICE_TX_REASON);
});

await t("comms-dispatch: the staff lane - claimed only with an e-mail provider, studio reply-to, footer by kind, every row marked", () => {
  const cd = read("supabase/functions/comms-dispatch/index.ts");
  assert.match(cd, /import \{ staffEmailMessage, (?:staffUpdateMessage, )?(?:staffEmailHtml, staffUpdateHtml, )?STAFF_TX_REASON, OFFICE_TX_REASON \} from "\.\/staff-email\.mjs";/);
  assert.match(cd, /mailOn && !overBudget\(\) \? await admin\.rpc\("staff_email_claim", \{ p_limit: batch \}\) : NOCLAIM;/);
  assert.match(cd, /const ident: Identity = await withReply\("staff", id,/);
  assert.match(cd, /=== "office_alert" \? OFFICE_TX_REASON : STAFF_TX_REASON/);
  assert.match(cd, /admin\.rpc\("staff_email_mark", \{ p_id: id, p_status: res === "failed" \? "retry" : res \}\)/);
  assert.equal(RT.LANE_TABLES.staff, "staff_email_outbox");
});

await t("Operations page: Send by email box on the assign form, per-task and per-person buttons, plain-words answers", () => {
  const h = read("public/ops.html");
  assert.match(h, /<label class="assign-mail" id="assignEmailWrap"[^>]*><input type="checkbox" id="assignEmail" checked(?: autocomplete="off")?> ✉ Send by email<\/label>/);
  assert.match(h, /if\(\$\("#assignEmailWrap"\)\) \$\("#assignEmailWrap"\)\.hidden = outsource;/);
  assert.match(h, /await BPStore\.ops\.emailHold\(quoteId, c\.id\)/);
  assert.match(h, /await BPStore\.ops\.emailTasks\(t\.id, true\)/);
  assert.match(h, /class="btn sm temail"/);
  assert.match(h, /class="btn sm semail" data-task=/);
  assert.match(h, /if\(why==="no_email"\) return `\$\{who\} has no email on their staff record/);
  assert.doesNotMatch(h, /emailTasks\([^)]*@/, "no address is ever sent from the page");
  const api = read("public/store-api.js");
  assert.match(api, /emailTasks: \(taskId, all\) => rpc\("staff_email_send", \{ p_task: taskId, p_all: all !== false \}\)/);
  assert.match(api, /emailHold: \(quoteId, crewId\) => rpc\("staff_email_hold", \{ p_quote: quoteId, p_crew: crewId \}\)/);
});

await t("Settings -> Automations lists the switch; the page tour explains the box and the reminder e-mails", () => {
  const a = read("public/automations.js");
  assert.match(a, /\{ key: "staff_email", group: "outside", name: "E-mail staff their tasks", sends: \["crew"\], how: "E-mail",/);
  const pt = read("public/page-tours.js");
  assert.match(pt, /\{ sel: "#assignEmailWrap", title: "Send by email(?: or WhatsApp)?",/);
  assert.match(pt, /by email to each staff record address/);   // R173 wording (no phone needed)
});

console.log(`\nr170-staff-email: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
