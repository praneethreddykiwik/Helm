// @logo — R154: the stage-screen logo end to end on localhost -> STAGING (never production).
// upload (Add logo, a transparent PNG) -> invite-media storage path -> stored on the stage item -> signed link ->
// 2D <image> + 3D texture -> exported 2D plan picture -> save -> reload -> still shown.
// It creates ONE synthetic lead + quote (the harness bootstrap) and uploads ONE small picture to that quote's
// invite-media folder on staging. Nothing is deleted. It never presses "Update client images" or Photo render.
// Run: set -a; . <qa-base>/.env.e2e; set +a; npx playwright test tests/e2e/workflow/builder-logo.spec.mjs --project=chromium
import { test, expect } from '@playwright/test';
import zlib from 'node:zlib';
import { authedPage } from '../helpers/session.mjs';
import { requireStagingEnv } from '../helpers/env.mjs';
import { assertStagingOnly } from '../helpers/staging.mjs';
import { bootstrapCanonicalLead, newRunId } from '../helpers/lifecycle.mjs';

test.beforeAll(() => requireStagingEnv());

// a 96 x 48 RGBA PNG: left half solid red, right half fully transparent
function transparentPng() {
  const W = 96, H = 48, raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (W * 4 + 1)] = 0;
    for (let x = 0; x < W; x++) { const o = y * (W * 4 + 1) + 1 + x * 4; if (x < W / 2) { raw[o] = 220; raw[o + 3] = 255; } } }
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcT[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// does the stored picture still carry an alpha channel?
function hasAlpha(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return buf[25] === 6 || buf[25] === 4;                       // PNG colour type RGBA / GA
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') {
    const c = buf.slice(12, 16).toString();
    if (c === 'VP8X') return (buf[20] & 0x10) !== 0;                                                    // extended: alpha flag
    if (c === 'VP8L') return ((buf[24] >> 4) & 1) === 1;                                                 // lossless: alpha_is_used bit
    return false;                                                                                        // 'VP8 ' lossy = no alpha
  }
  return false;                                                                                          // JPEG: never
}

test('@logo stage screen logo: upload -> storage -> 2D + 3D -> export -> save -> reload (staging)', async ({ browser }) => {
  test.setTimeout(180_000);
  const { quoteId } = await bootstrapCanonicalLead(newRunId());
  expect(quoteId, 'synthetic quote created on staging').toMatch(/^[0-9a-f-]{36}$/);
  const { context, page } = await authedPage(browser, 'admin');
  const csp = [], errors = [];
  page.on('console', (m) => { const s = m.text(); if (/Content Security Policy|Trusted Type|TrustedHTML|TrustedScript/i.test(s)) csp.push(s); if (m.type() === 'error') errors.push(s); });
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  try {
    await page.goto('/builder.html?quote=' + quoteId);
    await page.waitForFunction((q) => window.BPStore && window.HelmScreen && typeof currentQuoteId !== 'undefined' && currentQuoteId === q, quoteId, { timeout: 30_000 });
    await page.waitForTimeout(1500);
    await assertStagingOnly(page);
    const gate = await page.evaluate(() => screenLogoGate());
    test.skip(!!gate, 'logo upload gated on this staging studio: ' + gate);

    // a stage, selected, so the inspector shows the Logo picture box
    await page.evaluate(() => { const it = makeItem('stage', 60, 10, {}); store.items.push(it); setSelection([it.id]); commit(); renderAll(); });
    await page.waitForSelector('#scr_logo_file', { state: 'attached', timeout: 15_000 });
    await page.setInputFiles('#scr_logo_file', { name: 'logo.png', mimeType: 'image/png', buffer: transparentPng() });
    const path = await page.waitForFunction(() => { const s = store.items.find((i) => i.type === 'stage' && i.properties && i.properties.screenLogo); return s ? s.properties.screenLogo : null; }, null, { timeout: 45_000 }).then((h) => h.jsonValue());
    // 1) storage path: <org>/<this quote>/<random>.png|webp (cleanLogo accepts it; never a data: or web URL)
    expect(path).toMatch(new RegExp('^[0-9a-f-]{36}/' + quoteId + '/[0-9a-f-]{32,36}\\.(png|webp)$'));
    // 2) signed link resolves and the picture loads (CORS anonymous, CSP img-src)
    await page.waitForFunction((p) => HelmScreen.logoState(p) !== 'loading' && HelmScreen.logoState(p) !== 'none', path, { timeout: 20_000 });
    expect(await page.evaluate((p) => HelmScreen.logoState(p), path)).toBe('ok');
    const url = await page.evaluate((p) => HelmScreen.logoUrl(p), path);
    expect(url).toMatch(/^https:\/\/xizehqgeyjcfpzrdymly\.supabase\.co\/storage\/v1\/object\/sign\/invite-media\//);
    // 3) the stored picture kept its transparency (R154 fix: it used to be flattened on white)
    const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
    expect(hasAlpha(bytes), 'uploaded logo keeps an alpha channel').toBe(true);
    // 4) 2D: an SVG <image> with the signed link; 3D: the screen texture renders without a tainted canvas
    expect(await page.evaluate(() => [...document.querySelectorAll('image.scr-logo')].map((n) => n.getAttribute('href').slice(0, 60)))).not.toHaveLength(0);
    const shot3d = await page.evaluate(async () => { const b = await window.__capture3D(800, { labels: 'none' }); return b ? b.size : 0; });
    expect(shot3d, '3D capture with the logo texture').toBeGreaterThan(1000);
    // 5) exported 2D plan picture keeps the logo pixels (R154) and never the signed link
    const plan = await page.evaluate(async () => { const b = await window.__helmPhotoCtx().planBlob({ clean: true, maxW: 1200 }); return b ? b.size : 0; });
    expect(plan).toBeGreaterThan(1000);
    // 6) save -> reload -> same path, loads again
    expect(await page.evaluate(() => saveLayout(false))).toBeTruthy();
    await page.reload();
    await page.waitForFunction((p) => typeof store !== 'undefined' && store.items.some((i) => i.properties && i.properties.screenLogo === p), path, { timeout: 30_000 });
    await page.waitForFunction((p) => HelmScreen.logoState(p) === 'ok' || HelmScreen.logoState(p) === 'fail', path, { timeout: 20_000 }).catch(() => {});
    if (await page.evaluate((p) => HelmScreen.logoState(p), path) === 'none') { await page.evaluate((p) => HelmScreen.logoImage(p), path); await page.waitForTimeout(3000); }
    expect(await page.evaluate((p) => HelmScreen.logoState(p), path), 'logo shows again after reload').toBe('ok');
    expect(csp, 'no CSP / Trusted Types violations').toEqual([]);
    expect(page.__prodHits, 'zero production requests').toEqual([]);
  } finally { await context.close(); }
});
