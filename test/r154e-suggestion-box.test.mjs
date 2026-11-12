// r154e-suggestion-box.test.mjs - R154e Suggestion box v2 (migration 0351), static checks.
// Behaviour of the database side: tests/db/r154e-suggestion-box-0351.sql (local disposable PG).
//  * the "?" help menu has Suggest an idea + My suggestions (every page with the app shell), the profile menu too
//  * suggest.js builds the dialog with createElement + textContent only (Trusted Types), validates with the shared
//    HelmValidate text rule, 2000 characters, kind Idea / Problem / Other, page I was on, share with studio
//  * BPStore.suggestions calls the 0351 functions, falls back to the 0271 route on a database without 0351
//  * HQ: New / Planned / Done / Not now, kind + text filters, +1 column, reply box (hq_reply_suggestion)
//  * migration + paste file: additive, editor-safe comments, begin / commit, VERIFY grid, MANIFEST entry, tours
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const ROOT = new URL('..', import.meta.url);
const r = (p) => readFileSync(new URL(p, ROOT), 'utf8');
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };

const sb = r('public/shell-b.js'), sj = r('public/suggest.js'), api = r('public/store-api.js'), au = r('public/auth-ui.js');
const hq = r('public/hq.js'), hqh = r('public/hq.html'), mig = r('supabase/migrations/0351_r154e_suggestion_box.sql');
const app = r('supabase/APPLY-0351.sql'), man = r('supabase/migrations/MANIFEST'), css = r('public/suggest.css');

t('help (?) menu: Suggest an idea + My suggestions, reply count asked on open only, suggest.js loaded on first use', () => {
  assert.match(sb, /ideaMi\.id = "hbSuggest"/);
  assert.match(sb, /mineMi\.id = "hbMySuggest"/);
  assert.match(sb, /"Suggest an idea"/);
  assert.match(sb, /"My suggestions"/);
  assert.match(sb, /function mis\(\) \{ return \[tourMi, keysMi, ideaMi, mineMi\]; \}/);
  assert.match(sb, /function open\(idx\) \{[\s\S]{0,300}replies\(\);/);
  assert.match(sb, /sc\.src = "\/suggest\.js\?v=\d+"/);
  assert.match(sb, /HelmSuggest\.open\(\{ view: view \}\)/);
  assert.match(r('public/shell-b.css'), /\.hb-msep \{/);
});
t('profile menu keeps Send a suggestion and adds My suggestions', () => {
  assert.ok(au.includes('{ id: "suggest", label: "Send a suggestion" }'));
  assert.ok(au.includes('{ id: "suggest_mine", label: "My suggestions" }'));
  assert.match(au, /id === "suggest" \|\| id === "suggest_mine"/);
});
t('suggest.js: no HTML sinks, textContent only, three tabs, shared validator, 2000 max, share + page', () => {
  assert.doesNotMatch(sj, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(sj, /\["send", "Suggest an idea"\], \["mine", "My suggestions"\], \["studio", "From my studio"\]/);
  assert.match(sj, /HV\.rules\.text\(v, \{ label: "your suggestion", required: true, max: MAX \}\)/);
  assert.match(sj, /var MAX = 2000;/);
  assert.match(sj, /"\/form-validate\.js\?v=\d+"/);
  assert.match(sj, /\["idea", "Idea"\], \["problem", "Problem"\], \["other", "Other"\]/);
  assert.match(sj, /Include the page I was on/);
  assert.match(sj, /st\.submit\(Object\.assign\(\{ share: shBox\.checked \}, body\)\)/);
  assert.match(sj, /not_now: \["Not now"/);
  assert.match(sj, /st\.vote\(x\.id, !x\.voted\)/);
  assert.match(sj, /st\.seen\(\)/);
  assert.match(sj, /window\.HelmSuggest = \{ open: openDialog, close: close \}/);
  assert.match(sj, /"\/suggest\.css\?v=\d+"/);
  assert.match(css, /\.sgd-tab\[aria-selected="true"\]/);
});
t('BPStore.suggestions: the 0351 functions, 0271 fallback when the database has no 0351', () => {
  for (const fn of ['suggestion_submit', 'my_suggestions', 'my_suggestion_unread', 'suggestion_replies_seen', 'suggestion_vote', 'suggestion_share'])
    assert.ok(api.includes(`rpc("${fn}"`), fn);
  assert.match(api, /if \(rpcMissing\(e\)\) \{ const q = Object\.assign\(\{\}, p \|\| \{\}\); delete q\.share; return rpc\("submit_suggestion"/);
});
t('HQ: four statuses, filters, +1 column, in-app reply via hq_reply_suggestion', () => {
  assert.match(hq, /var SG_STATUS = \{ new: \["New", "warn"\], planned: \["Planned", ""\], done: \["Done", "ok"\], not_now: \["Not now", "bad"\] \};/);
  assert.match(hq, /call\("hq_reply_suggestion", \{ p_id: x\.id, p_reply: v, p_status: st\.value \|\| null \}\)/);
  assert.match(hq, /on\("#fSgKind", "change", paintSuggestions\)/);
  assert.match(hq, /on\("#fSgQ", "input", paintSuggestions\)/);
  assert.ok(hqh.includes('<option value="not_now">Not now</option>') && hqh.includes('id="fSgKind"') && hqh.includes('id="fSgQ"'));
  assert.ok(hqh.includes('<th>+1</th><th>Status</th>'));
});
t('0351: additive (no drop table / column, no delete), RLS on the vote table, editor-safe comments, ASCII', () => {
  assert.doesNotMatch(mig, /drop\s+table|drop\s+column|truncate|^\s*delete\s+from/im);
  assert.match(mig, /alter table public\.suggestion_votes enable row level security/);
  assert.match(mig, /create trigger zz_r351_suggestion_guard before insert on public\.suggestions/);
  assert.match(mig, /'new', ''reviewed'', ''planned'', ''done'', ''not_now''|''new'', ''reviewed'', ''planned'', ''done'', ''not_now''/);
  for (const [i, line] of app.split('\n').entries()) {
    assert.ok(/^[\x00-\x7f]*$/.test(line), 'ASCII line ' + (i + 1));
    const c = line.indexOf('--');
    if (c >= 0 && !/'[^']*--/.test(line.slice(0, c + 2))) assert.doesNotMatch(line.slice(c), /['";]/, 'comment quote / semicolon on line ' + (i + 1));
  }
  assert.equal((app.match(/^begin;$/gm) || []).length, 1);
  assert.equal((app.match(/^commit;$/gm) || []).length, 1);
  assert.match(app, /-- VERIFY every line should say true\nselect item, ok from \(values/);
  assert.ok(app.includes(mig.replace(/\s*$/, '\n')), 'APPLY-0351 carries the migration verbatim');
  assert.doesNotMatch(app, /^\\|create temp/im);
});
t('MANIFEST + release lists + page tours', () => {
  assert.match(man, /^forward  supabase\/migrations\/0351_r154e_suggestion_box\.sql$/m);
  assert.ok(r('test/release-1019.test.mjs').includes("'0344', '0351']"));
  assert.ok(r('test/release-1020.test.mjs').includes("'0344', '0351']"));
  assert.match(r('public/page-tours.js'), /sel: "#tab-requests"[^\n]*mark New \/ Planned \/ Done \/ Not now and write a reply the sender reads under My suggestions/);
  assert.match(sb, /sel: "\[data-tour='tour-top'\]", title: "Help and ideas"/);
  assert.match(r('scripts/db-test/run-all.sh'), /R154E-SUGGESTION-BOX-0351: ALL PASS/);
});
console.log(`r154e-suggestion-box: ${n} passed`);
