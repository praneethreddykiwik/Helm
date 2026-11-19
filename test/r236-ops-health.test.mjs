// r236-ops-health.test.mjs - R236 (0402) shape checks, no database: the migration + APPLY are additive, ASCII, paste-safe,
// carry no secret and never change an existing cron job; comms-dispatch uses the send ledger + heartbeat; the HQ card reads
// hq_ops_health with a fallback; the daily prod smoke needs no secret; npm run ci runs the local cache-bust check.
// The database side: tests/db/r236-ops-health-0402.sql; the edge side: tests/edge/r236-ops-health.test.ts.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const SQL = rd('supabase/migrations/0402_r236_ops_health.sql'), APPLY = rd('supabase/APPLY-0402.sql'), MF = rd('supabase/migrations/MANIFEST');
const CD = rd('supabase/functions/comms-dispatch/index.ts'), WS = rd('supabase/functions/_shared/wa-sender.ts');
const J = rd('public/hq.js'), H = rd('public/hq.html'), WF = rd('.github/workflows/prod-daily-smoke.yml');
const PK = JSON.parse(rd('package.json')), RA = rd('scripts/db-test/run-all.sh'), CMP = rd('supabase/CHECK-EMAIL-CRONS-VS-CODE.sql');
const OV = JSON.parse(rd('supabase/check-prod-overrides.json'));
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };

t('migration: ASCII, no temp table / session state, nothing dropped or deleted, no truncate', () => {
  for (const [f, s] of [['0402', SQL], ['APPLY-0402', APPLY], ['compare', CMP]]) assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(s), f + ' ASCII');
  assert.ok(!/\bcreate\s+(temp|temporary)\s+table\b/i.test(SQL + APPLY), 'temp table');
  assert.ok(!/^\s*(drop\s+(table|function|trigger|index|column)|truncate|delete\s+from)\b/im.test(SQL), 'drop / delete / truncate');
  assert.ok(!/\bset\s+(session|role)\b/i.test(SQL), 'session state');
});
t('cron: jobs only ADDED (cron.schedule inside ensure for state can_create); never unscheduled; alter only in the owner-run adopt', () => {
  assert.ok(!/cron\.unschedule\s*\(/i.test(SQL.replace(/^--.*$/gm, '')), 'unschedule');
  assert.equal((SQL.match(/cron\.schedule\(\$1, \$2, \$3\)/g) || []).length, 1);
  assert.match(SQL, /where x\.state = 'can_create' loop/);
  assert.equal((SQL.match(/cron\.alter_job\(/g) || []).length, 1);
  assert.match(SQL, /create or replace function public\.ops_mailer_cron_adopt\(p_job text\)[\s\S]*?cron\.alter_job/);
  assert.ok(!/(select|perform)\s+public\.ops_mailer_cron_adopt\(/i.test(SQL.replace(/^--.*$/gm, '')), 'adopt never called by the file');
});
t('cron: the 6 mailer jobs with the documented names + schedules; secrets by Vault NAME only, never a value', () => {
  for (const [job, fn, sch, sec] of [['helm_comms_dispatch', 'comms-dispatch', '*/5 * * * *', 'helm_comms_secret'],
      ['invite-mailer', 'invite-mailer', '*/2 * * * *', 'helm_invite_email_secret'], ['helm_security_alerts', 'security-alert-mailer', '*/5 * * * *', 'helm_security_alert_secret'],
      ['helm_pkg_notify', 'pkg-client-notify', '*/2 * * * *', 'helm_pkg_notify_secret'], ['helm_billing_reminder', 'billing-reminder', '15 * * * *', 'helm_billing_cron_secret'],
      ['helm_welcome_mailer', 'welcome-mailer', '*/10 * * * *', 'helm_welcome_email_secret']]) {
    assert.ok(SQL.includes(`('${job}', '${fn}', '${sch}', '${sec}',`), job);
    assert.ok(CMP.includes(`'${job}'`) && CMP.includes(`'${sch}'`) && CMP.includes(`'${sec}'`), 'compare file ' + job);
  }
  assert.ok(!/vault\.create_secret|vault\.update_secret/.test(SQL), 'never writes a secret');
  assert.ok(!/[0-9a-f]{32,}/.test(SQL), 'no secret-looking value');
  assert.ok(!/nqltzgiwznphugcfhmbm|xizehqgeyjcfpzrdymly/.test(SQL + APPLY), 'no project ref hard-coded');
  assert.match(SQL, /raise exception 'ops_kick_mailer: Vault secret % is missing', m\.vault_secret/);
});
t('compare SQL: read-only (one select), never the command text or a secret value', () => {
  const body = CMP.replace(/^--.*$/gm, '');
  assert.ok(!/\b(insert|update|delete|alter|create|drop|grant|revoke|truncate)\b/i.test(body), 'writes');
  assert.ok(!/decrypted_secret\b/.test(body), 'never decrypts');
  assert.ok(!/\bj\.command\s+as\b|\bcommand\s*,\s*$/m.test(body) && !/select[^;]*\bl\.command\b/.test(body), 'no command column');
});
t('APPLY-0402: begin + lock_timeout 5s + statement_timeout 5min first, the migration verbatim, check rows, commit', () => {
  const sql = APPLY.replace(/^--.*\n/gm, '');
  assert.match(sql, /^begin;\nset local lock_timeout = '5s';\nset local statement_timeout = '5min';\n/);
  assert.ok(APPLY.includes(SQL.replace(/\s*$/, '\n')), 'migration verbatim');
  assert.match(APPLY, /select item, ok, note from \([\s\S]*\) v order by item;\ncommit;\n$/);
  assert.equal((APPLY.match(/^begin;$/gm) || []).length, 1); assert.equal((APPLY.match(/^commit;$/gm) || []).length, 1);
  assert.ok(!/^\s*\\/m.test(APPLY), 'no psql meta-command');
});
t('MANIFEST + checker overrides + run-all + package know 0402', () => {
  assert.match(MF, /^forward  supabase\/migrations\/0402_r236_ops_health\.sql$/m);
  assert.ok(OV['0402'] && OV['0402'].add.includes('trigger zz_r402_backoff on public.staff_email_outbox'));
  assert.match(RA, /run "r236-ops-health-0402" "R236-OPS-HEALTH-0402: ALL PASS \\\(49\/49\\\)"/);
  assert.match(RA, /run "r236-apply-0402" "APPLY-0402: ALL OK"/);
  assert.match(PK.scripts.test, /node test\/r236-ops-health\.test\.mjs/);
});
t('grants: ops_health / hq_ops_health signed-in (HQ gate inside); sender calls service role; helpers owner only', () => {
  assert.match(SQL, /create or replace function public\.hq_ops_health\(\)[\s\S]*?_hq27_require\(public\._hq27_read_perm\('hq_metrics'\), false\)/);
  assert.match(SQL, /grant execute on function public\.hq_ops_health\(\) to authenticated/);
  assert.ok(!/to anon/.test(SQL), 'nothing for anon');
  for (const f of ['ops_heartbeat_beat(text, text, jsonb)', 'ops_send_ledger_note(text, uuid, text)', 'ops_send_ledger_open()'])
    assert.ok(SQL.includes(`grant execute on function public.${f} to service_role`), f);
});
t('comms-dispatch: every lane marks through the retried mark + ledger; ledger read once per run; heartbeat each run', () => {
  assert.equal((CD.match(/await mark\("[a-z_]+", id, (res|st) === "sent", "[a-z_]+_mark"/g) || []).length, 14);
  assert.ok(!/admin\.rpc\("[a-z_]+_mark"/.test(CD), 'no direct mark left');
  assert.equal((CD.match(/already\("[a-z_]+", id\)/g) || []).length, 14);
  assert.equal((CD.match(/ledgerOpen\(admin\)/g) || []).length, 1);
  assert.match(CD, /await beat\(admin, mailOn \? "ok" : "no_provider"/);
  assert.match(CD, /if \(err && sent && !await ledgerNote\(admin, lane, id, ref, waits\)\)/);
  // the dormant heartbeat only after the secret matched
  assert.match(CD, /if \(req\.method === "POST" && await secretMatches\(req\.headers\.get\("x-helm-cron-secret"\) \|\| "", Deno\.env\.get\("HELM_COMMS_SECRET"\) \|\| ""\)\) \{\s+await beat\(/);
});
t('MSG-01: a refused token / permission waits (held = retry), only for a studio account in error', () => {
  assert.match(CD, /r\.kind === "recipient" \? "skipped" : r\.kind === "token" \|\| r\.kind === "permission" \? "held" : "failed"/);
  assert.match(CD, /export function markStatus\(res: Res\): string \{ return res === "failed" \|\| res === "no_provider" \|\| res === "held" \? "retry" : res; \}/);
  assert.match(WS, /export function reconnectCache\(admin: any\)/);
  assert.match(WS, /String\(data\.status \|\| ""\) === "error"/);
});
t('HQ card: hq_ops_health with a fallback to the old card; pills ok / warn / bad', () => {
  assert.match(J, /call\("hq_ops_health"\)\.catch\(function \(\) \{ return null; \}\)/);
  assert.match(J, /if \(ops && typeof ops === "object" && Array\.isArray\(ops\.checks\)\) \{ renderOpsHealth\(box, st, ops\); return; \}/);
  assert.match(H, /hq\.js\?v=43/);
  const cx = { String, Number, isFinite, Math, Date };
  vm.createContext(cx);
  const src = (name) => { const i = J.indexOf('function ' + name + '('); let d = 0; const j = J.indexOf('{', i); for (let k = j; k < J.length; k++) { if (J[k] === '{') d++; else if (J[k] === '}') { d--; if (d === 0) return J.slice(i, k + 1); } } };
  vm.runInContext('function num(v) { var n = Number(v); return isFinite(n) ? n : 0; } function int(v) { return String(num(v)); } function ago2() { return "2 h ago"; }\n'
    + ['opsPill', 'opsWord', 'opsQueueNote'].map(src).join('\n') + '\nthis.opsPill = opsPill; this.opsWord = opsWord; this.opsQueueNote = opsQueueNote;', cx);
  assert.equal(cx.opsPill('red'), 'bad'); assert.equal(cx.opsPill('amber'), 'warn'); assert.equal(cx.opsPill('green'), 'ok'); assert.equal(cx.opsPill(undefined), 'ok');
  assert.equal(cx.opsWord('red'), 'Action needed'); assert.equal(cx.opsWord('amber'), 'Check'); assert.equal(cx.opsWord('green'), 'All good');
  assert.match(cx.opsQueueNote({ waiting: 2, oldest_waiting: 'x', level: 'red' }), /sender may be off/);
  assert.equal(cx.opsQueueNote({ waiting: 0, failed_24h: 3, level: 'amber' }), '3 failed in the last 24 hours.');
  assert.equal(cx.opsQueueNote({ waiting: 0, failed_24h: 0, level: 'green' }), '');
});
t('daily prod smoke: prod repo only, schedule + by hand, no secrets, one alert issue, Sentry URL validated', () => {
  assert.match(WF, /schedule:\n\s+- cron: '23 1 \* \* \*'/); assert.match(WF, /workflow_dispatch:/);
  assert.match(WF, /if: github\.repository == 'praneethreddykiwik\/Helm' \|\| github\.event_name == 'workflow_dispatch'/);
  assert.ok(!/secrets\./.test(WF), 'no secrets');
  assert.match(WF, /permissions:\n\s+contents: read\n\s+issues: write/);
  assert.match(WF, /node tests\/smoke\/anon\.mjs --target=prod/);
  assert.match(WF, /SMOKE_SIGNED_IN: '0'/); assert.match(WF, /SMOKE_CHANNEL_CHECK: '0'/);
  assert.match(WF, /title="Daily prod smoke is failing"/);
  assert.match(WF, /\^https:\/\/\[a-z0-9\.-\]\+\\\.ingest/);
  for (const m of WF.matchAll(/uses: ([^\s]+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, m[1]);
});
t('npm run ci: the local cache-bust check runs before the CSP / client-api checks', () => {
  assert.match(PK.scripts.ci, /node scripts\/check-asset-bump-local\.mjs && node scripts\/gen-csp\.mjs --check/);
  const s = rd('scripts/check-asset-bump-local.mjs');
  assert.match(s, /'--check', '--base', b\.base/); assert.ok(!/--apply'/.test(s.replace(/^.*Fix:.*$/m, '')), 'read-only');
  assert.match(s, /merge-base', 'HEAD', want/);
});
console.log(`r236-ops-health: ${n} passed`);
