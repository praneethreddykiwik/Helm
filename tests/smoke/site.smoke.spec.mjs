// R176 smoke - browser checks against the DEPLOYED site.
//   A4/A5  anonymous: login page draws, no console errors          (always)
//   B1-B7  signed-in, READ-ONLY (never clicks save / send / delete)  (only when the smoke account secrets exist)
//   C1/C2  channel check: real test e-mail / WhatsApp to the OWNER   (only on a manual run with SMOKE_CHANNEL_CHECK=1)
// Secrets come from env only and are never printed.
import { test, expect } from '@playwright/test';
import { CONSOLE_ALLOW, INLINE_STYLE_CSP, classifyStyleCsp, cspHashOf } from './config.mjs';

const TARGET = (process.env.SMOKE_TARGET || 'staging').toLowerCase();
const KEY = TARGET === 'prod' ? 'PROD' : 'STAGING';
const EMAIL = process.env[`SMOKE_${KEY}_EMAIL`] || '';
const PASSWORD = process.env[`SMOKE_${KEY}_PASSWORD`] || '';
const SIGNED_IN = process.env.SMOKE_SIGNED_IN !== '0' && !!EMAIL && !!PASSWORD;
const CHANNEL = process.env.SMOKE_CHANNEL_CHECK === '1';
const OWNER_EMAIL = (process.env.SMOKE_OWNER_EMAIL || '').trim().toLowerCase();
const OWNER_PHONE = (process.env.SMOKE_OWNER_PHONE || '').replace(/\D/g, '');

// R238: every CSP violation the page sees (directive + the file that caused it), read back by settle()
const CSP_WATCH = () => { window.__helmCspV = []; document.addEventListener('securitypolicyviolation', (e) => {
  try { window.__helmCspV.push({ directive: e.effectiveDirective || e.violatedDirective || '', sourceFile: e.sourceFile || '' }); } catch (_) {} }); };
function watchConsole(page) {
  const errors = [], styleCsp = [];
  page.addInitScript(CSP_WATCH).catch(() => {});
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (CONSOLE_ALLOW.some((re) => re.test(t))) return;
    if (INLINE_STYLE_CSP.test(t)) { styleCsp.push(t); return; }   // decided in settle(): Google's (warn) or Helm's (error)
    errors.push(t.slice(0, 200));
  });
  page.on('pageerror', (e) => errors.push(('pageerror: ' + (e && e.message)).slice(0, 200)));
  // R238: Google sign-in's own inline-style hash changes = a WARNING listing the new hash, not a red run
  errors.settle = async () => {
    if (!styleCsp.length) return errors;
    const seen = await page.evaluate(() => ({ v: window.__helmCspV || [],
      gsi: performance.getEntriesByType('resource').some((r) => /^https:\/\/accounts\.google\.com\/gsi\/client/.test(r.name)) })).catch(() => ({ v: [], gsi: false }));
    const warn = new Set();
    for (const t of styleCsp) {
      if (classifyStyleCsp(t, seen.v, seen.gsi) === 'gsi') warn.add(cspHashOf(t) || '(hash not in the message)');
      else errors.push(t.slice(0, 200));
    }
    if (warn.size) {
      const msg = "Google sign-in (accounts.google.com/gsi) injected an inline style with a new CSP hash - add to GIS_INLINE_STYLE_HASHES in scripts/csp-hashes.cjs: " + [...warn].map((h) => "'" + h + "'").join(' ');
      console.warn('WARNING: ' + msg);
      test.info().annotations.push({ type: 'warning', description: msg });
    }
    return errors;
  };
  return errors;
}

test.describe('anonymous', () => {
  test('A4+A5 login page draws (email, password, Google) with no console errors', async ({ page }) => {
    const errors = watchConsole(page);
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    const form = page.locator('#loginForm');
    await expect(form.locator('#email')).toBeVisible();
    await expect(form.locator('#pw')).toBeVisible();
    // Google: the classic button or Google's own (GIS) button
    await expect(page.locator('#googleBtn, .gis-btn, iframe[src*="accounts.google.com"]').first()).toBeAttached();
    await page.waitForLoadState('networkidle').catch(() => {});
    await errors.settle();
    expect([...errors], 'console errors on /login').toEqual([]);   // R252: copy - errors also carries settle(), so the bare array never equalled []
  });

  test('A5 homepage has no console errors', async ({ page }) => {
    const errors = watchConsole(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await errors.settle();
    expect([...errors], 'console errors on /').toEqual([]);   // R252: copy - errors also carries settle(), so the bare array never equalled []
  });
});

test.describe('signed-in (read-only)', () => {
  test.skip(!SIGNED_IN, `not configured: add SMOKE_${KEY}_EMAIL and SMOKE_${KEY}_PASSWORD secrets to switch on`);
  test.describe.configure({ mode: 'serial' });
  let page;

  test.beforeAll(async ({ browser }) => {
    page = await (await browser.newContext()).newPage();
  });
  test.afterAll(async () => { await page.context().close().catch(() => {}); });

  test('B1 sign in through the real form lands on the dashboard', async () => {
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    const form = page.locator('#loginForm');
    await form.locator('#email').fill(EMAIL);
    await form.locator('#pw').fill(PASSWORD);
    await form.locator('#submit').click();
    await page.waitForURL(/\/dashboard/, { timeout: 45_000, waitUntil: 'domcontentloaded' });
  });

  test('B2 dashboard shows content and no error toast', async () => {
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#main, main').first()).toBeVisible();
    await page.waitForLoadState('networkidle').catch(() => {});
    await expect(page.locator('.hs-toast.hs-error')).toHaveCount(0);
  });

  test('B3 events list loads', async () => {
    await page.goto('/quotes', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#rows')).toBeVisible();
    await expect(page.locator('#rows')).not.toHaveAttribute('aria-busy', 'true', { timeout: 30_000 });
  });

  test('B4 one event opens', async () => {
    const link = page.locator('#rows a[href*="quote="]').first();
    test.skip((await link.count()) === 0, 'no events in the smoke studio yet');
    const href = await link.getAttribute('href');
    await page.goto(href, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#main, main').first()).toBeVisible();
    await expect(page.locator('.hs-toast.hs-error')).toHaveCount(0);
  });

  test('B5 Integrations status cards load', async () => {
    await page.goto('/integrations', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#itgEmail')).toBeVisible();
  });

  test('B6 Operations page loads (nothing clicked)', async () => {
    await page.goto('/ops', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#main, main').first()).toBeVisible();
    await expect(page.locator('.hs-toast.hs-error')).toHaveCount(0);
  });

  // C1/C2 run BEFORE sign-out, only on a manual run with the switch on, and only to the OWNER.
  test('C1 channel check: test e-mail to the owner', async () => {
    test.skip(!CHANNEL, 'channel check is manual only (include_channel_check)');
    test.skip(!OWNER_EMAIL, 'SMOKE_OWNER_EMAIL not set');
    test.skip(EMAIL.trim().toLowerCase() !== OWNER_EMAIL, 'the smoke account is not the owner address, so no e-mail is sent (Send test e-mail goes to the signed-in account)');
    await page.goto('/integrations', { waitUntil: 'domcontentloaded' });
    await page.locator('#itgEmailTest').click();
    await expect(page.locator('#itgMsg, .hs-toast').first()).toContainText(/sent|on its way|simulat|not connected/i, { timeout: 60_000 });
  });

  test('C2 channel check: test WhatsApp to the owner (or "not set up yet")', async () => {
    test.skip(!CHANNEL, 'channel check is manual only (include_channel_check)');
    test.skip(!OWNER_PHONE, 'SMOKE_OWNER_PHONE not set');
    await page.goto('/integrations', { waitUntil: 'domcontentloaded' });
    const card = page.locator('#itgWa, section:has(#itgWaTest)').first();
    const notSetUp = card.getByText(/not set up|not connected/i).first();
    if (await notSetUp.count()) { await expect(notSetUp).toBeVisible(); return; }   // pass: WhatsApp isn't set up yet
    const field = card.locator('input[type="tel"], input[name*="phone" i], input[id*="Num" i]').first();
    const digits = ((await field.inputValue().catch(() => '')) || '').replace(/\D/g, '');
    test.skip(!digits.endsWith(OWNER_PHONE.slice(-10)), 'the studio number field is not the owner phone, so nothing is sent');
    await page.locator('#itgWaTest').click();
    await expect(page.locator('#itgMsg, .hs-toast').first()).toContainText(/sent|not set up|not connected/i, { timeout: 60_000 });
  });

  test('B7 sign out clears the session', async () => {
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await page.locator('#hauAccountBtn').click({ timeout: 15_000 });
    const out = page.locator('#hauMenu').getByRole('menuitem', { name: /sign out/i });
    await expect(out).toBeVisible();
    await out.click();
    await expect.poll(async () => page.evaluate(
      () => { try { return Object.keys(localStorage).some((k) => k.includes('auth-token')); } catch { return false; } },
    ).catch(() => true), { timeout: 15_000 }).toBe(false);
  });
});
