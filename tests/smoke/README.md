# Smoke tests (R176)

A 1-3 minute **"is the live site OK?"** check of a *deployed* Helm site. Read-only: it never signs up, saves, deletes, sends (except the manual channel check) or renders.

| Part | Checks | Runs |
|---|---|---|
| `anon.mjs` (plain HTTP, no browser) | A1 pages 200 · A2 `/api/health` ok · A3 security headers · A6 `store-api.js` version loads (and matches the commit on deploy runs) · A7 Supabase reachable · A8 static containment (`scripts/check-deploy-static.mjs`) | always |
| `site.smoke.spec.mjs` - anonymous | A4 login page draws (email, password, Google) · A5 no console errors | browser runs |
| `site.smoke.spec.mjs` - signed-in | B1 sign in · B2 dashboard · B3 events list · B4 open an event · B5 Integrations · B6 Operations · B7 sign out | only when the smoke-account secrets exist |
| `site.smoke.spec.mjs` - channel | C1 test e-mail · C2 test WhatsApp ("not set up yet" = pass) - **owner only** | only a manual run with `include_channel_check` |

All defaults live in `config.mjs` (targets, pages, headers, console allow-list, pace) and `.github/workflows/smoke.yml` (when it runs).

## When it runs (`.github/workflows/smoke.yml`, dev repo only)
- After every successful Vercel deploy of staging (`helm-v01.vercel.app`) or `helm.events` (previews skipped).
- Every 3 hours: quick anonymous HTTP checks of production.
- Daily (09:13 IST): full checks of production + staging.
- By hand: GitHub → Actions → **Smoke** → Run workflow.

A failure turns the run red (GitHub e-mails you) and keeps screenshots as an artifact. It blocks nothing.

## Secrets (GitHub → Settings → Secrets → Actions) - names only, values never in code
| Secret | Turns on |
|---|---|
| `SMOKE_STAGING_EMAIL`, `SMOKE_STAGING_PASSWORD` | signed-in checks on staging (use a dedicated "SMOKE TEST" studio) |
| `SMOKE_PROD_EMAIL`, `SMOKE_PROD_PASSWORD` | signed-in checks on production (dedicated "SMOKE TEST" studio) |
| `SMOKE_OWNER_EMAIL` | C1: the test e-mail is only sent when the signed-in smoke account IS this address ("Send test e-mail to me" goes to the signed-in account) |
| `SMOKE_OWNER_PHONE` | C2: the test WhatsApp is only sent when the studio's number field is this phone |

The older staging E2E suite (`tests/e2e`, separate) needs `HELM_E2E_STAGING_URL`, `HELM_E2E_STAGING_ANON`, `HELM_E2E_EMAIL`, `HELM_E2E_PASSWORD`.

## Run locally
```bash
npm run smoke          # staging
npm run smoke:prod     # production (read-only)
```

## Optional: auth e-mail speed check (R203) - by hand, owner only
Supabase Auth sends its own e-mails (password reset, invitation, sign-up confirmation) **before** it answers the browser.
When the studio SMTP (Gmail, `notifications@helm.events`) is slow, the reset still arrives but the page used to say
"Couldn't reach the server". The app now waits up to 75 s for these calls and reports a slow one to Sentry as
**`auth_mail_timeout`** (`endpoint=recover|resend|signup kind=timeout|gateway`); invite-signup logs `INVSU_MAIL_TIMEOUT` /
`INVSU_CREATE_TIMEOUT` / `INVSU_CREATE_FAILED`. Not automated (each run sends a real e-mail and Supabase limits e-mails
per hour). To check it after an SMTP change:
1. On production, **Forgot password?** for your own account. Time it: the green note should come within ~10 s.
2. Supabase → Logs → Auth: filter `path = /recover` and read `duration` (anything near 30 s+ = SMTP is slow).
3. Sentry → Issues: search `auth_mail_timeout` - any event means a user waited longer than 75 s.
4. If 1-3 are slow, see the PR R203 checklist (Gmail app password, port 587, Auth e-mail rate limit).
