// R258k (owner, 25 Nov 2026): 10 quotes a page in every Quotes tab, a numbered pager, each page fetched from the server.
//  A  pager.js: which numbers, "11-20 of 76", the Page box check, the control (fake DOM), keyboard
//  B  the list behind it: one page at a time, kept pages 30 s, dropped after a change, late answers dropped, errors
//  C  store-api pageNo: the call, the mapping, the fallback for a database without 0446
//  D  quotes.html wiring + styles + 0446 files
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const P = createRequire(import.meta.url)('../public/pager.js');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + (e && e.stack || e)); } };
const QH = read('public/quotes.html'), SA = read('public/store-api.js'), SQL = read('supabase/migrations/0446_r258_quotes_page.sql');

await t('A numbers: the owner picture, the ends, no "…" for one page', () => {
  assert.deepEqual(P.items(101, 125), [1, 'gap', 98, 99, 100, 101, 102, 103, 'gap', 125]);
  assert.deepEqual(P.items(1, 8), [1, 2, 3, 4, 5, 6, 7, 8]);
  for (let last = 1; last <= 40; last++) for (let p = 1; p <= last; p++) {
    const a = P.items(p, last), n = a.filter((x) => x !== 'gap');
    assert.ok(n.includes(1) && n.includes(p) && n.includes(last), p + '/' + last); assert.deepEqual(n, [...new Set(n)].sort((x, y) => x - y));
    a.forEach((x, i) => { if (x === 'gap') assert.ok(a[i + 1] - a[i - 1] > 2, 'gap of one page ' + p + '/' + last); else if (i && a[i - 1] !== 'gap') assert.equal(x - a[i - 1], 1); });
    assert.ok(a.length <= 11);
  }
});
await t('A "11-20 of 76", last page, thousands, unknown end; Page box check', () => {
  assert.equal(P.rangeText({ page: 2, size: 10, total: 76 }), '11-20 of 76'); assert.equal(P.rangeText({ page: 8, size: 10, total: 76 }), '71-76 of 76');
  assert.equal(P.rangeText({ page: 12, size: 10, total: 1250 }), '111-120 of 1,250'); assert.equal(P.rangeText({ page: 5, size: 10, total: 41 }), '41 of 41');
  assert.equal(P.rangeText({ page: 1, size: 10, total: 25, more: true }), '1-10 of 25+'); assert.equal(P.rangeText({ page: 1, size: 10, total: 0 }), '');
  for (const ok of ['1', ' 8 ', '08']) assert.equal(P.checkPage(ok, 8), ''); for (const no of ['', '0', '9', '-1', '1.5', 'abc', '1e3', '99999999']) assert.equal(P.checkPage(no, 8), 'Type a page number from 1 to 8.', no);
  assert.equal(P.checkPage('9', 3, true), '');
});

// a tiny DOM for the control
function makeDoc() {
  const doc = { activeElement: null };
  const mk = (tag) => { const e = { tag, children: [], attrs: {}, on: {}, hidden: false, textContent: '', value: '', className: '', ownerDocument: doc, parent: null,
    get firstChild() { return this.children[0] || null; },
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, removeAttribute(k) { delete this.attrs[k]; },
    appendChild(c) { c.parent = this; this.children.push(c); return c; }, removeChild(c) { this.children.splice(this.children.indexOf(c), 1); return c; },
    contains(x) { for (; x; x = x.parent) if (x === this) return true; return false; }, addEventListener(k, f) { this.on[k] = f; },
    closest() { return this.attrs['data-p'] ? this : null; }, focus() { doc.activeElement = this; }, select() {} }; return e; };
  doc.createElement = mk; return doc;
}
const all = (e, f) => [e, ...e.children.flatMap((c) => all(c, () => true))].filter(f);
await t('A control: hidden up to 10 rows, current page marked, Back / Next / number / box + Enter, wrong page said, focus kept', () => {
  const doc = makeDoc(), host = doc.createElement('div'), went = []; const ui = P.mount(host, { label: 'Quotes', onGo: (n) => went.push(n) });
  const nav = host.children[0], by = (c) => all(nav, (x) => x.className.split(' ').includes(c));
  ui.paint({ page: 1, size: 10, total: 10 }); assert.equal(nav.hidden, true); assert.equal(nav.attrs['aria-label'], 'Quotes pages');
  ui.paint({ page: 1, size: 10, total: 11 }); assert.equal(nav.hidden, false);
  ui.paint({ page: 2, size: 10, total: 76 });
  const cur = by('on'); assert.equal(cur.length, 1); assert.equal(cur[0].attrs['aria-current'], 'page'); assert.equal(cur[0].attrs['aria-label'], 'Page 2');
  assert.equal(by('hpg-now')[0].textContent, '2 / 8'); assert.equal(by('hpg-info')[0].textContent, '11-20 of 76'); assert.equal(by('hpg-info')[0].attrs['aria-live'], 'polite');
  const [back] = by('hpg-back'), [next] = by('hpg-next'), [box] = by('hpg-in'), [ok] = by('hpg-ok'), [nums] = by('hpg-nums'), [err] = by('hpg-err');
  back.on.click(); next.on.click(); nums.on.click({ target: by('hpg-n')[4] }); nums.on.click({ target: cur[0] }); assert.deepEqual(went, [1, 3, 5], 'the page on screen is not asked again');
  box.value = '9'; box.on.input(); ok.on.click(); assert.equal(err.hidden, false); assert.match(err.textContent, /from 1 to 8/); assert.equal(box.attrs['aria-invalid'], 'true'); assert.equal(doc.activeElement, box); assert.equal(went.length, 3);
  box.value = '8'; box.on.input(); assert.equal(err.hidden, true); let stopped = 0; box.on.keydown({ key: 'Enter', preventDefault() { stopped++; }, stopPropagation() {} }); assert.deepEqual(went, [1, 3, 5, 8]); assert.equal(stopped, 1);
  ui.paint({ page: 8, size: 10, total: 76 }); assert.equal(next.attrs['aria-disabled'], 'true'); next.on.click(); assert.equal(went.length, 4); assert.equal(box.value, '8');
  by('hpg-n')[7].focus(); ui.paint({ page: 3, size: 10, total: 76 }); assert.equal(doc.activeElement.attrs['aria-label'], 'Page 3', 'focus stays on the current page number');
});

// the list
function makeList(over = {}) {
  let key = 'a', now = 1000; const asked = [], shown = [], errs = [], waits = [];
  const L = P.list(Object.assign({ size: 10, ttl: 30000, clock: () => now, key: () => key, busy() {}, moved() {}, failed: (e) => errs.push(e.message),
    fetch: (n, hard) => { asked.push(key + n + (hard ? '!' : '')); return new Promise((res, rej) => waits.push({ res, rej, n })); }, render: (r) => shown.push(r.rows[0]) }, over));
  const ans = async (i, o = {}) => { waits[i].res(Object.assign({ rows: ['r' + waits[i].n], total: 76, page: waits[i].n }, o)); await new Promise((r) => setTimeout(r, 0)); };
  return { L, asked, shown, errs, waits, ans, set: (k) => { key = k; }, tick: (ms) => { now += ms; } };
}
const nap = () => new Promise((r) => setTimeout(r, 0));
await t('B one page at a time; visited pages kept 30 s; a change drops them', async () => {
  const x = makeList(); x.L.start(1); const p = x.L.go(1); await nap(); await x.ans(0); await p;
  x.L.go(2); await nap(); await x.ans(1); x.L.go(1); await nap(); assert.deepEqual(x.asked, ['a1', 'a2']); assert.deepEqual(x.shown, ['r1', 'r2', 'r1'], 'Back is instant');
  x.tick(30001); x.L.go(2); await nap(); await x.ans(2); assert.deepEqual(x.asked, ['a1', 'a2', 'a2']);
  x.L.remove('id'); x.L.go(1); await nap(); await x.ans(3); assert.equal(x.asked.length, 4, 'a change forgot the kept pages');
});
await t('B a new tab / search starts at page 1; the same list again asks nothing; a late answer never paints', async () => {
  const x = makeList(); x.L.start(1); x.L.go(4); await nap(); await x.ans(0); assert.equal(x.L.page(), 4);
  await x.L.apply(); assert.equal(x.asked.length, 1); x.set('b'); x.L.apply(); await nap(); assert.equal(x.asked[1], 'b1');
  x.set('c'); x.L.apply(); await nap(); await x.ans(2, { rows: ['c'] }); await x.ans(1, { rows: ['b'] }); assert.deepEqual(x.shown, ['r4', 'c']);
  x.L.apply(true); await nap(); assert.equal(x.asked[3], 'c1', 'a press on the open tab reads it again');
});
await t('B reload keeps the page; the server moves an emptied last page back by one', async () => {
  const x = makeList(); x.L.start(1); x.L.go(8); await nap(); await x.ans(0); const r = x.L.reset(); await nap(); assert.equal(x.asked[1], 'a8!'); await x.ans(1, { page: 7, total: 70 }); await r;
  assert.equal(x.L.page(), 7); assert.equal(x.L.total(), 70); x.L.reset(); await nap(); assert.equal(x.asked[2], 'a7!');
});
await t('B deep link / Back: the first load opens that page; a filter event with the same filters does not reset it; the early read is used once', async () => {
  const x = makeList(); x.L.start(3); x.L.prime(); await nap(); assert.deepEqual(x.asked, ['a3!']); await x.L.apply();
  const r = x.L.reset(); await nap(); assert.equal(x.asked.length, 1, 'the early answer is used'); await x.ans(0); await r; assert.equal(x.L.page(), 3);
  const y = makeList(); y.L.start(3); y.L.prime(); await nap(); y.set('z'); y.L.reset(); await nap(); assert.deepEqual(y.asked, ['a3!', 'z1!'], 'other filters: page 1, the early answer is not used');
});
await t('B a failed page click keeps the page and says so; a failed tab throws for the error card, and can be tried again', async () => {
  const x = makeList(); x.L.start(1); x.L.go(1); await nap(); await x.ans(0);
  const p = x.L.go(2, { click: true }); await nap(); x.waits[1].rej(new Error('offline')); await p; assert.deepEqual(x.errs, ['offline']); assert.equal(x.L.page(), 1);
  x.set('b'); const q = x.L.apply(); await nap(); x.waits[2].rej(new Error('x')); await assert.rejects(q, /x/); x.L.apply(); await nap(); assert.equal(x.asked.length, 4);
});

// pageNo, lifted out of store-api.js
function pageNoEnv(answer) {
  const a = SA.indexOf('    async pageNo(o) {'), b = SA.indexOf('    counts: () => qt().counts(),'), c = SA.indexOf('  const QPAGE_KEY ='), d = SA.indexOf('  const quotes = {', c);
  const calls = [], mem = {};
  const ctx = vm.createContext({ calls, mode: 'supabase', supa: {}, Number, Math, String, Set, Promise, Array, Date, isFinite, sessionStorage: { getItem: (k) => mem[k] || null, setItem: (k, v) => { mem[k] = v; } },
    linkViews: { attentionIds: async () => ['x1', 'x2'] }, quoteValidity: { expiringSoon: async () => ['x2', 'x3'] }, localISODate: () => '2026-11-25', quoteDay: (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ''),
    rpc: async (n, p) => { calls.push([n, p]); return answer(n, p); }, rpcMissing: (e) => e.code === 'PGRST202', mapQuoteSummary: (r) => ({ id: r.id, mapped: true }) });
  vm.runInContext(SA.slice(c, d) + ';this.S={' + SA.slice(a, b) + '};', ctx); return { S: ctx.S, calls, mem };
}
await t('C pageNo: one call, the filters and the page in it, rows mapped, the numbers only when asked', async () => {
  const e = pageNoEnv(() => ({ rows: [{ id: 'q1' }], total: 76, page: 2, size: 10, counts: null }));
  const d = await e.S.pageNo({ tab: 'deleted', page: 2, size: 10, search: "  o'neil %  ", eventType: 'Wedding', dateFrom: '2026-11-01', dateTo: 'junk', kind: 'hand', sort: 'confirmedFirst', counts: false });
  const p = e.calls[0][1]; assert.equal(e.calls.length, 1); assert.equal(e.calls[0][0], 'quotes_page');
  assert.deepEqual(JSON.parse(JSON.stringify(p)), { p_tab: 'deleted', p_search: "o'neil %", p_type: 'Wedding', p_from: '2026-11-01', p_to: null, p_kind: 'hand', p_sort: 'confirmed', p_page: 2, p_size: 10, p_ids: null, p_today: '2026-11-25', p_counts: false });
  assert.equal(d.total, 76); assert.equal(d.page, 2); assert.equal(d.rows[0].mapped, true); assert.equal(d.counts, null);
  await e.S.pageNo({ tab: 'attention', page: -4, size: 999 }); const q = e.calls[1][1]; assert.deepEqual([...q.p_ids], ['x1', 'x2', 'x3']); assert.equal(q.p_page, 1); assert.equal(q.p_size, 50); assert.equal(q.p_kind, 'all'); assert.equal(q.p_counts, true);
  const ip = await e.S.pageNo({ tab: 'inprogress' }); assert.equal(ip.rows[0].mapped, undefined, 'In progress rows stay as they are');
});
await t('C before 0446: null, and not asked again in this tab for 10 minutes; any other error is thrown', async () => {
  const e = pageNoEnv(() => { const x = new Error('missing'); x.code = 'PGRST202'; throw x; });
  assert.equal(await e.S.pageNo({ tab: 'all' }), null); assert.equal(await e.S.pageNo({ tab: 'all' }), null); assert.equal(e.calls.length, 1);
  e.mem.bp_q_page_off = String(Date.now() - 600001); await e.S.pageNo({ tab: 'all' }); assert.equal(e.calls.length, 2);
  await assert.rejects(pageNoEnv(() => { throw new Error('Failed to fetch'); }).S.pageNo({}), /Failed to fetch/);
  assert.match(SA, /\|quotes_page\)\(\\\?\|\$\)\/;/, 'a read-only call: it never drops the shared reads of the page');
});

await t('D quotes.html: 10 a page, pager under the list, no Load more, scripts + styles', () => {
  assert.match(QH, /const Q_SIZE=10, COUNTS_MS=30000;/); assert.match(QH, /<div id="qPager"><\/div>/); assert.match(QH, /<link rel="stylesheet" href="pager\.css\?v=\d+">/);
  assert.ok(QH.indexOf('pager.js?v=') > 0 && QH.indexOf('pager.js?v=') < QH.indexOf('<script>\n')); assert.doesNotMatch(QH, /BPUI\.pager\(/);
  assert.match(QH, /ttl:30000/); assert.match(QH, /\.\.\.quoteDateArgs\(\) \}\);\n\s+if\(d\)/, 'the dates go to the server');
  assert.match(QH, /const listKey=\(\)=>JSON\.stringify\(\[filter, typeFilter, \(\$\("#search"\)\.value\|\|""\)\.trim\(\), dateFilter, filter==="deleted"\?delKind:""\]\);/);
});
await t('D delete / archive / restore read the page again (and drop kept pages); Back keeps tab, page, search in the history entry, the search never in the address', () => {
  assert.match(QH, /async function rowGone\(id\)\{\s*if\(pager\) pager\.remove\(id\);[\s\S]{0,120}await reloadQuiet\(\);/); assert.equal(QH.split('await rowGone(id)').length - 1, 3);
  const sv = QH.slice(QH.indexOf('function saveView('), QH.indexOf('function restoreView(')); assert.match(sv, /searchParams\.set\("page", String\(p\)\)/); assert.doesNotMatch(sv, /searchParams\.set\("(q|search|focus)"/); assert.match(sv, /Object\.assign\(\{\}, history\.state, \{ hq:/);
  assert.match(QH, /if\(pager\) pager\.drop\(\);/, 'a client approval drops the kept pages');
});
await t('D shelf state comes with the rows of the page (the whole shelf is not read)', () => {
  const a = QH.indexOf('/* ---------- Archive / Deleted shelves (0040)'), b = QH.indexOf('/* ---------- end Archive / Deleted shelves ---------- */'); const els = {};
  const el = (s) => els[s] || (els[s] = { textContent: '', hidden: true, value: '' });
  const ctx = vm.createContext({ $: el, filter: 'deleted', typeFilter: '', dateFilter: '', quotes: [], detailCache: {}, window: {}, String, Number, Array, Date, Promise, isNaN, BPStore: { mode: () => 'supabase' } });
  vm.runInContext(QH.slice(a, b) + ';Object.assign(this,{shelf,shelfFromPage,shelfNote,paintShelfTabs});', ctx);
  ctx.shelfFromPage([{ id: 'd', deletedAt: '2026-11-20T10:00:00Z', deletedReason: 'auto_empty_draft' }, { id: 'a', archivedAt: '2026-11-20T10:00:00Z', archivedReason: 'manual' }, { id: 'x' }], { all: 5, cancelled: 2, archived: 3, deleted: 76, deleted_empty: 36 });
  assert.equal(ctx.shelf.ready, true); assert.deepEqual(Object.keys(ctx.shelf.byId), ['d', 'a']); assert.match(ctx.shelfNote(ctx.shelf.byId.d), /Discarded automatically/); assert.match(ctx.shelfNote(ctx.shelf.byId.a), /Archived by hand/);
  assert.equal(els['#cnt_deleted'].textContent, '76'); assert.equal(els['#cnt_dkhand'].textContent, '40'); assert.equal(els['#cnt_dkempty'].textContent, '36'); assert.equal(els['#discardWrap'].hidden, false); assert.equal(els['#cnt_cancelled'].textContent, '2');
});
await t('D phone: Back, "3 / 8", Next, Go at 44px; accent page number', () => {
  const c = read('public/pager.css'); assert.match(c, /@media \(max-width:760px\),\(pointer:coarse\)\{\.hpg-b\{min-width:44px;height:44px\}\.hpg-in\{height:44px;font-size:16px\}\}/);
  assert.match(c, /@media \(max-width:640px\)\{\s*\.hpg-nums\{display:none\}\.hpg-now\{display:inline-block\}/); assert.match(c, /\.hpg-b\.on\{background:var\(--accent/);
  assert.doesNotMatch(read('public/pager.js'), /innerHTML|\.style\b|eval\(/);
});
await t('D 0446: read only, runs as the caller, pinned, anon refused, clamps, MANIFEST + APPLY the same body', () => {
  assert.match(SQL, /language plpgsql stable security invoker set search_path = ''/); assert.match(SQL, /least\(coalesce\(p_size, 10\), 50\)/); assert.match(SQL, /q\.updated_at desc, q\.id desc/);
  assert.doesNotMatch(SQL.replace(/--.*$/gm, ''), /\b(update|delete from|drop|alter|truncate)\b(?! function)/i); assert.match(SQL, /insert into public\.helm_schema_markers\(num, name\) values \(446,/);
  assert.match(SQL, /from anon/); assert.match(read('supabase/migrations/MANIFEST'), /\nforward  supabase\/migrations\/0446_r258_quotes_page\.sql\n/);
  const ap = read('supabase/APPLY-0446.sql'); assert.ok(ap.includes(SQL)); assert.match(ap, /begin;\nset local lock_timeout = '5s';/); assert.ok(ap.trimEnd().endsWith('commit;'));
  assert.match(read('scripts/db-test/run-all.sh'), /r258-quotes-page-0446/);
});

console.log(`\nr258-k: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
