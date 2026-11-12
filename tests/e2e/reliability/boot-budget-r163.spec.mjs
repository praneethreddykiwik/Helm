// @smoke R163 - page boot budget on localhost -> STAGING (prod 12 Nov: "almost all signed-in pages take a very long time to
// load"). For Home, Quotes, the event workspace, the quote flow and the builder: the page paints within a budget, the
// expensive feeds are asked for at most once per load (bell_feed, my_pending, my_open_quotes per argument set), the bell is
// never asked for BEFORE the page's own first data, and there are no page errors. The event workspace shows its header
// while the module cards are still filling in. Read-only: nothing is written. Needs HELM_E2E_* staging env.
// Run: npx playwright test --project=chromium tests/e2e/reliability/boot-budget-r163.spec.mjs
import { test, expect } from '@playwright/test';
import { authedPage } from '../helpers/session.mjs';
import { requireStagingEnv } from '../helpers/env.mjs';
import { assertStagingOnly } from '../helpers/staging.mjs';

test.beforeAll(() => requireStagingEnv());
test.describe.configure({ timeout: 180_000 });
const STG = 'xizehqgeyjcfpzrdymly';
const PAINT_MS = Number(process.env.HELM_E2E_PAINT_MS || 8000);    // generous: a remote staging DB, ~0.3 s per round trip
const MAX_CALLS = Number(process.env.HELM_E2E_MAX_CALLS || 140);   // the whole first 10 s of a page, every Supabase request

function record(page) {
  const log = [];
  const on = (r) => { const u = r.url(); if (!u.includes(STG)) return; let body = ''; try { body = r.postData() || ''; } catch (e) {}
    log.push({ t: Date.now(), path: u.replace(/^https:\/\/[^/]+/, '').split('?')[0], body }); };
  page.on('request', on);
  return { log, stop: () => page.off('request', on) };
}
const count = (log, rpc) => log.filter((x) => x.path === '/rest/v1/rpc/' + rpc).length;
const perArgs = (log, rpc) => { const m = new Map(); for (const x of log.filter((x) => x.path === '/rest/v1/rpc/' + rpc)) m.set(x.body, (m.get(x.body) || 0) + 1); return Math.max(0, ...m.values()); };

test('@smoke boot budget: paint fast, each heavy feed once, bell after the page data', async ({ browser }) => {
  const errs = [];
  const { page, context } = await authedPage(browser, 'admin');
  page.on('pageerror', (e) => errs.push(page.url() + ': ' + (e && e.message || e)));
  await assertStagingOnly(page);
  // an event to open: the first quote the studio has
  const evId = await page.evaluate(async () => { try { const l = await BPStore.quotes.list(); return (l && l[0] && l[0].id) || ''; } catch (e) { return ''; } });

  const pages = [
    { url: '/dashboard.html', ready: '#main, main' },
    { url: '/quotes.html', ready: '#main, main' },
    ...(evId ? [{ url: '/event.html?id=' + evId, ready: '#evHead' }] : []),
    { url: '/flow.html', ready: 'main, #main' },
    { url: '/builder.html', ready: 'canvas, #stage, main' },
  ];
  for (const p of pages) {
    const rec = record(page); const t0 = Date.now();
    await page.goto(p.url, { waitUntil: 'domcontentloaded' });
    await page.locator(p.ready).first().waitFor({ state: 'visible', timeout: PAINT_MS });
    const paint = Date.now() - t0;
    await page.waitForTimeout(10_000);
    rec.stop();
    const firstOwn = rec.log.find((x) => !/\/rpc\/(bell_feed|chat_|my_notification_)/.test(x.path) && !/chat_(members|conversations|messages|prefs)/.test(x.path));
    const bell = rec.log.find((x) => x.path === '/rest/v1/rpc/bell_feed');
    console.log(`${p.url}: paint ${paint} ms, ${rec.log.length} calls, bell_feed x${count(rec.log, 'bell_feed')}, my_pending x${count(rec.log, 'my_pending')}, my_open_quotes max x${perArgs(rec.log, 'my_open_quotes')}`);
    expect(paint, p.url + ' paints within budget').toBeLessThan(PAINT_MS);
    expect(rec.log.length, p.url + ' total calls').toBeLessThanOrEqual(MAX_CALLS);
    expect(count(rec.log, 'bell_feed'), p.url + ' bell once').toBeLessThanOrEqual(1);
    expect(count(rec.log, 'my_pending'), p.url + ' my_pending once').toBeLessThanOrEqual(1);
    expect(perArgs(rec.log, 'my_open_quotes'), p.url + ' my_open_quotes once per argument set').toBeLessThanOrEqual(1);
    if (bell && firstOwn) expect(bell.t, p.url + ' bell after the page data started').toBeGreaterThanOrEqual(firstOwn.t);
  }
  expect(page.__prodHits).toEqual([]);
  expect(errs).toEqual([]);
  await context.close();
});
