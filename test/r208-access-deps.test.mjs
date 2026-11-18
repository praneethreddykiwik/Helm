// r208-access-deps.test.mjs - R208 (owner 18 Nov 2026: "How can a Supervisor assign tasks? Is Tasks & crew related to
// Quotes Can change? Show the dependencies properly.")
//   * the new "Assign & send tasks" switch (area 'tasks'): store-api AREAS (one switch, follows Staff until saved),
//     auth.canAssignTasks mirrors the server's _r385_can_assign, role-defaults TEMPLATE = the 0385 SQL template row
//   * access-deps.js: every "needs" line is true in the code (event pages read the event through quotes, Assign needs
//     Staff - Can see on the server, ...), unmet / canAssign / summary behave
//   * Settings -> Access control: Needs line, the hint + one-click Turn on (same save path), "What can this role do?"
//   * Tasks & Crew + the monitor ask canAssignTasks; a role without Templates - Can change adds a task for this event only
//   * migration 0385 + APPLY-0385 static guarantees (additive, patch list, no delete, supervisor row only, verify block)
// Behaviour in the database: tests/db/r208-task-assign-0385.sql.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const r = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ok ' + name); };
const AD = require('../public/access-deps.js');
const RD = require('../public/role-defaults.js');
const API = r('public/store-api.js');
const C = r('public/control.html');
const OPS = r('public/ops.html');
const MIG = r('supabase/migrations/0385_r208_task_assign_access.sql');
const APPLY = r('supabase/APPLY-0385.sql');
const areaKeys = [...API.slice(API.indexOf('const AREAS = ['), API.indexOf('const AREA_FALLBACK')).matchAll(/\{ key: "(\w+)"/g)].map((m) => m[1]);
const cells = (m) => (k) => m[k] || { view: false, edit: false };

await t('store-api: tasks = ONE switch that follows Staff until saved; canAssignTasks mirrors _r385_can_assign', () => {
  assert.match(API, /\{ key: "tasks",\s+label: "Assign & send tasks", icon: "[^"]+", page: null,\s+group: "Resources", defaultFrom: "staff", permission: true \}/);
  assert.ok(areaKeys.indexOf('tasks') === areaKeys.indexOf('staff') + 1, 'right after Staff');
  const fn = API.slice(API.indexOf('async canAssignTasks() {'), API.indexOf('areas: () => AREAS.slice(),\n    // Force'));
  assert.match(fn, /if \(ro\) return false;/);
  assert.match(fn, /if \(r === "admin"\) return true;/);
  assert.match(fn, /if \(acc\.unknown\) return false;/);
  assert.match(fn, /if \(!row\) return !!\(staff && staff\.edit\);/);
  assert.match(fn, /!\["client", "crew", "worker"\]\.includes\(r\) && !!\(row\.view && row\.edit\) && !!\(staff && staff\.view\)/);
});

await t('role-defaults: the tasks row equals the 0385 new-studio seed (Staff-edit roles of the template + supervisor)', () => {
  assert.match(MIG, /select p_org, d\.role, 'tasks', d\.can_edit or d\.role = 'supervisor', d\.can_edit or d\.role = 'supervisor', now\(\)\n\s+from public\._a49_default_matrix\(\) d where d\.area = 'staff'/);
  assert.ok(!/create or replace function public\._a49_default_matrix/.test(MIG), 'the 0239 template itself is not re-issued');
  const want = [...RD.TEMPLATE.staff[1], 'supervisor'].sort();
  assert.deepEqual([...RD.TEMPLATE.tasks[1]].sort(), want); assert.deepEqual([...RD.TEMPLATE.tasks[0]].sort(), want);
  assert.deepEqual(RD.defaultFor('supervisor', 'tasks'), { view: true, edit: true });
  assert.deepEqual(RD.defaultFor('quality', 'tasks'), { view: false, edit: false });
  assert.deepEqual(RD.defaultFor('sales', 'tasks'), { view: false, edit: false });
  for (const role of ['manager', 'planner', 'coordinator', 'operations']) assert.deepEqual(RD.defaultFor(role, 'tasks'), RD.defaultFor(role, 'staff').edit ? { view: true, edit: true } : null, role);
  const team = RD.SECTIONS.find((s) => s.key === 'team').rows.map((x) => x.area);
  assert.deepEqual(team.slice(0, 2), ['staff', 'tasks']);
  const row = RD.SECTIONS.find((s) => s.key === 'team').rows[1];
  assert.match(row.help, /assign, reassign, times, reminders, special, cancel, e-mail or WhatsApp/);
  assert.match(row.help, /Not staff records, wages, open shifts or days off/);
});

await t('access-deps.js: ASCII, every area + target is a real access area, every need has a reason', () => {
  assert.match(fs.readFileSync(new URL('../public/access-deps.js', import.meta.url), 'latin1'), /^[\x00-\x7f]*$/);
  for (const [area, d] of Object.entries(AD.DEPS)) {
    assert.ok(areaKeys.includes(area), area);
    for (const x of [...(d.needs || []), ...(d.uses || [])]) {
      assert.ok(areaKeys.includes(x.area), area + ' -> ' + x.area);
      assert.ok(['view', 'edit'].includes(x.level) && x.why && x.why.length > 8, area + ' -> ' + x.area);
    }
  }
  assert.deepEqual(AD.DEPS.tasks.needs.map((x) => x.area + ':' + x.level), ['staff:view', 'quotes:view']);
  assert.ok(!AD.DEPS.tasks.needs.some((x) => x.area === 'quotes' && x.level === 'edit'), 'tasks never needs Quotes - Can change');
});

await t('access-deps.js: each "needs" is true in the code', () => {
  // every event page loads the event through quotes (read policy = Quotes & workspace - Can see) behind its own area
  const PAGE = { command: 'command', issues: 'issues', media: 'media', runsheet: 'runsheet', logistics: 'logistics', ready: 'ready', plan: 'plan',
    resources: 'resources', discovery: 'discovery', proposal: 'proposal', finance: 'budget', settlement: 'settlement', closure: 'closure' };
  for (const [area, page] of Object.entries(PAGE)) {
    const h = r('public/' + page + '.html');
    assert.ok(AD.DEPS[area].needs.some((x) => x.area === 'quotes' && x.level === 'view'), area);
    assert.match(h, new RegExp('requireView\\("' + area + '"\\)'), page);
    assert.match(h, /quotes\.get\(/, page);
  }
  assert.match(OPS, /BPStore\.auth\.requireView\("staff"\)/); assert.match(OPS, /BPStore\.quotes\.get\(quoteId\)/);
  assert.match(MIG, /and coalesce\(public\.has_area\('staff', 'view'\), false\)/, 'the server asks Staff - Can see for a saved tasks row');
  assert.match(r('public/command.html'), /requireView\("command"\)/);   // the Deliveries tracker lives there
  assert.match(r('supabase/migrations/0282_r32_security_review.sql'), /has_area\('close_owed', 'edit'\)/);
  assert.match(r('supabase/migrations/0095_photo_render.sql'), /has_area\('photo_render', 'edit'\) and public\.has_area\('quotes', 'edit'\)/);
  assert.match(r('public/settlement.html'), /canClaims=canEdit && await BPStore\.auth\.canEditArea\("finance"\)/);
  assert.match(OPS, /BPStore\.ops\.templates\(activeCat\)/);   // ready-made lists = task_templates (Templates - Can see)
});

await t('access-deps.js: unmet / canAssign / summary', () => {
  const sup = { quotes: { view: true, edit: false }, staff: { view: true, edit: false }, tasks: { view: true, edit: true }, command: { view: true, edit: true } };
  assert.deepEqual(AD.unmet('tasks', cells(sup), true), []);
  assert.deepEqual(AD.unmet('tasks', cells({ ...sup, staff: { view: false, edit: false } }), true).map((x) => x.area), ['staff']);
  assert.deepEqual(AD.unmet('tasks', cells({ ...sup, tasks: { view: true, edit: false } }), true), [], 'switch off = nothing needed');
  assert.deepEqual(AD.unmet('tasks', cells(sup), true, 'uses').map((x) => x.area), ['templates']);
  assert.deepEqual(AD.unmet('close_owed', cells({ close_owed: { view: true, edit: true }, closure: { view: true, edit: false } }), true).map((x) => x.area + x.level), ['closureedit']);
  assert.deepEqual(AD.unmet('photo_render', cells({ photo_render: { view: true, edit: false }, quotes: { view: true } }), false), [], 'view only needs quotes view');
  assert.deepEqual(AD.unmet('photo_render', cells({ photo_render: { view: true, edit: true }, quotes: { view: true } }), false).map((x) => x.level), ['edit']);
  // the database rule
  assert.equal(AD.canAssign('supervisor', cells(sup), true), true);
  assert.equal(AD.canAssign('supervisor', cells({ ...sup, staff: { view: false } }), true), false);
  assert.equal(AD.canAssign('crew', cells(sup), true), false);
  assert.equal(AD.canAssign('manager', cells({ staff: { view: true, edit: true } }), false), true, 'no row = Staff - Can change');
  assert.equal(AD.canAssign('supervisor', cells({ staff: { view: true, edit: false } }), false), false);
  assert.equal(AD.canAssign('admin', cells({}), false), true);
  // the owner's example: Supervisor = assign and nudge tasks yes, see crew yes, approve day-off no, see money no
  const s = Object.fromEntries(AD.summary('supervisor', cells(sup), AD.canAssign('supervisor', cells(sup), true)).map((x) => [x.key, x.yes]));
  assert.deepEqual(s, { events: true, quotes: false, assign: true, crew: true, staffed: false, dayoff: false, day: true, money: false, close: false, admin: false });
  const a = AD.summary('admin', cells({}), true); assert.ok(a.every((x) => x.yes));
});

// ---- the Settings screen, run in a tiny sandbox -------------------------------------------------------------------
const SRC = C.slice(C.indexOf('  // 0147: an area with defaultOn'), C.indexOf('  async function initMatrix(){'));
function screen(MTX) {
  const calls = [], boxes = {};
  const $ = (sel) => (boxes[sel] = boxes[sel] || { hidden: true, innerHTML: '', setAttribute() {}, removeAttribute() {}, addEventListener() {} });
  const ALL = [{ key: 'quotes', label: 'Quotes & workspace' }, { key: 'staff', label: 'Staff' },
    { key: 'tasks', label: 'Assign & send tasks', defaultFrom: 'staff', permission: true }, { key: 'templates', label: 'Templates' }, { key: 'finance', label: 'Budget & finance' }];
  const ctx = { window: { HelmRoleDefaults: RD, HelmAccessDeps: AD }, ALL_AREAS: ALL, AREAS: ALL.slice(), MTX, selRole: 'supervisor', mtxErr: null,
    cellPending: 0, cellQueue: Promise.resolve(), $, esc: (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])), errMsg: () => 'E',
    loadMatrix: async () => true, renderMatrix() {}, setCell: (...a) => calls.push(['setCell', ...a]),
    BPUI: { toast() {} }, BPStore: { auth: { admin: { roleLabel: (x) => x[0].toUpperCase() + x.slice(1), setAccess: async (...a) => { calls.push(a); const c = (MTX[a[0]] = MTX[a[0]] || {}); c[a[1]] = { view: a[2], edit: a[3] }; } } } } };
  vm.createContext(ctx);
  vm.runInContext(SRC.replace('const RD', 'var RD').replace('const AD', 'var AD')
    + '\n;this.needsHtml=needsHtml;this.renderSummary=renderSummary;this.depAfter=depAfter;this.renderDep=renderDep;this.fixDeps=fixDeps;this.hint=()=>depHint;', ctx);
  return { ctx, calls, boxes, ALL };
}

await t('Settings: the Needs line shows what each row needs, with a one-click Turn on when it is missing', () => {
  const ok = screen({ supervisor: { quotes: { view: true, edit: false }, staff: { view: true, edit: false }, tasks: { view: true, edit: true } } });
  const line = ok.ctx.needsHtml('supervisor', ok.ALL[2]);
  assert.match(line, /Needs:<\/span>/); assert.match(line, /Staff – Can see/); assert.match(line, /Quotes &amp; workspace \u2013 Can see/);
  assert.match(line, /Also uses:<\/span>/); assert.ok(!/data-fix/.test(line), 'nothing missing -> no button');
  const bad = screen({ supervisor: { quotes: { view: true }, staff: { view: false, edit: false }, tasks: { view: true, edit: true } } });
  const l2 = bad.ctx.needsHtml('supervisor', bad.ALL[2]);
  assert.match(l2, /rm-need miss/); assert.match(l2, /data-fix="tasks">Turn on Staff – Can see<\/button>/);
  assert.equal(bad.ctx.needsHtml('admin', bad.ALL[2]), '', 'admin: nothing to explain');
});

await t('Settings: switching on Assign without Staff - Can see -> hint; Turn on saves Staff - Can see the normal way', async () => {
  const s = screen({ supervisor: { quotes: { view: true }, staff: { view: false, edit: false }, tasks: { view: true, edit: true } } });
  s.ctx.depAfter('supervisor', 'tasks');
  assert.equal(s.ctx.hint().kind, 'needs'); assert.deepEqual(s.ctx.hint().list.map((x) => x.area), ['staff']);
  s.ctx.renderDep();
  assert.equal(s.boxes['#rmDep'].hidden, false);
  assert.match(s.boxes['#rmDep'].innerHTML, /<b>Assign &amp; send tasks \(Tasks &amp; crew\)<\/b> needs Staff – Can see for Supervisor to work\. Turn it on\?/);
  await s.ctx.fixDeps('supervisor', 'tasks', null);
  assert.deepEqual(s.calls, [['supervisor', 'staff', true, false]], 'only switches ON, keeps Can change as it was');
});

await t('Settings: switching Staff - Can see off while Assign is on -> "can no longer use" hint', () => {
  const s = screen({ supervisor: { quotes: { view: true }, staff: { view: false, edit: false }, tasks: { view: true, edit: true } } });
  s.ctx.depAfter('supervisor', 'staff');
  assert.equal(s.ctx.hint().kind, 'breaks'); assert.deepEqual([...s.ctx.hint().list], ['tasks']);
  s.ctx.renderDep();
  assert.match(s.boxes['#rmDep'].innerHTML, /Without <b>Staff<\/b>, Supervisor can no longer use: Assign &amp; send tasks \(Tasks &amp; crew\)\. Turn Staff back on\?/);
  const fine = screen({ supervisor: { quotes: { view: true }, staff: { view: true }, tasks: { view: true, edit: true } } });
  fine.ctx.depAfter('supervisor', 'staff'); assert.equal(fine.ctx.hint(), null);
});

await t('Settings: "What can this role do?" in plain yes / no for the selected role', () => {
  const s = screen({ supervisor: { quotes: { view: true }, staff: { view: true, edit: false }, tasks: { view: true, edit: true } } });
  s.ctx.renderSummary(false);
  const h = s.boxes['#rmSum'].innerHTML;
  assert.equal(s.boxes['#rmSum'].hidden, false);
  assert.match(h, /What can Supervisor do\?/);
  assert.match(h, /class="y" data-k="assign"><span class="rm-yn">Yes<\/span>Assign and nudge tasks on events/);
  assert.match(h, /class="y" data-k="crew"><span class="rm-yn">Yes<\/span>See the crew list/);
  assert.match(h, /class="n" data-k="dayoff"><span class="rm-yn">No<\/span>Approve days off/);
  assert.match(h, /class="n" data-k="money"><span class="rm-yn">No<\/span>See money/);
  // no saved tasks row + only Staff - Can see (a studio before 0385 with the supervisor switched off) -> cannot assign
  const old = screen({ supervisor: { quotes: { view: true }, staff: { view: true, edit: false } } });
  old.ctx.renderSummary(false);
  assert.match(old.boxes['#rmSum'].innerHTML, /class="n" data-k="assign"/);
});

await t('Settings page wiring: scripts, boxes, the fix button handled before the save, same save path, no inline style', () => {
  assert.match(C, /<script src="role-defaults\.js\?v=2"><\/script><script src="access-deps\.js\?v=1"><\/script>/);
  assert.match(C, /<link rel="stylesheet" href="roles-matrix\.css\?v=2">/);
  // the hint sits in the sticky role header, so it is on screen next to whatever row was just switched
  assert.match(C, /<div class="rm-bar" id="rmBar"><\/div>\s*<div class="rm-dep" id="rmDep" role="status" hidden><\/div>\s*<\/div>/);
  assert.match(C, /<div class="rm-sum" id="rmSum" hidden><\/div>\s*<div id="matrix"><\/div>/);
  assert.match(C, /renderBar\(locked\); renderSummary\(locked\); renderDep\(\);/);
  assert.match(C, /const fx=e\.target\.closest\("\[data-fix\]"\); if\(fx\)\{ fixDeps\(selRole, fx\.dataset\.fix, fx\); return; \}[^\n]*\n\s*saveCell\(/);
  assert.match(C, /if\(saved\) depAfter\(role, area\);/);
  assert.match(C, /selRole=b\.dataset\.role; depHint=null;/);
  const seg = C.slice(C.indexOf('  // R208: what each area NEEDS'), C.indexOf('  async function initMatrix(){'));
  assert.ok(!/style="/.test(seg), 'no inline style');
  assert.match(seg, /await BPStore\.auth\.admin\.setAccess\(role, n\.area, true, n\.level==="edit" \? true : !!cur\.edit\)/);
  assert.ok(!/setAccess\([^)]*false, false\)/.test(seg), 'the hint never switches anything off');
  const css = r('public/roles-matrix.css');
  for (const c of ['.rm-needs', '.rm-need.miss', '.rm-dep', '.rm-sum-l', '.rm-yn']) assert.ok(css.includes(c), c);
});

await t('Tasks & Crew + monitor ask canAssignTasks; Templates - Can change off -> a typed task is for this event only', () => {
  assert.match(OPS, /BPStore\.auth\.canAssignTasks \? BPStore\.auth\.canAssignTasks\(\) : BPStore\.auth\.canEditArea\("staff"\)/);
  assert.match(OPS, /BPStore\.auth\.canEditArea\("templates"\)\.catch\(\(\)=>false\)/);
  assert.match(OPS, /else if\(!canTpl\)\{ const b=\$\("#tpl_add"\), i=\$\("#tpl_title"\); if\(b\) b\.textContent="\+ Add for this event";/);
  assert.match(OPS, /if\(!canTpl\)\{ const l=oneOff\[cat\]=oneOff\[cat\]\|\|\[\];[^\n]*\n[^\n]*setMsg\("ok",`Added "\$\{title\.slice\(0,120\)\}" for this event - ticked below\.`\); lastOkMsg=""; return; \}\n\s*try\{ await BPStore\.ops\.addTemplate\(cat,title\); \}/);
  assert.match(OPS, /\(this event only\)/);
  assert.match(OPS, /<script src="ops-board\.js\?v=2"><\/script>/);
  const mon = r('public/monitor.js');
  assert.match(mon, /S\.canEdit = !!\(await \(A\.canAssignTasks \? A\.canAssignTasks\(\) : A\.canEditArea\("staff"\)\)\);/);
  assert.match(r('public/monitor.html'), /monitor\.js\?v=7/);
  assert.match(r('public/ops-board.js'), /Your role can view this page only\. To give out work, an admin switches on \\u201cAssign & send tasks\\u201d/);
  // open shifts + days off keep their own Staff - Can change checks
  assert.match(r('public/crew-shifts.js'), /canEdit = await B\.auth\.canEditArea\("staff"\)/);
});

await t('0385: additive + idempotent; exactly the task calls patched; supervisor row only; RLS untouched', () => {
  assert.match(MIG, /^[\x00-\x7f]*$/, 'ASCII');
  const code = MIG.replace(/--[^\n]*/g, '');
  assert.ok(!/\b(drop|truncate|delete)\b/i.test(code), 'no drop / truncate / delete');
  assert.ok(!/\bupdate\s+public\./i.test(code), 'no row rewritten');
  assert.ok(!/\b(create|alter)\s+policy\b/i.test(code), 'no policy changed');
  const list = [...code.slice(code.indexOf('v_list text[] := array['), code.indexOf('];', code.indexOf('v_list'))).matchAll(/'public\.([a-z0-9_]+)\(/g)].map((m) => m[1]);
  assert.deepEqual(list, ['assign_tasks', 'assign_tasks_vendor', '_r311_reassign_task', 'reassign_task__pre0311', 'cancel_task', 'set_task_schedule',
    'set_task_special', 'set_task_reminders', 'set_task_reminder_times', 'run_task_triggers', 'run_task_reminders', 'staff_email_send',
    'staff_email_hold', 'staff_whatsapp_send', 'staff_link_get', 'work_links_for_event']);
  for (const no of ['staff_link_regenerate', 'open_shift', 'cantwork', 'crew_availability_set', 'event_checkin_site_set', 'admin_revoke_work_links'])
    assert.ok(!list.some((x) => x.startsWith(no)), no + ' stays Staff - Can change');
  assert.match(code, /if n <> 1 then raise notice '0385: % has % Staff-edit checks \(expected exactly 1\) - left unchanged'/);
  assert.match(code, /if position\('r208-0385' in v_def\) > 0 then continue; end if;/);
  assert.match(code, /select o\.id, d\.role, d\.area, d\.can_view, d\.can_edit, now\(\)\s+from public\.organizations o\s+join public\._a49_default_matrix\(\) d on d\.role = 'supervisor'\s+where not exists \(select 1 from public\.role_access r where r\.org_id = o\.id and r\.role = 'supervisor'\)\s+on conflict \(org_id, role, area\) do nothing;/);
  assert.match(code, /select s\.org_id, 'supervisor', 'tasks', true, true, now\(\)[\s\S]*s\.role = 'supervisor' and s\.area = 'staff' and s\.can_view[\s\S]*on conflict \(org_id, role, area\) do nothing;/);
  assert.equal((code.match(/insert into public\.role_access/g) || []).length, 3, 'zero-row supervisor rows + supervisor tasks + the new-studio seed');
  // the helper: no row = has_area('staff','edit') word for word
  assert.match(code, /else coalesce\(public\.has_area\('staff', 'edit'\), false\)\n  end;/);
  assert.match(code, /revoke all on function public\._r385_can_assign\(\) from authenticated/);
});

await t('APPLY-0385: header, begin, the migration verbatim, the all-true check block, commit; MANIFEST, run-all, checker', () => {
  assert.match(APPLY, /^-- APPLY-0385 [^\n]*Run on STAGING first, then production\. Safe to run twice\./);
  assert.ok(APPLY.includes('\nbegin;\n' + MIG), 'verbatim after begin');
  assert.match(APPLY, /\nselect item, ok from \(values\n[\s\S]*\n\) v\(item, ok\) order by item;\ncommit;\n$/);
  assert.equal((APPLY.match(/^  \('0\d /gm) || []).length, 7);
  assert.match(APPLY, /^[\x00-\x7f]*$/);
  assert.ok(!/^\\/m.test(APPLY) && !/temp table/i.test(APPLY), 'paste-safe');
  for (const l of APPLY.split('\n').filter((x) => x.trim().startsWith('--'))) assert.doesNotMatch(l, /['";]/, 'editor-safe comment: ' + l);
  const man = r('supabase/migrations/MANIFEST');
  assert.match(man, /\nforward  supabase\/migrations\/0385_r208_task_assign_access\.sql\n$/);
  assert.match(r('scripts/db-test/run-all.sh'), /run "r208-task-assign-0385" "R208-TASK-ASSIGN-0385: ALL PASS \\\(37\/37\\\)" psql -q -f tests\/db\/r208-task-assign-0385\.sql/);
  const ovr = JSON.parse(r('supabase/check-prod-overrides.json'))['0385'];
  assert.ok(ovr && ovr.add.length === 18 && ovr.add.every((x) => /^marker public\.[a-z0-9_]+\([^)]*\) r208-0385$/.test(x)));
  assert.match(r('supabase/CHECK-PROD-MIGRATIONS.sql'), /'0385_r208_task_assign_access'/);
});

await t('page tours: the Access control tour points at the summary box and the Needs line (tours stay at 8 steps)', () => {
  const pt = r('public/page-tours.js');
  assert.match(pt, /title: "Pick a role", desc: "[^"]*The box below says in plain words what that role can do, and Needs under a row lists what else must be on \(Turn on fixes it\)\."/);
});

console.log('r208-access-deps: ' + n + ' test(s) passed.');
