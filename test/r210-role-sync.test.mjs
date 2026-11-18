// r210-role-sync.test.mjs - R210 (owner 18 Nov 2026, Settings -> Users & invites): "Even if I change this to Event
// manager, the person is getting Admin" + "the same e-mail in both studios - check it out".
//   1. team-status.js roleSaved(): the words after a role change come from the role the DATABASE holds on a fresh read
//   2. control.html: the role drop-down no longer writes the picked role into its own copy - it re-reads the team
//      (renderUsers -> true / false) and shows roleSaved(); nothing sent -> the saved value again; refused -> error
//   3. 0386 + APPLY-0386 + MANIFEST + checker overrides + run-all wiring; asset pin team-status.js v4 (above R211 v3)
// Behaviour of 0386: tests/db/r210-role-sync-0386.sql.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ROOT = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };
const TS = require('../public/team-status.js');
const CTL = read('public/control.html');
const label = (r) => ({ admin: 'Admin', manager: 'Event manager', planner: 'Planner' })[r] || r;

/* ---------------------------------------------------------------- 1. roleSaved */
t('roleSaved: the database holds the picked role -> ok, words from the saved role', () => {
  const o = TS.roleSaved('manager', 'manager', true, label);
  assert.equal(o.ok, true); assert.equal(o.tone, 'ok'); assert.equal(o.text, 'Role saved: Event manager.');
});
t('roleSaved: the database still holds the old role -> NOT ok, says what Helm has (never the picked one)', () => {
  const o = TS.roleSaved('manager', 'admin', true, label);
  assert.equal(o.ok, false); assert.equal(o.tone, 'err');
  assert.match(o.text, /NOT changed/); assert.match(o.text, /still has them as Admin/); assert.doesNotMatch(o.text, /Event manager/);
});
t('roleSaved: the fresh read failed / the person is missing -> not ok, asks for a reload (no claim either way)', () => {
  for (const o of [TS.roleSaved('manager', 'manager', false, label), TS.roleSaved('manager', null, true, label), TS.roleSaved('manager', '', true)]) {
    assert.equal(o.ok, false); assert.match(o.text, /Reload this page/);
  }
});
t('roleError: the database refusals of a role change in plain words; anything else -> "" (the usual text)', () => {
  assert.match(TS.roleError(new Error('a studio must keep at least one admin - make someone else admin first')), /keep at least one Admin/);
  assert.match(TS.roleError(new Error('you cannot remove your own admin role')), /can't remove your own Admin role/);
  assert.match(TS.roleError(new Error('no such user')), /no longer in your studio/);
  assert.match(TS.roleError(new Error('invalid role: boss')), /isn't available/);
  assert.equal(TS.roleError(new Error('not authorized')), ''); assert.equal(TS.roleError(null), '');
});
t('roleSaved: without a label function the role key is shown', () => {
  assert.equal(TS.roleSaved('planner', 'planner', true).text, 'Role saved: planner.');
});

/* ---------------------------------------------------------------- 2. control.html */
const handler = CTL.slice(CTL.indexOf('tb.querySelectorAll(".roleSel").forEach'), CTL.indexOf('tb.querySelectorAll(".dnEdit")'));
t('the role drop-down never keeps the picked role as the truth (no optimistic copy, no bare "Role updated.")', () => {
  assert.ok(handler.length > 500, 'handler found');
  assert.doesNotMatch(handler, /u\.role=role/);
  assert.doesNotMatch(handler, /o\.defaultSelected=o\.value===role/);
  assert.doesNotMatch(handler, /setUMsg\("ok","Role updated\."\)/);
});
t('after a change: the team is read again and the message comes from the saved role (roleSaved)', () => {
  assert.match(handler, /const loaded=await renderUsers\(\), u=\(ucRows\|\|\[\]\)\.find\(x=>ucId\(x\)===id\);/);
  assert.match(handler, /HelmTeamStatus\.roleSaved\(role, u&&u\.role, loaded!==false&&!!u, BPStore\.auth\.admin\.roleLabel\)/);
  assert.match(handler, /setUMsg\(out\.ok\?"ok":"err", out\.text\)/);
});
t('nothing sent (guard answered undefined) -> the saved value again + why; refused -> the error + the saved value again', () => {
  assert.match(handler, /if\(r===undefined\)\{ if\(prev\) e\.target\.value=prev\.value; setUMsg\("err",/);
  assert.match(handler, /catch\(err\)\{ const rt=[^\n]*HelmTeamStatus\.roleError\(err\)/);
  assert.match(handler, /HelmTeam\.errText\(err\):rt\|\|errMsg\(err,"change the role"\)\); if\(prev\) e\.target\.value=prev\.value; \}/);
  // the 24-hour path is unchanged (asked, the drop-down shows the saved role, the team is read again)
  assert.match(handler, /if\(r&&r\.scheduled\)\{ if\(prev\) e\.target\.value=prev\.value; setUMsg\("ok","Asked\./);
});
t('renderUsers answers whether the fresh read worked (false on a load error, true after drawing)', () => {
  const ru = CTL.slice(CTL.indexOf('async function renderUsers(){'), CTL.indexOf('function drawUsers(){'));
  assert.match(ru, /BPUI\.loadError\(tb, e, renderUsers, \{what:"team members"\}\); return false; \}/);
  assert.match(ru, /drawUsers\(\);\n    return true;/);
});
t('asset pin: team-status.js v4 on Settings + Staff', () => {
  for (const f of ['public/control.html', 'public/staff.html']) assert.match(read(f), /<script src="team-status\.js\?v=4"><\/script>/, f);
});

/* ---------------------------------------------------------------- 3. 0386 wiring */
const MIG = read('supabase/migrations/0386_r210_role_sync.sql'), APPLY = read('supabase/APPLY-0386.sql');
t('0386: two definer trigger functions with the r210-0386 marker, empty search_path, closed to the app; triggers after update of role / org_id', () => {
  for (const f of ['_r386_tg_role_sync', '_r386_tg_left_studio']) {
    assert.match(MIG, new RegExp(`create or replace function public\\.${f}\\(\\)\\nreturns trigger language plpgsql security definer set search_path = '' as \\$\\$\\n-- r210-0386`));
    assert.match(MIG, new RegExp(`revoke all on function public\\.${f}\\(\\) from authenticated`));
  }
  assert.match(MIG, /create trigger zzzzz_r386_role_sync after update of role on public\.profiles/);
  assert.match(MIG, /create trigger zzzzz_r386_left_studio after update of org_id on public\.profiles/);
});
t('0386 is additive: no delete / drop table / truncate; invitations closed (accepted by them), staff words only while they show the old role', () => {
  assert.doesNotMatch(MIG, /\bdelete\s+from\b|\bdrop\s+table\b|\btruncate\b|\bdrop\s+function\s+(?!if exists public\._r386)/i);
  assert.match(MIG, /set status = 'accepted', accepted_at = now\(\), accepted_by = new\.id/);
  assert.match(MIG, /lower\(btrim\(coalesce\(c\.role, ''\)\)\) = any \(v_old_words\)/);
  assert.match(MIG, /u\.raw_user_meta_data \? 'role'/);
  assert.match(MIG, /'team\.invite\.superseded'/); assert.match(MIG, /'staff\.login_unlinked'/);
  assert.doesNotMatch(MIG, /[^\x00-\x7F]/, 'ASCII only');
});
t('APPLY-0386: begin + the migration + all-true checks + commit (paste-safe: no temp tables, no psql meta commands)', () => {
  assert.match(APPLY, /^-- APPLY-0386 /); assert.ok(APPLY.includes(MIG.trim()), 'the whole migration inside');
  assert.match(APPLY, /\nbegin;\n/); assert.match(APPLY, /select item, ok from \(values\n[\s\S]*\) v\(item, ok\) order by item;\ncommit;\n$/);
  assert.doesNotMatch(APPLY, /create temp|temporary table|^\\/im);
  assert.doesNotMatch(APPLY, /[^\x00-\x7F]/, 'ASCII only');
});
t('MANIFEST + checker overrides + generated checker + run-all + release lists know 0386', () => {
  assert.match(read('supabase/migrations/MANIFEST'), /\nforward  supabase\/migrations\/0386_r210_role_sync\.sql\n/);
  const ov = JSON.parse(read('supabase/check-prod-overrides.json'));
  assert.deepEqual(ov['0386'].add, ['marker public._r386_tg_role_sync() r210-0386', 'marker public._r386_tg_left_studio() r210-0386']);
  const chk = read('supabase/CHECK-PROD-MIGRATIONS.sql');
  assert.match(chk, /\('0386_r210_role_sync', 'trg', 'public\.profiles', 'zzzzz_r386_role_sync', null\)/);
  assert.match(chk, /\('0386_r210_role_sync', 'marker', 'public', '_r386_tg_role_sync', '\|r210-0386'\)/);
  assert.match(read('scripts/db-test/run-all.sh'), /run "r210-role-sync-0386" "R210-ROLE-SYNC-0386: ALL PASS \\\(16\/16\\\)" psql -q -f tests\/db\/r210-role-sync-0386\.sql/);
  for (const f of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.match(read(f), /'0385', '0386'(, '\d{4}')*\]/, f);
});

console.log(`r210-role-sync: ${n} passed`);
