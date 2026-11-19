// R233 log-noise guard: future features must not bring back the errors the production logs showed again and again
// (R91 / R193 / R206 / R231: signed-in calls sent while signed out; R47 / R206 / R212: the same failing read polled again;
// Oct 2026: 404 storms for functions / tables a database did not have yet; R193 / R209: Realtime channels rejoining an
// error forever; PROD-ERRORS-2026-10-29: Sentry merging every database error into one "Object captured" issue).
//  1. every database function the browser calls exists in a migration (no call to a function no migration creates)
//  2. ANON_RPCS (the only functions a signed-out tab may send) is complete: every function a migration grants to anon
//     is in it, and every function the client link pages (client-api.js) call is in it
//  3. the central session gate: a function outside ANON_RPCS sent with the bare anon key is answered locally (401 / 42501);
//     public_* / submit_* and every call with a real sign-in still go out
//  4. the repeat guard: a missing function / table is asked once per page; a failing READ waits before it is sent again
//     (403/404 1 min, 429 Retry-After, 5xx 2 s doubling to 30 s); writes and 401s are never held back
//  5. every Realtime channel goes through rtLive with the error backoff (presence has its own, R209)
//  6. every setInterval poller in public/*.js is on the reviewed list (it must skip hidden tabs / signed-out users)
//  7. telemetry sends a real Error (code as a tag) for a plain Supabase error object
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
const S = read('public/store-api.js');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ok ' + name); };
const rx = (name) => { const m = S.match(new RegExp('const ' + name + ' = (/.*/);')); assert.ok(m, name); return eval(m[1]); };
const ANON = rx('ANON_RPCS'), READ_RPCS = rx('READ_RPCS'), SIGNED_IN_ONLY = rx('SIGNED_IN_ONLY');

// ---- every database function name the browser code calls (same patterns as tests/db/r233-anon-rpcs.sh)
function calledIn(src) {
  const out = new Set();
  for (const m of src.matchAll(/(?:\b(?:rpc|wrpc|rpcOnce)|\.rpc|\b_call)\(\s*["']([a-z_][a-z0-9_]*)["']/g)) out.add(m[1]);
  for (const m of src.matchAll(/(?:\.hq|\bcall)\(\s*["'](hq_[a-z0-9_]*)["']/g)) out.add(m[1]);
  return out;
}
const PUB = readdirSync(new URL('public/', ROOT)).filter((f) => /\.(js|html)$/.test(f));
const CALLED = new Set(); for (const f of PUB) for (const x of calledIn(read('public/' + f))) CALLED.add(x);
const MANIFEST = read('supabase/migrations/MANIFEST').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#')).map((s) => s.split(/\s+/)[1]);
const MIG = MANIFEST.map((f) => [f, read(f).replace(/--[^\n]*/g, '')]);

await t('1. every database function the browser calls is created by a migration (' + CALLED.size + ' names)', () => {
  assert.ok(CALLED.size > 400, 'the scan found the calls');
  const def = new Set();
  for (const [, s] of MIG) for (const m of s.matchAll(/function\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi)) def.add(m[1].toLowerCase());
  const missing = [...CALLED].filter((x) => !def.has(x));
  assert.deepEqual(missing, [], 'called but no migration creates it (every call would be a 404 in the log): ' + missing.join(', '));
});

await t('2a. every function a migration grants to anon is in ANON_RPCS (else a public page would be blocked)', () => {
  const live = new Set();
  const re = /\b(grant|revoke)\s+(?:all(?:\s+privileges)?|execute)\s+on\s+function\s+(?:public\.)?"?([a-z0-9_]+)"?\s*\([^;']*?\)\s*(to|from)\s+([a-z_,\s]+)/gi;
  for (const [, s] of MIG) for (const m of s.matchAll(re)) {
    if (!m[4].toLowerCase().split(/[\s,]+/).includes('anon')) continue;
    if (m[1].toLowerCase() === 'grant') live.add(m[2].toLowerCase()); else live.delete(m[2].toLowerCase());
  }
  assert.ok(live.size > 30, 'grants were found');
  const notListed = [...live].filter((x) => !ANON.test(x) && !/__pre\d+$/.test(x));   // __preNNNN = kept old bodies, server only
  assert.deepEqual(notListed, [], 'granted to anon but not in ANON_RPCS (public/store-api.js): ' + notListed.join(', '));
});
await t('2b. every function the client link pages call (client-api.js, never signed in) is in ANON_RPCS', () => {
  const c = [...calledIn(read('public/client-api.js'))];
  assert.ok(c.length > 20);
  const bad = c.filter((x) => !ANON.test(x));
  assert.deepEqual(bad, [], 'a signed-out page calls a signed-in function (refused every time): ' + bad.join(', '));
});

// ---- 3. the session gate, run for real
const a3 = S.indexOf('  const ANON_RPCS'), b3 = S.indexOf('  /* R233 (log-noise guard), part 2');
assert.ok(a3 > 0 && b3 > a3);
const hdrSrc = S.slice(S.indexOf('  function hdrOf(init, input, name) {'), S.indexOf('  /* R142: a Supabase call that never answers'));
const gate = new Function('READ_RPCS', 'SIGNED_IN_ONLY', 'CFG', hdrSrc + S.slice(a3, b3) + '\nreturn { anonDenied, rpcNameOf };')(READ_RPCS, SIGNED_IN_ONLY, { anonKey: 'ANON' });
const B = 'https://x.supabase.co/rest/v1/';
const asAnon = { method: 'POST', headers: { Authorization: 'Bearer ANON' } }, asUser = { method: 'POST', headers: { Authorization: 'Bearer user.jwt' } };
await t('3a. the gate runs before the network call and before the repeat guard', () => {
  const a = S.indexOf('function authAwareFetchInner'); const body = S.slice(a, a + 600);
  assert.ok(body.indexOf('anonDenied(input, init)') > -1);
  assert.ok(body.indexOf('anonDenied') < body.indexOf('noiseHeld(input, init)') && body.indexOf('noiseHeld') < body.indexOf('coalescedFetch(input, init)'));
  assert.match(body, /coalescedFetch\(input, init\)\.then\(\(res\) => \{\s*noiseSeen\(input, init, res\);/);
});
await t('3b. signed out: every called function outside ANON_RPCS is answered locally, the rest goes out', () => {
  let blocked = 0, open = 0;
  for (const fn of CALLED) {
    const d = gate.anonDenied(B + 'rpc/' + fn, asAnon);
    if (ANON.test(fn)) { assert.equal(d, false, fn + ' is public: must go out'); open++; }
    else { assert.equal(d, true, fn + ' is signed-in only: must not be sent signed out'); blocked++; }
    assert.equal(gate.anonDenied(B + 'rpc/' + fn, asUser), false, fn + ' with a sign-in always goes out');
  }
  assert.ok(blocked > 400 && open > 30, blocked + ' / ' + open);
  for (const fn of ['signin_notice_ping', 'runsheet_team_options', 'bell_feed', 'my_pending', 'event_money_header', 'a_brand_new_signed_in_fn'])
    assert.equal(gate.anonDenied(B + 'rpc/' + fn, asAnon), true, fn);
  for (const fn of ['public_new_thing', 'submit_new_form', 'worker_get_tasks', 'invitation_preview', 'verify_and_consent', 'request_otp'])
    assert.equal(gate.anonDenied(B + 'rpc/' + fn, asAnon), false, fn);
  assert.equal(gate.anonDenied('https://x.supabase.co/auth/v1/token?grant_type=password', asAnon), false, 'auth calls untouched');
  assert.equal(gate.anonDenied('https://x.supabase.co/storage/v1/object/x', asAnon), false, 'storage untouched');
  assert.equal(gate.anonDenied('https://x.supabase.co/functions/v1/send-otp', asAnon), false, 'edge functions untouched');
});

// ---- 4. the repeat guard, run for real (fake clock)
const a4 = S.indexOf('  const NOISE_GONE'), b4 = S.indexOf('  /* R102 (x-browser run)');
assert.ok(a4 > 0 && b4 > a4);
let now = 1e12; const FakeDate = { now: () => now };
const G = new Function('READ_RPCS', 'rpcNameOf', 'Date', hdrSrc + S.slice(a4, b4) + '\nreturn { noiseHeld, noiseSeen, noiseWait, LOCAL_STATS };')(READ_RPCS, gate.rpcNameOf, FakeDate);
const tick = () => new Promise((r) => setTimeout(r, 0));
const res = (status, body, h) => new Response(JSON.stringify(body || {}), { status, headers: h || {} });
const post = (args, auth) => ({ method: 'POST', body: JSON.stringify(args || {}), headers: { Authorization: auth || 'Bearer u1' } });
await t('4a. a function this database does not have yet is asked once per page (same answer from the browser after)', async () => {
  const u = B + 'rpc/event_money_header', i = post({ p_quote: 'q1' });
  assert.equal(G.noiseHeld(u, i), null);
  G.noiseSeen(u, i, res(404, { code: 'PGRST202', message: 'Could not find the function public.event_money_header(p_quote)' })); await tick();
  const h = G.noiseHeld(u, post({ p_quote: 'q2' }));
  assert.ok(h, 'same function + argument names: answered locally'); assert.equal(h.status, 404);
  assert.equal(h.headers.get('X-Helm-Local'), 'missing'); assert.equal((await h.json()).code, 'PGRST202', 'callers still see "missing" (older path)');
  assert.equal(G.noiseHeld(u, post({ p_quote: 'q1', p_new: 1 })), null, 'other argument names = another function');
  G.noiseSeen(B + 'chat_mentions?select=*', { method: 'GET', headers: { Authorization: 'Bearer u1' } }, res(404, { code: 'PGRST205' })); await tick();
  assert.ok(G.noiseHeld(B + 'chat_mentions?select=id', { method: 'GET', headers: { Authorization: 'Bearer u2' } }), 'missing table: once per page');
  G.noiseSeen(B + 'rpc/save_thing', post({ a: 1 }), res(404, { code: 'P0002', message: 'not found' })); await tick();
  assert.equal(G.noiseHeld(B + 'rpc/save_thing', post({ a: 1 })), null, 'an ordinary "not found" answer is not "missing"');
});
await t('4b. a failing READ waits before the same question is sent again; a good answer clears it', async () => {
  const u = B + 'rpc/bell_feed', i = post({ p_limit: 10 });
  G.noiseSeen(u, i, res(500, { code: '57014', message: 'canceling statement due to statement timeout' })); await tick();
  const h = G.noiseHeld(u, i); assert.ok(h); assert.equal(h.status, 500); assert.equal(h.headers.get('X-Helm-Local'), 'backoff');
  assert.equal((await h.json()).code, '57014');
  assert.equal(G.noiseHeld(u, post({ p_limit: 10 }, 'Bearer other-user')), null, 'another sign-in is not held');
  now += 2001; assert.equal(G.noiseHeld(u, i), null, 'after 2 s it goes out again');
  G.noiseSeen(u, i, res(503, {})); await tick(); now += 2001; assert.ok(G.noiseHeld(u, i), 'second failure: 4 s'); now += 2000; assert.equal(G.noiseHeld(u, i), null);
  G.noiseSeen(u, i, res(200, [])); G.noiseSeen(u, i, res(500, {})); await tick(); now += 2001;
  assert.equal(G.noiseHeld(u, i), null, 'a good answer reset the doubling');
  assert.deepEqual([1, 2, 3, 4, 5, 9].map((k) => G.noiseWait(500, k)), [2000, 4000, 8000, 16000, 30000, 30000]);
  assert.equal(G.noiseWait(429, 1, '7'), 7000); assert.equal(G.noiseWait(429, 3, null), 8000); assert.equal(G.noiseWait(403, 1), 60000);
  const g = B + 'event_costs?select=*&quote_id=eq.q', gi = { method: 'GET', headers: { Authorization: 'Bearer u1' } };
  G.noiseSeen(g, gi, res(403, { code: '42501', message: 'permission denied for table event_costs' })); await tick();
  now += 59000; assert.ok(G.noiseHeld(g, gi), '403: same "no" for a minute'); now += 1001; assert.equal(G.noiseHeld(g, gi), null);
});
await t('4c. writes and 401s are never held back', async () => {
  const w = B + 'rpc/record_payment', wi = post({ p_quote: 'q', p_amount: 1 });
  G.noiseSeen(w, wi, res(500, { code: '57014' })); G.noiseSeen(w, wi, res(429, {})); G.noiseSeen(w, wi, res(403, { code: '42501' })); await tick();
  assert.equal(G.noiseHeld(w, wi), null, 'a save always goes out');
  const pw = B + 'quotes?id=eq.q', pi = { method: 'PATCH', body: '{}', headers: { Authorization: 'Bearer u1' } };
  G.noiseSeen(pw, pi, res(500, {})); await tick(); assert.equal(G.noiseHeld(pw, pi), null);
  const r = B + 'rpc/my_pending', ri = post({});
  G.noiseSeen(r, ri, res(401, { code: 'PGRST301' })); await tick(); assert.equal(G.noiseHeld(r, ri), null, '401 = the session check decides');
  assert.equal(G.noiseHeld('https://x.supabase.co/functions/v1/x', { method: 'POST' }), null);
});

await t('4d. R233b: a save that went through clears the read holds (the answer may have changed); a failed save does not', async () => {
  const r = B + 'rpc/my_trial_status', ri = post({});
  G.noiseSeen(r, ri, res(403, { code: '42501', message: 'not authorized' })); await tick();
  assert.ok(G.noiseHeld(r, ri), 'held after the refusal');
  G.noiseSeen(B + 'rpc/create_trial_studio', post({ p_name: 'x' }), res(500, {})); await tick();
  assert.ok(G.noiseHeld(r, ri), 'a FAILED save changes nothing');
  G.noiseSeen(B + 'rpc/create_trial_studio', post({ p_name: 'x' }), res(200, {}));
  assert.equal(G.noiseHeld(r, ri), null, 'the studio now exists: the same read goes out again at once');
  const g = B + 'event_costs?select=*', gi = { method: 'GET', headers: { Authorization: 'Bearer u1' } };
  G.noiseSeen(g, gi, res(500, {})); await tick(); assert.ok(G.noiseHeld(g, gi));
  G.noiseSeen(B + 'event_costs', { method: 'POST', body: '{}', headers: { Authorization: 'Bearer u1' } }, res(201, {}));
  assert.equal(G.noiseHeld(g, gi), null, 'table insert went through: holds cleared');
  G.noiseSeen(g, gi, res(500, {})); await tick(); assert.ok(G.noiseHeld(g, gi));
  G.noiseSeen('https://x.supabase.co/functions/v1/invite-signup', { method: 'POST', body: '{}' }, res(200, {}));
  assert.equal(G.noiseHeld(g, gi), null, 'an edge-function save that went through also clears them');
});
await t('4e. R233b: the guard does not parse request bodies on the normal path (a 300 KB save was parsed twice)', async () => {
  let parses = 0; const J = { parse: (x) => { parses++; return JSON.parse(x); }, stringify: JSON.stringify };
  const G2 = new Function('READ_RPCS', 'rpcNameOf', 'Date', 'JSON', hdrSrc + S.slice(a4, b4) + '\nreturn { noiseHeld, noiseSeen };')(READ_RPCS, gate.rpcNameOf, FakeDate, J);
  const big = JSON.stringify({ p_data: 'x'.repeat(300000) }), w = B + 'rpc/save_layout';
  G2.noiseSeen(w, post({}), res(200, {})); G2.noiseHeld(w, { method: 'POST', body: big });
  G2.noiseSeen(w, { method: 'POST', body: big, headers: {} }, res(200, {}));
  assert.equal(parses, 0, 'nothing held / missing: no body parsed');
  G2.noiseSeen(B + 'rpc/event_money_header', post({ p_quote: 'q' }), res(404, { code: 'PGRST202' })); await tick();
  const before = parses; G2.noiseHeld(w, { method: 'POST', body: big });
  assert.equal(parses, before, 'another function is "missing": this save body is still not parsed');
  assert.ok(G2.noiseHeld(B + 'rpc/event_money_header', post({ p_quote: 'q2' })), 'the missing one is still answered locally');
});

await t('4f. R233b: only PostgREST "no such function / table" is replayed; a save only for 30 s; local answers are counted', async () => {
  const st = G.LOCAL_STATS; assert.ok(st && typeof st.missing === 'number'); assert.match(S, /global\.__helmLocalStats = LOCAL_STATS/, 'window.__helmLocalStats');
  const inside = B + 'rpc/quote_summary', ii = post({ p_quote: 'q' });
  G.noiseSeen(inside, ii, res(404, { code: '42883', message: 'function public._r23_tz(text) does not exist' })); await tick();
  assert.equal(G.noiseHeld(inside, ii), null, '42883 raised INSIDE an existing function is a real bug: not replayed');
  G.noiseSeen(B + 'some_view?select=*', { method: 'GET', headers: {} }, res(404, { code: '42P01' })); await tick();
  const hv = G.noiseHeld(B + 'some_view?select=*', { method: 'GET', headers: {} });
  assert.equal(hv && hv.headers.get('X-Helm-Local'), 'backoff', '42P01 on a read: only the ordinary 1-minute read backoff, never "missing" for the page');
  now += 60001; assert.equal(G.noiseHeld(B + 'some_view?select=*', { method: 'GET', headers: {} }), null);
  const w = B + 'rpc/save_new_thing', wi = post({ p_x: 1 });
  G.noiseSeen(w, wi, res(404, { code: 'PGRST202' })); await tick();
  const m0 = st.missing; assert.ok(G.noiseHeld(w, wi), 'missing save: replayed for a moment'); assert.equal(st.missing, m0 + 1, 'counted');
  assert.ok(st.fn['missing:rpc:save_new_thing(p_x)'] >= 1);
  now += 30001; assert.equal(G.noiseHeld(w, wi), null, 'after 30 s a save goes out again (the migration may have been run)');
  G.noiseSeen(B + 'chat_mentions2?select=*', { method: 'GET', headers: {} }, res(404, { code: 'PGRST205' })); await tick();
  now += 3600e3; assert.ok(G.noiseHeld(B + 'chat_mentions2?select=id', { method: 'GET', headers: {} }), 'a missing READ stays for the page');
});
await t('3c. R233b: the gate\'s own answer is marked and counted; a signed-in tab hitting it sends one Sentry event', () => {
  const a = S.indexOf('function authAwareFetchInner'); const body = S.slice(a, a + 600);
  assert.match(body, /if \(anonDenied\(input, init\)\) \{\s*gateHit\(input\);/);
  assert.match(S, /localHit\("gate", [^;]*currentUser \? "HELM_GATE_SIGNED_IN_TAB" : ""\)/);
  assert.match(body, /"X-Helm-Local": "signed-out"/);
  assert.match(S, /if \(sentry && !LOCAL_SENT\.has\(k\) && LOCAL_SENT\.size < 50\)/, 'one event per page per (kind, name)');
});

// ---- 5. Realtime
await t('5a. every Realtime channel goes through rtLive with the error backoff (presence: own backoff, R209)', () => {
  const all = [...S.matchAll(/supa\.channel\(/g)].length, viaLive = [...S.matchAll(/rtLive\(\(st\) => supa\.channel\(/g)].length;
  const presence = [...S.matchAll(/supa\.channel\("presence:org:"/g)].length;
  assert.equal(viaLive + presence, all, 'a new supa.channel( must use rtLive((st) => ...) and .subscribe(... st(status) ...)');
  assert.ok(viaLive >= 3);
  assert.equal([...S.matchAll(/\.subscribe\(st\)|\.subscribe\(\(status\) => \{ st\(status\);/g)].length, viaLive);
  for (const f of PUB.filter((x) => x !== 'store-api.js' && x.endsWith('.js'))) assert.ok(!/\.channel\(/.test(read('public/' + f).replace(/BroadcastChannel\(/g, '')), f + ': open Realtime channels through BPStore (rtLive)');
});
await t('5b. rtLive: 3 errors in a row = channel removed, opened again after 15-30 s with a catch-up; SUBSCRIBED resets', () => {
  const a = S.indexOf('  const RT_IDLE_MS'), b = S.indexOf('  const MEMO_LIST_MS');
  const timers = []; const removed = []; const made = []; const warns = []; let backs = 0;
  const env = { setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clearTimeout: () => {},
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    supa: { removeChannel: (c) => removed.push(c) }, currentUser: { id: 'u' }, rtTokenExp: Date.now() + 3600e3, Math, console: { warn: (m) => warns.push(m) } };
  const live = new Function(...Object.keys(env), S.slice(a, b) + '\nreturn rtLive;')(...Object.values(env));
  const h = live((st) => { const ch = { id: made.length + 1, st }; made.push(ch); return ch; }, () => { backs++; });
  assert.equal(made.length, 1);
  made[0].st('CHANNEL_ERROR'); made[0].st('TIMED_OUT'); assert.equal(removed.length, 0, 'the library may still recover by itself');
  made[0].st('SUBSCRIBED'); made[0].st('CHANNEL_ERROR'); made[0].st('CHANNEL_ERROR'); assert.equal(removed.length, 0, 'SUBSCRIBED reset the count');
  made[0].st('CHANNEL_ERROR'); assert.equal(removed.length, 1, 'third error in a row: channel removed');
  const tm = timers[timers.length - 1]; assert.ok(tm.ms >= 15000 && tm.ms <= 30000, String(tm.ms));
  made[0].st('CHANNEL_ERROR'); made[0].st('CHANNEL_ERROR'); made[0].st('CHANNEL_ERROR'); assert.equal(removed.length, 1, 'a closed channel no longer counts');
  tm.f(); assert.equal(made.length, 2, 'opened again'); assert.equal(backs, 1, 'catch-up ran');
  made[1].st('CHANNEL_ERROR'); made[1].st('CHANNEL_ERROR'); made[1].st('CHANNEL_ERROR');
  const tm2 = timers[timers.length - 1]; assert.ok(tm2.ms >= 30000 && tm2.ms <= 60000, 'the wait grows: ' + tm2.ms);
  assert.equal(warns.length, 0, 'two rounds: still quiet');
  tm2.f(); made[2].st('CHANNEL_ERROR'); made[2].st('CHANNEL_ERROR'); made[2].st('CHANNEL_ERROR');
  assert.equal(warns.length, 1, 'R233b: the third round in a row says so once');
  const tm3 = timers[timers.length - 1]; tm3.f(); made[3].st('CHANNEL_ERROR'); made[3].st('CHANNEL_ERROR'); made[3].st('CHANNEL_ERROR');
  assert.equal(warns.length, 1, 'only once per page');
  h.unsubscribe(); timers[timers.length - 1].f(); assert.equal(made.length, 4, 'stopped: never reopened');
});

// ---- 6. pollers
/* Reviewed 19 Nov 2026 (R233): each of these timers either skips hidden tabs / signed-out users before it asks the server,
   or does no network at all (animations, countdowns, dialog watchers). A NEW setInterval must be checked the same way and
   then counted here. */
const INTERVALS = {
  'approval-watch.js': 1, 'auth-visual.js': 1, 'auth-ui.js': 1, 'builder-inspector-ui.js': 1, 'crew-self.js': 1, 'delivery-tracker.js': 1,
  'home.js': 2, 'google-gis.js': 1, 'hq-referrals.js': 1, 'inbox.js': 1, 'hq.js': 1, 'live-board.js': 1, 'marketing-features.js': 1,
  'mobile-nav.js': 1, 'monitor.js': 1, 'ops-board.js': 1, 'quote-validity.js': 1, 'shell-b-privacy.js': 3, 'shell-b-dash.js': 2,
  'store-api.js': 3, 'shell-b.js': 3, 'trial-lock.js': 1, 'when-picker.js': 1, 'task-status.js': 1,
  'chat.html': 1, 'login.html': 2, 'work.html': 2,
};
await t('6. every setInterval poller is on the reviewed list (skips hidden tabs / signed-out users)', () => {
  const got = {};
  for (const f of PUB.filter((x) => x !== 'client-api.js')) { const c = [...read('public/' + f).matchAll(/\bsetInterval\(/g)].length; if (c) got[f] = c; }
  assert.deepEqual(got, INTERVALS, 'a poller was added or removed: check it skips hidden tabs + signed-out users, then update INTERVALS');
});

// ---- 7. telemetry
await t('7. telemetry: a plain Supabase error object reaches Sentry as a real Error with the code as a tag', () => {
  const captured = {}; const handlers = {};
  const doc = { head: { appendChild: (s) => { captured.script = s; } }, createElement: () => ({}) };
  const w = { HELM_TELEMETRY: { dsn: 'https://k9@o1.ingest.sentry.io/2', env: 'production' }, addEventListener(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); }, document: doc };
  const ctx = vm.createContext({ window: w, document: doc, location: { pathname: '/', reload() {} }, navigator: {}, console });
  vm.runInContext(read('public/telemetry.js'), ctx);
  const sent = []; w.Sentry = { init() {}, captureException: (e, x) => sent.push([e, x]) };
  w.HelmTelemetry.report('rpc', { code: '57014', details: null, hint: null, message: 'canceling statement due to statement timeout for a@b.com' });
  captured.script.onload();
  w.HelmTelemetry.report('rpc', { code: '42501', message: 'permission denied for function bell_feed' });
  assert.equal(sent.length, 2, 'the early one waited for the SDK, the later one went at once');
  const [e1, x1] = sent[0], [e2, x2] = sent[1];
  assert.equal(e1.name, 'HelmError'); assert.match(e1.message, /^\[rpc\] 57014 canceling statement/); assert.ok(!/a@b\.com/.test(e1.message), 'redacted');
  assert.equal(x1.tags.pg_code, '57014'); assert.equal(x2.tags.pg_code, '42501');
  assert.equal(JSON.stringify(x1.fingerprint), JSON.stringify(['{{ default }}', 'rpc', '57014']), 'R233b: grouped by kind + code, not only by the (shared) stack');
  assert.equal(JSON.stringify(x2.fingerprint), JSON.stringify(['{{ default }}', 'rpc', '42501'])); assert.match(e2.message, /^\[rpc\] 42501 permission denied/);
  const real = new (vm.runInContext('Error', ctx))('x'); sent.length = 0; w.HelmTelemetry.report('error', real);
  assert.equal(sent[0][0], real, 'a real Error is passed as it is'); assert.equal(sent[0][1].tags, undefined); assert.equal(sent[0][1].fingerprint, undefined);
});

await t('7b. R233b: Sentry\'s own record of a plain-object rejection is named by its code and grouped by it', () => {
  const w = { HELM_TELEMETRY: {}, addEventListener() {}, document: { head: { appendChild() {} }, createElement: () => ({}) } };
  const ctx = vm.createContext({ window: w, document: w.document, location: { pathname: '/', reload() {} }, navigator: {}, console });
  vm.runInContext(read('public/telemetry.js'), ctx);
  const ev = { exception: { values: [{ type: 'UnhandledRejection', value: 'Object captured as promise rejection with keys: code, details, hint, message' }] },
    extra: { __serialized__: { code: '57014', message: 'canceling statement due to statement timeout for a@b.com' } } };
  const out = w.HelmTelemetry.redactEvent(ev);
  assert.match(out.exception.values[0].value, /^\[sdk\] 57014 canceling statement/); assert.ok(!/a@b\.com/.test(out.exception.values[0].value), 'redacted');
  assert.equal(JSON.stringify(out.fingerprint), JSON.stringify(['{{ default }}', 'sdk', '57014'])); assert.equal(out.tags.pg_code, '57014');
  const plain = w.HelmTelemetry.redactEvent({ exception: { values: [{ type: 'TypeError', value: 'x is null' }] } });
  assert.equal(plain.fingerprint, undefined, 'a real error is left alone');
});
console.log(`\nr233-log-noise-guard: ${n} passed`);
