# Email that actually sends (R169)

_Builds on `EMAIL-SETUP-PLAN.md` (R168). That file proves the email **system** is already built and
tested; this file is the **operator's playbook** — how to make real mail leave the building today for
testing, and the production-grade way to make it land in inboxes. Researched and written 2026-11-14 on a
worktree off `693ce816`. No real email was sent, no edge function was called, nothing was deployed._

---

## 0. Headline

- **The code is ready. The only thing missing is a verified sending domain + two secrets.** Helm has one
  shared mailer that auto-selects **Resend** (if `RESEND_API_KEY` + `RESEND_FROM` are set) or **SMTP**
  (if `SMTP_HOST`/`USER`/`PASS` are set), else sends nothing. You do not change code to switch providers —
  you set secrets.
- **To test TODAY:** a Gmail address + a 16-character **App Password** over SMTP, **port 465**. Works with
  the current code as-is. _Testing only — deliverability is limited and capped ~500 messages/day._
- **For production:** **Resend** with the `helm.events` domain verified (SPF + DKIM + DMARC). Best
  balance of deliverability, setup effort, price, and the fact that **Helm already auto-switches to it**.
- **The biggest real-world gotcha** (and the one correction to the task brief): on Supabase Edge, outbound
  ports **25 and 587 are blocked** by the platform. Gmail's usual port 587 (STARTTLS) **will time out**.
  Use **port 465** (implicit TLS). Gmail supports 465, and Helm defaults `SMTP_PORT` to 465, so this is
  the default anyway — just don't override it to 587.

---

## 1. Deep research — how the best small SaaS products send transactional email in 2026

### The field, realistically

| Provider | Deliverability | SPF/DKIM/DMARC alignment | Sending limits | Price (entry) | Setup effort | Notes |
|---|---|---|---|---|---|---|
| **Personal Gmail SMTP** | Poor for a *domain* | ❌ cannot DKIM-sign `helm.events` — From is `@gmail.com` | ~**500/day** (personal) | Free | Trivial (App Password) | Fine to **test the pipe**, wrong for production. |
| **Google Workspace** (mailbox or SMTP relay) | OK | ✅ if you own the Workspace domain | 2,000/day per user; relay higher | ~₹125+/user/mo | Medium (Workspace + DNS) | Viable if the studio already lives in Workspace; relay needs 465/SSL on Edge too. |
| **Resend** | Good; developer-first | ✅ domain verification issues SPF + DKIM; you add DMARC | Free **3,000/mo**, then ~$20/mo for 50k | **Low** (add domain, paste DNS, done) | Newer, but the default pick for dev-led SaaS; **Helm auto-switches to it**. |
| **Amazon SES** | Good, but you own reputation | ✅ | Cheapest at volume (~$0.10/1k) | Pennies | **High** (IAM, out-of-sandbox request, you build suppression/bounce handling) | Best at scale; most plumbing to own. |
| **Postmark** | **Best** inbox placement (separate transactional IP pools) | ✅ | ~$15/mo for 10k | Low–medium | Strong reputation, highest per-email price. |
| **SendGrid** | OK, mixed reputation | ✅ | Free plan **retired May 2025**; ~$19.95/mo for 50k | Medium | Heavier product; fine but no longer the obvious default. |
| **Mailgun** | OK | ✅ | Pay-as-you-go | Medium | Developer-oriented; fine alternative to SES. |

### Current best-practice conclusions

- **Authentication is non-negotiable.** Since Feb 2024, **Gmail and Yahoo** require every sender (strictly,
  bulk senders ≥5,000/day, but treat it as universal) to publish **SPF + DKIM + DMARC** with the DMARC
  domain **aligned to the visible `From:`**, keep the Gmail spam-complaint rate **under 0.3 %**, and offer
  **one-click unsubscribe** (RFC 8058) on marketing mail. Transactional mail (sign-in codes, receipts) is
  exempt from one-click unsubscribe but still must authenticate. **Helm already does all the code-side
  parts** (footers, `List-Unsubscribe` on marketing mail, domain-aligned From) — so the remaining work is
  purely DNS + provider dashboard.
- **A free-mailbox From (`@gmail.com`) can never pass DKIM alignment for `helm.events`.** This is precisely
  why the production path needs a verified custom domain, and why personal Gmail is testing-only.
- **(a) Fastest way to send right now:** Gmail + App Password over SMTP **465**. Minutes, zero code.
- **(b) Production-grade:** verified custom domain on a real provider. For Helm specifically → **Resend**.

### Why Resend for Helm (the single pick)

1. **Zero code to adopt** — the mailer flips to Resend the moment `RESEND_API_KEY` + `RESEND_FROM` exist.
2. **Lowest setup effort** — add `helm.events`, paste the SPF/DKIM records it shows, wait for *Verified*.
3. **Free 3,000/mo** comfortably covers a growing studio SaaS; ~$20/mo at 50k if it scales.
4. **Idempotency-Key** is already sent by `mailer.ts` (prevents duplicate sends on retry) — a Resend feature
   Helm is already coded for.
5. Postmark edges it on raw inbox placement and SES on price-at-scale, but neither is worth the extra setup
   for Helm's stage; **SES in particular makes you build suppression/bounce handling yourself.** Keep SES as
   the "if we ever send hundreds of thousands" escape hatch.

### India-specific notes

- No India-specific blocker for Resend / SES / Postmark — they authenticate by DNS, which is global. Choose
  a provider region close to recipients if offered, but it is not decisive.
- Most Indian clients are on **Gmail / Yahoo**, so the Gmail/Yahoo 2024 rules above apply directly — the
  verified-domain path matters more here, not less.
- **DPDP (India's privacy law)** already governs this project (see project memory); transactional mail
  needs a lawful basis and a working reply/grievance path — Helm's per-studio **Reply-To** already supports
  this. **Zoho ZeptoMail** (India-based, very cheap transactional) is a credible regional alternative to
  Resend if the owner prefers an Indian vendor — it would use the **SMTP path** (`SMTP_HOST` = Zoho's host,
  **port 465**), no code change. Resend remains the primary recommendation because Helm auto-switches to it.

---

## 2. Make it work **now** — Gmail path (testing only)

> Deliverability is limited (From is `@gmail.com`, not DKIM-aligned to `helm.events`) and capped at ~500
> messages/day on a personal account. Use this to **confirm the pipe sends**, not for real client mail.

**Does Helm's SMTP path support this as-is?** **Yes, with one correction.** `_shared/smtp.ts` already does
implicit TLS on 465 **and** STARTTLS on other ports, and `mailConfig` defaults `SMTP_PORT` to 465 with
`SMTP_FROM` defaulting to `SMTP_USER`. So Gmail works with **no code change** — *provided you use port 465*.
**The exact gap:** the task brief said port **587**, but **Supabase Edge blocks outbound 25 and 587**, so a
587 attempt times out at the `connect` stage. Use **465**.

**Owner steps (all owner-config, no code):**
1. In the Google account that will send: turn on **2-Step Verification**, then create an **App Password**
   (Google Account → Security → App passwords) — a 16-character string. Plain-password SMTP was removed by
   Google in May 2025, so an App Password (or OAuth) is required.
2. Set these secrets on **staging first** (Supabase → Project → Edge Functions → Secrets):
   - `SMTP_HOST` = `smtp.gmail.com`
   - `SMTP_USER` = the full Gmail address, e.g. `you@gmail.com`
   - `SMTP_PASS` = the 16-character App Password (no spaces)
   - `SMTP_PORT` = `465` _(optional — 465 is already the default; just never set 587)_
   - `SMTP_FROM` = _optional; defaults to `SMTP_USER`_
3. Confirm with the built-in **dry run** before any real send: Integrations page → Email card →
   **Check status** shows the active provider + any setup hints (R169, below); **Send test email to me**
   sends only to your own login address and reports the exact From/Reply-To, or reads **Simulated** if no
   provider is set (nothing leaves Helm).
4. The mailer auto-selects SMTP; every mailer in the app now sends. When you move to production, **remove
   these SMTP secrets** (or set Resend, which takes priority) so you don't keep sending from Gmail.

---

## 3. Recommended **production** path — Resend + `helm.events`

**Owner steps (owner-config; the code already auto-switches):**
1. Create a **Resend** account. Dashboard → **Domains** → **Add Domain** → `helm.events`.
2. Resend shows DNS records (an **SPF** TXT/MX or CNAME, and a **DKIM** record at the `resend._domainkey`
   selector). Add them **exactly as shown** at your DNS host. _Trust the dashboard's records over any blog —
   record types vary by account/date._
3. Add a **DMARC** record yourself (Resend does **not** add it): a TXT record at `_dmarc.helm.events`,
   start at **`v=DMARC1; p=none; rua=mailto:dmarc@helm.events`** (monitor only).
4. Back in Resend, click **Verify**. Wait for **Verified** (usually minutes; if >72 h, use *Restart
   verification*). Verify DMARC separately with any DMARC checker — the Resend badge does not cover it.
5. Create an **API key**. Set the two secrets on staging, then prod:
   - `RESEND_API_KEY` = the key
   - `RESEND_FROM` = `Helm <mail@helm.events>` (a mailbox on the verified domain)
   - (also set `HELM_POSTAL_ADDRESS` and `APP_URL` for the compliance footer — see `EMAIL-COMPLIANCE.md`)
6. The mailer switches to Resend automatically (Resend takes priority over SMTP). Re-run the **Send test**.
7. **DMARC rollout:** keep `p=none` for 2–4 weeks, then `p=quarantine; pct=25`, raise to 100, optionally
   `p=reject`. Register **Google Postmaster Tools** + **Yahoo Complaint Feedback Loop** to watch spam rate.
8. **Option B (studio branding):** when ready, apply migration `0150` and set `EMAIL_BRAND_MODE=studio` —
   client mail then reads "`<Studio> via Helm Events`" with the studio as Reply-To, still sent From the
   verified `helm.events` address (so SPF/DKIM stay aligned). Code is already done.

---

## 4. Code vs. owner-config

| Item | Code done? | Owner action |
|---|---|---|
| Shared mailer, Resend↔SMTP auto-select, fail-closed | ✅ Done | — |
| Gmail App Password over SMTP (testing) | ✅ Supported as-is (port **465**) | Create App Password; set `SMTP_*` secrets |
| Resend production send | ✅ Auto-switch on secrets | Verify domain + SPF/DKIM/DMARC; set `RESEND_API_KEY` + `RESEND_FROM` |
| Idempotency-Key on retries (no duplicate sends) | ✅ Done | — |
| Footers / one-click unsubscribe / compliance | ✅ Done | Set `HELM_POSTAL_ADDRESS`, `APP_URL`; apply `0165` |
| Built-in dry-run test + status (`integrations-test`) | ✅ Done | Use the Integrations page buttons |
| **R169: value-free setup hints** (`emailSetupHints`) in the status response | ✅ **Added (this PR)** | Optionally surface `email.hints` on the Integrations UI |
| **R169: SMTP `connect` error names the 25/587 block + 465 fix** | ✅ **Added (this PR)** | — |
| Verified sending domain (SPF/DKIM/DMARC) | n/a | **Owner: DNS + provider dashboard** |
| Option B studio branding | ✅ Done | Apply `0150`; set `EMAIL_BRAND_MODE=studio` |
| Mailer cron schedules | n/a | **Owner: per `docs/ops/EMAIL-SETUP.md`** |
| Surface `email.hints` in the Integrations UI | ⚠️ Not wired (design choice) | Owner decision — see §6 |
| Dark-mode emails; `pkg-client-notify` saved Sender name; billing/nurture dormant senders | per R168 §5 | **Owner decisions** (unchanged) |

---

## 5. How I did it (this PR)

- **Verified, didn't re-derive.** Read `mailer.ts`, `smtp.ts`, `integrations-test/{index.ts,logic.mjs}` and
  the R168 `EMAIL-SETUP-PLAN.md`. Confirmed the SMTP client supports both 465 (implicit TLS) and STARTTLS,
  and that `mailConfig` defaults to 465 with `SMTP_FROM`→`SMTP_USER` — so **Gmail works with no code
  change**. Confirmed the real constraint is the Supabase-Edge 25/587 block (corrects the brief's "587").
- **Research** via web search (sources below): current provider landscape, Gmail SMTP ports/limits, the
  Gmail/Yahoo 2024 authentication rules, Resend domain-verification steps, and India notes.
- **Safe code only (cannot send mail, no owner decision needed):**
  1. `emailSetupHints(env)` — a **pure, value-free** diagnostic in `integrations-test/logic.mjs`. Reads env
     **names** only (never a secret value), returns plain-words hints: the Supabase 587 block, the Gmail-465
     testing caveat, a free-mailbox From that can't be DKIM-aligned, and missing `RESEND_FROM`. No network,
     nothing sent.
  2. Wired `email.hints` **additively** into the `integrations-test` **status** response (the frontend still
     only reads `email.live`/`email.sender`, so nothing breaks).
  3. Improved the SMTP `connect` failure message to name the 25/587 block and the 465 fix — better error
     surfacing, a string only.
  4. New test `test/r169-email-setup.test.mjs` (11 checks), including explicit assertions that **no hint
     ever echoes a secret value**.
- **Deliberately NOT changed** (would alter how real mail is addressed/rendered, or needs a decision):
  the dark-mode email decision, `pkg-client-notify` honoring the studio's saved Sender name, the dormant
  `billing-reminder`/nurture senders (all per R168 §5), and surfacing `email.hints` in the Integrations UI
  (a design choice — see §6). No migrations, no `public/` assets, no HTML inline scripts, no deploy.
- **Tests:** full suite **613 pass** (612 existing + 1 new file), `check-migration-canon.mjs` clean.

## 6. Recommendations (need owner decision — not implemented)

1. **Surface `email.hints` on the Integrations page.** The backend now returns them; a small `integrations.js`
   addition could list them under the Email card. Left out because the exact UI placement/wording is a design
   choice and would touch `public/` (asset bump).
2. **Move prod off personal Gmail to Resend + `helm.events`** (the single biggest deliverability lever).
3. Then flip **Option B** on once the verified domain is live.

---

## Sources

- [10 Best Transactional Email Providers for SaaS in 2026 — makerkit.dev](https://makerkit.dev/blog/saas/best-transactional-email-provider-saas)
- [Transactional email providers compared: Resend, Postmark, SendGrid, AWS SES, Mailgun — getfluxly.com](https://www.getfluxly.com/blog/transactional-email-providers)
- [transactional email resend ses deliverability 2026 — codercops.com](https://blog.codercops.com/blog/transactional-email-resend-ses-deliverability-2026)
- [Gmail SMTP settings: ports, auth, limits — Nylas](https://developer.nylas.com/docs/cookbook/email/gmail-smtp-settings.md)
- [Gmail SMTP Settings 2026 — zeliq.com](https://www.zeliq.com/blog/gmail-smtp-settings)
- [Resend — Add a domain (SPF/DKIM) docs](https://resend.com/docs/add-a-domain)
- [Resend — DMARC docs](https://resend.com/docs/dashboard/domains/dmarc.md)
- [How to configure SPF and DKIM for Resend — autospf.com](https://autospf.com/blog/how-to-configure-spf-and-dkim-for-resend)
- [Google and Yahoo Updated Email Authentication Requirements (2024) — powerdmarc.com](https://powerdmarc.com/google-and-yahoo-updated-email-authentication-requirements-for-2024/)
- [Requirements for bulk email senders — Close](https://help.close.com/technical-support/email-deliverability/requirements-for-bulk-email-senders)
