// r136: audit log clarity (owner items 1-5). Pure + static checks; behaviour of 0340: tests/db/r136-audit-via-0340.sql.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
let n = 0;
const t = async (name, fn) => { try { await fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };
globalThis.HelmCountry = require('../public/country-profile.js');
globalThis.AuditFormat = require('../public/audit-format.js');
const A = require('../public/audit-clarity.js');
const SRC = r('public/audit-clarity.js'), SQL = r('supabase/migrations/0340_r136_audit_via.sql'), APPLY = r('supabase/APPLY-0340.sql'), HTML = r('public/audit.html');
const code = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
const txt = (lines) => lines.map((l) => A.segText(l.segs)).join(' / ');
const IN = { country: 'IN' }, AE = { country: 'AE' };
const Q = '11111111-1111-4111-8111-111111111111', Q2 = '22222222-2222-4222-8222-222222222222', U = 'aaaaaaaa-0000-4000-8000-000000000001';
const at = (s) => '2026-11-11T10:' + s + '+00:00';
const row = (o) => Object.assign({ actor: U, actor_email: 'admin@helm.com', quote_id: Q, action: 'update', entity: 'quotes' }, o);

await t('0340: in the manifest after 0338, APPLY carries it verbatim in one transaction, ASCII only', () => {
  const mf = r('supabase/migrations/MANIFEST');
  assert.ok(mf.indexOf('0338_r130_task_reminders.sql') < mf.indexOf('forward  supabase/migrations/0340_r136_audit_via.sql'));
  assert.ok(!/0339_/.test(mf), '0339 stays reserved for the parked branch');
  assert.ok(APPLY.includes(SQL.trim())); assert.match(APPLY, /^begin;$/m); assert.ok(APPLY.indexOf('commit;') < APPLY.indexOf('-- VERIFY'));
  for (const s of [SQL, APPLY]) assert.ok(/^[\x00-\x7F]*$/.test(s));
  assert.match(r('scripts/db-test/run-all.sh'), /run "r136-audit-via-0340" "R136-AUDIT-VIA-0340: ALL PASS \\\(18\/18\\\)" psql -q -f tests\/db\/r136-audit-via-0340\.sql/);
});
await t('0340: additive - nothing dropped / deleted, no grant widened, old rows never updated', () => {
  assert.doesNotMatch(code, /\bdrop\s+(table|column|policy|schema|view|function|trigger)\b/i);
  assert.doesNotMatch(code, /\bdelete\s+from\b/i); assert.doesNotMatch(code, /\btruncate\b/i);
  assert.doesNotMatch(code, /\bupdate\s+public\.audit_log\b/i); assert.doesNotMatch(code, /\bgrant\b/i);
  assert.doesNotMatch(code, /alter\s+table/i);
});
await t('0340: marker set only around the lead write and put back; tg_audit copies it; 0164 parts kept', () => {
  assert.match(code, /perform set_config\('helm\.audit_via', 'quote_sync', true\);\s*perform set_config\('helm\.audit_via_quote', NEW\.id::text, true\);\s*if v_lead\.id is not null then/);
  assert.match(code, /perform set_config\('helm\.audit_via', v_via0, true\);\s*perform set_config\('helm\.audit_via_quote', v_viaq0, true\);\s*return NEW;/);
  assert.match(code, /jsonb_build_object\('_via', v_via\)/); assert.match(code, /jsonb_build_object\('_via_quote', v_via_q\)/);
  assert.match(code, /public\._audit_redact\(v_changed, true\)/); assert.match(code, /v_email := 'helm:maintenance'/);
  // guarded re-issue over the known bodies; the new bodies carry no OLD marker, so re-running 0148 / 0164 can't overwrite them
  assert.match(code, /position\('sys-quiet-0164' in v_src\) = 0 and position\('audit-via-0340' in v_src\) = 0/);
  assert.match(code, /position\('0199: the quote is the single source' in v_src\) = 0/);
  const bodies = code.split('$fn$').filter((_, i) => i % 2 === 1).join('\n');
  for (const m of ['sys-quiet-0164', 'audit-1017-0148', 'audit-run2-0042']) assert.ok(!bodies.includes(m), m);
  assert.match(code, /_r340_keep\('public\.tg_audit\(\)'\)/); assert.match(code, /_r340_keep\('public\.sync_quote_to_lead\(\)'\)/);
});

await t('item 4: money in the studio currency - INR Indian grouping, AED, a supplied formatter wins', () => {
  assert.equal(A.money(8000000, IN), '₹80,00,000'); assert.equal(A.money(800000, IN), '₹8,00,000');
  assert.equal(A.money(508344, IN), '₹5,08,344'); assert.equal(A.money(800000, AE), 'AED 800,000');
  assert.equal(A.money(5, { money: (x) => 'X' + x }), 'X5');
  assert.equal(txt(A.describe(row({ entity: 'leads', changed: { budget: [8000000, 800000] } }), IN)), 'Budget: ₹80,00,000 → ₹8,00,000');
  assert.equal(txt(A.describe(row({ entity: 'leads', changed: { budget: [null, 9500] } }), AE)), 'Budget: (empty) → AED 9,500');
  for (const k of ['budget', 'total', 'subtotal', 'grandTotal', 'amount', 'advance_paid', 'discount', 'price', 'balance']) assert.ok(A.isMoneyKey(k), k);
  for (const k of ['tax_rate', 'gst_pct', 'guest_count', 'paid_at', 'payment_method', 'discount_type', 'currency', 'status']) assert.ok(!A.isMoneyKey(k), k);
});
await t('item 4: plain words - (empty), tokens, versions, settings actions, Title words, seconds on hover', () => {
  assert.equal(txt(A.describe(row({ changed: { guest_count: [null, 150] } }), IN)), 'Guests: (empty) → 150');
  assert.equal(txt(A.describe(row({ changed: { deleted_reason: [null, 'auto_empty_draft'] } }), IN)), 'Removed automatically because it was left empty');
  assert.equal(txt(A.describe(row({ changed: { current_version: [1, 2] } }), IN)), 'Saved quote version 2');
  assert.equal(txt(A.describe(row({ changed: { pricing: [null, { total: 508344 }] } }), IN)), 'Total set to ₹5,08,344');
  assert.equal(txt(A.describe({ action: 'comms_settings.set', entity: 'comms_settings', changed: {} }, IN)), 'Changed message settings');
  assert.equal(A.actionLabel('comms_settings.set'), 'Changed'); assert.equal(A.actionLabel('privacy_pin.reset'), 'Reset');
  assert.equal(A.fieldLabel('lifecycle_stage'), 'Stage'); assert.equal(A.fieldLabel('travel_mode'), 'Travel Mode'); assert.equal(A.fieldLabel('setupFee'), 'Setup Fee');
  assert.equal(txt(A.describe(row({ changed: { lifecycle_stage: ['quote', 'event_day'] } }), IN)), 'Stage: Quote → Event day');
  assert.doesNotMatch(txt(A.describe(row({ changed: { foo_bar: [null, ''] } }), IN)), /∅/);
  assert.match(SRC, /second: "2-digit"/); assert.match(SRC, /setAttribute\("title", fmtFull\(r\.at\)\)/);
});
await t('item 2: client details show before -> after for safe fields only; phone / e-mail / address stay names-only', () => {
  const o = { name: 'Spandhana', budget: '8000000', guests: '100', city: '', phone: '9000011111', email: 'a@x.test', address: '12 MG Road', notes: 'secret note' };
  const nw = { name: 'Spandhana', budget: '800000', guests: '150', city: 'Hyderabad', state: 'Telangana', phone: '9000022222', email: 'b@x.test', address: '14 MG Road', notes: 'other' };
  const s = txt(A.describe(row({ changed: { client: [o, nw] } }), IN));
  assert.match(s, /Budget: ₹80,00,000 → ₹8,00,000/); assert.match(s, /Guests: 100 → 150/);
  assert.match(s, /City: \(empty\) → Hyderabad/); assert.match(s, /State: \(empty\) → Telangana/);
  assert.match(s, /Phone changed/); assert.match(s, /Email changed/); assert.match(s, /Address changed/); assert.match(s, /Notes changed/);
  for (const v of ['9000011111', '9000022222', 'a@x.test', 'b@x.test', 'MG Road', 'secret note']) assert.ok(!s.includes(v), v);
  // a lead's own phone / e-mail columns too
  assert.equal(txt(A.describe(row({ entity: 'leads', changed: { phone: ['1', '2'], email: [null, 'c@x.test'] } }), IN)), 'Phone changed / Email added');
  assert.ok(!A.isSensitiveKey('company')); assert.ok(A.isSensitiveKey('alt_phone')); assert.ok(A.isSensitiveKey('pan'));
});

await t('item 1: Helm (automatic) for a marked row; old rows only when safely deducible', () => {
  const ev = { [Q]: { code: '11112026-01', label: 'CORP_HYD_150_29NOV26', client: 'Spandhana' } };
  const who = (r) => ({ text: r.actor_email || 'System', title: '' });
  const marked = row({ entity: 'leads', at: at('43:05'), changed: { budget: [8000000, 800000], _via: 'quote_sync', _via_quote: Q } });
  const w = A.who(marked, { events: ev, who }, [marked]);
  assert.equal(w.text, 'Helm (automatic)'); assert.equal(w.sub, 'from quote CORP_HYD_150_29NOV26 · after admin@helm.com saved it');
  assert.doesNotMatch(txt(A.describe(marked, IN)), /_via|quote_sync/);
  // old (before 0340): lead CREATED in the same transaction (identical time) as the same person's quote change
  const qrow = row({ at: at('41:00.123456'), changed: { client: [null, { name: 'Spandhana' }] } });
  const lead = row({ entity: 'leads', action: 'insert', at: at('41:00.123456'), changed: { name: 'Spandhana', status: 'quoted', source: 'quote' } });
  assert.equal(A.who(lead, { events: ev, who }, [lead, qrow]).text, 'Helm (probably automatic)');
  assert.equal(A.who(lead, { who }, [lead]).text, 'admin@helm.com', 'no quote row at that exact time: left as it is');
  assert.equal(A.who(lead, { who }, [lead, Object.assign({}, qrow, { at: at('41:01') })]).text, 'admin@helm.com', 'a second apart: not deducible');
  assert.equal(A.who(Object.assign({}, lead, { changed: { name: 'S', source: 'walk_in' } }), { who }, [lead, qrow]).text, 'admin@helm.com');
  const handEdit = row({ entity: 'leads', at: at('41:00.123456'), changed: { notes: [null, 'x'] } });
  assert.equal(A.who(handEdit, { who }, [handEdit, qrow]).text, 'admin@helm.com', 'a lead field the sync never writes: a person');
  // the empty-draft clean-up says so
  const draft = row({ changed: { deleted_at: [null, at('40:00')], deleted_reason: [null, 'auto_empty_draft'] } });
  assert.equal(A.who(draft, { who }, [draft]).text, 'Helm (automatic)');
  assert.equal(A.who(row({ changed: { budget: [1, 2] } }), { who }, []).text, 'admin@helm.com');
});
await t('item 3: one entry per editing session; duplicates fold into x2; other people / events / gaps split', () => {
  const rows = [
    row({ id: 7, entity: 'leads', at: at('44:00'), changed: { budget: [8000000, 800000], _via: 'quote_sync', _via_quote: Q } }),
    row({ id: 6, at: at('44:00'), changed: { client: [{ budget: '8000000', guests: '100' }, { budget: '800000', guests: '150', city: 'Hyderabad', state: 'Telangana' }] } }),
    row({ id: 5, at: at('43:10.2'), changed: { current_version: [1, 2] } }),
    row({ id: 4, at: at('43:10.9'), changed: { current_version: [1, 2] } }),
    row({ id: 3, at: at('42:00'), changed: { tax_snapshot: [null, { rate: 18 }] } }),
    row({ id: 2, at: at('35:00'), changed: { title: ['A', 'B'] } }),                      // 7 minutes earlier: a new session
    row({ id: 1, at: at('34:59'), actor: 'other', actor_email: 'sam@helm.com', changed: { title: ['B', 'C'] } }),
  ];
  const g = A.group(rows);
  assert.deepEqual(g.map((x) => x.type), ['group', 'row', 'row']);
  assert.equal(g[0].entries.length, 4); assert.equal(g[0].rows.length, 5);
  assert.equal(g[0].entries.find((e) => e.row.id === 5).count, 2, 'the identical version save half a second apart folds into x2');
  const s = A.segText(A.summary(g[0].entries, Object.assign({ rows }, IN)));
  assert.equal(s, 'Edited quote: tax, saved version 2, budget ₹8,00,000, guests 150, city, state (4 changes)');
  // no event: never grouped; another event: split
  assert.equal(A.group([row({ quote_id: null, at: at('10:00') }), row({ quote_id: null, at: at('10:01') })]).length, 2);
  assert.equal(A.group([row({ at: at('10:00') }), row({ quote_id: Q2, at: at('10:01') })]).length, 2);
  // the same change twice but 10 s apart is two real steps, not a duplicate
  assert.equal(A.dedupe([row({ at: at('10:10'), changed: { a: [1, 2] } }), row({ at: at('10:00'), changed: { a: [1, 2] } })]).length, 2);
  assert.equal(A.GAP_MS, 5 * 60 * 1000);
});
await t('item 5: event label = name . client with the code; fallbacks; never money', () => {
  const ev = { [Q]: { code: '11112026-01', title: 'CORP_HYD_150_29NOV26', label: 'CORP_HYD_150_29NOV26', client: 'Spandhana' } };
  const L = A.eventLabel(row({}), ev, []);
  assert.equal(L.text, 'CORP_HYD_150_29NOV26 · Spandhana'); assert.equal(L.code, '11112026-01'); assert.equal(L.href, 'event.html?id=' + Q);
  assert.equal(A.eventLabel(row({}), {}, []).text, 'Event', 'unreadable / deleted: no name');
  assert.equal(A.eventLabel(row({}), {}, [row({ action: 'insert', changed: { code: '11112026-01' } })]).text, '11112026-01', 'deleted: the code from its own audit row');
  assert.equal(A.eventLabel(row({}), { [Q]: { code: 'C1', label: 'Wedding ₹5,00,000 budget', client: '' } }, []).text, 'Wedding');
  assert.equal(A.eventLabel(row({}), { [Q]: { code: 'C1', label: '', client: '' } }, []).text, 'C1');
  assert.equal(A.eventLabel(row({ quote_id: null }), ev, []), null);
});
await t('item 5: ONE batched, RLS-scoped read (BPStore.quotes.byIds) for the rows on screen', async () => {
  const calls = [];
  globalThis.BPStore = { quotes: { byIds: async (ids) => { calls.push(ids); return [{ id: Q, code: '11112026-01', title: '', client: { name: 'Spandhana', city: 'Hyderabad', guests: '150' }, eventType: 'corporate', eventDate: '2026-11-29' }]; } } };
  globalThis.HelmEventName = require('../public/event-name.js');
  const by = await A.loadEvents([Q, Q, Q2, 'not-a-uuid']);
  assert.equal(calls.length, 1); assert.deepEqual(calls[0], [Q, Q2]);
  assert.deepEqual(by[Q], { code: '11112026-01', title: '', label: 'CORP_HYD_150_29NOV26', client: 'Spandhana' });
  assert.equal(by[Q2], undefined);
  delete globalThis.BPStore; delete globalThis.HelmEventName;
});

// a tiny DOM, enough for render()
function fakeDoc() {
  class N { constructor(tag) { this.tagName = tag; this.childNodes = []; this.attrs = {}; this.className = ''; this.hidden = false; this.listeners = {}; this._t = '';
      const self = this; this.classList = { toggle(c, on) { const s = new Set(self.className.split(' ').filter(Boolean)); if (on) s.add(c); else s.delete(c); self.className = [...s].join(' '); } }; }
    get firstChild() { return this.childNodes[0] || null; }
    appendChild(c) { this.childNodes.push(c); c.parentNode = this; return c; }
    removeChild(c) { this.childNodes.splice(this.childNodes.indexOf(c), 1); return c; }
    setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; } hasAttribute(k) { return k in this.attrs; }
    addEventListener(k, f) { this.listeners[k] = f; }
    set textContent(v) { this.childNodes = []; this._t = String(v); }
    get textContent() { return this._t + this.childNodes.map((c) => c.textContent).join(''); }
    set innerHTML(v) { throw new Error('innerHTML used'); } }
  const doc = { createElement: (tg) => new N(tg), createTextNode: (s) => ({ textContent: s }) };
  const tbody = new N('tbody'); tbody.ownerDocument = doc; return { doc, tbody };
}
await t('render: DOM only (no innerHTML), group button toggles the steps (aria-expanded), money spans masked by Hide amounts', () => {
  for (const bad of [/\.innerHTML\b/, /insertAdjacentHTML/, /\.outerHTML\b/, /document\.write/, /new Function\b/, /\beval\(/]) assert.doesNotMatch(SRC, bad);
  const { tbody } = fakeDoc();
  const rows = [
    row({ id: 2, entity: 'leads', at: at('44:00'), changed: { budget: [8000000, 800000], _via: 'quote_sync', _via_quote: Q } }),
    row({ id: 1, at: at('44:00'), changed: { client: [{ budget: '8000000' }, { budget: '800000' }] } }),
    row({ id: 0, quote_id: null, entity: 'app_config', at: at('20:00'), changed: { price: [10, 20] } }),
  ];
  A.render(tbody, rows, Object.assign({ events: {}, areaLabel: (e) => e, fmt: (x) => 'T' }, IN));
  const trs = tbody.childNodes; assert.equal(trs.length, 4, 'summary + 2 hidden steps + the other row');
  assert.equal(trs[0].className, 'ac-group'); assert.ok(trs[1].hidden && trs[2].hidden); assert.ok(!trs[3].hidden);
  const find = (nd, f) => { if (f(nd)) return nd; for (const c of nd.childNodes || []) { const x = find(c, f); if (x) return x; } return null; };
  const btn = find(trs[0], (x) => x.tagName === 'button');
  assert.equal(btn.getAttribute('type'), 'button'); assert.equal(btn.getAttribute('aria-expanded'), 'false');
  assert.equal(btn.getAttribute('aria-controls'), trs[1].id + ' ' + trs[2].id);
  btn.listeners.click(); assert.equal(btn.getAttribute('aria-expanded'), 'true'); assert.ok(!trs[1].hidden && !trs[2].hidden); assert.equal(btn.textContent, 'Hide steps');
  btn.listeners.click(); assert.ok(trs[1].hidden);
  assert.match(trs[0].textContent, /\+ 1 automatic update by Helm/); assert.match(trs[1].textContent + trs[2].textContent, /Helm \(automatic\)/);
  const m = find(trs[3], (x) => x.attrs && 'data-money' in x.attrs); assert.ok(m, 'money carries data-money'); assert.equal(m.textContent, '₹10');
});
await t('audit.html: loads audit-clarity js + css, renders through it, keeps the old path as a fallback; tour step', () => {
  assert.match(HTML, /<script src="audit-clarity\.js\?v=\d+"><\/script>/); assert.match(HTML, /<link rel="stylesheet" href="\/audit-clarity\.css\?v=\d+">/);
  assert.ok(HTML.indexOf('audit-format.js') < HTML.indexOf('audit-clarity.js'));
  assert.match(HTML, /if\(window\.AuditClarity\)\{ AuditClarity\.render\(\$\("#rows"\), list,/);
  assert.match(HTML, /window\.AuditClarity \? await AuditClarity\.loadEvents\(need\) : await BPStore\.audit\.eventLabels\(need\)/);
  assert.match(r('public/page-tours.js'), /\{ sel: "#rows \.ac-toggle", title: "One line per edit"/);
});

console.log(`r136-audit-clarity: ${n} passed`);
