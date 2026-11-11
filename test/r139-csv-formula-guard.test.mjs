// R139: every CSV/spreadsheet export guard must neutralise formulas hidden behind
// leading spaces (incl. NBSP / ideographic space) and full-width = + - @ signs,
// matching the reports.html / hq.js pattern.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const STRONG = '/^[\\s\\u00a0\\u3000]*[=+\\-@\\t\\r\\uff1d\\uff0b\\uff0d\\uff20]/';
const files = {
  'public/smart-import-core.js': 2,
  'public/onboarding-core.js': 2,
  'public/invite-extras.js': 1,
};
for (const [f, n] of Object.entries(files)) {
  const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
  const count = src.split(STRONG).length - 1;
  assert.equal(count, n, `${f}: expected ${n} strong formula guards, found ${count}`);
  assert.ok(!/\/\^\[=\+\\-@\\t\\r\]\//.test(src), `${f}: weak /^[=+\\-@\\t\\r]/ guard still present`);
  assert.ok(!/\/\^\\s\*\[=\+\\-@\]\//.test(src), `${f}: weak /^\\s*[=+\\-@]/ guard still present`);
}

// Behaviour check with the exact regex.
const re = /^[\s 　]*[=+\-@\t\r＝＋－＠]/;
const bad = ['=1+1', ' =HYPERLINK("x")', ' +cmd', '　@SUM(A1)', '＝1+1', '  －x', '\tfoo', '-2+3'];
const ok = ['Alice', 'a=b', 'Rs 1,000', ''];
for (const s of bad) assert.ok(re.test(s), 'should guard: ' + JSON.stringify(s));
for (const s of ok) assert.ok(!re.test(s), 'should not guard: ' + JSON.stringify(s));
console.log('r139 csv formula guard: ok');
