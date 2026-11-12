// @responsive R164 - the floor builder on a PHONE (upright or sideways) as a full-screen editor with floating controls,
// a real full-screen mode (Fullscreen API, or the app-level immersive mode where the browser has none - iPhone Safari),
// the app's bottom tab bar folded away in the builder, and the zoom buttons working in and out of full screen.
// Needs NO credentials and NO network (like builder-landscape.spec.mjs): every request that is not this local server is
// blocked and config.js is served with the Supabase url + key blanked. Nothing is saved; the photo render is never started.
// For each device: floating controls inside the screen, never intersecting, touch targets >= 40px; zoom + / - / FIT change
// the zoom in 2D and the camera in 3D, in and out of full screen; full screen enters and exits (native + immersive
// fallback); the bottom tab bar is hidden in the builder on phones (the handle brings it up); zero page errors.
// iPad and desktop: unchanged layout (no floating phone controls), and the full-screen zoom still works.
// Screenshots: HELM_IMMERSIVE_SHOTS=<dir> keeps them (otherwise the test output folder).
// Run: npx playwright test tests/e2e/responsive/builder-immersive.spec.mjs --project=chromium
import { test, expect, devices } from '@playwright/test';
import { mkdirSync, existsSync } from 'node:fs';
import { statePath } from '../helpers/session.mjs';
import { STAGING_URL, STAGING_ANON } from '../helpers/env.mjs';
import { join } from 'node:path';

const PHONE_Q = '(pointer:coarse) and (orientation:landscape) and (max-height:500px), (pointer:coarse) and (orientation:portrait) and (max-width:599px)';
const strip = (d) => { const { defaultBrowserType, ...o } = d; return o; };   // eslint-disable-line no-unused-vars
const phone = (w, h, dpr = 3) => ({ viewport: { width: w, height: h }, screen: { width: w, height: h }, isMobile: true, hasTouch: true, deviceScaleFactor: dpr });
const PHONES = {
  'iphone14-landscape': strip(devices['iPhone 14 landscape']),
  'iphone14-portrait': strip(devices['iPhone 14']),
  'pixel7-landscape': strip(devices['Pixel 7 landscape']),
  'phone-667x375': phone(667, 375, 2),
};
const BIG = {
  'ipad-landscape': strip(devices['iPad (gen 7) landscape']),
  'ipad-portrait': strip(devices['iPad (gen 7)']),
  'desktop-1440': { viewport: { width: 1440, height: 900 } },
};

async function open(browser, opts, { noFullscreenApi = false } = {}) {
  const context = await browser.newContext(opts);
  await context.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (!/^(127\.0\.0\.1|localhost)$/.test(u.hostname)) return route.abort();
    if (/\/config(\.staging)?\.js$/.test(u.pathname)) {
      const r = await route.fetch();
      return route.fulfill({ response: r, body: (await r.text()) + '\n;try{window.SUPABASE_CONFIG.url="";window.SUPABASE_CONFIG.anonKey="";}catch(e){}\n' });
    }
    return route.continue();
  });
  await context.addInitScript(() => { try { localStorage.setItem('bp_seen_tour', '1'); localStorage.setItem('helm_tour_seen_builder', '1'); sessionStorage.setItem('helm.builder.portraitOk', '1'); } catch (e) {} });
  if (noFullscreenApi) {
    // iPhone Safari: no element fullscreen at all -> fullscreen.js must fall back to the app-level immersive mode
    await context.addInitScript(() => {
      delete Element.prototype.requestFullscreen; delete Element.prototype.webkitRequestFullscreen;
      Object.defineProperty(Document.prototype, 'fullscreenEnabled', { get() { return false; } });
    });
  }
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  await page.goto('/builder.html?preset=wedding_banquet');
  await page.waitForFunction(() => window.BPStore && typeof store !== 'undefined' && document.getElementById('svg') && !document.documentElement.classList.contains('auth-pending'), null, { timeout: 30_000 });
  await page.waitForTimeout(1200);
  return { context, page, errors };
}
const shotDir = (info) => { const d = process.env.HELM_IMMERSIVE_SHOTS || info.outputPath('shots'); mkdirSync(d, { recursive: true }); return d; };

// ---- geometry (in the page) ----
const RECTS = (sels) => sels.map((s) => {
  const n = document.querySelector(s); if (!n || !n.getClientRects().length) return { s, missing: true };
  const cs = getComputedStyle(n); if (cs.visibility === 'hidden' || cs.display === 'none') return { s, missing: true };
  const r = n.getBoundingClientRect(); return { s, l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height };
});
const inside = (r, vw, vh) => r.l >= -0.5 && r.t >= -0.5 && r.r <= vw + 0.5 && r.b <= vh + 0.5;
const overlaps = (a, b) => Math.min(a.r, b.r) - Math.max(a.l, b.l) > 1 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 1;
function assertLayout(rects, vw, vh, label) {
  const shown = rects.filter((r) => !r.missing);
  for (const r of shown) expect(inside(r, vw, vh), `${label}: ${r.s} inside the screen ${JSON.stringify(r)}`).toBe(true);
  for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++) {
    expect(overlaps(shown[i], shown[j]), `${label}: ${shown[i].s} must not overlap ${shown[j].s}`).toBe(false);
  }
}
// every floating control group / button on a phone (2D)
const FLOATING = ['#bimBack', '#bimExit', '#bimTools', '#bimInsp', '#bimMore', '#bimSave', '#bimRail', '.zoombar', '.fabstack .fs-fab', '.fabstack .htour-fab', '#status', '#bimNav'];
const FLOATING_3D = ['#bimBack', '#bimExit', '#bimTools', '#bimInsp', '#bimMore', '#bimSave', '#bimRail', '.zoombar', '.fabstack .fs-fab', '.fabstack .htour-fab', '#tools3d', '#bimNav'];
const smallTargets = () => [...document.querySelectorAll('.bim-b, .zoombar button, .fabstack .fs-fab, .fabstack .htour-fab, #tools3d button')]
  .filter((n) => n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden' && getComputedStyle(n).display !== 'none')
  .map((n) => { const r = n.getBoundingClientRect(); return { id: n.id || n.textContent.trim().slice(0, 12), w: r.width, h: r.height }; })
  .filter((x) => x.h < 39.5 || x.w < 39.5);
const zoom2d = (page) => page.evaluate(() => store.view.zoom);
const cam3d = (page) => page.evaluate(() => { const v = window.__helm3D && __helm3D.getView && __helm3D.getView(); if (!v) return null; const [x, y, z] = v.pos, [a, b, c] = v.target; return Math.hypot(x - a, y - b, z - c); });

async function zoomButtonsWork(page, label, tapper) {
  const press = async (id) => { if (tapper) await page.locator(id).tap(); else await page.locator(id).click(); await page.waitForTimeout(450); };
  const is3d = await page.evaluate(() => !!(window.__helm3D && __helm3D.isActive && __helm3D.isActive()));
  const read = is3d ? cam3d : zoom2d;
  const a = await read(page); await press('#zoomIn');
  const b = await read(page); await press('#zoomIn');
  const c = await read(page); await press('#zoomOut');
  const d = await read(page);
  if (is3d) {   // 3D: + moves the camera closer, - further away
    expect(b, `${label}: 3D + dollies in`).toBeLessThan(a - 0.5);
    expect(c, `${label}: 3D + again`).toBeLessThan(b - 0.5);
    expect(d, `${label}: 3D - dollies out`).toBeGreaterThan(c + 0.5);
  } else {
    expect(b, `${label}: + zooms in`).toBeGreaterThan(a * 1.1);
    expect(c, `${label}: + again`).toBeGreaterThan(b * 1.1);
    expect(d, `${label}: - zooms out`).toBeLessThan(c / 1.1);
    expect(await page.evaluate(() => document.getElementById('zoomLbl').textContent), `${label}: the % label follows`).toBe(Math.round(d * 100) + '%');
  }
  await press('#zoomFit');
}
const to3D = async (page) => {
  await page.evaluate(() => { const b = document.getElementById('bimV3d'); if (b && getComputedStyle(b).display !== 'none') b.click(); else document.querySelector('#viewSeg [data-v="3d"]').click(); });
  return page.waitForFunction(() => { const st = document.getElementById('stage3d'), c = document.getElementById('scene3d'); return st && !st.hidden && c && c.width > 0 && window.__helm3D && __helm3D.getView && __helm3D.getView(); }, null, { timeout: 20_000 }).then(() => page.waitForTimeout(900)).then(() => true).catch(() => false);
};
const to2D = async (page) => { await page.evaluate(() => { const b = document.getElementById('bimV2d'); if (b && getComputedStyle(b).display !== 'none') b.click(); else document.querySelector('#viewSeg [data-v="2d"]').click(); }); await page.waitForTimeout(500); };

test.describe('@responsive builder as a full-screen editor on a phone (local, no sign-in)', () => {
  test.beforeEach(({ browserName }) => { test.skip(browserName !== 'chromium', 'phone emulation (isMobile / touch) is Chromium-only in Playwright'); });

  for (const [name, opts] of Object.entries(PHONES)) {
    for (const mode of ['native', 'immersive']) {
      test(`${name} (${mode} full screen): floating controls, zoom, full screen, app bar`, async ({ browser }, info) => {
        test.setTimeout(150_000);
        const dir = shotDir(info);
        const { context, page, errors } = await open(browser, opts, { noFullscreenApi: mode === 'immersive' });
        try {
          const vw = opts.viewport.width, vh = opts.viewport.height;
          expect(await page.evaluate((q) => matchMedia(q).matches, PHONE_Q), 'phone media query').toBe(true);
          // the floor is the whole screen; the top bar is folded away; nothing scrolls the page
          const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, w: innerWidth, h: innerHeight,
            hdrB: document.querySelector('header').getBoundingClientRect().bottom, hdrV: getComputedStyle(document.querySelector('header')).visibility,
            vp: document.querySelector('.viewport').getBoundingClientRect().toJSON() }));
          expect(m.sw).toBeLessThanOrEqual(m.w); expect(m.sh).toBeLessThanOrEqual(m.h);
          expect(m.hdrB, 'top bar folded away').toBeLessThanOrEqual(1); expect(m.hdrV).toBe('hidden');
          expect(m.vp.width).toBeGreaterThanOrEqual(vw - 1); expect(m.vp.height).toBeGreaterThanOrEqual(vh - 1 - (name.includes('portrait') ? 60 : 0));
          // floating controls: all there, inside the screen, never intersecting, >= 40px
          const r = await page.evaluate(RECTS, FLOATING);
          for (const s of ['#bimBack', '#bimTools', '#bimInsp', '#bimMore', '#bimSave', '#bimRail', '.zoombar', '.fabstack .fs-fab']) expect(r.find((x) => x.s === s).missing, s + ' shown').toBeFalsy();
          assertLayout(r, vw, vh, name + ' 2D');
          // the rails: 2D / 3D / Walk stacked on the left, zoom stacked on the right
          const rail = r.find((x) => x.s === '#bimRail'), zb = r.find((x) => x.s === '.zoombar');
          expect(rail.h, '2D / 3D / Walk stacked').toBeGreaterThan(rail.w * 2); expect(rail.l).toBeLessThan(vw / 4);
          expect(zb.h, 'zoom stacked').toBeGreaterThan(zb.w * 2); expect(zb.r).toBeGreaterThan(vw * 3 / 4);
          const zin = await page.evaluate(() => document.getElementById('zoomIn').getBoundingClientRect().top), zout = await page.evaluate(() => document.getElementById('zoomOut').getBoundingClientRect().top);
          expect(zin, 'zoom in above zoom out').toBeLessThan(zout);
          expect(await page.evaluate(smallTargets), 'touch targets >= 40px').toEqual([]);
          await page.screenshot({ path: join(dir, `${name}-${mode}-2d.png`) });

          // the zoom buttons (tap) - out of full screen
          await zoomButtonsWork(page, name + ' 2D', true);

          // More opens the full top bar as a sheet; an outside tap folds it again
          await page.locator('#bimMore').tap(); await page.waitForTimeout(350);
          const sheet = await page.evaluate(() => { const h = document.querySelector('header'); const b = h.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, vis: getComputedStyle(h).visibility, sw: h.scrollWidth, cw: h.clientWidth }; });
          expect(sheet.vis).toBe('visible'); expect(sheet.top).toBeGreaterThanOrEqual(-0.5); expect(sheet.bottom).toBeLessThanOrEqual(vh + 0.5);
          expect(sheet.sw, 'the sheet wraps, no sideways scroll').toBeLessThanOrEqual(sheet.cw + 1);
          await expect(page.locator('#saveBtn')).toBeVisible(); await expect(page.locator('#bimMenuClose')).toBeVisible();
          await page.screenshot({ path: join(dir, `${name}-${mode}-more.png`) });
          await page.touchscreen.tap(Math.round(vw / 2), vh - 12); await page.waitForTimeout(350);
          expect(await page.evaluate(() => document.documentElement.classList.contains('bim-menu'))).toBe(false);

          // Tools / Inspector open the existing drawers (one at a time); an outside tap closes
          await page.locator('#bimTools').tap(); await page.waitForTimeout(350);
          expect(await page.evaluate(() => [document.getElementById('leftPanel').classList.contains('open'), document.getElementById('bimTools').getAttribute('aria-expanded')])).toEqual([true, 'true']);
          await page.touchscreen.tap(Math.round(vw * 0.75), Math.round(vh * 0.85)); await page.waitForTimeout(350);
          expect(await page.evaluate(() => document.getElementById('leftPanel').classList.contains('open'))).toBe(false);
          await page.locator('#bimInsp').tap(); await page.waitForTimeout(350);
          expect(await page.evaluate(() => document.getElementById('rightPanel').classList.contains('open'))).toBe(true);
          const rp = await page.evaluate(() => document.getElementById('rightPanel').getBoundingClientRect().left);
          await page.touchscreen.tap(Math.max(4, Math.round(rp / 2)), Math.round(vh * 0.85)); await page.waitForTimeout(350);
          expect(await page.evaluate(() => document.getElementById('rightPanel').classList.contains('open'))).toBe(false);

          // the app's bottom tab bar (mobile-nav.js, signed-in pages < 768px) is folded away here; the handle brings it up
          await page.addScriptTag({ url: '/mobile-nav.js?v=4' });
          const booted = await page.evaluate(async () => {
            const a = BPStore.auth; a.user = () => ({ id: 'e2e-local' }); a.cachedRole = () => 'admin'; a.canEditArea = async () => true; a.can = async () => true; a.canView = async () => true;
            return window.HelmMobileNav ? HelmMobileNav.boot() : false;
          });
          expect(booted).toBe(true);
          await page.waitForTimeout(300);
          const nav = await page.evaluate(() => { const b = document.getElementById('hmnBar'); return { exists: !!b, wouldShow: innerWidth < 768, shown: !!b && getComputedStyle(b).display !== 'none', handle: getComputedStyle(document.getElementById('bimNav')).display }; });
          expect(nav.exists).toBe(true);
          expect(nav.shown, 'bottom tab bar hidden in the builder').toBe(false);
          if (nav.wouldShow) {
            expect(nav.handle, 'the handle is there').not.toBe('none');
            assertLayout(await page.evaluate(RECTS, FLOATING), vw, vh, name + ' with handle');
            await page.locator('#bimNav').tap(); await page.waitForTimeout(250);
            expect(await page.evaluate(() => getComputedStyle(document.getElementById('hmnBar')).display), 'the handle brings it up').not.toBe('none');
            await page.screenshot({ path: join(dir, `${name}-${mode}-appbar-up.png`) });
            const hb = await page.evaluate(() => [document.getElementById('hmnBar').getBoundingClientRect().toJSON(), document.getElementById('bimNav').getBoundingClientRect().toJSON()]);
            expect(hb[1].bottom, 'handle sits above the bar').toBeLessThanOrEqual(hb[0].top + 0.5);
            await page.locator('#bimNav').tap(); await page.waitForTimeout(250);
            expect(await page.evaluate(() => getComputedStyle(document.getElementById('hmnBar')).display)).toBe('none');
          } else {
            expect(nav.handle, 'no handle where the bar never shows (>= 768px)').toBe('none');
          }

          // full screen: enter from the right rail, everything keeps working, ✕ Exit leaves
          await page.locator('#fsFab').tap(); await page.waitForTimeout(mode === 'immersive' ? 1500 : 900);
          const fs = await page.evaluate(() => ({ on: document.body.classList.contains('fs-on'), whole: document.documentElement.classList.contains('fs-phone'), el: document.fullscreenElement === document.documentElement, pseudo: HelmFullscreen._ui.pseudo }));
          expect(fs.on, 'full screen on').toBe(true); expect(fs.whole, 'the whole page (drawers + floating controls) goes full screen').toBe(true);
          if (mode === 'native') expect(fs.el, 'Fullscreen API on the page').toBe(true); else expect(fs.pseudo, 'app-level immersive fallback').toBe(true);
          const fr = await page.evaluate(RECTS, FLOATING);
          expect(fr.find((x) => x.s === '#bimExit').missing, 'Exit shown').toBeFalsy();
          for (const s of ['#bimBack', '#bimMore', '.fabstack .fs-fab', '#bimNav']) expect(fr.find((x) => x.s === s).missing, s + ' folded away in full screen').toBe(true);
          expect(await page.evaluate(() => getComputedStyle(document.getElementById('hmnBar')).display), 'no app bar in full screen').toBe('none');
          assertLayout(fr, vw, vh, name + ' full screen 2D');
          expect(await page.evaluate(smallTargets)).toEqual([]);
          await page.screenshot({ path: join(dir, `${name}-${mode}-fullscreen-2d.png`) });
          await zoomButtonsWork(page, name + ' full screen 2D', true);
          // pinch still zooms the floor in full screen
          const z0 = await zoom2d(page);
          await page.evaluate(() => {
            const el = document.getElementById('scroll'), b = el.getBoundingClientRect(), cx = b.left + b.width / 2, cy = b.top + b.height / 2;
            const t = (id, x) => new Touch({ identifier: id, target: el, clientX: x, clientY: cy });
            const fire = (type, a) => el.dispatchEvent(new TouchEvent(type, { touches: type === 'touchend' ? [] : [t(1, cx - a), t(2, cx + a)], changedTouches: [t(1, cx - a), t(2, cx + a)], bubbles: true, cancelable: true }));
            fire('touchstart', 30); fire('touchmove', 50); fire('touchmove', 80); fire('touchend', 80);
          });
          expect(await zoom2d(page), 'pinch zooms the floor in full screen').toBeGreaterThan(z0 * 1.5);
          await page.locator('#zoomFit').tap();
          // Tools drawer works in full screen
          await page.locator('#bimTools').tap(); await page.waitForTimeout(350);
          const lp = await page.evaluate(RECTS, ['#leftPanel']);
          expect(lp[0].missing, 'toolbox drawer visible in full screen').toBeFalsy();
          await page.screenshot({ path: join(dir, `${name}-${mode}-fullscreen-tools.png`) });
          await page.touchscreen.tap(Math.round(vw * 0.75), Math.round(vh * 0.85)); await page.waitForTimeout(350);
          // 2D -> 3D in full screen: the camera zooms with the same buttons
          if (await to3D(page)) {
            expect(await page.evaluate(() => document.body.classList.contains('fs-on')), 'still full screen in 3D').toBe(true);
            expect(await page.evaluate(() => document.getElementById('bimV3d').getAttribute('aria-pressed'))).toBe('true');
            assertLayout(await page.evaluate(RECTS, FLOATING_3D), vw, vh, name + ' full screen 3D');
            await page.screenshot({ path: join(dir, `${name}-${mode}-fullscreen-3d.png`) });
            await zoomButtonsWork(page, name + ' full screen 3D', true);
            await to2D(page);
          }
          // exit
          await page.locator('#bimExit').tap(); await page.waitForTimeout(900);
          const out = await page.evaluate(() => ({ on: document.body.classList.contains('fs-on'), whole: document.documentElement.classList.contains('fs-phone'), el: !!document.fullscreenElement,
            back: getComputedStyle(document.getElementById('bimBack')).display, exit: getComputedStyle(document.getElementById('bimExit')).display }));
          expect(out.back, 'Back is back').not.toBe('none');
          expect({ ...out, back: 'shown' }).toEqual({ on: false, whole: false, el: false, back: 'shown', exit: 'none' });
          await zoomButtonsWork(page, name + ' after full screen', true);

          // 3D out of full screen: nothing overlaps, zoom works
          if (await to3D(page)) {
            assertLayout(await page.evaluate(RECTS, FLOATING_3D), vw, vh, name + ' 3D');
            await page.screenshot({ path: join(dir, `${name}-${mode}-3d.png`) });
            await zoomButtonsWork(page, name + ' 3D', true);
          }
          expect(errors, 'no page errors').toEqual([]);
        } finally { await context.close(); }
      });
    }
  }

  for (const [name, opts] of Object.entries(BIG)) {
    test(`${name}: layout unchanged, full-screen zoom works`, async ({ browser }, info) => {
      test.setTimeout(120_000);
      const dir = shotDir(info);
      const { context, page, errors } = await open(browser, opts);
      try {
        expect(await page.evaluate((q) => matchMedia(q).matches, PHONE_Q)).toBe(false);
        const s = await page.evaluate(() => ({ bim: ['#bimTL', '#bimTR', '#bimRail', '#bimNav'].map((q) => getComputedStyle(document.querySelector(q)).display),
          hdrPos: getComputedStyle(document.querySelector('header')).position, hdrVis: getComputedStyle(document.querySelector('header')).visibility,
          fab: getComputedStyle(document.getElementById('fabStack')).flexDirection }));
        expect(s.bim, 'no floating phone controls').toEqual(['none', 'none', 'none', 'none']);
        expect(s.hdrPos).not.toBe('fixed'); expect(s.hdrVis).toBe('visible');
        expect(s.fab, 'zoom dock stays a row under the floor').toBe('row');
        await zoomButtonsWork(page, name, false);
        // full screen = the canvas box, as before; zoom works there too (2D and 3D)
        await page.locator('#fsFab').click(); await page.waitForTimeout(1200);
        expect(await page.evaluate(() => [document.body.classList.contains('fs-on'), document.documentElement.classList.contains('fs-phone'), document.fullscreenElement === document.querySelector('.viewport')])).toEqual([true, false, true]);
        await page.screenshot({ path: join(dir, `${name}-fullscreen.png`) });
        await zoomButtonsWork(page, name + ' full screen', false);
        if (await to3D(page)) await zoomButtonsWork(page, name + ' full screen 3D', false);
        await page.keyboard.press('Escape'); await page.waitForTimeout(800);
        if (await page.evaluate(() => document.body.classList.contains('fs-on'))) { await page.evaluate(() => HelmFullscreen._ui.exit()); await page.waitForTimeout(800); }
        expect(await page.evaluate(() => document.body.classList.contains('fs-on'))).toBe(false);
        expect(errors).toEqual([]);
      } finally { await context.close(); }
    });
  }
  // signed in against STAGING (never production): the real studio top bar + the real bottom tab bar (mobile-nav.js).
  // Read-only: it only opens the builder (no quote, nothing saved, no photo render).
  test('@staging signed-in builder on an upright phone: app bar folded away, floating controls clear (staging only, read-only)', async ({ browser }, info) => {
    test.skip(!STAGING_URL || !STAGING_ANON || !existsSync(statePath('admin')), 'needs the staging E2E env (HELM_E2E_*) + global-setup state');
    test.setTimeout(120_000);
    const dir = shotDir(info);
    const opts = strip(devices['iPhone 14']);
    const context = await browser.newContext({ ...opts, storageState: statePath('admin') });
    const page = await context.newPage();
    const prod = [], errors = [];
    page.on('request', (r) => { if (r.url().includes('nqltzgiwznphugcfhmbm')) prod.push(r.url()); });
    page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
    await page.addInitScript(([u, a]) => { window.HELM_STAGING_SUPABASE = { url: u, anonKey: a }; try { localStorage.setItem('helm_tour_seen_builder', '1'); sessionStorage.setItem('helm.builder.portraitOk', '1'); } catch (e) {} }, [STAGING_URL, STAGING_ANON]);
    try {
      await page.goto('/builder.html');
      await page.waitForFunction(() => window.BPStore && typeof store !== 'undefined' && !document.documentElement.classList.contains('auth-pending'), null, { timeout: 30_000 });
      await page.waitForFunction(() => document.body.classList.contains('hmn-on'), null, { timeout: 20_000 }).catch(() => {});
      await page.waitForTimeout(1500);
      expect(await page.evaluate(() => window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.url)).toContain('xizehqgeyjcfpzrdymly');
      const vw = opts.viewport.width, vh = opts.viewport.height;
      const nav = await page.evaluate(() => { const b = document.getElementById('hmnBar'); return { on: document.body.classList.contains('hmn-on'), shown: !!b && getComputedStyle(b).display !== 'none', pb: getComputedStyle(document.body).paddingBottom }; });
      expect(nav.shown, 'bottom tab bar hidden in the builder').toBe(false);
      if (nav.on) expect(await page.evaluate(() => getComputedStyle(document.getElementById('bimNav')).display)).not.toBe('none');
      assertLayout(await page.evaluate(RECTS, FLOATING), vw, vh, 'staging iPhone 14');
      expect(await page.evaluate(smallTargets)).toEqual([]);
      await page.screenshot({ path: join(dir, 'staging-signed-in-iphone14-portrait.png') });
      await page.locator('#bimMore').tap(); await page.waitForTimeout(400);
      await page.screenshot({ path: join(dir, 'staging-signed-in-iphone14-more.png') });
      await page.keyboard.press('Escape');
      if (nav.on) { await page.locator('#bimNav').tap(); await page.waitForTimeout(300); await page.screenshot({ path: join(dir, 'staging-signed-in-iphone14-appbar-up.png') }); }
      expect(prod, 'zero requests to production').toEqual([]);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });
});
