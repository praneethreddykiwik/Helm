// R187: a "can't work" day is a REQUEST the office approves (0370): 7-day notice checked on the server in the studio time zone,
// bell + e-mail to the office (in-app only on a free trial), approve / turn down with a note on the Staff page, the staff member
// sees the answer on their link and taps "OK, got it", assign warnings say pending vs approved, old marked days stay approved.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cantworkMessage, cantworkHtml, cantworkLink, CANTWORK_KINDS } from '../supabase/functions/comms-dispatch/cantwork-email.mjs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); } };

const MIG = read('supabase/migrations/0370_r187_cantwork_approval.sql');
const APPLY = read('supabase/APPLY-0370.sql');
const MF = read('supabase/migrations/MANIFEST');
const RUNALL = read('scripts/db-test/run-all.sh');
const RET = read('tests/db/trial-retention-0184.sql');
const OVR = read('supabase/check-prod-overrides.json');
const API = read('public/store-api.js');
const SELF = read('public/crew-self.js'), HOME = read('public/staff-home.js'), SHIFTS = read('public/crew-shifts.js'), CSS = read('public/crew-shifts.css');
const OPS = read('public/ops.html'), STAFF = read('public/staff.html'), SCHED = read('public/crew-schedule.js'), CAL = read('public/calendar.html');
const MON = read('public/monitor.js'), TOURS = read('public/page-tours.js');
const CD = read('supabase/functions/comms-dispatch/index.ts'), RT = read('supabase/functions/_shared/reply-to.mjs');
const code = (s) => s.replace(/^\s*--.*$/gm, '');

await t('0370: additive only - new nullable columns, guarded constraints, no drop / delete / truncate, no mass update', () => {
  for (const c of ['approval', 'requested_at', 'decided_at', 'decided_by', 'decision_note', 'ack_at'])
    assert.match(MIG, new RegExp('alter table public\\.crew_availability add column if not exists ' + c + ' '));
  assert.doesNotMatch(MIG, /add column if not exists approval text (not null|default)/, 'empty approval = approved (grandfathered by default, not by an update)');
  assert.doesNotMatch(code(MIG), /\bdrop\s+(table|function|policy|index|trigger|column|constraint)\b|\bdelete\s+from\b|\btruncate\b/i);
  // every UPDATE of crew_availability is scoped to one row / one person (never the whole table)
  for (const m of code(MIG).matchAll(/update public\.crew_availability\b[\s\S]*?;/g)) assert.match(m[0], /where (id = |crew_id = )/, m[0].slice(0, 120));
  assert.match(MIG, /if not exists \(select 1 from pg_constraint where conrelid = 'public\.crew_availability'::regclass and conname = 'crew_availability_approval_r370'\)/);
});

await t('0370: e-mail queue closed (RLS, no grants, outbox guards, trial purge), definer functions with a fixed search_path', () => {
  assert.match(MIG, /create table if not exists public\.cantwork_email_outbox \(/);
  assert.match(MIG, /alter table public\.cantwork_email_outbox enable row level security;/);
  assert.match(MIG, /revoke all on table public\.cantwork_email_outbox from authenticated/);
  for (const tg of ['zzz_studio_read_only', 'zzz_sq164_system_skip', 'zzzz_ts166_outbox_skip']) assert.ok(MIG.includes("tgname = '" + tg + "'"), tg);
  assert.match(MIG, /'''cantwork_email_outbox'', ''crew_availability'''/);
  const defs = [...MIG.matchAll(/create or replace function (public\.[a-z0-9_]+)\([^)]*\)\s*returns[^$]*?(security definer)?\s*set search_path = ''/g)];
  assert.ok(defs.length >= 20, 'functions found: ' + defs.length);
  const fns = [...MIG.matchAll(/create or replace function (public\.[a-z0-9_]+)\(/g)].map((m) => m[1]);
  for (const f of fns) assert.match(MIG, new RegExp('create or replace function ' + f.replace('.', '\\.') + '\\([^)]*\\)\\s*returns[\\s\\S]{0,120}?set search_path = \'\''), f + ' fixed search_path');
});

await t('0370: buffer on the SERVER, studio time zone, friendly sentence, studio setting 0..60 (default 7)', () => {
  assert.match(MIG, /v_today := public\._a198_org_today\(w\.org_id\);/);
  assert.match(MIG, /if v_fresh and p_day < v_today \+ v_buf then\s+raise exception '%', public\._r370_too_close\(v_buf\) using errcode = '22023', hint = 'cantwork_buffer';/);
  assert.ok(MIG.includes("'Too close - days within a week can''t be blocked here. Please call your manager.'"));
  assert.match(MIG, /c\.key = 'cantwork'\), 7\), 0\), 60\)::integer/);
  assert.match(MIG, /p_buffer_days < 0 or p_buffer_days > 60/);
  // the office grid has no buffer and approves at once
  const grid = MIG.slice(MIG.indexOf('create or replace function public.crew_availability_set('), MIG.indexOf('create or replace function public.cantwork_settings_get('));
  assert.doesNotMatch(grid, /_r370_buffer|too_close/);
  assert.match(grid, /case when p_status = 'unavailable' then 'approved' end/);
});

await t('0370: staff link calls verify the link; office calls check studio + RBAC; owner / admin always decide', () => {
  const set = MIG.slice(MIG.indexOf('create or replace function public.crew_set_availability('), MIG.indexOf('create or replace function public.crew_cantwork_ack('));
  assert.match(set, /w := public\._work_token_live\(p_token\);\s+c := public\._r23_crew_of_token\(w\);/);
  const ack = MIG.slice(MIG.indexOf('create or replace function public.crew_cantwork_ack('), MIG.indexOf('create or replace function public.staff_link_cantwork('));
  assert.match(ack, /_work_token_live\(p_token\)/); assert.match(ack, /crew_id = c\.id and org_id = w\.org_id/);
  assert.match(MIG, /perform public\._r341_limit\('staff_link', 600, 240\);\s+if p_token is null or p_token !~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(MIG, /coalesce\(public\.is_admin\(\), false\) or coalesce\(public\.has_area\('staff', 'edit'\), false\)/);
  assert.match(MIG, /select \* into a from public\.crew_availability x where x\.id = p_id and x\.org_id = v_org for update;/);
  assert.match(MIG, /'public\.cantwork_decide\(uuid,text,text\)'[\s\S]*?grant execute on function %s to authenticated/);
  assert.match(MIG, /'public\.crew_link_home__pre0370\(uuid\)'/);
});

await t('0370: office told (bell for everyone in the office, e-mail to owner / admin / manager / Staff editors), trial = in-app only', () => {
  const tell = MIG.slice(MIG.indexOf('create or replace function public._r370_tell_office('), MIG.indexOf('create or replace function public._r370_tell_staff('));
  assert.match(tell, /'in_app', 'crew_cantwork_request'/);
  assert.ok(tell.indexOf("'crew_cantwork_request'") < tell.indexOf('_tb179_no_send'), 'the bell row comes before the trial check');
  assert.match(tell, /if coalesce\(public\._tb179_no_send\(a\.org_id\), true\) then return; end if;   -- free trial/);
  assert.match(tell, /coalesce\(pr\.role, ''\) in \('admin', 'manager'\) or public\._r23_area\(a\.org_id, pr\.role, 'staff', 'edit'\)/);
  assert.match(tell, /not public\._r283_is_off\(pr\.id, a\.org_id\)/);
  const claim = MIG.slice(MIG.indexOf('create or replace function public.cantwork_email_claim('));
  assert.match(claim, /elsif coalesce\(public\._tb179_no_send\(r\.org_id\), true\) then v_why := 'trial';/);
});

await t('0370: editor-safe (ASCII, no apostrophes in comments), APPLY verbatim + verify block, MANIFEST, run-all, retention, check-prod', () => {
  assert.ok(/^[\x00-\x7f]*$/.test(MIG), 'ASCII only');
  assert.ok(!MIG.split('\n').some((l) => /^\s*--/.test(l) && l.includes("'")), 'no apostrophe in a comment');
  assert.doesNotMatch(code(MIG), /create\s+temp|set\s+(local\s+)?session|\\[a-z]/i);
  assert.equal(APPLY.slice(APPLY.indexOf('begin;\n') + 7, APPLY.indexOf('\ncommit;\n')).trim(), MIG.trim());
  assert.match(APPLY, /^-- APPLY-0370 \(R187 [^\n]*\)\. Run on STAGING first, then production\. Safe to run twice\.\n/);
  assert.match(MIG, /-- VERIFY every line should say true\nselect item, ok from \(values\n/);
  assert.ok(MF.includes('forward  supabase/migrations/0370_r187_cantwork_approval.sql'));
  assert.match(RUNALL, /R187-CANTWORK-APPROVAL-0370: ALL PASS/);
  assert.match(RET, /\\ir \.\.\/\.\.\/supabase\/migrations\/0370_r187_cantwork_approval\.sql/);
  const line = OVR.split('\n').find((l) => l.startsWith('  "0370": '));
  assert.ok(line && JSON.parse('{' + line.replace(/,\s*$/, '') + '}')['0370'].add.includes('marker public.crew_link_home(uuid) r187-0370'));
});

await t('store: requests / decide / ack / settings + permanent link calls; null before 0370; bell label + link', () => {
  assert.match(API, /async requests\(scope\) \{ if \(!supa\) return null; try \{ return await rpc\("cantwork_requests"/);
  assert.match(API, /decide: \(id, decision, note\) => rpc\("cantwork_decide"/);
  assert.match(API, /ack: \(token, day\) => wrpc\("crew_cantwork_ack"/);
  assert.match(API, /saveCantworkBuffer: \(days\) => rpc\("cantwork_settings_set"/);
  assert.match(API, /rpc\("staff_link_cantwork", \{ p_token: t \}\)/);
  assert.match(API, /crew_cantwork_request: \["🗓️"/);
  assert.match(API, /if \(k === "crew_cantwork_request"\) return "staff\.html#cantwork-requests";/);
});

await t('worker page: pending / approved, too-close days, decisions with OK got it, server sentence shown as is', () => {
  assert.match(SELF, /isLock = !isOff && !!firstDay && d < firstDay/);
  assert.match(SELF, /if \(lock\) \{ note\(card, tooClose\(buf\), "err"\); try \{ global\.BPUI\.toast\(tooClose\(buf\), \{ type: "err" \}\); \} catch \(e\) \{\} return; \}/);
  assert.ok(SELF.includes('"Too close - days within a week can\'t be blocked here. Please call your manager."'));
  assert.match(SELF, /e\.hint === "cantwork_buffer"/);
  assert.match(SELF, /text: "OK, got it"/); assert.match(SELF, /S\(\)\.ops\.shifts\.ack\(token, day\)/);
  assert.match(SELF, /"Waiting for approval" : "Approved"/);
  assert.match(HOME, /W\.staffCantworkAck\(TOKEN, d\)/); assert.match(HOME, /text: "OK, got it"/);
  assert.doesNotMatch(SELF + HOME, /innerHTML|insertAdjacentHTML/);
});

await t('office: Staff page list with badge, approve / turn down with a note, grid shows pending; settings buffer', () => {
  assert.match(STAFF, /<div class="card" id="cantwork-requests" hidden><\/div>\n  <div id="grid" class="grid">/);
  assert.match(SHIFTS, /cls: "cs-req-badge"/);
  assert.match(SHIFTS, /B\.ops\.shifts\.decide\(x\.id, decision,/);
  assert.match(SHIFTS, /cls: "cs-cell" \+ \(o \? \(ask \? " ask" : " off"\) : ""\)/);
  assert.match(SHIFTS, /await B\.ops\.shifts\.saveCantworkBuffer\(bv\)/);
  assert.match(CSS, /\.cs-day\.ask\{/); assert.match(CSS, /\.cs-req-badge\{/);
  assert.doesNotMatch(SHIFTS, /innerHTML|insertAdjacentHTML/);
});

await t('assigning: pending = asked off (waiting), approved = approved day off, never blocked', () => {
  assert.match(OPS, /offIds\.get\(c\.id\)\.pending\?" · ⏳ asked off this day \(waiting for approval\)":" · ⛔ approved day off"/);
  assert.match(OPS, /pending:x\.approval==="pending"/);
  assert.match(OPS, /You can still assign - you'll be asked to confirm\./);
  assert.match(API, /\(me\.approval === "pending" \? "asked for " : "on an approved day off on "\)/);
  assert.match(SCHED, /lead = pending \? "Asked off \(waiting\)" : "Can\\u2019t work"/);
  assert.match(CAL, /u\.approval==="pending"\?"asked for this day off \(waiting for approval\)":"has this day off \(approved\)"/);
  assert.match(MON, /S\.offAsk\[first\.crew_id\] \? "⏳ Asked for this day off - waiting for approval · "/);
  assert.match(read('public/task-status.js'), /case "dayoff_asked":/);   // R192: activity wording shared with Tasks & Crew (task-status.js)
});

await t('e-mails: request to the office, decision to the staff member, own links only, layout HTML', () => {
  const o = 'https://www.helm.events';
  const req = { kind: 'request', name: 'Asha Rao', studio: 'Aurora Events', worker: 'Ravi Kumar', day: '25/11/2026', weekday: 'Wed', note: 'Exam', link_path: 'staff.html#cantwork-requests' };
  const m = cantworkMessage(req, o);
  assert.equal(m.subject, 'Ravi Kumar asked for Wed 25/11/2026 off');
  assert.ok(m.text.includes('Reason: Exam') && m.text.includes(o + '/staff.html#cantwork-requests'));
  assert.ok(cantworkHtml(req, o).includes('Approve or turn down'));
  const dec = { kind: 'decision', name: 'Ravi Kumar', studio: 'Aurora Events', day: '25/11/2026', weekday: 'Wed', approval: 'rejected',
    decision_note: 'Big wedding', decided_by: 'Asha', link_path: 'work.html?staff=' + 'ab'.repeat(32) };
  const d = cantworkMessage(dec, o);
  assert.equal(d.subject, 'Day off not approved: Wed 25/11/2026');
  assert.ok(d.text.includes('Note from Asha: Big wedding') && d.text.includes('OK, got it'));
  assert.equal(cantworkMessage({ ...dec, approval: 'pending' }, o).text, '');
  assert.equal(cantworkLink({ ...dec, link_path: 'https://evil.example/x' }, o), '');
  assert.equal(cantworkLink({ ...req, link_path: 'work.html?staff=' + 'ab'.repeat(32) }, o), '', 'a request e-mail never carries a staff link');
  assert.equal(cantworkMessage({ ...req, day: '2026-11-25' }, o).text, '');
  assert.ok(!cantworkHtml({ ...req, worker: '<img src=x>' }, o).includes('<img src=x>'));
  assert.deepEqual(CANTWORK_KINDS, ['request', 'decision']);
  assert.match(CD, /admin\.rpc\("cantwork_email_claim", \{ p_limit: batch \}\)/);
  assert.match(CD, /admin\.rpc\("cantwork_email_mark", \{ p_id: id, p_status: res === "failed" \? "retry" : res \}\)/);
  assert.match(RT, /cantwork: "cantwork_email_outbox"/);
});

await t('page tour explains the Staff page requests', () => {
  assert.match(TOURS, /\{ sel: "#cantwork-requests", title: "Day-off requests"/);
});

console.log(`\nR187 cantwork approval: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
