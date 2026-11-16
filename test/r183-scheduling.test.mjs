// R183 - scheduling fixes (owner tests on prod, 17 Nov 2026):
//   a) an exact reminder time ("At an exact time" 3:45 AM) could never be saved: "Couldn't read one of the reminder times".
//      Since R179 each reminder row also holds the picker's own visible date + time fields, and read() took EVERY <input>
//      of the list - the visible "2026-11-17" / "3" values failed fromLocal() -> null -> the error. It now reads only the
//      value holders (input.trm-at-in). Round trip: picker value (studio wall clock) -> fromLocal -> checkTimes -> the ISO
//      the server stores.
//   b) "Send by email" on the assign form is ticked on every visit and after every assign (browsers restored an old
//      unticked state on reload / Back, which silently cancelled the automatic assignment e-mail).
//   c) the time part of the picker is an iOS-style clock: big hour : minute segments (spinbuttons) + AM | PM toggle.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok', name); } catch (e) { fail++; console.log('  FAIL', name, '\n', e && e.stack || e); } };

const TRM = read('public/task-reminders-ui.js'), WP = read('public/when-picker.js'), WPC = read('public/when-picker.css'), OPS = read('public/ops.html');

// studio-time.js + task-reminders-ui.js in a sandbox (pure helpers only)
const ctx = vm.createContext({ Intl, Date, Math, isNaN, isFinite, String, Number, Array, Object, JSON, parseInt });
vm.runInContext(read('public/studio-time.js').replace('typeof window !== "undefined" ? window : globalThis', 'this'), ctx);
vm.runInContext(TRM.replace('typeof window !== "undefined" ? window : globalThis', 'this'), ctx);
const ST = ctx.HelmStudioTime, R = ctx.HelmTaskReminders;

t('a) read() takes only the value holders, never the picker\'s visible fields', () => {
  assert.match(TRM, /var vals = \[\], ins = list\.querySelectorAll\("input\.trm-at-in"\);/);
  assert.doesNotMatch(TRM, /list\.querySelectorAll\("input"\)/);
  assert.match(TRM, /inp\.type = "datetime-local"; inp\.id = id; inp\.className = "trm-at-in";/, 'each row\'s holder carries the class');
});

t('a) exact time round trip: 4:15 PM IST on the picker -> the ISO the server stores (device anywhere)', () => {
  const TZ = 'Asia/Kolkata';
  const fromLocal = (v) => { const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(v); return ST.wallToUtc(m[1], m[2], TZ); };
  const start = fromLocal('2026-12-20T16:30').toISOString();
  const holder = '2026-12-20T16:15';                        // what the picker writes into input.trm-at-in
  const c = R.checkTimes([fromLocal(holder).getTime()], start, [], Date.parse('2026-11-17T00:00:00Z'));
  assert.equal(c.ok, true, c.error);
  assert.equal(JSON.stringify(c.times), JSON.stringify(['2026-12-20T10:45:00.000Z']));
  // the visible picker values that used to be read must NOT be what reaches checkTimes
  const bad = R.checkTimes([null], start, [], Date.parse('2026-11-17T00:00:00Z'));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Couldn't read one of the reminder times/);
});

t('a) the owner\'s case: start 4:00 AM IST 17 Nov, reminder 3:45 AM -> saved', () => {
  const TZ = 'Asia/Kolkata', f = (ymd, hm) => ST.wallToUtc(ymd, hm, TZ);
  const c = R.checkTimes([f('2026-11-17', '03:45').getTime()], f('2026-11-17', '04:00').toISOString(), [], Date.parse('2026-11-16T21:00:00Z'));
  assert.equal(c.ok, true, c.error);
  assert.equal(JSON.stringify(c.times), JSON.stringify(['2026-11-16T22:15:00.000Z']));
});

t('b) "Send by email" is ticked on every visit and after every assign (never restored as unticked)', () => {
  assert.match(OPS, /<input type="checkbox" id="assignEmail" checked autocomplete="off">/);
  assert.match(OPS, /function resetAssignEmail\(\)\{ const x=\$\("#assignEmail"\); if\(x\) x\.checked=true; \}\n  resetAssignEmail\(\);\n  window\.addEventListener\("pageshow", resetAssignEmail\);/);
  assert.match(OPS, /\$\("#selAll"\)\.checked=false; resetAssignEmail\(\); await refresh\(\);/);
  assert.match(OPS, /No email sent \(\\"Send by email\\" was unticked\) - use ✉ Email below to send it\./);
});

t('c) iOS-style time: hour + minute spinbuttons, AM | PM toggle, quick minutes; old text box + 15-min list gone', () => {
  assert.match(WP, /seg\("whenp-hh", base \+ "_t", "hour", 1, 12\)/);
  assert.match(WP, /seg\("whenp-mm", base \+ "_m", "minutes", 0, 59\)/);
  assert.match(WP, /s\.setAttribute\("role", "spinbutton"\)/);
  assert.match(WP, /el\("button", "whenp-ap", "AM"\), bPM = el\("button", "whenp-ap", "PM"\)/);
  assert.match(WP, /\[0, 15, 30, 45\]\.forEach/);
  assert.match(WP, /bAM\.setAttribute\("aria-pressed"/);
  assert.doesNotMatch(WP, /whenp-time|helmWhenTimes|setAttribute\("list"/);
  assert.match(WPC, /\.whenp-clock \{ display: flex;/);
  assert.match(WPC, /\.whenp \.whenp-seg:focus, \.whenp \.whenp-seg:focus-visible \{ outline: none; background: var\(--accent, #0b6b4f\); color: #fff; \}/);
  assert.match(WPC, /\.whenp-ap\.on \{ background: var\(--accent, #0b6b4f\); color: #fff;/);
  assert.match(WPC, /\.whenp-row \{ display: grid;/);
});

t('c) typing behaves like a phone clock: a digit in a full box starts it over; a whole time fills both boxes', () => {
  assert.match(WP, /sg\.selectionStart === sg\.selectionEnd && String\(sg\.value\)\.length >= 2\) \{\n        e\.preventDefault\(\); sg\.value = k;/);
  assert.match(WP, /function takeWhole\(seg\)/);
  assert.match(WP, /sgm\.addEventListener\("mouseup"/);
  // the wheel only changes a box that has the focus (page scrolling is never hijacked)
  assert.match(WP, /hh\.addEventListener\("wheel", function \(e\) \{ if \(doc\.activeElement !== hh\) return;/);
});

t('c) the whole-time parser still takes 6:32 pm / 18:32 / 1832 / 632p', () => {
  const c2 = vm.createContext({ document: {}, Event: function () {} });
  vm.runInContext(WP.replace('typeof window !== "undefined" ? window : globalThis', 'this'), c2);
  const W = c2.HelmWhen;
  for (const [k, v] of Object.entries({ '6:32 pm': '18:32', '18:32': '18:32', '1832': '18:32', '632p': '18:32', '12am': '00:00', '12:05 PM': '12:05' })) assert.equal(W.parseTime(k), v, k);
  assert.equal(W.parseTime('13pm'), null);
});

console.log(`\nr183-scheduling: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
