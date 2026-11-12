// R152 - the "Forgot password?" link on /login is clickable over its whole box.
//
// In plain words: the link sits 10px up under the password box (.hint has margin-top:-10px) and R151 gave it a 24px
// tall hit area. The password wrapper (.pwwrap) is position:relative, so it was painted - and hit-tested - over the
// top half of the link: a click in the middle of "Forgot password?" did nothing (R146 found it). public-v2.css now
// makes that link positioned too; being later in the page it wins. Nothing moves on screen.
//
// Static checks always run. When Playwright + its Chromium are installed, the real page is also loaded (served from
// public/ through page.route - no server, no network) and document.elementFromPoint at the link's centre must be the
// link, at 375px and 1440px wide. Without a browser that part is skipped with a note.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
let n = 0;
const t = async (name, f) => { await f(); n++; console.log('  ok ' + name); };

const LOGIN = read('public/login.html');
const V2 = read('public/public-v2.css');

await t('public-v2.css: the link in a .hint paragraph on a card is positioned (painted above .pwwrap); nothing else changes', () => {
  assert.match(V2, /\n\.card p\.hint > \.linkbtn \{ position:relative; \}\n/);
  // the R151 24px hit area stays exactly as it was
  assert.match(V2, /\n\.card \.linkbtn, \.card \.foot a \{ padding-block:5px; margin-block:-5px; \}\n/);
  // no z-index / offsets: the fix only changes paint order, never the position
  const rule = V2.match(/\.card p\.hint > \.linkbtn \{([^}]*)\}/)[1];
  assert.doesNotMatch(rule, /z-index|top|left|margin|padding|transform/);
});

await t('login.html: the link is a .linkbtn inside p.hint#forgotRow right after the password, in the card; public-v2.css?v=9', () => {
  assert.match(LOGIN, /<p class="hint" id="forgotRow"><button type="button" class="linkbtn" id="forgotBtn">Forgot password\?<\/button><\/p>/);
  assert.match(LOGIN, /\.pwwrap\{position:relative\}/);
  assert.match(LOGIN, /\.hint\{[^}]*margin:-10px 0 16px\}/);
  assert.match(LOGIN, /<form class="card[^"]*" id="loginForm"|<form [^>]*id="loginForm"[^>]*class="card/);
  for (const p of ['public/login.html', 'public/reset-password.html']) assert.match(read(p), /\/public-v2\.css\?v=9"/, p);
});

// ---- real browser check (optional) --------------------------------------------------------------------------------
let pw = null;
try { pw = await import('playwright'); } catch { /* not installed */ }
let browser = null;
if (pw) { try { browser = await pw.chromium.launch(); } catch { browser = null; } }
if (!browser) {
  console.log('  - browser check skipped (Playwright Chromium not installed); static checks above still apply');
} else {
  const HOST = '127.0.0.1:41952';   // never contacted: every request is answered by page.route from public/
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.woff2': 'font/woff2', '.json': 'application/json', '.webp': 'image/webp', '.ico': 'image/x-icon' };
  try {
    for (const width of [375, 1440]) {
      await t(`browser (chromium ${width}px): elementFromPoint at the centre of "Forgot password?" is the link; a click opens the form`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        await page.route('**/*', async (route) => {
          const u = new URL(route.request().url());
          if (u.host !== HOST) return route.abort();
          let p = decodeURIComponent(u.pathname);
          if (p === '/login') p = '/login.html';
          const f = join(ROOT, 'public', p);
          if (!f.startsWith(join(ROOT, 'public')) || !existsSync(f)) return route.fulfill({ status: 404, body: '' });
          return route.fulfill({ status: 200, contentType: TYPES[extname(f)] || 'application/octet-stream', body: readFileSync(f) });
        });
        await page.goto('http://' + HOST + '/login', { waitUntil: 'domcontentloaded' });
        await page.locator('#forgotBtn').waitFor({ state: 'visible' });
        await page.waitForTimeout(300);
        const r = await page.evaluate(() => {
          const btn = document.getElementById('forgotBtn'); const b = btn.getBoundingClientRect();
          const at = (fy) => document.elementFromPoint(b.left + b.width / 2, b.top + b.height * fy);
          return { centre: at(0.5) === btn, upper: at(0.2) === btn, wrapBelowBtnTop: document.querySelector('#loginForm .pwwrap').getBoundingClientRect().bottom > b.top };
        });
        assert.ok(r.wrapBelowBtnTop, 'layout changed: .pwwrap no longer reaches under the link (test needs a look)');
        assert.ok(r.centre, 'centre of the link is covered');
        assert.ok(r.upper, 'upper part of the link is covered');
        const bb = await page.locator('#forgotBtn').boundingBox();
        await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
        await page.waitForFunction(() => !document.getElementById('forgotForm').hidden, null, { timeout: 3000 });
        await page.close();
      });
    }
  } finally { await browser.close(); }
}

console.log(`r152-forgot-link: ${n} checks passed`);
