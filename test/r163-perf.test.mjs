// r163-perf.test.mjs - R163 (prod 12 Nov, after the R152..R162 release: "almost all signed-in pages take a very long time to
// load on 4 devices; Past renders sits on Loading the photo... for ever"). Static + small behaviour checks of the fixes:
//  1 SQL 0357: the bell / inbox / pending type worked out once per (kind, channel) pair, my_open_quotes step count only
//    for the page (behaviour + exact-answer proof: tests/db/r163-bell-type-once-0357.sql), APPLY / MANIFEST / checker.
//  2 Past renders: a hidden <img loading="lazy"> is never fetched by Chrome / Safari / Firefox, so onload never fired -
//    the picture is loaded eagerly, and the fetch + decode give up after a while (Reload).
//  3 Event workspace: the event row is asked for at the same time as the access checks (not after them).
//  4 Boot budget: my_pending shared on one page load; the bell polls once for all tabs (hidden tabs never, an unfocused
//    tab skips while another tab polled); no page awaits the bell before painting.
// Real pages: tests/e2e/reliability/boot-budget-r163.spec.mjs (staging).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + (e && e.stack || e)); } };

const MIG = read('supabase/migrations/0357_r163_bell_type_once.sql');
const APPLY = read('supabase/APPLY-0357.sql');
const MF = read('supabase/migrations/MANIFEST');
const STORE = read('public/store-api.js');
const PR = read('public/photo-render-ui.js');
const EV = read('public/event.html');

// the body of one created function inside the migration ($fn$ ... $fn$)
const fnBody = (name) => { const i = MIG.indexOf('create or replace function public.' + name + '('); assert.ok(i > 0, name + ' created'); return MIG.slice(i, MIG.indexOf('$fn$', i)).replace(/--[^\n]*/g, ''); };   // code only, comments dropped

await t('0357: _r23_visible works the type out per (kind, channel) pair, never per row', () => {
  const b = fnBody('_r23_visible');
  assert.match(b, /pairs as materialized \(\s*select distinct n\.kind, n\.channel from public\.notifications n where n\.org_id = p_org/);
  assert.match(b, /public\.notification_type_of\(k\.kind, k\.channel\) as ty\s+from pairs k/);
  assert.equal((b.match(/notification_type_of\(/g) || []).length, 1, 'one call, on the pairs');
  assert.doesNotMatch(b, /cross join lateral/);
  assert.doesNotMatch(b, /notification_type_of\(n\./);
  // every 0293 rule is still there
  for (const r of ["coalesce(n.kind, '') <> 'security_alert'", 'not (t.ty = any (me.hid))', 'not (t.ty = any (me.mut))',
    "(me.qe or coalesce(n.kind, '') <> 'price_change')", "(me.cl or coalesce(n.kind, '') not in ('event_close_request', 'event_close_decision'))",
    "not ((n.detail -> 'notify') ? p_uid::text)"]) assert.ok(b.includes(r), r);
  // detail: the 0266 rule written out (only while the helper is the known body), else the helper as before
  assert.match(MIG, /declare v_det text := 'public\._r23_detail\(n\.detail, me\.qv\)';/);
  assert.match(MIG, /position\('r23-inbox-0266' in coalesce\(\(select p\.prosrc from pg_proc p where p\.oid = to_regprocedure\('public\._r23_detail\(jsonb,boolean\)'\)\), ''\)\) > 0/);
  assert.match(b, /@@DETAIL@@/);
});

await t('0357: bell_feed__pre0042 keeps the 0036 list + count, type once per pair (not pushed down)', () => {
  const b = fnBody('bell_feed__pre0042');
  assert.match(b, /pairs as materialized/);
  assert.match(b, /where coalesce\(not \(public\.notification_type_of\(k\.kind, k\.channel\) = any \(v_hidden\)\), false\)/);
  assert.equal((b.match(/notification_type_of\(/g) || []).length, 1);
  assert.match(b, /'unread', \(select count\(\*\) from ok n where n\.created_at > seen\)/);
  assert.match(b, /limit greatest\(1, least\(coalesce\(p_limit, 20\), 100\)\)/);
});

await t('0357: my_open_quotes step count only for the page / where the listing depends on it', () => {
  const b = fnBody('my_open_quotes');
  assert.doesNotMatch(b, /public\._flow_steps_done\(b\.id\)/, 'no step count for every open quote');
  assert.match(b, /case when x\.phase <> 'building' or x\.filled or x\.last_user is not null then true\s+else cardinality\(public\._flow_steps_done\(x\.id\)\) > 0 end/);
  assert.match(b, /'steps_done', to_jsonb\(public\._flow_steps_done\(z\.id\)\)/);
  assert.match(b, /limit v_lim offset v_off\) z\) r0\(ord, r\)/);
  assert.match(MIG.slice(MIG.indexOf('create or replace function public.my_open_quotes(')), /-- open-quotes-0356 /);   // the 0356 checker + VERIFY markers stay true
  assert.match(b, /z\.created_at desc nulls last/);
});

await t('0357: guarded, old bodies kept once with no privilege, nothing dropped', () => {
  for (const k of ['_r23_visible__pre0357', 'bell_feed__pre0042__pre0357', 'my_open_quotes__pre0357']) assert.ok(MIG.includes(k), k);
  assert.match(MIG, /left unchanged'/);
  assert.doesNotMatch(MIG.replace(/^--.*$/gm, ''), /\bdrop\s+(table|function|policy|index|trigger)\b|\bdelete\s+from\b|\btruncate\b/i);
  assert.match(MIG, /revoke all on function public\.my_open_quotes__pre0357\(text, int, int, uuid, int\) from %I', r\)/);
});

await t('APPLY-0357 = the migration in one transaction + VERIFY; MANIFEST entry', () => {
  assert.match(APPLY, /^-- APPLY-0357 \(R163 [^\n]*\)\. Run on STAGING first, then production\. Safe to run twice\.\n/);
  const body = APPLY.slice(APPLY.indexOf('begin;\n') + 7, APPLY.indexOf('\ncommit;\n'));
  assert.equal(body.trim(), MIG.trim());
  assert.match(APPLY, /-- VERIFY every line should say true/);
  assert.ok(!/create temp|create temporary/i.test(APPLY), 'editor-safe: no temp tables');
  assert.ok(MF.includes('forward  supabase/migrations/0357_r163_bell_type_once.sql'));
  assert.match(read('supabase/CHECK-PROD-MIGRATIONS.sql'), /'0357_r163_bell_type_once'/);
  assert.match(read('scripts/db-test/run-all.sh'), /R163-BELL-TYPE-ONCE-0357: ALL PASS \\\(16\/16\\\)/);
});

await t('Past renders: no hidden lazy <img>, eager load before onload, fetch + decode time out', () => {
  assert.doesNotMatch(PR, /img\.alt = [^\n]*; img\.loading = 'lazy';/, 'no unconditional lazy');
  assert.match(PR, /if \(src\) img\.loading = 'lazy';/);
  assert.match(PR, /img\.removeAttribute\('loading'\);/);
  assert.match(PR, /inTime\(A\.image\(id\), IMG_FETCH_MS\)/);
  assert.match(PR, /\}\), IMG_DECODE_MS\)\.catch/);
  for (const f of ['builder.html', 'capture.html']) assert.match(read('public/' + f), /photo-render-ui\.js\?v=12/);
});

await t('Past renders: inTime settles a promise that never settles (behaviour)', async () => {
  const m = /function inTime\(p, ms\) \{[\s\S]*?\n  \}/.exec(PR); assert.ok(m);
  const inTime = vm.runInNewContext('(' + m[0].replace('function inTime', 'function') + ')', { setTimeout, clearTimeout, Promise, Error, Object });
  await assert.rejects(inTime(new Promise(() => {}), 20), (e) => e.code === 'timeout');
  assert.equal(await inTime(Promise.resolve(7), 50), 7);
});

await t('Event workspace: the event row is read at the same time as the access checks', () => {
  const a = EV.indexOf('const evFirst=BPStore.quotes.get(id)'), r = EV.indexOf('await BPStore.auth.requireView("quotes")'), g = EV.indexOf('ev=await evFirst;');
  assert.ok(a > 0 && r > a && g > r, 'started before the checks, used after them');
  assert.match(EV, /evFirst\.catch\(\(\)=>\{\}\);/);   // no unhandled rejection when a check sends the person away
  assert.doesNotMatch(EV, /try\{ ev=await BPStore\.quotes\.get\(id\); \}/);
});

await t('Boot budget: my_pending shared, bell polls once for all tabs, never while hidden', () => {
  assert.match(STORE, /pending: \(\) => \(supa \? memoRead\("ops\.pending", 5000, \(\) => shareInflight\("ops\.pending", \(\) => rpc\("my_pending"\)\)\)/);
  assert.match(STORE, /function otherTabPolled\(ms\) \{/);
  assert.match(STORE, /document\.hasFocus\(\)\) return false;/);
  assert.match(STORE, /if \(kicked && !document\.hidden && !isOpen && [^\n]*!otherTabPolled\(pollMs\(\) - 2000\)\) refresh\(\);/);
  assert.match(STORE, /const refreshNow = async \(\) => \{ lastRf = Date\.now\(\); bellStamp\(\);/);
  assert.match(STORE, /window\.addEventListener\("focus", onVis\)/);
  assert.match(STORE, /window\.removeEventListener\("focus", onVis\)/);
  // the bell feed is never awaited by a page boot: kick() runs after load / idle
  assert.match(STORE, /else \{\s+const idle = \(\) => \{ if \(window\.requestIdleCallback\) window\.requestIdleCallback\(kick, \{ timeout: 4000 \}\)/);
});

await t('Boot budget: otherTabPolled behaviour (focused tab always polls, unfocused skips a fresh stamp)', () => {
  const m = /function otherTabPolled\(ms\) \{[\s\S]*?\n      \}/.exec(STORE); assert.ok(m);
  const store = new Map(); let focus = false;
  const ctx = { localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }, document: { hasFocus: () => focus },
    bellTab: 'me', bellKey: () => 'bp_bell_poll:u', JSON, Date, Number };
  const fn = vm.runInNewContext('(' + m[0].replace('function otherTabPolled', 'function') + ')', ctx);
  assert.equal(fn(28000), false, 'nobody polled');
  store.set('bp_bell_poll:u', JSON.stringify({ t: Date.now(), tab: 'other' }));
  assert.equal(fn(28000), true, 'another tab just polled');
  focus = true; assert.equal(fn(28000), false, 'focused tab always polls');
  focus = false; store.set('bp_bell_poll:u', JSON.stringify({ t: Date.now(), tab: 'me' })); assert.equal(fn(28000), false, 'own stamp');
  store.set('bp_bell_poll:u', JSON.stringify({ t: Date.now() - 60000, tab: 'other' })); assert.equal(fn(28000), false, 'old stamp');
  ctx.localStorage.getItem = () => { throw new Error('blocked'); }; assert.equal(fn(28000), false, 'storage blocked = poll');
});

await t('Notifications 10 at a time: bell grows by 10 on scroll (max 100, back to 10 on close), inbox keyset + infinite scroll', () => {
  assert.match(STORE, /const BELL_PAGE = 10, BELL_MAX = 100;/);
  assert.match(STORE, /const f = await this\.feed\(bellLimit\);/);
  assert.match(STORE, /if \(!isOpen\) return; isOpen = false; bellLimit = BELL_PAGE;/);
  assert.match(STORE, /bellLimit = Math\.min\(BELL_MAX, bellLimit \+ BELL_PAGE\);/);
  assert.match(STORE, /bellLastCount < bellLimit\) return;/);
  const IB = read('public/inbox.js');
  assert.match(IB, /limit: 10, cursor: more \? S\.cursor : null/);
  assert.match(IB, /new window\.IntersectionObserver\(function \(es\) \{/);
  assert.match(IB, /if \(e\.isIntersecting && S\.cursor && !S\.busy && !\$\("#ibxMore"\)\.hidden\) load\(true\);/);
  assert.match(read('public/inbox.html'), /inbox\.js\?v=5/);
});

await t('Realtime: the bell opens no channel off the Chat page; every channel closes while hidden; leads only this studio', () => {
  assert.match(STORE, /kicked = true; liveRefresh\(\);\n[^\n]*\n[^\n]*\n\s+if \(pageKey\(\) !== "chat"\) return;\n\s+try \{ if \(chat && chat\.subscribe\) \{ csub = chat\.subscribe\(/);
  assert.match(STORE, /const RT_IDLE_MS = 60000;\n  function rtLive\(make, onBack\) \{/);
  assert.equal((STORE.match(/return rtLive\(\(\) => supa\.channel\(/g) || []).length, 3, 'versions, leads, chat');
  assert.equal((STORE.match(/supa\.channel\(/g) || []).length, 3, 'no channel outside rtLive');
  assert.match(STORE, /spec\.filter = "org_id=eq\." \+ oid;/);
});

await t('rtLive behaviour: closes after the idle time while hidden, re-opens + catches up when visible, unsubscribe stops it', async () => {
  const m = /function rtLive\(make, onBack\) \{[\s\S]*?\n  \}/.exec(STORE); assert.ok(m);
  const ls = {}, doc = { hidden: false, addEventListener: (k, f) => { ls[k] = f; }, removeEventListener: (k) => { delete ls[k]; } };
  let opened = 0, removed = 0, back = 0; const timers = [];
  const ctx = { document: doc, RT_IDLE_MS: 60000, supa: { removeChannel: () => { removed++; } },
    setTimeout: (f) => { timers.push(f); return timers.length; }, clearTimeout: () => {} };
  const rtLive = vm.runInNewContext('(' + m[0].replace('function rtLive', 'function') + ')', ctx);
  const h = rtLive(() => { opened++; return {}; }, () => { back++; });
  assert.equal(opened, 1);
  doc.hidden = true; ls.visibilitychange(); timers.pop()(); assert.equal(removed, 1, 'closed while hidden');
  doc.hidden = false; ls.visibilitychange(); assert.equal(opened, 2); assert.equal(back, 1, 'catch-up');
  h.unsubscribe(); assert.equal(removed, 2); assert.equal(ls.visibilitychange, undefined);
});

await t('Per-page prefs: my_notification_prefs + mutes answered once per tab session (swr)', () => {
  assert.match(STORE, /await swr\("nprefs", \(\) => rpc\("my_notification_prefs", \{\}\)\)/);
  assert.match(STORE, /await swr\("nmutes", \(\) => rpc\("my_notification_mutes", \{\}\)\)/);
});

await t('0358: catalog built once per request, _r23_tz without the time zone files, APPLY + MANIFEST', () => {
  const M = read('supabase/migrations/0358_r163_catalog_tz_speed.sql'), A = read('supabase/APPLY-0358.sql');
  assert.match(M, /declare v text := current_setting\('helm\.r358_cat', true\); c jsonb;/);
  assert.match(M, /c := public\.notification_catalog__pre0329\(\);/);
  assert.match(M, /perform pg_catalog\.set_config\('helm\.r358_cat', c::text, true\);/);
  assert.match(M, /-- r156-0354: \+ wa_templates \(once\)/);   // the 0354 re-run guard + checker marker
  assert.match(M, /if exists \(select 1 from public\._r358_tz_names t where t\.name = v\) then/);
  assert.match(M, /alter table public\._r358_tz_names enable row level security;/);
  assert.doesNotMatch(M.replace(/^--.*$/gm, ''), /\bdrop\s+(table|function|policy|index|trigger)\b|\bdelete\s+from\b|\btruncate\b/i);
  assert.equal(A.slice(A.indexOf('begin;\n') + 7, A.indexOf('\ncommit;\n')).trim(), M.trim());
  assert.match(A, /^-- APPLY-0358 \(R163 [^\n]*\)\. Run on STAGING first, then production\. Safe to run twice\.\n/);
  assert.ok(MF.includes('forward  supabase/migrations/0358_r163_catalog_tz_speed.sql'));
  assert.match(read('scripts/db-test/run-all.sh'), /R163-CATALOG-TZ-0358: ALL PASS \\\(9\/9\\\)/);
});

await t('cache-bust: store-api v350 on every page', () => {
  assert.match(EV, /store-api\.js\?v=350/);
  assert.match(read('public/dashboard.html'), /store-api\.js\?v=350/);
});

console.log(`\nr163-perf: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
