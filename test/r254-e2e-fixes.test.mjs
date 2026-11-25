// R254: what the staging end-to-end run found (25 Nov 2026), page side.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const R = (f) => readFileSync(new URL('../public/' + f, import.meta.url), 'utf8');
let n = 0; const t = async (name, f) => { await f(); n++; console.log('  ok ', name); };
const store = R('store-api.js');
await t('1 sending work back needs a reason for every role; approving does not', async () => {
  const src = /verify: \(taskId, pass, note\) => \{[\s\S]*?\n[\s\S]*?\},\n/.exec(store)[0].replace(/,\n$/, '');
  const calls = []; const verify = vm.runInNewContext('({' + src + '})', { rpc: async (...a) => { calls.push(a); return 1; }, Promise, Error, String }).verify;
  for (const bad of ['', '   ', null, undefined]) { let e = null; try { await verify('x', false, bad); } catch (x) { e = x; } assert.match(String(e && e.message), /done again/); }
  assert.equal(calls.length, 0); await verify('x', true); await verify('x', false, ' fix it '); assert.equal(calls[0][1].p_note, null); assert.equal(calls[1][1].p_note, 'fix it');
});
await t('2 "Client approved" never shows the raw word', () => {
  const src = /function approvalWords[\s\S]*?\n  \}\n/.exec(store)[0]; const f = vm.runInNewContext(src + ';approvalWords');
  for (const s of ['none', 'sent', 'cancelled']) assert.notEqual(f(s).detail, s === 'cancelled' ? '' : s); assert.match(f('sent').detail, /not approved yet/); assert.match(f('paid', { basis: 'advance' }).detail, /advance/);
});
await t('3 Guests arrive is shown like every other time, on both pages', () => {
  for (const [f, v] of [['ops-board.js', 'guestsAt'], ['monitor.js', 'e.event_time']]) { const s = R(f); assert.ok(s.includes('tile("Guests arrive", guestWord(' + v + ')'), f);
    const g = vm.runInNewContext(/function guestWord[\s\S]*?\} catch \(e\) \{ return String\(t\); \} \}/.exec(s)[0] + ';guestWord', { loc: () => 'en-IN', Intl, Date, String });
    assert.match(g('18:00'), /^6:00\s?pm$/i); assert.match(g('18:00:00'), /^6:00\s?pm$/i); assert.equal(g('evening'), 'evening'); assert.equal(g(''), ''); assert.equal(g('25:00'), '25:00'); }
});
await t('4 Open shifts sits under the crew, above Plan & reminders, on every step', () => {
  assert.match(R('ops-board.js'), /var TAIL = \["tcActCard", "tcCrewCard", "shiftCard", "tcPlanRem"\];/);
});
await t('5 Mark event complete says so when the guests have not arrived', () => {
  const w = { console, Intl, Date, Math, String, isFinite, isNaN, Object, Array, JSON, Promise, setTimeout, clearTimeout }; w.window = w; w.globalThis = w; w.document = { addEventListener() {}, createElement: () => ({}) };
  vm.createContext(w); for (const f of ['studio-time.js', 'task-status.js', 'event-steps.js']) vm.runInContext(R(f), w);
  const early = w.HelmEventWrap._pure.early, at = (iso) => ({ quote: { eventDate: '2026-11-25', eventTime: '18:00' }, tz: 'Asia/Kolkata', now: Date.parse(iso) });
  assert.match(early(at('2026-11-24T22:25:00Z')), /due in 14 hours/); assert.match(early(at('2026-11-25T12:10:00Z')), /due in 20 min/); assert.equal(early(at('2026-11-25T12:31:00Z')), '');
  assert.equal(early({ quote: { eventDate: '2026-11-25', eventTime: '' }, tz: 'Asia/Kolkata', now: 1 }), ''); assert.equal(early({ quote: {}, tz: 'Asia/Kolkata', now: 1 }), '');
});
await t('6 the plan lock is read again right after the stage moved', () => { assert.match(R('event-steps.js'), /HelmEventFloor\.stale\(id\)/); assert.match(R('event-floor.js'), /function stale\(qid\) \{ if \(cache\[qid\]\) cache\[qid\]\.fat = 0; \}/); });
await t('7 day-of rows: one per vendor - a duplicate keeps the other row and is not counted; another error still throws', async () => {
  const body = /const dayops = \{([\s\S]*?)\n  \};\n/.exec(store)[1]; let code = '23505';
  const row = { id: 'r1', ref_id: 'v1', kind: 'arrival', status: 'left' };
  const q = { insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { code } }) }) }), select: () => q, eq: () => q, order: () => q, not: () => q, then: (f) => f({ data: [row], error: null }) };
  const D = vm.runInNewContext('({' + body + '})', { mode: 'supabase', supa: { from: () => q }, readLs: () => [], DAY_LS: '', Promise, Set, Object, staff: { list: async () => [] }, vendors: { listAll: async () => [] }, bookings: { list: async () => [{ id: 'v1', status: 'booked', label: 'V' }] }, crewTaskLive: () => false });
  const r = await D.add('q', { kind: 'arrival', ref_id: 'v1', status: 'arrived' }); assert.equal(r.existed, true); assert.equal(r.status, 'left');
  assert.equal(await D.pullRoster('q'), 0);
  code = '42501'; let e = null; try { await D.add('q', { kind: 'arrival', ref_id: 'v1' }); } catch (x) { e = x; } assert.equal(e && e.code, '42501');
});
await t('8 vendor rows keep the arrival time after Left (0437), and still work on an older database', () => {
  const src = R('event-wrap.js'), W = { arrived: 1, left: 1, expected: 1, no_show: 1 };
  const f = vm.runInNewContext(/function vendorRows[\s\S]*?\n  \}\n/.exec(src)[0] + ';vendorRows', { WORD: W, arrivalOf: (a, id) => (a || []).find((x) => x.ref_id === id), String });
  const b = [{ id: 'v', label: 'L', status: 'booked' }];
  let x = f(b, [{ id: 'a', ref_id: 'v', status: 'left', updated_at: 'U', arrived_at: 'A', left_at: 'Z' }])[0]; assert.deepEqual([x.arrivedAt, x.at], ['A', 'Z']);
  x = f(b, [{ id: 'a', ref_id: 'v', status: 'arrived', updated_at: 'U2', arrived_at: 'A' }])[0]; assert.deepEqual([x.arrivedAt, x.at], [null, 'A']);
  x = f(b, [{ id: 'a', ref_id: 'v', status: 'left', updated_at: 'U' }])[0]; assert.deepEqual([x.arrivedAt, x.at], [null, 'U']);
});
console.log('r254-e2e-fixes: ' + n + ' passed');
