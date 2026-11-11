// r150: production migration checker - supabase/CHECK-PROD-MIGRATIONS.sql is generated from MANIFEST by
// scripts/gen-check-prod.mjs. Pure checks (no database): parser cases, replay rules, the generated SQL is one
// read-only paste-safe SELECT, every MANIFEST entry has a row, the known prod drift (0312, 0165) is checked.
// The database half (fully migrated canonical DB -> no missing / partial row) runs in scripts/db-test/run-all.sh.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseFile, build, render, readManifest } from '../scripts/gen-check-prod.mjs';
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0;
const t = async (name, fn) => { try { await fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };
const creates = (sql) => parseFile(sql).ev.filter((e) => e.op === 'create').map((e) => e.obj);
const keysOf = (built, id) => built.rows.find((x) => x.mg.id === id).list.map((x) => x.key);
const mig = (id, text) => ({ id, num: id.slice(0, 4), text });

await t('parser: function name + input argument types (out / defaults / names dropped, aliases normalised)', () => {
  const [f] = creates(`create or replace function public.f(p_a uuid, p_at timestamptz default now(), out o_x int, variadic p_v text[])
    returns record language plpgsql as $$ begin create table public.not_now (id int); end $$;`);
  assert.deepEqual(f, { kind: 'fn', schema: 'public', name: 'f', types: ['uuid', 'timestamp with time zone', 'text[]'] });
  const [g] = creates(`create function public.g(numeric(12,2), double precision, character varying, int) returns int language sql as 'select 1';`);
  assert.deepEqual(g.types, ['numeric', 'double precision', 'character varying', 'integer']);
  assert.equal(creates('create function public.h() returns void language sql as $f$ select 1 $f$;')[0].types.length, 0);
});
await t('parser: function bodies are not scanned, DO blocks are, comments never', () => {
  const objs = creates(`-- create table public.in_comment (id int);
    /* create index nope on public.t (c); */
    do $$ begin
      create table if not exists public.t (id int);
      execute 'create index if not exists t_id_idx on public.t (id)';
    end $$;
    create function public.k() returns void language plpgsql as $b$ begin create table public.later (id int); end $b$;`);
  assert.deepEqual(objs.map((o) => o.kind + ' ' + o.name), ['tbl t', 'idx t_id_idx', 'fn k']);
});
await t('parser: columns, constraints, policies, triggers, indexes, cron jobs, buckets, publication', () => {
  const objs = creates(`alter table if exists public.t add column if not exists c text, add constraint t_c_chk check (c <> ''), add d int;
    create policy "Members read" on public.t for select using (true);
    create trigger zz_t after insert or update of c on public.t for each row execute function public.k();
    create unique index if not exists t_c_uk on public.t (c);
    select cron.schedule('helm-x', '* * * * *', 'select 1');
    insert into storage.buckets (id, name, public) values ('b1', 'b1', false), ('b2', 'b2', true) on conflict (id) do nothing;
    alter publication supabase_realtime add table public.t;`);
  assert.deepEqual(objs.map((o) => o.kind + ' ' + o.name), ['col c', 'con t_c_chk', 'col d', 'pol Members read', 'trg zz_t', 'idx t_c_uk',
    'cron helm-x', 'bucket b1', 'bucket b2', 'pub supabase_realtime']);
});
await t('parser: dynamic SQL with %I / string concatenation yields no made-up names', () => {
  const objs = creates(`do $$ declare t text; begin foreach t in array array['a','b'] loop
      execute format('create trigger audit_trg after insert on public.%I for each row execute function public.tg_audit()', t);
      execute 'create policy ' || quote_ident(t) || ' on public.x for select using (true)';
      execute format('alter table public.%I add column if not exists z int', t);
    end loop; end $$;`);
  assert.deepEqual(objs, []);
});
await t('replay: dropped / renamed objects are not expected; re-issues are checked by body under the last author', () => {
  const b = build({ overrides: {}, migs: [
    mig('0001_a', `create table public.t (id int);
      create function public.f(uuid) returns int language sql as $$ select 1 $$;
      create function public.g() returns int language sql as $$ select 1 $$;
      create index t_i on public.t (id);`),
    mig('0002_b', `drop function if exists public.f(uuid);
      create or replace function public.g() returns int language sql as $$ select 2 $$;
      alter index t_i rename to t_i2;
      create table public.u (id int);`),
  ] });
  assert.deepEqual(keysOf(b, '0001_a').sort(), ['fn public.g()', 'table public.t']);
  assert.deepEqual(keysOf(b, '0002_b').sort(), ['body public.g()', 'index public.t_i2', 'table public.u']);
  assert.match(render(b), /\('0002_b', 'body', 'public', 'g', '\|[0-9a-f]{32}'\)/);
});
await t('replay: drop + create of the same name in one migration is a re-issue (no evidence), __preNNNN copies are', () => {
  const b = build({ overrides: {}, migs: [
    mig('0001_a', `create table public.t (id int, k text); alter table public.t add constraint t_k_chk check (k <> '');`),
    mig('0002_b', `alter table public.t drop constraint if exists t_k_chk, add constraint t_k_chk check (k <> 'x');
      do $$ begin execute format('alter function public.%I() rename to %I', 'g', 'g__pre0002'); end $$;`),
  ] });
  assert.deepEqual(keysOf(b, '0001_a'), ['table public.t', 'constraint t_k_chk on public.t']);
  assert.deepEqual(keysOf(b, '0002_b'), ['pre *__pre0002']);
});
await t('overrides: nothing detectable -> the generator fails until it is explained; optional / skip / add / ignore', () => {
  const migs = [mig('0001_a', 'update public.t set x = 1;'), mig('0002_b', 'create table public.t (id int); create table public.u (id int);')];
  assert.throws(() => build({ overrides: {}, migs }), /0001_a: makes nothing detectable/);
  const b = build({ migs, overrides: { '0001': { status: 'skip', note: 'data only' },
    '0002_b': { status: 'optional', note: 'dormant', ignore: ['table public.u'], add: ['column public.t.id'] } } });
  assert.deepEqual(keysOf(b, '0002_b'), ['table public.t', 'column public.t.id']);
  const sql = render(b);
  assert.match(sql, /\(1, '0001_a', 'skip', 'data only'\)/); assert.match(sql, /\(2, '0002_b', 'optional', 'dormant'\)/);
  assert.throws(() => build({ migs, overrides: { '0009': { note: 'x' } } }), /does not name exactly one MANIFEST entry/);
});

const SQL = r('supabase/CHECK-PROD-MIGRATIONS.sql');
await t('CHECK-PROD-MIGRATIONS.sql is current (same as a fresh generation) and ASCII', () => {
  assert.equal(SQL, render(build()), 'out of date - run: node scripts/gen-check-prod.mjs');
  assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(SQL));
});
await t('one read-only SELECT: no statement but the last, no DDL / DML / session state / meta-commands, sorted problems first', () => {
  const code = SQL.replace(/'(?:[^']|'')*'/g, "''").split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.equal((code.match(/;/g) || []).length, 1); assert.ok(code.trim().endsWith(';'));
  assert.ok(code.trim().startsWith('with o(m, k, s, n, x) as (values'));
  const bad = code.match(/\b(insert|update|delete|create|drop|alter|grant|revoke|truncate|copy|call|do|perform|execute|set|reset|begin|commit|vacuum|analyze|lock|notify|pg_sleep|dblink|lo_\w+)\b/i);
  assert.equal(bad && bad[0], null, 'a write / session keyword outside a string literal');
  assert.ok(!/^\s*\\/m.test(code), 'a psql meta-command');
  assert.ok(/order by case when mig\.ov is not null then 2[\s\S]*when a\.found = 0 then 0\s*when a\.found < a\.total then 1/.test(code), 'problems sort first');
  // cron.job / storage.buckets are only read when present + readable (never a hard reference that fails)
  assert.ok(!/\bfrom\s+(cron|storage)\./i.test(code), 'a hard reference to cron / storage');
  assert.ok(SQL.includes("when not has_table_privilege(to_regclass('cron.job'), 'select') then null::text[]"));
  assert.ok(SQL.includes("query_to_xml('select jobname from cron.job', false, false, '')"));
});
await t('every MANIFEST entry has exactly one row, in MANIFEST order', () => {
  const ids = readManifest().map((m) => m.id);
  const rows = [...SQL.matchAll(/^ {2}\((\d+), '([^']+)', /gm)].map((m) => [Number(m[1]), m[2]]);
  assert.deepEqual(rows.map((x) => x[1]), ids);
  assert.deepEqual(rows.map((x) => x[0]), ids.map((_, i) => i + 1));
});
await t('the known prod drift is checked: 0312 cancel_task + its columns, 0165 comms_outbox_unsub; 0117 optional', () => {
  const b = build();
  const k312 = keysOf(b, '0312_r96_cancel_task');
  for (const k of ['fn public.cancel_task(uuid,text)', 'column public.event_tasks.cancel_reason', 'trigger zz_r312_cancel_cols on public.event_tasks']) assert.ok(k312.includes(k), k);
  assert.ok(keysOf(b, '0165_email_unsubscribe').includes('fn public.comms_outbox_unsub(uuid)'));
  assert.equal(b.rows.find((x) => x.mg.num === '0117').o.status, 'optional');
  assert.match(SQL, /'0117_integration_accounts', 'optional', 'optional, Razorpay dormant/);
});
await t('wired in: npm run ci + GitHub CI run --check; run-all.sh asserts a fully migrated DB has no missing / partial row', () => {
  const pkg = JSON.parse(r('package.json'));
  assert.match(pkg.scripts.ci, /node scripts\/gen-check-prod\.mjs --check && node test\/r150-check-prod\.test\.mjs/);
  assert.match(r('.github/workflows/ci.yml'), /run: node scripts\/gen-check-prod\.mjs --check && node test\/r150-check-prod\.test\.mjs/);
  assert.match(r('scripts/db-test/run-all.sh'), /supabase\/CHECK-PROD-MIGRATIONS\.sql/);
  assert.match(r('docs/RUNBOOK-MIGRATIONS.md'), /STAGING first, then PRODUCTION/);
});

console.log(`r150-check-prod: ${n} passed`);
