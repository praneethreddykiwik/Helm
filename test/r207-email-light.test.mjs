// R207 (owner decision): every Helm e-mail is LIGHT-ONLY with a soft light-green design. The owner saw the
// Supabase "Reset your password" e-mail as a dark card in Outlook (old prefers-color-scheme:dark / [data-ogsc]
// overrides + color-scheme "light dark"). Pins: no dark-mode CSS anywhere, light colour tokens, accessible
// contrast (WCAG AA), no white text on a colour, Outlook VML button kept, every auth link unchanged.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const r = (p) => readFileSync(new URL(p, root), 'utf8');
const L = await import('../supabase/functions/_shared/email-layout.mjs');
const { TEMPLATES } = await import('../scripts/gen-email-templates.mjs');
const S = await import('../supabase/functions/comms-dispatch/staff-email.mjs');
const CW = await import('../supabase/functions/comms-dispatch/cantwork-email.mjs');
const VB = await import('../supabase/functions/comms-dispatch/vendor-bill-reminder.mjs');
const TR = await import('../supabase/functions/comms-dispatch/trial-reminders.mjs');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n    ' + (e && e.message)); } };

const DARK = /prefers-color-scheme\s*:\s*dark|\[data-ogsc\]|\[data-ogsb\]|data-ogsc|data-ogsb|content="light dark"|color-scheme:\s*light dark/i;
const lightOnly = (h, k) => {
  assert.doesNotMatch(h, DARK, k + ': no dark-mode overrides');
  assert.ok(h.includes('<meta name="color-scheme" content="light only">'), k + ': color-scheme light only');
  assert.ok(h.includes('<meta name="supported-color-schemes" content="light">'), k + ': supported-color-schemes light');
  assert.ok(h.includes(':root{color-scheme:light only;supported-color-schemes:light;}'), k + ': :root light only');
  assert.ok(h.includes(`bgcolor="${L.C.bg}"`) && h.includes(`bgcolor="${L.C.card}"`) && h.includes(`bgcolor="${L.C.band}"`), k + ': backgrounds also set as bgcolor');
  assert.doesNotMatch(h, /color:\s*#fff(?:fff)?\b/i, k + ': no white text (would vanish when a client inverts)');
  assert.ok(h.includes('src="https://www.helm.events/email/helm-logo-v3.png"'), k + ': Helm logo');
};

const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

t('light colour tokens (soft light-green family)', () => {
  const C = L.C;
  for (const k of ['bg', 'card', 'brandSoft', 'band', 'accent']) assert.ok(lum(C[k]) > 0.45, k + ' ' + C[k] + ' is a light colour');
  assert.equal(C.card, '#ffffff'); assert.equal(C.band, '#e8f5ee'); assert.equal(C.accent, '#34d399');
  assert.notEqual(C.brand, '#0d8a5c', 'old dark emerald brand retired');
});
t('WCAG AA contrast for every text/background pair the layout uses', () => {
  const C = L.C, AA = 4.5;
  const pairs = [[C.btnInk, C.accent, 'button text'], [C.brand, C.card, 'links on card'], [C.brand, C.brandSoft, 'chips/eyebrow'],
    [C.brand, C.band, 'wordmark "Events"'], [C.ink, C.band, 'wordmark'], [C.body, C.card, 'body'], [C.muted, C.card, 'muted'],
    [C.faint, C.bg, 'footer'], [C.ink, C.brandSoft, 'code box']];
  for (const [fg, bg, what] of pairs) assert.ok(ratio(fg, bg) >= AA, `${what}: ${fg} on ${bg} = ${ratio(fg, bg).toFixed(2)}:1`);
});
t('layout + button: light-only, Outlook VML kept, light-green fill with dark text, preheader', () => {
  const h = L.layout('T', 'Pre <y>', L.h1('Hi') + L.button('https://a.test/x?y=1&amp;z=2', 'Go') + L.fallback('https://a.test/x?y=1&amp;z=2') + L.codeBox('123456'));
  lightOnly(h, 'layout');
  assert.ok(h.includes('<v:roundrect') && h.includes(`fillcolor="${L.C.accent}"`) && h.includes(`<center style="color:${L.C.btnInk};`), 'VML button: light-green fill, dark text');
  assert.ok(h.includes(`bgcolor="${L.C.accent}"`) && h.includes(`color:${L.C.btnInk};`), 'HTML button: light-green fill, dark text');
  assert.equal((h.match(/href="https:\/\/a\.test\/x\?y=1&amp;z=2"/g) || []).length, 3, 'button (VML + HTML) + fallback link unchanged');
  assert.ok(h.includes('Pre &lt;y&gt;') && /display:none;max-height:0/.test(h), 'preheader');
  assert.ok(h.includes('Helm Events &middot;') && h.includes('helm.events</a>'), 'footer as before');
  assert.ok(h.includes('class="band px"'), 'light-green header band');
});

// the exact auth links (0205) - must not change
const LINKS = {
  'confirm-signup': '{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&amp;type=email&amp;next={{ .RedirectTo }}',
  'invite-user': '{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&amp;type=invite&amp;next={{ .RedirectTo }}',
  'magic-link': '{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&amp;type=magiclink&amp;next={{ .RedirectTo }}',
  'reset-password': '{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&amp;type=recovery&amp;next=/reset-password',
  'change-email': '{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&amp;type=email_change&amp;next={{ .RedirectTo }}',
  'password-changed': 'https://www.helm.events/login#forgot',
};
t('every Supabase auth template is light-only and keeps its exact links', () => {
  const files = readdirSync(new URL('docs/ops/email-templates/', root)).filter((f) => f.endsWith('.html'));
  assert.equal(files.length, 8);
  for (const f of files) {
    const k = f.replace('.html', ''), h = r('docs/ops/email-templates/' + f);
    lightOnly(h, f);
    assert.equal(h, TEMPLATES[k].html + '\n', f + ' = generator output');
    const hrefs = [...h.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((u) => !/^\{\{ \.SiteURL \}\}(\/privacy)?$/.test(u));
    if (LINKS[k]) {
      assert.ok(hrefs.length >= 3 && hrefs.every((u) => u === LINKS[k]), f + ': only the expected link (VML + button + fallback) ' + JSON.stringify([...new Set(hrefs)]));
      assert.ok(h.includes('<v:roundrect'), f + ': Outlook VML button');
    } else assert.deepEqual(hrefs, [], f + ': no action link');
  }
  assert.ok(r('docs/ops/email-templates/reauthentication.html').includes('{{ .Token }}'));
});
t('mirrors + welcome previews in docs/email-templates are light-only too', () => {
  for (const f of readdirSync(new URL('docs/email-templates/', root)).filter((x) => x.endsWith('.html'))) lightOnly(r('docs/email-templates/' + f), f);
});
t('comms-dispatch e-mails (staff, office, escalation, day off, vendor bill, trial) are light-only', () => {
  const O = 'https://www.helm.events', base = { studio: 'S', event: 'E', event_date: '20 Dec 2026', venue: 'V', name: 'N' };
  const STAFF = 'work.html?staff=' + 'a'.repeat(64);
  lightOnly(S.staffEmailHtml({ ...base, kind: 'task_one', link_path: STAFF, task: 'T', start: '2:30 PM', day: '16 Nov 2026' }, O), 'staff task_one');
  lightOnly(S.staffUpdateHtml({ ...base, kind: 'task_update', link_path: STAFF, changes: ['x: new task'], tasks: [] }, O), 'staff update');
  for (const fn of [CW.cantworkHtml, VB.vendorBillHtml]) {
    let h = ''; try { h = fn({ ...base, kind: fn === CW.cantworkHtml ? 'request' : 'due', amount: 100, currency: 'INR' }, O); } catch (_) { h = ''; }
    if (h) lightOnly(h, fn.name);
  }
  const m = TR.trialReminderEmail('d5', 'S', '2026-12-01T00:00:00Z', 'Asia/Kolkata', O);
  if (m && m.html) lightOnly(m.html, 'trial reminder');
});
t('no source e-mail file still carries dark-mode overrides or the old dark emerald', () => {
  const walk = (d) => readdirSync(new URL(d, root), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(d + e.name + '/') : [d + e.name]);
  for (const f of walk('supabase/functions/').filter((x) => /\.(ts|mjs|js)$/.test(x))) {
    const s = r(f);
    if (!/email-layout\.mjs|<html/.test(s)) continue;
    assert.doesNotMatch(s, /prefers-color-scheme\s*:\s*dark|data-ogsc|data-ogsb/, f);
    assert.ok(!s.includes('#0d8a5c'), f + ': old dark emerald');
  }
});
t('owner README: paste each template into its Supabase template, with subjects', () => {
  const md = r('docs/ops/email-templates/README.md');
  assert.match(md, /Authentication → Emails → Templates/);
  for (const [k, v] of Object.entries(TEMPLATES)) {
    assert.ok(md.includes('`' + k + '.html`'), k + ' listed');
    assert.ok(md.includes(v.subject), k + ' subject');
  }
  assert.match(md, /light/i);
});

console.log(`r207-email-light: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
