// r129: each studio sends WhatsApp from its OWN number. Static + pure-logic checks; behaviour: tests/db/r129-studio-whatsapp-0337.sql.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
let n = 0;
const t = async (name, fn) => { try { await fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };
const SQL = r('supabase/migrations/0337_r129_studio_whatsapp.sql'), APPLY = r('supabase/APPLY-0337.sql');
const code = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
const W = await import('../supabase/functions/_shared/wa-studio.mjs');
const P = await import('../supabase/functions/wa-proposal/logic.mjs');
const noComments = (s) => s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

await t('0337 is in the manifest, after 0336', () => {
  const mf = r('supabase/migrations/MANIFEST');
  assert.match(mf, /forward\s+supabase\/migrations\/0337_r129_studio_whatsapp\.sql/);
  assert.ok(mf.indexOf('0336_r128_security_fixes.sql') < mf.indexOf('0337_r129_studio_whatsapp.sql'));
});
await t('APPLY-0337 carries the same body in one transaction, then VERIFY', () => {
  assert.ok(APPLY.includes(SQL.trim()));
  assert.match(APPLY, /^begin;$/m); assert.match(APPLY, /^commit;$/m);
  assert.ok(APPLY.indexOf('commit;') < APPLY.indexOf('-- VERIFY'));
});
await t('both files are ASCII', () => { for (const s of [SQL, APPLY]) assert.ok(/^[\x00-\x7F]*$/.test(s)); });
await t('additive: nothing dropped; the only delete is the disconnecting studio\'s own token', () => {
  assert.doesNotMatch(code, /\bdrop\s+(table|column|policy|schema|view|function)\b/i);
  assert.doesNotMatch(code, /\btruncate\b/i);
  assert.doesNotMatch(code, /delete\s+from\s+public\./i);
  const dels = code.match(/delete from [a-z_.]+/gi) || [];
  assert.deepEqual(dels, ['delete from vault.secrets']);
  assert.match(code, /'delete from vault\.secrets where id = \$1' using r\.token_secret_id/);
});
await t('server-only functions are never granted to the app; kept bodies lose every privilege', () => {
  for (const f of ['org_whatsapp_check_creds', 'wa_account_verified', 'wa_templates_mark', 'wa_template_status', '_r337_wa_ready']) {
    assert.doesNotMatch(code, new RegExp("grant execute on function public\\." + f + "\\([^)]*\\) to (anon|authenticated)"), f);
  }
  assert.match(code, /revoke all on function ' \|\| f \|\| ' from service_role/);
});
await t('a late check result cannot reconnect a disconnected / paused studio', () => {
  assert.match(code, /if v_status is null or v_status not in \('pending', 'connected', 'error'\) then return jsonb_build_object\('result', 'ignored'\)/);
});

await t('template catalogue: the 8 names the senders use, English, examples given', () => {
  assert.deepEqual(W.CATALOGUE_NAMES.slice(0, 8), ['proposal_sent', 'proposal_reminder', 'proposal_approved_pay', 'payment_received',
    'proposal_approval_otp', 'helm_notice', 'helm_task_assigned', 'helm_event_reminder']);   // R130 adds the field templates after these
  for (const k of P.KINDS) assert.ok(W.CATALOGUE_NAMES.includes(k), k);
  assert.ok(W.CATALOGUE_NAMES.includes(P.OTP_TEMPLATE));
  for (const tpl of W.templateCatalogue('https://www.helm.events')) {
    assert.equal(tpl.language, 'en');
    const body = tpl.components.find((c) => c.type === 'BODY');
    if (tpl.category === 'AUTHENTICATION') { assert.equal(body.add_security_recommendation, true); continue; }
    assert.equal(tpl.category, 'UTILITY');
    const vars = (body.text.match(/\{\{\d+\}\}/g) || []).length;
    assert.equal(body.example.body_text[0].length, vars, tpl.name);
    assert.doesNotMatch(body.text, /^\{\{|\}\}$/, tpl.name + ': Meta refuses a body that starts or ends with a variable');
  }
});
await t('variable counts match what wa-proposal sends', () => {
  const cat = Object.fromEntries(W.templateCatalogue().map((x) => [x.name, x]));
  for (const k of P.KINDS) {
    const vars = (cat[k].components[0].text.match(/\{\{\d\}\}/g) || []).length;
    assert.equal(P.bodyVars(k, {}).length, vars, k);
    const btn = cat[k].components.find((c) => c.type === 'BUTTONS').buttons[0];
    assert.equal(btn.type, 'URL'); assert.match(btn.url, /\/portal\.html\?token=\{\{1\}\}$/);
  }
});
await t('the button site follows APP_URL (https only)', () => {
  assert.equal(W.siteOrigin('https://helm-v01.vercel.app/x'), 'https://helm-v01.vercel.app');
  assert.equal(W.siteOrigin('http://evil.test'), 'https://www.helm.events');
  assert.equal(W.siteOrigin('not a url'), 'https://www.helm.events');
});
await t('template states: Helm\'s English templates only; what is left to create', () => {
  const st = W.templateStates([{ name: 'proposal_sent', language: 'en', status: 'approved' }, { name: 'proposal_sent', language: 'en_US', status: 'REJECTED' },
    { name: 'somebody_else', language: 'en', status: 'APPROVED' }, { name: 'helm_notice', language: 'en', status: 'PENDING' }]);
  assert.deepEqual(st, { proposal_sent: 'APPROVED', helm_notice: 'PENDING' });
  assert.deepEqual(W.templatesToCreate(st).map((x) => x.name), W.CATALOGUE_NAMES.filter((x) => !['proposal_sent', 'helm_notice'].includes(x)));
  const s = W.templateSummary(st); assert.equal(s.approved, 1); assert.equal(s.waiting, 1); assert.equal(s.missing, W.CATALOGUE_NAMES.length - 2); assert.equal(s.ready, false);
});
await t('Meta errors: token / permission / exists / template / recipient / limit', () => {
  assert.equal(W.graphError(401, {}).kind, 'token');
  assert.equal(W.graphError(400, { error: { code: 190 } }).kind, 'token');
  assert.equal(W.graphError(400, { error: { code: 10 } }).kind, 'permission');
  assert.equal(W.graphError(400, { error: { code: 100, error_subcode: 2388024 } }).kind, 'exists');
  assert.equal(W.graphError(400, { error: { code: 132001 } }).kind, 'template');
  assert.equal(W.graphError(400, { error: { code: 131026 } }).kind, 'recipient');
  assert.equal(W.graphError(429, {}).kind, 'limit');
  assert.equal(W.graphError(500, {}).kind, 'other');
});
await t('connection check: the number must be the one asked for and in that account', () => {
  assert.equal(W.verifyResult('123456', { id: '999999' }, []).ok, false);
  assert.equal(W.verifyResult('123456', { id: '123456' }, [{ id: '555555' }]).ok, false);
  const ok = W.verifyResult('123456', { id: '123456', display_phone_number: '+91 90000 00337<', verified_name: 'Aurora <b>', quality_rating: 'GREEN' }, [{ id: '123456' }]);
  assert.equal(ok.ok, true); assert.equal(ok.display, '+91 90000 00337'); assert.doesNotMatch(ok.name, /[<>]/); assert.equal(ok.quality, 'GREEN');
});
await t('notices: one-line {{1}} in the studio\'s helm_* templates', () => {
  assert.equal(W.noticeContent('task_assigned', 'a\nb').template.name, 'helm_task_assigned');
  assert.equal(W.noticeContent('event_reminder', 'x').template.name, 'helm_event_reminder');
  assert.equal(W.noticeContent('general', 'x').template.name, 'helm_notice');
  assert.equal(W.noticeContent('general', 'a\nb').template.components[0].parameters[0].text, 'a b');
  assert.equal(W.noticeContent('general', '  '), null);
});

await t('every studio sender uses the studio number, never Helm\'s secrets', () => {
  for (const fn of ['wa-proposal', 'send-otp', 'comms-dispatch', 'pkg-client-notify', 'send-whatsapp', 'integrations-test']) {
    const src = noComments(r('supabase/functions/' + fn + '/index.ts'));
    assert.match(src, /_shared\/wa-sender\.ts/, fn);
    assert.doesNotMatch(src, /env(\.get)?\(\s*["']WHATSAPP_(TOKEN|PHONE_ID)["']/, fn);
  }
  // Helm's own number stays for Helm's own code (staff phone verification)
  assert.match(r('supabase/functions/send-phone-code/index.ts'), /WHATSAPP_TOKEN/);
});
await t('wa-sender: connected accounts only; a refused token marks the account', () => {
  const s = r('supabase/functions/_shared/wa-sender.ts');
  assert.match(s, /admin\.rpc\("org_whatsapp_creds"/);
  assert.match(s, /mark_org_integration", \{ p_org: sender\.orgId, p_kind: "whatsapp", p_status: "error"/);
  assert.match(s, /redirect: "error"/);
  assert.doesNotMatch(noComments(s), /console\.(log|error)\([^)]*token/i);
});
await t('send-otp: no WhatsApp code without a connected number, checked before a code is stored', () => {
  const s = r('supabase/functions/send-otp/index.ts');
  const i = s.indexOf('if (!sender) return json({ error: "Your planner hasn\'t connected WhatsApp yet - please use e-mail instead.'), j = s.indexOf('admin.rpc("wa_otp_begin"');
  assert.ok(i > 0 && j > i, 'checked before wa_otp_begin');
  assert.match(s, /not_connected: true, fallback: "email"/);
});
await t('wa-proposal: the caller\'s studio (RLS) and its own number; not connected = 409', () => {
  const s = r('supabase/functions/wa-proposal/index.ts');
  assert.match(s, /asCaller\.from\("quotes"\)\.select\("id, org_id"\)/);
  assert.match(s, /not_connected: true, status: "not_connected" \}, 409/);
});
await t('wa-connect: admin only (asked as the caller), JWT checked by the gateway, token never answered', () => {
  const s = r('supabase/functions/wa-connect/index.ts');
  assert.match(s, /asCaller\.rpc\("wa_connect_org"/);
  assert.match(r('supabase/config.toml'), /\[functions\.wa-connect\][^\n]*\nverify_jwt = true/);
  assert.doesNotMatch(noComments(s), /json\(\{[^}]*\btoken\s*[:,}]/);
  assert.match(s, /u\.hostname !== "graph\.facebook\.com"/);
});
await t('wa-webhook: template states saved by WABA id; a failure there is not a retry storm', () => {
  const s = r('supabase/functions/wa-webhook/index.ts');
  assert.match(s, /kind: "template", args: \{ p_waba_id: waba, p_name: tname, p_status: status \}/);
  assert.match(s, /a\.kind === "template" \? "wa_template_status"/);
  assert.match(s, /if \(error && a\.kind === "template"\) \{[^}]*continue; \}/);
});

await t('site switches: studio WhatsApp on, Helm\'s own number off, payments off, Integrations page on', () => {
  const c = r('public/config.js');
  const block = (c.match(/liveChannels\s*:\s*\{[\s\S]*?\n  \}/) || [''])[0];
  assert.match(block, /\bwhatsapp: true\b/); assert.match(block, /\bwhatsappHelm: false\b/); assert.match(block, /\bpay: false\b/);
  assert.match(c, /integrationsPage: true \}/);
});
await t('phone Verify uses Helm\'s own switch; the profile hides Verify without it', () => {
  assert.match(r('public/store-api.js'), /available: \(\) => mode === "supabase" && !!LIVE\.whatsappHelm/);
  assert.match(r('public/auth-ui.js'), /if \(!helmWaLive\) vBtn\.hidden = true;/);
});
await t('approval page hides "Send code on WhatsApp" when the studio has no connected number', () => {
  assert.match(r('public/approve.html'), /if\(r\.wa===false\)\{ const w=\$\("#sendWa"\); if\(w\)\{ w\.hidden=true;/);
});
await t('Send on WhatsApp box: the studio\'s number, a Connect link when not connected', () => {
  const s = r('public/wa-proposal.js');
  assert.match(s, /"WhatsApp \(your studio's number\)"/);
  assert.match(s, /connA\.href = "integrations\.html#whatsapp"/);
  assert.match(s, /btn\.disabled = !phone \|\| ready === false;/);
  assert.doesNotMatch(s, /Helm Events number/);
});
await t('Integrations page loads the connect card; the payments card stays hidden while payments are off', () => {
  const h = r('public/integrations.html');
  assert.match(h, /<div class="wac" id="itgWaConnect" hidden><\/div>/);
  assert.ok(h.indexOf('wa-connect-ui.js') < h.indexOf('integrations.js?'));
  assert.match(r('public/integrations.js'), /if \(pay && !liveFlags\(\)\.pay\) pay\.hidden = true;/);
});
await t('connect card helpers', () => {
  const C = require('../public/wa-connect-ui.js');
  assert.equal(C.stateOf(null), 'none');
  assert.equal(C.stateOf({ status: 'disabled' }), 'none');
  assert.equal(C.stateOf({ status: 'disabled', phone_number_id: '123456' }), 'paused');
  assert.equal(C.stateOf({ status: 'connected' }), 'connected');
  assert.equal(C.stateOf({ status: 'error' }), 'error');
  assert.equal(C.stateOf({ status: 'pending' }), 'pending');
  assert.match(C.validate({ wabaId: 'x', phoneId: '123456', token: 'y'.repeat(30) }), /Business Account ID/);
  assert.match(C.validate({ wabaId: '123456', phoneId: '123456', token: 'short' }), /token/);
  assert.equal(C.validate({ wabaId: '123456', phoneId: '1234567', token: 'y'.repeat(30), disp: '+91 98765 43210' }), '');
  assert.deepEqual(C.TEMPLATES.map((x) => x[0]), W.CATALOGUE_NAMES);
  assert.equal(C.templateLine(Object.fromEntries(W.CATALOGUE_NAMES.map((x) => [x, 'APPROVED']))).ready, true);
  assert.match(C.friendly({ message: 'phone_in_use' }), /another studio/);
});
await t('Integrations status words follow the studio\'s own account', () => {
  const H = require('../public/integrations.js');
  assert.equal(H.whatsappStatus({ whatsapp: { status: 'connected', display_phone: '+91 90000 00337' } }).label, 'Live');
  assert.equal(H.whatsappStatus({ whatsapp: { status: 'pending' } }).state, 'wait');
  assert.equal(H.whatsappStatus({ whatsapp: { status: 'error' } }).label, 'Needs attention');
  assert.equal(H.whatsappStatus({ studio_whatsapp: '919876543210' }).label, 'Not connected');
});
console.log(`r129-studio-whatsapp: ${n} passed`);
