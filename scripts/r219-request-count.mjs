// r219-request-count.mjs - R219: loads real Helm pages in headless Chromium and counts their Supabase requests.
// EVERY Supabase request is answered by the local mock below and every other host is aborted (WebSocket stubbed), so
// nothing leaves the machine and no real database is touched. Per page: a fresh tab, a reload ~6 s later in the same tab,
// and a reload with this tab's startup answers aged 2 minutes.
// usage: node scripts/r219-request-count.mjs [publicDir=public] [page ...]   (pages: dashboard quotes event calendar builder)
// Needs the Playwright browsers (npx playwright install chromium). Not part of npm test.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
const { chromium } = await import('playwright');

const ROOT = process.argv[2] || new URL('../public', import.meta.url).pathname;
const PAGES = process.argv.slice(3).length ? process.argv.slice(3) : ['dashboard', 'quotes', 'event', 'calendar', 'builder'];
const ORIGIN = 'http://localhost:4519';
const SB = 'https://nqltzgiwznphugcfhmbm.supabase.co';
const UID = '0b9c1f6e-1111-4222-8333-444455556666', ORG = '7d0e4c1a-aaaa-4bbb-8ccc-ddddeeeeffff', QID = '11111111-2222-4333-8444-555555555555';
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const exp = Math.floor(Date.now() / 1000) + 3600;
const JWT = b64u({ alg: 'HS256', typ: 'JWT' }) + '.' + b64u({ sub: UID, role: 'authenticated', aud: 'authenticated', aal: 'aal1', amr: [{ method: 'password', timestamp: exp - 7200 }], session_id: 'sess-1', exp, email: 'owner@example.test' }) + '.sig';
const USER = { id: UID, aud: 'authenticated', role: 'authenticated', email: 'owner@example.test', app_metadata: { provider: 'email' }, user_metadata: { full_name: 'Test Owner' }, factors: [], created_at: '2026-01-01T00:00:00Z' };
const SESSION = { access_token: JWT, refresh_token: 'r1', token_type: 'bearer', expires_in: 3600, expires_at: exp, user: USER };

const RPC = {
  page_bootstrap: () => ({ v: 1, parts: { current_org_id: ORG, my_profile_status: { complete: true, required: false, nudge: false },
    my_checkout_status: { required: false, is_admin: true, has_subscription: true, reason: 'subscribed', pending_payment: false },
    password_change_required: false, profile_role: 'admin', role_access: [], my_trial_org: { is_trial_org: false, read_only: false, is_admin: true },
    my_trial_status: { status: 'active', state: 'paid', is_admin: true }, my_demo_status: { has_demo: false, demo_rows: 0, is_admin: true },
    my_subscription: { status: 'active', read_only: false, plan: 'studio' }, my_test_studio: false,
    get_pricing_config: { chairPrice: 250, gstPct: 18, currency: 'INR', country: 'IN' }, get_item_rate_cards: { rates: {}, canEdit: true, custom: [] } }, errors: {} }),
  current_org_id: ORG, my_profile_status: { complete: true, required: false, nudge: false },
  my_checkout_status: { required: false, is_admin: true, has_subscription: true, reason: 'subscribed', pending_payment: false },
  password_change_required: false, my_trial_org: { is_trial_org: false, read_only: false, is_admin: true },
  my_trial_status: { status: 'active', state: 'paid', is_admin: true }, my_demo_status: { has_demo: false, demo_rows: 0, is_admin: true },
  my_subscription: { status: 'active', read_only: false, plan: 'studio' }, my_test_studio: false,
  get_pricing_config: { chairPrice: 250, gstPct: 18, currency: 'INR', country: 'IN' }, get_item_rate_cards: { rates: {}, canEdit: true, custom: [] },
  my_studio_route: { own: true, slug: 'aurora' }, my_profile: { id: UID, full_name: 'Test Owner', role: 'admin', email: 'owner@example.test' },
  is_platform_admin: false, is_platform_operator: false, my_auth_info: { has_password: true },
};
const ROWS = {
  organizations: [{ id: ORG, name: 'Aurora Events', slug: 'aurora', country: 'IN', timezone: 'Asia/Kolkata', brand: {} }],
  profiles: [{ id: UID, role: 'admin', full_name: 'Test Owner', email: 'owner@example.test', org_id: ORG }],
  quotes: [{ id: QID, code: 'Q-0001', title: 'Sharma wedding', status: 'draft', approval_status: 'none', org_id: ORG, current_version: 1, data: {}, event_date: '2026-12-01', updated_at: '2026-11-18T10:00:00Z', created_at: '2026-11-01T10:00:00Z' }],
};
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };

function fileFor(pathname) {
  const p = decodeURIComponent(pathname).replace(/^\/+/, '');
  const cands = [p, p + '.html'];
  const seg = p.split('/');
  if (seg.length >= 2 && !p.includes('.')) cands.push(seg[1] + '.html', seg[seg.length - 1] + '.html');   // /<studio>/<page>[/<ref>]
  if (seg.length >= 3 && !p.includes('.')) { const map = { event: 'event.html', 'floor-plan': 'builder.html', tasks: 'ops.html', client: 'client.html' }; if (map[seg[1]]) cands.unshift(map[seg[1]]); }
  for (const c of cands) { const f = join(ROOT, c); if (c && existsSync(f) && statSync(f).isFile()) return f; }
  return null;
}

async function main() {
  const browser = await chromium.launch();
  const results = {};
  for (const pg of PAGES) {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const reqs = []; let phase = 'cold';
    if (process.env.STACKS) await ctx.addInitScript((re) => { window.__STACKS_RE = re; }, process.env.STACKS);
    await ctx.addInitScript(([k, s]) => {
      try { for (const kk of k) if (!localStorage.getItem(kk)) localStorage.setItem(kk, s); } catch (e) {}
      // no realtime socket ever leaves the page
      window.WebSocket = function () { const o = { readyState: 0, send() {}, close() {}, addEventListener() {}, removeEventListener() {} }; return o; };
      if (window.__STACKS_RE) { const of = window.fetch; window.fetch = function (i, init) { try { const u = typeof i === 'string' ? i : i.url; if (new RegExp(window.__STACKS_RE).test(u)) console.trace('STACK ' + (init && init.method || 'GET') + ' ' + u.replace(/^https:\/\/[^/]+/, '').slice(0, 90)); } catch (e) {} return of.apply(this, arguments); }; }
      window.WebSocket.CONNECTING = 0; window.WebSocket.OPEN = 1; window.WebSocket.CLOSING = 2; window.WebSocket.CLOSED = 3;
    }, [['sb-nqltzgiwznphugcfhmbm-auth-token', 'sb-xizehqgeyjcfpzrdymly-auth-token'], JSON.stringify(SESSION)]);
    await ctx.route('**/*', async (route) => {
      const req = route.request(); const url = new URL(req.url());
      if (url.origin === ORIGIN) {
        const f = fileFor(url.pathname);
        if (!f) return route.fulfill({ status: 404, body: 'nf' });
        return route.fulfill({ status: 200, contentType: TYPES[extname(f)] || 'application/octet-stream', body: readFileSync(f) });
      }
      if (url.protocol === 'https:' && url.hostname.endsWith('.supabase.co')) {
        const path = url.pathname; const m = req.method();
        if (path.startsWith('/auth/v1/')) {
          if (path.endsWith('/user')) return route.fulfill({ json: USER });
          if (path.endsWith('/token')) return route.fulfill({ json: SESSION });
          if (path.includes('/factors')) return route.fulfill({ json: [] });
          return route.fulfill({ json: {} });
        }
        if (path.startsWith('/rest/v1/')) {
          const name = path.slice(9);
          let label = m + ' ' + name;
          if (!name.startsWith('rpc/')) { const sel = url.searchParams.get('select'); label += ' ?' + [...url.searchParams.keys()].filter((k) => k !== 'select').join('&') + (sel ? ' select=' + sel.slice(0, 60) : ''); }
          reqs.push({ hdr: ['range', 'prefer', 'accept'].map((h) => req.headers()[h] || '').join(' / '), t: Date.now(), phase, label, name, method: m, url: url.pathname + url.search, body: req.postData() || '' });
          const acceptObj = /vnd\.pgrst\.object/.test(req.headers()['accept'] || '');
          if (name.startsWith('rpc/')) {
            const fn = name.slice(4); const v = RPC[fn]; const data = typeof v === 'function' ? v() : v;
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data === undefined ? null : data) });
          }
          const rows = ROWS[name] || [];
          const hdr = { 'content-range': '0-' + Math.max(0, rows.length - 1) + '/' + rows.length };
          if (m === 'HEAD') return route.fulfill({ status: 200, headers: hdr, body: '' });
          return route.fulfill({ status: 200, contentType: 'application/json', headers: hdr, body: JSON.stringify(acceptObj ? (rows[0] || null) : rows) });
        }
        if (path.startsWith('/storage/v1/')) return route.fulfill({ status: 404, json: { error: 'not found' } });
        if (path.startsWith('/functions/v1/')) return route.fulfill({ json: {} });
        return route.fulfill({ status: 404, body: '' });
      }
      return route.abort();   // fonts / sentry / google / anything else: never leaves the machine
    });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
    if (process.env.STACKS) { const cdp = await ctx.newCDPSession(page); await cdp.send('Runtime.enable'); await cdp.send('Debugger.enable'); await cdp.send('Debugger.setAsyncCallStackDepth', { maxDepth: 40 });
      cdp.on('Runtime.consoleAPICalled', (ev) => { if (ev.type !== 'trace') return; const msg = ev.args && ev.args[0] && ev.args[0].value; const fr = []; let st = ev.stackTrace;
        while (st) { for (const f of st.callFrames) { const file = f.url.replace(/^.*\//, '').replace(/\?v=\d+/, ''); if (/supabase-js|^$/.test(file)) continue; if (/^(timedFetch|coalescedFetch|authAwareFetch|authAwareFetchInner|window\.fetch)$/.test(f.functionName)) continue; fr.push((f.functionName || '(anon)') + '@' + file + ':' + (f.lineNumber + 1)); } st = st.parent; }
        console.error('[' + phase + '] ' + msg + '\n    ' + fr.slice(0, 9).join(' < ')); }); }
    if (process.env.DBG) { page.on('console', (m) => console.error('console', m.type(), m.text().slice(0, 200))); page.on('request', (r) => console.error('req', r.method(), r.url().slice(0, 140))); page.on('framenavigated', (f) => console.error('nav', f.url())); }
    const path = pg === 'onboarding' ? '/onboarding' : pg === 'event' ? '/aurora/event/Q-0001' : pg === 'builder' ? '/aurora/floor-plan/Q-0001' : '/aurora/' + pg;
    // cold tab (first visit), then a reload a few seconds later in the same tab (what the owner did), then a reload with
    // the 60 s startup answers aged 2 minutes (the usual case: a page opened after a minute or more in this tab)
    await page.goto(ORIGIN + path, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(6000);
    phase = 'reload'; await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(6000);
    await page.evaluate(() => { for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); try { const o = JSON.parse(sessionStorage.getItem(k)); if (o && typeof o.ts === 'number') { o.ts -= 120000; sessionStorage.setItem(k, JSON.stringify(o)); } } catch (e) {} } });
    phase = 'aged'; await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(6000);
    results[pg] = { reqs, errs }; if (process.env.URLS) { const ph = process.env.URLS; const r = reqs.filter((y) => y.phase === ph); for (const x of r) console.error(String(x.t - r[0].t).padStart(6), process.env.FULL ? decodeURIComponent(x.url).slice(-160) + ' ' + (x.hdr || '') : x.label.slice(0, 90), x.body.slice(0, 60)); }
    await ctx.close();
  }
  await browser.close();
  return results;
}
const res = await main();
const out = {};
for (const [pg, { reqs, errs }] of Object.entries(res)) {
  out[pg] = {};
  for (const ph of ['cold', 'reload', 'aged']) {
    const r = reqs.filter((x) => x.phase === ph); const by = {};
    for (const x of r) by[x.label] = (by[x.label] || 0) + 1;
    out[pg][ph] = { total: r.length, by };
  }
  out[pg].errors = [...new Set(errs)].slice(0, 8);
}
console.log(JSON.stringify(out, null, 1));
