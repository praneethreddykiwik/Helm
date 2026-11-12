// @coverage — quotes.html (Quotes & Confirmations list; previously uncovered screen).
// Item 4 (empty create form) is N/A here: this screen is a list; the "New quote" control (a
// <button id="newBtn" data-newquote>, no longer a link) starts the dashboard flow, and the pricing/confirm
// modal requires selecting an existing quote row, so there is no standalone create form to submit empty.
// Items 1–3 are covered.
import { test, expect } from '@playwright/test';
import { requireStagingEnv } from '../helpers/env.mjs';
import { openScreen, assertNotRedirectedToLogin, assertScreenRendered, assertNoConsoleErrors } from './_coverage-utils.mjs';

test.beforeAll(() => requireStagingEnv());

test('@coverage quotes loads authenticated, clean console, key controls render', async ({ browser }) => {
  const { context, page, consoleErrors } = await openScreen(browser, 'admin', '/quotes.html');
  try {
    assertNotRedirectedToLogin(page);
    await assertScreenRendered(page);
    assertNoConsoleErrors(consoleErrors);

    // Item 3 — the primary "New quote" control plus list controls exist.
    // "New quote" is a <button id="newBtn" data-newquote> now (public/quotes.html), not a link.
    const newQuote = page.locator('#newBtn[data-newquote]');
    await expect(newQuote, 'the New quote control must be present').toBeVisible();
    await expect(newQuote).toHaveText(/new quote/i);
    await expect(page.locator('#search'), 'the quotes search/filter must render').toBeVisible();
  } finally { await context.close(); }
});
