#!/usr/bin/env node
/* check-asset-bump-local.mjs - R236 (PART-B API-02): the cache-bust guard that GitHub CI runs on pull requests
 * (ci.yml "Cache-bust guard": node scripts/bump-changed-assets.mjs --check --base origin/<base>) now also runs in
 * `npm run ci`, so a changed public/ JS / CSS whose ?v= (or loader constant / SHELL_V) was not bumped fails LOCALLY,
 * before a push. Browsers keep an un-bumped file for a year (immutable cache).
 *
 * Base: the merge-base of HEAD and origin/main (override: CI_ASSET_BASE=<ref>), so only THIS branch's changes (committed
 * or not) are judged, never other people's work that landed on main since. Read-only; never writes a file.
 * Skips (exit 0, says why) when there is no git, no origin/main (e.g. a shallow CI checkout) or no merge-base.
 *
 *   node scripts/check-asset-bump-local.mjs          exit 1 when a changed asset still needs a bump
 *   fix:  node scripts/bump-changed-assets.mjs --apply --base <the base printed below>
 */
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

export function pickBase(env = process.env, run = git) {
  const want = String(env.CI_ASSET_BASE || 'origin/main').trim();
  if (!/^[A-Za-z0-9._\/-]{1,100}$/.test(want)) return { skip: 'CI_ASSET_BASE is not a plain ref' };
  if (run('rev-parse', '--git-dir').status !== 0) return { skip: 'not a git checkout' };
  if (run('rev-parse', '--verify', '--quiet', want + '^{commit}').status !== 0) return { skip: want + ' not available here (shallow / fresh clone)' };
  const mb = run('merge-base', 'HEAD', want);
  const sha = String(mb.stdout || '').trim();
  if (mb.status !== 0 || !/^[0-9a-f]{40}$/.test(sha)) return { skip: 'no merge-base with ' + want };
  return { base: sha, ref: want };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const b = pickBase();
  if (b.skip) { console.log('asset version check (local): skipped - ' + b.skip); process.exit(0); }
  console.log('asset version check (local): changed public/ JS / CSS vs ' + b.ref + ' (merge-base ' + b.base.slice(0, 10) + ')');
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'bump-changed-assets.mjs'), '--check', '--base', b.base], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) console.error('\nFix: node scripts/bump-changed-assets.mjs --apply --base ' + b.base + '   (then re-run the pins / CSP / client-api generators)');
  process.exit(r.status == null ? 1 : r.status);
}
