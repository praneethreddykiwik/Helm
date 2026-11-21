// r247-p10-scale.test.mjs - R247 fix plan Phase 10 (scale and speed), no database:
//  * 0427-0429 + their APPLY files are additive, ASCII, paste-safe (begin + lock_timeout + statement_timeout, the migration
//    verbatim, check rows, commit), the size cap is NOT VALID, every new number has its schema marker;
//  * Q-11: the builder / event page listen to quote_live_signals (only after schema.has(427)), the old bindings stay as the
//    fallback, a too-big layout gets a plain message;
//  * BELL-02: ONE Realtime channel per topic per tab (rtShared, run in a sandbox) - chat page + bell share one chat channel;
//  * Q-12: a list that reaches the 20,000-row cap shows a "Showing the first 20,000 rows" note (sbAll run in a sandbox);
//  * REP-03: long report ranges are asked in 3-month pieces that never overlap (reportWindows / reportPaged in a sandbox);
//  * FILE-02: every image upload accepts a phone photo up to 25 MB and makes it smaller (no refusal at the bucket cap first);
//  * FILE-04: the Settings storage card + bell kind + tour; PERF-05: /try text is 12 px or larger.
// The database side: tests/db/r247-p10-scale-0427-0429.sql.
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const NUMS = ['0427', '0428', '0429'];
const MIGS = readdirSync(new URL('../supabase/migrations/', import.meta.url));
const MIG = Object.fromEntries(NUMS.map((n) => [n, rd('supabase/migrations/' + MIGS.find((f) => f.startsWith(n + '_')))]));
const APPLY = Object.fromEntries(NUMS.map((n) => [n, rd(`supabase/APPLY-${n}.sql`)]));
const MF = rd('supabase/migrations/MANIFEST'), RA = rd('scripts/db-test/run-all.sh'), PK = JSON.parse(rd('package.json'));
const SA = rd('public/store-api.js'), CH = rd('public/control.html'), CS = rd('public/control-split.js'), PT = rd('public/page-tours.js');
let n = 0;
const fails = (name, e) => { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; };
const pend = [];
const t = (name, fn) => { try { const r = fn(); if (r && typeof r.then === 'function') pend.push(r.then(() => { n++; console.log('  ok ' + name); }, (e) => fails(name, e))); else { n++; console.log('  ok ' + name); } } catch (e) { fails(name, e); } };
const code = (s) => s.replace(/^\s*--.*$/gm, '');
// a top-level function of store-api.js by name (balanced braces from "function name(")
function fnSrc(name) {
  let i = SA.indexOf('function ' + name + '('); assert.ok(i >= 0, name + ' not found');
  if (SA.slice(i - 6, i) === 'async ') i -= 6;
  let d = 0, j = SA.indexOf('{', i);
  for (let k = j; k < SA.length; k++) { if (SA[k] === '{') d++; else if (SA[k] === '}') { d--; if (!d) return SA.slice(i, k + 1); } }
  throw new Error('unbalanced ' + name);
}

t('0427-0429: additive only - no drop table / column, no truncate, no row delete, no validate of the new cap', () => {
  for (const nn of NUMS) {
    const c = code(MIG[nn]);
    assert.doesNotMatch(c, /\bdrop\s+(table|column|schema)\b/i, nn);
    assert.doesNotMatch(c, /\btruncate\b/i, nn);
    assert.doesNotMatch(c, /\bdelete\s+from\b/i, nn);
    assert.doesNotMatch(c, /validate\s+constraint\s+quote_versions_data_size_chk427/i, nn);
    assert.ok(/^[\x00-\x7f]*$/.test(MIG[nn]), nn + ' ASCII');
    assert.match(c, new RegExp(`insert into public\\.helm_schema_markers\\(num, name\\) values \\(${+nn}, '${nn}_r247_`), nn + ' marker');
  }
  assert.match(MIG['0427'], /check \(pg_column_size\(data\) <= 10485760\) not valid/);
  assert.match(MIG['0427'], /exception when others then\s+raise warning 'r247-0427: live signal skipped/);   // never blocks a save
  assert.doesNotMatch(code(MIG['0427']), /drop publication|publication supabase_realtime drop/i);   // old pages keep working
  assert.match(MIG['0428'], /as restrictive for insert to authenticated/);
  assert.match(MIG['0428'], /storage_object_name_ok__pre0428/);
  assert.match(MIG['0429'], /interval '7 days'/); assert.match(MIG['0429'], /interval '1 hour'/);
  for (const nn of NUMS) for (const m of code(MIG[nn]).matchAll(/create or replace function (public\.[a-z0-9_]+)\([^)]*\)\s*returns[^$]*?security definer set search_path = ''/g)) assert.ok(m[1]);
  assert.ok(!/security definer(?! set search_path = '')/.test(code(MIG['0429']).replace(/\n\s*/g, ' ')), '0429 definer + empty search_path');
});
t('APPLY-0427 .. 0429: begin, lock_timeout 5s, statement_timeout, the migration verbatim, one check grid, commit', () => {
  for (const nn of NUMS) {
    const a = APPLY[nn];
    assert.ok(/^[\x00-\x7f]*$/.test(a), nn + ' ASCII');
    assert.match(a, /\nbegin;\nset local lock_timeout = '5s';\nset local statement_timeout = '5min';\n/);
    assert.ok(a.includes(MIG[nn].trimEnd()), nn + ' verbatim');
    assert.equal((a.match(/^select item, ok from \(values$/gm) || []).length, 1, nn + ' one check grid');
    assert.match(a, /\) v\(item, ok\) order by item;\ncommit;\n$/);
    assert.doesNotMatch(a, /^\\/m, nn + ' no psql meta-commands');
    assert.doesNotMatch(a, /create temp|temporary table|set session|set role/i, nn + ' no session state');
    assert.match(a, /staging first, then production|STAGING first, then production/i);
  }
});
t('MANIFEST ends 0427-0429 in order, run-all runs the suite + the APPLY files twice, package runs this test', () => {
  const nums = [...MF.matchAll(/^forward  supabase\/migrations\/(\d{4})_/gm)].map((m) => m[1]);
  assert.deepEqual(nums.slice(nums.indexOf('0427'), nums.indexOf('0427') + 3), NUMS);
  assert.ok(nums.indexOf('0427') > nums.indexOf('0412'));
  assert.match(RA, /run "r247-p10-scale-0427-0429" "R247-P10-SCALE-0427-0429: ALL PASS \\\(36\/36\\\)"/);
  assert.match(RA, /run "r247-apply-0427-0429" "APPLY-0427-0429: ALL OK"/);
  assert.ok(RA.indexOf('r247-apply-0427-0429') < RA.indexOf('run "r232-remove-role-traces-0400"'), 'before the last (0400) run');
  assert.match(PK.scripts.test, /node test\/r247-p10-scale\.test\.mjs/);
  const chk = rd('supabase/CHECK-PROD-MIGRATIONS.sql');
  for (const f of ['0427_r247_layout_live_signals', '0428_r247_stock_upload_cap', '0429_r247_storage_usage']) assert.ok(chk.includes("'" + f + "'"), f);
});

t('Q-11: subscribeVersions listens to quote_live_signals once 0427 is in, the old bindings stay as the fallback', () => {
  const i = SA.indexOf('subscribeVersions(id, cb) {'), s = SA.slice(i, i + 3000);
  assert.match(s, /table: "quote_live_signals", filter: f/);
  assert.match(s, /BPStore\.schema\.has\(427\)/);
  assert.match(s, /table: "quote_versions", filter: f/);   // fallback for a database before 0427
  assert.match(s, /rtShared\("qv:" \+ id/);
  assert.match(SA, /if \(error\) throw layoutTooBig\(error\);/);
  const f = new vm.Script('(' + fnSrc('layoutTooBig').replace('function layoutTooBig', 'function') + ')');
  const ctx = vm.createContext({ LAYOUT_MAX_MB: 10, Error }); const ltb = f.runInContext(ctx);
  const e = ltb({ code: '23514', message: 'new row for relation "quote_versions" violates check constraint "quote_versions_data_size_chk427"' });
  assert.equal(e.code, 'layout_too_big'); assert.match(e.message, /too big to save \(over 10 MB\)/);
  const other = { code: '23514', message: 'other_chk' }; assert.equal(ltb(other), other);
});

t('BELL-02: rtShared keeps ONE channel per key - shared fan-out, closed when the last subscriber leaves', () => {
  const ctx = vm.createContext({ Map, Set });
  vm.runInContext('const RT_SHARED = new Map();\n' + fnSrc('rtShared') + '\nthis.rtShared = rtShared; this.RT_SHARED = RT_SHARED;', ctx);
  let opened = 0, closed = 0, fanOut = null, stOut = null;
  const open = (fan, st) => { opened++; fanOut = fan; stOut = st; return { unsubscribe() { closed++; } }; };
  const got = [];
  const a = ctx.rtShared('chat:x', { cb: (k) => got.push('a' + (k || '')) }, open);
  stOut('SUBSCRIBED');
  const seen = [];
  const b = ctx.rtShared('chat:x', { cb: (k) => got.push('b' + (k || '')), onStatus: (s) => seen.push(s) }, open);
  assert.equal(opened, 1, 'one channel for two subscribers');
  assert.deepEqual(seen, ['SUBSCRIBED'], 'a late subscriber hears the current status');
  fanOut('layout'); assert.deepEqual(got, ['alayout', 'blayout']);
  a.unsubscribe(); a.unsubscribe(); assert.equal(closed, 0, 'still one subscriber left');
  b.unsubscribe(); assert.equal(closed, 1, 'closed with the last one'); assert.equal(ctx.RT_SHARED.size, 0);
  ctx.rtShared('chat:y', { cb() {} }, open); ctx.rtShared('chat:z', { cb() {} }, open); assert.equal(opened, 3, 'other keys = own channels');
  // the chat page and the bell share it
  const ci = SA.indexOf('subscribe(cb, onStatus, chanName) {'), cs = SA.slice(ci, ci + 3200);
  assert.match(cs, /rtShared\("chat:" \+ \(cflt \|\| "all"\)/);
  assert.equal((cs.match(/supa\.channel\(/g) || []).length, 1);
});

t('Q-12: a list at the 20,000-row cap is flagged AND shows a plain "Showing the first 20,000 rows" note once', () => {
  const made = [], events = [];
  const mk = (tag) => { const el = { tag, style: {}, attrs: {}, kids: [], textContent: '', setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.kids.push(c); }, addEventListener() {}, remove() {} }; made.push(el); return el; };
  const body = mk('body');
  const ctx = vm.createContext({ console: { warn() {} }, Number, global: { document: { body, createElement: mk }, dispatchEvent: (e) => events.push(e), CustomEvent: function (type, o) { this.type = type; this.detail = o && o.detail; } } });
  vm.runInContext('const SB_ALL_CHUNK = 1000, SB_ALL_MAX = 20000; let capNoted = false;\n' + fnSrc('sbAll') + '\n' + fnSrc('listCapNote') + '\nthis.sbAll = sbAll;', ctx);
  const build = () => ({ range: async (a, b) => ({ data: Array.from({ length: b - a + 1 }, (_, i) => ({ id: a + i })) }) });
  return ctx.sbAll(build).then(async (rows) => {
    assert.equal(rows.length, 20000); assert.equal(rows.truncated, true);
    const note = made.find((x) => x.attrs.role === 'status');
    assert.ok(note && body.kids.includes(note), 'note on the page');
    assert.match(note.kids[0].textContent, /^Showing the first 20,000 rows of this list\. Use search or a filter to find older ones\.$/);
    assert.equal(events[0].type, 'helm:list-capped'); assert.equal(events[0].detail.cap, 20000);
    await ctx.sbAll(build); assert.equal(body.kids.length, 1, 'once per page');
    const small = await ctx.sbAll(() => ({ range: async () => ({ data: [{ id: 1 }] }) })); assert.equal(small.truncated, undefined);
  });
});

t('REP-03: long ranges in 3-month pieces that never overlap and cover every day; short ranges = one call', async () => {
  const ctx = vm.createContext({ Date, Math, Set, Object, Array });
  vm.runInContext('const REPORT_WINDOW_MONTHS = 3, REPORT_MAX_WINDOWS = 48;\n' + fnSrc('reportWindows') + '\n' + fnSrc('reportPaged') + '\nthis.w = reportWindows; this.p = reportPaged;', ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.w('2025-01-01', '2025-12-31'))), [['2025-01-01', '2025-03-31'], ['2025-04-01', '2025-06-30'], ['2025-07-01', '2025-09-30'], ['2025-10-01', '2025-12-31']]);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.w('2025-02-15', '2025-03-10'))), [['2025-02-15', '2025-03-10']]);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.w(null, '2025-03-10'))), [[null, '2025-03-10']]);
  const w = ctx.w('2024-02-29', '2026-05-07'); const day = (s) => Date.parse(s + 'T00:00:00Z') / 864e5;
  assert.equal(w[0][0], '2024-02-29'); assert.equal(w[w.length - 1][1], '2026-05-07');
  for (let i = 1; i < w.length; i++) assert.equal(day(w[i][0]), day(w[i - 1][1]) + 1, 'back to back');
  const many = ctx.w('2000-01-01', '2030-12-31'); assert.ok(many.length <= 48); assert.equal(many[many.length - 1][1], '2030-12-31');
  const calls = [];
  const one = async (f, tt) => { calls.push([f, tt]); return { from: f, to: tt, finance: true, events: [{ id: f, date: f }, { id: 'dup', date: f }] }; };
  const r = await ctx.p(one, '2025-01-01', '2025-12-31', 500);
  assert.equal(calls.length, 4); assert.equal(r.paged, true); assert.equal(r.capped, false); assert.equal(r.from, '2025-01-01'); assert.equal(r.to, '2025-12-31');
  assert.equal(r.events.length, 5, 'four pieces + one id seen twice kept once');
  const r1 = await ctx.p(one, '2025-01-01', '2025-02-01', 500); assert.equal(r1.paged, undefined, 'a short range = the plain one-call answer');
  const capped = await ctx.p(async (f, tt) => ({ finance: true, events: Array.from({ length: 2 }, (_, i) => ({ id: f + i })) }), '2025-01-01', '2025-12-31', 2);
  assert.equal(capped.capped, true);
  assert.match(SA, /return reportPaged\(one, from, to, 1000\);/); assert.match(SA, /return reportPaged\(one, from, to, 500\);/);
  assert.match(rd('public/insights.html'), /!\(costRes\.value\.paged && !costRes\.value\.capped\) && costRes\.value\.events\.length>=500\)\{/);
});

t('FILE-02: every image upload takes a phone photo up to 25 MB and makes it smaller (no refusal at the bucket cap first)', () => {
  assert.match(SA, /const UG_PHOTO_INPUT_MAX = 25 \* 1024 \* 1024;/);
  for (const m of SA.matchAll(/ugPrepareImage\(file, \{([^}]*)\}/g)) assert.match(m[1], /maxInput: UG_PHOTO_INPUT_MAX/, m[0]);
  assert.doesNotMatch(SA, /if \(file\.size > TASK_PROOF_MAX\) throw/);
  assert.doesNotMatch(SA, /file\.size > INVITE_IMG_MAX \* 3/);
  assert.match(rd('public/work.html'), /f\.size>EV_MAX_INPUT\)/);
  assert.match(rd('public/invite-studio.html'), /f\.size>25\*1024\*1024/);
});

t('FILE-04: Settings storage card (DOM-only module, general section, #storage link), bell kind + link, tour', () => {
  const M = rd('public/storage-usage-settings.js');
  assert.doesNotMatch(M, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.match(M, /B\.storageUsage\.get\(\)/);
  assert.match(CH, /<div class="card" id="stoCard" hidden>/); assert.match(CH, /<script src="storage-usage-settings\.js\?v=\d+"><\/script>/);
  assert.match(CH, /"#storage":"stoCard"/); assert.match(CS, /id==="stoCard"/); assert.match(CS, /"#storage":"general"/);
  assert.match(SA, /rpc\("storage_usage", \{\}\)/);
  assert.match(SA, /storage_usage_high: \["/); assert.match(SA, /if \(k === "storage_usage_high"\) return "control\.html#storage";/);
  assert.match(PT, /sel: "#stoCard", title: "File storage"/); assert.match(PT, /"#storage": "general"/);
});

t('PERF-05: /try text (legal line, tray heading) is 12 px or larger on phones', () => {
  const css = rd('public/try.css');
  for (const m of css.matchAll(/\.try-(legal|tray-h)\{[^}]*font-size:(\d+)px/g)) assert.ok(+m[2] >= 12, m[0]);
});

await Promise.all(pend);
console.log(`r247-p10-scale: ${n} passed`);
