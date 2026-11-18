# INCIDENT-RESPONSE-RUNBOOK.md (Agent G)

Incident response for Helm production. Legend: **SOURCE** · **STAGING VERIFIED** ·
**RECOMMENDATION** · **BLOCKED**. Pairs with DISASTER-RECOVERY-RUNBOOK (recovery
mechanics) and OBSERVABILITY-ACTIVATION.md (signal wiring).

## 1. Severity levels (RECOMMENDATION)
| SEV | Definition | Example | Response |
|-----|-----------|---------|----------|
| **SEV1** | Data loss, money error, or cross-tenant exposure; or full outage | wrong-org data visible; duplicate/lost payment; site down | page owner immediately; all-hands; comms clock starts |
| **SEV2** | Major function broken, no data/money loss | OTP delivery down; quotes can't save | owner within 30 min; fix same day |
| **SEV3** | Degraded / partial, workaround exists | slow dashboard; one integration flaky | next business day |
| **SEV4** | Cosmetic / low impact | UI glitch, typo | backlog |
- Any suspected **cross-tenant data exposure or money discrepancy is SEV1** (ties to
  the zero-data-loss guardrail).

## 2. On-call / owner (RECOMMENDATION — fill in)
- Primary owner / incident commander: ______ (currently `hr@criskasecurity.com` as
  default contact).
- Secondary / escalation: ______. Define a single IC per incident who owns decisions.

## 3. Lifecycle: triage → containment → eradication → recovery
1. **Triage:** confirm it's real, assign SEV, name an IC, open a timeline doc.
2. **Containment:** stop the bleeding — e.g. flip a `liveChannels` flag off, disable a
   compromised Edge function, revoke a leaked key, block an abusive IP. Prefer
   fail-closed (the app's integrations are already dormant/fail-closed by default —
   **SOURCE** memory: WhatsApp/Razorpay).
3. **Eradication:** remove root cause — patch code, rotate secret, fix data via an
   additive/idempotent script (NEVER a destructive one).
4. **Recovery:** restore service via the matching DISASTER-RECOVERY domain; verify
   `/api/health` + a real login + one quote read.
5. **Postmortem:** see §7.

## 4. Secret rotation steps
Trigger: any suspected key exposure (SEV1/2).
1. Generate a new secret at the provider (Razorpay / MSG91 / Resend / Supabase
   service-role).
2. `supabase secrets set NAME=<new>` — set by NAME, value never logged (**SOURCE**
   `PRODUCTION-RELEASE-PACK.md` §7–8).
3. Redeploy the consuming Edge function so it picks up the new value.
4. Invalidate the old secret at the provider; for the webhook secret, update the
   provider dashboard so inbound signatures verify against the new value.
5. For service-role / JWT secret rotation, expect session invalidation — communicate.
6. Record rotation in the incident timeline. Scan repo/logs to confirm no secret leaked
   (`.gitleaks.toml` present — **SOURCE**).

## 5. Rollback
- **Code (Vercel):** promote the prior production deployment / redeploy last-good SHA.
- **DB:** restore pre-apply snapshot, OR run the per-object reverse script; migrations
  are additive/idempotent so forward-fix is usually safer than reverse (**SOURCE**
  `PRODUCTION-RELEASE-PACK.md` §9). NEVER hand-delete production rows to "undo".
- **Edge:** redeploy previous function versions.
- **Vercel env/config:** revert the changed env var and redeploy.

## 6. Customer-comms decision tree (RECOMMENDATION)
- Cross-tenant data exposure OR confirmed payment error (SEV1) → **notify affected
  tenants**; assess regulatory/DPDP breach-notification duty → escalate to legal/owner.
  Do NOT send on your own — comms are a send-on-user-behalf action requiring explicit
  owner approval.

### 6a. Personal-data breach clock (India) — audit E, 18 Nov 2026 (have a lawyer confirm)
Start the clock at the moment Helm **becomes aware** of a likely personal-data breach
(any studio's or client's names, phones, e-mails, guest lists, money rows, files).
Write that time down in the incident log first.

| When | Who is told | What |
|---|---|---|
| Within **6 hours** | CERT-In (incident@cert-in.org.in, form on cert-in.org.in) | Cyber-security incident report under the CERT-In Directions of 28 Apr 2022 (data breach, data leak, unauthorised access, compromise of the app or database are all reportable types). A first report with what is known is enough; send the rest later. |
| **Without delay** | Data Protection Board of India + every affected person (studio owners; through them, or directly, their clients / staff where Helm holds the data) | DPDP Rules 2025 r.7(1): what happened, when, likely effect, what Helm did, what the person can do, a contact. Plain words, through the account e-mail. |
| Within **72 hours** | Data Protection Board of India | DPDP Rules 2025 r.7(2): the detailed report (facts, cause, who did it if known, steps taken, people told). |

Helm is the Data **Processor** for studio data (each studio is the Data Fiduciary for its
clients) and the Data **Fiduciary** for studio accounts / HQ data — tell the affected studios
at once so they can meet their own duty.

Before any of this can work, the owner must fill in the named contacts on /privacy and
/grievance (Grievance Officer, DPO / contact e-mail — today they say "To be updated"), and
keep an evidence pack per incident: timeline, affected studio ids, row counts (counts only,
never the personal data itself), the fix, and copies of every notice sent.

The CERT-In 6-hour rule is in force today. The DPDP Rules 2025 breach duties (r.7) start on the
date the Rules give for them (18 months after they were notified on 13/14 Nov 2025, i.e. by May 2027 —
lawyer to confirm); follow them now anyway.
- Outage > RTO (SEV1/2) → status-page / direct notice to active tenants.
- Internal-only, no customer impact (SEV3/4) → internal log only.

## 7. Postmortem (RECOMMENDATION)
Blameless, within 5 business days of SEV1/2: timeline, root cause, detection gap,
customer impact, action items with owners + dates. File under `docs/`.

## 8. Observability activation checklist
State on 18 Nov 2026 (audit E): front-end Sentry is ON (R45, errors only, self-hosted SDK
R138/R140); edge functions log one JSON line per event (R142 `_shared/log.ts`) and can send
error tags to Sentry when the `SENTRY_DSN` edge secret is set (owner to confirm it is);
`/api/health` answers on www.helm.events. The remaining items still need an operator:
- [x] Frontend JS errors → Sentry (DSN in `config.js`; `telemetry.js` redacts
      JWT/token/OTP/email/phone/amounts/link tokens via `beforeSend` — **SOURCE**).
- [x] Edge Function errors as structured one-line JSON (`_shared/log.ts`; edge → Sentry
      only when the `SENTRY_DSN` secret is set).
- [ ] Sentry alert rule ("new issue" + spike) routed to the owner's e-mail.
- [ ] Auth failures (failed sign-in / invalid-OTP / expired session).
- [ ] DB CPU / connection count alerts.
- [ ] Storage usage / quota alerts.
- [ ] Slow-query monitoring.
- [ ] HTTP 5xx rate alert.
- [ ] Uptime monitor on `https://www.helm.events/api/health` + `/` (1-min interval). Use the www host or let the
      monitor follow redirects: `helm.events/...` answers 307 -> www. `/api/health` does not touch the database, so
      add a second check that does (see audit E report, E-04).
- [ ] OTP-abuse / OTP-pumping spike detection.
- [ ] Payment anomaly alerts (declines, amount-mismatch — webhook already logs
      amount-under-total, **SOURCE** `razorpay-webhook`).
- [ ] Webhook-failure visibility (invalid signature → 401, logged — **SOURCE**;
      failed rows queryable without raw body per STAGING-OBSERVABILITY §2).

## 9. Log hygiene (invariant)
Logs must NEVER contain passwords, OTP values, tokens, service-role keys, or payment
secrets. **SOURCE:** webhook uses constant-time signature compare and logs only status
/ ids, not raw bodies (`razorpay-webhook/index.ts`); `telemetry.js` `beforeSend`
redacts PII/secrets. Any new log line must be reviewed against this rule.
