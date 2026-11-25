// r252-payment-plan-0435.test.mjs - R252 (0435) payment plan, advance and approval: the SQL's shape, and that the built-in plans are what
// the page knows. Behaviour of the SQL: tests/db/r252-payment-plan-0435.sql, r252-payment-plan-race-0435.sh.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const M = '0435_r252_payment_plan', MIG = read('supabase/migrations/' + M + '.sql'), APPLY = read('supabase/APPLY-0435.sql');
const CODE = MIG.replace(/--.*$/gm, '');

t('ASCII, no psql meta / temp tables / session state, additive, marker, APPLY = migration + set local + check rows', () => {
  for (const s of [MIG, APPLY]) assert.ok(!/[^\x00-\x7F]/.test(s), 'ASCII');
  assert.ok(!/^\\/m.test(APPLY) && !/create\s+temp/i.test(APPLY) && !/\bset_config\(/.test(CODE) && !/^set (?!local)/m.test(APPLY));
  assert.ok(!/\bdrop\s+(table|column|index|policy|trigger|function)\b|\bdelete\s+from\b|\btruncate\b/i.test(CODE), 'additive');
  assert.deepEqual(CODE.match(/drop constraint[^,;]*/gi), ['drop constraint if exists payment_schedule_settings_default_builtin_check'], 'the one check that is widened');
  assert.match(CODE, /default_builtin in \('30-50-20', '50-50', '100-upfront', '25-25-25-25'\)/);
  assert.match(APPLY, /\nbegin;\nset local lock_timeout = '5s';\nset local statement_timeout = '5min';\n/);
  assert.ok(APPLY.includes(MIG), 'APPLY carries the whole migration');
  assert.match(APPLY, /\) v\(item, ok\) order by item;\ncommit;\n$/);
  assert.ok(MIG.includes("values (435, '" + M + "') on conflict (num) do nothing"));
  assert.ok(read('supabase/migrations/MANIFEST').includes('forward  supabase/migrations/' + M + '.sql'));
  assert.ok(read('supabase/CHECK-PROD-MIGRATIONS.sql').includes(M));
  for (const s of ['r252-payment-plan-0435', 'r252-apply-0435', 'r252-payment-plan-race-0435']) assert.ok(read('scripts/db-test/run-all.sh').includes('run "' + s + '"'), s + ' wired');
});
t('every new function: definer + empty search_path; helpers revoked, RPCs for signed-in members only', () => {
  const fns = [...MIG.matchAll(/create or replace function public\.(\w+)\([^]*?\nreturns [^\n]*\n/g)];
  assert.ok(fns.length >= 22, String(fns.length));
  for (const f of fns) if (f[1] !== '_pst_builtins') assert.ok(/security definer set search_path = ''/.test(f[0]), f[1]);
  for (const f of fns) if (f[1].startsWith('_r435_')) assert.ok(MIG.includes("'public." + f[1] + '('), f[1] + ' revoked');
  assert.ok(!/grant [^']*to anon/i.test(CODE), 'nothing new for signed-out visitors');
});
t('money rows: milestones are only inserted (new plan) or get a later due date while due; receipts and quotes are never written', () => {
  const ups = [...CODE.matchAll(/\bupdate public\.(\w+)([^;]*);/g)].filter((m) => !/approval_status = /.test(m[0]));
  assert.deepEqual([...new Set(ups.map((m) => m[1]))].sort(), ['payment_milestones', 'payment_schedule_quote_prefs', 'payment_schedule_settings']);
  const ms = ups.filter((m) => m[1] === 'payment_milestones'); assert.equal(ms.length, 1);
  assert.match(ms[0][0], /set due_date = v_due where id = m\.id and status = 'due'/);
  assert.ok(!/insert into public\.quote_payments/.test(CODE));
  assert.equal((CODE.match(/insert into public\.payment_milestones/g) || []).length, 1);
});
t('the approval / the payment never fail because of it: guarded trigger + recorder', () => {
  assert.match(MIG, /exception when others then raise warning 'r252-0435: plan dates not moved/);
  assert.match(MIG, /exception when others then raise warning 'r252-0435: advance confirmation not recorded/);
  assert.match(MIG, /pg_try_advisory_xact_lock/);
});
t('the built-in plans: the first three exactly as the page has them, then four payments', () => {
  const j = JSON.parse(MIG.match(/select \$b\$(\[[^]*?\])\$b\$/)[1]);
  assert.deepEqual(j.map((b) => b.key), ['builtin:30-50-20', 'builtin:50-50', 'builtin:100-upfront', 'builtin:25-25-25-25']);
  const old = JSON.parse(read('supabase/migrations/0264_payment_schedules.sql').match(/select \$b\$(\[[^]*?\])\$b\$/)[1]);
  assert.deepEqual(j.slice(0, 3), old);
  assert.deepEqual(j[3].lines.map((l) => [l.value, l.anchor, l.offset_days]), [[25, 'approval', 0], [25, 'event', -30], [25, 'event', -15], [25, 'event', 0]]);
});

let bad = 0;
for (const [name, fn] of tests) { try { await fn(); console.log('  ok  ' + name); } catch (e) { bad++; console.error('  FAIL ' + name + '\n       ' + (e && e.message)); } }
console.log(bad ? 'r252-payment-plan-0435: ' + bad + ' FAILED' : 'r252-payment-plan-0435: ' + tests.length + ' passed');
process.exit(bad ? 1 : 0);
