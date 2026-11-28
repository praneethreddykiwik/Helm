// R271: Settings > Links going out - every link the studio sent, in one list; turn off / back on / new link (admins only, no tokens)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const L = require('../public/studio-links.js');
const JS = read('public/studio-links.js'), CSS = read('public/studio-links.css'), CTL = read('public/control.html'), SPLIT = read('public/control-split.js');
const CAT = read('public/search-catalog.js'), TOURS = read('public/page-tours.js'), STORE = read('public/store-api.js');
const SQL = read('supabase/migrations/0454_r271_links.sql'), APPLY = read('supabase/APPLY-0454.sql'), MAN = read('supabase/migrations/MANIFEST'), RUN = read('scripts/db-test/run-all.sh');

const rows = [
  { kind: 'approval', id: 'q1', quote_id: 'q1', event_code: 'A-1', event_title: 'Rao wedding', who: 'Alice Rao', status: 'live', created_at: '2026-11-20T10:00:00Z', can_off: true },
  { kind: 'crew', id: 'c1', quote_id: 'q1', event_code: 'A-1', event_title: 'Rao wedding', who: 'Ravi Crew', status: 'off', created_at: '2026-11-19T10:00:00Z', can_off: false },
  { kind: 'vendor', id: 'v1', quote_id: 'q2', event_code: 'A-2', event_title: 'Gala', who: 'Deccan Rentals', status: 'live', request_id: 'r9', can_off: true },
  { kind: 'team', id: 't1', who: 'new@a.test', status: 'used', can_off: false },
  { kind: 'staff', id: 's1', who: 'Sita', status: 'live', can_off: true, can_new: true },
];

test('1 every kind has a plain name and every state a plain word', () => {
  for (const k of L.ORDER) assert.ok(L.kindLabel(k) && L.kindLabel(k) !== 'Link', k);
  assert.equal(L.ORDER.length, 9);
  assert.deepEqual(['live', 'expired', 'off', 'cancelled', 'paused', 'used'].map(L.statusLabel), ['Live', 'Expired', 'Turned off', 'Event cancelled', 'Paused', 'Used']);
});
test('2 the confirm says who loses access, for every kind', () => {
  for (const k of L.ORDER) { const t = L.offText({ kind: k, who: 'Asha' }); assert.ok(k === 'site' ? /Guests/.test(t) : /Asha/.test(t), k); assert.doesNotMatch(t, /—/); }
  assert.match(L.offText({ kind: 'crew', who: 'Ravi' }), /send their tasks again/);
});
test('3 search, kind, event and state filters', () => {
  assert.deepEqual(L.filter(rows, { q: 'ravi' }).map((r) => r.id), ['c1']);
  assert.deepEqual(L.filter(rows, { q: 'rao wedding' }).map((r) => r.id), ['q1', 'c1']);
  assert.deepEqual(L.filter(rows, { kind: 'vendor' }).map((r) => r.id), ['v1']);
  assert.deepEqual(L.filter(rows, { quote: 'q1' }).map((r) => r.id), ['q1', 'c1']);
  assert.deepEqual(L.filter(rows, { status: 'off' }).map((r) => r.id), ['c1']);
  assert.deepEqual(L.filter(rows, { q: 'turned off' }).map((r) => r.id), ['c1']);
  assert.deepEqual(L.events(rows).map((e) => e.text), ['A-1 Rao wedding', 'A-2 Gala']);
});
test('4 "Open its page" goes to the page the link belongs to (never the link itself)', () => {
  assert.equal(L.pageHref(rows[0]), 'event.html?id=q1');
  assert.equal(L.pageHref(rows[1]), 'ops.html?quote=q1');
  assert.equal(L.pageHref(rows[2]), 'vendors.html?tab=requests&quote=q2&req=r9');
  assert.equal(L.pageHref({ kind: 'site', quote_id: 'q1' }), 'invite-studio.html?quote=q1');
  assert.equal(L.pageHref({ kind: 'proposal', quote_id: 'q1' }), 'proposal.html?quote=q1');
  assert.equal(L.pageHref(rows[3]), 'control.html#users');
  assert.equal(L.pageHref(rows[4]), 'staff.html');
});
test('5 safe DOM only: no innerHTML, no inline styles, no em dash, no token copied', () => {
  assert.doesNotMatch(JS, /innerHTML|insertAdjacentHTML|outerHTML|\.style\b|document\.write/);
  assert.doesNotMatch(JS, /—/); assert.doesNotMatch(JS, /clipboard|\.token\b|\.slug\b/);
  assert.match(JS, /role !== "admin"/);
});
test('6 phone first: 44px targets, one column, wide screens get a row', () => {
  assert.match(CSS, /min-height:44px/); assert.match(CSS, /grid-template-columns:1fr/); assert.match(CSS, /@media \(min-width:760px\)/);
  assert.doesNotMatch(CSS, /(^|[;{\s])width:\s*\d{3,}px/);
});
test('7 wired into Settings: its own section, search, tour, the same in a free trial', () => {
  assert.match(CTL, /<div class="card" id="slCard" hidden aria-label="Links going out"><\/div>/);
  assert.match(CTL, /<script src="studio-links\.js\?v=\d+"><\/script>/); assert.match(CTL, /href="studio-links\.css\?v=\d+"/);
  assert.match(SPLIT, /key:"outlinks", group:"Workspace",  label:"Links going out"/); assert.match(SPLIT, /if\(id==="slCard"\) return "outlinks";/);
  assert.doesNotMatch(SPLIT, /TRIAL_OFF=\{[^}]*outlinks/); assert.doesNotMatch(CAT, /TRIAL_OFF_SECTIONS = \{[^}]*outlinks/);   // same in a free trial
  assert.match(CAT, /key: "outlinks",   label: "Links going out"/); assert.match(TOURS, /outlinks: \[\s*\{ sel: "#slCard"/); assert.match(TOURS, /"#links-going-out": "outlinks"/);
});
test('8 the store calls only the admin functions; an older database answers null', () => {
  for (const f of ['studio_links_list', 'studio_link_off', 'studio_links_off', 'studio_link_on', 'studio_link_new']) assert.ok(STORE.includes('rpc("' + f + '"'), f);
  assert.match(STORE, /const slNull = \(e\) => \{ if \(rpcMissing\(e\)\) return null; throw e; \};/); assert.match(STORE, /quoteValidity, automation,\n    studioLinks,\n/);
});
test('9 SQL: additive, safe twice, ASCII, admins only, existing switches, APPLY wraps it exactly', () => {
  assert.doesNotMatch(SQL, /[^\x00-\x7F]/); assert.doesNotMatch(SQL, /\b(drop\s+table|truncate|delete\s+from)\b/i);
  assert.match(SQL, /create table if not exists public\.link_offs/); assert.match(SQL, /if to_regprocedure\('public\._a260_link_state__pre0454\(text,text\)'\) is null then/);
  for (const f of ['booklet_revoke(v_q)', 'publish_proposal(v_q, false)', 'publish_event_site(p_id, false)', 'event_site_new_link(p_id)', 'staff_link_regenerate(v_crew)']) assert.ok(SQL.includes(f), f);
  assert.match(SQL, /not coalesce\(public\.is_admin\(\), false\)/); assert.match(SQL, /insert into public\.helm_schema_markers\(num, name\) values \(454, '0454_r271_links'\)/);
  assert.ok(APPLY.includes("begin;\nset local lock_timeout = '5s';\nset local statement_timeout = '5min';\n" + SQL + 'commit;\n'));
  assert.match(MAN, /\nforward  supabase\/migrations\/0454_r271_links\.sql\n/); assert.match(RUN, /R271-LINKS-0454: ALL PASS/); assert.match(RUN, /APPLY-0454: ALL OK/);
});
