// r249-workspace-speed.test.mjs - R249 Event Workspace speed + loading look, and the production database load. Read from the files:
//   1. the money reads of one event go out as ONE event_money_bundle call (batched, wants from the page, serialized per event,
//      fallback to the separate calls on a database without 0431, errors per part like the separate call) - run in a sandbox
//   2. the Event Workspace paints from the event row: row + versions in parallel, asked during the startup read (HelmPrefetch),
//      the skeleton is the final layout and goes the moment the card paints; the shared boot bars never draw a lone spinner
//   3. a signed-out tab never sends a table write with the bare anon key (42501 current_org_id); reads untouched
//   4. the rail HEAD counts wait for the 60 s run when this tab counted less than a minute ago
//   5. SQL 0431-0433 + APPLY files + MANIFEST + run-all + the read-only diagnostic file
// Behaviour of the SQL: tests/db/r249-money-once-0431.sql, r249-cron-quiet-0432.sql, r249-read-speed-0433.sql, r249-apply-order-0431.sh.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const ROOT = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const API = read('public/store-api.js'), EV = read('public/event.html'), THEME = read('public/theme.css'), EVCSS = read('public/event-ui.css');
const SHELL = read('public/shell-b.js'), MH = read('public/money-header-ui.js'), ML = read('public/money-ledger-ui.js');
const M = ['0431_r249_money_once', '0432_r249_cron_quiet', '0433_r249_read_speed'];

// the moneyOnce block of store-api.js, run with a fake rpc
function moneySandbox(rpcImpl) {
  const a = API.indexOf('  const MONEY_PARTS = ['), b = API.indexOf('  const vendorBills = {');
  assert.ok(a > 0 && b > a, 'moneyOnce block found');
  const src = API.slice(a, b) + '\nthis.moneyOnce = moneyOnce; this.moneyPartOf = moneyPartOf;';
  const calls = [];
  const ctx = { mode: 'supabase', setTimeout, Promise, Set, Map, Object, String, Error, Array, document: { querySelectorAll: () => [], querySelector: () => null },
    rpc: (fn, args) => { calls.push([fn, args]); return rpcImpl(fn, args, calls.length); },
    rpcMissing: (e) => !!e && (e.code === 'PGRST202' || e.code === '42883') };
  vm.createContext(ctx); vm.runInContext(src, ctx);
  return { ctx, calls };
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

t('money: parts asked together (and wanted by the page) go out as ONE bundle call; each caller gets its own part', async () => {
  const { ctx, calls } = moneySandbox((fn, args) => Promise.resolve({ v: 1, header: { h: 1 }, cash: { c: 2 }, breakdown: null, errors: {} }));
  ctx.moneyOnce.want('Q1', ['breakdown']);
  const [h, c, b] = await Promise.all([ctx.moneyOnce.get('Q1', 'header', () => 'old'), ctx.moneyOnce.get('Q1', 'cash', () => 'old'), ctx.moneyOnce.get('Q1', 'breakdown', () => 'old')]);
  assert.equal(calls.length, 1, 'one call');
  assert.equal(calls[0][0], 'event_money_bundle');
  assert.deepEqual(Array.from(calls[0][1].p_parts), ['header', 'cash', 'breakdown'], 'fixed order, wanted part included');
  assert.equal(calls[0][1].p_quote, 'Q1');
  assert.deepEqual(JSON.parse(JSON.stringify([h, c, b])), [{ h: 1 }, { c: 2 }, null]);
});
t('money: a refused part rejects like its own call (code + message); the other parts still resolve', async () => {
  const { ctx } = moneySandbox(() => Promise.resolve({ v: 1, header: { ok: true }, errors: { pnl: { code: '42501', message: 'not authorized' } } }));
  const ph = ctx.moneyOnce.get('Q2', 'header', () => 'old'), pp = ctx.moneyOnce.get('Q2', 'pnl', () => 'old');
  assert.deepEqual(JSON.parse(JSON.stringify(await ph)), { ok: true });
  await assert.rejects(pp, (e) => e.code === '42501' && /not authorized/.test(e.message));
});
t('money: a database without 0431 -> every caller gets its old separate call, and later reads skip the bundle', async () => {
  const { ctx, calls } = moneySandbox(() => { const e = new Error('Could not find the function public.event_money_bundle'); e.code = 'PGRST202'; return Promise.reject(e); });
  const v = await Promise.all([ctx.moneyOnce.get('Q3', 'header', () => Promise.resolve('H')), ctx.moneyOnce.get('Q3', 'cash', () => Promise.resolve('C'))]);
  assert.deepEqual(v, ['H', 'C']);
  assert.equal(await ctx.moneyOnce.get('Q3', 'header', () => Promise.resolve('H2')), 'H2');
  assert.equal(calls.length, 1, 'the bundle was asked once');
});
t('money: a second batch for the same event waits for the first (never side by side); another event is its own call', async () => {
  let open = 0, maxOpen = 0;
  const { ctx, calls } = moneySandbox(async (fn, args) => { open++; maxOpen = Math.max(maxOpen, open); await tick(60); open--; return { v: 1, header: 1, cash: 2, errors: {} }; });
  const a = ctx.moneyOnce.get('Q4', 'header', () => 0);
  await tick(50);   // past the batch window: the next ask is a new batch
  const b = ctx.moneyOnce.get('Q4', 'cash', () => 0);
  await Promise.all([a, b]);
  assert.equal(calls.length, 2); assert.equal(maxOpen, 1, 'serialized per event');
  const c = await ctx.moneyOnce.get('Q5', 'header', () => 0);
  assert.equal(c, 1); assert.equal(calls[2][1].p_quote, 'Q5');
});
t('money: the four reads go through the batch with their old call as the fallback; the pages say which parts they show', () => {
  assert.ok(API.includes('moneyOnce.get(quoteId, "pnl", () => rpc("event_pnl", { p_quote: quoteId }))'));
  assert.ok(API.includes('moneyOnce.get(quoteId, "breakdown", () => rpc("event_cost_breakdown", { p_quote: quoteId }))'));
  assert.ok(API.includes('moneyOnce.get(quoteId, "header", () => softRead("event_money_header", { p_quote: quoteId }))'));
  assert.ok(API.includes('moneyOnce.get(quoteId, "cash", () => softRead("event_money_cash", { p_quote: quoteId }))'));
  assert.match(API, /\n    moneyOnce, \/\/ R249 \(0431\)/);
  for (const [f, s] of [['money-header-ui', MH], ['money-ledger-ui', ML]]) assert.ok(s.includes('B.moneyOnce.wantPage(id)'), f + ' says what the page shows');
  assert.ok(EV.includes('BPStore.moneyOnce.wantPage(ev.id||id); BPStore.moneyOnce.want(ev.id||id,["pnl"]);'), 'event page: header + P&L in one call');
  // pageParts reads the page's own cards
  const { ctx } = moneySandbox(() => Promise.resolve({}));
  const doc = { querySelectorAll: () => [{ getAttribute: () => 'header attention pva cash owes' }], querySelector: (q) => (q.includes('data-ml-mount') ? {} : null) };
  assert.deepEqual(Array.from(ctx.moneyOnce.pageParts(doc)), ['header', 'cash', 'breakdown']);
  const ev = { querySelectorAll: () => [{ getAttribute: () => 'header attention' }], querySelector: () => null };
  assert.deepEqual(Array.from(ctx.moneyOnce.pageParts(ev)), ['header']);
});
t('workspace: the event row + its versions in parallel, shared while in flight; asked during the startup read', () => {
  assert.match(API, /const \[r1, r2\] = await Promise\.all\(\[supa\.from\("quotes"\)\.select\("\*"\)\.eq\("id", id\)\.maybeSingle\(\),\n\s+supa\.from\("quote_versions"\)/);
  assert.ok(API.includes('if (quoteGetInflight.has(key)) return quoteGetInflight.get(key);'));
  assert.ok(API.includes('out.then(() => quoteGetInflight.delete(key), () => quoteGetInflight.delete(key));'), 'never cached after the answer');
  const i = API.indexOf('if (currentUser && typeof global.HelmPrefetch === "function")'), j = API.indexOf('bootReqP = pageBootstrap();');
  assert.ok(i > 0 && j > i, 'HelmPrefetch runs before the startup read is awaited');
  assert.ok(EV.includes('window.HelmPrefetch=function(){'));
  assert.ok(EV.includes('const evFirst=(evEarly && evEarlyId===id) ? evEarly : BPStore.quotes.get(id); evEarly=null;'), 'used once (Retry reads fresh)');
});
t('workspace: the skeleton is the final layout and goes the moment the card paints (not after every card)', () => {
  assert.match(EV, /<div id="boot" class="evsk" aria-busy="true" role="status" aria-label="Loading the event">/);
  assert.ok(EV.includes('class="card evsk-head"') && EV.includes('class="evsk-steps"') && (EV.match(/class="card evsk-mod"/g) || []).length === 3);
  assert.ok(EV.includes('$("#app").hidden=false; render(); hideBoot();'));
  assert.ok(EV.indexOf('hideBoot();') < EV.indexOf('await Promise.all(['), 'before the module reads');
  assert.match(EVCSS, /#boot\.evsk\{display:block;max-width:none;min-height:0;margin:0;padding:0;color:inherit\}/);
  assert.match(EVCSS, /#boot\.evsk::before,#boot\.evsk::after\{content:none;display:none\}/);
  assert.match(EVCSS, /@media \(prefers-reduced-motion:no-preference\)\{ \.evsk \.evsk-b\{animation:evskShimmer/);
  assert.match(EVCSS, /@media \(max-width:640px\)\{[\s\S]*\.evsk \.evsk-grid\{grid-template-columns:minmax\(0,1fr\);gap:12px\}/);
  assert.ok(!/style="/.test(EV.slice(EV.indexOf('<div id="boot"'), EV.indexOf('<div id="loadErr">'))), 'no inline styles');
});
t('shared boot bars (every other page): full width, no ring mask, no spin, start at the top', () => {
  assert.match(THEME, /#boot \{ align-items: stretch; justify-content: flex-start; min-height: 0; \}/);
  assert.match(THEME, /#boot:empty::before, #boot:empty::after \{\n  width: auto; align-self: stretch; border: 0; box-sizing: border-box; animation: none;\n  -webkit-mask: none; mask: none;\n\}/);
  assert.ok(THEME.indexOf('animation: none;') < THEME.indexOf('animation: bpShimmer'), 'the shimmer (later) still wins with motion on');
});
t('anon: a table write with the bare anon key is answered locally; reads and rpc calls are not caught by it', () => {
  const a = API.indexOf('  const ANON_TABLE = '), b = API.indexOf('  function rpcNameOf(u) {');
  const ctx = {}; vm.createContext(ctx); vm.runInContext(API.slice(a, b) + '\nthis.f = anonTableWrite;', ctx);
  const u = 'https://x.supabase.co/rest/v1/event_checklist?on_conflict=id';
  assert.equal(ctx.f(u, { method: 'POST' }), true);
  assert.equal(ctx.f(u, { method: 'PATCH' }), true);
  assert.equal(ctx.f(u, { method: 'delete' }), true);
  assert.equal(ctx.f(u, { method: 'GET' }), false);
  assert.equal(ctx.f(u, undefined), false, 'no method = GET');
  assert.equal(ctx.f('https://x.supabase.co/rest/v1/rpc/public_site_get', { method: 'POST' }), false, 'rpc untouched');
  assert.equal(ctx.f(u, undefined, { method: 'POST' }), true, 'a Request object');
  assert.ok(API.includes('(fn && !ANON_RPCS.test(fn)) || anonTableWrite(u, init, input))) return false;'));
});
t('rail: counted less than 55 s ago -> wait until a minute after that; otherwise 1.5 s', () => {
  const a = SHELL.indexOf('  function railBootDelay('), b = SHELL.indexOf('  try { window.__helmRailBootDelay');
  const ctx = {}; vm.createContext(ctx); vm.runInContext(SHELL.slice(a, b) + '\nthis.f = railBootDelay;', ctx);
  assert.equal(ctx.f(0, 1e9), 1500);
  assert.equal(ctx.f(1e9 - 10000, 1e9), 50000);
  assert.equal(ctx.f(1e9 - 59000, 1e9), 1500);
  assert.equal(ctx.f(1e9 - 54000, 1e9), 6000);
  assert.equal(ctx.f(1e9 + 5000, 1e9), 1500, 'a clock that went back counts again');
  assert.ok(SHELL.includes('sessionStorage.setItem(CNT_AT_KEY, String(Date.now()))'));
});
t('SQL 0431-0433: ASCII, additive (no drop table / delete / truncate), markers, APPLY = migration + set local + check rows', () => {
  for (const m of M) {
    const n = m.slice(0, 4), MIG = read('supabase/migrations/' + m + '.sql'), APPLY = read('supabase/APPLY-' + n + '.sql');
    for (const [f, s] of [['migration', MIG], ['APPLY', APPLY]]) assert.ok(!/[^\x00-\x7F]/.test(s), m + ' ' + f + ' ASCII');
    assert.ok(!/\bdrop\s+(table|column|index|policy|trigger)\b|\bdelete\s+from\b|\btruncate\b/i.test(MIG.replace(/^--.*$/gm, '').replace(/alter publication supabase_realtime drop table public\.chat_reactions/g, '')), m + ' additive (the one Realtime membership aside)');
    assert.match(APPLY, /\nbegin;\nset local lock_timeout = '5s';\nset local statement_timeout = '5min';\n/);
    assert.ok(APPLY.includes(MIG), m + ': APPLY carries the whole migration');
    assert.match(APPLY, /\) v\(item, ok\) order by item;\ncommit;\n$/);
    assert.ok(MIG.includes("values (" + Number(n) + ", '" + m + "') on conflict (num) do nothing"), m + ' schema marker');
    assert.ok(read('supabase/migrations/MANIFEST').includes('forward  supabase/migrations/' + m + '.sql'), m + ' in MANIFEST');
    assert.ok(read('supabase/CHECK-PROD-MIGRATIONS.sql').includes(m), m + ' in the prod checker');
  }
  const RA = read('scripts/db-test/run-all.sh');
  for (const s of ['r249-money-once-0431', 'r249-cron-quiet-0432', 'r249-read-speed-0433', 'r249-apply-0431-0433', 'r249-apply-order-0431']) assert.ok(RA.includes('run "' + s + '"'), s + ' wired');
});
t('0431: the memory lives only inside event_money_bundle (set at its start, cleared at its end, transaction-local)', () => {
  const MIG = read('supabase/migrations/0431_r249_money_once.sql');
  assert.ok(MIG.includes("if coalesce(current_setting('helm.r431_money_on', true), '') <> 'on' then\n    return public._r21_event_money__pre0372__pre0431(p_quote, p_org, p_lines);"));
  assert.equal((MIG.match(/set_config\('helm\.r431_money_on', 'on', true\)/g) || []).length, 1);
  assert.equal((MIG.match(/set_config\('helm\.r431_money_on', '', true\)/g) || []).length, 1);
  assert.ok(!/set_config\([^)]*, false\)/.test(MIG), 'never session-wide');
  assert.ok(MIG.includes("exception when others then\n      v_err := v_err || jsonb_build_object(p,"), 'a refused part = its error');
});
t('0432: cron.job untouched; checks are supersets of the kept bodies; 0433: no live Realtime table removed', () => {
  const C = read('supabase/migrations/0432_r249_cron_quiet.sql').replace(/^--.*$/gm, ''), R = read('supabase/migrations/0433_r249_read_speed.sql').replace(/^--.*$/gm, '');
  assert.ok(!/cron\.(schedule|unschedule|alter_job)|update\s+cron\.job/i.test(C), 'no schedule change');
  assert.ok(C.includes("t.planned_start between coalesce(p_now, now()) - interval '1 day' and coalesce(p_now, now()) + interval '25 hours'"));
  assert.ok(C.includes("coalesce(d.eta_at, d.due_at) between now() - interval '3 hours' and now() + interval '1465 minutes'"));
  assert.equal((R.match(/alter publication supabase_realtime drop table/g) || []).length, 1);
  assert.ok(R.includes("alter publication supabase_realtime drop table public.chat_reactions"));
  assert.ok(!/drop table public\.(leads|chat_messages|chat_conversations|quote_live_signals|quote_versions|quotation_versions)/.test(R));
});
t('diagnostic file: read only (no writes, no settings, no temp tables), one result', () => {
  const D = read('supabase/DIAG-R249-db-load.sql'), body = D.replace(/^--.*$/gm, '');
  assert.ok(!/[^\x00-\x7F]/.test(D));
  assert.ok(!/\b(insert|update|delete|create|alter|drop|grant|revoke|truncate|set_config|notify)\b/i.test(body.replace(/'[^']*'/g, "''")), 'read only');
  assert.equal((body.match(/;\s*$/gm) || []).length, 1, 'one statement');
  for (const s of ["'A realtime'", "'B cron'", "'C statements'", "'D restarts'", "'E studios'"]) assert.ok(D.includes(s), s);
});

let n = 0;
for (const [name, fn] of tests) { await fn(); n++; console.log('  ok', name); }
console.log(`r249-workspace-speed: ${n}/${tests.length} passed`);
