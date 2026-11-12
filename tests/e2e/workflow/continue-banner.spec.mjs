// @smoke R161 - the shared "Continue where you left off" banner + Home "Continue quotes" order, on localhost -> STAGING.
// Two new synthetic quotes are started from Home ("New quote" opens the flow): each one is first on Home right away (the flow
// saves its opening step before the long load), newest first; a teammate working on the older one moves it back to the top.
// The banner shows on the event workspace, Discovery, Proposal and the flow (opened on another step) for an editor, not for a
// view-only role, not for an archived quote; "Not now" hides it for the tab session only. Every page is checked for zero page
// errors. The quotes are moved to Deleted at the end (soft, restorable). Needs HELM_E2E_* staging env + 0350 on staging.
// Screenshots: HELM_E2E_SHOTS=<dir> (default test-results/r161).
// Run: npx playwright test --project=chromium tests/e2e/workflow/continue-banner.spec.mjs
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { authedPage } from '../helpers/session.mjs';
import { requireStagingEnv } from '../helpers/env.mjs';
import { assertStagingOnly } from '../helpers/staging.mjs';

test.beforeAll(() => requireStagingEnv());
test.describe.configure({ timeout: 240_000 });
const SHOTS = process.env.HELM_E2E_SHOTS || 'test-results/r161';
mkdirSync(SHOTS, { recursive: true });

function watchErrors(page, label, errs) {
  page.on('pageerror', (e) => errs.push(label() + ': ' + (e && e.message || e)));
}
async function newQuote(page) {
  await page.goto('/dashboard.html');
  const mark = page.waitForResponse((r) => /\/rpc\/mark_flow_step/.test(r.url()) && r.request().method() === 'POST', { timeout: 20_000 });
  await page.locator('#createBtn').first().click();
  await page.waitForURL(/\/flow(\.html)?\?quote=/, { timeout: 30_000, waitUntil: 'domcontentloaded' });
  const id = new URL(page.url()).searchParams.get('quote');
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  const r = await mark;                                       // r161 earlyLand: saved before the flow finished loading
  expect(r.ok()).toBe(true);
  return id;
}
const homeIds = (page) => page.evaluate(() => [...document.querySelectorAll('#hdResume [data-quote], #flowResume [data-quote]')].map((n) => n.getAttribute('data-quote')));

test('@smoke Continue banner on every quote page + Home newest first', async ({ browser }) => {
  const errs = [];
  const a = await authedPage(browser, 'admin');
  let where = 'admin'; watchErrors(a.page, () => where + ' ' + a.page.url(), errs);
  const made = [];
  try {
    // 1) a brand-new quote is first on Home at once; a second one goes above it
    const q1 = await newQuote(a.page); made.push(q1);
    await a.page.goto('/dashboard.html');
    await expect(a.page.locator('#hdResume [data-quote="' + q1 + '"]')).toBeVisible({ timeout: 20_000 });
    expect((await homeIds(a.page))[0]).toBe(q1);
    // give q1 a client (an untouched blank quote is reused by the next New quote - 0075), then start q2
    await a.page.goto('/flow.html?quote=' + q1 + '#sec-client');
    await a.page.locator('#c_name').fill('R161 Banner A');
    await a.page.locator('#c_email').fill('r161.e2e@example.com');          // reserved example.com domain: no real inbox
    await a.page.locator('#c_phone').fill('9876543210');
    await a.page.locator('#c_type').fill('Wedding');
    await a.page.locator('#c_date').fill(new Date(Date.now() + 45 * 864e5).toISOString().slice(0, 10));
    await a.page.locator('#c_date').blur();
    await expect.poll(() => a.page.evaluate(async (id) => ((await window.BPStore.quotes.get(id)) || {}).client?.name || '', q1), { timeout: 30_000 }).toBe('R161 Banner A');
    const q2 = await newQuote(a.page); made.push(q2);
    expect(q2).not.toBe(q1);
    await a.page.goto('/dashboard.html');
    await expect(a.page.locator('#hdResume [data-quote="' + q2 + '"]')).toBeVisible({ timeout: 20_000 });
    expect((await homeIds(a.page)).slice(0, 2)).toEqual([q2, q1]);
    const order = await a.page.evaluate(async () => (await window.BPStore.flowProgress.open({ scope: 'mine', limit: 20 })).rows
      .map((r) => Date.parse(r.activity)));
    for (let i = 1; i < order.length; i++) expect(order[i - 1]).toBeGreaterThanOrEqual(order[i]);   // newest activity first
    await a.page.screenshot({ path: join(SHOTS, 'home-continue-quotes.png'), fullPage: false });

    // 2) a teammate works on the OLDER quote in the flow -> it is back on top of MY Home list
    const m = await authedPage(browser, 'manager');
    try {
      const ok = await m.page.evaluate(async (id) => { try { return await window.BPStore.flowProgress.mark(id, 'venue'); } catch (e) { return { err: String(e && e.message || e) }; } }, q1);
      if (ok && ok.ok) {
        await a.page.goto('/dashboard.html');
        await expect(a.page.locator('#hdResume [data-quote="' + q1 + '"]')).toBeVisible({ timeout: 20_000 });
        expect((await homeIds(a.page)).slice(0, 2)).toEqual([q1, q2]);
      } else console.log('manager cannot mark a step on staging (' + JSON.stringify(ok) + ') - teammate order checked in the DB suite only');
    } finally { await m.context.close(); }

    // 3) event workspace: the banner, at the top, Continue -> the exact step
    where = 'event';
    await a.page.goto('/event.html?id=' + q2);
    const b = a.page.locator('#flowResumeBanner');
    await expect(b).toBeVisible({ timeout: 20_000 });
    await expect(b).toContainText('Not confirmed yet');
    await expect(b).toContainText(/Next: [A-Za-z &]+ \(step \d+( of 8)?\)/);
    await expect(b).not.toContainText(/steps done\.|of 8 \(/);                 // the old "step 8 of 8 (Quotation). 2 of 8 steps done." wording is gone
    const step = await b.getAttribute('data-step');
    await expect(b.getByRole('link', { name: /^Continue where you left off/ })).toHaveAttribute('href', new RegExp('flow(\\.html)?\\?quote=' + q2 + '#sec-' + step + '$'));
    await a.page.screenshot({ path: join(SHOTS, 'event-banner.png') });

    // 4) Not now = hidden for this tab session (a reload keeps it hidden), back in a new tab session
    await b.getByRole('button', { name: /Hide this reminder for this session/ }).click();
    await expect(b).toHaveCount(0);
    await a.page.reload(); await a.page.waitForTimeout(4_000);
    await expect(a.page.locator('#flowResumeBanner')).toHaveCount(0);
    const fresh = await authedPage(browser, 'admin');            // a new session (new tab / device): shown again
    try {
      watchErrors(fresh.page, () => 'fresh ' + fresh.page.url(), errs);
      await fresh.page.goto('/event.html?id=' + q2);
      await expect(fresh.page.locator('#flowResumeBanner')).toBeVisible({ timeout: 20_000 });
    } finally { await fresh.context.close(); }

    // 5) Discovery + Proposal pages of the same quote (q1 is not hidden)
    for (const p of ['discovery', 'proposal']) {
      where = p;
      await a.page.goto('/' + p + '.html?quote=' + q1);
      await expect(a.page.locator('#flowResumeBanner')).toBeVisible({ timeout: 20_000 });
      await a.page.screenshot({ path: join(SHOTS, p + '-banner.png') });
    }

    // 6) the flow opened on another step: the banner, Continue scrolls to the step in place (no reload)
    where = 'flow';
    await a.page.evaluate(async (id) => window.BPStore.flowProgress.mark(id, 'quote'), q1);
    await a.page.goto('/flow.html?quote=' + q1 + '#sec-client');
    const fb = a.page.locator('#flowResumeBanner');
    await expect(fb).toBeVisible({ timeout: 30_000 });
    await expect(fb).toContainText('Next: Quotation (step 8 of 8)');
    await a.page.screenshot({ path: join(SHOTS, 'flow-banner.png') });
    const before = a.page.url();
    await fb.getByRole('link', { name: /^Continue where you left off/ }).click();
    await expect.poll(() => a.page.url()).toMatch(/#sec-quote$/);
    expect(a.page.url().split('#')[0]).toBe(before.split('#')[0]);
    await expect(fb).toHaveCount(0);
    // opened right on that step (no #step: the flow lands there itself) -> no banner
    await a.page.goto('/flow.html?quote=' + q1); await a.page.waitForTimeout(8_000);
    await expect(a.page.locator('#flowResumeBanner')).toHaveCount(0);

    // 7) Quotes: the dashboard + Quotes list render without errors (R158 lesson)
    where = 'quotes';
    await a.page.goto('/quotes.html'); await a.page.waitForTimeout(5_000);
    // the Confirm dialog of an open quote carries the same banner (closed again without saving anything)
    const cb = a.page.locator('tr button[data-act="confirm"][aria-label^="Confirm "]').first();
    if (await cb.count()) {
      await cb.click(); await expect(a.page.locator('#confirmModal')).toBeVisible({ timeout: 20_000 });
      await a.page.waitForTimeout(3_000);
      const inModal = a.page.locator('#confirmModal #flowResumeBanner');
      if (await inModal.count()) { await expect(inModal).toContainText(/Next: [A-Za-z &]+ \(step \d+/); await a.page.screenshot({ path: join(SHOTS, 'quotes-confirm-banner.png') }); }
      await a.page.locator('#cm_close').click();
    }
    await a.page.goto('/quotes.html?view=inprogress'); await expect(a.page.locator('#ipWrap')).toBeVisible({ timeout: 20_000 });

    // 8) a view-only role (quotes view, not edit) never gets the banner
    for (const role of ['coordinator', 'quality', 'operations', 'supervisor', 'planner', 'sales']) {
      const v = await authedPage(browser, role).catch(() => null); if (!v) continue;
      try {
        const can = await v.page.evaluate(async () => ({ view: await window.BPStore.auth.canView('quotes').catch(() => false), edit: await window.BPStore.auth.canEditArea('quotes').catch(() => true) }));
        if (!can.view || can.edit) continue;
        where = 'view-only ' + role; watchErrors(v.page, () => where, errs);
        await v.page.goto('/event.html?id=' + q1); await v.page.waitForTimeout(6_000);
        await expect(v.page.locator('#evHead')).toBeVisible({ timeout: 20_000 });
        await expect(v.page.locator('#flowResumeBanner')).toHaveCount(0);
        console.log('view-only role checked: ' + role);
        break;
      } finally { await v.context.close(); }
    }

    // 9) archived -> never a banner (the server list leaves it out too)
    where = 'archived';
    await a.page.evaluate((id) => window.BPStore.quoteShelf.move(id, 'archive'), q2);
    await a.page.goto('/event.html?id=' + q2); await a.page.waitForTimeout(6_000);
    await expect(a.page.locator('#flowResumeBanner')).toHaveCount(0);
    await assertStagingOnly(a.page);
  } finally {
    for (const id of made) await a.page.evaluate((x) => window.BPStore.quoteShelf && window.BPStore.quoteShelf.move(x, 'delete'), id).catch(() => {});
    await a.context.close();
  }
  expect(errs, errs.join('\n')).toEqual([]);
});
