// r245-p6-account-safety.test.mjs - R245 fix plan Phase 6 "Account and team safety" shape + UI checks, no database:
// migrations 0413-0415 + their APPLY files are additive, ASCII, paste-safe; the auth.users guard is BEFORE DELETE, fails
// open and keeps the existing purge marks; the HQ report is read-only; the HQ actions need two-step + a reason and never
// delete; ROLE-03 asks before money access for a Crew / view-only role; ACC-20 "Reassign to ..." uses the existing calls;
// HQ shows Account checks + Make admin / Deactivate login. The database side: tests/db/r245-p6-account-safety-0413-0415.sql.
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const NUMS = ['0413', '0414', '0415'];
const MIG = Object.fromEntries(NUMS.map((n) => [n, rd('supabase/migrations/' + readdirSync(new URL('../supabase/migrations/', import.meta.url)).find((f) => f.startsWith(n + '_')))]));
const APPLY = Object.fromEntries(NUMS.map((n) => [n, rd(`supabase/APPLY-${n}.sql`)]));
const MF = rd('supabase/migrations/MANIFEST'), RA = rd('scripts/db-test/run-all.sh'), CHK = rd('supabase/CHECK-PROD-MIGRATIONS.sql');
const J = rd('public/hq.js'), H = rd('public/hq.html'), C = rd('public/control.html'), TS = rd('public/team-safety.js'), RDF = rd('public/role-defaults.js'), PT = rd('public/page-tours.js');
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };
const code = (s) => s.replace(/^\s*--.*$/gm, '');

t('migrations + APPLY: ASCII, no temp table / session state, nothing dropped (except re-creating its own trigger), deleted or truncated', () => {
  for (const nn of NUMS) {
    for (const [f, s] of [[nn, MIG[nn]], ['APPLY-' + nn, APPLY[nn]]]) {
      assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(s), f + ' ASCII');
      assert.ok(!/\bcreate\s+(temp|temporary)\s+table\b/i.test(s), f + ' temp table');
      const c = code(s).replace(/drop trigger if exists a0_r413_login_delete_guard on auth\.users;/g, '');
      assert.ok(!/\b(drop\s+(table|function|trigger|index|column|view|policy)|truncate|delete\s+from|alter\s+table)\b/i.test(c), f + ' drop / delete / truncate / alter table');
      assert.ok(!/\bset\s+(session\b|role\s+(?!=))/i.test(c), f + ' session state');
      assert.ok(!/^\s*\\/m.test(s), f + ' psql meta-command');
    }
  }
});
t('APPLY-0413..0415: begin + lock_timeout 5s + statement_timeout 5min first, the migration verbatim, 4 check rows, commit; auth files say staging first + a day', () => {
  for (const nn of NUMS) {
    const sql = APPLY[nn].replace(/^--.*\n/gm, '');
    assert.match(sql, /^begin;\nset local lock_timeout = '5s';\nset local statement_timeout = '5min';\n/);
    assert.ok(APPLY[nn].includes(MIG[nn]), nn + ' verbatim');
    assert.match(APPLY[nn], /\ncommit;\n?$/);
    assert.equal((APPLY[nn].match(/^  select '0\d /gm) || []).length + (APPLY[nn].match(/^  select '0\d [^']*' as item/gm) ? 0 : 0), 4, nn + ' 4 check rows');
  }
  for (const nn of ['0413', '0415']) assert.match(APPLY[nn], /run on STAGING first and leave it there for a day before production/);
});
t('0413 ACC-05: BEFORE DELETE row guard on auth.users, definer + empty search_path, used studio logins only, fails open, purge marks + owner flag honoured', () => {
  const s = MIG['0413'];
  assert.match(s, /create trigger a0_r413_login_delete_guard before delete on auth\.users\s+for each row execute function public\._r413_tg_login_delete_guard\(\)/);
  assert.match(s, /function public\._r413_tg_login_delete_guard\(\)\nreturns trigger language plpgsql security definer set search_path = ''/);
  assert.match(s, /exception when others then v_block := false;   -- a bug in the check never blocks/);
  assert.match(s, /coalesce\(j ->> 'email_confirmed_at', j ->> 'phone_confirmed_at', j ->> 'last_sign_in_at'\) is not null/);
  assert.match(s, /current_setting\('helm\.allow_login_delete', true\)/);
  assert.match(s, /public\._r55_purge_allowed\(p_org, false\)/);
  assert.match(s, /hint = 'login_delete_refused'/);
  assert.match(s, /exception when insufficient_privilege then/);
});
t('0414 ACC-03 / ACC-04: HQ People access, read-only (no insert except the view row, no update / delete), masked, never merged', () => {
  const s = MIG['0414'], body = s.slice(s.indexOf('create or replace function public.hq_account_checks'), s.indexOf('revoke all on function public._r414_email_key'));
  assert.match(body, /perform public\._hq27_require\('people\.read', false\);/);
  assert.equal((code(body).match(/\binsert into\b/g) || []).length, 1);
  assert.match(body, /'hq\.view', 'hq_account_checks'/);
  assert.ok(!/\bupdate\s+public\.|\bdelete\b/i.test(code(body).replace(/'[^']*'/g, '')), 'no update / delete');
  assert.match(body, /u\.email_confirmed_at is null and u\.last_sign_in_at is null/);
  assert.match(body, /coalesce\(p\.role, ''\) <> 'client'/);
  assert.match(body, /public\._r57_mask_email/);
  assert.ok(!/'phone'\s*,\s*[a-z]/i.test(body), 'never returns a phone number');
});
t('0415 ACC-18 / ACC-24: HQ two-step (aal2) + role + reason first, the 0283 deactivate path, never delete, owner / last admin protected', () => {
  const s = MIG['0415'];
  assert.match(s, /coalesce\(auth\.jwt\(\) ->> 'aal', ''\) <> 'aal2'/);
  assert.match(s, /perform public\._hq27_require\(public\._hq27_write_perm\(p_action\), true\);/);
  assert.match(s, /char_length\(v_reason\) < 20 or char_length\(v_reason\) > 1000/);
  assert.match(s, /public\._r283_do_deactivate\(p_org, p_user,/);
  assert.match(s, /hint = 'owner_protected'/);
  assert.match(s, /hint = 'last_admin'/);
  assert.match(s, /hint = 'rate_limited'/);
  assert.ok(!/\bdelete\b/i.test(code(s).replace(/'[^']*'/g, '')), 'no delete');
  for (const f of ['hq_studio_member_promote', 'hq_studio_member_deactivate']) assert.match(s, new RegExp(`grant execute on function public\\.${f}\\(uuid, uuid, text\\) to authenticated`));
});
t('MANIFEST + run-all + prod checker know 0413-0415 in order', () => {
  const nums = [...MF.matchAll(/^forward\s+supabase\/migrations\/(\d{4})_/gm)].map((m) => m[1]);
  const i = nums.indexOf('0412');
  assert.deepEqual(nums.slice(i, i + 4), ['0412', '0413', '0414', '0415']);
  assert.match(RA, /run "r245-p6-account-safety-0413-0415" "R245-P6-ACCOUNT-SAFETY-0413-0415: ALL PASS \\\(40\/40\\\)"/);
  assert.match(RA, /run "r245-apply-0413-0415" "APPLY-0413-0415: ALL OK"/);
  // owner decision 20 Nov: Phase 9 (0423-0425) is ON HOLD - APPLY-0413..0415 are proven on a DB without 0423-0425
  assert.match(RA, /^run "r245-apply-order-0413" "R245-APPLY-ORDER-0413: PASS" bash tests\/db\/r245-apply-order-0413\.sh$/m);
  const ORD = readFileSync(new URL('../tests/db/r245-apply-order-0413.sh', import.meta.url), 'utf8');
  assert.match(ORD, /\*041\[345\]_r245_\*\|\*042\[345\]_r246_\*\) continue;;/);
  assert.match(ORD, /for k in 1 2; do\n  for f in 0413 0414 0415;/);
  for (const nn of NUMS) assert.ok(CHK.includes(MIG[nn] ? '_r245_' : 'x') && CHK.includes(`'${nn}_r245_`), nn + ' in CHECK-PROD');
});
t('ROLE-03: money access for a Crew / view-only role asks first (pure helper + the matrix uses it)', () => {
  const w = {}; vm.runInNewContext(RDF, { window: w, globalThis: w });
  const RD = w.HelmRoleDefaults;
  assert.ok(RD.moneyGrantAsk('crew', 'finance', { view: false, edit: false }, { view: true, edit: false }, 'Crew', 'Budget & finance'));
  assert.ok(RD.moneyGrantAsk('client', 'business', { view: true, edit: false }, { view: true, edit: true }));
  assert.ok(RD.moneyGrantAsk('crew', 'discount_approve', {}, { view: true, edit: true }));
  assert.equal(RD.moneyGrantAsk('crew', 'finance', { view: true, edit: false }, { view: false, edit: false }), null, 'taking access away: no question');
  assert.equal(RD.moneyGrantAsk('manager', 'finance', {}, { view: true, edit: true }), null, 'not a view role');
  assert.equal(RD.moneyGrantAsk('crew', 'runsheet', {}, { view: true }), null, 'not a money area');
  assert.match(C, /const ask=RD\.moneyGrantAsk\?RD\.moneyGrantAsk\(role, area, cur, \{view, edit\}/);
  assert.match(C, /title:"Give money access\?"/);
});
t('ACC-20: "Reassign to ..." after a deactivation / Open work uses the existing calls only (reassign_task, event manager, lead owner)', () => {
  const w = {}; vm.runInNewContext(TS, { window: w, globalThis: w, document: undefined, encodeURIComponent });
  const plan = w.HelmTeam.reassignPlan({ tasks: [{ id: 't1' }, { id: 't2' }], events: [{ quote_id: 'q1' }], leads: [{ id: 'l1' }] }, 'u2',
    [{ id: 'c9', name: 'Other', profile_id: 'u9' }, { id: 'c2', name: 'Two', phone: '+919800000000', profile_id: 'u2' }]);
  assert.deepEqual(plan.tasks.map((x) => [x.id, x.crew.id]), [['t1', 'c2'], ['t2', 'c2']]);
  assert.deepEqual([plan.events, plan.leads, plan.noStaff], [['q1'], ['l1'], 0]);
  const p2 = w.HelmTeam.reassignPlan({ tasks: [{ id: 't1' }] }, 'u3', []);
  assert.deepEqual([p2.tasks.length, p2.noStaff], [0, 1]);
  assert.match(C, /task:\(taskId,c\)=>BPStore\.ops\.reassign\(taskId, c\.id, c\.name, c\.phone\)/);
  assert.match(C, /event:\(quoteId,userId\)=>BPStore\.ops\.setEventManager\(quoteId, userId\)/);
  assert.match(C, /lead:\(leadId,userId\)=>BPStore\.leads\.update\(leadId, \{owner:userId\}\)/);
  assert.match(C, /HelmTeam\.paintWork\(\$\("#team_work"\), u\.full_name\|\|email, r\.open_work, await umWorkOpts\(u\)\)/);
  assert.match(TS, /"Reassign to "/);
  assert.ok(!/innerHTML/.test(TS.slice(TS.indexOf('R245 (ACC-20)'))), 'no innerHTML');
});
t('HQ: Account checks card (read-only) + Make admin / Deactivate login (HQ Owner only, reason, confirm); tours updated', () => {
  assert.match(H, /id="btnAcc"/);
  assert.match(H, /Nothing is deleted or merged here/);
  assert.match(J, /call\("hq_account_checks", \{ p_days: days \}\)/);
  assert.match(J, /if \(!can\("owner\.only"\)\)/);
  assert.match(J, /reason\.length < 20/);
  assert.match(J, /window\.confirm\(verb/);
  for (const sel of ['#btnAcc', '#team_work']) assert.ok(PT.includes(`"${sel}"`), 'tour ' + sel);
  assert.match(PT, /make a member admin or deactivate a login/);
  assert.match(PT, /Giving Crew or a view-only role a money area asks/);
});
console.log(`r245-p6-account-safety: ${n} checks passed`);
