// R191 (0374): Money phase 3 "Inventory upgrade" + phase 4 "multi-day stock" - consumables, part-returns, photo proof,
// found / repair rows, the absorb / charge-client decision (Finance), stock dates + buffer days, item costs for Finance only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); } };

const MIG = read('supabase/migrations/0374_r191_inventory_upgrade.sql');
const APPLY = read('supabase/APPLY-0374.sql');
const MF = read('supabase/migrations/MANIFEST');
const RUNALL = read('scripts/db-test/run-all.sh');
const RET = read('tests/db/trial-retention-0184.sql');
const DBT = read('tests/db/r191-inventory-0374.sql');
const OVR = read('supabase/check-prod-overrides.json');
const API = read('public/store-api.js');
const INV = read('public/inventory.html');
const TD = read('public/teardown.html');
const PORTAL = read('public/portal.html');
const SCJ = read('public/stock-checkin.js');
const TOURS = read('public/page-tours.js');
const PKG = read('package.json');
const code = (s) => s.replace(/^\s*--.*$/gm, '');
const SC = require('../public/stock-checkin.js');
const SF = require('../public/stock-flow.js');

await t('0374: zero data loss - additive, ASCII, editor-safe comment lines', () => {
  assert.ok(/^[\x00-\x7f]*$/.test(MIG), 'ASCII only');
  assert.ok(!MIG.split('\n').some((l) => /^\s*--/.test(l) && /['";]/.test(l)), 'editor-safe: no apostrophe, quote or semicolon in a comment line');
  assert.doesNotMatch(code(MIG), /\bdrop\s+(table|function|column|index|view)\b|\bdelete\s+from\b|\btruncate\b/i);
  // the only "drop" statements: re-run guards for this migration's own trigger + two storage policies
  for (const m of code(MIG).matchAll(/\bdrop\s+(\w+)\s+if\s+exists\s+(\w+)/gi)) assert.ok(/^(trigger|policy)$/i.test(m[1]) && /(a374_insert_only|_0374)$/.test(m[2]), m[0]);
  assert.doesNotMatch(code(MIG), /\bupdate\s+public\.(event_refunds|quotes|quote_payments|vendor_bills|vendor_payouts|inventory_reservations|inventory_stock_events|inventory_settings|event_stock_windows)\b/i,
    'never updates money rows, events, reservations or its own history');
  assert.match(MIG, /add column if not exists item_kind text not null default 'reusable'/);
  assert.match(MIG, /add column if not exists qty_used numeric not null default 0/);
});

await t('0374: three insert-only tables (RLS on, no app grants, UPDATE refused, DELETE only for the purge marks)', () => {
  for (const tb of ['inventory_stock_events', 'inventory_settings', 'event_stock_windows']) assert.match(MIG, new RegExp('create table if not exists public\\.' + tb + ' \\('));
  assert.match(MIG, /'inventory_stock_events', 'inventory_settings', 'event_stock_windows'\] loop\s+execute format\('alter table public\.%I enable row level security'/);
  assert.match(MIG, /_r374_tg_insert_only\(\)[\s\S]{0,300}tg_op = 'DELETE' and public\._r55_purge_allowed\(old\.org_id\)/);
  assert.match(MIG, /before update or delete on public\.%I for each row execute function public\._r374_tg_insert_only\(\)/);
  assert.match(MIG, /tg_studio_read_only/); assert.match(MIG, /tg_quote_org_match/);
});

await t('0374: SECURITY DEFINER everywhere with search_path = \'\' and an org check', () => {
  const fns = [...MIG.matchAll(/create or replace function (public\.\w+)\(([\s\S]*?)\$\$;/g)];
  assert.ok(fns.length >= 25, 'functions found: ' + fns.length);
  for (const f of fns) {
    if (/_r374_tg_insert_only/.test(f[1])) continue;   // trigger runs as the caller on purpose (0296 rule)
    assert.match(f[0], /security definer set search_path = ''/, f[1] + ' definer + empty search_path');
  }
  for (const fn of ['stock_found', 'stock_repair', 'stock_add_photo', 'stock_story', 'stock_overlaps', 'stock_windows', 'event_stock_window_set', 'inventory_settings_get', 'inventory_settings_set', '_r374_checkin', '_r374_decide']) {
    const b = MIG.slice(MIG.indexOf('function public.' + fn + '('), MIG.indexOf('end $$;', MIG.indexOf('function public.' + fn + '(')));
    assert.match(b, /current_org_id\(\)|_r374_lock\(/, fn + ' scoped to the studio');
  }
});

await t('0374: money only with Finance - decision / repair cost need Finance edit, amounts only with Finance view', () => {
  const dec = MIG.slice(MIG.indexOf('create or replace function public._r374_decide('), MIG.indexOf('create or replace function public.stock_damage_decision('));
  assert.match(dec, /has_area\('finance', 'edit'\)[\s\S]{0,200}hint = 'finance_only'/);
  assert.match(MIG, /coalesce\(p_cost, 0\) > 0 and not coalesce\(public\.has_area\('finance', 'edit'\), false\)/);
  assert.match(MIG, /'charge_amount', case when v_money and d\.kind = 'charge_client' then d\.amount end/);
  assert.match(MIG, /'amount', case when v_money then e\.amount end/);
  // a charge is ONE pending recovery (the existing Settlement path), credited in the P&L only once processed
  assert.match(MIG, /insert into public\.event_refunds \(quote_id, kind, amount, reason, status, note, created_by, org_id\)\s+values \(v_c\.quote_id, 'recovery'/);
  assert.match(MIG, /'pending'/);
  assert.match(MIG, /kind = 'charge_client' and r\.status = 'processed'\) as back_paid/);
  // item costs: Finance view, or stock staff only when the studio allows it
  assert.match(MIG, /_r374_can_cost[\s\S]{0,300}has_area\('finance', 'view'\)[\s\S]{0,200}'stock_costs'/);
  assert.match(MIG, /grant select \(item_kind, reorder_level\) on public\.inventory_items to authenticated/);
});

await t('0374: wraps kept once (rename only when no __pre0374), markers of the kept bodies named', () => {
  for (const f of ['_r21_cost_lines', 'public_portal_extras', 'worker_checkin_equipment', 'inventory_costs'])
    assert.match(MIG, new RegExp("to_regprocedure\\('public\\." + f + "__pre0374\\([^)]*\\)'\\) is null then\\s+alter function public\\." + f + "\\("));
  for (const m of ['r21-money-0246', 'r22-money-0252', 'r23-crew-0265', 'r58-inventory-cost-0299']) assert.ok(MIG.includes(m), m);
  // the ledger: an event with no R191 rows gets the kept answer unchanged
  assert.match(MIG, /if not exists \(select 1 from public\.inventory_stock_events e where e\.quote_id = p_quote[\s\S]{0,300}return v_lines;/);
});

await t('0374: defaults - photo proof on, client portal off, 0 buffer days, stock staff see no costs', () => {
  assert.match(MIG, /jsonb_build_object\('photo_proof', true, 'portal_damage', false, 'buffer_days', 0, 'stock_costs', false/);
  assert.match(MIG, /photo_proof\s+boolean not null default true/); assert.match(MIG, /portal_damage boolean not null default false/);
  assert.match(MIG, /check \(buffer_days between 0 and 14\)/);
});

await t('APPLY-0374: paste-safe - begin, the migration unchanged, the verify block, commit; no temp tables / session state', () => {
  const lines = APPLY.split('\n');
  assert.ok(lines[0].startsWith('-- APPLY-0374') && lines[1].startsWith('-- ') && lines[2] === 'begin;');
  assert.equal(APPLY.trimEnd().split('\n').slice(-1)[0], 'commit;');
  assert.ok(APPLY.includes(MIG), 'contains the migration byte for byte');
  assert.doesNotMatch(code(APPLY), /\btemp(orary)?\s+table\b|\bset_config\b|^\s*set\s+(local\s+)?(search_path|role|session|client_min_messages|statement_timeout|lock_timeout)\b|^\\/im);
  const ver = MIG.slice(MIG.lastIndexOf('select item, ok from (values'));
  assert.ok(ver.trim().endsWith(') v(item, ok) order by item;'), 'final verify block');
  assert.ok((ver.match(/^\s+\('\d\d /gm) || []).length >= 8);
});

await t('release lists: MANIFEST after 0369, run-all suite, trial purge suite, one-line prod-check override', () => {
  assert.ok(MF.indexOf('0374_r191_inventory_upgrade.sql') > MF.indexOf('0369_r186_special_escalation.sql'));
  assert.match(RUNALL, /run "r191-inventory-0374" "R191-INVENTORY-0374: ALL PASS \\\(53\/53\\\)" psql -q -f tests\/db\/r191-inventory-0374\.sql/);
  assert.ok(RET.includes('\\ir ../../supabase/migrations/0374_r191_inventory_upgrade.sql'));
  assert.ok(DBT.includes('\\ir ../../supabase/migrations/0374_r191_inventory_upgrade.sql'));
  const line = OVR.split('\n').find((l) => l.trim().startsWith('"0374"'));
  assert.ok(line && JSON.parse('{' + line.trim().replace(/,$/, '') + '}')['0374'].add.length === 4, 'one line, four markers');
  assert.ok(PKG.includes('node test/r191-inventory-upgrade.test.mjs'));
});

await t('Mark back plan (pure): reusable / part-return / consumable / photo rule', () => {
  let p = SC.plan({ out: 10, prior: 0, ok: 7, damaged: 1, photoProof: true });
  assert.deepEqual([p.miss, p.dmg, p.used, p.part, p.photoNeeded], [2, 1, 0, false, true]);
  p = SC.plan({ out: 30, prior: 0, ok: 20, damaged: 0, restOut: true, photoProof: true });
  assert.deepEqual([p.part, p.stillOut, p.miss, p.photoNeeded], [true, 10, 0, false]);
  p = SC.plan({ out: 30, prior: 20, ok: 5, damaged: 2, photoProof: true });   // after a part-return: 10 left
  assert.deepEqual([p.left, p.miss, p.dmg], [10, 3, 2]);
  assert.match(SC.plan({ out: 30, prior: 20, ok: 11 }).error, /Only 10 still out/);
  p = SC.plan({ out: 50, ok: 15, consumable: true, photoProof: true });
  assert.deepEqual([p.used, p.miss, p.photoNeeded], [35, 0, false]);
  assert.match(SC.plan({ out: 5, ok: 0, restOut: true }).error, /Count what came back now/);
  assert.equal(SC.plan({ out: 5, ok: 2, damaged: 1, photoProof: false }).photoNeeded, false);
  assert.match(SC.plan({ out: 5, ok: '1.5' }).error, /whole numbers/);
});

await t('line chips (pure): found / repair / photo / decision; an amount only with Finance view', () => {
  const line = { found: 2, in_repair: 1, repaired: 1, photo_needed: true, decision: 'charge_client', charge_status: 'pending', charge_amount: 2400 };
  const txt = (ctx) => SC.badges(line, ctx).map((b) => b.text).join(' | ');
  assert.match(txt({}), /2 found later \| 1 in repair \| 1 repaired \| Photo needed \| Charged to client - to collect/);
  assert.doesNotMatch(txt({ can_money: false, money: (v) => 'Rs ' + v }), /2400/);
  assert.match(txt({ can_money: true, money: (v) => 'Rs ' + v }), /Charged to client Rs 2400 - to collect/);
  assert.match(SC.badges({ decision: 'charge_client', charge_status: 'processed' }).map((b) => b.text).join(), /paid/);
});

await t('stock-flow (pure): consumables show left over + used; a part-return shows what is back while Out', () => {
  assert.deepEqual(SF.coParts({ status: 'returned', qty_out: 50, qty_in: 50, qty_used: 35, qty_damaged: 0 }), { out: 0, back: 15, missing: 0, damaged: 0, used: 35, cancelled: false });
  assert.equal(SF.coSummary({ status: 'returned', qty_out: 50, qty_in: 50, qty_used: 35 }), 'Left over 15 · Used 35');
  const p = SF.coParts({ status: 'out', qty_out: 30, qty_in: 20, qty_damaged: 0 });
  assert.deepEqual([p.out, p.back], [10, 20]);
  assert.equal(SF.coSummary({ status: 'partial', qty_out: 10, qty_in: 8, qty_damaged: 1 }), 'Back 7 · Damaged 1 · Missing 2');   // old rows unchanged
});

await t('store-api: v2 check-in + stock calls + the item columns with an older-database fallback', () => {
  assert.match(API, /async backV2\(id, o\)[\s\S]{0,700}rpc\("checkin_stock_v2"[\s\S]{0,500}if \(!rpcMissing\(e\) \|\| o\.restOut \|\| o\.decision\) throw e;/);
  for (const fn of ['inventory_settings_get', 'inventory_settings_set', 'stock_story', 'stock_found', 'stock_repair', 'stock_damage_decision', 'stock_add_photo', 'stock_windows', 'event_stock_window_set', 'stock_overlaps'])
    assert.ok(API.includes('"' + fn + '"'), fn);
  assert.match(API, /INV_COLS_R191 = INV_COLS \+ ",item_kind,reorder_level"/);
  assert.match(API, /invColsR191 = false; rows = await read\(\);/);
  // photos: re-encoded (EXIF / GPS stripped), private bucket, the stock folder
  assert.match(API, /uploadStockPhoto\(quoteId, file\)[\s\S]{0,300}ugPrepareImage\(file,[\s\S]{0,500}"\/stock\/" \+ name[\s\S]{0,200}from\("event-docs"\)\.upload\(path, img\.blob, \{ upsert: false/);
});

await t('store-api: free stock counts stock still out from a finished event on every date, and the stock window', () => {
  assert.match(API, /const over = !!\(today && to < today\);/);
  assert.match(API, /if \(over && x\.out > 0\) \{ always\[x\.it\] = \(always\[x\.it\] \|\| 0\) \+ x\.out;/);
  assert.match(API, /const base = \(d\.undated\[i\.id\] \|\| 0\) \+ \(\(d\.always && d\.always\[i\.id\]\) \|\| 0\);/);
  assert.match(API, /inventory\.stock\.windows\(live\.slice\(i, i \+ 1000\)\)/);
});

await t('Inventory page: costs only when allowed (never sent otherwise), item type + reorder, follow-up, stock dates, settings', () => {
  assert.match(INV, /if\(canCost\) rec\.unit_cost=cr\.value; else if\(!editingId\) rec\.unit_cost=0;/);
  assert.match(INV, /\$\("#i_cost_fld"\)\.hidden=!canCost;/);
  assert.match(INV, /id="i_kind"[\s\S]{0,200}value="consumable"/); assert.ok(INV.includes('id="i_reorder"'));
  assert.match(INV, /SC\.lineActions\(td,\{/); assert.match(INV, /SC\.open\(\{ checkout:c, item:it, quoteId:c\.quote_id, ctx:invCtx, onDone:load \}\)/);
  for (const id of ['stockDates', 'sd_from', 'sd_to', 'sd_save', 'stockSettings', 'ss_photo', 'ss_portal', 'ss_costs', 'ss_buffer']) assert.ok(INV.includes('id="' + id + '"'), id);
  assert.ok(INV.includes('<script src="stock-checkin.js?v=1"></script>') && TD.includes('<script src="stock-checkin.js?v=1"></script>'));
  assert.match(TD, /HelmStockCheckin\.open\(\{ checkout:c, item:itemsById\[c\.item_id\]\|\|\{\}, quoteId:id, ctx:tdCtx, onDone:re \}\)/);
});

await t('stock-checkin.js builds its dialog with DOM calls only (no HTML strings)', () => {
  assert.doesNotMatch(SCJ.replace(/\/\*[\s\S]*?\*\//g, ''), /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(SCJ, /capture: "environment"/);
});

await t('client portal: damage charges with textContent only, shown only when the server sends them', () => {
  assert.ok(PORTAL.includes('id="damageCard" hidden'));
  const seg = PORTAL.slice(PORTAL.indexOf('R191 (0374): damage'), PORTAL.indexOf('const c=x.contact'));
  assert.doesNotMatch(seg, /innerHTML/); assert.match(seg, /Array\.isArray\(x\.damage_charges\)/);
});

await t('page tours: the new parts of Inventory + Teardown are explained', () => {
  assert.match(TOURS, /sel: "#stockDates", title: "Stock dates"/);
  assert.match(TOURS, /sel: "#stockSettings", title: "Stock settings"/);
  assert.match(TOURS, /Some are still out/);
});

console.log(`\nr191-inventory-upgrade: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
