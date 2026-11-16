// R176 smoke suite - static guards (no network): the workflow can only run in the dev repo, channel
// checks are manual-only and owner-only, secrets come from env and are never echoed, checks are read-only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n     ' + e.message); } };

const WF = read('.github/workflows/smoke.yml');
const SPEC = read('tests/smoke/site.smoke.spec.mjs');
const ANON = read('tests/smoke/anon.mjs');
const CFG = read('tests/smoke/config.mjs');
const PKG = JSON.parse(read('package.json'));

t('workflow only runs in the dev repo (never on the public prod repo)', () => {
  assert.match(WF, /if: >-\s*\n\s*github\.repository == 'koushik1133\/Helm'/);
  const jobs = WF.split(/^jobs:\s*$/m)[1] || '';
  assert.deepEqual((jobs.match(/^  [a-z][\w-]*:\s*$/gm) || []).map((l) => l.trim()), ['smoke:'], 'exactly one job, guarded');
});

t('triggers: deploy, schedule (3-hourly quick + daily full), manual', () => {
  assert.match(WF, /^\s+deployment_status:/m);
  assert.match(WF, /cron: '17 \*\/3 \* \* \*'/);
  assert.match(WF, /cron: '43 3 \* \* \*'/);
  assert.match(WF, /workflow_dispatch:/);
});

t('deploy runs skip previews: only successful deploys of known hosts', () => {
  assert.match(WF, /deployment_status\.state == 'success'/);
  assert.match(WF, /contains\(github\.event\.deployment_status\.environment_url, 'helm-v01\.vercel\.app'\)/);
  // R178: dev-repo deploys arrive at a unique vercel.app address, so they are recognised by environment 'Production'
  assert.match(WF, /github\.event\.deployment\.environment == 'Production'/);
  assert.doesNotMatch(WF, /deployment\.environment == 'Preview'/);
});

t('channel check: manual input defaults to false and is forced off outside workflow_dispatch', () => {
  assert.match(WF, /include_channel_check:[\s\S]*?default: false/);
  assert.match(WF, /\[\[ "\$EVENT" == "workflow_dispatch" \]\] \|\| channel=0/);
  assert.doesNotMatch(WF.split('schedule)')[1].split(';;')[0], /channel=1/, 'schedule branch never enables channel');
});

t('channel check is owner-only in the spec', () => {
  assert.match(SPEC, /SMOKE_CHANNEL_CHECK === '1'/);
  assert.match(SPEC, /EMAIL\.trim\(\)\.toLowerCase\(\) !== OWNER_EMAIL/);
  assert.match(SPEC, /endsWith\(OWNER_PHONE\.slice\(-10\)\)/);
});

t('secrets only from env, only in the browser step, never echoed', () => {
  const steps = WF.split(/\n      - /);
  const withSecrets = steps.filter((s) => /secrets\./.test(s));
  assert.equal(withSecrets.length, 1, 'one step gets secrets');
  assert.match(withSecrets[0], /^name: Browser checks/);
  assert.doesNotMatch(WF, /echo[^\n]*SMOKE_(PROD|STAGING)_PASSWORD|echo[^\n]*secrets\./);
  assert.doesNotMatch(SPEC + ANON, /console\.log\([^)]*(PASSWORD|EMAIL\b|anonKey|key\))/);
  assert.match(SPEC, /process\.env\[`SMOKE_\$\{KEY\}_PASSWORD`\]/);
});

t('signed-in checks skip cleanly without secrets', () => {
  assert.match(SPEC, /test\.skip\(!SIGNED_IN, `not configured/);
});

t('read-only: no save / delete / send clicks except the owner channel checks', () => {
  const clicks = [...SPEC.matchAll(/locator\('([^']+)'\)[^;\n]*\.click\(/g)].map((m) => m[1]);
  for (const c of clicks) assert.ok(['#submit', '#hauAccountBtn', '#itgEmailTest', '#itgWaTest'].includes(c), 'unexpected click ' + c);
  assert.doesNotMatch(SPEC, /getByRole\('button', \{ name: \/(save|delete|send|sign ?up)/i);
  assert.doesNotMatch(SPEC, /render-photo|\/signup|send-otp/i);
});

t('gentle and named: ~1 req/s, HelmSmoke user agent, GET only', () => {
  assert.match(CFG, /PACE_MS = 1000/);
  assert.match(CFG, /HelmSmoke\/1\.0/);
  assert.doesNotMatch(ANON, /method:\s*'(POST|PUT|PATCH|DELETE)'/i);
});

t('warn-only: failure turns the run red, nothing else is blocked', () => {
  assert.match(WF, /continue-on-error: true/);
  assert.match(WF, /Result \(red run = GitHub e-mails you; nothing is blocked\)/);
  assert.match(CFG, /blockReleases: false/);
});

t('chromium only, one worker, no retries', () => {
  const PW = read('tests/smoke/playwright.smoke.config.mjs');
  assert.match(PW, /workers: 1/); assert.match(PW, /retries: 0/);
  assert.equal((PW.match(/name: '/g) || []).length, 1);
  assert.match(WF, /playwright install --with-deps chromium/);
});

t('npm scripts + test registered', () => {
  assert.ok(PKG.scripts.smoke && PKG.scripts['smoke:prod']);
  assert.match(PKG.scripts.test, /r176-smoke-suite\.test\.mjs/);
});

console.log(`\nr176-smoke-suite: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
