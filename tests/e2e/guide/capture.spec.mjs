// @guide — captures full-page screenshots of every tester-facing screen into
// docs/tester-guide/screens/. Not a functional test; it documents the app.
// Run: npx playwright test --project=chromium --grep @guide --trace off
import { test } from '@playwright/test';
import { authedPage } from '../helpers/session.mjs';
import { rpcAs } from '../helpers/lifecycle.mjs';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(process.cwd(), 'docs', 'tester-guide', 'screens');
fs.mkdirSync(OUT, { recursive: true });

// a real staging quote (wedding, has data) for event-scoped screens
const QUOTE = 'a5178208-ee9f-41bd-8b6c-ebcfb87df7fa';

async function shoot(page, name, { fullPage = true } = {}) {
  await page.waitForTimeout(700);                 // let async render settle
  await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage });
}

test('@guide public pages (landing + sign in / sign up)', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await page.goto('/index.html'); await shoot(page, '01-landing');
    await page.goto('/login.html'); await shoot(page, '02-signin-signup');
  } finally { await ctx.close(); }
});

test('@guide authenticated screens (admin walkthrough)', async ({ browser }) => {
  // 19 full-page screenshots on free-tier staging do not fit the 60 s default test budget.
  test.setTimeout(300_000);
  const { context, page } = await authedPage(browser, 'admin');
  try {
    const screens = [
      ['dashboard.html', '03-dashboard'],
      ['leads.html', '04-leads-pipeline'],
      ['crm.html', '05-crm-archive'],
      [`flow.html?quote=${QUOTE}`, '06-event-flow'],
      [`discovery.html?quote=${QUOTE}`, '07-discovery'],
      [`quotes.html`, '08-quotes-list'],
      [`proposal.html?quote=${QUOTE}`, '09-proposal'],
      [`plan.html?quote=${QUOTE}`, '10-planning'],
      [`logistics.html?quote=${QUOTE}`, '11-logistics-payments'],
      [`settlement.html?quote=${QUOTE}`, '12-settlement'],
      [`closure.html?quote=${QUOTE}`, '13-closure-pl'],
      ['staff.html', '14-staff'],
      ['inventory.html', '15-inventory'],
      ['vendors.html', '16-vendors'],
      ['control.html', '17-control-center'],
      // the builder is a full-window canvas app: its toolbar heading is not visible (wait for the Save button), and a
      // fullPage screenshot of it took ~267 s on staging (trace, R144) - a window-sized shot shows the same layout
      [`builder.html?quote=${QUOTE}`, '19-builder-layout', { ready: '#saveBtn', fullPage: false }],
      [`command.html?quote=${QUOTE}`, '20-event-day-command'],
      [`runsheet.html?quote=${QUOTE}`, '21-runsheet'],
      [`budget.html?quote=${QUOTE}`, '22-budget'],
    ];
    for (const [p, name, opt = {}] of screens) {
      await page.goto('/' + p);
      // every screen renders a visible top-level heading once its shell has booted; wait for that (or the screen's
      // own ready selector) instead of networkidle - realtime/polling pages may never go idle, which burned the budget.
      await page.locator(opt.ready || 'h1:visible').first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
      await shoot(page, name, { fullPage: opt.fullPage !== false });
    }
  } finally { await context.close(); }
});

test('@guide client approval page (public, token-based)', async ({ browser }) => {
  // mint a real approval token for the canonical quote so the page renders its flow
  let tok = '';
  try { tok = String(await rpcAs('planner', 'generate_approval_token', { p_quote_id: QUOTE })).replace(/"/g, ''); } catch {}
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await page.goto(tok ? `/approve.html?token=${tok}` : '/approve.html');
    await shoot(page, '18-client-approval');
  } finally { await ctx.close(); }
});
