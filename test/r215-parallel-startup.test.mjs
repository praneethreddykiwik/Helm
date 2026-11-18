// r215-parallel-startup.test.mjs - R215: signed-in pages ask their independent startup questions together instead of
// one after another (the database is in Canada, users are in India: every wait in a row is ~250 ms).
// Runs each page's REAL startup code against a mocked BPStore that takes one "trip" per database call
// (test/r215-startup-harness.mjs) and checks:
//  1 the number of trips in a row before the page shows its content (fresh tab) went down to the new numbers
//  2 the page still makes exactly the same database calls on a normal open (nothing removed, nothing added)
//  3 each failure still shows the same message in the same place (quote / version / calendar / list / feeds)
// Before (origin/main 76b195a1): builder 8, calendar 5, Tasks & crew 4, quotes 3, dashboard 3 (manager board 4).
// R215_BEFORE_REF=<git ref> also compares every scenario's whole result (messages + page content) with that commit.
import assert from 'node:assert/strict';
import { runPage, FIRST_CONTENT } from './r215-startup-harness.mjs';

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + (e && e.stack || e)); } };
const NF = { code: 'PGRST116', message: 'not found' }, NET = { message: 'Failed to fetch' };
const msgs = (r) => r.log.filter((l) => l[0] === 'toast' || l[0] === 'loadError' || l[0] === 'readonly').map((l) => l.join(' | '));
const names = (r) => r.calls.map((c) => c.replace(/\(.*$/, '')).sort();

// 1 -----------------------------------------------------------------------------------------------------------
const AFTER = { builder: 4, calendar: 3, ops: 3, quotes: 2, dashboard: 2 };
for (const [p, n] of Object.entries(AFTER)) {
  await t(p + ': content after ' + n + ' trips in a row (fresh tab)', async () => {
    const r = await runPage(p); assert.equal(r.error, null, String(r.error && r.error.stack));
    assert.ok(r.waits[FIRST_CONTENT[p]] != null, 'content drawn'); assert.ok(r.waits[FIRST_CONTENT[p]] <= n, 'waits ' + r.waits[FIRST_CONTENT[p]]);
  });
}
await t('dashboard: a manager board (design queue) fills after 2 trips (was 4: my_pending, then my_tasks, then the queue)', async () => {
  const r = await runPage('dashboard', { role: 'manager' }); assert.ok(r.waits['html:#rbcards'] <= 2, 'waits ' + r.waits['html:#rbcards']);
  assert.ok(r.calls.some((c) => c.startsWith('design.queue(')), 'queue still asked');
});

// 2 -----------------------------------------------------------------------------------------------------------
const CALLS = {
  builder: ['config.getPricing', 'init', 'menuTemplates.list', 'plan.get', 'quotes.get', 'quotes.getVersion', 'rpc.my_trial_org'],
  calendar: ['calendar.acks', 'calendar.load', 'calendar.sampleIds', 'init', 'leads.list', 'ops.shifts.unavailableConflicts', 'rpc.my_trial_org'],
  ops: ['chat.directory', 'init', 'links.studio', 'ops.categories', 'ops.listCrew', 'ops.listEvidence', 'ops.listTasks', 'ops.listTokens', 'ops.shifts.dayStatus',
    'ops.templates', 'ops.waStatus', 'quotes.get', 'rpc.my_trial_org', 'rpc.my_trial_status', 'staff.suggest', 'vendors.listAll'],
  dashboard: ['budget.invoiceTotals', 'init', 'init', 'init', 'myTasks', 'pending', 'quoteShelf.tick', 'quotes.counts', 'quotes.nextCodeFor', 'quotes.page', 'rpc.my_trial_org'],
};
for (const [p, list] of Object.entries(CALLS)) {
  await t(p + ': the same database calls as before, once each', async () => { assert.deepEqual(names(await runPage(p)), list); });
}
await t('quotes: the first page and the shelf are asked once each (the early read is the one the list uses)', async () => {
  const n = names(await runPage('quotes'));
  for (const c of ['quotes.page', 'quoteShelf.list', 'config.getPricing', 'org.current', 'quotes.staleApprovals', 'quoteValidity.list', 'budget.approvedChangeTotals'])
    assert.equal(n.filter((x) => x === c).length, 1, c);
});
await t('calendar: the "can\'t work" read keeps its 90-day window from the studio\'s today', async () => {
  const r = await runPage('calendar'); assert.ok(r.calls.includes('ops.shifts.unavailableConflicts(["2026-11-18","2027-02-16"])'), r.calls.join(' '));
});
await t('calendar: the conflict acknowledgements still include the "can\'t work" conflicts (asked after both arrived)', async () => {
  const r = await runPage('calendar'); const ack = r.calls.find((c) => c.startsWith('calendar.acks('));
  assert.ok(ack && ack.includes('unavail|c1|2026-12-01'), ack);
});

// 3 -----------------------------------------------------------------------------------------------------------
const LOCK = 'readonly | viewer | 🔒 Editing is locked — that quote or version could not be opened. Reload the page to try again; nothing was changed.';
const LOCK_TOAST = 'toast | Could not open that quote — editing is locked so nothing gets overwritten';
const CASES = [
  ['builder', { 'quotes.get': NF }, [LOCK, LOCK_TOAST]],
  ['builder', { 'quotes.getVersion': NET }, [LOCK, LOCK_TOAST]],
  ['builder', { 'config.getPricing': NET }, ['toast | Opened Q-0001 · V2']],
  ['builder', { 'menuTemplates.list': NET }, ['toast | Opened Q-0001 · V2']],
  ['builder', { 'plan.get': NET }, ['toast | Opened Q-0001 · V2']],
  ['builder', { viewOnly: true }, ['readonly | admin | ', 'toast | Opened Q-0001 · V2']],
  ['calendar', { 'calendar.load': NET }, ['loadError | the calendar | Failed to fetch']],
  ['calendar', { 'ops.shifts.unavailableConflicts': NET }, []],
  ['calendar', { 'calendar.acks': NET }, []],
  ['ops', { 'quotes.get': NET }, ['loadError | this event | Failed to fetch']],
  ['ops', { 'ops.templates': NET }, ['loadError | task templates | Failed to fetch']],
  ['ops', { 'ops.listTasks': NET }, ['loadError | staff and tasks | Failed to fetch']],
  ['quotes', { 'quotes.page': NET }, ['loadError | quotes | Failed to fetch']],
  ['dashboard', { 'quotes.page': NET }, ['loadError | your quotes | Failed to fetch']],
  ['dashboard', { myTasks: NET }, ['loadError | your tasks | Failed to fetch', 'loadError | your workspace | Failed to fetch']],
];
for (const [p, f, want] of CASES) {
  await t(p + ' ' + JSON.stringify(f) + ': same message', async () => { assert.deepEqual(msgs(await runPage(p, { fail: f })), want); });
}
await t('ops: an event that is not found still says "Event not found" (not a load error)', async () => {
  const r = await runPage('ops', { fail: { 'quotes.get': NF } });
  assert.match(String(r.dom['#noquoteMsg'] && r.dom['#noquoteMsg'].html), /Event not found/); assert.deepEqual(msgs(r), []);
});
await t('calendar: a failed calendar read still clears the conflicts box and hides "No date set"', async () => {
  const r = await runPage('calendar', { fail: { 'calendar.load': NET } });
  assert.equal(r.dom['#conflicts'].html, ''); assert.equal(r.dom['#nodateWrap'].hidden, true);
});
await t('dashboard: a manager\'s failed design queue still shows the workspace load error', async () => {
  assert.deepEqual(msgs(await runPage('dashboard', { role: 'manager', fail: { 'design.queue': NET } })), ['loadError | your workspace | Failed to fetch']);
});

// optional: whole-result comparison with an older commit ------------------------------------------------------
if (process.env.R215_BEFORE_REF) {
  const ref = process.env.R215_BEFORE_REF;
  const clean = (r) => JSON.stringify({ log: msgs(r), dom: r.dom, redirected: r.redirected, err: r.error && String(r.error.message) });
  const S = { builder: [{}, { 'quotes.get': NF }, { 'quotes.getVersion': NET }, { 'plan.get': NET }, { viewOnly: true }],
    calendar: [{}, { 'calendar.load': NET }, { 'ops.shifts.unavailableConflicts': NET }, { 'calendar.acks': NET }],
    ops: [{}, { 'quotes.get': NF }, { 'ops.templates': NET }], quotes: [{}, { 'quotes.page': NET }, { 'quoteShelf.list': NET }],
    dashboard: [{}, { 'quotes.page': NET }, { pending: NET }, { myTasks: NET }] };
  for (const [p, list] of Object.entries(S)) for (const f of list) {
    await t('same result as ' + ref + ': ' + p + ' ' + JSON.stringify(f), async () => { assert.equal(clean(await runPage(p, { fail: f })), clean(await runPage(p, { ref, fail: f }))); });
  }
}

console.log(`\nr215-parallel-startup: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
