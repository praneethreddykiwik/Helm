// r215-startup-harness.mjs - R215: counts how many database round trips a signed-in page waits for, one after another,
// before it shows its content. It runs the page's REAL startup code (builder.js init(), or the page's inline boot script)
// against a mocked BPStore where every database call takes one "trip" (an artificial delay), with a minimal fake DOM.
//
// The mock follows store-api.js closely enough for counting (fresh browser tab, signed in):
//  - BPStore.init() = 1 trip (the sign-in gate; role + access matrix arrive with it, as the per-tab cache does)
//  - the first edit-permission check waits for my_trial_org (1 trip, shared); a free-trial-only area also waits for
//    my_trial_status (1 trip, shared) - the same memos store-api keeps per page
//  - quotes.get = 2 trips (store-api reads the quote row, then its version list); every other read = 1 trip
//  - nothing else (role, cached access answers, the bell's mount) costs a trip
// Used by test/r215-parallel-startup.test.mjs. `node test/r215-startup-harness.mjs [--ref <git-ref>]` prints the table
// (with --ref, the same measurement for that commit's files too, for a before / after comparison).
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const HelmPager = createRequire(import.meta.url)('../public/pager.js');   // R258: the real list behind the Quotes pager

export const TRIP_MS = 60;
const QID = '11111111-2222-4333-8444-555555555555';

const fileAt = (ref, path) => ref
  ? execFileSync('git', ['show', ref + ':' + path], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', maxBuffer: 64 << 20 })
  : readFileSync(new URL('../' + path, import.meta.url), 'utf8');

// the page's own startup code
export function pageSource(page, ref) {
  if (page === 'builder') {
    const js = fileAt(ref, 'public/builder.js');
    const a = js.indexOf('async function init(){'); const b = js.indexOf('\n}\n', a);
    if (a < 0 || b < 0) throw new Error('builder.js init() not found');
    return js.slice(a, b + 2) + '\n__boot(init);';
  }
  const html = fileAt(ref, 'public/' + page + '.html');
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((s) => s.includes('BPUI.boot('));
  if (blocks.length !== 1) throw new Error(page + ': expected one inline boot script, found ' + blocks.length);
  return blocks[0];
}

// ---------- a universal stand-in: any property, any call, any `new`, prints as "" ----------
function U() {
  const own = {};
  const f = function () {};
  return new Proxy(f, {
    get(t, k) {
      if (k === 'then') return undefined;
      if (k === Symbol.toPrimitive) return () => '';
      if (k === Symbol.iterator) return function* () {};
      if (k === 'length') return 0;
      if (k in own) return own[k];
      return (own[k] = U());
    },
    set(t, k, v) { own[k] = v; return true; },
    apply() { return U(); },
    construct() { return U(); },
  });
}

// ---------- fake DOM elements, one per selector; records when each first gets content ----------
function makeDom(now, marks) {
  const els = {}, touched = new Set();   // only elements the page wrote to count in the snapshot (a read changes nothing)
  const el = (sel) => {
    if (els[sel]) return els[sel];
    const own = { hidden: true, value: '', checked: false, style: {}, dataset: {}, options: [] };
    const set = (k, v) => { own[k] = v; touched.add(sel); if (k === 'innerHTML' || k === 'textContent') { if (!(('html:' + sel) in marks)) marks['html:' + sel] = now(); }
      if (k === 'hidden' && v === false && !(('shown:' + sel) in marks)) marks['shown:' + sel] = now(); };
    const p = new Proxy({}, {
      get(t, k) {
        if (k === 'then') return undefined;
        if (k === Symbol.toPrimitive) return () => '';
        if (k in own) return own[k];
        if (k === 'querySelectorAll') return () => [];
        if (k === 'querySelector' || k === 'closest') return (s) => el(sel + ' ' + s);
        if (k === 'classList') return { add() {}, remove() {}, toggle() {}, contains() { return false; } };
        if (k === 'addEventListener' || k === 'removeEventListener' || k === 'focus' || k === 'scrollIntoView' || k === 'setAttribute' || k === 'appendChild') return () => {};
        if (k === 'getAttribute') return () => null;
        if (k === 'children') return [];
        if (k === 'firstElementChild') return el(sel + ' >1');
        return U();
      },
      set(t, k, v) { set(k, v); return true; },
    });
    els[sel] = p; return p;
  };
  const snapshot = () => { const o = {}; for (const s of [...touched].sort()) { const e = els[s]; o[s] = { html: e.innerHTML, text: e.textContent, hidden: e.hidden, value: e.value, disabled: e.disabled }; } return o; };
  return { el, snapshot };
}

// ---------- the mocked BPStore ----------
function makeStore({ trip, log, fail, role, warm, oldDb }) {
  const calls = [];
  // one database read: resolves (or fails) after n trips
  const db = (path, n, value) => (...args) => {
    calls.push(path + '(' + JSON.stringify(args) + ')'); if (log.now) log.push(['call@' + Math.round(log.now() / trip), path]);
    return new Promise((res, rej) => setTimeout(() => {
      if (fail[path]) rej(Object.assign(new Error(fail[path].message || path + ' failed'), fail[path])); else res(typeof value === 'function' ? value(...args) : value);
    }, n * trip));
  };
  let ro = null, trial = null;
  // warm = a second page in the same tab: store-api already holds these two answers
  const studioRO = () => ro || (ro = warm ? Promise.resolve(false) : db('rpc.my_trial_org', 1, false)());
  const inTrial = () => trial || (trial = warm ? Promise.resolve(false) : db('rpc.my_trial_status', 1, false)());
  const OFF = { photo_render: 1, templates: 1, audit: 1 };
  const edit = fail.viewOnly ? false : true;
  const q = { id: QID, code: 'Q-0001', title: 'Sharma wedding', eventType: 'wedding', status: 'draft', approvalStatus: 'none', lifecycleStage: 'quote',
    client: { name: 'Sharma', guests: 200 }, pricing: { total: 1000 }, currentVersion: 2, versions: [{ versionNo: 1 }, { versionNo: 2 }], eventDate: '2026-12-01' };
  const rows = [{ id: QID, code: 'Q-0001', title: 'Sharma wedding', status: 'draft', approvalStatus: 'none', client: { name: 'Sharma' }, currentVersion: 2, updatedAt: '2026-11-18T10:00:00Z', eventDate: '2026-12-01' }];
  const S = {
    init: db('init', 1, undefined),
    mode: () => 'supabase',
    todayLocal: () => '2026-11-18',
    studioTimezone: () => 'Asia/Kolkata',
    fmtStudioDate: (d) => String(d), fmtDateIN: (d) => String(d),
    invoiceTotal: (x) => (x && x.total) || 0, quoteMoney: (n) => String(n), quoteStatus: () => ({ key: 'draft', label: 'Draft', tone: 'draft', title: '' }),
    stageLabel: (k) => String(k || ''), fmtDay: (d) => String(d || ''), fmtDateTime: (d) => String(d || ''),
    tax: { resolve: () => ({ name: 'GST' }) },
    auth: {
      enabled: () => true, required: () => true, user: () => ({ id: 'u1', email: 'owner@example.test' }),
      role: async () => role, cachedRole: () => role,
      canView: async (a) => { if (OFF[a]) await inTrial(); return true; },
      canEditArea: async (a) => { await studioRO(); if (OFF[a]) await inTrial(); return edit; },
      can: async (c) => { if (c !== 'view') await studioRO(); return edit; },
      canAssignTasks: async () => { await studioRO(); return edit; },
      requireView: async () => true,
      signOut: async () => {}, admin: { roleLabel: (r) => r }, areas: () => [{ key: 'quotes', page: 'quotes.html', label: 'Quotes' }, { key: 'leads', page: 'leads.html', label: 'Leads' }], tourSeen: () => true, tourEligible: () => false,
    },
    bell: { mount: async () => {} },
    config: { getPricing: db('config.getPricing', 1, { chairPrice: 10 }) },
    menuTemplates: { list: db('menuTemplates.list', 1, [{ id: 'p1', name: 'Gold', price_per_plate: 500 }]) },
    plan: { get: db('plan.get', 1, { menu_template: 'Gold', menu_plate_price: 500 }) },
    get: db('layouts.get', 1, { id: 'L1', name: 'Hall A', data: { items: [] } }),
    org: { current: db('org.current', 1, { brand: {} }) },
    quotes: {
      get: db('quotes.get', 2, q),
      getVersion: db('quotes.getVersion', 1, (id, n) => ({ versionNo: n, data: { items: [{ type: 'chair' }] } })),
      page: db('quotes.page', 1, { rows, hasMore: false, offset: 0 }),
      // R258 (0446): one page of 10 + the total; oldDb = a database without it (no such function -> null, remembered)
      pageNo: (...a) => (oldDb ? Promise.resolve(null) : db('quotes.pageNo', 1, { rows, total: 1, page: 1, size: 10, counts: { all: 1, cancelled: 0, archived: 0, deleted: 0, deleted_empty: 0 } })(...a)),
      counts: db('quotes.counts', 1, { quote: 1, confirmed: 0, cancelled: 0, total: 1 }),
      nextCodeFor: db('quotes.nextCodeFor', 1, 'Q-0002'), nextCode: () => 'Q-0002', isArchived: () => false,
      staleApprovals: db('quotes.staleApprovals', 1, new Set()),
      eventTypes: db('quotes.eventTypes', 1, ['Wedding']),
      countCancelled: db('quotes.countCancelled', 1, 0),
    },
    quoteShelf: { list: db('quoteShelf.list', 1, { rows: [], archived_count: 0, deleted_count: 0 }), tick: db('quoteShelf.tick', 1, null) },
    quoteValidity: { list: db('quoteValidity.list', 1, {}) },
    budget: { approvedChangeTotals: db('budget.approvedChangeTotals', 1, {}), invoiceTotals: db('budget.invoiceTotals', 1, {}) },
    calendar: {
      load: db('calendar.load', 1, () => ({ agenda: [{ event: { id: QID, code: 'Q-0001', title: 'Sharma wedding', eventDate: '2026-12-01', status: 'confirmed' } }], conflicts: [] })),
      sampleIds: db('calendar.sampleIds', 1, []),
      acks: db('calendar.acks', 1, {}),
    },
    leads: { list: db('leads.list', 1, []) },
    staff: { list: db('staff.list', 1, []), suggest: db('staff.suggest', 1, []) },
    vendors: { listAll: db('vendors.listAll', 1, []) },
    chat: { directory: db('chat.directory', 1, {}), paintAvatars: () => {}, eventGroups: { index: db('chat.eventGroups.index', 1, {}) } },
    ops: {
      categories: db('ops.categories', 1, ['Stage setup', 'Lighting']),
      listCrew: db('ops.listCrew', 1, [{ id: 'c1', name: 'Ravi', phone: '9' }]), listTasks: db('ops.listTasks', 1, []), listTokens: db('ops.listTokens', 1, []),
      listEvidence: db('ops.listEvidence', 1, []), templates: db('ops.templates', 1, [{ title: 'Build stage' }]), waStatus: db('ops.waStatus', 1, null),
      crew: { eventBrief: db('ops.crew.eventBrief', 1, null) },
      shifts: { unavailableConflicts: db('ops.shifts.unavailableConflicts', 1, [{ crew_id: 'c1', day: '2026-12-01', name: 'Ravi', approval: 'approved', events: [{ id: QID, code: 'Q-0001' }] }]),
        dayStatus: db('ops.shifts.dayStatus', 1, []) },
    },
    links: { studio: db('links.studio', 1, ''), url: (k, t, f) => f },
    flowProgress: { list: db('flowProgress.list', 1, []) },
    pending: db('pending', 1, { upcoming: [{ id: QID, code: 'Q-0001', title: 'Sharma wedding', event_date: '2026-12-01' }], unread: 0 }),
    myTasks: db('myTasks', 1, { counts: { today: 1 }, today: [{ title: 'Build stage' }] }),
    design: { queue: db('design.queue', 1, []) },
  };
  // anything the mock does not list still answers (and is counted as one trip), so a page never stalls on it
  const deep = (obj, path) => new Proxy(obj, {
    get(t, k) {
      if (typeof k === 'symbol' || k === 'then') return t[k];
      if (k in t) { const v = t[k]; return (v && typeof v === 'object' && !(v instanceof Set) && !Array.isArray(v)) ? deep(v, path + k + '.') : v; }
      log.push(['unmocked', path + k]);
      return db(path + k, 1, undefined);
    },
  });
  return { store: deep(S, ''), calls };
}

// ---------- run one page ----------
export async function runPage(page, { ref = null, fail = {}, role = 'admin', trip = TRIP_MS, warm = false, oldDb = false } = {}) {
  const src = pageSource(page, ref);
  const t0 = Date.now(); const now = () => Date.now() - t0;
  const marks = {}, log = [];
  const mark = (k) => { if (!(k in marks)) marks[k] = now(); };
  const dom = makeDom(now, marks);
  log.now = now;
  const { store, calls } = makeStore({ trip, log, fail, role, warm, oldDb });
  let boot = null, redirected = null;
  const location = { search: page === 'builder' ? '?quote=' + QID : page === 'ops' ? '?quote=' + QID : '', pathname: '/' + page + '.html', hash: '', href: '',
    replace: (u) => { redirected = u; }, reload() {} };
  const mem = {}; const storage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
  const BPUI0 = {
    boot: (fn) => { boot = fn; },
    loadError: (el, e, retry, o) => { log.push(['loadError', (o && o.what) || '', e && e.message]); mark('loadError'); return dom.el('loadError'); },
    toast: (m) => log.push(['toast', String(m)]),
    isNotFound: (e) => !!(e && e.code === 'PGRST116'),
    isPermissionError: () => false, isMissingFunction: () => false, isMissingTable: () => false, isAuthError: () => false, isRpcMissing: () => false,
    friendlyError: (e) => (e && e.message) || 'error',
    guard: (b, fn) => Promise.resolve().then(fn), confirm: async () => true, alert: async () => {}, confirmDiscard: async () => true,
    capGate: () => Promise.resolve(), capToast() {},
    pager: (o) => ({ reset: () => Promise.resolve(o.fetch(0)).then((r) => { mark('rows'); o.render(r.rows, { all: r.rows }); return r; }) }),
  };
  const BPUI = new Proxy(BPUI0, { get: (t, k) => (k in t ? t[k] : (t[k] = U())) });   // other helpers: stand-ins
  const env258 = { mount: () => ({ el: null, paint() {} }), list: (o) => HelmPager.list(Object.assign({}, o, { render: (r) => { mark('rows'); o.render(r); } })) };
  const win = { HelmPager: env258, BPStore: store, BPUI, HelmUrl: null, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }),
    parent: { postMessage() {} }, location };
  const HelmUrl = { get: async (n, fb) => (n === 'quote' ? QID : fb), here: () => page + '.html', upgrade: (h) => h };
  win.HelmUrl = HelmUrl;
  const document = { querySelector: (s) => dom.el(s), querySelectorAll: () => [], getElementById: (id) => dom.el('#' + id), body: dom.el('body'),
    createElement: () => dom.el('new:' + Math.random()), documentElement: dom.el('html'), addEventListener() {}, activeElement: null };
  const env = {
    window: new Proxy(win, { get: (t, k) => t[k], has: () => true }), document, location, localStorage: storage, sessionStorage: storage,
    HelmPager: env258, BPStore: store, BPUI, HelmUrl, history: { replaceState() {} },
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },   // the pages' own diagnostics stay quiet
    $: (s) => dom.el(s), __boot: (fn) => { boot = fn; },
    MutationObserver: function () { return { observe() {} }; }, ResizeObserver: undefined, IntersectionObserver: undefined,
    // builder.js module-level names the boot touches (the rest are stand-ins)
    PRICING: {}, CAPS: {}, CAPTURE_HOST: false, HelmBuilderAutoDefault: undefined, HelmRepriceGuard: undefined, EVENT_TYPE_PRESET: {}, TEMPLATES: { political: () => [] },
    applyLayout: () => mark('layout'), applyReadonly: (r, m) => log.push(['readonly', String(r), m || '']), toast: (m) => log.push(['toast', String(m)]),
    escapeHtml: (s) => String(s == null ? '' : s), quoteDisplayName: (x) => x.title, readDraft: () => null, canvasKey: () => 'k', layoutLoading: true,
    setLayoutLoading: (on) => { if (!on) mark('layoutLoadingOff'); }, versionsList: [],
    initStore: async () => { await store.init(); },   // builder.js: BPStore.init() + the connection badge
  };
  const scope = new Proxy(env, {
    has: (t, k) => typeof k === 'string',
    get(t, k) { if (k === Symbol.unscopables) return undefined; if (k in t) return t[k]; if (k in globalThis) return globalThis[k]; return (t[k] = U()); },
    set(t, k, v) { t[k] = v; return true; },
  });
  // sloppy-mode `with` so the page's free names resolve to the fake environment
  const run = new Function('__scope', 'with(__scope){\n' + src + '\n}');
  run(scope);
  if (!boot) throw new Error(page + ': no boot function');
  let error = null;
  try { await boot(); } catch (e) { error = e; log.push(['bootError', String(e && e.message)]); }
  const bootDone = now();
  await new Promise((r) => setTimeout(r, trip * 6));   // let the "never awaited" reads finish (badges, feeds)
  const w = (ms) => (ms == null ? null : Math.round(ms / trip));
  const waits = {}; for (const [k, v] of Object.entries(marks)) waits[k] = w(v);
  return { page, waits, bootDone: w(bootDone), calls, log, dom: dom.snapshot(), redirected, error };
}

// the content each page counts as "shown" (first paint of the real data), and when everything has arrived
export const FIRST_CONTENT = {
  builder: 'layout',            // the saved layout is on the floor
  calendar: 'html:#agenda',     // the event list (conflicts already marked)
  ops: 'html:#taskList',        // the task checklist (header + crew are drawn the same moment or before)
  quotes: 'rows',               // the quote rows
  dashboard: 'html:#mywork',    // the "My events" feed below the quote cards
};

export async function measure(ref, opts = {}) {
  const out = {};
  for (const p of Object.keys(FIRST_CONTENT)) {
    const r = await runPage(p, { ref, ...opts });
    out[p] = { content: r.waits[FIRST_CONTENT[p]], done: r.bootDone, run: r };
  }
  return out;
}

if (import.meta.url === 'file://' + process.argv[1]) {
  const i = process.argv.indexOf('--ref'); const ref = i > 0 ? process.argv[i + 1] : null;
  const warm = process.argv.includes('--warm');
  const after = await measure(null, { warm }); const before = ref ? await measure(ref, { warm }) : null;
  if (warm) console.log('(warm tab: the trial / read-only answers are already cached)');
  const dashMgr = { after: await runPage('dashboard', { role: 'manager', warm }), before: ref ? await runPage('dashboard', { ref, role: 'manager', warm }) : null };
  console.log('page        ' + (before ? 'before  ' : '') + 'after   (round trips one after another until the content shows, ' + (warm ? 'warm' : 'fresh') + ' tab)');
  for (const p of Object.keys(after)) console.log(p.padEnd(12) + (before ? String(before[p].content).padEnd(8) : '') + after[p].content);
  console.log('dashboard (manager board, design queue) ' + (dashMgr.before ? 'before ' + dashMgr.before.waits['html:#rbcards'] + ', ' : '') + 'after ' + dashMgr.after.waits['html:#rbcards']);
  const um = new Set(); for (const p of Object.values(after)) p.run.log.filter((l) => l[0] === 'unmocked').forEach((l) => um.add(l[1]));
  if (um.size) console.log('unmocked (counted as 1 trip each): ' + [...um].join(', '));
  for (const p of Object.values(after)) if (p.run.error) console.log(p.run.page + ' boot error: ' + p.run.error.stack);
}
