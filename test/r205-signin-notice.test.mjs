// r205-signin-notice.test.mjs - R205 (owner 18 Nov 2026): "When someone logs in, the admin should get a notification like
// 'a person with role X logged in'." Static + pure checks (behaviour: tests/db/r205-signin-notice-0383.sql).
//   1. signin-notice-ui.js: the plain-words rule, the role cleaner, CSP-safe building (no HTML strings).
//   2. store-api.js: the bell kind team_signin (label, type, deep link to Settings -> Users & invites -> that person), the
//      Settings calls, the audit words, the fallback ping (once per session, only SIGNED_IN / INITIAL_SESSION, never blocks).
//   3. control.html: the card on the Notifications tab, the script, ?person=<id>#users opens that person; page tour step.
//   4. 0383 files: migration (exception-safe triggers, definer + empty search_path, wraps once, no delete, ASCII), APPLY paste
//      file, MANIFEST, checker override, run-all (+ the quiet switch for the other suites), release lists, CHECK-PROD, pins.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ROOT = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
let n = 0;
const t = async (name, fn) => { try { await fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };
const fnSrc = (src, name) => {
  const at = src.indexOf('function ' + name + '('); assert.ok(at >= 0, name + ' missing');
  let d = 0; for (let k = src.indexOf('{', src.indexOf(')', at)); k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}' && !--d) return src.slice(at, k + 1); }
  throw new Error(name + ' unterminated');
};
const UI = read('public/signin-notice-ui.js'), API = read('public/store-api.js'), CTL = read('public/control.html'), TOURS = read('public/page-tours.js');
const SN = require('../public/signin-notice-ui.js');
const UID = '804439b1-5769-4c23-9232-8a045851612f';

/* ---------------------------------------------------------------- 1. signin-notice-ui.js */
await t('explain(): default = first sign-in each day, anyone except Crew; every; off; a custom role list', () => {
  const all = SN.ALL;
  const def = SN.explain({ mode: 'first_daily', roles: all.filter((r) => r !== 'crew'), roles_default: true, roles_all: all });
  assert.match(def, /^When anyone except Crew signs in, the studio owner and admins get a bell notice with their name, role, the time \(studio clock\) and the browser - for their first sign-in each day\./);
  assert.match(def, /signed in for the first time/); assert.match(def, /never get a notice about your own sign-in/); assert.match(def, /Helm support staff never cause one/);
  assert.match(SN.explain({ mode: 'every', roles: all, roles_default: false, roles_all: all }), /^When anyone in the studio signs in, .* every time \(at most once per person every 10 minutes\)\./);
  assert.match(SN.explain({ mode: 'every', roles: ['planner', 'crew'], roles_default: false, roles_all: all }), /^When Planner, Crew signs in/);
  assert.equal(SN.explain({ mode: 'off' }), 'Sign-in notices are off. Each sign-in is still written to the Audit log.');
  assert.match(SN.explain({ mode: 'first_daily', roles: [], roles_all: all }), /^When nobody \(no role ticked\) signs in/);
});
await t('pickRoles(): known roles only, lower case, trimmed, no duplicates, in the list order; labels match the app', () => {
  assert.deepEqual(SN.pickRoles([' Crew', 'planner', 'client', 'planner', 'ADMIN', 7, null]), ['admin', 'planner', 'crew']);
  assert.deepEqual(SN.pickRoles('x'), []);
  assert.equal(SN.roleLabel('manager'), 'Event manager'); assert.equal(SN.roleLabel('supervisor'), 'Supervisor'); assert.equal(SN.roleLabel('crew'), 'Crew');
  assert.deepEqual(SN.MODES.map((m) => m[0]), ['first_daily', 'every', 'off']);
  assert.deepEqual(SN.MODES.map((m) => m[1]), ['First sign-in each day', 'Every sign-in', 'Off']);
});
await t('the card: CSP-safe (createElement / textContent), hidden without 0383, admins only, roles null = default, digest off', () => {
  assert.doesNotMatch(UI, /innerHTML|insertAdjacentHTML|outerHTML|document\.write|eval\(/);
  assert.match(UI, /if \(!host \|\| !R \|\| typeof R\.settings !== "function"\) \{ if \(host\) host\.hidden = true; return Promise\.resolve\(false\); \}/);
  assert.match(UI, /if \(!c \|\| typeof c !== "object"\) \{ host\.hidden = true; return false; \}/);
  assert.match(UI, /R\.saveSettings\(\{ mode: mode, roles: useDefault \? null : roles \}\)/);
  assert.match(UI, /if \(mode !== "off" && !roles\.length\) \{ msg\.textContent = "Tick at least one role, or choose Off\."; return; \}/);
  assert.match(UI, /Only studio admins can change this\./); assert.match(UI, /E-mail digest of sign-ins: off \(not available yet\)/);
  assert.match(UI, /never the network address/);
});

/* ---------------------------------------------------------------- 2. store-api.js */
await t('bell: team_signin deep link -> control.html?person=<id>#users (bad id -> the Users tab); type + label', () => {
  const ctx = { URLSearchParams }; vm.runInNewContext(['notifLink', 'bellTypeOf'].map((f) => fnSrc(API, f)).join('\n') + '\nglobalThis.link=notifLink; globalThis.typeOf=bellTypeOf;', ctx);
  assert.equal(ctx.link({ kind: 'team_signin', detail: { user_id: UID } }), 'control.html?person=' + UID + '#users');
  assert.equal(ctx.link({ kind: 'team_signin', detail: { user_id: 'javascript:alert(1)' } }), 'control.html#users');
  assert.equal(ctx.link({ kind: 'team_signin', detail: {} }), 'control.html#users');
  assert.equal(ctx.typeOf({ kind: 'team_signin' }), 'team_signin');
  assert.match(API, /team_signin: \["👋", String\(d\.label \|\| \(\(d\.name \|\| "A teammate"\) \+ " signed in" \+ \(d\.first_time \? " for the first time" : ""\)\)\)\],/);
  assert.match(API, /team_signin: "Teammate sign-ins",/);
});
await t('Settings calls + audit words', () => {
  assert.match(API, /settings: \(\) => \(supa \? rpc\("signin_notice_settings_get", \{\}\)\.catch\(\(e\) => \{ if \(rpcMissing\(e\)\) return null; throw e; \}\) : Promise\.resolve\(null\)\),/);
  assert.match(API, /saveSettings: \(patch\) => \(supa \? rpc\("signin_notice_settings_set", \{ p: patch \|\| \{\} \}\)/);
  assert.match(API, /\n    signinNotice,    \/\/ R205 \(0383\)\n/);
  assert.match(API, /"auth\.sign_in": "Signed in", "signin_notice\.settings": "Sign-in notices changed" \};/);
  const ctx = {}; vm.runInNewContext(['auditHuman', 'auditEventText', 'auditDescribe'].map((f) => fnSrc(API, f)).join('\n') + '\nglobalThis.d=auditDescribe;', ctx);
  assert.equal(ctx.d({ action: 'auth.sign_in', changed: { first_time: true, device: 'Chrome on Windows' } }), 'Signed in for the first time (Chrome on Windows)');
  assert.equal(ctx.d({ action: 'auth.sign_in', changed: {} }), 'Signed in');
  assert.equal(ctx.d({ action: 'signin_notice.settings', changed: { to: { mode: 'every' } } }), 'Changed the sign-in notices to Every sign-in');
});
await t('fallback ping: once per session per tab, after the page settled, never throws, stops asking while the trigger is on', () => {
  const ping = fnSrc(API, 'signinPing'), sid = fnSrc(API, 'jwtSessionId');
  assert.match(ping, /const sid = jwtSessionId\(sess\.access_token\); if \(!sid\) return;/);
  assert.match(ping, /sessionStorage\.getItem\("helm\.r383\.ping"\) === sid\) return;/);
  assert.match(ping, /supa\.rpc\("signin_notice_ping", \{ p_ua: /);
  assert.match(ping, /\}, 4000\);/);
  assert.match(ping, /if \(via === "trigger" \|\| missing\)/);
  assert.match(API, /if \(\(event === "SIGNED_IN" \|\| event === "INITIAL_SESSION"\) && sess && sess\.user\) signinPing\(sess\);   \/\/ R205 \(0383\) fallback only/);
  const ctx = { atob: (s) => Buffer.from(s, 'base64').toString('binary') }; vm.runInNewContext(sid + '\nglobalThis.s=jwtSessionId;', ctx);
  const tok = (o) => 'h.' + Buffer.from(JSON.stringify(o)).toString('base64url') + '.x';
  assert.equal(ctx.s(tok({ session_id: UID })), UID); assert.equal(ctx.s(tok({ session_id: 'x' })), ''); assert.equal(ctx.s('nope'), '');
});

/* ---------------------------------------------------------------- 3. control.html + page tours */
await t('control.html: the card on the Notifications tab, the script, the init, ?person=<id>#users opens that person', () => {
  assert.match(CTL, /<div class="card" id="sinCard" hidden><\/div>/);
  assert.ok(CTL.indexOf('id="trmCard"') < CTL.indexOf('id="sinCard"') && CTL.indexOf('id="sinCard"') < CTL.indexOf('id="commsCard"'), 'between task reminders and client messages');
  assert.match(CTL, /<script src="task-reminders-ui\.js\?v=8"><\/script><script src="signin-notice-ui\.js\?v=3"><\/script>/);
  assert.match(CTL, /if\(typeof HelmSigninNotice!=="undefined"\) HelmSigninNotice\.settingsCard\(\$\("#sinCard"\)\);   \/\/ R205 \(0383\) teammate sign-ins/);
  assert.match(CTL, /if\(location\.hash==="#users"\)\{ switchTab\("users"\); openPersonFromLink\(\); \}/);
  const f = fnSrc(CTL, 'openPersonFromLink');
  assert.match(f, /if\(!\/\^\[0-9a-f-\]\{36\}\$\/i\.test\(pid\) \|\| !usersTabP\) return;/);
  assert.match(f, /const u=ucRows\.find\(x=>ucId\(x\)===pid\); if\(!u\) return;/);
  assert.match(f, /viewMember\(u, team\);/); assert.match(f, /url\.searchParams\.delete\("person"\)/);
});
await t('page tour: the Notifications section explains Teammate sign-ins', () => {
  assert.match(TOURS, /\{ sel: "#sinCard", title: "Teammate sign-ins", desc: "When a teammate signs in, the owner and admins get a bell notice: name, role, time and browser\. Choose Off, First sign-in each day \(the default\) or Every sign-in, and which roles count\."/);
  assert.ok(TOURS.indexOf('sel: "#trmCard"') < TOURS.indexOf('sel: "#sinCard"'));
});

/* ---------------------------------------------------------------- 4. 0383 + release files + pins */
const MIG = read('supabase/migrations/0383_r205_signin_notice.sql'), APPLY = read('supabase/APPLY-0383.sql');
const code = MIG.replace(/--.*$/gm, '');
await t('0383: triggers never raise, real sign-ins only, refresh ignored, 10-minute + daily rules, recipients, HQ never; ASCII', () => {
  assert.doesNotMatch(MIG, /[^\x00-\x7F]/, 'ASCII only'); assert.doesNotMatch(APPLY, /[^\x00-\x7F]/, 'ASCII only');
  assert.match(MIG, /create trigger zz_r383_signin_notice after update of last_sign_in_at on auth\.users\s+for each row execute function public\.tg_r383_signin\(\);\nexception when insufficient_privilege then/);
  assert.match(MIG, /create trigger zz_r383_join_notice after update of org_id on public\.profiles/);
  for (const f of ['tg_r383_signin', 'tg_r383_join']) {
    const body = MIG.slice(MIG.indexOf('function public.' + f + '()'), MIG.indexOf('end $fn$;', MIG.indexOf('function public.' + f + '()')));
    assert.match(body, /exception when others then raise warning 'r205-0383: (sign-in|join) notice skipped \(%\)', sqlstate;\s*end;\s*return null;/, f);
    assert.match(body, /if not public\._r383_trigger_may\(\) then return null; end if;/, f);
  }
  assert.match(MIG, /if p_session is not null and exists \(select 1 from public\.signin_notice_log l where l\.session_id = p_session\) then return 0; end if;/);
  assert.match(MIG, /and l\.signed_in_at > v_now - interval '10 minutes'\) then v_reason := 'within_10_min';/);
  assert.match(MIG, /and l\.signed_in_at >= \(\(v_now at time zone v_tz\)::date\)::timestamp at time zone v_tz\) then v_reason := 'not_first_today';/);
  assert.match(MIG, /where p\.org_id = v_org and \(lower\(coalesce\(p\.role, ''\)\) = 'admin' or p\.id = v_owner\)\s+and p\.id <> p_uid and not public\._r283_is_off\(p\.id, v_org\)/);
  assert.match(MIG, /if public\._r383_is_hq\(v_email\) then return 0; end if;/);
  assert.match(MIG, /session_user::text not in \('postgres', 'supabase_admin'\)/);
  assert.match(MIG, /v_name \|\| ' \(' \|\| public\._r383_role_label\(v_role\) \|\| '\) signed in'\s+\|\| case when v_first then ' for the first time' else '' end\s+\|\| ' ' \|\| chr\(183\) \|\| ' ' \|\| btrim\(to_char\(v_now at time zone v_tz, 'FMHH12:MI AM'\)\)/);
  assert.doesNotMatch(code, /\b(delete\s+from|truncate|drop\s+table|drop\s+function|drop\s+policy)\b/i, 'nothing deleted or dropped (only drop trigger if exists before re-creating it)');
  assert.doesNotMatch(code, /'ip'|\.ip\b|inet/i, 'never the network address');
});
await t('0383: definer + empty search_path, wraps once with __pre0383, policies, grants', () => {
  const definers = [...MIG.matchAll(/create or replace function (public\.[a-z0-9_]+)\([^)]*\)[\s\S]*?\$fn\$/g)].map((m) => m[0]);
  for (const d of definers) if (/security definer/.test(d)) assert.match(d, /set search_path = ''/, d.slice(0, 80));
  for (const f of ['_r23_visible', 'bell_feed']) assert.match(MIG, new RegExp(`to_regprocedure\\('public\\.${f}__pre0383\\((uuid,uuid|integer)\\)'\\) is null then\\s+alter function public\\.${f}\\(`));
  assert.match(MIG, /\('notification_catalog', ''\), \('notification_type_of', 'text,text'\), \('notify_default', 'uuid,text,text,text'\)/);
  for (const p of ['r383_signin_read', 'r383_signin_ins', 'r383_signin_upd']) assert.match(MIG, new RegExp(`create policy ${p} on public\\.notifications as restrictive`));
  assert.match(MIG, /\(detail -> 'notify'\) \? \(\(select auth\.uid\(\)\)::text\)/);
  assert.match(MIG, /foreach f in array array\['public\.signin_notice_settings_get\(\)', 'public\.signin_notice_settings_set\(jsonb\)', 'public\.signin_notice_ping\(text\)',/);
  assert.match(MIG, /revoke all on table ' \|\| t \|\| ' from public/);
  assert.match(MIG, /else execute replace\(v_def, '''notifications''', '''notifications'', ''signin_notice_log'''\); end if;/, 'the sign-in log is purged with a trial studio');
  assert.match(MIG, /'''task_reminder_settings'', ''signin_notice_settings'''\); end if;/, 'the setting is kept like other studio settings');
  assert.match(read('tests/db/trial-retention-0184.sql'), /27b free-trial purge empties signin_notice_log/);
  for (const m of ['r190-0373', 'r186-0369', 'r24-ci-0270', 'r163-0357', 'r163-0358', 'r156-0354']) assert.ok(MIG.includes(m), 'the wrappers name ' + m);
});
await t('APPLY-0383: header, begin; the migration exactly; checks with select item, ok from (values ...); commit - no temp tables / meta-commands', () => {
  assert.ok(APPLY.includes(MIG.trim()), 'carries the migration body exactly');
  assert.match(APPLY, /^-- APPLY-0383[^\n]*\n(--[^\n]*\n)*begin;\n/);
  assert.match(APPLY, /\nselect item, ok from \(values\n[\s\S]*\) v\(item, ok\) order by item;\ncommit;\n$/);
  assert.doesNotMatch(APPLY, /temp table|\\set|\\ir|set local role/i);
  assert.match(APPLY, /If ONLY check 03 is false, this Supabase project refused a trigger on\n-- auth\.users/);
  assert.equal((APPLY.match(/^  \('\d\d /gm) || []).length, 10);
});
await t('MANIFEST, checker override, run-all (+ quiet switch), release lists, CHECK-PROD carries 0383; DB test dates relative', () => {
  const MAN = read('supabase/migrations/MANIFEST');
  assert.ok(MAN.indexOf('forward  supabase/migrations/0378_r199_team_account_status.sql') < MAN.indexOf('forward  supabase/migrations/0383_r205_signin_notice.sql'));
  assert.match(MAN, /# 0383 \(R205, owner 18 Nov 2026:[^\n]*Safe to run twice\. Goes after 0378\.\n/);
  assert.match(read('supabase/check-prod-overrides.json'), /"0383": \{ "note": "teammate sign-in notices[^\n]*"marker public\._r23_visible\(uuid,uuid\) r205-0383"[^\n]*"execute authenticated public\.signin_notice_ping\(text\)"\] \}(,\n|\n\}\n$)/);
  const RA = read('scripts/db-test/run-all.sh');
  assert.match(RA, /run "r205-signin-notice-0383" "R205-SIGNIN-NOTICE-0383: ALL PASS \\\(39\/39\\\)" psql -q -f tests\/db\/r205-signin-notice-0383\.sql/);
  assert.match(RA, /-c helm\.signin_notice=off -c helm\.retry_backoff=off( -c helm\.[a-z0-9_]+=off)*"/);   // R227: + helm.r397_plan_lock=off
  for (const f of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.match(read(f), /'0384', '0383'[,\]]/, f);
  assert.match(read('supabase/CHECK-PROD-MIGRATIONS.sql'), /0383_r205_signin_notice/);
  const DB = read('tests/db/r205-signin-notice-0383.sql');
  assert.match(DB, /v_midnight := \(\(now\(\) at time zone tz\)::date\)::timestamp at time zone tz;/, 'the studio today');
  assert.match(DB, /now\(\) - interval '20 minutes'/); assert.match(DB, /^rollback;$/m);
});
await t('asset pins: store-api v376 + page-tours v56 on every page that loads them', () => {
  for (const f of readdirSync(new URL('../public/', import.meta.url)).filter((x) => x.endsWith('.html'))) {
    const h = read('public/' + f);
    const m = h.match(/store-api\.js\?v=(\d+)/); if (m) assert.equal(m[1], '398', f);
    const p = h.match(/page-tours\.js\?v=(\d+)/); if (p) assert.equal(p[1], '69', f);
  }
});

console.log(`r205-signin-notice: ${n} passed`);
