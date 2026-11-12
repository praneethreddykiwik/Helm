// r156-wa-templates.test.mjs - R156: WhatsApp template improvements. (a) the 5 templates Meta refused are reworded (A3,
// same names + same blanks, senders unchanged) and EVERY template passes a static wording check; Meta's real reason is kept
// per template and shown in plain words (no "try again later"); the approval-code template says verify your business.
// (a2) Meta Template Library versions where one fits, Helm's wording otherwise, senders fill either. (b) background setup
// (0354 + wa-template-worker), (c) status sync + category change, (f) number health. Static + pure logic + a small fake-DOM
// run of the card. SQL behaviour: tests/db/r156-wa-template-jobs-0354.sql; edge: tests/edge/wa-template-worker.test.ts +
// tests/edge/wa-connect.test.ts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const ROOT = new URL('..', import.meta.url);
const r = (p) => readFileSync(new URL(p, ROOT), 'utf8');
const require = createRequire(import.meta.url);
let n = 0;
const t = async (name, fn) => { try { await fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exit(1); } };
const W = await import('../supabase/functions/_shared/wa-studio.mjs');
const P = await import('../supabase/functions/wa-proposal/logic.mjs');
const cat = Object.fromEntries(W.templateCatalogue('https://www.helm.events').map((x) => [x.name, x]));
const body = (name) => cat[name].components.find((c) => c.type === 'BODY').text;

await t('(a) the 5 refused templates carry the approved A3 wording, same names, same blanks', () => {
  const A3 = {
    staff_shift_result: 'Hi {{1}}, here is the update on your request for the {{2}} shift at {{3}} on {{4}}. The office has marked your request as {{5}}. You can see the full details on your staff link here: {{6}} Thank you for your help.',
    vendor_request: 'Hello {{1}}, this is {{2}}. We would like to book you for {{3}} at the {{4}} event on {{5}} at {{6}}. The venue is {{7}} and the amount offered is {{8}}. Please tell us if you can take this booking by {{9}} using this secure link: {{10}} Thank you, we look forward to working with you.',
    vendor_delivery_reminder: 'Hello {{1}}, this is a reminder about your booking for {{2}} at the {{3}} event. Please deliver on {{4}} by {{5}} at this venue: {{6}}. You can see the full booking details and contact the studio using this link: {{7}} Thank you for your support.',
    vendor_invoice_update: 'Hello {{1}}, there is an update on your invoice {{2}} for the amount of {{3}}. The studio has marked this invoice as {{4}}. A note from the studio: {{5}}. You can see the full details using this link: {{6}} Thank you.',
    crew_runsheet_reminder: 'Hi {{1}}, this is a reminder from the event run sheet. At {{2}} during {{3}}, the next item is {{4}}. Please be ready at your position a few minutes early. You can open your run sheet here: {{5}} Thank you.',
  };
  for (const [name, text] of Object.entries(A3)) {
    assert.equal(body(name), text, name);
    assert.equal(W.wordStats(text).vars, W.FIELDS[name].length, name + ': same number of blanks as the sender fills');
  }
});

await t('(a) wording check over ALL templates: >= 4.5 fixed words per blank, no blank first / last / next to another, limits', () => {
  assert.equal(W.templateCatalogue().length, 21);
  assert.deepEqual(W.lintCatalogue('https://www.helm.events'), []);
  for (const tpl of W.templateCatalogue()) {
    if (tpl.category === 'AUTHENTICATION') continue;
    const s = W.wordStats(body(tpl.name));
    assert.ok(s.ratio >= 4.5, tpl.name + ' ratio ' + s.ratio.toFixed(2));
  }
  // the old wording that Meta refused fails the check (so a regression is caught before Meta sees it)
  const old = { name: 'x', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hello {{1}}, reminder: {{2}} for {{3}} on {{4}} at {{5}}, {{6}}. Details: {{7}} Thank you.', example: { body_text: [['a', 'b', 'c', 'd', 'e', 'f', 'g']] } }] };
  assert.ok(W.lintTemplate(old).some((p) => /too few fixed words/.test(p)));
  assert.ok(W.lintTemplate(old).some((p) => /next to each other/.test(p)));
  const mk = (text, ex) => ({ name: 'y', category: 'UTILITY', components: [{ type: 'BODY', text, example: { body_text: [ex] } }] });
  assert.ok(W.lintTemplate(mk('{{1}} is here with a long enough sentence of many words for the check', ['a'])).some((p) => /starts with a variable/.test(p)));
  assert.ok(W.lintTemplate(mk('A long enough sentence of many words for the check ends here {{1}}.', ['a'])).some((p) => /ends with a variable/.test(p)));
  assert.ok(W.lintTemplate(mk('Hi ' + 'word '.repeat(220) + '{{1}} done.', ['a'])).some((p) => /longer than 1024/.test(p)));
  assert.ok(W.lintTemplate(mk('Hi {{2}} and then many more words here so the ratio is fine {{1}} ok.', ['a', 'b'])).some((p) => /in order/.test(p)));
  assert.ok(W.lintTemplate(mk('Hi {{1}} and then many more words here so the ratio is fine.', ['a\nb'])).some((p) => /new line/.test(p)));
  assert.ok(W.lintTemplate(mk('Hi {{1}} and then many more words here so the ratio is fine.', [])).some((p) => /examples must match/.test(p)));
});

await t('(a) Meta errors: wording refusals are NOT "wrong ID"; templateError decides failed / retry / pause; the approval code', () => {
  assert.equal(W.graphError(400, { error: { code: 100, error_subcode: 2388293 } }).kind, 'content');
  assert.equal(W.graphError(400, { error: { code: 100, error_subcode: 33 } }).kind, 'number');
  const te = (s, b, c) => W.templateError(s, b, c);
  assert.deepEqual([te(400, { error: { code: 100, error_subcode: 2388293 } }).reason, te(400, { error: { code: 100, error_subcode: 2388293 } }).next], ['ratio', 'failed']);
  assert.equal(te(400, { error: { code: 100, error_subcode: 2388299 } }).reason, 'edge_variable');
  assert.equal(te(400, { error: { code: 100, error_subcode: 2388040 } }).reason, 'too_long');
  assert.equal(te(400, { error: { code: 100, error_subcode: 2388024 } }).next, 'exists');
  assert.equal(te(400, { error: { code: 80008 } }).next, 'pause');
  assert.equal(te(429, {}).next, 'pause');
  assert.equal(te(500, { error: { code: 2 } }).next, 'retry');
  assert.equal(te(401, { error: { code: 190 } }).reason, 'token');
  assert.deepEqual([te(400, { error: { code: 200, message: 'This WhatsApp business account does not have permission to create message template' } }, 'AUTHENTICATION').reason,
    te(400, { error: { code: 200 } }, 'AUTHENTICATION').next], ['auth_not_eligible', 'failed']);
  assert.equal(te(400, { error: { code: 200 } }, 'UTILITY').reason, 'permission');
  const e = W.safeMetaError(400, { error: { code: 100, error_subcode: 2388293, error_user_title: 'Too many\nvariables', error_user_msg: 'see https://x.y/z?access_token=abc and EAAGabcdefghijklmnopqrstuvwxyz0123456789 <b>' } }, 'ratio');
  assert.deepEqual([e.reason, e.code, e.subcode, e.status, e.title], ['ratio', 100, 2388293, 400, 'Too many variables']);
  assert.ok(!/https?:|EAAG|<b>/.test(e.message) && /\[link\]/.test(e.message) && /\[hidden\]/.test(e.message), e.message);
  assert.match(W.REASON_TEXT.auth_not_eligible, /^Verify your business in Meta Business Manager - approval codes go by e-mail meanwhile\.$/);
});

await t('(c) the template list keeps only Helm templates in "en", with status / category / reason / quality / id', () => {
  const d = W.templateDetails([{ name: 'proposal_sent', language: 'en', status: 'approved', category: 'UTILITY', quality_score: { score: 'GREEN' }, id: '123' },
    { name: 'proposal_sent', language: 'en_US', status: 'APPROVED' }, { name: 'other', language: 'en', status: 'APPROVED' },
    { name: 'vendor_request', language: 'en', status: 'REJECTED', rejected_reason: 'INVALID_FORMAT', id: 'x<' }]);
  assert.deepEqual(d, [{ name: 'proposal_sent', language: 'en', status: 'APPROVED', category: 'UTILITY', quality_score: 'GREEN', rejected_reason: null, id: '123' },
    { name: 'vendor_request', language: 'en', status: 'REJECTED', category: null, quality_score: null, rejected_reason: 'INVALID_FORMAT', id: null }]);
  assert.equal(W.TEMPLATE_FIELDS, 'name,status,language,category,rejected_reason,quality_score,id');
});

await t('(a2) Template Library: an entry is used only when every blank maps to a Helm field; the create body; the sender', () => {
  assert.deepEqual(Object.keys(W.LIBRARY).sort(), ['payment_received', 'proposal_approval_otp', 'proposal_approved_pay']);
  assert.match(W.libraryQuery('payment_received'), /^message_template_library\?topic=PAYMENTS&usecase=PAYMENT_CONFIRMATION&limit=25$/);
  assert.equal(W.libraryQuery('vendor_request'), null, 'no library for the vendor / crew / proposal ones');
  const fit = W.libraryFit('payment_received', { name: 'payment_confirmation_3', category: 'UTILITY', body: 'Hi {{1}}, your payment of {{2}} was received on {{3}}.', body_param_types: ['TEXT', 'AMOUNT', 'DATE'], buttons: [{ type: 'URL' }] });
  assert.deepEqual(fit, { library_name: 'payment_confirmation_3', fields: ['name', 'amount', 'date'], url_button: true });
  assert.equal(W.libraryFit('payment_received', { name: 'x_1', body: 'Your {{1}} for {{2}} is ready.', body_param_types: ['TEXT', 'TEXT'] }), null, 'unknown blanks');
  assert.equal(W.libraryFit('payment_received', { name: 'x_2', body: 'Hi {{1}}, thanks.', body_param_types: ['TEXT'] }), null, 'no amount');
  assert.equal(W.libraryFit('payment_received', { name: 'x_3', body: 'Hi {{1}}, payment of {{2}}.', body_param_types: ['TEXT', 'AMOUNT'], buttons: [{ type: 'PHONE_NUMBER' }] }), null, 'a phone button Helm cannot fill');
  assert.equal(W.libraryFit('payment_received', { name: 'x_4', category: 'MARKETING', body: 'Hi {{1}}, payment of {{2}}.', body_param_types: ['TEXT', 'AMOUNT'] }), null);
  const b = W.libraryCreateBody('payment_received', fit, 'https://www.helm.events');
  assert.deepEqual(b, { name: 'payment_received', language: 'en', category: 'UTILITY', library_template_name: 'payment_confirmation_3',
    library_template_button_inputs: [{ type: 'URL', url: { base_url: 'https://www.helm.events/portal.html?token={{1}}', url_suffix_example: 'https://www.helm.events/portal.html?token=' + W.SAMPLE_TOKEN } }] });
  const otp = W.libraryCreateBody('proposal_approval_otp', W.libraryFit('proposal_approval_otp', { name: 'verify_code_1', category: 'AUTHENTICATION', buttons: [{ type: 'OTP' }] }));
  assert.deepEqual([otp.category, otp.library_template_body_inputs, otp.library_template_button_inputs], ['AUTHENTICATION', { add_security_recommendation: true, code_expiration_minutes: 10 }, [{ type: 'OTP', otp_type: 'COPY_CODE' }]]);
  // the sender: library version -> its blank order, no button when the entry has none; own / unknown -> Helm order
  const vars = { client_name: 'Priya', studio_name: 'Aurora', event_type: 'Wedding', event_date: '12 Dec 2026', total: 'INR 2,36,000' };
  const tok = '11111111-1111-4111-8111-111111111111';
  const lib = P.templateMessage('919000000000', 'payment_received', vars, tok, 'en', { variant: 'library', param_map: { fields: ['amount', 'name'], url_button: false } });
  assert.deepEqual(lib.template.components, [{ type: 'body', parameters: [{ type: 'text', text: 'INR 2,36,000' }, { type: 'text', text: 'Priya' }] }]);
  const libBtn = P.templateMessage('919000000000', 'payment_received', vars, tok, 'en', { variant: 'library', param_map: { fields: ['name', 'amount'], url_button: true } });
  assert.equal(libBtn.template.components[1].parameters[0].text, tok);
  const own = P.templateMessage('919000000000', 'payment_received', vars, tok, 'en', { variant: 'own' });
  assert.deepEqual(own, P.templateMessage('919000000000', 'payment_received', vars, tok, 'en'));
  assert.deepEqual(own.template.components[0].parameters.map((x) => x.text), ['Priya', 'Aurora', 'Wedding']);
  assert.equal(W.libraryParams({ variant: 'library', param_map: { fields: ['code'] } }, {}), null, 'the code template is never filled from here');
  assert.equal(W.libraryParams({ variant: 'library', param_map: { fields: ['x;drop'] } }, {}), null);
});

await t('(f) number health -> warnings (quality, low limit, payment, blocked)', () => {
  const h = W.healthOf({ quality_rating: 'YELLOW', name_status: 'APPROVED' }, { messaging_limit_tier: 'TIER_250' },
    { health_status: { can_send_message: 'LIMITED', entities: [{ entity_type: 'WABA', errors: [{ error_code: 141006, error_description: 'No payment method https://x' }] }] } });
  assert.deepEqual([h.quality, h.tier, h.can_send, h.payment_issue, h.limit_low], ['YELLOW', 'TIER_250', 'LIMITED', true, true]);
  assert.deepEqual(h.warnings, ['quality_yellow', 'payment', 'limit_low']);
  assert.ok(!/https?:/.test(h.errors[0]));
  assert.deepEqual(W.healthOf({ quality_rating: 'GREEN' }, { messaging_limit_tier: 'TIER_10K' }, null).warnings, []);
});

await t('0354: MANIFEST once after 0353, additive (no drop / truncate / delete), grants, cron guarded; APPLY verbatim + VERIFY; editor-safe', () => {
  const M = r('supabase/migrations/0354_r156_wa_template_jobs.sql'), A = r('supabase/APPLY-0354.sql'), mf = r('supabase/migrations/MANIFEST');
  const line = 'forward  supabase/migrations/0354_r156_wa_template_jobs.sql';
  assert.equal(mf.split('\n').filter((l) => l === line).length, 1);
  assert.ok(mf.indexOf('forward  supabase/migrations/0353_r154h_wa_details.sql') < mf.indexOf(line));
  assert.match(mf, /# 0354 \(R156[^\n]*Nothing dropped or deleted\. Safe to run twice\./);
  const code = M.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  assert.doesNotMatch(code, /\b(drop|truncate)\b/i); assert.doesNotMatch(code, /\bdelete\s+from\b/i);
  assert.match(code, /create table if not exists public\.wa_template_jobs/); assert.match(code, /constraint wa_template_jobs_uk354 unique \(org_id, name, language\)/);
  assert.match(code, /alter table public\.wa_template_jobs enable row level security/);
  assert.match(code, /for update skip locked/);
  assert.match(code, /100 - public\._r354_creates_last_hour\(p_org\)/);
  assert.match(code, /on conflict \(org_id, name, language\) do update[\s\S]{0,300}where j\.state not in \('queued', 'creating'\)/);
  assert.match(code, /if v_att >= 8 then/);
  assert.match(code, /execute 'grant select on table ' \|\| t \|\| ' to authenticated'/);
  assert.doesNotMatch(code, /grant (insert|update|delete|all)[^\n]*on table/i);
  assert.doesNotMatch(code, /grant [^\n]* to (anon|public)\b/i);
  assert.match(code, /alter function public\.%I\(%s\) rename to %I', f\.n, f\.a, f\.n \|\| '__pre0354'/);
  assert.match(code, /if v_ok then\n\s+if not exists \(select 1 from cron\.job where jobname = 'helm-wa-templates'\)/);
  assert.match(code, /'\*\/3 \* \* \* \*'/); assert.match(code, /'0 21 \* \* \*'/);
  assert.doesNotMatch(code, /decrypted_secret[^\n]*(raise|notice)/i, 'never prints a secret');
  assert.match(A, /^-- APPLY-0354 \(R156 [^\n]*\)\. Run on STAGING first, then production\. Safe to run twice\.\n/);
  assert.ok(A.includes('\nbegin;\n' + M.replace(/\s*$/, '\n') + '\ncommit;\n'));
  assert.equal((A.match(/^begin;$/gm) || []).length, 1); assert.equal((A.match(/^commit;$/gm) || []).length, 1);
  assert.match(A, /\ncommit;\n\n-- VERIFY every line should say true\nselect item, ok from \(values\n[\s\S]*\n\) v\(item, ok\) order by item;\n$/);
  assert.equal((A.match(/^  \('0\d /gm) || []).length, 9);
  for (const s of [M, A]) {
    assert.ok(/^[\x09\x0a\x20-\x7e]*$/.test(s), 'ASCII only');
    for (const l of s.split('\n')) {
      const c = l.indexOf('--'); if (c < 0) continue;
      if ((l.slice(0, c).match(/'/g) || []).length % 2) continue;
      assert.doesNotMatch(l.slice(c), /['";]/, 'comment with a quote or semicolon: ' + l);
    }
    assert.doesNotMatch(s, /^\s*\\/m); assert.doesNotMatch(s, /\bcreate\s+(temp|temporary)\s+table\b/i);
    assert.doesNotMatch(s, /^\s*(set|reset)\s+/im);
  }
  for (const f of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.match(r(f), /'0346', '0353', '0354'\]/, f);
  assert.match(r('scripts/db-test/run-all.sh'), /run "r156-wa-template-jobs-0354" "R156-WA-TEMPLATE-JOBS-0354: ALL PASS \\\(48\/48\\\)" psql -q -f tests\/db\/r156-wa-template-jobs-0354\.sql/);
  assert.match(r('supabase/check-prod-overrides.json'), /"0354": \{ "note": "WhatsApp template setup in the background[^\n]*"ignore": \["cron helm-wa-templates", "cron helm-wa-templates-nightly"\]/);
  assert.match(r('supabase/CHECK-PROD-MIGRATIONS.sql'), /\('0354_r156_wa_template_jobs', 'tbl', 'public\.wa_template_jobs', null, null\)/);
});

await t('worker + wa-connect: cron secret, no JWT at the gateway, idempotent, no token in answers / logs; senders use the variant', () => {
  const w = r('supabase/functions/wa-template-worker/index.ts'), c = r('supabase/functions/wa-connect/index.ts'), toml = r('supabase/config.toml');
  assert.match(toml, /\[functions\.wa-template-worker\][^\n]*\nverify_jwt = false/);
  assert.match(w, /secretMatches\(req\.headers\.get\("x-helm-cron-secret"\) \|\| "", env\("HELM_WA_TEMPLATE_SECRET"\) \|\| ""\)/);
  assert.match(w, /if \(ex && !isResubmit\) \{\n\s+await record\(j\.id, \{ outcome: "exists"/, 'a template already in the account is only recorded');
  assert.doesNotMatch(w, /json\(\{[^\n]*\btoken\b/); assert.doesNotMatch(w, /log\.(error|info|warn)\([^\n]*\btoken\b(?!s)/i);
  assert.match(c, /admin\.rpc\("wa_template_enqueue"/); assert.match(c, /background: true/);
  assert.doesNotMatch(r('public/wa-connect-ui.js'), /try again later/i);
  assert.match(r('supabase/functions/wa-proposal/index.ts'), /templateVariant\(admin, String\(\(q as \{ org_id\?: string \}\)\.org_id \|\| ""\), kind\)/);
  assert.match(r('public/store-api.js'), /waSetup: \(\) => \(supa \? rpc\("my_wa_template_setup", \{\}\)/);
  assert.match(r('public/store-api.js'), /waResubmit: \(name\) => /);
});

await t('page: plain reasons, background text, OTP verify text, health + category warnings; versions, guide, tour, docs', () => {
  const C = require('../public/wa-connect-ui.js');
  assert.equal(C.BG_TEXT, 'Setup is running in the background — you can leave this page; we\'ll notify you.');
  assert.equal(C.OTP_VERIFY, 'Verify your business in Meta Business Manager — approval codes go by e-mail meanwhile.');
  assert.equal(C.reasonOf('proposal_approval_otp', { state: 'failed', error: { reason: 'auth_not_eligible' } }), C.OTP_VERIFY);
  assert.match(C.reasonOf('vendor_request', { state: 'failed', error: { reason: 'ratio', code: 100, subcode: 2388293, title: 'Too many variables' } }), /too many blanks[\s\S]*Meta: Too many variables \(code 100\/2388293\)/);
  assert.match(C.reasonOf('x', { state: 'rejected', rejected_reason: 'INVALID_FORMAT' }), /^Rejected by Meta: the format is not allowed\. Press Fix and resubmit/);
  assert.match(C.reasonOf('x', { state: 'queued', error: { reason: 'rate_limit' } }), /^Will try again by itself\./);
  assert.equal(C.reasonOf('x', { state: 'approved' }), '');
  assert.equal(C.canResubmit({ state: 'rejected' }), true); assert.equal(C.canResubmit({ state: 'pending' }), false);
  assert.match(C.categoryNote('helm_notice', { prev_category: 'UTILITY', category: 'MARKETING' }), /from utility to marketing - marketing messages cost more/);
  assert.equal(C.progressLine({ jobs: [{ in_round: true, state: 'approved' }, { in_round: true, state: 'pending' }, { in_round: true, state: 'queued' }, { in_round: false, state: 'failed' }] }), '1 of 3 approved, 1 waiting for Meta, 1 being sent to Meta.');
  assert.equal(C.healthLines({ warnings: ['quality_red', 'payment', 'limit_low'], tier: 'TIER_250' }).length, 3);
  assert.match(C.setupResultText({ ok: true, background: true, queued: 20 }), /^20 template\(s\) queued\. Setup is running in the background/);
  assert.match(C.setupResultText({ ok: true, created: 19, failed: [{ name: 'proposal_approval_otp', reason: 'auth_not_eligible' }, 'vendor_request'] }), /2 not accepted by Meta: proposal_approval_otp \(Verify your business in Meta Business Manager/);
  const h = r('public/integrations.html');
  assert.match(h, /wa-connect-ui\.js\?v=4/); assert.match(h, /integrations\.css\?v=10/);
  assert.match(h, /Setup runs in the background – you can leave the page/);
  assert.match(r('public/page-tours.js'), /Template setup runs in the background - leave the page; a bell notice says when Meta is done/);
  assert.match(r('public/tour.js'), /const PT_V = "30";/);
  const d = r('docs/ops/WHATSAPP-SETUP.md');
  assert.match(d, /## R156 \(0354\)/); assert.match(d, /helm_wa_template_secret/); assert.match(d, /supabase functions deploy wa-template-worker --no-verify-jwt/);
});

// ---- a small fake DOM, enough for the card -------------------------------------------------------------------------------
class Node_ {
  constructor(tag) { this.tagName = String(tag || '#text').toUpperCase(); this.children = []; this.parentNode = null; this.attrs = {}; this.listeners = {}; this.hidden = false; this._text = ''; this.value = ''; this.disabled = false; this.open = false; }
  get firstChild() { return this.children[0] || null; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; } removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  fire(ev) { for (const fn of this.listeners[ev] || []) fn.call(this, { type: ev, target: this, preventDefault() {} }); }
  click() { if (!this.disabled) this.fire('click'); }
  focus() {}
  set textContent(v) { this.children = []; this._text = String(v); } get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  all() { return [this].concat(...this.children.map((c) => c.all())); }
  byId(id) { return this.all().find((x) => x.id === id) || null; }
}
globalThis.document = { createElement: (x) => new Node_(x), createTextNode: (s) => { const x = new Node_('#text'); x._text = String(s); return x; } };
globalThis.BPUI = { trackDirty() { return { mark() {}, clean() {}, isDirty() { return false; }, dispose() {} }; }, confirm: () => Promise.resolve(true) };
const timers = [];
globalThis.setTimeout = ((orig) => (fn, ms) => { if (ms === 20000) { timers.push(fn); return 0; } return orig(fn, ms); })(globalThis.setTimeout);
delete require.cache[require.resolve('../public/wa-connect-ui.js')];
const UI = require('../public/wa-connect-ui.js');
const settle = () => new Promise((res) => setImmediate(res));

await t('card: setup running -> background text + live progress + Fix and resubmit on a refused one; polls while it runs', async () => {
  const calls = [];
  let setup = { running: true, health: { warnings: ['quality_yellow'] }, jobs: [
    { name: 'vendor_request', state: 'failed', in_round: true, error: { reason: 'ratio', code: 100, subcode: 2388293 } },
    { name: 'proposal_approval_otp', state: 'failed', in_round: true, error: { reason: 'auth_not_eligible' } },
    { name: 'proposal_sent', state: 'pending', in_round: true }, { name: 'staff_task_assigned', state: 'queued', in_round: true }] };
  const I = {
    mine: async () => ({ is_admin: true, whatsapp: { status: 'connected', token_saved: true, waba_id: '1', phone_number_id: '2', templates: { proposal_sent: 'PENDING' } } }),
    waSetup: async () => { calls.push('setup'); return setup; },
    waResubmit: async (name) => { calls.push('resubmit:' + name); return { ok: true, background: true }; },
    waConnect: async (a) => { calls.push('connect:' + a); return { ok: true, background: true, queued: 19 }; },
  };
  const box = new Node_('div');
  await UI.mount(box, { store: { integrations: I } });
  assert.equal(box.byId('wacBg').textContent, UI.BG_TEXT);
  assert.match(box.byId('wacProgress').textContent, /^0 of 4 approved, 1 waiting for Meta, 1 being sent to Meta, 2 need attention\.$/);
  const txt = box.textContent;
  assert.match(txt, /Verify your business in Meta Business Manager — approval codes go by e-mail meanwhile\./);
  assert.match(txt, /too many blanks for its length/); assert.match(txt, /Quality rating is YELLOW/);
  assert.ok(box.byId('wacFix_vendor_request') && box.byId('wacFix_proposal_approval_otp'));
  assert.equal(box.byId('wacFix_proposal_sent'), null, 'nothing to resubmit on a waiting one');
  box.byId('wacFix_vendor_request').click(); for (let i = 0; i < 6; i++) await settle();
  assert.ok(calls.includes('resubmit:vendor_request'));
  assert.match(box.byId('wacMsg').textContent, /^vendor_request: resubmitted\. Setup is running in the background/);
  // the poll re-draws while running, and stops once the setup is over
  assert.ok(timers.length >= 1, 'a poll was scheduled');
  setup = { running: false, jobs: [] };
  const before = calls.filter((c) => c === 'setup').length;
  timers.at(-1)(); for (let i = 0; i < 6; i++) await settle();
  assert.equal(calls.filter((c) => c === 'setup').length, before + 1);
  assert.equal(box.byId('wacBg'), null, 'done -> no background line');
  const pending = timers.length; timers.at(-1)(); await settle();
  assert.equal(timers.length, pending, 'no new poll once the setup is over');
});
console.log(`r156-wa-templates: ${n} passed`);
