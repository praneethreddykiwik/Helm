// R182: task times are the STUDIO's wall clock, and the picker says so when the device clock differs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); } };

const SRC = read('public/studio-time.js');
const ctx = vm.createContext({ Intl, Date, Math, isNaN, String, Number });
vm.runInContext(SRC.replace('typeof window !== "undefined" ? window : globalThis', 'this'), ctx);
const S = ctx.HelmStudioTime;
const iso = (d) => d.toISOString();
const wall = (d, tz) => { const w = S.utcToWall(d, tz); return w.ymd + ' ' + w.hm; };

t('IST (no DST): 2:30 PM on 16 Nov is 09:00 UTC, and back', () => {
  assert.equal(iso(S.wallToUtc('2026-11-16', '14:30', 'Asia/Kolkata')), '2026-11-16T09:00:00.000Z');
  assert.equal(wall(new Date('2026-11-16T09:00:00Z'), 'Asia/Kolkata'), '2026-11-16 14:30');
  assert.equal(S.offsetMin(new Date('2026-06-01T00:00:00Z'), 'Asia/Kolkata'), 330);
});
t('midnight edges: 00:00 IST is 18:30 UTC the day before; 23:59 London summer', () => {
  assert.equal(iso(S.wallToUtc('2026-11-17', '00:00', 'Asia/Kolkata')), '2026-11-16T18:30:00.000Z');
  assert.equal(iso(S.wallToUtc('2026-07-01', '23:59', 'Europe/London')), '2026-07-01T22:59:00.000Z');
  assert.equal(iso(S.wallToUtc('2026-11-16', '00:00', 'Asia/Dubai')), '2026-11-15T20:00:00.000Z');
});
t('America/Chicago DST: winter -6, summer -5, spring gap moves forward, fall overlap takes the first', () => {
  assert.equal(S.offsetMin(new Date('2026-01-15T12:00:00Z'), 'America/Chicago'), -360);
  assert.equal(S.offsetMin(new Date('2026-07-15T12:00:00Z'), 'America/Chicago'), -300);
  const gap = S.wallToUtc('2026-03-08', '02:30', 'America/Chicago');   // 2:30 AM does not exist that day
  assert.equal(iso(gap), '2026-03-08T08:30:00.000Z'); assert.equal(wall(gap, 'America/Chicago'), '2026-03-08 03:30');
  assert.equal(iso(S.wallToUtc('2026-03-08', '03:30', 'America/Chicago')), '2026-03-08T08:30:00.000Z');
  assert.equal(iso(S.wallToUtc('2026-11-01', '01:30', 'America/Chicago')), '2026-11-01T06:30:00.000Z');
});
t('Europe/London spring gap 01:30 -> 02:30 BST', () => {
  const g = S.wallToUtc('2026-03-29', '01:30', 'Europe/London');
  assert.equal(iso(g), '2026-03-29T01:30:00.000Z'); assert.equal(wall(g, 'Europe/London'), '2026-03-29 02:30');
});
t('round trips every 37 minutes across a DST year in 4 zones', () => {
  for (const tz of ['Asia/Kolkata', 'America/Chicago', 'Europe/London', 'Asia/Dubai']) {
    for (let ms = Date.UTC(2026, 0, 1); ms < Date.UTC(2027, 0, 1); ms += 37 * 60000 * 97) {
      const d = new Date(Math.floor(ms / 60000) * 60000), w = S.utcToWall(d, tz);
      const back = S.wallToUtc(w.ymd, w.hm, tz);
      // an ambiguous fall-back hour may resolve to its first occurrence; the WALL clock must always match
      assert.equal(wall(back, tz), w.ymd + ' ' + w.hm, tz + ' ' + d.toISOString());
    }
  }
});
t('zone labels: IST / CST / GST and long names', () => {
  assert.deepEqual({ ...S.zoneLabel('Asia/Kolkata', new Date('2026-11-16T00:00:00Z')) }, { abbr: 'IST', long: 'India Standard Time' });
  assert.equal(S.zoneLabel('America/Chicago', new Date('2026-01-16T00:00:00Z')).abbr, 'CST');
  assert.ok(S.zoneLabel('Asia/Dubai').abbr.length > 0);
  assert.equal(S.validTz('Not/AZone'), false);
  assert.ok(isNaN(S.wallToUtc('2026-11-16', '14:30', 'Not/AZone').getTime()));
});
t('fmt: "1:47 AM, Tue 17 Nov" in IST for 20:17 UTC on 16 Nov', () => {
  assert.equal(S.fmt(new Date('2026-11-16T20:17:00Z'), 'Asia/Kolkata'), '1:47 AM, Tue 17 Nov');
});
t('studio-time.js is pure (no DOM, no network, no storage)', () => {
  assert.doesNotMatch(SRC, /document\.|localStorage|fetch\(|XMLHttpRequest/);
});

const OPS = read('public/ops.html'), WP = read('public/when-picker.js'), TRM = read('public/task-reminders-ui.js'), CSS = read('public/when-picker.css');
t('ops.html loads studio-time.js before when-picker.js and converts with it in the studio zone', () => {
  const a = OPS.indexOf('studio-time.js'), b = OPS.indexOf('when-picker.js?v=');
  assert.ok(a > 0 && b > a, 'studio-time.js before when-picker.js');
  assert.match(OPS, /HelmStudioTime\.wallToUtc\(`\$\{m\[1\]\}-\$\{m\[2\]\}-\$\{m\[3\]\}`, `\$\{m\[4\]\}:\$\{m\[5\]\}`, studioTz\(\)\)/);
  assert.match(OPS, /const studioTz=\(\)=>\{ try\{ return BPStore\.studioTimezone\(\); \}/);
  // no device-local Date(...) parse of the datetime value for task times
  assert.doesNotMatch(OPS, /new Date\(\$\("#(sc|as)_when"\)\.value\)/);
});
t('past-time errors say whose clock (studio zone + time there now)', () => {
  assert.match(OPS, /const pastMsg=\(\)=>/);
  assert.match(OPS, /Times are in the studio's time zone \(\$\{lb\.long\}, \$\{lb\.abbr\}\) - it's \$\{T\.fmt\(new Date\(\),tz\)\} there now/);
  assert.match(OPS, /out\.block=pastMsg\(\)/); assert.match(OPS, /\$\("#sc_err"\)\.textContent=pastMsg\(\)/);
});
t('picker: zone note + both-zone words line when the device clock differs; exact rows skip the note', () => {
  assert.match(WP, /function zoneDiffers\(tz\)/);
  assert.match(WP, /Times here are in the studio's time zone - " \+ lb\.long/);
  assert.match(WP, /on your device\)"/);
  assert.match(WP, /opts\.zoneNote !== false/);
  assert.match(TRM, /HelmWhen\.attach\(inp, \{ compact: true, label: "Reminder", zoneNote: false \}\)/);
  assert.match(CSS, /\.whenp-zone \{/);
});

console.log(`\nr182-studio-timezone: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
