// R185: the designed HTML part of every staff e-mail (comms-dispatch/staff-email.mjs staffEmailHtml / staffUpdateHtml)
// on the shared Helm layout (_shared/email-layout.mjs). The plain-text part must stay exactly the R170-R179 text.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const M = await import('../supabase/functions/comms-dispatch/staff-email.mjs');
const L = await import('../supabase/functions/_shared/email-layout.mjs');
const SRC = readFileSync(new URL('../supabase/functions/comms-dispatch/staff-email.mjs', import.meta.url), 'utf8');
const IDX = readFileSync(new URL('../supabase/functions/comms-dispatch/index.ts', import.meta.url), 'utf8');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n    ' + (e && e.message)); } };

const O = 'https://www.helm.events';
const STAFF = 'work.html?staff=' + 'a'.repeat(64);
const QID = 'd1f9dac9-2eec-41c7-a0e0-36ca7bce50f2';
const TOK = '0b6c1f2e-1111-4a4a-8888-123456789abc';
const base = { studio: 'Helm & "Co" Studio', event: "QA-P1 Lead 1 — Wedding's day", event_date: '20 Dec 2026', venue: 'Grand Hall', name: 'Koushik Goud' };
const rows = {
  task_assigned: { ...base, kind: 'task_assigned', link_path: STAFF, quote_id: QID, tasks: [{ title: 'Load furniture & chairs', category: 'Transport', start: '4:00 AM', day: '17 Nov 2026' }, { title: 'Unload at venue', category: 'Transport' }] },
  task_list: { ...base, kind: 'task_list', link_path: STAFF, quote_id: QID, tasks: [{ title: 'Guest shuttle', category: 'Transport' }] },
  task_one: { ...base, kind: 'task_one', link_path: STAFF, quote_id: QID, task: 'Vehicle scheduling', start: '2:30 PM', day: '16 Nov 2026' },
  task_reminder: { ...base, kind: 'task_reminder', link_path: STAFF, quote_id: QID, task: 'Load furniture & chairs', start: '4:00 AM', day: '17 Nov 2026', minutes: 10 },
  task_reminder_now: { ...base, kind: 'task_reminder', link_path: STAFF, quote_id: QID, task: 'Load furniture & chairs', start: '4:00 AM', day: '17 Nov 2026', minutes: 0 },
  task_late: { ...base, kind: 'task_late', link_path: 'work.html?token=' + TOK, task: 'Stage lights', start: '12:30 PM', day: '01 Dec 2026' },
  office_alert: { ...base, kind: 'office_alert', link_path: 'ops.html?quote=' + QID, task: 'Stage lights', worker: 'Ravi Kumar', start: '12:30 PM', day: '01 Dec 2026' },
};
const upd = { ...base, kind: 'task_update', link_path: STAFF, changes: ['Load furniture & chairs: start time changed from no time set to 4:00 AM on 17 Nov 2026', 'Unload at venue: new task'], more: 2, tasks: [{ title: 'Load furniture & chairs', start: '4:00 AM', day: '17 Nov 2026' }] };
const cancelled = { ...base, kind: 'task_update', link_path: STAFF, changes: ['The event was cancelled'], cancelled: true, tasks: [] };

const imgs = (h) => (h.match(/<img\b/gi) || []).length;

t('every staff e-mail kind renders a full designed HTML document on the shared layout', () => {
  for (const [k, r] of Object.entries(rows)) {
    const h = M.staffEmailHtml(r, O, { address: 'Test Street 1' });
    assert.ok(h.startsWith('<!DOCTYPE html>'), k);
    assert.ok(h.includes(L.LOGO_URL), k + ' logo');
    assert.equal(imgs(h), 1, k + ': the logo is the only image (no tracking pixel)');
    assert.ok(/via Helm<\/span>/.test(h), k + ' studio eyebrow');
    assert.ok(h.includes('You received this because'), k + ' compliance line');
    assert.ok(h.includes('Test Street 1'), k + ' postal address');
    assert.ok(!/<script/i.test(h), k + ' no script');
  }
  for (const r of [upd, cancelled]) assert.ok(M.staffUpdateHtml(r, O, {}).includes(L.LOGO_URL));
});

t('the plain-text part is unchanged (html is a separate function; staffEmailMessage keeps { subject, text })', () => {
  for (const r of Object.values(rows)) assert.deepEqual(Object.keys(M.staffEmailMessage(r, O)).sort(), ['subject', 'text']);
  assert.deepEqual(Object.keys(M.staffUpdateMessage(upd, O)).sort(), ['subject', 'text']);
  const m = M.staffEmailMessage(rows.task_reminder, O);
  assert.match(m.subject, /^Due in 10 min: Load furniture & chairs at 4:00 AM - /);
  assert.match(m.text, /^Hello Koushik,\n\nA reminder from Helm & "Co" Studio: Load furniture & chairs for /);
});

t('every dynamic value is HTML-escaped (& " \' never raw inside the html)', () => {
  const h = M.staffEmailHtml(rows.task_assigned, O, {});
  assert.ok(h.includes('Helm &amp; &quot;Co&quot; Studio via Helm'));
  assert.ok(h.includes('Load furniture &amp; chairs'));
  assert.ok(h.includes('Wedding&#39;s day'));
  assert.ok(!h.includes('Helm & "Co"'), 'raw studio name never appears');
});

t('the button and the fallback link are the validated staff link (permanent link + &event), escaped', () => {
  const h = M.staffEmailHtml(rows.task_reminder, O, {});
  const link = M.staffLink(rows.task_reminder, O);
  assert.ok(link.endsWith('&event=' + QID));
  assert.ok(h.includes('href="' + link.replace(/&/g, '&amp;') + '"'));
  assert.ok(h.includes('Mark it started'));
  const bad = M.staffEmailHtml({ ...rows.task_one, link_path: 'https://evil.example/x' }, O, {});
  assert.ok(!/evil\.example/.test(bad) && !/Open my task</.test(bad), 'no button when the link is not valid');
});

t('reminders: big clock + countdown chip; due now / late use the red tone', () => {
  const soon = M.staffEmailHtml(rows.task_reminder, O, {});
  assert.ok(/font-size:40px[^>]*>4:00 AM</.test(soon));
  assert.ok(soon.includes('>Due in 10 min</span>') && soon.includes('#fff4e0'));
  const now = M.staffEmailHtml(rows.task_reminder_now, O, {});
  assert.ok(now.includes('>Due now</span>') && now.includes('#fdecec') && now.includes('Your task is due now'));
  const late = M.staffEmailHtml(rows.task_late, O, {});
  assert.ok(late.includes('>Not started</span>') && late.includes('Open my task page'));
});

t('task lists: one row per task with its time (or "No time yet")', () => {
  const h = M.staffEmailHtml(rows.task_assigned, O, {});
  assert.ok(h.includes('New work for you') && h.includes('2 tasks'));
  assert.ok(h.includes('4:00 AM on 17 Nov 2026') && h.includes('No time yet'));
  assert.ok(h.includes('Open my tasks'));
});

t('change notices: before (struck) -> after rows, "and N more", tasks now; cancelled = red banner', () => {
  const h = M.staffUpdateHtml(upd, O, {});
  assert.ok(h.includes('Your tasks changed'));
  assert.ok(/line-through;">no time set<\/span> &rarr; <strong[^>]*>4:00 AM on 17 Nov 2026<\/strong>/.test(h));
  assert.ok(h.includes('Unload at venue: new task'));
  assert.ok(h.includes('and 2 more changes'));
  assert.ok(h.includes('Your tasks for this event now') && h.includes('See all my tasks'));
  const c = M.staffUpdateHtml(cancelled, O, {});
  assert.ok(c.includes('Event cancelled') && c.includes('has cancelled') && !c.includes('Your tasks for this event now'));
});

t('office alert: banner, facts, "See live status", office compliance reason', () => {
  const h = M.staffEmailHtml(rows.office_alert, O, {});
  assert.ok(h.includes('Ravi Kumar has not started Stage lights.') && h.includes('See live status'));
  assert.ok(h.includes('you are the manager of this event'));
});

t('nothing to send -> no html either (same rule as the text)', () => {
  assert.equal(M.staffEmailHtml({ kind: 'task_one', studio: 'x' }, O, {}), '');
  assert.equal(M.staffEmailHtml({ kind: 'nope' }, O, {}), '');
  assert.equal(M.staffUpdateHtml({ kind: 'task_update', changes: [] }, O, {}), '');
});

t('one logo constant: staff-email.mjs never hard-codes an image URL; layout LOGO_URL is the versioned email PNG', () => {
  assert.ok(!/https?:\/\/[^"'`\s]*\.(png|jpe?g|gif|svg)/i.test(SRC), 'no image URL in staff-email.mjs');
  assert.match(L.LOGO_URL, /^https:\/\/www\.helm\.events\/email\/helm-logo-v\d+\.png$/);
});

t('comms-dispatch sends the designed html for staff e-mails and change notices', () => {
  assert.match(IDX, /staffEmailHtml\(r, origin, \{ address: postalAddress\(env\) \}\)/);
  assert.match(IDX, /staffUpdateHtml\(r, origin, \{ address: postalAddress\(env\) \}\)/);
  assert.match(IDX, /sendEmail\(id, to, msg\.subject, msg\.text, String\(r\?\.studio \?\? ""\), ident, extra, shtml\)/);
  assert.match(IDX, /sendEmail\(id, to, msg\.subject, msg\.text, String\(r\?\.studio \?\? ""\), ident, extra, uhtml\)/);
});

console.log(`r185-staff-email-template: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
