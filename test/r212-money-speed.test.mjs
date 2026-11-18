// r212-money-speed.test.mjs - R212 (prod pg_stat_statements 18 Nov 2026): event money reads slow (up to 1 s average,
// 6.3 s slowest; event_money_header answered 500 after the 8 s statement timeout).
//   1. 0387: event_money_header / event_money_cash build the cost ledger ONCE (_r21_event_money with lines, then
//      _r387_event_pnl from it) instead of _vb_event_pnl + _r21_event_money; old bodies kept as __pre0387, server only
//   2. 0387: the kept ledger body _r21_cost_lines__pre0372 re-issued with exactly five "offset 0" fences, nothing else changed
//   3. _r387_event_pnl is the _vb_event_pnl__pre0372 + _vb_event_pnl steps, composed from the caller's ledger
//   4. APPLY-0387 + MANIFEST + checker overrides + generated checker + run-all + release lists
// Behaviour (byte-identical answers vs the old chain, ledger calls 2 -> 1): tests/db/r212-money-speed-0387.sql.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const ROOT = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };

const MIG = read('supabase/migrations/0387_r212_money_speed.sql'), APPLY = read('supabase/APPLY-0387.sql');
const fnBody = (src, sig) => {
  const i = src.indexOf('create or replace function public.' + sig);
  assert.ok(i >= 0, sig);
  const j = src.indexOf('\nend $$;', i);
  return src.slice(i, j + 8);
};
const HDR = fnBody(MIG, 'event_money_header(p_quote uuid)'), CASH = fnBody(MIG, 'event_money_cash(p_quote uuid)');
const LEDGER = fnBody(MIG, '_r21_cost_lines__pre0372(p_quote uuid, p_org uuid)'), PNL = fnBody(MIG, '_r387_event_pnl(p_quote uuid, p_org uuid, p_money jsonb)');

t('0387: header + cash build the ledger once - _r21_event_money(.., true) then _r387_event_pnl, no _vb_event_pnl call left', () => {
  for (const [name, b] of [['header', HDR], ['cash', CASH]]) {
    assert.match(b, /returns jsonb language plpgsql stable security definer set search_path = '' as \$\$\n-- r212-0387: /, name);
    assert.equal((b.match(/public\._r21_event_money\(/g) || []).length, 1, name + ': one ledger');
    assert.ok(b.includes('v_live_m := public._r21_event_money(p_quote, v_org, true);\n  v_pnl := public._r387_event_pnl(p_quote, v_org, v_live_m);'), name);
    assert.ok(!b.includes('public._vb_event_pnl('), name);
    assert.ok(b.includes("if v_money is null then v_money := coalesce(v_live_m, '{}'::jsonb); end if;"), name);
    assert.ok(b.includes("coalesce(public.user_role(), '') = 'client' or not public.has_area('finance', 'view')"), name + ': access check kept');
  }
  assert.ok(HDR.includes('-- r197-0376: read-only.'), 'old header marker kept'); assert.ok(CASH.includes('-- r198-0377: read-only.'), 'old cash marker kept');
});
t('0387: the kept ledger body is re-issued with exactly five offset 0 fences (markers kept)', () => {
  assert.equal((LEDGER.match(/ offset 0\) /g) || []).length, 5);
  assert.ok(LEDGER.includes('-- r212-0387: the same ledger as before'));
  assert.ok(LEDGER.includes('-- r21-money-0246 (r22-money-0252:') && LEDGER.includes('-- r23-crew-0265:'));
  assert.ok(LEDGER.includes('public._r25_crew_cfg(p_org)'), 'crew settings reader of 0371');
  assert.equal((LEDGER.match(/public\._r21_category\(/g) || []).length, 5, 'same category calls in the text');
});
t('0387: _r387_event_pnl = the _vb_event_pnl__pre0372 step + the _vb_event_pnl frozen step, from p_money minus its lines', () => {
  assert.match(PNL, /returns jsonb language plpgsql stable security definer set search_path = '' as \$\$\n-- r212-0387: /);
  assert.ok(PNL.includes("v_old := public._vb_event_pnl__pre0246(p_quote, p_org);"));
  assert.ok(PNL.includes("m := p_money - 'lines';"));
  assert.ok(!PNL.includes('public._r21_event_money(') && !PNL.includes('public._r21_cost_lines'), 'never builds the ledger itself');
  assert.ok(PNL.includes("if not coalesce((public._r372_cfg(p_org) ->> 'freeze_closed')::boolean, true) then return v; end if;"));
  assert.ok(PNL.includes("s := public._r372_current_snapshot(p_quote);"));
  assert.ok(PNL.includes("'legacy_net_profit', v_old -> 'net_profit'"));
});
t('0387 is additive + safe to run twice: guarded renames, no delete / drop table / truncate / index change, grants, ASCII', () => {
  assert.doesNotMatch(MIG.replace(/^--.*$/gm, ''), /\bdelete\s+from\b|\bdrop\s+(table|index|policy|trigger|function)\b|\btruncate\b|\bcreate\s+(unique\s+)?index\b/i);
  for (const [f, k] of [['_r21_cost_lines__pre0372', '_r21_cost_lines__pre0372__pre0387(uuid,uuid)'], ['event_money_header', 'event_money_header__pre0387(uuid)'], ['event_money_cash', 'event_money_cash__pre0387(uuid)']]) {
    assert.ok(MIG.includes(`if to_regprocedure('public.${k}') is null then`), k);
    assert.ok(MIG.includes(`alter function public.${f}(`), f);
  }
  assert.match(MIG, /foreach f in array array\['public\.event_money_header\(uuid\)', 'public\.event_money_cash\(uuid\)'\] loop[\s\S]*?grant execute on function %s to authenticated/);
  assert.match(MIG, /'public\._r387_event_pnl\(uuid,uuid,jsonb\)',[\s\S]*?revoke all on function %s from authenticated/);
  assert.doesNotMatch(MIG, /[^\x00-\x7F]/, 'ASCII only');
});
t('APPLY-0387: begin + the migration + all-true checks + commit (paste-safe: no temp tables, no psql meta commands)', () => {
  assert.match(APPLY, /^-- APPLY-0387 /); assert.ok(APPLY.includes(MIG.trim()), 'the whole migration inside');
  assert.match(APPLY, /\nbegin;\n/); assert.match(APPLY, /select item, ok from \(values\n[\s\S]*\) v\(item, ok\) order by item;\ncommit;\n$/);
  assert.equal((APPLY.match(/\n  \('0\d /g) || []).length, 7, 'seven check rows');
  assert.doesNotMatch(APPLY, /create temp|temporary table|^\\/im);
  assert.doesNotMatch(APPLY, /[^\x00-\x7F]/, 'ASCII only');
});
t('MANIFEST + checker overrides + generated checker + run-all + release lists know 0387', () => {
  assert.match(read('supabase/migrations/MANIFEST'), /\nforward  supabase\/migrations\/0387_r212_money_speed\.sql\n/);
  const ov = JSON.parse(read('supabase/check-prod-overrides.json'));
  assert.ok(ov['0387'].add.includes('marker public.event_money_header(uuid) r212-0387'));
  assert.ok(ov['0387'].add.includes('marker public._r21_cost_lines__pre0372(uuid,uuid) r212-0387'));
  const chk = read('supabase/CHECK-PROD-MIGRATIONS.sql');
  assert.match(chk, /\('0387_r212_money_speed', 'marker', 'public', 'event_money_header', 'uuid\|r212-0387'\)/);
  assert.match(chk, /\('0387_r212_money_speed', 'fn', 'public', '_r387_event_pnl', 'uuid,uuid,jsonb'\)/);
  assert.match(chk, /\('0376_r197_event_money_header', 'marker', 'public', 'event_money_header', 'uuid\|r197-0376'\)/);
  assert.match(read('scripts/db-test/run-all.sh'), /run "r212-money-speed-0387" "R212-MONEY-SPEED-0387: ALL PASS \\\(12\/12\\\)" psql -q -f tests\/db\/r212-money-speed-0387\.sql/);
  for (const f of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.match(read(f), /'0386', '0387'(, '\d{4}')*\]/, f);
});

console.log(`r212-money-speed: ${n} passed`);
