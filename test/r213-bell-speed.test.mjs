// r213-bell-speed.test.mjs - R213 (prod pg_stat_statements 18 Nov 2026: bell_feed / my_pending / inbox = 28,075 calls x
// 262 ms, the biggest app-side database cost). The shape of the 0388 fix, read from the SQL files:
//   1. _r388_vis = the whole inbox rule in one pass, without details; every (kind, channel)-only rule decided per pair
//   2. _r23_visible = _r388_vis + the same cleaned-up details (money keys found once per distinct key, links / tokens out)
//   3. _r388_rows (flags without details) feeds _r23_counts (badge, my_pending) and the bell's inbox layer
//   4. packaging: kept __pre0388 bodies, guards, grants, APPLY-0388 checks, MANIFEST / checker / run-all / release lists
//   5. the client: the bell already polls only from a visible tab (no change needed, pinned here)
// Behaviour (old vs new answers per person): tests/db/r213-bell-speed-0388.sql.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const ROOT = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };
const MIG = read('supabase/migrations/0388_r213_bell_speed.sql'), APPLY = read('supabase/APPLY-0388.sql');
const body = (head) => { const i = MIG.indexOf(head); assert.ok(i >= 0, head); return MIG.slice(i, MIG.indexOf('\n$$', i)); };

t('_r388_vis: one pass, no detail column; the pair-only rules live in the per-pair ty step; notify-list kinds for the people on it', () => {
  const b = body('create or replace function public._r388_vis(p_org uuid, p_uid uuid)');
  assert.match(b, /returns table\(id uuid, kind text, channel text, status text, created_at timestamptz, quote_id uuid, ntype text\)/);
  assert.doesNotMatch(b, /\bdetail jsonb\b|_a42_redact_detail|jsonb_each|_a153_money_key/);
  const ty = b.slice(b.indexOf('ty as materialized'), b.indexOf('\n  )\n  select'));
  for (const rule of ["coalesce(k.kind, '') <> 'security_alert'", 'not (x.ty = any (me.hid))', 'not (x.ty = any (me.mut))',
                      "(me.qe or coalesce(k.kind, '') <> 'price_change')",
                      "(me.qv or coalesce(k.kind, '') !~ '(price|reapproval|payment|refund|invoice|bill|settle|pkg_pay|quote_|discount|budget)')",
                      "(me.cl or coalesce(k.kind, '') not in ('event_close_request', 'event_close_decision'))"]) assert.ok(ty.includes(rule), rule);
  assert.match(b, /coalesce\(n\.kind, ''\) not in \('task_escalated', 'vendor_bill_due', 'team_signin'\)\n\s+or \(jsonb_typeof\(n\.detail -> 'notify'\) = 'array' and \(n\.detail -> 'notify'\) \? p_uid::text\)/);
  assert.match(b, /n\.kind = 'client_view_followup'/);
  assert.match(b, /language sql stable security definer set search_path = '' as \$\$\n  -- r213-0388/);
});
t('_r23_visible: _r388_vis + details; money keys once per distinct key; redaction helper kept; a null detail is {} without Quotes view', () => {
  const b = body('create or replace function public._r23_visible(p_org uuid, p_uid uuid)');
  assert.match(b, /cross join public\._r388_vis\(p_org, p_uid\) l\n\s+join public\.notifications n on n\.id = l\.id/);
  assert.match(b, /dk as materialized \([\s\S]*select distinct e\.k[\s\S]*where not me\.qv and n\.org_id = p_org/);
  assert.match(b, /mk as materialized \(\s+-- the money keys among them\n\s+select coalesce\(array_agg\(z\.k\), '\{\}'::text\[\]\) as a from dk z where public\._a153_money_key\(z\.k\)/);
  assert.match(b, /from \(select public\._a42_redact_detail\(n\.detail\) as d offset 0\) dd\)/);
  assert.match(b, /when me\.qv then dd\.d\n\s+when dd\.d is null then '\{\}'::jsonb\n\s+when jsonb_typeof\(dd\.d\) <> 'object' then dd\.d/);
  assert.match(b, /~\* '\(price\|total\|amount\|paid\|rs\\\.\|inr\)' then \(dd\.d - mk\.a\) - 'message'/);
  for (const m of ['r24-ci-0270', 'r163-0357', 'r186-0369', 'r190-0373', 'r205-0383', 'r213-0388']) assert.ok(b.includes(m), 'marker ' + m);
});
t('_r388_rows = the 0266 unread / Done / snooze rule without details; _r23_counts and the bell inbox layer read it', () => {
  const r = body('create or replace function public._r388_rows(p_org uuid, p_uid uuid)');
  assert.match(r, /from public\._r388_vis\(p_org, p_uid\) v\n\s+left join public\.notification_inbox_state st on st\.user_id = p_uid and st\.notification_id = v\.id/);
  assert.doesNotMatch(r.replace(/--[^\n]*/g, ""), /detail/);
  assert.match(body('create or replace function public._r23_counts(p_org uuid, p_uid uuid)'), /from public\._r388_rows\(p_org, p_uid\) r;/);
  const bf = body('create or replace function public.bell_feed__pre0299(p_limit integer default 20)');
  assert.match(bf, /with r as materialized \(select \* from public\._r388_rows\(v_org, v_uid\)\)/);
  assert.match(bf, /'detail', public\._r23_detail\(n\.detail, \(select public\._r23_area\(v_org, p\.role, 'quotes', 'view'\)/);
  assert.match(bf, /order by r\.sort_at desc limit 10\) r\n\s+join public\.notifications n on n\.id = r\.id/);
  assert.match(bf, /exception when others then\n\s+raise warning 'r23-inbox-0266: bell inbox state skipped \(%\)', sqlstate;\n\s+return v;/);
});
t('bell_feed__pre0042: the shown rows kept as (id, created_at) only, details read for the listed rows; same count', () => {
  const b = body('create or replace function public.bell_feed__pre0042(p_limit integer default 20)');
  assert.match(b, /ok as materialized \(\n\s+select n\.id, n\.created_at from public\.notifications n/);
  assert.match(b, /top as \(\n\s+select o\.id from ok o order by o\.created_at desc limit greatest\(1, least\(coalesce\(p_limit, 20\), 100\)\)/);
  assert.match(b, /from top\n\s+join public\.notifications n on n\.id = top\.id\n\s+left join public\.quotes q on q\.id = n\.quote_id/);
  assert.match(b, /'unread', \(select count\(\*\) from ok n where n\.created_at > seen\)/);
  assert.match(b, /raise exception 'not authenticated' using errcode = '42501'/);
  for (const m of ['notification-prefs-0036', 'r163-0357', 'r213-0388']) assert.ok(b.includes(m), m);
});
t('kept once as __pre0388, only from the known bodies; re-run safe (own body or a known older wrapper put back)', () => {
  for (const [f, a] of [['_r23_visible', 'uuid, uuid'], ['_r23_counts', 'uuid, uuid'], ['bell_feed__pre0299', 'integer'], ['bell_feed__pre0042', 'integer']]) {
    assert.ok(MIG.includes(`alter function public.${f}(${a}) rename to ${f}__pre0388;`), f);
  }
  assert.equal((MIG.match(/raise notice '0388: [^']*left unchanged'/g) || []).length, 8);
  assert.match(MIG, /position\('r205-0383' in v_src\) > 0 and position\('from public\._r23_visible__pre0383\(p_org, p_uid\) v' in v_src\) > 0/);
});
t('read-only + additive: no table / row / policy change, ASCII, definer + empty search_path, server-only grants', () => {
  assert.doesNotMatch(MIG, /\b(delete\s+from|drop\s+table|truncate|alter\s+table|create\s+policy|drop\s+policy|insert\s+into|update\s+public\.)\b/i);
  assert.doesNotMatch(MIG, /[^\x00-\x7F]/, 'ASCII only');
  assert.equal((MIG.match(/language (sql|plpgsql) stable security definer set search_path = ''/g) || []).length, 6);
  assert.match(MIG, /execute format\('revoke all on function %s from authenticated', f\)/);
  assert.match(MIG, /execute format\('revoke all on function %s from service_role', f\)/);
});
t('APPLY-0388: begin + the whole migration + 8 all-true checks + commit; paste-safe', () => {
  assert.match(APPLY, /^-- APPLY-0388 /); assert.ok(APPLY.includes(MIG.trim()), 'the whole migration inside');
  assert.match(APPLY, /\nbegin;\n/); assert.match(APPLY, /select item, ok from \(values\n[\s\S]*\) v\(item, ok\) order by item;\ncommit;\n$/);
  assert.equal((APPLY.match(/^  \('0\d /gm) || []).length, 8);
  assert.match(APPLY, /08 same answers on THIS database/);
  assert.doesNotMatch(APPLY, /create temp|temporary table|^\\/im);
  assert.doesNotMatch(APPLY, /[^\x00-\x7F]/, 'ASCII only');
});
t('MANIFEST + checker overrides + generated checker + run-all + release lists know 0388', () => {
  assert.match(read('supabase/migrations/MANIFEST'), /\nforward  supabase\/migrations\/0388_r213_bell_speed\.sql\n/);
  const ov = JSON.parse(read('supabase/check-prod-overrides.json'));
  assert.deepEqual(ov['0388'].add, ['marker public._r388_vis(uuid,uuid) r213-0388', 'marker public._r388_rows(uuid,uuid) r213-0388',
    'marker public._r23_visible(uuid,uuid) r213-0388', 'marker public._r23_counts(uuid,uuid) r213-0388', 'marker public.bell_feed__pre0299(integer) r213-0388',
    'marker public.bell_feed__pre0042(integer) r213-0388']);
  const chk = read('supabase/CHECK-PROD-MIGRATIONS.sql');
  assert.match(chk, /\('0388_r213_bell_speed', 'marker', 'public', '_r23_visible', 'uuid,uuid\|r213-0388'\)/);
  assert.match(chk, /\('0388_r213_bell_speed', 'fn', 'public', '_r388_vis', 'uuid,uuid'\)/);
  assert.match(read('scripts/db-test/run-all.sh'), /run "r213-bell-speed-0388" "R213-BELL-SPEED-0388: ALL PASS \\\(14\/14\\\)" psql -q -f tests\/db\/r213-bell-speed-0388\.sql/);
  for (const f of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.match(read(f), /'0387', '0388'(, '\d{4}')*\]/, f);
});
t('client: the bell poll already skips hidden tabs and other tabs of the same person (nothing to change)', () => {
  const s = read('public/store-api.js');
  assert.match(s, /setInterval\(\(\) => \{ if \(kicked && !document\.hidden && !isOpen && Date\.now\(\) >= feedBackoffUntil && Date\.now\(\) - lastRf >= pollMs\(\) - 1000 && !otherTabPolled\(pollMs\(\) - 2000\)\) refresh\(\); \}, 30000\);/);
  assert.match(s, /const BELL_PAGE = 10, BELL_MAX = 100;/);
});

console.log(`r213-bell-speed: ${n} passed`);
