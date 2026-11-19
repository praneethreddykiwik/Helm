// r229-retire-roles.test.mjs - R229 (owner, 18-19 Nov 2026), the browser / repo side:
//   1. store-api: Event coordinator / Designer / Crew are never OFFERED (auth.admin.roles, staff.staffRoles) but stay
//      known (labels, old staff words still recognised), isRetiredRole / retiredRoles for the "Retired role" hint
//   2. Settings -> Users & invites: Add user / Invite default to Event manager; a person who still has a retired role
//      keeps it in the dropdown with "Retired role - choose a new one"; onboarding / trial invite pickers default Event manager
//   3. Staff page: "Save and invite to sign in" off, Role field gone from Add staff (read-only on an existing record,
//      never sent on save), the card's "Invite to log in" hidden (a waiting invite can still be copied / re-sent / cancelled)
//   4. Sign-in notice roles list without coordinator / designer
//   5. SQL 0398: MANIFEST + run-all + both DB suites + release lists, APPLY = migration verbatim + check rows, ASCII,
//      the owner-run DELETE file is separate (never in APPLY) and stops without a typed number
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0;
const t = async (name, fn) => { try { await fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };
const API = rd('public/store-api.js'), C = rd('public/control.html'), S = rd('public/staff.html');
const SQL = rd('supabase/migrations/0398_r229_retire_roles.sql'), APPLY = rd('supabase/APPLY-0398.sql');
const DEL = rd('supabase/DELETE-0398-RETIRED-ROLE-USERS.sql'), MAN = rd('supabase/migrations/MANIFEST'), RUN = rd('scripts/db-test/run-all.sh');

/* 1 */
await t('store-api: retired roles never offered, still known', () => {
  const m = API.match(/const ALL_ROLES {2}= (\[[^\]]+\]);/); assert.ok(m);
  const ALL = JSON.parse(m[1]);
  assert.match(API, /const RETIRED_ROLES = \["coordinator", "designer", "crew"\];/);
  assert.match(API, /const PICK_ROLES = KNOWN_ROLES\.filter\(\(r\) => !RETIRED_ROLES\.includes\(r\)\);/);
  const RET = ['coordinator', 'designer', 'crew'], KNOWN = ALL.filter((r) => r !== 'worker'), PICK = KNOWN.filter((r) => !RET.includes(r));
  for (const r of RET) assert.ok(!PICK.includes(r), r);
  for (const r of ['admin', 'manager', 'planner', 'sales', 'supervisor', 'quality', 'operations']) assert.ok(PICK.includes(r), r);
  assert.match(API, /roles: \(\) => PICK_ROLES\.slice\(\),\n {6}\/\/ R229[^\n]*\n {6}retiredRoles: \(\) => RETIRED_ROLES\.slice\(\),\n {6}isRetiredRole,/);
  assert.match(API, /staffRoles: \(\) => PICK_ROLES\.filter\(\(r\) => r !== "client"\)/);
  assert.match(API, /for \(const r of KNOWN_ROLES\) if \(r !== "client" && \(t === r \|\| t === roleLabel\(r\)\.toLowerCase\(\)\)\) return r;/);
  assert.match(API, /coordinator: "Event coordinator"/, 'labels kept for old rows');
});

/* 2 */
await t('Users & invites: defaults Event manager; a retired role stays selected with the hint', () => {
  assert.match(C, /ROLES\.map\(r=>`<option value="\$\{esc\(r\)\}"\$\{r==="manager"\?" selected":""\}>/);
  assert.doesNotMatch(C, /r==="crew"\?" selected"|r==="coordinator"\?" selected"/);
  assert.match(C, /const retiredHint=\(u\)=>/);
  assert.match(C, /Retired role — choose a new one/);
  assert.match(C, /\(u\.role&&!noAccess\(u\)&&!roles\.includes\(u\.role\)\?roles\.concat\(\[u\.role\]\):roles\)/, 'current value kept in the dropdown');
  assert.match(C, /<\/select>\$\{retiredHint\(u\)\}`;/);
  const OB = rd('public/onboarding.js'), TD = rd('public/trial-demo.js');
  assert.match(OB, /r === \(v\.role \|\| "manager"\)/); assert.doesNotMatch(OB, /"coordinator"/);
  assert.match(TD, /if \(r === "manager"\) o\.selected = true;/); assert.doesNotMatch(TD, /r === "coordinator"/);
});

/* 3 */
await t('Staff page: no Save-and-invite, no Role on Add staff, Invite to log in hidden, role never sent', () => {
  assert.match(S, /const STAFF_LOGIN_INVITES_ON = false;/);
  assert.match(S, /\$\("#s_access"\)\.hidden=!STAFF_LOGIN_INVITES_ON\|\|!!s\|\|!isAdminUser;/);
  assert.match(S, /<div class="fld" id="s_role_fld" hidden><label for="s_role">Role<\/label><select id="s_role" aria-describedby="s_role_hint" disabled>/);
  assert.match(S, /const shown=!!s&&\(linked\|\|!!String\(s\.role\|\|""\)\.trim\(\)\); \$\("#s_role_fld"\)\.hidden=!shown; sel\.disabled=true;/);
  assert.match(S, /delete rec\.role;/);
  assert.match(S, /const loginRoleChange=null;/);
  assert.match(S, /&&\(STAFF_LOGIN_INVITES_ON\|\|BPStore\.staff\.loginStatus\(s,invites\)==="invited"\)\?`<button class="ic" data-act="invite"/);
  assert.match(S, /if\(!STAFF_LOGIN_INVITES_ON && BPStore\.staff\.loginStatus\(s,invites\)!=="invited"\)/);
  // the form fields the owner listed are all still there
  for (const id of ['s_name', 's_dept', 's_emp', 's_phone', 's_email', 's_rate', 's_skills', 's_notes', 's_attrs_box']) assert.ok(S.includes('id="' + id + '"'), id);
});

/* 4 */
await t('sign-in notice roles: no coordinator / designer, crew kept', () => {
  const w = {}; vm.runInNewContext(rd('public/signin-notice-ui.js'), { window: w, globalThis: w, document: undefined });
  const m = rd('public/signin-notice-ui.js').match(/var ALL = (\[[^\]]+\]);/); const ALL = JSON.parse(m[1]);
  assert.ok(!ALL.includes('coordinator') && !ALL.includes('designer') && ALL.includes('crew'));
});

/* 5 */
await t('SQL 0398: MANIFEST, run-all, APPLY verbatim + checks, ASCII, DELETE file separate and guarded', () => {
  assert.match(MAN, /\nforward {2}supabase\/migrations\/0398_r229_retire_roles\.sql\n/);
  assert.match(RUN, /-c helm\.retired_role_gate=off"/);
  assert.match(RUN, /run "r229-retire-roles-0398" "R229-RETIRE-ROLES-0398: ALL PASS \\\(22\/22\\\)"/);
  assert.match(RUN, /run "r229-delete-retired-users-0398" "R229-DELETE-0398: PASS" bash tests\/db\/r229-delete-retired-users-0398\.sh/);
  assert.ok(APPLY.includes(SQL), 'APPLY carries the migration verbatim');
  assert.match(APPLY, /^begin;$/m); assert.match(APPLY, /\) v\(item, ok\) order by item;\ncommit;\n$/);
  for (const [f, s] of [['0398', SQL], ['APPLY', APPLY], ['DELETE', DEL]]) assert.ok(!/[^\x00-\x7F]/.test(s), f + ' ASCII only');
  for (const s of [SQL, APPLY, DEL]) assert.doesNotMatch(s, /create temp|set session|\bset local\b|set_config\(/i, 'no temp tables / session state');
  // the migration deletes nothing; only the owner-run file does
  assert.doesNotMatch(SQL, /\bdelete from\b/i); assert.doesNotMatch(SQL, /\bdrop table\b/i);
  assert.ok(!APPLY.includes('DELETE-0398') || /SEPARATE, owner-run file/.test(APPLY));
  assert.doesNotMatch(APPLY, /delete from auth\.users|delete from public\.profiles/i);
  assert.match(DEL, /v_expected int := null;/);
  assert.match(DEL, /if v_expected is null then\n {4}raise exception 'STOP: type the number/);
  assert.match(DEL, /where p\.role in \('coordinator', 'designer'\)/);
  assert.doesNotMatch(DEL, /role in \([^)]*'crew'/, 'crew logins never selected for deletion');
  assert.match(DEL, /platform_admins/); assert.match(DEL, /_r283_owner/);
  for (const f of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.match(rd(f), /'0397', '0398'(, '0\d{3}')*\]/, f);
});

/* 6 */
await t('Transfer ownership is off (UI only): switch false, no tour step, no search entries', () => {
  assert.match(rd('public/team-safety.js'), /const TRANSFER_OWNERSHIP_ON = false;/);
  assert.doesNotMatch(rd('public/page-tours.js'), /sel: "#ts_danger"/);
  assert.doesNotMatch(rd('public/search-catalog.js'), /\["users", "(Danger zone|Transfer ownership)"/);
});

console.log(process.exitCode ? 'R229 tests FAILED' : `R229 tests: ${n}/${n} ok`);
