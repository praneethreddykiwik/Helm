// R206: warnings / errors from the production API gateway log (17-18 Nov 2026).
//  1  500 rpc/event_timesheet + rpc/runsheet_group_status = Postgres 57014 statement timeout: 0384 re-issues event_timesheet
//     with the same answer but work bounded by the event (the DB suite r206-api-timeouts-0384 compares it with the old body
//     on seeded volume) + five additive indexes; runsheet_group_status is unchanged.
//  2  stale / other-studio quote id on flow.html / event.html: the stage history box, package selections panel and the trial
//     payments note wait for the page's own quote check (window.HelmPageQuote); quotes.get uses maybeSingle (no 406); the
//     anon-key guard also covers event_costs + the stage history / valid-until reads.
//  3  404 rpc/event_money_header before 0376: a missing read call is asked once per page load, then answered null locally.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ✓ ' + name); };
const S = read('public/store-api.js');
const M = read('supabase/migrations/0384_r206_api_timeouts.sql');
const A = read('supabase/APPLY-0384.sql');
const C = read('supabase/APPLY-0384-CONCURRENT.sql');
const MF = read('supabase/migrations/MANIFEST');
const IDX = [
  'ix_event_tasks_quote_crew_0384 on public.event_tasks (quote_id, crew_id) where crew_id is not null',
  "ix_event_day_arrival_ref_0384 on public.event_day (quote_id, ref_id, updated_at desc) where kind = 'arrival'",
  'ix_open_shift_claims_crew_0384 on public.open_shift_claims (crew_id)',
  'ix_event_task_log_crew_0384 on public.event_task_log (crew_id) where crew_id is not null',
  'ix_audit_log_org_at_id_0384 on public.audit_log (org_id, at desc, id desc)'];

await t('0384: event_timesheet keeps its checks, grants and settings reader; additive only; ASCII; paste-safe comments', () => {
  const code = M.replace(/^\s*--.*$/gm, '');
  const i = code.indexOf('create or replace function public.event_timesheet(p_quote uuid)\nreturns jsonb language plpgsql stable security definer set search_path = \'\' as $$');
  assert.ok(i > 0, 'same signature, stable, definer, empty search_path');
  const body = M.slice(M.indexOf('create or replace function public.event_timesheet(p_quote uuid)'), M.indexOf('end $$;', M.indexOf('create or replace function public.event_timesheet(p_quote uuid)')));
  assert.match(body, /-- r206-0384:/);
  assert.match(body, /if auth\.uid\(\) is null or v_org is null or not \(public\.has_area\('staff', 'view'\) or public\.has_area\('command', 'view'\)\) then\n\s+raise exception 'not authorized' using errcode = '42501'; end if;/);
  assert.match(body, /where qq\.id = p_quote and qq\.org_id = v_org;\n\s+if q\.id is null then raise exception 'no such event' using errcode = 'P0002'; end if;/);
  assert.match(body, /v_cfg := public\._r25_crew_cfg\(v_org\)/);
  assert.doesNotMatch(body, /public\._r23_cfg\(|public\._r23_on_event\(|public\._r23_expected_start\(/, 'no per-person helper calls');
  assert.match(body, /join public\.crew_members cm on cm\.id = e\.id and cm\.org_id = v_org/, 'own studio only');
  assert.match(M, /if to_regprocedure\('public\.event_timesheet__pre0384\(uuid\)'\) is null then[\s\S]+?if position\('r206-0384' in v_def\) = 0 then/);
  assert.match(M, /revoke all on function public\.event_timesheet__pre0384\(uuid\) from authenticated/);
  assert.match(M, /grant execute on function public\.event_timesheet\(uuid\) to authenticated/);
  assert.doesNotMatch(M, /grant execute on function public\.event_timesheet\(uuid\) to anon/);
  for (const x of IDX) assert.ok(M.includes('create index if not exists ' + x + ';'), x);
  assert.doesNotMatch(code, /\bdrop\s+(table|function|policy|index|trigger)\b|\bdelete\s+from\b|\btruncate\b|\bupdate\s+public\.|\balter\s+table\b/i);
  assert.doesNotMatch(code, /runsheet_group_status/, 'runsheet_group_status is not re-issued');
  assert.ok(/^[\x00-\x7F]*$/.test(M), 'ASCII only');
  for (const l of M.split('\n').filter((x) => /^\s*--/.test(x))) assert.doesNotMatch(l, /['";]/, 'comment: ' + l);
});

await t('APPLY-0384 = the migration + a final all-true check list; CONCURRENT = the same five indexes one line each', () => {
  assert.match(A, /^-- APPLY-0384 \(R206 [^\n]*\)\. Run on STAGING first, then production\. Safe to run twice\.\n/);
  const body = A.slice(A.indexOf('begin;\n') + 7, A.indexOf('\nselect item, ok from (values'));
  assert.equal(body.trim(), M.trim());
  assert.match(A, /select item, ok from \(values\n[\s\S]+\) v\(item, ok\) order by item;\ncommit;\n$/);
  for (const l of A.split('\n').filter((x) => /^\s*--/.test(x))) assert.doesNotMatch(l, /['";]/, 'comment: ' + l);
  assert.doesNotMatch(C, /^\s*(begin|commit)\s*;/im);
  const lines = C.split('\n').filter((l) => /^create index/.test(l));
  assert.equal(lines.length, 5);
  for (const x of IDX) assert.ok(lines.includes('create index concurrently if not exists ' + x + ';'), x);
  for (const l of C.split('\n').filter((x) => /^\s*--/.test(x))) assert.doesNotMatch(l, /['";]/, 'comment: ' + l);
  assert.ok(MF.includes('forward  supabase/migrations/0384_r206_api_timeouts.sql'));
  assert.match(read('supabase/check-prod-overrides.json'), /"0384": \{ "note": "API timeouts[^\n]*"marker public\.event_timesheet\(uuid\) r206-0384"/);
  assert.match(read('scripts/db-test/run-all.sh'), /run "r206-api-timeouts-0384" "R206-API-TIMEOUTS-0384: ALL PASS \\\(21\/21\\\)" psql -q -f tests\/db\/r206-api-timeouts-0384\.sql/);
});

await t('quotes.get: maybeSingle (no 406 for 0 rows), still the same "not found" error for its callers', async () => {
  const i = S.indexOf('    async get(id) {\n      // a truncated/garbled id'); assert.ok(i > 0);
  const g = S.slice(i, S.indexOf('\n    },', i));
  assert.match(g, /supa\.from\("quotes"\)\.select\("\*"\)\.eq\("id", id\)\.maybeSingle\(\); if \(error\) throw error;\n\s+if \(!q\) \{ const e = new Error\([^)]*\); e\.code = "PGRST116"; throw e; \}/);
  assert.doesNotMatch(S, /from\("quotes"\)\.select\("\*"\)\.eq\("id", [a-zA-Z]+\)\.single\(\)/);
});

await t('anon-key guard: + event_costs, quote_stage_history, quote_validity_get; public reads still pass', () => {
  const m = S.match(/const SIGNED_IN_ONLY = (\/.*\/);/); assert.ok(m);
  const R = eval(m[1]); const B = 'https://x.supabase.co/rest/v1/';
  for (const u of ['event_costs?select=*&quote_id=eq.x&order=created_at', 'rpc/quote_stage_history', 'rpc/quote_validity_get',
    'audit_log?select=*', 'rpc/booklet_current', 'quotes?select=*&id=eq.x'])
    assert.ok(R.test(B + u), u);
  for (const u of ['rpc/public_quote_validity', 'rpc/public_get_booklet', 'event_costsx', 'rpc/quote_stage_historyx', 'rpc/quote_validity_getx'])
    assert.ok(!R.test(B + u), u);
});

await t('a read call the database does not have yet is asked once per page load (event_money_header / event_money_cash)', async () => {
  const i = S.indexOf('  const goneReads = new Set();'); assert.ok(i > 0);
  const src = S.slice(i, S.indexOf('\n  }\n', i) + 4);
  assert.match(S, /const moneyHeader = \{\n\s+async get\(quoteId\) \{\n\s+if \(mode !== "supabase" \|\| !quoteId\) return null;\n\s+return softRead\("event_money_header", \{ p_quote: quoteId \}\);/);
  assert.match(S, /return softRead\("event_money_cash", \{ p_quote: quoteId \}\);/);
  const calls = [];
  const ctx = { Set, calls, rpc: async (fn) => { calls.push(fn); if (fn === 'gone') { const e = new Error('Could not find the function'); e.code = 'PGRST202'; throw e; } if (fn === 'deny') { const e = new Error('no'); e.code = '42501'; throw e; } return { ok: fn }; },
    rpcMissing: (e) => e && e.code === 'PGRST202' };
  vm.runInNewContext(src + '\nthis.softRead = softRead;', ctx);
  assert.equal(await ctx.softRead('gone', {}), null);
  assert.equal(await ctx.softRead('gone', {}), null);
  assert.equal(await ctx.softRead('gone', {}), null);
  assert.deepEqual(calls.filter((c) => c === 'gone'), ['gone'], 'asked once, then answered locally');
  assert.deepEqual(await ctx.softRead('there', {}), { ok: 'there' });
  assert.deepEqual(await ctx.softRead('there', {}), { ok: 'there' });
  assert.equal(calls.filter((c) => c === 'there').length, 2, 'a working call is not memoised');
  await assert.rejects(ctx.softRead('deny', {}), (e) => e.code === '42501', 'a refusal still reaches the caller');
  await assert.rejects(ctx.softRead('deny', {}), (e) => e.code === '42501', 'and is asked again next time');
});

await t('stage history / package selections / trial payments note wait for the page check (and behave as before without one)', async () => {
  const SH = read('public/stage-history.js'), PR = read('public/pkg-review.js'), TN = read('public/trial-test-note.js');
  assert.match(SH, /var id = quoteIdFor\(box\), b = B\(\); if \(!id \|\| !b \|\| !b\.stages\) return;\n\s+if \(!box\.getAttribute\("data-quote"\) && !\(await pageQuoteOk\(id\)\)\) \{ box\.hidden = true; return; \}/);
  assert.match(PR, /if \(!view \|\| !q\) \{ p\.hidden = true; continue; \}\n\s+if \(!UUID_RE\.test\(p\.getAttribute\("data-quote"\) \|\| ""\) && !\(await pageQuoteOk\(q\)\)\) \{ p\.hidden = true; continue; \}/);
  assert.match(TN, /pq\.then\(function \(q\) \{ return q && String\(q\)\.toLowerCase\(\) === id\.toLowerCase\(\) \? st\.approval\.trialSimPayments\(id\) : null; \}, function \(\) \{ return null; \}\)/);
  const grab = (src) => { const m = /function pageQuoteOk\(id\) \{[\s\S]*?\n  \}/.exec(src); assert.ok(m); return m[0]; };
  const id = 'a0000000-0000-4000-8000-00000000da01';
  for (const src of [SH, PR]) {
    const mk = (g) => vm.runInNewContext('(' + grab(src).replace('function pageQuoteOk', 'function') + ')', { global: g, String, Promise });
    assert.equal(await mk({})(id), true, 'no page check: unchanged');
    assert.equal(await mk({ HelmPageQuote: Promise.resolve(null) })(id), false, 'not found: nothing asked');
    assert.equal(await mk({ HelmPageQuote: Promise.resolve(id.toUpperCase()) })(id), true, 'the opened quote');
    assert.equal(await mk({ HelmPageQuote: Promise.resolve('b0000000-0000-4000-8000-00000000da01') })(id), false, 'another quote');
    assert.equal(await mk({ HelmPageQuote: Promise.reject(new Error('x')) })(id), false, 'a failed check');
  }
  // the pages still publish the check the widgets wait for
  for (const H of [read('public/flow.html'), read('public/event.html')]) assert.match(H, /window\.HelmPageQuote=new Promise\(r=>\{ pageQuoteDone=r; \}\);/);
  assert.match(read('public/event.html'), /id="pkg-selections" class="card" data-pkg-review data-quote-from-url/);
});

console.log(`r206-api-errors: ${n} passed`);
