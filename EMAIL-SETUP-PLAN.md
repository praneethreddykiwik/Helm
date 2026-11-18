# Email setup — plan (R168)

_Plain-English owner summary first, then the technical detail. Investigated 2026-11-13 on commit `693ce816`._

## The one-paragraph summary

Helm's email is **already built and working** — far more than "planned but not implemented". Every
email Helm sends (sign-in codes, invites, welcome, approval/booklet links to clients, package choices,
payment receipts, payment reminders, billing, security alerts, sales follow-ups, trial nudges) goes
through **one shared mailer** that can send via **Resend** or **SMTP**, with legal footers,
one-click unsubscribe for marketing mail, and a per-studio "Reply-To" so client replies reach the
studio, not Helm. "**Option B**" — letting each studio's emails go out **under its own name** — is
also **already in the code** (the `EMAIL_BRAND_MODE=studio` switch plus a per-studio sender name on the
Integrations page). What's left is **not code**: it's three owner setup jobs — (1) verify a proper
**sending domain** so mail lands in inboxes instead of spam, (2) flip **Option B on**, and (3) one
pending design decision (dark-mode emails). This file lays out exactly what each of those is, and what
is code vs. owner-config.

---

## 1. Current state — what exists today

### The sender (code — done)
- **`supabase/functions/_shared/mailer.ts`** is the single outbound path. `sendMail()` picks the provider:
  - **Resend** when `RESEND_API_KEY` + `RESEND_FROM` are set (`mailer.ts:97-99`),
  - else **SMTP** when `SMTP_HOST` + `SMTP_USER` + `SMTP_PASS` are set (built-in TLS client in
    `_shared/smtp.ts`, port 465; Supabase blocks 25/587),
  - else **nothing is sent** and the reason (setting names only, never values) is logged — "fail closed",
    never throws (`mailer.ts:112-116`).
- **No fallback sender** (R154g): the old `onboarding@resend.dev` default is gone. A missing/invalid
  `RESEND_FROM`/`SMTP_FROM` counts as *not set up* (`mailConfig`, `mailer.ts:88-105`).
- Every mailer in the app now routes through this shared path — `client-mailer`, `send-otp`,
  `invite-mailer`, `integrations-test`, `comms-dispatch`, `welcome-mailer`, `billing-reminder`,
  `security-alert-mailer`, `pkg-client-notify`, `razorpay-webhook` (per `docs/project/API.md:346`).

### Branding / "from" name (code — done, incl. Option B)
- Display name is driven by **one switch, `EMAIL_BRAND_MODE`** (`brandMode`, `mailer.ts:55-57`):
  - unset / `helm` (default) → **"Helm Events"**,
  - `studio` → **"&lt;Studio&gt; via Helm Events"** (`fromName`, `mailer.ts:58-62`).
- **Option B, per-studio name:** `comms-dispatch` reads the studio's own **Sender name** and
  **Reply-to** from the Integrations page (migration **0150**, columns
  `comms_settings.email_from_name` / `email_reply_to`) and uses the saved name directly when
  `EMAIL_BRAND_MODE=studio` (`comms-dispatch/index.ts:153-155`).
- The **sending address is always Helm's verified domain** (from `RESEND_FROM`/`SMTP_FROM`); only the
  **display name** and **Reply-To** are per-studio. This is what keeps SPF/DKIM alignment valid
  (`docs/ops/EMAIL-COMPLIANCE.md:14`).
- **Reply-To** resolution (`_shared/reply-to.mjs`, R107): studio's own reply-to (0150) → business email
  → studio owner's login email; an address equal to Helm's own sender is dropped so replies are never lost.

### Which emails exist and whether they really send
| Email | Function | Live / dormant |
|---|---|---|
| Sign-in / magic link / reset / invite (Supabase Auth) | Auth templates | Live (Supabase Auth mailer) |
| Team invite | `invite-mailer` | Live, on by default once deployed |
| Welcome (owner / member) | `comms-dispatch` welcome lane | **LIVE on prod** since 2026-11-02 (DB switch `helm_welcome_mail_settings.enabled`, 0327) |
| Approval / booklet link to client | `client-mailer` | Live when a provider is set |
| Email OTP for approval | `send-otp` | Live when a provider is set |
| Package chosen / client+staff notices | `pkg-client-notify` | Behind `HELM_PKG_NOTIFY_ENABLED` + cron |
| Payment received / needs attention | `razorpay-webhook` | Live with Razorpay; logs `simulated` if no mail provider |
| Client payment reminder | `comms-dispatch` | Studio switch in Control Center |
| Subscription renews / past due | `billing-reminder` | **Dormant** — `HELM_BILLING_REMINDERS_ENABLED` (owner decision pending) |
| Security alert to admins | `security-alert-mailer` | Behind `HELM_SECURITY_ALERTS_ENABLED` + `HELM_SECURITY_ALERT_HQ_TO` |
| Sales follow-up | `comms-dispatch` | Non-transactional; off by default per studio; needs unsubscribe token (0165) |
| Trial nudges / follow-ups | `comms-dispatch`, `billing-reminder` | Non-transactional, scoped to Helm |
| Nurture greetings (birthday, etc.) | queued to `notifications` | **Simulated only — no real send yet** (intentional, pending owner) |

"Fail-closed" everywhere: with **no provider**, non-transactional senders claim nothing and leave rows for
a later retry — they do **not** silently mark mail as skipped/sent (`docs/ops/EMAIL-SETUP.md`, R154g).

### Deliverability (owner config — not code)
Needed so mail lands in inboxes (and to satisfy Gmail/Yahoo bulk-sender rules): a **verified sending
domain** with **SPF + DKIM**, a **DMARC** record, and From aligned to that domain. All of this is **DNS +
provider dashboard work only the owner can do** — fully documented in `docs/ops/EMAIL-COMPLIANCE.md §4`.
The code side (one-click unsubscribe, footers, postal address, alignment via `helm.events` sender) is done.

### Known current weakness
- Prod is currently on **personal-Gmail SMTP** (per project memory). A `@gmail.com` sender **cannot align
  with `helm.events`**, hurting deliverability, and Gmail's built-in relay is rate-limited. This is the
  single biggest "make email better" lever and it is **owner config**, not code.

---

## 2. What "better email" means here

Two things, both mostly owner-side:

1. **Reliable delivery** — move off personal Gmail to a **verified `helm.events` sender**:
   - **Recommended: Resend** with domain `helm.events` (`RESEND_API_KEY` + `RESEND_FROM="Helm <mail@helm.events>"`).
     The code switches to it automatically once the two secrets are set; nothing else changes.
   - Alternative: a **Google Workspace mailbox on `helm.events`** (not personal Gmail) via SMTP.
2. **Option B — studio branding** — flip `EMAIL_BRAND_MODE=studio` so client-facing mail reads
   "&lt;Studio&gt; via Helm Events" (or the studio's own saved Sender name), with the studio as Reply-To.
   The code is ready; this is a secret flip + the 0150 migration applied + the Integrations UI.

---

## 3. Code vs. owner-config

| Item | Code done? | Owner action |
|---|---|---|
| Shared mailer, provider selection, fail-closed | ✅ Done | — |
| Option B brand switch + per-studio name/reply-to (comms-dispatch) | ✅ Done | Apply 0150; set `EMAIL_BRAND_MODE=studio` |
| Footers / one-click unsubscribe / compliance | ✅ Done | Apply 0165; set `HELM_POSTAL_ADDRESS`, `UNSUB_MAILTO` |
| Welcome emails | ✅ Live | — (off switch is a DB update) |
| **Verified sending domain (SPF/DKIM/DMARC)** | n/a | **Owner DNS + Resend/Workspace dashboard** |
| **Resend account + API key** | n/a | **Owner: create key, set `RESEND_API_KEY` + `RESEND_FROM`** |
| Mailer cron schedules | n/a | **Owner: per `docs/ops/EMAIL-SETUP.md` (each needs its own secret)** |
| Dark-mode email rendering | ✅ Decided (R207): light-only | Owner: re-paste auth templates + redeploy mail functions |
| `pkg-client-notify` honoring studio's saved Sender name | ⚠️ Not wired (see §5) | Owner decision (changes live From name) |

---

## 4. Recommended sequence

1. **Decide the sender.** Recommended: **Resend + `helm.events`**. Add the domain in Resend, add the
   SPF/DKIM (and DMARC `p=none`) DNS records it shows, wait for **Verified** (`EMAIL-COMPLIANCE.md §4`).
2. **Set secrets** on staging then prod: `RESEND_API_KEY`, `RESEND_FROM="Helm <mail@helm.events>"`,
   `HELM_POSTAL_ADDRESS`, `APP_URL`. The mailer flips to Resend automatically.
3. **Verify with the built-in test** before any real send: Integrations page → Email card →
   **Send test email to me** (`integrations-test`). It shows the exact From/Reply-To and, with no
   provider, reads **Simulated** (nothing sent) — a safe dry-run.
4. **Turn on Option B:** apply 0150, set `EMAIL_BRAND_MODE=studio`, redeploy `comms-dispatch` +
   `integrations-test`, then set each studio's Sender name / Reply-to on its Integrations page.
5. **DMARC rollout:** `p=none` for 2–4 weeks → `p=quarantine; pct=25` → raise to 100 → optionally
   `p=reject` (`EMAIL-COMPLIANCE.md §4`). Register Gmail Postmaster Tools + Yahoo CFL.
6. **Schedules:** add only the mailer crons you want, staging first (`docs/ops/EMAIL-SETUP.md`,
   `supabase/CHECK-EMAIL-CRONS.sql`).
7. **Resolve the two pending decisions:** dark-mode emails (§5), and whether `pkg-client-notify` should
   use the studio's saved Sender name (§5).

---

## 5. Recommendations deliberately NOT implemented (need an owner decision or touch live sending)

- **`pkg-client-notify` ignores the studio's saved Sender name.** In `EMAIL_BRAND_MODE=studio`,
  `comms-dispatch` uses the studio's own saved Sender name (0150), but `pkg-client-notify`
  (`index.ts:57-61`, `pkgFromName`) and `razorpay-webhook` (`index.ts:67`, `fromName`) do **not** — package
  emails go out as "&lt;Studio&gt; via Helm Events" and receipts as the raw studio name. Making package
  emails honor the saved Sender name would need a DB read of `comms_settings.email_from_name` and would
  **change the From line on real client emails**, so it is left for the owner to approve. (Payment-receipt
  naming looks intentional per the docs and is probably best left as-is.)
- **Dark-mode transactional emails: DECIDED (R207) - light-only.** `_shared/email-layout.mjs` now emits
  `color-scheme: light only` and no dark-mode rules; the tests (test/r207-email-light, email-redesign,
  auth-signup-confirm, tests/edge/trial-reminder-email, tests/edge/pkg-client-notify) pin light-only.
- **`billing-reminder` / nurture greetings** remain intentionally dormant pending owner decisions — not a
  code gap.

---

## 6. Why no code was changed in this PR

The email system is already complete and heavily tested (612 node tests pass). Every candidate improvement
either (a) changes how **real** emails are addressed/rendered, or (b) needs an owner decision — both outside
the "clearly-safe, no-send-risk" bar. The high-value deliverable is this plan plus the §4 sequence. The
items in §5 are ready to implement the moment the owner approves them.
