// r172-update-notices.test.mjs - R172 (0363): staff get ONE short "your tasks changed" e-mail per event when the office
// changes their tasks or the event (5 quiet minutes, max 15), with their PERMANENT task link; one permanent link per staff
// member (Staff page "Task link" / "New task link", Operations "Permanent link", work.html?staff=<64 hex> page); staff
// e-mails carry the permanent link; migration 0363 is additive, editor-safe and wired everywhere.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { staffEmailMessage, staffUpdateMessage, staffLink } from "../supabase/functions/comms-dispatch/staff-email.mjs";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n       " + e.message); } };

const M = read("supabase/migrations/0363_r172_update_notices_staff_link.sql");
const A = read("supabase/APPLY-0363.sql");
const ORIGIN = "https://www.helm.events";
const TOK = "0123456789abcdef".repeat(4);
const upd = { kind: "task_update", name: "Ravi Kumar", studio: "ABCD Studios", event: "Rao Wedding", event_date: "12 Dec 2026", venue: "Lake Palace",
  changes: ["Receive guests: start time changed from 6:00 PM on 12 Dec 2026 to 6:30 PM on 12 Dec 2026", "Cancelled: Napkins"], more: 0, cancelled: false,
  tasks: [{ title: "Receive guests", start: "6:30 PM", day: "12 Dec 2026" }], link_path: "work.html?staff=" + TOK };

t("notice e-mail: subject names the event and date; every change line; the tasks now; the permanent link", () => {
  const m = staffUpdateMessage(upd, ORIGIN);
  assert.equal(m.subject, "Update: your tasks for Rao Wedding on 12 Dec 2026 changed");
  assert.ok(m.text.includes("ABCD Studios changed something on your work for Rao Wedding on 12 Dec 2026 at Lake Palace:"), m.text);
  assert.ok(m.text.includes("  - Receive guests: start time changed from 6:00 PM on 12 Dec 2026 to 6:30 PM on 12 Dec 2026"));
  assert.ok(m.text.includes("  - Cancelled: Napkins"));
  assert.ok(m.text.includes("Your tasks for this event now:\n  - Receive guests - starts 6:30 PM on 12 Dec 2026"));
  assert.ok(m.text.includes(ORIGIN + "/work.html?staff=" + TOK), "the permanent link");
  assert.ok(m.text.includes("reply to this e-mail - it goes to ABCD Studios"));
});
t("notice e-mail: more changes than shown, no open tasks, cancelled event", () => {
  assert.ok(staffUpdateMessage({ ...upd, more: 3 }, ORIGIN).text.includes("  - and 3 more changes"));
  assert.ok(staffUpdateMessage({ ...upd, tasks: [] }, ORIGIN).text.includes("You have no open tasks for this event now."));
  const c = staffUpdateMessage({ ...upd, cancelled: true, changes: ["The event has been cancelled - your tasks for it are off"], tasks: [] }, ORIGIN);
  assert.equal(c.subject, "Cancelled: Rao Wedding on 12 Dec 2026");
  assert.ok(!c.text.includes("Your tasks for this event now"));
});
t("notice e-mail: nothing to say / wrong kind -> empty (comms-dispatch marks it skipped)", () => {
  assert.equal(staffUpdateMessage({ ...upd, changes: [] }, ORIGIN).text, "");
  assert.equal(staffUpdateMessage({ ...upd, kind: "task_list" }, ORIGIN).text, "");
  assert.equal(staffUpdateMessage(null, ORIGIN).text, "");
});
t("links: the permanent link (64 hex) and the per-event link are allowed; anything else is dropped", () => {
  assert.equal(staffLink({ link_path: "work.html?staff=" + TOK }, ORIGIN), ORIGIN + "/work.html?staff=" + TOK);
  assert.equal(staffLink({ link_path: "work.html?token=11111111-2222-4333-8444-555555555555" }, ORIGIN), ORIGIN + "/work.html?token=11111111-2222-4333-8444-555555555555");
  assert.equal(staffLink({ link_path: "work.html?staff=" + TOK.slice(1) }, ORIGIN), "");
  assert.equal(staffLink({ link_path: "work.html?staff=" + TOK.toUpperCase() }, ORIGIN), "");
  assert.equal(staffLink({ link_path: "https://evil.example/work.html?staff=" + TOK }, ORIGIN), "");
  assert.ok(staffEmailMessage({ kind: "task_reminder", task: "Receive guests", event: "Rao Wedding", start: "6:00 PM", minutes: 5,
    studio: "ABCD Studios", link_path: "work.html?staff=" + TOK }, ORIGIN).text.includes("/work.html?staff=" + TOK), "reminders carry the permanent link");
  assert.ok(!staffUpdateMessage({ ...upd, changes: ["x <script>y</script>"] }, ORIGIN).text.includes("<script>"), "no angle brackets in text");
});

t("0363: additive, guarded, editor-safe (ASCII, no apostrophes in comments, no temp tables, no drop/delete of data)", () => {
  assert.ok(/^[\x00-\x7f]*$/.test(M), "ASCII only");
  for (const line of M.split("\n")) if (/^\s*--/.test(line)) assert.ok(!line.includes("'"), "apostrophe in comment: " + line);
  assert.doesNotMatch(M, /\btemp(orary)?\s+table\b/i);
  assert.doesNotMatch(M.replace(/^--.*$/gm, ""), /\bdrop\s+(table|function|trigger|index)\b|\btruncate\b|\bdelete\s+from\b/i);
  assert.match(M, /raise exception 'STOP 0363: run 0362/);
});
t("0363: RLS on both new tables at the TOP level (the Supabase editor sees it), closed to the app", () => {
  assert.match(M, /^alter table public\.staff_links enable row level security;$/m);
  assert.match(M, /^alter table public\.staff_update_outbox enable row level security;$/m);
  assert.match(M, /revoke all on table public\.staff_links from anon/);
  assert.match(M, /revoke all on table public\.staff_update_outbox from authenticated/);
});
t("0363: link = 64 hex, one live per person, New link revokes, the page is rate limited and never shows other people", () => {
  assert.match(M, /token ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(M, /create unique index if not exists staff_links_live363 on public\.staff_links\(crew_id\) where revoked_at is null;/);
  assert.match(M, /update public\.staff_links set revoked_at = now\(\) where crew_id = p_crew and org_id = v_org and revoked_at is null;/);
  assert.match(M, /perform public\._r341_limit\('staff_link', 600, 240\);/);
  assert.match(M, /has_area\('staff', 'edit'\)/);
});
t("0363: notices collect (5 quiet minutes, max 15), only office edits, nothing while a new-work e-mail waits", () => {
  assert.match(M, /not_before = least\(u\.first_at \+ interval '15 minutes', now\(\) \+ interval '5 minutes'\)/);
  assert.match(M, /if v_actor is null then return null; end if;/);
  assert.match(M, /o\.kind = 'task_assigned' and o\.status = 'pending' and o\.sent_at is null\) then return; end if;/);
  assert.match(M, /create trigger zzz_r363_task_changed after update of title, planned_start, planned_end, note, category, status, crew_id, assignee_phone/);
  assert.match(M, /create trigger zzz_r363_event_changed after update of event_date, event_time, client, status, deleted_at/);
});
t("0363: staff e-mail claim wrapped once (old body kept), APPLY = migration verbatim, MANIFEST + checker + run-all + release lists", () => {
  assert.match(M, /alter function public\.staff_email_claim\(integer\) rename to staff_email_claim__pre0363;/);
  assert.equal(A.slice(A.indexOf("begin;\n") + 7, A.indexOf("\ncommit;\n")).trim(), M.trim());
  assert.match(A, /^-- APPLY-0363 \(R172 [^\n]*\)\. Run on STAGING first, then production\. Safe to run twice\.\n/);
  assert.ok(read("supabase/migrations/MANIFEST").includes("forward  supabase/migrations/0363_r172_update_notices_staff_link.sql"));
  assert.ok(read("supabase/CHECK-PROD-MIGRATIONS.sql").includes("0363_r172_update_notices_staff_link"));
  assert.match(read("scripts/db-test/run-all.sh"), /R172-UPDATE-NOTICES-0363: ALL PASS \\\(41\/41\\\)/);
  assert.match(read("test/release-1020.test.mjs"), /'0363'/);
});

t("comms-dispatch: the change-notice lane (claimed only with an e-mail provider, studio reply-to, staff footer, every row marked)", () => {
  const cd = read("supabase/functions/comms-dispatch/index.ts");
  assert.match(cd, /admin\.rpc\("staff_update_claim", \{ p_limit: batch \}\)/);
  assert.match(cd, /mailOn && !overBudget\(\) \? await admin\.rpc\("staff_update_claim"/);
  assert.match(cd, /withReply\("staffUpdate", id,/);
  assert.match(cd, /admin\.rpc\("staff_update_mark", \{ p_id: id, p_status: res === "failed" \? "retry" : res \}\)/);
  assert.match(read("supabase/functions/_shared/reply-to.mjs"), /staffUpdate: "staff_update_outbox"/);
});
t("UI: Staff page Task link / New task link, Operations Permanent link, the work.html?staff= page", () => {
  const st = read("public/staff.html"), ops = read("public/ops.html"), wk = read("public/work.html"), sh = read("public/staff-home.js"), api = read("public/store-api.js");
  assert.match(st, /data-act="tlink"/); assert.match(st, /data-act="tlinknew"/);
  assert.match(st, /The old link stops working at once/);
  assert.match(ops, /class="btn sm splink" data-crew="\$\{esc\(t\.crew_id\)\}"/);
  assert.match(api, /staffLink: \(crewId\) => rpc\("staff_link_get", \{ p_crew: crewId \}\)/);
  assert.match(api, /staffLinkNew: \(crewId\) => rpc\("staff_link_regenerate", \{ p_crew: crewId \}\)/);
  assert.match(api, /staffHome: \(staffToken\) => \{/);
  assert.match(wk, /<script src="\/staff-home\.js\?v=\d+"><\/script>/);
  assert.match(wk, /if\(window\.HelmStaffHome&&HelmStaffHome\.wants\(\)\) return HelmStaffHome\.start\(\);/);
  assert.doesNotMatch(sh, /innerHTML|insertAdjacentHTML|document\.write/, "DOM API only");
  assert.match(sh, /\/\^\[0-9a-f\]\{64\}\$\/\.test\(raw\)/);
  assert.match(read("public/automations.js"), /a short update when the office changes their tasks or the event/);
  assert.match(read("public/page-tours.js"), /title: "Permanent task link"/);
});

console.log(`\nr172-update-notices: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
