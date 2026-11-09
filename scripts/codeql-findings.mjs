#!/usr/bin/env node
/* codeql-findings.mjs - CodeQL in free mode (private repo, no Code Security upload): print every finding from the
 * SARIF files and exit 1 when any is error-level (warnings / notes are printed but do not fail the check).
 *   node scripts/codeql-findings.mjs <sarif-folder>
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function summarise(sarif) {
  const out = [];
  for (const run of (sarif && sarif.runs) || []) {
    const rules = new Map();
    for (const r of (run.tool && run.tool.driver && run.tool.driver.rules) || []) rules.set(r.id, r);
    for (const res of run.results || []) {
      const rule = rules.get(res.ruleId) || {};
      const level = res.level || (rule.defaultConfiguration && rule.defaultConfiguration.level) || 'warning';
      const loc = (res.locations && res.locations[0] && res.locations[0].physicalLocation) || {};
      out.push({ level, rule: res.ruleId || '?', file: (loc.artifactLocation && loc.artifactLocation.uri) || '?',
        line: (loc.region && loc.region.startLine) || 0, message: String((res.message && res.message.text) || '').slice(0, 200) });
    }
  }
  return out;
}

if (import.meta.url === 'file://' + process.argv[1]) {
  const dir = process.argv[2] || 'sarif-results';
  if (!existsSync(dir)) { console.log('codeql-findings: no SARIF folder (' + dir + ') - nothing to check'); process.exit(0); }
  const all = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sarif'))) all.push(...summarise(JSON.parse(readFileSync(join(dir, f), 'utf8'))));
  const errors = all.filter((x) => x.level === 'error');
  for (const x of all) console.log(`${x.level.toUpperCase()}  ${x.rule}  ${x.file}:${x.line}  ${x.message}`);
  console.log(`codeql-findings: ${all.length} finding(s), ${errors.length} error-level`);
  if (errors.length) { console.error('codeql-findings: FAILED - fix the error-level findings above'); process.exit(1); }
}
