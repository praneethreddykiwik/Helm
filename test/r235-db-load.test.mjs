// r235-db-load.test.mjs - R235 (owner read-only prod measurement 19 Nov 2026: 595 GB of temporary files since 25 Aug,
// auth 500s + 57014 timeouts while the database was busy). The shape of the 0401 fix, read from the files:
//   1. the bell window: _r401_vis / _r401_rows are made from the live _r388_vis / _r388_rows text (never typed twice),
//      limited to the last 90 days (+ rows the person touched in that time), one filter on the rows (0388's plan kept)
//   2. the bell / my_pending / inbox bodies are patched in place, old bodies kept as __pre0401, the Inbox keeps everything
//   3. request keys: <name>_once wrappers + rpc_request_keys; the page keeps one key per press until an answer arrives
//   4. jobs: lock_timeout per function; role / database settings untouched
//   5. APPLY-0401: the two "set local" lines first, check rows last; runbook template; MANIFEST / checker / run-all
//   6. polling: the 30 s refresher backs off after a failed or slow refresh; the bell skips a poll after a slow answer
// Behaviour (old vs new answers per person, request keys, timings): tests/db/r235-db-load-0401.sql.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const ROOT = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
let n = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const MIG = read('supabase/migrations/0401_r235_db_load.sql'), APPLY = read('supabase/APPLY-0401.sql');
const API = read('public/store-api.js'), TS = read('public/task-status.js'), MON = read('public/monitor.js');

t('migration + APPLY are ASCII; APPLY opens with the two set local lines and ends with check rows + commit', () => {
  for (const [f, s] of [['migration', MIG], ['APPLY', APPLY]]) assert.ok(!/[^\x00-\x7F]/.test(s), f + ' is ASCII');
  assert.match(APPLY, /\nbegin;\nset local lock_timeout = '5s';\nset local statement_timeout = '5min';\n/);
  assert.ok(APPLY.includes(MIG), 'APPLY carries the whole migration');
  assert.match(APPLY, /\) v\(item, ok\) order by item;\ncommit;\n$/);
  assert.ok(!/create temp|create temporary|^\s*set (?!local )/im.test(MIG + APPLY), 'no temp tables, no session settings (only set local)');
  for (const k of ['01 ', '02 ', '03 ', '04 ', '05 ', '06 ', '07 ', '08 ', '09 ', '10 ']) assert.ok(APPLY.includes("('" + k), 'check row ' + k);
});
t('the bell window is made from the live _r388_vis / _r388_rows text (tripwire), 90 days, one filter on the rows read', () => {
  assert.match(MIG, /d text := pg_get_functiondef\('public\._r388_vis\(uuid,uuid\)'::regprocedure\);/);
  assert.match(MIG, /d text := pg_get_functiondef\('public\._r388_rows\(uuid,uuid\)'::regprocedure\);/);
  assert.match(MIG, /select pg_catalog\.now\(\) - interval '90 days';/);
  assert.doesNotMatch(MIG, /wn as materialized/);   // measured: a materialized copy of the window spilled to disk (slower)
  assert.ok(MIG.includes("d := replace(d, a4, '    join public.notifications n on n.org_id = p_org and ' || v_win || chr(10));"));
  assert.ok(MIG.includes("v_win text := '(n.created_at >= (select public._r401_since()) /* r235-0401: the bell window */ or exists (select 1'"));
  assert.ok(MIG.includes("' and greatest(st.unread_at, st.snoozed_until, st.snooze_returned_at) >= (select public._r401_since())))';"));
  assert.match(MIG, /\nselect public\._r401_sync\(\);\n/);
});
t('bell / my_pending / inbox patched in place; old bodies kept once as __pre0401 without app privilege; never raises on an unknown body', () => {
  for (const f of ['bell_feed__pre0042(integer)', 'bell_feed__pre0299(integer)', 'my_pending()', 'inbox_feed__pre0299(text,text,uuid,integer,text)',
                   'inbox_act(uuid[],text,timestamp with time zone,text)', 'inbox_read_all(text,uuid)'])
    assert.ok(MIG.includes("public._r401_patch('public." + f + "'::regprocedure, 'r235-0401'"), f);
  assert.match(MIG, /raise warning 'r235-0401: % left unchanged \(its body is not the known one\)', p_fn; return 'skipped';/);
  assert.match(MIG, /'__pre0401'/);
  assert.match(MIG, /revoke all on function public\.%I\(%s\) from authenticated', v_name \|\| '__pre0401'/);
  assert.match(MIG, /v_unread := \(select count\(\*\) from public\._r401_rows\(v_org, v_uid\) r where r\.is_unread\)::integer;/);
});
t('request keys: five _once wrappers, first answer replayed, different values refused (22023), no key = the old call; table closed', () => {
  for (const [w, inner] of [['assign_tasks_once', 'public.assign_tasks(p_quote_id, p_category, p_titles, p_crew_id, p_name, p_phone)'],
                            ['assign_tasks_vendor_once', 'public.assign_tasks_vendor(p_quote_id, p_category, p_titles, p_vendor_id)'],
                            ['event_task_remind_bell_once', 'public.event_task_remind_bell(p_task)'],
                            ['link_view_nudge_once', 'public.link_view_nudge(p_quote, p_channel)'],
                            ['payment_reminder_send_now_once', 'public.payment_reminder_send_now(p_milestone)']]) {
    const i = MIG.indexOf('create or replace function public.' + w + '('); assert.ok(i > 0, w);
    const b = MIG.slice(i, MIG.indexOf('\nend $$;', i));
    assert.ok(b.includes('if p_request_id is null then') && b.split(inner).length === 3, w + ' calls ' + inner + ' with and without a key');
    assert.match(b, /security definer set search_path = ''/);
    assert.ok(MIG.includes("grant execute on function public." + w + "("), w + ' granted to signed-in users');
  }
  assert.match(MIG, /using errcode = '22023', hint = 'request_key_reused'/);
  assert.match(MIG, /jsonb_build_object\('replayed', true\)/);
  assert.match(MIG, /constraint rpc_request_keys_pk primary key \(user_id, fn, request_id\)/);
  assert.match(MIG, /alter table public\.rpc_request_keys enable row level security;/);
  assert.match(MIG, /pg_advisory_xact_lock\(hashtextextended\('helm:r401-once:'/);
});
t('the inbox digest job reads the bell window; ten jobs get lock_timeout', () => {
  assert.ok(MIG.includes("public._r401_patch('public._r23_queue_digests()'::regprocedure, 'r235-0401',"));
  assert.ok(MIG.includes("array['from public._r23_rows(o.id, p.id) r'],"));
  for (const f of ['quote_stage_sweep(integer)', 'link_views_tick()', 'apply_link_expiry_archive_all()', 'discard_empty_drafts_all()',
                   'event_ready_alert_tick()', 'team_safety_tick()', 'pay_details_tick()', 'inbox_tick()', 'runsheet_reminders_tick()', 'comms_tick()'])
    assert.ok(MIG.includes("'public." + f + "'"), f);
});
t('Tasks & staff page: a failed refresh tells the refresher (backs off); chat no longer listens to chat_reactions (not published since 0156)', () => {
  const OB = read('public/ops-board.js'), OPS = read('public/ops.html');
  assert.match(OB, /if \(P\(\) && P\(\)\.reload && \(await P\(\)\.reload\(\)\) === false\) failed = true;/);
  assert.match(OB, /if \(failed\) return false;/);
  assert.match(OPS, /renderDashboard\(\); \}catch\{ return false; \} \}/);
  assert.doesNotMatch(API, /cspec\("chat_reactions"\)/);
  assert.match(API, /\.on\("postgres_changes", cspec\("chat_messages"\)/);
  assert.match(API, /\.on\("postgres_changes", cspec\("chat_conversations"\)/);
});
t('prod checker: no override note has a semicolon or "into <word>" (the Supabase SQL editor split on the 0402 note); the generator refuses one', () => {
  const OVR = JSON.parse(read('supabase/check-prod-overrides.json')), GEN = read('scripts/gen-check-prod.mjs'), CHK = read('supabase/CHECK-PROD-MIGRATIONS.sql');
  for (const [k, v] of Object.entries(OVR)) {
    const note = (v && v.note) || '';
    assert.ok(!/;/.test(note) && !/\binto\s+\w/i.test(note), k + ' note: ' + note.slice(0, 80));
  }
  assert.match(GEN, /the note must not contain a semicolon or "into <word>"/);
  assert.ok(!CHK.includes('into their') && !CHK.includes("concat_ws('; '"), 'generated checker clean');
  assert.match(CHK, /R236: backoff trigger and next_attempt_at on the 7 staff \/ reminder queues, 8-try limit in the claim bodies \(dynamic SQL\)/);
});
t('real order (0402 already on staging / production): a run-all suite pastes APPLY-0401 after APPLY-0402 and re-checks 0402', () => {
  const RA = read('scripts/db-test/run-all.sh'), SH = read('tests/db/r235-order-after-0402.sh');
  assert.match(RA, /run "r235-order-after-0402" "R235-ORDER-AFTER-0402: PASS" bash tests\/db\/r235-order-after-0402\.sh/);
  assert.match(SH, /case "\$path" in \*0401_r235_db_load\.sql(?:\|\*0438_r254_\*)?\) continue;; esac/);
  assert.match(SH, /SET statement_timeout = 200ms runs 600 ms to the end/);
  assert.match(APPLY, /After APPLY-0402 is fine/);
});
t('jobs: lock_timeout per function only; no role / database setting changed', () => {
  assert.match(MIG, /execute format\('alter function %s set lock_timeout = %L', f, '10s'\);/);
  assert.doesNotMatch(MIG, /alter (role|database|system)\b/i);
  assert.doesNotMatch(MIG, /set statement_timeout|statement_timeout =/i);
});
t('the page: one request key per press, kept until an answer arrives; old database = the old call', () => {
  assert.match(API, /const rpcKeyed = async \(fn, onceFn, args\) => \{/);
  assert.match(API, /const r = await rpc\(onceFn, Object\.assign\(\{\}, args, \{ p_request_id: ent\.id \}\)\);\n\s+onceKeys\.delete\(fp\); return r;/);
  assert.match(API, /if \(rpcMissing\(e\)\) \{ const r = await rpc\(fn, args\); onceKeys\.delete\(fp\); return r; \}/);
  for (const [fn, once] of [['assign_tasks', 'assign_tasks_once'], ['assign_tasks_vendor', 'assign_tasks_vendor_once'],
                            ['event_task_remind_bell', 'event_task_remind_bell_once'], ['link_view_nudge', 'link_view_nudge_once'],
                            ['payment_reminder_send_now', 'payment_reminder_send_now_once']])
    assert.ok(API.includes('rpcKeyed("' + fn + '", "' + once + '"'), fn);
  assert.doesNotMatch(API, /rpc\("assign_tasks"|rpc\("assign_tasks_vendor"|rpc\("event_task_remind_bell"/);
});
t('the bell: hidden tabs never poll (kept), error backoff kept, a slow answer skips the next poll', () => {
  assert.match(API, /if \(kicked && !document\.hidden && !isOpen && Date\.now\(\) >= feedBackoffUntil/);
  assert.match(API, /feedBackoffUntil = Date\.now\(\) \+ Math\.min\(480000, 30000 \* Math\.pow\(2, feedFails\)\);/);
  assert.match(API, /feedBackoffUntil = Date\.now\(\) - t0 > 4000 \? Date\.now\(\) \+ 60000 : 0; return f;/);
});
t('the wall screen: loadTasks tells the refresher a failure', () => {
  assert.match(MON, /return false;   \/\/ R235: tells the 30 s refresher to wait longer before the next try/);
  assert.match(MON, /TS\.refresher\(function \(\) \{ if \(signedIn\(\)\) return loadTasks\(true\); \}, REFRESH_MS\);/);
});

// behaviour of the refresher with a fake clock
async function refresherRun() {
  let now = 1000000; const timers = [];
  const doc = { hidden: false, addEventListener() {}, removeEventListener() {} };
  const ctx = { document: doc, Date: { now: () => now }, setInterval: (f) => { timers.push(f); return timers.length; }, clearInterval() {},
                Promise, Math, Object, Array, JSON, String, Number, isNaN };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx); vm.runInContext(TS, ctx);
  const H = ctx.HelmTaskStatus; let calls = 0, mode = 'fail';
  const r = H.refresher(() => { calls++; if (mode === 'fail') return Promise.reject(new Error('x')); if (mode === 'false') return false;
                                if (mode === 'slow') { now += 6000; return true; } return true; }, 30000);
  const flush = () => new Promise((res) => setImmediate(res));
  const tick = async (ms) => { now += ms; timers.forEach((f) => f()); await flush(); await flush(); };
  r.now(); await flush(); await flush();
  assert.equal(r.wait(), 60000, 'one failure: 2x');
  await tick(30000); assert.equal(calls, 1, 'no refresh at 30 s while backing off');
  await tick(30000); assert.equal(calls, 2, 'refresh after 60 s');
  assert.equal(r.wait(), 120000, 'two failures: 4x');
  mode = 'false'; await tick(120000); assert.equal(calls, 3); assert.equal(r.wait(), 240000, 'an answer of false counts as a failure');
  for (let i = 0; i < 4; i++) { await tick(480000); }
  assert.ok(r.wait() <= 480000, 'max 8 min');
  mode = 'ok'; r.now(); await flush(); await flush(); assert.equal(r.wait(), 30000, 'a good refresh goes back to 30 s');
  mode = 'slow'; await tick(30000); assert.equal(r.wait(), 60000, 'a slow refresh (> 5 s) waits 2x');
  mode = 'ok'; await tick(60000); assert.equal(r.wait(), 30000);
  doc.hidden = true; const c0 = calls; await tick(60000); assert.equal(calls, c0, 'hidden tab: no refresh');
  r.stop();
}

(async () => {
  for (const [name, fn] of tests) { try { fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } }
  try { await refresherRun(); n++; console.log('  ok the refresher backs off: failure 2x / 4x / ... max 8 min, slow 2x, good = 30 s, hidden = none'); }
  catch (e) { console.error('  FAIL refresher backoff\n' + (e && e.stack || e)); process.exitCode = 1; }
  console.log(process.exitCode ? 'R235-DB-LOAD: FAILED' : 'R235-DB-LOAD: ALL PASS (' + n + '/' + (tests.length + 1) + ')');
})();
