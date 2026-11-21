// r241-concurrent-edits.test.mjs - R241 fix plan Phase 4 "concurrent edits" (20 Nov 2026):
//  1. rtLive (store-api.js): a re-SUBSCRIBED after CHANNEL_ERROR / TIMED_OUT / CLOSED runs the catch-up ONCE (RT-01); the
//     first SUBSCRIBED never does; the browser coming back online catches up; a re-open is not doubled
//  2. quotes.addVersion: with a base version it calls add_quote_version_checked; a newer version = NEWER_VERSION error with
//     the facts (nothing written); save_as_new passed through; a server without 0407 falls back to the old call (once
//     detected, remembered); a duplicate version number (23505) is retried once; no base = the old call
//  3. quotes.updateMeta: the lock token is meta_rev seen with that updated_at (0408); a stale counter = CONFLICT with the
//     plain sentence; an unknown stamp / no column = the old updated_at check; 0 rows + same counter = NOT_SAVED
//  4. leads board: a teammate's change within 2 s of your own save (or during a drag) is delayed, never dropped (RT-02)
//  5. builder: the save sends the base version, the conflict dialog offers Reload / Save mine as a new version, Reload keeps
//     a copy first, the base is NOT moved by a realtime list refresh, the name is written only when it changed
//  6. SQL: 0407 / 0408 + APPLY files pasteable (ASCII, one transaction, lock_timeout 5s, statement_timeout 5min, no temp
//     table / session state, check rows), MANIFEST order with the reserved gap, run-all suites, prod checker rows
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
const S = read('public/store-api.js');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ok ' + name); };
// the text of `async <name>(...) {...}` starting at a marker (brace matched, strings ignored well enough for this file)
function block(src, marker) {
  const i = src.indexOf(marker); assert.ok(i >= 0, 'missing: ' + marker);
  let j = src.indexOf('{', i), d = 0;
  for (; j < src.length; j++) { const c = src[j]; if (c === '{') d++; else if (c === '}') { d--; if (!d) break; } }
  return src.slice(i, j + 1);
}

// ---- 1. rtLive
const rtA = S.indexOf('  const RT_IDLE_MS'), rtB = S.indexOf('  const MEMO_LIST_MS');
function mkLive() {
  const timers = [], made = [], winL = {}; let backs = [];
  const env = { setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clearTimeout: () => {},
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    window: { addEventListener: (k, f) => { winL[k] = f; }, removeEventListener: (k) => { delete winL[k]; } },
    supa: { removeChannel() {} }, currentUser: { id: 'u' }, rtTokenExp: Date.now() + 3600e3, Math, console: { warn() {} } };
  const live = new Function(...Object.keys(env), S.slice(rtA, rtB) + '\nreturn rtLive;')(...Object.values(env));
  const h = live((st) => { const ch = { st }; made.push(ch); return ch; }, (why) => { backs.push(why === undefined ? 'reopen' : why); });
  return { h, made, timers, winL, backs: () => backs };
}
await t('1a. rtLive: the first SUBSCRIBED does not catch up; CHANNEL_ERROR -> SUBSCRIBED (library rejoin) catches up once', () => {
  const L = mkLive();
  L.made[0].st('SUBSCRIBED'); assert.deepEqual(L.backs(), [], 'first join: the page has just loaded');
  L.made[0].st('CHANNEL_ERROR'); L.made[0].st('SUBSCRIBED'); assert.deepEqual(L.backs(), ['rejoin']);
  L.made[0].st('SUBSCRIBED'); assert.deepEqual(L.backs(), ['rejoin'], 'a repeated SUBSCRIBED without a drop: nothing');
  L.made[0].st('TIMED_OUT'); L.made[0].st('TIMED_OUT'); L.made[0].st('SUBSCRIBED'); assert.deepEqual(L.backs(), ['rejoin', 'rejoin'], 'two errors, one rejoin = one catch-up');
  L.made[0].st('CLOSED'); L.made[0].st('SUBSCRIBED'); assert.deepEqual(L.backs(), ['rejoin', 'rejoin', 'rejoin'], 'CLOSED then SUBSCRIBED');
});
await t('1b. rtLive: back online -> catch-up; after unsubscribe nothing; a re-open after the backoff is not doubled by its first SUBSCRIBED', () => {
  const L = mkLive(); L.made[0].st('SUBSCRIBED');
  assert.equal(typeof L.winL.online, 'function', 'listens for online'); L.winL.online(); assert.deepEqual(L.backs(), ['online']);
  L.made[0].st('CHANNEL_ERROR'); L.made[0].st('CHANNEL_ERROR'); L.made[0].st('CHANNEL_ERROR');   // removed, backoff timer
  L.timers[L.timers.length - 1].f(); assert.equal(L.made.length, 2); assert.deepEqual(L.backs(), ['online', 'reopen']);
  L.made[1].st('SUBSCRIBED'); assert.deepEqual(L.backs(), ['online', 'reopen'], 'the new channel\'s first SUBSCRIBED: no second catch-up');
  L.h.unsubscribe(); assert.equal(L.winL.online, undefined, 'online listener removed');
});
await t('1c. chat, leads board and builder version lists all ride rtLive (catch-up = their full refetch); leads keeps the live pill on a rejoin', () => {
  assert.match(S, /return rtLive\(\(st\) => supa\.channel\("leads-rt"\)/);
  assert.match(S, /return rtLive\(\(st\) => supa\.channel\(chanName \|\| "chat-rt"\)/);
  assert.match(S, /return rtLive\(\(st\) => supa\.channel\("qv-rt-"/);
  assert.match(S, /\(why\) => \{ if \(onStatus && !why\) onStatus\("CONNECTING"\);/);
  assert.match(read('public/chat.html'), /function onRealtime\(\)\{ clearTimeout\(rtT\); rtT=setTimeout\(async\(\)=>\{ await refresh\(\); if\(activeId\)\{ await loadThread\(\);/);
});

// ---- 2. addVersion
const helpers = block(S, 'function newerVersionError(r)');
const addV = block(S, '    async addVersion(quoteId, label, data, objectCount, opts)');
function mkAdd(answers) {
  const calls = [];
  const supa = { rpc: async (fn, args) => { calls.push([fn, args]); const a = answers.shift(); return typeof a === 'function' ? a(fn, args) : a; } };
  const isMissingFn = (e) => !!e && (e.code === 'PGRST202' || e.code === '42883');
  const o = new Function('supa', 'isMissingFn', 'setTimeout', 'let qvCheckedMissing = false;\n' + helpers + '\nreturn { ' + addV.trim() + ' };')(supa, isMissingFn, (f) => f());
  return { o, calls };
}
const VROW = { id: 'v', quote_id: 'q', version_no: 5, label: null, object_count: 1, created_at: 'x', created_by: 'me' };
await t('2a. addVersion with a base: add_quote_version_checked(p_base_version, p_save_as_new); ok -> the version row', async () => {
  const { o, calls } = mkAdd([{ data: { ok: true, version: VROW }, error: null }]);
  const v = await o.addVersion('q', null, { items: [] }, 1, { baseVersion: 4 });
  assert.equal(v.version_no, 5);
  assert.equal(calls[0][0], 'add_quote_version_checked'); assert.equal(calls[0][1].p_base_version, 4); assert.equal(calls[0][1].p_save_as_new, false);
  const m = mkAdd([{ data: { ok: true, version: VROW }, error: null }]);
  await m.o.addVersion('q', 'Saved after V7 (both kept)', { items: [] }, 1, { baseVersion: 4, saveAsNew: true });
  assert.equal(m.calls[0][1].p_save_as_new, true);
});
await t('2b. a newer version: NEWER_VERSION with the facts, nothing retried / re-sent', async () => {
  const { o, calls } = mkAdd([{ data: { ok: false, conflict: 'newer_version', latest_version: 7, latest_by: 'u2', latest_by_me: false, latest_at: '2026-11-20T10:00:00Z', base_version: 4, message: 'Someone saved a newer version (V7) after you opened V4. Nothing was saved and nothing was overwritten.' }, error: null }]);
  await assert.rejects(o.addVersion('q', null, { items: [] }, 1, { baseVersion: 4 }), (e) => {
    assert.equal(e.code, 'NEWER_VERSION'); assert.deepEqual(e.conflict, { latestVersion: 7, latestBy: 'u2', latestByMe: false, latestAt: '2026-11-20T10:00:00Z', baseVersion: 4 });
    assert.match(e.message, /Nothing was saved and nothing was overwritten/); return true; });
  assert.equal(calls.length, 1);
});
await t('2c. a server without 0407: falls back to add_quote_version and stops asking; no base = the old call', async () => {
  const { o, calls } = mkAdd([{ data: null, error: { code: 'PGRST202', message: 'not found' } }, { data: VROW, error: null }, { data: VROW, error: null }]);
  await o.addVersion('q', null, { items: [] }, 1, { baseVersion: 4 });
  await o.addVersion('q', null, { items: [] }, 1, { baseVersion: 5 });
  assert.deepEqual(calls.map((c) => c[0]), ['add_quote_version_checked', 'add_quote_version', 'add_quote_version']);
  const b = mkAdd([{ data: [VROW], error: null }]); const v = await b.o.addVersion('q', null, { items: [] }, 1);
  assert.equal(b.calls[0][0], 'add_quote_version'); assert.equal(v.version_no, 5);
});
await t('2d. two saves at the same moment on an older server (23505): ONE automatic retry; other errors are not retried', async () => {
  const { o, calls } = mkAdd([{ data: null, error: { code: '23505', message: 'duplicate key' } }, { data: { ok: true, version: VROW }, error: null }]);
  assert.equal((await o.addVersion('q', null, { items: [] }, 1, { baseVersion: 4 })).version_no, 5); assert.equal(calls.length, 2);
  const x = mkAdd([{ data: null, error: { code: '23505' } }, { data: null, error: { code: '23505' } }]);
  await assert.rejects(x.o.addVersion('q', null, {}, 1, { baseVersion: 4 }), (e) => e.code === '23505'); assert.equal(x.calls.length, 2, 'only once');
  const y = mkAdd([{ data: null, error: { code: '42501', message: 'not authorized' } }]);
  await assert.rejects(y.o.addVersion('q', null, {}, 1, { baseVersion: 4 }), (e) => e.code === '42501'); assert.equal(y.calls.length, 1);
});
await t('2e. the local (no server) tier answers the same conflict', () => {
  const ls = block(S, '    async addVersion(id, label, data, objectCount, opts)');
  assert.match(ls, /no - 1 > base\) \{/); assert.match(ls, /throw newerVersionError\(/);
  assert.match(S, /addVersion: \(id, label, data, objectCount, opts\) => qt\(\)\.addVersion\(id, label, data, objectCount, opts\)/);
});

// ---- 3. updateMeta
const upd = block(S, '    async updateMeta(quoteId, patch, expectedUpdatedAt)');
const metaHelpers = block(S, 'function noteMetaRev(row)') + '\n' + S.match(/function metaRevFor\(id, stamp\) \{[^\n]*\}/)[0] + '\n' + block(S, 'function sameStamp(a, b)');
const CONFLICT_MSG = S.match(/const CONFLICT_MSG = ("[^"]*");/)[1];
function mkUpd(db, opts) {
  const sent = [];
  const supa = { from: () => {
    const st = { op: 'select', filt: [], cols: null, upd: null };
    const ch = {
      update(u) { st.op = 'update'; st.upd = u; return ch; }, select(c) { if (st.op !== 'update') st.cols = c; return st.op === 'update' ? run() : ch; },
      eq(k, v) { st.filt.push([k, v]); return ch; }, maybeSingle() { return run(true); } };
    const run = async (single) => {
      sent.push(JSON.parse(JSON.stringify(st)));
      if (st.op === 'update') {
        if (opts && opts.noColumn && st.filt.some((f) => f[0] === 'meta_rev')) return { data: null, error: { code: '42703', message: 'column quotes.meta_rev does not exist' } };
        const okRow = st.filt.every(([k, v]) => (k === 'id' ? v === db.id : k === 'meta_rev' ? String(db.meta_rev) === String(v) : k === 'updated_at' ? db.updated_at === v : true));
        if (!okRow || (opts && opts.refuse)) return { data: [], error: null };
        Object.assign(db, st.upd); db.updated_at = 'T' + (++db.n); if (st.upd.title) db.meta_rev++;
        return { data: [{ ...db }], error: null };
      }
      return { data: single ? { ...db } : [{ ...db }], error: null };
    };
    return ch; } };
  const isMissingColumn = (e) => !!e && (e.code === '42703' || e.code === 'PGRST204');
  const o = new Function('supa', 'isMissingColumn', 'CONFLICT_MSG', 'const _metaRevSeen = new Map();\n' + metaHelpers + '\nreturn { noteMetaRev, ' + upd.trim() + ' };')(supa, isMissingColumn, JSON.parse(CONFLICT_MSG));
  return { o, sent };
}
await t('3a. updateMeta locks on the details counter seen with that updated_at: a layout autosave in between is NOT a conflict', async () => {
  const db = { id: 'q', title: 'A', meta_rev: 3, updated_at: 'T0', n: 0 };
  const { o, sent } = mkUpd(db);
  o.noteMetaRev({ ...db });                       // the page read the event (get)
  db.updated_at = 'T-layout';                     // a teammate's layout save moved updated_at only
  const row = await o.updateMeta('q', { title: 'B' }, 'T0');
  assert.equal(row.title, 'B'); assert.deepEqual(sent[0].filt, [['id', 'q'], ['meta_rev', 3]]);
});
await t('3b. a stale counter (a teammate changed a detail) -> CONFLICT with the plain sentence, nothing written', async () => {
  const db = { id: 'q', title: 'A', meta_rev: 3, updated_at: 'T0', n: 0 };
  const { o } = mkUpd(db); o.noteMetaRev({ ...db });
  db.title = 'Teammate'; db.meta_rev = 4; db.updated_at = 'T9';
  await assert.rejects(o.updateMeta('q', { title: 'Mine' }, 'T0'), (e) => { assert.equal(e.code, 'CONFLICT'); assert.match(e.message, /^Someone saved a newer version of this event since you opened it\. Nothing was overwritten/); return true; });
  assert.equal(db.title, 'Teammate');
});
await t('3c. unknown stamp -> the old updated_at check; a database without meta_rev -> the old check; refused + same counter -> NOT_SAVED', async () => {
  const db = { id: 'q', title: 'A', meta_rev: 3, updated_at: 'T0', n: 0 };
  const a = mkUpd(db); await a.o.updateMeta('q', { title: 'B' }, 'T0'); assert.deepEqual(a.sent[0].filt, [['id', 'q'], ['updated_at', 'T0']]);
  const db2 = { id: 'q', title: 'A', meta_rev: 3, updated_at: 'T0', n: 0 };
  const b = mkUpd(db2, { noColumn: true }); b.o.noteMetaRev({ ...db2 });
  await b.o.updateMeta('q', { title: 'B' }, 'T0'); assert.deepEqual(b.sent.map((x) => x.filt[1][0]), ['meta_rev', 'updated_at']);
  const db3 = { id: 'q', title: 'A', meta_rev: 3, updated_at: 'T0', n: 0 };
  const c = mkUpd(db3, { refuse: true }); c.o.noteMetaRev({ ...db3 });
  await assert.rejects(c.o.updateMeta('q', { title: 'B' }, 'T0'), (e) => e.code === 'NOT_SAVED');
});
await t('3d. quotes.get records the counter; the old pages without a token keep last-write-wins (unchanged)', () => {
  assert.match(S, /noteMetaRev\(q\);   \/\/ R241 \(0408\)/);
  assert.match(read('public/flow.html'), /updateMeta\(id,\{ pricing: next \}, ev\.updatedAt\)/);
});

// ---- 4. leads board
await t('4. leads: a change within 2 s of your own save (or during a drag) waits and reloads after - never dropped', () => {
  const L = read('public/leads.html');
  assert.ok(!/if\(Date\.now\(\)-lastLocalWrite<2000\) return;/.test(L), 'the early return is gone');
  const fn = block(L, 'function rtKick()');
  const timers = []; let loads = 0;
  const env = { lastLocalWrite: 0, dragging: false };
  const kick = new Function('env', 'setTimeout', 'clearTimeout', 'load', `let rtReloadTimer=null; let lastLocalWrite, dragging;
    const sync=()=>{ lastLocalWrite=env.lastLocalWrite; dragging=env.dragging; };
    ${fn.replace(/\{/, '{ sync();').replace(/rtReloadTimer=setTimeout\(\(\)=>\{/, 'rtReloadTimer=setTimeout(()=>{ sync();')}
    return rtKick;`)(env, (f, ms) => { timers.push({ f, ms }); return timers.length; }, () => {}, () => { loads++; });
  env.lastLocalWrite = Date.now() - 500;          // my save 0.5 s ago, a teammate's change arrives now
  kick(); const w = timers[timers.length - 1].ms; assert.ok(w >= 1400 && w <= 1700, 'waits for the end of the 2 s window: ' + w);
  env.lastLocalWrite = Date.now() - 5000; timers[timers.length - 1].f(); assert.equal(loads, 1, 'then reloads');
  env.dragging = true; kick(); timers[timers.length - 1].f(); assert.equal(loads, 1, 'still dragging: waits again');
  env.dragging = false; timers[timers.length - 1].f(); assert.equal(loads, 2, 'drag over: reloads');
  assert.match(L, /\(\)=>\{ rtKick\(\); \},/);
});

// ---- 5. builder
const B = read('public/builder.js'), BH = read('public/builder.html');
await t('5a. builder save sends the base version; the base moves on open / own save / a knowing pick, NOT on a realtime refresh', () => {
  assert.match(B, /BPStore\.quotes\.addVersion\(currentQuoteId, label, data, store\.items\.length, \{ baseVersion: baseVersionNo, saveAsNew \}\)/);
  assert.match(B, /baseVersionNo = currentVersionNo;        \/\/ R241/);
  assert.match(B, /baseVersion[A-Za-z]* = latestVersionNo;       \/\/ R241/);
  assert.match(block(B, 'function loadVersionIntoEditor(no, data)'), /baseVersionNo=Math\.max\(\+latestVersionNo\|\|0, \+no\|\|0\)/);
  assert.ok(!/baseVersionNo/.test(block(B, 'async function refreshVersions()')), 'a list refresh never moves the base');
});
await t('5b. a NEWER_VERSION answer: nothing lost, the dialog offers Reload / Save mine as a new version / Keep editing', () => {
  assert.match(B, /if\(e && e\.code==='NEWER_VERSION'\)\{ saveUi='dirty'; renderSaveState\('dirty'\); const c=e\.conflict\|\|\{\}; setTimeout\(\(\)=>\{ onSaveConflict\(c\); \},0\); return false; \}/);
  assert.match(BH, /<b id="conflictModalTitle">Someone saved a newer version<\/b>/);
  assert.match(BH, /data-choice="reload" id="conflictReloadBtn">Reload</); assert.match(BH, /data-choice="mine">Save mine as a new version</);
  assert.match(BH, /data-choice="cancel">Keep editing</);
  const on = block(B, 'async function onSaveConflict(c)');
  assert.match(on, /saveLayout\(false,\{ saveAsNew:true, label:'Saved after V'\+latestNo\+' \(both kept\)' \}\)/);
  assert.match(on, /reloadLatestKeepingMine\(latestNo\)/); assert.match(on, /conflictSnoozed=true/);
});
await t('5c. Reload keeps a copy FIRST (stops if it cannot), then opens the newer version; the copy can be put back or discarded (asked)', () => {
  const r = block(B, 'async function reloadLatestKeepingMine(no)');
  const keep = r.indexOf('localStorage.setItem(conflictKey(qid)'), load = r.indexOf('loadVersionIntoEditor(no, target.data)');
  assert.ok(keep > 0 && load > keep, 'copy kept before the canvas is replaced');
  assert.match(r, /catch\(e\)\{ await BPUI\.alert\('This browser could not keep a copy of your changes, so nothing was reloaded\./);
  assert.match(BH, /id="conflictPutBackBtn"[^>]*>Put my changes back</); assert.match(BH, /id="conflictDiscardBtn">Discard copy</);
  assert.match(B, /BPUI\.confirm\('Delete the copy of your unsaved changes kept in this browser\?/);
  assert.match(B, /showConflictCopyBar\(\);               \/\/ R241: a copy kept by "Reload"/);
});
await t('5d. background saves pause while a conflict waits; the event name is written only when changed, under the lock', () => {
  assert.match(B, /if\(silent && currentQuoteId && \(conflictOpen \|\| conflictSnoozed\)\) return false;/);
  assert.ok(!/updateMeta\(currentQuoteId, \{ title:name \}\); \}catch\{\}/.test(B), 'the old every-save title write is gone');
  const s = block(B, 'async function saveTitleIfChanged(name)');
  assert.match(s, /if\(!currentQuoteId \|\| name===syncedTitle\) return;/);
  assert.match(s, /updateMeta\(currentQuoteId, \{ title:name \}, fresh \? fresh\.updatedAt : undefined\)/);
  assert.match(s, /your name was not saved \(nothing overwritten\)/);
});

// ---- 6. SQL + release plumbing
const M7 = read('supabase/migrations/0407_r241_layout_save_conflict.sql'), M8 = read('supabase/migrations/0408_r241_quote_meta_rev.sql');
const A7 = read('supabase/APPLY-0407.sql'), A8 = read('supabase/APPLY-0408.sql');
await t('6a. migrations additive + ASCII: no DROP / DELETE / UPDATE / TRUNCATE of data; the old wrapper kept as __pre0407', () => {
  for (const [f, s] of [['0407', M7], ['0408', M8]]) {
    assert.ok(!/[^\x09\x0a\x0d\x20-\x7e]/.test(s), f + ' ASCII');
    const code = s.replace(/--[^\n]*/g, '');
    assert.ok(!/\b(drop\s+(table|column|function|trigger|policy)|delete\s+from|truncate)\b/i.test(code), f + ' nothing dropped / deleted');
    assert.ok(!/^\s*update\s+public\./im.test(code), f + ' no data update');
  }
  assert.match(M7, /alter function public\.add_quote_version\(uuid, text, jsonb, integer\) rename to add_quote_version__pre0407;/);
  assert.match(M7, /pg_advisory_xact_lock/); assert.match(M8, /add column if not exists meta_rev bigint not null default 0/);
});
await t('6b. APPLY-0407 / APPLY-0408: one transaction, lock_timeout 5s, statement_timeout 5min, the migration verbatim, check rows, pasteable', () => {
  for (const [a, m] of [[A7, M7], [A8, M8]]) {
    assert.match(a, /^begin;\nset local lock_timeout = '5s';\nset local statement_timeout = '5min';\n/m);
    assert.ok(a.includes(m), 'migration verbatim'); assert.match(a, /\ncommit;\n$/);
    assert.equal((a.match(/^begin;$/gm) || []).length, 1); assert.equal((a.match(/^commit;$/gm) || []).length, 1);
    assert.ok(!/[^\x09\x0a\x0d\x20-\x7e]/.test(a), 'ASCII'); assert.ok(!/^\s*\\/m.test(a), 'psql meta');
    assert.ok(!/\bcreate\s+(temp|temporary)\s+table\b/i.test(a), 'temp table'); assert.ok(!/\bset\s+(session|role)\b|^\s*set\s+(?!local)/im.test(a), 'session state');
    assert.ok((a.match(/^  select '0\d /gm) || []).length + (a.match(/^  select '0\d [^']*' as item,/gm) || []).length >= 6, 'check rows');
  }
});
await t('6c. MANIFEST: 0407 then 0408 after 0403 (0404-0406 reserved, numeric order kept); run-all suites; prod checker rows; release lists', () => {
  const man = read('supabase/migrations/MANIFEST');
  const nums = [...man.matchAll(/^forward  supabase\/migrations\/(\d{4})_/gm)].map((m) => m[1]);
  assert.ok(nums.indexOf('0407') > nums.indexOf('0403') && nums.indexOf('0408') === nums.indexOf('0407') + 1);
  const ra = read('scripts/db-test/run-all.sh');
  assert.match(ra, /^run "r241-concurrent-edits-0407" "R241-CONCURRENT-EDITS-0407: ALL PASS \\\(21\/21\\\)" psql -q -f tests\/db\/r241-concurrent-edits-0407\.sql$/m);
  assert.match(ra, /^run "r241-qv-race-0407" "R241-QV-RACE-0407: PASS" bash tests\/db\/r241-qv-race-0407\.sh$/m);
  assert.match(ra, /^run "r241-apply-order-0407" "R241-APPLY-ORDER-0407: PASS" bash tests\/db\/r241-apply-order-0407\.sh$/m);
  const chk = read('supabase/CHECK-PROD-MIGRATIONS.sql');
  assert.match(chk, /\('0407_r241_layout_save_conflict', 'fn', 'public', 'add_quote_version_checked', 'uuid,text,jsonb,integer,integer,boolean'\)/);
  assert.match(chk, /\('0408_r241_quote_meta_rev', 'trg', 'public\.quotes', 'zzzzz_r408_meta_rev', null\)/);
  for (const f of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.match(read(f), /'0403', '0404', '0405', '0407', '0408', '0409', '0410', '0411', '0412'\]/);
});
console.log('r241-concurrent-edits: ' + n + ' passed');
