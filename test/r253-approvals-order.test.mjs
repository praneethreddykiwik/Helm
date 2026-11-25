// R253 (owner, 25 Nov): no "Behind" line on Ready by; "Waits for another task" end to end (one after another, the three words, Order of work);
// the Approvals page for supervisors / quality engineers (and event managers, planners, admins). Client side; the rules are 0282 / 0311 / 0436.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
require('../public/task-status.js'); require('../public/event-plan.js'); const HD = require('../public/event-delay.js'); require('../public/ops-board.js');
const B = globalThis.OpsBoard._pure, AP = require('../public/approvals.js');
const EP = read('public/event-plan.js'), BRD = read('public/ops-board.js'), OPS = read('public/ops.html'), MON = read('public/monitor.js'), API = read('public/store-api.js'), PAGE = read('public/approvals.html'), JS = read('public/approvals.js'), SB = read('public/shell-b.js');
const T = (id, o = {}) => ({ id, title: id, status: 'accepted', crew_id: 'c', planned_start: null, ...o });

test('Ready by: plain progress only, no word about being behind', () => {
  for (const f of ['public/event-plan.js', 'public/ops-board.js', 'public/monitor.js', 'public/ops.html', 'public/monitor.html', 'public/event-delay.js', 'public/day-before.js', 'public/ready.html', 'public/eventday-pack.js'])
    assert.doesNotMatch(read(f), /"Behind|Behind by|Start now - late|should have started already|past the latest start - start now|"On time"|Start soon/, f);
  assert.match(EP, /line = sc\.done \+ " of " \+ sc\.rows\.length \+ " set-up jobs done\."/); assert.match(EP, /"Start by"/);
  assert.doesNotMatch(read('public/event-plan.css'), /\.ep-status\.bad|\.ep-job\.late/);
  assert.match(OPS, /id="tcPreCheck"/); assert.match(read('public/monitor.html'), /id="monPreCheck"/);   // the pre-event check stays
});
test('the three words: released / rework / waiting - the same as the worker page (task-waits.js)', () => {
  const s = T('Stage set-up'), f = T('Flowers', { depends_on: 'Stage set-up' }), W = (t, d) => HD.linkState(t, d);
  assert.deepEqual(W(f, s), ['wait', 'Waits for Stage set-up (not done yet)']);
  assert.deepEqual(W(f, { ...s, status: 'completed', verify_status: 'pending' }), ['go', 'You can start now - Stage set-up is done'], 'approval does not gate the release');
  assert.deepEqual(W(f, { ...s, status: 'cancelled', verify_status: 'rejected' }), ['go', 'You can start now - Stage set-up was cancelled']);
  assert.deepEqual(W(f, { ...s, status: 'in_progress', verify_status: 'rejected' }), ['rework', 'Stage set-up needs rework - please hold']);
  assert.equal(W({ ...f, status: 'in_progress' }, { ...s, status: 'completed' }), null); assert.equal(W({ ...f, status: 'completed' }, s), null); assert.equal(W(f, null), null);
  const E = (o, p) => W({ ...f, ...o }, { ...s, ...p }), S1 = '2026-11-24T08:00:00Z', S2 = '2026-11-24T09:00:00Z';
  assert.deepEqual(E({ status: 'in_progress', started_at: S1 }, {}), ['early', 'Started early - Stage set-up is not done yet']); assert.deepEqual(E({ status: 'completed', completed_at: S1 }, { status: 'completed', completed_at: S2 }), ['early', 'Started early - Stage set-up was not done yet']);
  assert.equal(E({ status: 'in_progress', started_at: S2 }, { status: 'completed', completed_at: S1 }), null); assert.equal(E({ status: 'in_progress', started_at: S2 }, { status: 'cancelled', cancelled_at: S1 }), null); assert.equal(E({ status: 'in_progress', started_at: S1 }, { status: 'cancelled', cancelled_at: S2 })[0], 'early');
  assert.equal(E({ status: 'in_progress', started_at: S2 }, { status: 'in_progress', verify_status: 'rejected' })[0], 'rework', 'sent back later: hold, not early'); assert.equal(E({ status: 'completed', completed_at: S2 }, { status: 'in_progress', verify_status: 'rejected' }), null);
  const TW = read('public/task-waits.js');
  for (const w of [/You can start now - /, / needs rework - please hold/, /\(not done yet\)/]) assert.match(TW, w);
  assert.equal((MON.match(/linkOf\(t\)/g) || []).length >= 3, true); assert.match(BRD, /linkOf\(t\)/);
});
test('one after another: links, the first one, a circle is refused', () => {
  const ts = [T('a'), T('b', { depends_on: 'z' }), T('c'), T('z')];
  assert.deepEqual(B.chainLinks(['a', 'b', 'c'], 'z', ts), { links: [{ id: 'a', dep: 'z' }, { id: 'b', dep: 'a' }, { id: 'c', dep: 'b' }], cycle: '' });
  assert.equal(B.chainLinks(['b', 'a'], undefined, ts).links[0].dep, 'z', 'keep: the first keeps its own link'); assert.equal(B.chainLinks(['b', 'a'], null, ts).links[0].dep, null);
  assert.equal(B.chainLinks(['a', 'b'], undefined, [T('a', { depends_on: 'b' }), T('b')]).cycle, 'a');
  assert.equal(B.chainLinks(['a', 'b'], 'x', [T('a'), T('b'), T('x', { depends_on: 'b' })]).cycle, 'a', 'a circle through a task outside the list');
  assert.equal(B.chainLinks(['a', 'b'], null, [T('a', { depends_on: 'b' }), T('b')]).cycle, '', 'the old link is replaced');
});
test('Order of work: a tree, loops never hang, cancelled tasks are left out', () => {
  const r = B.orderTree([T('lights', { depends_on: 'flowers' }), T('stage', { status: 'completed' }), T('flowers', { depends_on: 'stage' }), T('carpet', { depends_on: 'stage' }), T('alone'), T('x', { status: 'cancelled', depends_on: 'stage' })]);
  assert.equal(r.roots.length, 1); assert.equal(r.roots[0].t.id, 'stage'); assert.deepEqual(r.roots[0].kids.map((k) => k.t.id), ['carpet', 'flowers']); assert.equal(r.roots[0].kids[1].kids[0].t.id, 'lights');
  assert.deepEqual([r.linked, r.go, r.hold], [3, 2, 1]);
  const l = B.orderTree([T('a', { depends_on: 'b' }), T('b', { depends_on: 'a' }), T('s', { depends_on: 's' })]); assert.equal(l.roots.length, 1);
  assert.equal(B.orderTree([]).roots.length, 0); assert.equal(B.orderTree([T('a')]).linked, 0);
  assert.match(OPS, /data-view="order"[^>]*>Order of work <span class="tc-seg-n" id="tcOrderN" hidden>/); assert.match(BRD, /S\.view === "order" && liveTasks\(\)\.length\) \{ renderOrder\(v, ot\); return; \}/);
});
test('the sheet: every live task with person and state, a circle and a gone task are refused, the list follows the 30 s refresh', () => {
  assert.match(OPS, /function depLabel\(x\)/); assert.match(OPS, /One after another, in this order/); assert.match(OPS, /id="as_chainList"/);
  assert.match(OPS, /const can=depOptions\(sd, new Set\(\[String\(id\)\]\), t\.depends_on\)/, 'Change on a task uses the same list');
  assert.match(OPS, /String\(x\.id\)===String\(keep\|\|""\)\|\|\(!has\(x\.id\)&&x\.status!=="cancelled"/, 'a link to a cancelled task is not lost by saving');
  assert.match(OPS, /round in a circle/); assert.match(OPS, /depRefresh:refreshAsDep/); assert.match(BRD, /P\(\)\.depRefresh && P\(\)\.depRefresh\(\)/);
  assert.match(OPS, /fillAsDep\(preset, depId\|\|undefined\)/, 'tasks already on the list start on "Keep as it is"');
  assert.match(BRD, /B0\.ops\.setSchedule\(t\.id, ns, t\.planned_end \? moveBy\(t\.planned_end, m\) : null, t\.depends_on \|\| null\)/, 'bulk Set time keeps the link');
});
test('no circles: a 3-task chain, every list leaves out what already waits, a circle already saved is one plain line and never hangs', () => {
  // C waits for B waits for A (A is cancelled in one case: status does not matter, like the server)
  const ch = [T('A'), T('B', { depends_on: 'A' }), T('C', { depends_on: 'B' }), T('D')], EV = globalThis.HelmEventPlan;
  for (const x of ['A', 'B', 'C']) assert.equal(EV.waitsFor(ch, x, 'A'), true, x + ' is not offered to A'); assert.equal(EV.waitsFor(ch, 'D', 'A'), false);
  assert.deepEqual(['A', 'B', 'C', 'D'].filter((x) => !EV.waitsFor(ch, x, 'B')), ['A', 'D']); assert.equal(EV.waitsFor([T('A', { status: 'cancelled' }), ...ch.slice(1)], 'C', 'A'), true);
  // the page's own check (Change on a task + the sheet), run as it is written
  const src = /function wouldCycle\(id, depId\)\{[\s\S]*?\n  \}/.exec(OPS)[0], wc = (ts) => new Function('tasks', src + ';return wouldCycle;')(ts);
  assert.deepEqual(['A', 'B', 'C', 'D'].filter((x) => !wc(ch)('A', x)), ['D']); assert.deepEqual(['A', 'B', 'C', 'D'].filter((x) => !wc(ch)('C', x)), ['A', 'B', 'D']);
  const ring = [T('A', { depends_on: 'C' }), T('B', { depends_on: 'A' }), T('C', { depends_on: 'B' }), T('D', { depends_on: 'C' })];
  assert.equal(wc(ring)('X', 'A'), false, 'a stored circle ends'); assert.equal(EV.waitsFor(ring, 'A', 'X'), false); assert.equal(EV.waitsFor(ring, 'A', 'A'), true);
  const r = B.orderTree(ring); assert.deepEqual(r.loops.map((l) => l.slice().sort()), [['A', 'B', 'C']], 'D only waits for the circle'); assert.equal(r.roots.length, 1);
  assert.deepEqual(B.orderTree([T('s', { depends_on: 's' })]).loops, [['s']]); assert.deepEqual(B.orderTree(ch).loops, []);
  assert.match(BRD, /These tasks wait for each other: /);
  // one after another against links that already exist: A, then C would make C wait for A - fine; C, then A closes the circle
  assert.equal(B.chainLinks(['A', 'C'], null, ch).cycle, ''); assert.equal(B.chainLinks(['C', 'A'], undefined, ch).cycle, 'C'); assert.equal(B.chainLinks(['D', 'A'], 'C', ch).cycle, 'D');
  assert.match(OPS, /const waitErr=/); assert.match(OPS, /waitErr\(err\)\|\|/); assert.match(EP, /\^r436_wait_/);
});
test('approvals: who may, refusals, words', () => {
  const all = { role: 'quality', all: true, mine: {}, own: [] }, sup = { role: 'supervisor', all: false, mine: {}, own: ['c1'] };
  assert.equal(AP.may(all, { crew_id: 'c1' }), true); assert.equal(AP.may(sup, { crew_id: 'c2' }), true); assert.equal(AP.may(sup, { crew_id: 'c1' }), false, 'never their own task');
  assert.equal(AP.may({ ...sup, old: true }, { crew_id: 'c2' }), false, 'before 0436 no Approve is offered'); assert.equal(AP.may(null, {}), false);
  assert.equal(AP.refused(sup, { code: '42501' }), true); assert.equal(AP.refused(all, { code: '42501' }), false); assert.equal(AP.refused(sup, { code: '42501', hint: 'r436_not_your_section' }), false);
  assert.equal(AP.nextWords([{ title: 'Flowers', assignee_name: 'Ravi', status: 'assigned' }, { title: 'Lights', status: 'in_progress' }, { title: 'X', status: 'cancelled' }]), 'Flowers (Ravi), Lights (nobody yet, started)');
  assert.equal(AP.ago('2026-11-24T08:00:00Z', Date.parse('2026-11-24T10:30:00Z')), '2 h ago');
  assert.deepEqual(AP.newest([{ id: 1, at: null }, { id: 2, at: '2026-01-01' }, { id: 3, at: '2026-02-01' }], 'at').map((x) => x.id), [3, 2, 1]);
});
// the store's own code, run against a fake database
const code = /    approvals: (\{[\s\S]*?\n    \}),\n    verifySummary/.exec(API)[1];
function store(role, db, answer) {
  const asked = [];
  const supa = { from(t) { const f = []; let cols; const q = { select(c) { cols = c; return q; }, eq(k, v) { f.push((r) => r[k] === v); return q; }, neq(k, v) { f.push((r) => r[k] !== v); return q; }, in(k, v) { f.push((r) => v.includes(r[k])); return q; },
    not(k) { f.push((r) => r[k] != null); return q; }, order() { return q; }, limit() { return q; }, then(ok, no) { asked.push([t, cols]); return Promise.resolve({ data: (db[t] || []).filter((r) => f.every((x) => x(r))), error: null }).then(ok, no); } }; return q; } };
  const A = new Function('supa', 'auth', 'ops', 'isMissingColumn', 'return (' + code + ')')(supa, { user: () => ({ id: 'me' }), role: async () => role, canView: async () => true }, { deptSupervisors: { get: async () => answer } }, () => false);
  return { A, asked };
}
const done = (id, q, cat, o = {}) => ({ id, quote_id: q, category: cat, title: id, status: 'completed', verify_status: 'pending', completed_at: '2026-11-24T08:00:00Z', ...o });
const DB = () => ({ event_tasks: [done('t1', 'q1', 'Stage setup'), done('t2', 'q1', 'Catering'), done('t3', 'q2', 'Stage setup'), done('t4', 'q3', 'Stage setup'), done('t5', 'q1', 'Stage setup', { verify_status: 'passed', verified_at: '2026-11-24T07:00:00Z' }), done('t6', 'q1', 'Stage setup', { verify_status: 'unverified' }),
    { ...done('n1', 'q1', 'Flowers'), status: 'assigned', verify_status: 'unverified', depends_on: 't1' }],
  quotes: [{ id: 'q1', title: 'Sharma', status: 'confirmed' }, { id: 'q2', title: 'Reddy', status: 'confirmed' }, { id: 'q3', title: 'Old', status: 'confirmed', lifecycle_stage: 'closed' }],
  task_evidence: [{ id: 'e1', task_id: 't1', kind: 'proof_photo', storage_path: 'p' }, { id: 'e2', task_id: 't5', kind: 'proof_photo' }],
  event_department_supervisors: [{ quote_id: 'q1', department: 'Stage setup', profile_id: 'me' }, { quote_id: 'q2', department: 'Stage setup', profile_id: 'other' }], crew_members: [{ id: 'cm', profile_id: 'me' }] });
test('approvals store: a supervisor gets only their departments, the others every live event; closed events are left out', async () => {
  let s = store('quality', DB()), d = await s.A.list(); assert.deepEqual(d.pending.map((t) => t.id), ['t1', 't2', 't3']); assert.equal(await s.A.count(), 3); assert.deepEqual(d.history.map((t) => t.id), ['t5']);
  assert.deepEqual(d.next.t1.map((t) => t.id), ['n1']); assert.deepEqual(d.evidence.map((e) => e.id), ['e1']);
  s = store('supervisor', DB(), { verify: { all: false, departments: ['Stage setup'], my_crew_ids: ['cx'] } }); d = await s.A.list();
  assert.deepEqual(d.pending.map((t) => t.id), ['t1']); assert.deepEqual(d.scope.own, ['cm', 'cx']); assert.equal(d.scope.old, false); assert.equal(await s.A.count(), 1);
  assert.equal((await store('supervisor', DB(), { rows: [] }).A.list()).scope.old, true, 'before 0436');
  const none = DB(); none.event_department_supervisors = []; s = store('supervisor', none); d = await s.A.list(); assert.deepEqual(d.pending, []); assert.equal(s.asked.some((x) => x[0] === 'event_tasks'), false, 'no department = no task read');
  for (const r of ['operations', 'sales', 'crew', 'client']) assert.equal(await store(r, DB()).A.list(), null, r);
  s = store('admin', DB()); await s.A.list(); for (const [, c] of s.asked) assert.doesNotMatch(String(c), /phone|email|pricing|total|wage|day_rate|\*/);
});
test('the page: no inline script or style, photos, required reason, live region, the server decides', () => {
  assert.doesNotMatch(PAGE, /<script>|style="|onclick/); assert.doesNotMatch(JS, /innerHTML|insertAdjacentHTML|\.style\b/);
  assert.match(JS, /requireView\("staff"\)/); assert.match(JS, /required: true, requiredMessage: "Give a reason/); assert.match(JS, /if \(note === null\) return/); assert.match(PAGE, /aria-live="polite"/); assert.match(PAGE, /<dialog/);
  assert.match(JS, /ops\.verify\(ts\[i\]\.id, true\)/); assert.match(JS, /r311_qc_not_pending/);
  // a quality engineer is not behind "Assign & send tasks" any more
  assert.match(BRD, /if \(mayVerify\(t\) && t\.status === "completed" && t\.verify_status === "pending"\) \{[\s\S]{0,700}\}\n    if \(edit\) \{/);
});
test('found everywhere: the nav with a count, the phone tab, the pretty link, no search engines', () => {
  assert.match(SB, /\["approve", "Approvals", "approvals\.html", "approvals"\]/); assert.match(SB, /COUNT_KEYS = \{ leads: 1, quotes: 1, chat: 1, approvals: 1 \}/); assert.match(SB, /v\[1\] === "supervisor" \|\| v\[1\] === "quality"/);
  assert.match(read('public/shell-proto.js'), /approvals: 1/); assert.match(read('public/nav-trail.js'), /approvals: \["Approvals"/); assert.match(read('public/_headers'), /\n\/approvals\n {2}X-Robots-Tag: noindex/);
  const V = JSON.parse(read('vercel.json')); assert.ok(V.rewrites.some((r) => r.source === '/([a-z0-9-]+)/approvals' && r.destination === '/approvals')); assert.equal(V.headers.filter((h) => /\|approvals\|/.test(h.source)).length >= 3, true);
  assert.match(OPS, /id="toApprovals"/);
});
test('finished work waiting for approval is counted in the sort-out list, the pre-event check and the card', () => {
  const t = [{ status: 'completed', verify_status: 'pending', crew_id: 'a' }, { status: 'completed', verify_status: 'pending', crew_id: 'a' }];
  assert.deepEqual([...B.readyChecks(t, {})].pop().slice(0, 4).filter((x, i) => i !== 1), [false, '2 finished tasks wait for approval', 'qc']);
  assert.equal(B.readyChecks([{ status: 'completed', verify_status: 'unverified', crew_id: 'a' }], {}).length, 6);
  assert.equal(B.chipTest('qc', { status: 'in_progress', verify_status: 'pending' }, Date.now()), false);
  assert.match(read('public/event-steps.js'), /"finished task waits", "finished tasks wait"/); assert.match(read('public/pre-check.js'), /s\.approve\) parts\.push/); assert.match(MON, /To approve/);
});
