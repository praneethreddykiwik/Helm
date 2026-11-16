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
