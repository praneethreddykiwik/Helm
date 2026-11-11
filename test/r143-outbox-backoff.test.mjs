// r143: outbox retry backoff + WhatsApp STOP / START ordering (0342). Static checks; behaviour of 0342:
// tests/db/r143-outbox-backoff-0342.sql, wa-webhook runtime: tests/edge/integration-accounts.test.ts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0;
const t = async (name, fn) => { try { await fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };
const SQL = r('supabase/migrations/0342_r143_outbox_backoff.sql'), APPLY = r('supabase/APPLY-0342.sql'), MF = r('supabase/migrations/MANIFEST');
const WAW = r('supabase/functions/wa-webhook/index.ts');
const code = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

await t('0342: in the manifest after 0340, APPLY carries it verbatim in one transaction, ASCII only', () => {
  assert.ok(MF.indexOf('forward  supabase/migrations/0340_r136_audit_via.sql') < MF.indexOf('forward  supabase/migrations/0342_r143_outbox_backoff.sql'));
  assert.ok(!/forward  supabase\/migrations\/0339_/.test(MF), '0339 stays reserved for the parked branch');
  assert.match(MF, /# 0342 \(R143[^\n]*Nothing dropped or deleted\. Safe to run twice\./);
  assert.ok(APPLY.includes(SQL.trim())); assert.match(APPLY, /^begin;$/m); assert.ok(APPLY.indexOf('commit;') < APPLY.indexOf('-- VERIFY'));
  for (const s of [SQL, APPLY]) assert.ok(/^[\x00-\x7F]*$/.test(s));
});
await t('0342: editor-safe - no apostrophe, quote or semicolon in any comment line, no temp table / session state', () => {
  for (const l of APPLY.split('\n').filter((x) => x.trim().startsWith('--'))) assert.doesNotMatch(l, /['";]/, l);
  assert.doesNotMatch(code, /\btemp(orary)?\s+table\b/i);
  assert.doesNotMatch(code, /^\s*set\s+(local\s+)?[a-z_.]+\s*(=|to)\b/im);
});
await t('0342: additive - nothing dropped / deleted / truncated, old bodies kept as __pre0342 with no privilege', () => {
  assert.doesNotMatch(code, /\bdrop\s+(table|column|policy|schema|view|function|trigger|index)\b/i);
  assert.doesNotMatch(code, /\bdelete\s+from\b/i); assert.doesNotMatch(code, /\btruncate\b/i);
  assert.match(code, /add column if not exists next_attempt_at timestamptz/);
  assert.match(code, /alter table public\.whatsapp_opt_outs add column if not exists last_event_at timestamptz/);
  assert.match(code, /v_name \|\| '__pre0342'/);
  assert.match(code, /foreach r in array array\['anon', 'authenticated', 'service_role'\]/);
  assert.match(code, /create or replace trigger zz_r342_backoff before update of %I on public\.%I/);
});
await t('0342: backoff 1 2 4 8 16 30 60 minutes + jitter, 8 tries (codes 5), lease = next try - 10 minutes, send window respected', () => {
  assert.match(code, /when coalesce\(p_attempts, 0\) <= 1 then 1 when p_attempts = 2 then 2 when p_attempts = 3 then 4\s+when p_attempts = 4 then 8 when p_attempts = 5 then 16 when p_attempts = 6 then 30 else 60 end/);
  assert.match(code, /\(1 \+ 0\.1 \* random\(\)\)/);
  assert.match(code, /when p_kind = 'pkg_otp' then 5\s+else 8 end/);
  assert.match(code, /c\[1\], v_next - interval '10 minutes'/);
  assert.match(code, /public\._sw290_not_before\(TG_TABLE_NAME, n, v_next\)/);
  assert.match(code, /TG_TABLE_NAME = 'pkg_outbox' and coalesce\(n ->> 'kind', ''\) = 'pkg_otp' then return NEW/);
  // time-sensitive queues are not in the list
  for (const q of ['task_wa_outbox', 'runsheet_reminder_sends', 'delivery_reminder_sends']) assert.ok(!code.includes("'" + q + "'"), q);
  assert.equal((code.match(/'attempts >= 5'|'email_attempts >= 5'/g) || []).length, 17);
  assert.match(code, /if v_n = 0 and f\[4\] = 'optional' then continue; end if;/);
});
await t('0342: STOP / START - newest wins (STOP on a tie), replay ignored in the same call, old 3-argument call kept', () => {
  assert.match(code, /where excluded\.last_event_at > coalesce\(w\.last_event_at, w\.updated_at\)\s+or \(excluded\.last_event_at = coalesce\(w\.last_event_at, w\.updated_at\) and excluded\.opted_out\)/);
  assert.match(code, /v_rec := public\.wa_record_event\('optout:' \|\| v_mid/);
  assert.match(code, /return public\.wa_set_opt_out\(p_phone_number_id, p_phone, p_opted_out, null::timestamptz, null::text\);/);
  assert.match(code, /grant execute on function public\.wa_set_opt_out\(text, text, boolean, timestamptz, text\) to service_role/);
});
await t('wa-webhook: HMAC before parse + constant-time compare unchanged; opt-out = one call with Meta time + id; old database fallback', () => {
  assert.ok(WAW.indexOf('x-hub-signature-256') < WAW.indexOf('JSON.parse(raw)'));
  assert.match(WAW, /if \(!timingSafeEqual\("sha256=" \+ await hmacHex\(appSecret, raw\), sig\)\) return new Response\("invalid signature", \{ status: 401 \}\);/);
  assert.match(WAW, /for \(let i = 0; i < a\.length; i\+\+\) diff \|= a\.charCodeAt\(i\) \^ b\.charCodeAt\(i\);/);
  assert.match(WAW, /p_event_at: metaTime\(m\.timestamp\), p_message_id: ID\(m\.id\)/);
  assert.match(WAW, /const NO_0342 = \/\^\(PGRST202\|42883\)\$\/;/);
  assert.doesNotMatch(WAW, /p_event_id: `optout:\$\{mid\}`/, 'no separate event action before the opt-out any more');
});
await t('suites: DB suite in run-all with its count, older suites run with the backoff off, release lists carry 0342', () => {
  const ra = r('scripts/db-test/run-all.sh');
  assert.match(ra, /run "r143-outbox-backoff-0342" "R143-OUTBOX-BACKOFF-0342: ALL PASS \\\(55\/55\\\)" psql -q -f tests\/db\/r143-outbox-backoff-0342\.sql/);
  assert.match(ra, /-c helm\.retry_backoff=off"/);
  for (const f of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.match(r(f), /'0340', '0342'\]/, f);
});
console.log(`r143-outbox-backoff: ${n} passed`);
