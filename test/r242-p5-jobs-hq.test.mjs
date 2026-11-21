// r242-p5-jobs-hq.test.mjs - R242 fix plan Phase 5 shape checks, no database: migrations 0409-0412 + their APPLY files are
// additive, ASCII, paste-safe (begin + lock_timeout + statement_timeout, the migration verbatim, check rows, commit), carry no
// secret and never unschedule / re-command a cron job; the 5 other mailers use the shared send ledger; render-photo maps the
// Helm-wide cap hints and marks every stored picture; the builder + booklet label AI photos; HQ shows the read-only Switches
// list behind the schema gate; every APPLY since 0401 keeps the lock_timeout template (DB-05).
// The database side: tests/db/r242-p5-jobs-0409-0412.sql + tests/db/r242-p5-order.sh; the edge side: tests/edge/r242-p5-senders.test.ts.
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const NUMS = ['0409', '0410', '0411', '0412'];
const MIG = Object.fromEntries(NUMS.map((n) => [n, rd('supabase/migrations/' + readdirSync(new URL('../supabase/migrations/', import.meta.url)).find((f) => f.startsWith(n + '_')))]));
const APPLY = Object.fromEntries(NUMS.map((n) => [n, rd(`supabase/APPLY-${n}.sql`)]));
const MF = rd('supabase/migrations/MANIFEST'), RA = rd('scripts/db-test/run-all.sh'), PK = JSON.parse(rd('package.json'));
const OV = JSON.parse(rd('supabase/check-prod-overrides.json')), CHK = rd('supabase/CHECK-PROD-MIGRATIONS.sql');
const FN = (p) => rd('supabase/functions/' + p);
const J = rd('public/hq.js'), H = rd('public/hq.html'), PR = rd('public/photo-render-ui.js'), BK = rd('public/booklet.js'), SA = rd('public/store-api.js');
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };
const code = (s) => s.replace(/^\s*--.*$/gm, '');

t('migrations + APPLY: ASCII, no temp table / session state, nothing dropped, deleted or truncated', () => {
  for (const nn of NUMS) {
    for (const [f, s] of [[nn, MIG[nn]], ['APPLY-' + nn, APPLY[nn]]]) {
      assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(s), f + ' ASCII');
      assert.ok(!/\bcreate\s+(temp|temporary)\s+table\b/i.test(s), f + ' temp table');
      assert.ok(!/^\s*(drop\s+(table|function|trigger|index|column|view|policy)|truncate|delete\s+from)\b/im.test(code(s)), f + ' drop / delete / truncate');
      assert.ok(!/\bset\s+(session|role)\b/i.test(code(s)), f + ' session state');
      assert.ok(!/^\s*\\/m.test(s), f + ' psql meta-command');
    }
  }
  // the one constraint change: the 0402 lane CHECK replaced by a WIDER one that keeps every old lane
  const m = MIG['0410'];
  assert.match(m, /add constraint ops_send_ledger_lane_chk410 check \(lane in \([^)]*'comms', 'trial_reminder', 'trial_retention',\s+'assign', 'task_wa', 'delivery', 'vendor_request', 'vendor_bill', 'runsheet', 'staff_email', 'staff_update', 'cantwork', 'enquiry',\s+'helm_notice', 'welcome', 'invite', 'security', 'pkg', 'billing'\)\) not valid;/);
  assert.equal((code(m).match(/drop constraint/g) || []).length, 1);
  assert.match(m, /drop constraint if exists ops_send_ledger_lane_chk402/);
});
t('APPLY-0409..0412: begin + lock_timeout 5s + statement_timeout 5min first, the migration verbatim, check rows, commit', () => {
  for (const nn of NUMS) {
    const sql = APPLY[nn].replace(/^--.*\n/gm, '');
    assert.match(sql, /^begin;\nset local lock_timeout = '5s';\nset local statement_timeout = '5min';\n/, nn);
    assert.ok(APPLY[nn].includes(MIG[nn].replace(/\s*$/, '\n')), nn + ' migration verbatim');
    assert.match(APPLY[nn], /select item, ok, note from \([\s\S]*\) v order by item;\ncommit;\n$/, nn);
    assert.equal((APPLY[nn].match(/^begin;$/gm) || []).length, 1); assert.equal((APPLY[nn].match(/^commit;$/gm) || []).length, 1);
  }
});
t('DB-05 (done in 0401, verified): every APPLY-04NN since 0401 opens with lock_timeout + statement_timeout', () => {
  const files = readdirSync(new URL('../supabase/', import.meta.url)).filter((f) => /^APPLY-04\d\d\.sql$/.test(f) && +f.slice(6, 10) >= 401);
  assert.ok(files.length >= 7, files.join(','));   // 0401, 0402, 0403, 0409-0412 (0404-0408 when they land)
  for (const f of files) assert.match(rd('supabase/' + f).replace(/^--.*\n/gm, ''), /^begin;\nset local lock_timeout = '5s';\nset local statement_timeout = '5min';\n/, f);
  assert.match(rd('docs/RUNBOOK-MIGRATIONS.md'), /set local lock_timeout = '5s';/);
});
t('0409 cron: schedule only (alter_job with schedule :=), never unschedule / command; moved only when name + command + schedule match', () => {
  const s = code(MIG['0409']);
  assert.ok(!/cron\.unschedule\s*\(|cron\.schedule\s*\(/.test(s), 'no unschedule / new job');
  assert.equal((s.match(/cron\.alter_job\(job_id := \$1, schedule := \$2\)/g) || []).length, 2);
  assert.ok(!/alter_job\([^)]*command\s*:=/.test(s), 'never changes a command');
  assert.match(s, /if public\._r409_norm\(j\.command\) <> public\._r409_norm\(p\.cmd\) then\s+state := 'kept_owner'/);
  assert.match(s, /elsif j\.schedule = p\.old_schedule then state := case when j\.active then 'can_stagger' else 'paused' end;/);
  assert.ok(!/(select|perform)\s+public\.ops_cron_stagger_undo\(/i.test(s), 'undo is owner-only, never called by the file');
  // every new schedule is a plain comma list that _ops402_every understands (same interval), never minute 0
  for (const m of MIG['0409'].matchAll(/\('([a-z_-]+)',\s+'[^']*(?:''[^']*'')?[^']*',\s+'(\*\/(\d+) \* \* \* \*)',\s+'([0-9,]+) \* \* \* \*', '\d{4}'\)/g)) {
    const every = +m[3], mins = m[4].split(',').map(Number);
    assert.equal(mins.length, 60 / every, m[1] + ' interval');
    assert.ok(!mins.includes(0) && mins.every((x, i) => i === 0 || x - mins[i - 1] === every), m[1] + ' spread');
  }
  assert.equal([...MIG['0409'].matchAll(/^\s+\('helm[a-z_-]+',\s+'select public\./gm)].length, 12);
});
t('0410 wake: AFTER INSERT on pkg_outbox for package codes only, fail-soft (never raises), throttled, owner + test switch', () => {
  const s = MIG['0410'];
  assert.match(s, /create or replace trigger zz_r410_pkg_wake after insert on public\.pkg_outbox for each row\s+when \(new\.kind = ''pkg_otp'' and new\.status = ''pending''\)/);
  assert.match(s, /where w\.last_kick_at < now\(\) - interval '20 seconds'/);
  assert.match(s, /perform public\.ops_kick_mailer\(p_fn\);\s+return true;\s+exception when others then/);
  assert.match(s, /coalesce\(current_setting\('helm\.mailer_wake', true\), ''\) = 'off'/);
  assert.match(s, /pkg_wake   boolean not null default true/);
  assert.ok(!/vault\.decrypted_secrets/.test(s), 'reads Vault only through ops_kick_mailer / by name');
});
t('0411 render cap: BEFORE INSERT on photo_render_usage, pending rows only, plain messages + the 3 hints, kill switch default on', () => {
  const s = MIG['0411'];
  assert.match(s, /create or replace trigger zz_r411_render_cap before insert on public\.photo_render_usage/);
  assert.match(s, /if NEW\.status is distinct from 'pending' then return NEW; end if;/);
  for (const h of ['render_helm_off', 'render_day_cap', 'render_helm_cap']) assert.ok(s.includes(`hint = '${h}'`), h);
  assert.match(s, /renders_on          boolean not null default true/);
  assert.match(s, /add column if not exists ai_generated boolean not null default true/);
  assert.match(s, /grant execute on function public\.render_cap_status\(\) to authenticated/);
});
t('0412 switches: HQ gate, read-only (stable), Vault by NAME from vault.secrets (never decrypted), env text values hidden', () => {
  const s = MIG['0412'];
  assert.match(s, /create or replace function public\.hq_switches\(\)\s+returns jsonb language plpgsql stable security definer[\s\S]*?_hq27_require\(public\._hq27_read_perm\('hq_metrics'\), false\)/);
  assert.match(s, /select exists \(select 1 from vault\.secrets s where s\.name = \$1\)/);
  assert.ok(!/decrypted/.test(code(s)), 'never decrypts');
  assert.match(s, /case when jsonb_typeof\(r\.value\) in \('boolean', 'number', 'null'\) then r\.value else '"set"'::jsonb end/);
  assert.match(s, /grant execute on function public\.helm_schema_version\(\) to authenticated/);
  assert.ok(!/to anon/.test(code(s)), 'nothing for anon');
  for (const nn of [409, 410, 411, 412]) assert.match(s, new RegExp(`\\(${nn}, '0${nn}_r242_`));
});
t('MANIFEST numeric order (0405-0408 left free), checker overrides (notes paste-safe), CHECK-PROD current, release lists, run-all + package', () => {
  const nums = [...MF.matchAll(/^forward  supabase\/migrations\/(\d{4})_/gm)].map((m) => m[1]);
  { const i = nums.indexOf('0403'); assert.deepEqual(nums.slice(i, i + 9), ['0403', '0404', '0405', '0407', '0408', '0409', '0410', '0411', '0412']); }   // R246: 0423+ follow;   // R240: 0405 = insights overview; R241: 0407 + 0408 = concurrent edits; 0406 left free
  for (const nn of NUMS) {
    assert.ok(OV[nn] && OV[nn].note, nn + ' override');
    assert.ok(!/;|\binto\s+[a-z_]/i.test(OV[nn].note), nn + ' note paste-safe');
    assert.match(CHK, new RegExp(`\\('${nn}_r242_[a-z_]+', `));
  }
  assert.ok(OV['0411'].add.includes('marker public._sa54_label(text) Photo render limit'));
  for (const f of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.match(rd(f), /'0403', '0404', '0405', '0407', '0408', '0409', '0410', '0411', '0412'[,\]]/);   // R240: + 0405
  assert.match(RA, /run "r242-p5-jobs-0409-0412" "R242-P5-JOBS-0409-0412: ALL PASS \\\(48\/48\\\)"/);
  assert.match(RA, /run "r242-apply-0409-0412" "APPLY-0409-0412: ALL OK"/);
  assert.match(RA, /run "r242-p5-order" "R242-P5-ORDER: PASS" bash tests\/db\/r242-p5-order\.sh/);
  assert.match(PK.scripts.test, /node test\/r242-p5-jobs-hq\.test\.mjs/);
});
t('the 5 other mailers: shared send ledger (lane names), "already sent" marks without sending, no direct mark of a sent row left', () => {
  const L = FN('_shared/send-ledger.ts');
  assert.match(L, /export const LEDGER_LANES = \["welcome", "invite", "security", "pkg", "billing"\] as const;/);
  assert.match(L, /if \(!error && data !== false\) return true;/);
  for (const [f, lane, mark] of [['invite-mailer/index.ts', 'invite', 'invite_email_outbox_mark'], ['security-alert-mailer/index.ts', 'security', 'security_alert_outbox_mark'],
      ['pkg-client-notify/index.ts', 'pkg', 'pkg_outbox_mark']]) {
    const s = FN(f);
    assert.match(s, new RegExp(`const led = await sendLedger\\(admin, "${lane}", Deno\\.env\\.get\\("[A-Z_]+_MARK_RETRY_MS"\\)\\);`), f);
    assert.match(s, /if \(led\.already\(id\)\) \{/, f);
    assert.equal((s.match(new RegExp(`admin\\.rpc\\("${mark}"`, 'g')) || []).length, 2, f + ' both marks through led.mark');
    assert.equal((s.match(/await led\.mark\(id, /g) || []).length, 2, f);
  }
  const b = FN('billing-reminder/index.ts');
  assert.match(b, /const led = await sendLedger\(admin, "billing", Deno\.env\.get\("BILLING_MARK_RETRY_MS"\)\);/);
  assert.match(b, /await led\.mark\(id, res === "sent", markSent\(id, res === "sent" \? "email" : "skipped"\)\);/);
  assert.match(b, /\.eq\("id", id\)\.is\("sent_at", null\);   \/\/ idempotent mark/);
  const w = FN('welcome-mailer/send.ts');
  assert.match(w, /const led = await sendLedger\(admin, "welcome", env\("WELCOME_MARK_RETRY_MS"\)\);/);
  assert.match(w, /if \(led\.already\(id\)\) status = "sent";/);
  assert.match(FN('comms-dispatch/index.ts'), /from "\.\.\/welcome-mailer\/send\.ts"/, 'comms-dispatch bundles send.ts: redeploy it too');
});
t('render-photo: the 3 cap hints -> 503 / 429 with the database message; aiMark on every stored picture', () => {
  const s = FN('render-photo/index.ts');
  assert.match(s, /if \(hint === "render_helm_off"\) return json\(\{ error: "render_helm_off", message: [^}]+\}, 503\);/);
  assert.match(s, /if \(hint === "render_helm_cap"\) return json\(\{ error: "render_helm_cap", message: [^}]+\}, 429\);/);
  assert.match(s, /if \(hint === "render_day_cap"\) return json\(\{ error: "render_day_cap", message: [^}]+\}, 429\);/);
  assert.match(s, /const bytes = aiMark\(raw, mime\);   \/\/ R242 \(LEG-06\)/);
  assert.match(s, /export const AI_NOTE = "AI-generated image \(Helm photo render\)\. Not a photograph of a real event\.";/);
});
t('builder: AI badge on every photo card, caption + alt + download name, labelled download, cap pre-check; plain messages', () => {
  assert.match(PR, /var badge = el\('span', 'ph-ai', AI_LABEL\);/);
  assert.match(PR, /img\.alt = 'AI-generated photo render of the event plan'/);
  assert.match(PR, /\[AI_LABEL, r\.style, r\.camera, r\.quality\]/);
  assert.match(PR, /dl\.download = aiFileName\(r\.id\);/);
  assert.match(PR, /var capMsg = await capBlock\(params\.n\);/);
  assert.match(rd('public/builder.css'), /\.ph-card \.ph-ai\{position:absolute;/);
  const cx = { Uint8Array, String, Math, Number, window: {}, document: { readyState: 'complete', getElementById: () => null, querySelector: () => null, documentElement: { classList: { contains: () => false } } },
    MutationObserver: function () { this.observe = () => {}; }, setTimeout, clearTimeout, Promise, Blob: function () {}, URL: {} };
  cx.window = cx; vm.createContext(cx); vm.runInContext(PR, cx);
  const A = cx.HelmPhotoAI;
  assert.equal(A.aiFileName('abcdef12-3456-4000-8000-000000000000'), 'event-photo-abcdef12-AI-generated.jpg');
  const out = A.jpegWithComment(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]), 'AI-generated x');
  assert.deepEqual([...out.slice(0, 6)], [0xff, 0xd8, 0xff, 0xfe, 0, 16]);
  assert.equal(String.fromCharCode(...out.slice(6, 20)), 'AI-generated x');
  assert.deepEqual([...out.slice(20)], [0xff, 0xe0, 1, 2]);
  assert.deepEqual([...A.jpegWithComment(new Uint8Array([1, 2, 3]))], [1, 2, 3], 'not a JPEG: unchanged');
  const pe = cx.HelmPhotoRenderUI.plainError;
  assert.equal(pe({ code: 'render_day_cap', message: 'Your studio has made its 40 photo renders for today. You can make more tomorrow.' }), 'Your studio has made its 40 photo renders for today. You can make more tomorrow.');
  assert.match(pe({ code: 'render_helm_cap', message: '<b>x</b>' }), /limit for all studios is reached/);
  assert.match(pe({ code: 'render_helm_off' }), /paused for all studios/);
});
t('client booklet: the photo render is shown as "AI photo" with a visible AI-generated label, alt text and full-size label', () => {
  assert.match(BK, /out\.push\(\{ variant: "photo", label: "AI photo" \}\)/);
  assert.match(BK, /const aiTag = el\("span", "snap-ai", AI_TAG\);/);
  assert.match(BK, /curAlt = isAi \? AI_TAG \+ " photo render of the event" : alt;/);
  assert.match(BK, /const AI_TAG = "AI-generated";/);
  assert.ok(BK.indexOf('const AI_TAG') < BK.indexOf('function dbFigure('), 'declared before use');
  assert.match(rd('public/booklet.css'), /\.snap-ai\{position:absolute;[^}]*print-color-adjust:exact\}/);
});
t('store-api: schema gate (helm_schema_version once per page, has(n) true / false / null, never throws) + capStatus', () => {
  assert.match(SA, /rpc\("helm_schema_version", \{\}\)/);
  assert.match(SA, /capStatus: \(\) => \(supa && mode === "supabase"\s+\? rpc\("render_cap_status", \{\}\)/);
  // run has() against a fake info
  const i0 = SA.indexOf('      has: async (n) => {'), b0 = SA.indexOf('{', i0);
  let d = 0, b1 = b0; for (let k = b0; k < SA.length; k++) { if (SA[k] === '{') d++; else if (SA[k] === '}') { d--; if (d === 0) { b1 = k; break; } } }
  const body = SA.slice(b0, b1 + 1);
  const mk = (info) => { const cx = { BPStore: { schema: { info: async () => info } }, Math, Number }; vm.createContext(cx); vm.runInContext('this.has = async (n) => ' + body, cx); return cx.has; };
  return (async () => {
    const known = mk({ known: true, version: 412, applied: [402, 409, 410, 411, 412] });
    assert.equal(await known(411), true); assert.equal(await known(408), false);
    const old = mk({ known: false, version: 0, applied: [], before: 412 });
    assert.equal(await old(412), false); assert.equal(await old(411), null);
    const err = mk({ known: false, version: 0, applied: [], before: 0 });
    assert.equal(await err(412), null);
  })().catch((e) => { console.error('  FAIL schema has()\n' + e.stack); process.exitCode = 1; });
});
t('HQ: Switches card read-only behind the schema gate (update pending, never an error), site flags as set / not set', () => {
  assert.match(H, /<section class="card" aria-labelledby="hSwitches"><div class="hd"><h2 id="hSwitches">Switches<\/h2>/);
  assert.match(J, /if \(!S \|\| \(await S\.has\(412\)\) !== false\) data = await call\("hq_switches"\)\.catch\(function \(\) \{ return null; \}\);/);
  assert.match(J, /if \(canTab\("overview"\)\) \{ jobs\.push\(loadOverview\(\)\); loadSwitches\(\)\.catch\(function \(\) \{\}\); \}/);
  assert.ok(!/call\("hq_set_|hq_switch_set/.test(J.slice(J.indexOf('function renderSwitches'), J.indexOf('// pure (r126)'))), 'read-only');
  const src = (name) => { const i = J.indexOf('function ' + name + '('); let d = 0; const j = J.indexOf('{', i); for (let k = j; k < J.length; k++) { if (J[k] === '{') d++; else if (J[k] === '}') { d--; if (d === 0) return J.slice(i, k + 1); } } };
  const cx = { String, JSON, Object }; vm.createContext(cx);
  vm.runInContext(['switchWord', 'switchPill', 'siteSwitches'].map(src).join('\n') + '\nthis.switchWord = switchWord; this.switchPill = switchPill; this.siteSwitches = siteSwitches;', cx);
  assert.equal(cx.switchWord({ state: 'on' }), 'On'); assert.equal(cx.switchWord({ state: 'off' }), 'Off');
  assert.equal(cx.switchWord({ state: 'missing' }), 'not on this database'); assert.equal(cx.switchWord({ state: 'value', value: 40 }), '40');
  assert.equal(cx.switchPill({ state: 'off', differs: true }), 'warn'); assert.equal(cx.switchPill({ state: 'on' }), 'ok');
  const site = cx.siteSwitches({ HELM_FEATURES: { payNow: false, manual: true }, SUPABASE_CONFIG: { captcha: { siteKey: '0x4AAAAsecretish' } }, HELM_TELEMETRY: { dsn: 'https://k@o.ingest.sentry.io/1' } });
  assert.equal(JSON.stringify(site.items.map((i) => i.key)), JSON.stringify(['site_manual', 'site_payNow', 'site_turnstile', 'site_sentry']));
  assert.ok(!JSON.stringify(site).includes('0x4AAAA') && !JSON.stringify(site).includes('ingest'), 'keys only as set / not set');
  assert.match(rd('public/page-tours.js'), /Switches below lists every on \/ off switch, read-only \(secrets: set \/ not set\)\." \}/);
});
setTimeout(() => console.log(`r242-p5-jobs-hq: ${n} passed`), 50);
