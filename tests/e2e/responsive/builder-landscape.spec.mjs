// @responsive R154i - the 2D/3D floor builder on a PHONE held sideways (and the portrait "turn your phone" card).
// Needs NO credentials and NO network, like no-overflow-local.spec.mjs: every request that is not this local server
// is blocked and config.js is served with the Supabase url + key blanked, so the builder runs in its local mode.
// Nothing is saved anywhere and the photo render is only OPENED (never started).
// For each landscape phone: no page scroll, the top bar folded away (R164: floating controls), the canvas gets the screen, the key controls
// are inside the screen and never overlap, touch targets >= 40px, the toolbox / inspector are slide-over drawers,
// dialogs fit the height and scroll inside, two fingers zoom the 2D floor, rotating keeps the state and re-fits
// (2D zoom + 3D renderer size), and tablets / desktop keep their layout.
// Screenshots: set HELM_LANDSCAPE_SHOTS=<dir> to keep them (otherwise they go to the test output folder).
// One extra check runs SIGNED IN against STAGING (never production) when the harness env is set: it only opens the
// builder (no quote, nothing saved) and repeats the overlap check with the real studio header.
// Run: npx playwright test tests/e2e/responsive/builder-landscape.spec.mjs --project=chromium
import { test, expect, devices } from '@playwright/test';
import { mkdirSync, existsSync } from 'node:fs';
import { statePath } from '../helpers/session.mjs';
import { STAGING_URL, STAGING_ANON } from '../helpers/env.mjs';
import { join } from 'node:path';

const LAND_Q = '(orientation:landscape) and (max-height:500px) and (pointer:coarse)';
const phone = (w, h, dpr = 3) => ({ viewport: { width: w, height: h }, screen: { width: w, height: h }, isMobile: true, hasTouch: true, deviceScaleFactor: dpr });
const strip = (d) => { const { defaultBrowserType, ...o } = d; return o; };   // eslint-disable-line no-unused-vars
const LANDSCAPE = {
  'iphone14-landscape': strip(devices['iPhone 14 landscape']),
  'pixel7-landscape': strip(devices['Pixel 7 landscape']),
  'phone-844x390': phone(844, 390),
  'phone-932x430': phone(932, 430),
  'phone-667x375': phone(667, 375, 2),
  'android-915x412': phone(915, 412, 2.6),
};

async function offline(context) {
  await context.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (!/^(127\.0\.0\.1|localhost)$/.test(u.hostname)) return route.abort();
    if (/\/config(\.staging)?\.js$/.test(u.pathname)) {
      const r = await route.fetch();
      return route.fulfill({ response: r, body: (await r.text()) + '\n;try{window.SUPABASE_CONFIG.url="";window.SUPABASE_CONFIG.anonKey="";}catch(e){}\n' });
    }
    return route.continue();
  });
  // no auto tour / walkthrough hints in the way
  await context.addInitScript(() => { try { localStorage.setItem('bp_seen_tour', '1'); localStorage.setItem('helm_tour_seen_builder', '1'); } catch (e) {} });
}
async function openBuilder(browser, opts) {
  const context = await browser.newContext(opts);
  await offline(context);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  await page.goto('/builder.html?preset=wedding_banquet');
  await page.waitForFunction(() => window.BPStore && typeof store !== 'undefined' && document.getElementById('svg') && !document.documentElement.classList.contains('auth-pending'), null, { timeout: 30_000 });
  await page.waitForTimeout(1200);
  return { context, page, errors };
}
function shotDir(info) {
  const d = process.env.HELM_LANDSCAPE_SHOTS || info.outputPath('shots');
  mkdirSync(d, { recursive: true });
  return d;
}

// ---- geometry helpers (run in the page) ----
const RECTS = (sels) => sels.map((s) => {
  const n = document.querySelector(s); if (!n || !n.getClientRects().length) return { s, missing: true };
  const cs = getComputedStyle(n); if (cs.visibility === 'hidden' || cs.display === 'none') return { s, missing: true };
  const r = n.getBoundingClientRect(); return { s, l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height };
});
const inside = (r, vw, vh) => r.l >= -0.5 && r.t >= -0.5 && r.r <= vw + 0.5 && r.b <= vh + 0.5;
const overlaps = (a, b) => Math.min(a.r, b.r) - Math.max(a.l, b.l) > 1 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 1;
function assertNoOverlap(rects, vw, vh, label) {
  const shown = rects.filter((r) => !r.missing);
  for (const r of shown) expect(inside(r, vw, vh), `${label}: ${r.s} inside the screen ${JSON.stringify(r)}`).toBe(true);
  for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++) {
    expect(overlaps(shown[i], shown[j]), `${label}: ${shown[i].s} must not overlap ${shown[j].s}`).toBe(false);
  }
}
// controls that must always be on screen on a sideways phone - R164: the floating ones (builder-immersive.js); the top bar
// is folded behind More, the zoom / fit / full screen / tour buttons are stacked on the right edge
const KEY_CONTROLS = ['#bimBack', '#bimTools', '#bimInsp', '#bimMore', '#bimSave', '#bimRail', '#status', '#zoomOut', '#zoomLbl', '#zoomIn', '#zoomFit', '.fabstack .fs-fab', '.fabstack .htour-fab'];

test.describe('@responsive builder on a phone held sideways (local, no sign-in)', () => {
  test.beforeEach(({ browserName }) => { test.skip(browserName !== 'chromium', 'phone emulation (isMobile / touch) is Chromium-only in Playwright'); });

  for (const [name, opts] of Object.entries(LANDSCAPE)) {
    test(`landscape ${name}: usable, nothing overlaps`, async ({ browser }, info) => {
      test.setTimeout(120_000);
      const dir = shotDir(info);
      const { context, page, errors } = await openBuilder(browser, opts);
      try {
        const vw = opts.viewport.width, vh = opts.viewport.height;
        expect(await page.evaluate((q) => matchMedia(q).matches, LAND_Q), 'landscape phone media query').toBe(true);
        // no "turn your phone" card sideways
        expect(await page.locator('#orientCard').isVisible().catch(() => false)).toBe(false);
        // the page itself never scrolls (pinch / drag stay on the canvas)
        const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, w: innerWidth, h: innerHeight,
          hdr: document.querySelector('header').getBoundingClientRect().bottom, hdrVis: getComputedStyle(document.querySelector('header')).visibility, vp: document.querySelector('.viewport').getBoundingClientRect().toJSON(),
          sc: document.getElementById('scroll').getBoundingClientRect().toJSON() }));
        expect(m.sw, 'no sideways page scroll').toBeLessThanOrEqual(m.w);
        expect(m.sh, 'no up/down page scroll').toBeLessThanOrEqual(m.h);
        expect(m.hdr, 'R164: the top bar is folded away (More opens it)').toBeLessThanOrEqual(1);
        expect(m.hdrVis).toBe('hidden');
        expect(m.vp.width, 'the canvas spans the screen (panels are drawers)').toBeGreaterThanOrEqual(vw - 1);
        expect(m.vp.height, 'R164: the canvas gets the whole height').toBeGreaterThanOrEqual(vh - 1);
        expect(m.sc.height, 'the 2D floor area is most of the screen').toBeGreaterThanOrEqual(vh * 0.85);
        assertNoOverlap(await page.evaluate(RECTS, KEY_CONTROLS), vw, vh, name + ' 2D');
        // touch targets: header controls in view + the dock
        const small = await page.evaluate(() => [...document.querySelectorAll('.bim-b, .zoombar button, .fabstack .fs-fab, .fabstack .htour-fab')]
          .filter((n) => n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden' && !n.closest('.hmenu-pop'))
          .map((n) => ({ id: n.id || n.textContent.trim().slice(0, 16), h: n.getBoundingClientRect().height })).filter((x) => x.h < 40 - 0.5));
        expect(small, 'touch targets at least 40px tall').toEqual([]);
        // objects on the floor take the finger (drag), the floor itself pans natively
        expect(await page.evaluate(() => { const o = document.querySelector('#svg .obj'); return o ? getComputedStyle(o).touchAction : 'none'; })).toBe('none');
        expect(await page.evaluate(() => getComputedStyle(document.getElementById('scroll')).touchAction)).toBe('pan-x pan-y');
        await page.screenshot({ path: join(dir, `${name}-2d.png`) });

        // toolbox drawer: slides over, fits, closes on an outside tap
        await page.locator('#bimTools').tap();
        await page.waitForTimeout(350);
        let r = await page.evaluate(RECTS, ['#leftPanel']);
        expect(r[0].missing, 'toolbox drawer open').toBeFalsy();
        expect(inside(r[0], vw, vh), 'toolbox drawer inside the screen').toBe(true);
        expect(r[0].w, 'toolbox drawer leaves part of the floor visible').toBeLessThanOrEqual(vw * 0.6);
        await page.screenshot({ path: join(dir, `${name}-tools-drawer.png`) });
        await page.touchscreen.tap(Math.round(vw * 0.7), Math.round(vh / 2));   // the floor beside the drawer (not the zoom rail)
        await page.waitForTimeout(350);
        expect(await page.evaluate(() => document.getElementById('leftPanel').classList.contains('open'))).toBe(false);
        // inspector / price drawer
        await page.locator('#bimInsp').tap();
        await page.waitForTimeout(350);
        r = await page.evaluate(RECTS, ['#rightPanel']);
        expect(inside(r[0], vw, vh), 'inspector drawer inside the screen').toBe(true);
        expect(await page.evaluate(() => { const a = document.getElementById('rightPanel'); return a.scrollHeight <= a.clientHeight + 1 || getComputedStyle(a).overflowY === 'auto'; }), 'inspector scrolls inside').toBe(true);
        await page.screenshot({ path: join(dir, `${name}-inspector-drawer.png`) });
        await page.touchscreen.tap(Math.round(vw * 0.25), Math.round(vh / 2));   // outside tap closes it
        await page.waitForTimeout(300);
        expect(await page.evaluate(() => document.getElementById('rightPanel').classList.contains('open'))).toBe(false);
        await page.waitForTimeout(300);

        // two fingers zoom the 2D floor (and do not scroll the page)
        const z0 = await page.evaluate(() => store.view.zoom);
        await page.evaluate(() => {
          const el = document.getElementById('scroll'), b = el.getBoundingClientRect(), cx = b.left + b.width / 2, cy = b.top + b.height / 2;
          const t = (id, x) => new Touch({ identifier: id, target: el, clientX: x, clientY: cy });
          const fire = (type, a, c) => el.dispatchEvent(new TouchEvent(type, { touches: type === 'touchend' ? [] : [t(1, cx - a), t(2, cx + c)], changedTouches: [t(1, cx - a), t(2, cx + c)], bubbles: true, cancelable: true }));
          fire('touchstart', 40, 40); fire('touchmove', 60, 60); fire('touchmove', 90, 90); fire('touchend', 90, 90);
        });
        const z1 = await page.evaluate(() => store.view.zoom);
        expect(z1, 'pinch out zooms in').toBeGreaterThan(z0 * 1.5);
        expect(await page.evaluate(() => document.documentElement.scrollTop + document.body.scrollTop)).toBe(0);
        await page.locator('#zoomFit').tap();

        // dialogs fit the short screen and scroll inside: Create layout (the tallest), Open, photo render (opened only)
        const checkDialog = async (modalSel, shot) => {
          const d = await page.evaluate((s) => { const m = document.querySelector(s); const sh = m.querySelector('.sheet,.lw-sheet'); const body = sh.querySelector('.sheet-body,.lw-body') || sh;
            const r = sh.getBoundingClientRect(), head = sh.querySelector('.sheet-head,.lw-head'); const hr = head ? head.getBoundingClientRect() : r;
            return { l: r.left, t: r.top, r: r.right, b: r.bottom, headTop: hr.top, scrollable: body.scrollHeight <= body.clientHeight + 1 || /auto|scroll/.test(getComputedStyle(body).overflowY) }; }, modalSel);
          expect(inside(d, vw, vh), `${modalSel} fits inside the screen`).toBe(true);
          expect(d.headTop, `${modalSel} title + close stay visible`).toBeGreaterThanOrEqual(0);
          expect(d.scrollable, `${modalSel} scrolls inside`).toBe(true);
          await page.screenshot({ path: join(dir, `${name}-${shot}.png`) });
        };
        await page.evaluate(() => document.getElementById('customBtn').click());
        await page.waitForTimeout(400);
        const customSel = await page.evaluate(() => { const lw = document.querySelector('.lw-modal:not([hidden])'); if (lw) return '.lw-modal:not([hidden])'; return '#customModal'; });
        await checkDialog(customSel, 'dialog-create-layout');
        await page.keyboard.press('Escape');
        await page.evaluate(() => document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }));
        await page.evaluate(() => document.getElementById('loadBtn').click());
        await page.waitForTimeout(300);
        await checkDialog('#loadModal', 'dialog-open');
        await page.evaluate(() => { document.getElementById('loadModal').hidden = true; });
        await page.evaluate(() => document.querySelector('#viewSeg [data-v="render"]').click());   // opens the dialog only - "Create photo" is never pressed
        await page.waitForTimeout(600);
        if (await page.locator('#photoModal').isVisible()) {
          await checkDialog('#photoModal', 'dialog-photo-render');
          await page.locator('#photoX').tap();
        }
        // template "Save as template" dialog (studio templates), if this build offers it here
        const canSave = await page.evaluate(() => !!(window.HelmStudioTemplates && HelmStudioTemplates.openSave));
        if (canSave) {
          await page.evaluate(() => { try { HelmStudioTemplates.openSave(); } catch (e) {} });
          await page.waitForTimeout(400);
          if (await page.locator('#stSaveModal').isVisible().catch(() => false)) { await checkDialog('#stSaveModal', 'dialog-save-template'); await page.evaluate(() => { const m = document.getElementById('stSaveModal'); if (m) m.remove(); }); }
        }

        // 3D: the renderer fills the stage; the Move / Rotate / Scale bar and the dock do not overlap
        await page.evaluate(() => document.querySelector('#viewSeg [data-v="3d"]').click());
        const has3d = await page.waitForFunction(() => { const st = document.getElementById('stage3d'), c = document.getElementById('scene3d');
          return st && !st.hidden && c && c.width > 0 && Math.abs(c.getBoundingClientRect().width - st.clientWidth) < 2; }, null, { timeout: 20_000 }).then(() => true).catch(() => false);
        if (has3d) {
          await page.waitForTimeout(800);
          assertNoOverlap(await page.evaluate(RECTS, ['#tools3d', '#zoomOut', '#zoomIn', '#zoomFit', '.fabstack .fs-fab', '.fabstack .htour-fab', '#bimBack', '#bimTools', '#bimInsp', '#bimMore', '#bimSave', '#bimRail']), vw, vh, name + ' 3D');
          const small3d = await page.evaluate(() => [...document.querySelectorAll('#tools3d button')].filter((b) => b.getClientRects().length).map((b) => b.getBoundingClientRect().height).filter((hh) => hh < 39.5));
          expect(small3d, '3D Move / Rotate / Scale buttons at least 40px').toEqual([]);
          await page.screenshot({ path: join(dir, `${name}-3d.png`) });
          await page.evaluate(() => document.querySelector('#viewSeg [data-v="2d"]').click());
          await page.waitForTimeout(400);
        }
        expect(errors, 'no page errors').toEqual([]);
      } finally { await context.close(); }
    });
  }

  test('rotating keeps the state, re-fits the 2D floor and resizes the 3D view', async ({ browser }, info) => {
    test.setTimeout(120_000);
    const dir = shotDir(info);
    const { context, page, errors } = await openBuilder(browser, phone(844, 390));
    try {
      const before = await page.evaluate(() => ({ n: store.items.length, name: document.getElementById('projName').value }));
      await page.evaluate(() => { const it = makeItem('stage', 20, 20, {}); store.items.push(it); commit(); renderAll(); });
      const n1 = await page.evaluate(() => store.items.length);
      expect(n1).toBe(before.n + 1);
      // turn to portrait: the card appears, nothing is lost
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(600);
      await expect(page.locator('#orientCard')).toBeVisible();
      await page.screenshot({ path: join(dir, 'rotate-to-portrait-card.png') });
      expect(await page.evaluate(() => store.items.length)).toBe(n1);
      // back to landscape: the card goes away by itself, the floor is re-fitted to the wide screen
      await page.setViewportSize({ width: 844, height: 390 });
      await page.waitForTimeout(700);
      await expect(page.locator('#orientCard')).toBeHidden();
      const fit = await page.evaluate(() => { const zx = (scrollEl.clientWidth - 40) / (WORLD.w * PX_PER_FT), zy = (scrollEl.clientHeight - 40) / (WORLD.h * PX_PER_FT);
        return { zoom: store.view.zoom, want: Math.min(zx, zy), atFit: viewAtFit }; });
      expect(fit.atFit).toBe(true);
      expect(Math.abs(fit.zoom - fit.want) / fit.want, '2D floor re-fitted after the rotation').toBeLessThan(0.05);
      expect(await page.evaluate(() => store.items.length)).toBe(n1);
      // 3D: rotate while in 3D -> renderer size + camera aspect follow the stage
      await page.evaluate(() => document.querySelector('#viewSeg [data-v="3d"]').click());
      const ok3d = await page.waitForFunction(() => { const st = document.getElementById('stage3d'), c = document.getElementById('scene3d'); return st && !st.hidden && c && c.width > 0; }, null, { timeout: 20_000 }).then(() => true).catch(() => false);
      if (ok3d) {
        for (const [w, h] of [[932, 430], [667, 375]]) {
          await page.setViewportSize({ width: w, height: h });
          await page.waitForTimeout(700);
          const s = await page.evaluate(() => { const st = document.getElementById('stage3d'), c = document.getElementById('scene3d'), cr = c.getBoundingClientRect();
            const v = window.__helm3D && __helm3D.getView ? __helm3D.getView() : null;
            return { sw: st.clientWidth, sh: st.clientHeight, cw: cr.width, ch: cr.height, aspect: v && v.aspect }; });
          expect(Math.abs(s.cw - s.sw), `3D canvas width follows the stage at ${w}x${h}`).toBeLessThan(2);
          expect(Math.abs(s.ch - s.sh), `3D canvas height follows the stage at ${w}x${h}`).toBeLessThan(2);
          if (s.aspect) expect(Math.abs(s.aspect - s.sw / s.sh), 'camera aspect = stage aspect').toBeLessThan(0.02);
        }
        await page.screenshot({ path: join(dir, 'rotate-3d-667x375.png') });
      }
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });

  test('portrait phone: "turn your phone" card, Continue anyway is remembered, the builder still works', async ({ browser }, info) => {
    const dir = shotDir(info);
    const { context, page, errors } = await openBuilder(browser, strip(devices['iPhone 14']));
    try {
      const card = page.locator('#orientCard');
      await expect(card).toBeVisible();
      await expect(card.getByRole('heading', { name: /Turn your phone sideways/ })).toBeVisible();
      await expect(page.locator('#orientContinue')).toBeFocused();
      const box = await page.locator('#orientContinue').boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(40);
      await page.screenshot({ path: join(dir, 'iphone14-portrait-card.png') });
      await page.locator('#orientContinue').tap();
      await expect(card).toBeHidden();
      expect(await page.evaluate(() => sessionStorage.getItem('helm.builder.portraitOk'))).toBe('1');
      // R164: upright too the floor is the full-screen editor; Tools floats top-left and opens the drawer
      await page.locator('#bimTools').tap();
      await page.waitForTimeout(300);
      expect(await page.evaluate(() => document.getElementById('leftPanel').classList.contains('open'))).toBe(true);
      await page.screenshot({ path: join(dir, 'iphone14-portrait-continue.png') });
      // same tab: not asked again
      await page.reload();
      await page.waitForFunction(() => window.BPStore && typeof store !== 'undefined', null, { timeout: 30_000 });
      await page.waitForTimeout(800);
      await expect(card).toBeHidden();
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });

  for (const [name, opts, expectDrawers] of [
    ['ipad-portrait', strip(devices['iPad (gen 7)']), false],
    ['ipad-landscape', strip(devices['iPad (gen 7) landscape']), false],
    ['desktop-1440', { viewport: { width: 1440, height: 900 } }, false],
  ]) {
    test(`${name}: no card, side panels unchanged`, async ({ browser }, info) => {
      const dir = shotDir(info);
      const { context, page, errors } = await openBuilder(browser, opts);
      try {
        expect(await page.evaluate((q) => matchMedia(q).matches, LAND_Q)).toBe(false);
        await expect(page.locator('#orientCard')).toHaveCount(0);
        const s = await page.evaluate(() => ({ drawers: DRAWER_MQ.matches, btns: getComputedStyle(document.querySelector('.drawer-btns')).display,
          bim: ['#bimTL', '#bimTR', '#bimRail', '#bimNav'].map((q) => getComputedStyle(document.querySelector(q)).display), hdrPos: getComputedStyle(document.querySelector('header')).position,
          left: getComputedStyle(document.getElementById('leftPanel')).position, sw: document.documentElement.scrollWidth, w: innerWidth }));
        expect(s.drawers).toBe(expectDrawers);
        expect(s.btns).toBe('none');
        expect(s.left).toBe('static');
        expect(s.bim, 'R164: no floating phone controls here').toEqual(['none', 'none', 'none', 'none']);
        expect(s.hdrPos, 'the top bar stays in place').not.toBe('fixed');
        expect(s.sw).toBeLessThanOrEqual(s.w);
        await page.screenshot({ path: join(dir, `${name}.png`) });
        expect(errors).toEqual([]);
      } finally { await context.close(); }
    });
  }

  test('@staging signed-in builder sideways: nothing overlaps (staging only, read-only)', async ({ browser }, info) => {
    test.skip(!STAGING_URL || !STAGING_ANON || !existsSync(statePath('admin')), 'needs the staging E2E env (HELM_E2E_*) + global-setup state');
    test.setTimeout(120_000);
    const dir = shotDir(info);
    const context = await browser.newContext({ ...phone(844, 390), storageState: statePath('admin') });
    const page = await context.newPage();
    const prod = [];
    page.on('request', (r) => { if (r.url().includes('nqltzgiwznphugcfhmbm')) prod.push(r.url()); });
    await page.addInitScript(([u, a]) => { window.HELM_STAGING_SUPABASE = { url: u, anonKey: a }; try { localStorage.setItem('helm_tour_seen_builder', '1'); } catch (e) {} }, [STAGING_URL, STAGING_ANON]);
    try {
      await page.goto('/builder.html');
      await page.waitForFunction(() => window.BPStore && typeof store !== 'undefined' && !document.documentElement.classList.contains('auth-pending'), null, { timeout: 30_000 });
      await page.waitForTimeout(2500);
      expect(await page.evaluate(() => window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.url)).toContain('xizehqgeyjcfpzrdymly');
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, w: innerWidth, h: innerHeight, hdr: document.querySelector('header').getBoundingClientRect().bottom }));
      expect(m.sw).toBeLessThanOrEqual(m.w);
      expect(m.sh).toBeLessThanOrEqual(m.h);
      expect(m.hdr, 'R164: the top bar is folded away').toBeLessThanOrEqual(1);
      assertNoOverlap(await page.evaluate(RECTS, KEY_CONTROLS), 844, 390, 'staging 844x390');
      await page.screenshot({ path: join(dir, 'staging-signed-in-844x390.png') });
      await page.locator('#bimInsp').tap();
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(dir, 'staging-signed-in-inspector.png') });
      expect(prod, 'zero requests to production').toEqual([]);
    } finally { await context.close(); }
  });
});
