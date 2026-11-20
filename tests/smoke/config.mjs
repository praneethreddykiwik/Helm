// R176 smoke tests - ONE place for every default (owner can change any line here).
// Read-only checks of a DEPLOYED Helm site. Never signs up, never sends, never saves, never renders.

export const TARGETS = {
  prod: 'https://www.helm.events',
  staging: 'https://helm-v01.vercel.app',
};

// Hosts a deploy-triggered run may test (Vercel preview URLs are skipped: they sit behind Vercel auth).
export const KNOWN_HOSTS = ['www.helm.events', 'helm.events', 'helm-v01.vercel.app'];

// A1: pages that must answer 200 (extensionless: Vercel cleanUrls)
export const PUBLIC_PAGES = ['/', '/login', '/try', '/pricing'];
export const LEGAL_PAGES = ['/privacy', '/terms', '/refund-policy', '/cookie-policy', '/grievance', '/security', '/acceptable-use'];

// A3: security headers that must be present on / and /login
export const REQUIRED_HEADERS = ['content-security-policy', 'strict-transport-security', 'x-content-type-options'];
// framing protection: X-Frame-Options OR a CSP frame-ancestors directive
export const FRAME_GUARD = true;

// A5: console messages that are known-harmless (regex, case-insensitive). Keep this list SHORT.
export const CONSOLE_ALLOW = [
  /favicon/i,
  /Failed to load resource.*(googletagmanager|google-analytics|accounts\.google\.com|gstatic)/i,
  /\[GSI_LOGGER\]/i,                       // Google sign-in library chatter
  /Content Security Policy.*report-only/i, // report-only notices are not errors
  /net::ERR_BLOCKED_BY_CLIENT/i,           // ad blockers in local runs
];

// R238: Google's sign-in script (accounts.google.com/gsi/client) injects its own inline <style> next to the button.
// When Google changes it, the browser reports "Applying inline style violates ... style-src-elem ... a hash
// ('sha256-...') is required". That is NOT Helm code and the button still works, so the smoke run reports it as a
// WARNING with the new hash (add it to GIS_INLINE_STYLE_HASHES in scripts/csp-hashes.cjs, then node scripts/gen-csp.mjs)
// instead of failing. Any other inline-style violation (Helm's own) still fails the run.
export const INLINE_STYLE_CSP = /Applying inline style violates[\s\S]*style-src(-elem)?/i;
export const GSI_SRC = /^https:\/\/accounts\.google\.com\/gsi\//;
// text: the console error; violations: securitypolicyviolation events seen on the page ({directive, sourceFile});
// gsiLoaded: Google's /gsi/client script was loaded on the page -> 'gsi' (warn) | 'error'
export function classifyStyleCsp(text, violations, gsiLoaded) {
  if (!INLINE_STYLE_CSP.test(String(text || ''))) return 'error';
  const v = (violations || []).filter((x) => /^style-src/.test(String(x && x.directive || '')));
  if (v.some((x) => GSI_SRC.test(String(x.sourceFile || '')))) return 'gsi';
  // the browser does not always name the injecting script: only when Google's script is on the page AND no style
  // violation names a Helm file is it treated as Google's
  if (gsiLoaded && !v.some((x) => x.sourceFile && !GSI_SRC.test(String(x.sourceFile)))) return 'gsi';
  return 'error';
}
export const cspHashOf = (text) => ((String(text || '').match(/sha256-[A-Za-z0-9+/=]+/) || [''])[0]);

// Gentle: at most ~1 request a second, one clear name.
export const PACE_MS = 1000;
export const USER_AGENT = 'HelmSmoke/1.0 (+https://www.helm.events; read-only smoke check)';
export const TIMEOUT_MS = 20000;

// Owner defaults (R176, 16 Nov 2026 - change here or in .github/workflows/smoke.yml):
//  - signed-in checks run only when SMOKE_<TARGET>_EMAIL / _PASSWORD secrets exist; otherwise "not configured" (skip)
//  - channel checks (real test email / WhatsApp to the OWNER only) only on a manual run with include_channel_check
//  - a failed smoke WARNS (red run + GitHub's own email); it blocks nothing
export const DEFAULTS = {
  signedInNeedsSecrets: true,
  channelCheckManualOnly: true,
  blockReleases: false,
};

export function baseFor(target) {
  const t = String(target || '').trim();
  if (TARGETS[t]) return TARGETS[t];
  if (/^https:\/\/[^\s/]+$/i.test(t.replace(/\/+$/, ''))) return t.replace(/\/+$/, '');
  throw new Error('unknown smoke target: use prod, staging or an https://host URL');
}
