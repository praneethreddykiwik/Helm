# Helm API reference

This page describes the API surface Helm has today. It was first checked against `origin/main` (worktree `wt-docs`, 2026-10-17) and re-checked against the code on branch `fix/r147-small-lows` (2026-11-11). Code is referenced by file and function name, not line number. Helm has **no custom REST backend in production**. The browser talks to three things:

1. **Supabase PostgREST**: table reads and writes, all guarded by Row-Level Security (RLS).
2. **Postgres RPC functions** (`supa.rpc(name, args)`). About 450 distinct names appear in `rpc("…")` calls in `public/*.js` (count from 2026-11-11). Section 3 lists the main ones by area.
3. **Supabase Edge Functions** (`/functions/v1/<name>`). There are **25**. Each has a folder in `supabase/functions/` (next to `_shared/` and `README.md`) and a `[functions.<name>]` section in `supabase/config.toml`.

Provider webhooks (Razorpay, Meta) call edge functions directly. Browsers send CSP violation reports to `csp-report`, and mail providers send one-click unsubscribes to `email-unsubscribe`. `server.js` is a local dev server only (see section 9).

Conventions: "Assumption:" marks something not fully proven from code. "Decision needed:" marks an owner choice. Secret **values** never appear on this page, only their **names**.

Related docs (reuse, do not duplicate): `supabase/functions/README.md`, `docs/project/DEPLOYMENT.md`, `docs/project/INTEGRATIONS.md`, `docs/INTEGRATIONS-WHATSAPP-RAZORPAY.md`, `docs/ops/WHATSAPP-SETUP.md`, `docs/ops/EMAIL-SETUP.md`, `docs/ops/EMAIL-COMPLIANCE.md`, `docs/COMMS-AUTOMATION-SETUP.md`, `docs/AUTH-DASHBOARD-SETTINGS.md`, `docs/AUTH-PRODUCTION-HARDENING.md`, `docs/security/OWNER-DASHBOARD-STEPS-R21.md`, `docs/security/MONITORING-R21.md`, `docs/PHOTO-RENDER-SETUP.md`, `docs/OBSERVABILITY-ACTIVATION.md`, `docs/RUNBOOK.md`, `docs/INCIDENT-RESPONSE-RUNBOOK.md`, `docs/DATA-PROTECTION-REVIEW.md`, `docs/OPERATOR-VERIFY-DEFINER-FUNCTIONS.md`.

---

## 1. Auth model

| Caller | Credential | What it can reach |
|---|---|---|
| **Anonymous visitor** (client approval link, booklet, portal, invitation site, crew work link) | Supabase **anon key** (public by design, in `public/config.js`) plus a **bearer token in the URL** (a UUID or hex string such as `p_token`) | Only the functions granted `to anon` (section 3.1). Each one checks the token itself: that it is live, unexpired and unrevoked. No table access. |
| **Signed-out edge call** (invitation join page, unsubscribe page or mail provider, public forms, browser CSP reports) | The anon key or nothing, plus a token where one exists | Edge functions with `verify_jwt = false` that check a token in code: `invite-signup` (48-hex invitation token), `email-unsubscribe` (unsubscribe token checked in the DB), `booklet-snapshot` (booklet token), `captcha-verify` public actions (the Turnstile token is the proof), `csp-report` (no auth possible; nothing stored). See section 4. |
| **Signed-in studio member** (admin, manager, planner, sales, coordinator, supervisor, quality, operations, designer, crew, client) | Supabase Auth **JWT** (email/password, Google OAuth, optional TOTP MFA) | Tables through RLS, plus functions granted `to authenticated`. Tenant scope is `current_org_id()`. Permission scope is `has_area(area, level)` from the configurable role matrix (`admin_get_role_access` / `admin_set_role_access`, legacy `supabase/phase29-role-access.sql`). |
| **Platform operator / HQ** | JWT plus an operator flag (`is_platform_operator`, `is_platform_admin`, `operator_mfa_required`) | HQ pages (`hq.html`, `hq.js`) and cross-studio billing functions. |
| **Edge function (server)** | `SUPABASE_SERVICE_ROLE_KEY` (injected by Supabase, never sent to the browser) | `service_role`-only functions (section 3.13), such as outbox claim/mark, payment settle and rate limiting. |
| **Cron / DB webhook** | Shared secret in the `x-helm-cron-secret` header (compared in constant time). Each function has its own secret name (section 4). | `billing-reminder`, `comms-dispatch`, `pkg-client-notify`, `security-alert-mailer`, `verify-upload`, `welcome-mailer`, and the cron path of `invite-mailer`. |
| **Provider webhook** | HMAC signature header (section 6) | `razorpay-webhook`, `razorpay-subscription-webhook`, `wa-webhook`. |

How tenancy works:
- Every studio-owned row carries `org_id`. RLS policies compare it with `current_org_id()`.
- `SECURITY DEFINER` functions re-check org and role inside the function body. Migrations 0073 and later, plus `supabase/phase73-definer-org-isolation-final.sql`, cover this. See `docs/OPERATOR-VERIFY-DEFINER-FUNCTIONS.md`.

Default privileges (0156 and earlier hardening): new functions in `public` are **not** executable by `anon` or `PUBLIC`. Each anon function has to be granted explicitly.

Account-level controls (Supabase dashboard; see `docs/AUTH-DASHBOARD-SETTINGS.md`):
- Email confirmation.
- Auth rate limits. The doc notes 30 emails per hour needs custom SMTP.
- Optional Cloudflare Turnstile (`config.captcha.siteKey`, empty means off). Supabase Auth verifies it on sign-in, sign-up and reset. The `captcha-verify` edge function verifies it for checkout "Contact sales" and the signed-out public forms (needs `TURNSTILE_SECRET_KEY`; section 4).
- MFA lockout: 5 wrong codes lock code entry for 15 minutes (0050, `mfa_record_failure` / `mfa_lock_status`).

---

## 2. Request / response and error conventions

### 2.1 Client wrappers (`public/store-api.js`)
- **RPC:** `rpc(name, args)` wraps `supa.rpc` (through `rpcOnce`). Argument names use the `p_` prefix (for example `{ p_token, p_quote_id }`). Most functions return `jsonb` or a table row, and the wrapper throws the PostgREST error object (`code`, `message`, `hint`, `details`). When the server refuses a sensitive change until the caller enters a fresh two-step code (r35, 0285), `withStepUp` asks for the code once and retries.
- **Edge functions:** `async function callFn(name, body)` in `store-api.js`. The URL comes from `fnUrl(name)`, which is `<config.url>/functions/v1/<name>`.
  - Always `POST` with a JSON body.
  - Sends `Authorization: Bearer <session access token>`, falling back to the anon key on public pages, plus an `apikey` header.
  - A non-2xx response throws `Error(j.error || "HTTP <status>")`.
  - Some callers use `fetch` directly instead of `callFn`, because they need the HTTP status or different headers: `invite-signup`, `create-subscription-checkout`, `captcha-verify` (`captchaPass` in `store-api.js`, plus `public/captcha.js` for the signed-out forms), `render-photo`, `email-unsubscribe` (`public/unsubscribe.js`) and `booklet-snapshot` (an `<img src>` URL).
- **Live versus simulated:** `const LIVE = CFG.liveChannels` in `store-api.js`. Today `public/config.js` sets:

  | Flag | Value | Meaning |
  |---|---|---|
  | `sms` | `false` | MSG91 SMS codes are off. |
  | `pay` | `false` | Razorpay Payment Links are off. |
  | `whatsapp` | `true` | R129 (0337): each studio sends from **its own** WhatsApp Business number, connected on the Integrations page. A studio that has not connected one sends no WhatsApp. There is no fallback to a Helm number. |
  | `whatsappHelm` | `false` | Helm's **own** number (`WHATSAPP_TOKEN` / `WHATSAPP_PHONE_ID` secrets). Used only for the staff phone "Verify" code (`send-phone-code`). |
  | `email` | `true` | `client-mailer` ("Send by email") and the e-mail approval code from `send-otp`, sent through Resend or SMTP (`SMTP_*` secrets). |

  While a flag is false, the app calls a simulated RPC (or nothing) instead of the edge function:

  | Action | Flag | Flag off | Flag on |
  |---|---|---|---|
  | SMS approval code | `sms` | `request_otp` RPC (dev code shown off production) | `send-otp` `{ token, phone }` |
  | Online payment of a quote | `pay` | `create_payment` RPC (mock link). On production hosts (`window.HELM_IS_PROD_HOST`) it is refused with a plain message. | `create-payment-link` `{ token }` |
  | WhatsApp approval code | `whatsapp` | `wa_request_otp` RPC | `send-otp` `{ token, channel: "whatsapp" }` |
  | E-mail approval code | `email` | `wa_request_otp` RPC | `send-otp` `{ token, channel: "email" }` |
  | "Send on WhatsApp" (proposal / payment) | `whatsapp` | `wa_proposal_prepare` with `p_simulate: true` | `wa-proposal` |
  | "Send by email" (approval / booklet link) | `email` | No call. Answers `{ status: "not_configured" }` ("e-mail sending is switched off for this site"). | `client-mailer` |
  | Staff phone verification code | `whatsappHelm` | No call. "Phone verification will be available shortly — you can continue." | `send-phone-code` |
  | Online subscription payment on `/checkout` | `pay` **and** HQ's `online_payments_live` (`payLive`); the Pay now buttons also need `HELM_FEATURES.payNow` (`false` today) | Contact sales / free trial | `create-subscription-checkout` |

  A function that is called live can still answer "simulated" or "not configured" when its own secrets are missing: e-mail with no Resend or SMTP secret, or a studio with no connected WhatsApp number. See section 4.

### 2.2 `function friendlyError(e, o)` (`public/store-api.js`)
Called as `friendlyError(err, { action, setupHint })`. Every UI error goes through this function. It never shows SQL or stack traces to end users. When `action` is given, the message starts with "Couldn't <action>.". It checks these cases in order:

| Condition | Message shown |
|---|---|
| An auth error already put into words by `BPStore.auth` (`e.authMapped`, r29) | Shown as written |
| Auth error (expired or invalid JWT, `PGRST301`–`PGRST303`, a bare 401 that is not a failed login) | "Your session expired — sign in again." |
| Browser offline (`navigator.onLine === false`) | "You're offline — reconnect and try again." |
| Network failure | "Couldn't reach the server — check your connection and try again." |
| `hint = money_frozen` (0046) | The DB message itself (a locked approved, paid or closed money record) |
| `hint = payment_pending` (0159) | "Choose a plan and complete payment to start using Helm — or start a free trial instead." |
| Two-step step-up (`e.stepUp`, or a message starting `R35_REAUTH`, `R35_SETUP_2STEP` or `R35_FLAGGED`; r35, 0285) | "This change needs your two-step code." when the person cancelled, otherwise the server message |
| `hint = trial_cap` / `trial_locked` (0166, 0173), `hint = menu_pkg_invalid` (0192) | The DB message, shown as written |
| `code = invalid_phone` (B15) | The message, which says what to type (for example a 10-digit number for India) |
| `code = reserved_domain`, or a "reserved for the Helm team" message (0248) | "Addresses on helm.events are reserved for the Helm team…" |
| `hint = seat_limit` | The free trial's seats (you + 2 people) are all in use |
| `hint = plan_seat_limit` (R32b) | The plan's invite limit is reached (the number comes from `details.limit`) |
| `hint = trial_ended` (0183) | "Your trial has ended. Your data is preserved and available in read-only mode…" |
| `hint = studio_suspended` or code `25006` | Studio is read-only (subscription suspended or trial ended) |
| `HL409` (blocked; an admin may override), `HL428` (client must re-approve) (0052), `HL425` (event day not over, 0198) | The DB message, shown as written |
| `22023` / `42501` whose message is a plain sentence | Shown as written (for example "Only an admin can re-open a closed event.") |
| `42501`, HTTP 403, RLS denial | "You don't have permission to …" |
| Missing table or function (`42P01`, `PGRST205`, `PGRST202`, `42883`) | Admins see a "database setup hasn't been applied yet" notice (with `setupHint`). Other users see "This feature isn't available yet". |
| Not found (`PGRST116`, HTTP 404, "0 rows") | "It may have been deleted, or you may no longer have access." |
| `23505` | Already exists |
| `23503` | Linked to other records |
| `23502` | Required field missing |
| `23514`, `22P02`, `22003`, `22007`, `22008` | Some values are invalid |
| `40001`, `40P01`, HTTP 409 | Someone else changed this at the same time |
| `57014`, HTTP 504/408 | The server took too long |
| HTTP 429 | Too many requests |
| HTTP 5xx | The server had a problem |
| `P0001` / plain message with no technical words | Shown as written |
| Anything else | "Something went wrong — please try again." |

Server-side convention: business rules `raise exception … using errcode = 'P0001' | '22023' | '42501' | 'HL409' | 'HL428' | 'HL425', hint = '<machine hint>'`, and the message is written for people.

### 2.3 Edge function responses
- Errors are JSON `{ "error": "<short_code_or_sentence>" }` with a meaningful status:

  | Status | Meaning |
  |---|---|
  | 204 | `csp-report` (always; browsers ignore the body) |
  | 400 | Bad input |
  | 401 | Bad or missing secret, JWT or signature |
  | 403 | Not allowed (including a free-trial studio refused a real send, `trial: true`) |
  | 404 | Dormant webhook or snapshot, or an invalid link token |
  | 405 | Wrong method |
  | 409 | State conflict, for example `not_connected` (no studio WhatsApp number), `not_priced`, a payment link already being made, or "create the approval link first" |
  | 413 | Body over the size cap |
  | 415 | `csp-report` only: not a CSP report content type |
  | 429 | Rate limited, with a `Retry-After` header |
  | 502 | The provider (Meta, Resend, SMTP, Razorpay) refused or failed |
  | 503 | Not configured, for example `render_not_configured`, `captcha_unavailable`, or `create-subscription-checkout` `{ dormant: true }` |

- Dormant cron functions answer **200 no-op** (`{status:"dormant"}`), so that cron jobs do not alarm. Other dormant functions answer 404 (`booklet-snapshot`, `wa-webhook`) or 503 (`create-subscription-checkout`, `render-photo`, `send-phone-code`).
- **CORS:** browser-called functions allow an exact origin list from `_shared/cors.ts`: `https://helm.events`, `https://www.helm.events`, `https://helm-v01.vercel.app` and `https://helm-alpha-nine.vercel.app`. There are no wildcard previews. Override with `ALLOWED_ORIGINS` or `EXTRA_ALLOWED_ORIGINS`. `ALLOW_LOCALHOST=1` is for dev or staging only. Every response sends `Vary: Origin`.
- **Body caps** (`_shared/limits.ts`): 16 KB by default for browser-called functions (`DEFAULT_BODY_LIMIT`), 64 KB for webhooks and `verify-upload` (`WEBHOOK_BODY_LIMIT`). Exceptions: `captcha-verify` and `email-unsubscribe` 4 KB, `render-photo` 11 MB (up to four reference pictures). Bodies are read in a stream and abandoned once they pass the cap.
- **Server errors:** a 500 from `responders().serverError` (`_shared/cors.ts`) can also send an optional Sentry alert (only with the `SENTRY_DSN` secret; function name and error tag only).

---

## 3. RPC functions by area

**Where definitions live.** The **latest migration wins** (`supabase/migrations/0001…0340` on this branch, order in `MANIFEST`). Some older functions are defined only in the root `supabase/*.sql` phase files, for example `create_quote` (`supabase/quotes.sql`) and `admin_set_role_access` (`supabase/phase29-role-access.sql`). `supabase/PENDING-SQL-ALL.sql` bundles these.

**Who may call.** Unless the "Anon" column says otherwise, a function is granted to `authenticated` only. Inside, it checks `current_org_id()` and the caller's `has_area(...)` level, or `can_edit`.

Assumption: argument lists below are summarised. The exact signature is the last `create or replace function` in the migrations.

### 3.1 Public token links (anon-callable)
Grants verified with `grant … to anon` in the migrations.

| Function | Purpose | Inputs → output |
|---|---|---|
| `public_get_quote` | Client approval page: quote, lines and studio branding. Flags a stale approval (0052). | `p_token uuid` → jsonb |
| `public_quote_paid_status` | Paid versus total, from the `quote_payments` ledger (0098) | `p_token` → jsonb |
| `request_otp` | Simulated OTP. Stores a bcrypt hash and returns a dev code only off production. | `p_token, p_phone` → jsonb |
| `verify_and_consent` | Checks the OTP, records consent (terms version, consent text, name, user agent) and approves the quote | 8 args → jsonb |
| `wa_request_otp`, `wa_verify_and_consent` | Approval code over WhatsApp or email, sent to the contact **on the quote** (0151) | token, channel… → jsonb |
| `create_payment` | Simulated payment link. Refused on production hosts by the client. | `p_token` → jsonb |
| `trial_test_mode_for_token`, `trial_test_approve` | Trial-studio test approval with no SMS or email (0128) | token… → bool / jsonb |
| `public_get_booklet`, `public_get_booklet_image`, `public_booklet_packages`, `public_booklet_pay_terms`, `public_booklet_studio` | Client booklet: content, images (stored in the DB, 0083), package choices, payment terms | `p_token` → jsonb |
| `public_booklet_otp_request`, `public_booklet_choose` | Booklet package choice, confirmed by code (0069, re-wrapped in 0156) | token, package, guests, note, otp → jsonb |
| `public_get_portal`, `public_portal_extras` | Client portal | token → jsonb |
| `public_get_proposal` | Proposal view (`/<studio>/proposal/<token>`) | token → jsonb |
| `public_event_site`, `request_site_slug` | Public invitation website `/i/<slug>` (phase87) | slug → jsonb |
| `public_link_studio`, `public_link_opened` | Branding for a link, and "link opened" tracking that drives follow-ups (0078) | kind, token |
| `invitation_preview` | Invitation landing details before sign-in | token → jsonb |
| `worker_respond`, `worker_respond_evidence`, `worker_evidence_upload`, `worker_checkin_equipment`, `worker_assignment_updates` | Crew work link (`/<studio>/work/<token>`): accept or decline, proof photos, equipment check-in | `p_token, p_task_id, …` → jsonb |

Decision needed: some booklet functions (`public_booklet_choose`, `public_booklet_otp_request`) were re-wrapped in 0156. The visible re-grant is to `authenticated`. Confirm on staging that anonymous booklet visitors can still choose a package. Assumption: an earlier anon grant carries over, or the booklet page holds a session.

### 3.2 Session, profile, onboarding, trial

| Function | Purpose |
|---|---|
| `current_org_id`, `my_auth_info`, `my_profile`, `my_profile_status`, `complete_my_profile`, `update_my_profile`, `set_my_display_name`, `set_my_avatar` | Who am I, plus my profile |
| `password_change_required`, `clear_password_change_required` | Forced password change for temp-password users |
| `mfa_lock_status`, `mfa_record_failure`, `mfa_record_success`, `operator_mfa_required` | MFA lockout and enforcement |
| `is_platform_admin`, `is_platform_operator` | HQ flags |
| `create_studio`, `my_studio_route`, `set_studio_link_name`, `my_studio_account`, `my_studio_account_update` | Studio (org) creation, URL slug, account details |
| `start_trial`, `start_self_serve_trial`, `my_start_trial`, `my_pending_start_trial`, `my_trial_status`, `my_trial_access`, `my_trial_org`, `set_trial_mode`, `trial_demo_choice` | 8-day free trial (0120) |
| `my_checkout_options`, `my_checkout_preview`, `my_checkout_status`, `my_subscription`, `my_invoice`, `my_pending` | Subscription checkout and billing (studio → Helm) |
| `seed_demo_data`, `reset_demo_data`, `clear_demo_data`, `my_demo_status` | Demo data (guarded by 0097) |
| `my_getting_started`, `my_getting_started_dismiss`, `my_dashboard_prefs`, `save_dashboard_layout`, `save_desk_notes`, `recent_list`, `recent_touch`, `saved_view_set_default` | UI preferences |

### 3.3 Team, roles, invitations (mostly admin)

| Function | Purpose / who |
|---|---|
| `create_invitation(p_email, p_role)` | **Admin only** (0156). Per-studio caps (0155): trial 20 a day / 50 open; paid 200 a day / 500 open. |
| `resend_invitation_email`, `invitation_by_token`, `accept_invitation(token)` | Invite flow. Accepting does not change the role of someone already in that studio (0156). |
| `admin_create_user`, `admin_create_user_temp`, `admin_delete_user`, `admin_set_role`, `admin_set_display_name`, `admin_update_member_profile`, `staff_set_login_role` | Admin user management |
| `admin_get_role_access`, `admin_set_role_access` | Per-role access matrix that drives `has_area` |
| `member_profile_list`, `studio_avatars`, `audit_actor_names`, `staff_departments`, `staff_department_add` | Team directory |
| `admin_get_notification_prefs`, `admin_set_notification_pref`, `admin_reset_notification_prefs`, `my_notification_prefs`, `my_notification_mutes`, `set_notification_mute` | Notification preferences |
| `privacy_pin_status`, `privacy_pin_set`, `privacy_pin_check`, `privacy_pin_reset` | Privacy PIN that hides money tiles |
| `phone_verify_status`, `phone_verify_check` | Member phone verification (the code is sent by `send-phone-code`) |

### 3.4 Leads and nurture

| Function | Purpose |
|---|---|
| `convert_lead_to_quote` | Lead → quote (the quote **is** the event) |
| `restore_archived_lead`, `set_discovery`, `client_timeline`, `resolve_client_ref` | Lead and client housekeeping |
| `nurture_due`, `queue_nurture_greeting`, `run_nurture_auto` | Nurture follow-ups |
| `smart_import_batch` | CSV / smart import (0088) |
| `studio_search` | Global search |

### 3.5 Quotes / events (core lifecycle)

| Function | Purpose |
|---|---|
| `create_quote`, `start_blank_quote`, `discard_empty_drafts` | Create a quote. Empty drafts are cleaned up (0141). |
| `add_quote_version`, `save_quotation_version`, `rebrand_quote_code` | Versions and quote code |
| `confirm_quote(p_quote_id, p_client jsonb, p_pricing jsonb)` | Confirms pricing. The **server is the pricing authority** (D8, phase99; role gate 0144). |
| `get_pricing_config`, `set_pricing_config`, `get_item_rate_cards`, `set_item_rate_card`, `apply_menu_template`, `add_event_dish`, `remove_event_dish`, `set_event_dish_qty` | Pricing, menus, dishes |
| `generate_approval_token`, `reissue_approval_link`, `admin_get_link_autoexpire`, `admin_set_link_autoexpire`, `admin_get_link_expiry_shelf`, `admin_set_link_expiry_shelf`, `link_expiry_shelf_tick` | Approval links and their expiry (0039) |
| `move_quote_to_shelf`, `restore_quote_from_shelf`, `list_quote_shelf` | Shelf (archive) |
| `set_lifecycle_stage` | Stage move. Can raise `HL409` / `HL428` (0052). |
| `set_proposal`, `publish_proposal` | Proposal |
| `create_event_group`, `refresh_event_group`, `event_group_index`, `resolve_event_ref`, `event_activity`, `list_event_files` | Grouping and event lookups |
| `studio_template_save`, `studio_template_duplicate`, `studio_template_set_default`, `studio_template_set_archived` | Studio templates |
| `venue_save`, `venue_set_active`, `venue_load_samples` | Venues for the floor-plan builder |

### 3.6 Client approval, booklet, packages, event sites (staff side)

| Function | Purpose |
|---|---|
| `booklet_share`, `booklet_current`, `booklet_revoke`, `booklet_put_image`, `booklet_set_image_variants`, `booklet_set_snapshot`, `booklet_image_info`, `booklet_staff_image` | Build and share the client booklet (0069, 0083) |
| `pkg_settings_get`, `pkg_settings_set`, `pkg_selection_list`, `pkg_selection_review` | Menu packages and review of the client's choice |
| `create_event_site`, `publish_event_site`, `event_site_live_until` | Digital invitation sites (phase87) |
| `wa_proposal_prepare`, `wa_proposal_state` | "Send on WhatsApp" status (simulated / sent / delivered / read / failed) (0151) |
| `photo_render_settings_get`, `photo_render_settings_set`, `photo_render_list`, `photo_render_job`, `photo_render_image`, `photo_render_use_in_booklet` | AI photo renders (0095). Owner-triggered only. |

### 3.7 Planning, run sheet, crew, tasks

| Function | Purpose |
|---|---|
| `set_event_plan`, `set_plan_lock`, `set_plan_signoff` | Plan and sign-off |
| `design_get`, `design_queue`, `design_advance` | Designer queue |
| `assign_tasks`, `assign_tasks_vendor`, `reassign_task`, `set_task_schedule`, `set_task_special`, `verify_task`, `task_verify_summary`, `run_task_reminders`, `run_task_triggers` | Tasks and quality verification |
| `my_tasks`, `crew_event_brief`, `crew_task_respond`, `crew_schedule` | Crew self-service (signed-in). These are **not** anon (0153). |
| `runsheet_group_status`, `runsheet_post_to_group` | Run sheet posted to group chat |
| `event_reminder_settings_get`, `event_reminder_settings_set`, `event_reminder_upcoming` | Event-approaching reminders (0129) |

### 3.8 Inventory and equipment

| Function | Purpose |
|---|---|
| `reserve_inventory`, `return_reservation`, `adjust_inventory_total` | Atomic reservations (0071) |
| `checkout_availability`, `checkout_equipment`, `checkout_equipment_smart`, `cancel_checkout`, `checkin_equipment` | Equipment checkout and check-in (0072) |

### 3.9 Money: payments, settlement, closure

| Function | Purpose |
|---|---|
| `record_payment`, `mark_paid`, `settle_milestone`, `record_settlement_payment` | Record client payments on the `quote_payments` ledger. Approved or paid records are frozen (`money_frozen`). |
| `payment_reminder_send_now` | Queues a client payment reminder (outbox → `comms-dispatch`) |
| `record_vendor_payout`, `vendor_payables_summary` | Vendor bills and payouts (0124) |
| `close_event_blockers`, `close_event(uuid, boolean, text)`, `reopen_event(uuid, text)`, `set_closure` | Closure gate. Override and reopen are admin-only and need a reason. |
| `save_org_payment_account` | The studio's own Razorpay account (0117). Credentials are read server-side by `org_razorpay_creds`. |

### 3.10 Dashboards and insights

| Function | Purpose |
|---|---|
| `dashboard_money`, `dashboard_money_for`, `dashboard_due_today` | KPI tiles. `dashboard_money_for` is not anon. |
| `insights_range(date, date)`, `insights_events`, `insights_events_ex_tax`, `business_pnl(date, date)`, `event_pnl` | Per-currency totals (0094), P&L (0124) |
| `bell_feed`, `bell_mark_seen`, `mgr_notify` | In-app notification bell |

### 3.11 Team chat

`chat_directory`, `chat_start_dm`, `chat_create_group`, `chat_add_members`, `chat_ensure_broadcast`, `chat_send`, `chat_react`, `chat_mark_read`, `chat_set_pref`, `chat_my_mentions` (0016 onwards). The `client` role is excluded from staff chat (0156).

### 3.12 Integrations, comms settings, data export

| Function | Purpose |
|---|---|
| `integrations_overview`, `my_integration_accounts`, `set_org_integration_status`, `save_org_whatsapp_account` | Integrations page (Control Center view/edit) |
| `comms_settings_get`, `comms_settings_set`, `studio_email_settings_get`, `studio_email_settings_set`, `my_wa_forward_get`, `my_wa_forward_set` | Messaging settings: Reply-To studio email, WhatsApp forwarding |
| `export_org_data`, `export_tenant_organization_package` | Studio data export (admin). Supports data-portability requests. |
| `upload_scan_status` | Upload virus/type-scan state |

### 3.13 Service-role only (called by edge functions, never by the browser)

| Area | Functions |
|---|---|
| Payments | `payment_link_begin`, `payment_link_attach`, `payment_link_fail`, `razorpay_settle`, `razorpay_settle_for_org`, `razorpay_record_event`, `org_razorpay_creds`, `hq_settle_provider_payment`, `checkout_attach_subscription`, `my_checkout_prepare` (as caller) |
| OTP / phone | `admin_store_otp`, `otp_send_authorize`, `wa_otp_begin`, `phone_verify_request` |
| WhatsApp | `whatsapp_authorize`, `notify_allowed`, `wa_recipient_opted_out` (STOP list, 0155), `wa_proposal_mark` |
| Outboxes (claim → send → mark) | `comms_outbox_claim/mark/email_identity`, `pkg_outbox_claim/mark`, `invite_email_outbox_claim/mark`, `invite_email_kick_org` (as caller, from `invite-mailer`), `welcome_email_outbox_claim/mark`, `security_alert_outbox_claim/mark`, `trial_reminder_email_claim/mark`, `assign_notify_claim/mark` |
| Uploads / renders | `upload_scan_claim/mark`, `booklet_snapshot_path`, `photo_render_begin` |
| Limits | `rate_hit(bucket, key, window_s, max)` (0050), `_a154_hit` (0154) |
| Integrations test | `integrations_test_target` |

---

## 4. Edge functions (`supabase/functions/*/index.ts`)

All **25** functions declared in `supabase/config.toml`, in the same order: the 9 with `verify_jwt = true` first, then the 16 with `verify_jwt = false`. Each row was read from the function's `index.ts` header comment and its request-parsing code.

How to read the columns:
- **verify_jwt**: the value in `supabase/config.toml`. `true` = the Supabase gateway refuses a request without a valid JWT before the code runs (the anon key is a JWT too, so public pages pass). `false` = the gateway lets the request in and the code authenticates it.
- **Auth in code**: what the function itself enforces.
  - "getUser" = the caller's own access token is checked with `auth.getUser(jwt)`, and the anon key is refused with 401. The work then runs **as the caller** under RLS.
  - "Cron secret `<NAME>`" = the `x-helm-cron-secret` header, compared in constant time with that secret. An unset secret means every call gets 401.
  - "HMAC" = a provider signature over the raw body (section 6).
  - "Link token" = a token from a link, checked with the service role.
- Every function that a browser calls with `fetch` answers `OPTIONS` for CORS. Cron functions ignore the request body and take their work from the database.

| Function | Method | verify_jwt | Auth in code | Purpose | Main inputs | Default state |
|---|---|---|---|---|---|---|
| `create-payment-link` | POST | true | Gateway: anon JWT from the public approval page. In code: the approval token (UUID) is resolved with the service role (`quotes.approval_token`, `payment_link_begin`). No getUser. | Razorpay Payment Link for an **approved** quote. Uses the studio's own Razorpay account (0117, `org_razorpay_creds`), with Helm's keys as fallback unless `RAZORPAY_REQUIRE_STUDIO_ACCOUNT=1`. INR only (other currencies: 409 `currency_unsupported`). A free-trial studio gets 409 `code: "trial"`. | `{ token }` | Off: the app calls it only when `liveChannels.pay=true` (it is `false`). 503 "online payments are not configured" with no keys. |
| `create-subscription-checkout` | POST | true | getUser. Plan, price and Razorpay plan come from `my_checkout_prepare` run as the caller (admin gate, terms accepted). | Studio → Helm subscription through Razorpay Standard Checkout. The `verify` action checks the checkout signature for an early "payment received" message; it records no money. | `{ plan, interval: "monthly" \| "yearly" }`, or `{ action: "verify", razorpay_payment_id, razorpay_subscription_id, razorpay_signature }` | Dormant: 503 `{ dormant: true }` unless `HELM_RAZORPAY_SUBSCRIPTIONS_ENABLED=true` and both `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` are set. |
| `integrations-test` | POST | true | getUser. Then, as the caller: `integrations_overview` (Settings view), `integrations_test_target` (Settings edit), `integrations_wa_test_target` (studio admin, WhatsApp test). | Integrations page "Check status" (booleans only, never a key) and "Send test": an e-mail to the caller's own login address (shared mailer: Resend or SMTP, R154), or a WhatsApp to the studio's own saved number from the studio's connected number. | `{ action: "status" }` or `{ action: "test", channel: "email" \| "whatsapp" }` | Available. Kill switch `HELM_INTEGRATIONS_TEST_ENABLED=false` makes every test "simulated". WhatsApp tests are capped at `WA_TEST_PER_DAY` (default 5) per studio. |
| `wa-connect` | POST | true | getUser, then `wa_connect_org` as the caller (studio admin only). | R129 (0337): the Integrations page's buttons for the studio's **own** WhatsApp Business number. `verify` checks the phone number ID and WhatsApp Business Account (WABA) ID with Meta, records "connected" or "error", subscribes Helm's app to the account's webhooks, and refreshes template states. `templates` creates Helm's message templates in the studio's account. `status` refreshes template states. The token is read with the service role (`org_whatsapp_check_creds`) and is never returned or logged. | `{ action: "verify" \| "templates" \| "status" }` | Live wherever it is deployed. 409 `code: "details_missing"` until the studio saves its IDs AND token (`save_org_whatsapp_account`; R154h 0353: without a token it saves the two IDs only). R154h: every failed check answers `code` (token / permission / number / waba / not_in_account / limit / not_checked / timeout / other) - never a secret. 503 on a database without 0337. |
| `render-photo` | POST (plus an `OPTIONS` probe from the app) | true | getUser, then `photo_render_begin` as the caller (quotes edit + photo_render edit, renders switched on, hourly limit and monthly quota). | AI event photo from builder snapshots (OpenAI Images edits). Async: 202 `{ job_id }`, then the browser polls `photo_render_job`. Usage and cost are logged in `photo_render_usage` (0095). | `{ quote_id, prompt, n (1–4), quality, size, style, camera, theme, images: [{ mime, data }] (1–4, ≤ 2 MB each) }` | 503 `render_not_configured` until `OPENAI_API_KEY` is set. Owner-only: Claude never triggers renders. |
| `send-otp` | POST | true | Gateway: anon JWT from the public approval page. In code: the approval token (UUID) is checked with the service role (`otp_send_authorize`, `wa_otp_begin`, `admin_store_otp`). No getUser. | Client approval code, always to the phone or e-mail **on the quote**: SMS through MSG91, or (0151) WhatsApp from the studio's own connected number (template `proposal_approval_otp`) or e-mail through the shared mailer. A free-trial studio gets 403 `{ trial: true, test_mode: true }` (R113, 0322). A quote with no price gets 409 `not_priced` (R108). No connected WhatsApp number gets 409 `{ not_connected: true, fallback: "email" }`. | `{ token, phone }` (SMS) or `{ token, channel: "whatsapp" \| "email" }` | SMS path off (`liveChannels.sms=false`, so `request_otp` is used). WhatsApp and e-mail paths are called live (`liveChannels.whatsapp` / `.email` are `true`). E-mail answers `status: "not_configured"` (nothing sent) while no Resend or SMTP secret exists. |
| `send-phone-code` | POST | true | getUser. Banned logins are refused, and the account needs a confirmed e-mail or phone. | Member phone-verification code on WhatsApp from **Helm's own** number (0055). The code is minted by `phone_verify_request` (service role) and is never returned or logged. Spend caps `PHONE_CODE_*` (section 7). | `{ phone }` (E.164) | Off: 503 until `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_ID` are set, and the app calls it only when `liveChannels.whatsappHelm=true` (it is `false`). |
| `send-whatsapp` | POST | true | getUser. Then `whatsapp_authorize` and RLS as the caller; `{ ping: true }` also needs `has_area('controls', 'view')`. | Template WhatsApp about one event, from the studio's own connected number (R129). Templates must be on the `WHATSAPP_TEMPLATES` allowlist. Free text only with `WHATSAPP_ALLOW_TEXT=1`. STOP list, opt-in for unpaid studios, and distinct-recipient caps apply. A free-trial studio is refused. | `{ quote_id, number, template, lang, params[], kind }`, `{ quote_id, number, text }`, or `{ ping: true }` | No caller in `public/*.js` on this branch (only a comment in `callFn` mentions it). A studio with no connected number gets 409 `not_connected`. |
| `wa-proposal` | POST | true | getUser. The quote is read as the caller (RLS), and `wa_proposal_prepare` runs as the caller (quotes edit, number on the quote, opt-in, STOP, hourly cap). | "Send on WhatsApp" for proposals and payments (0151), from the studio's own connected number. | `{ quote_id, kind (proposal_sent \| proposal_reminder \| proposal_approved_pay \| payment_received), phone, opt_in, consent_text }` | Called live (`liveChannels.whatsapp=true`). No connected number: 409 `not_connected`. A free-trial studio runs the simulated path: `{ simulated: true, trial: true }`, nothing sent. |
| `captcha-verify` | POST | false | `sales`: getUser (anon key refused). `contact`, `enquiry`, `suggest`: public (the anon key is enough), with tighter per-IP limits. | Server-side Cloudflare Turnstile check for the paths Supabase Auth's CAPTCHA does not cover: checkout "Contact sales" (records a pass with `captcha_pass_record`, 0249) and the signed-out forms (a one-use 10-minute pass from `captcha_public_pass_record`, 0276). | `{ action: "sales" \| "contact" \| "enquiry" \| "suggest", token }` (4 KB cap) | Dormant: with no `TURNSTILE_SECRET_KEY` it answers `{ ok: true, configured: false }` (fail open; the database switch `rpc_captcha_required` must stay off). The browser skips it while `captcha.siteKey` is empty. Once configured: a refused token gets 403, and Cloudflare unreachable gets 503 (fail closed). |
| `client-mailer` | POST | false | getUser (anon key refused). Then `client_mailer_check` as the caller (quotes edit, own studio, r56 / 0297), and the quote is read as the caller (RLS). | "Send by email" from the quote flow: e-mails the client approval link or booklet link to the client e-mail **saved on the quote** (never taken from the request). The link must be live. Reply-To is the studio. | `{ quote_id, kind: "approval" \| "booklet" }` | Called live (`liveChannels.email=true`). Shared mailer: Resend, else SMTP, else `not_configured`. A free-trial studio gets `status: "test_mode"` with a preview of the e-mail, and nothing is sent (R114, 0323). |
| `invite-mailer` | POST | false | Either cron secret `HELM_INVITE_EMAIL_SECRET` (flushes every studio's queue), or getUser plus `invite_email_kick_org` as the caller (a studio admin; flushes that studio only). The `config.toml` comment names only the user JWT; the code accepts both. | Staff invitation e-mails from `invite_email_outbox` (0131, 0205). Branded e-mail through the shared mailer; with no provider, Supabase Auth's own invite or magic-link e-mail. | Body ignored | On. Kill switch `HELM_INVITE_EMAILS_ENABLED=false` gives 200 `{ status: "dormant" }`. |
| `invite-signup` | POST | false | Link token: the 48-hex invitation token is checked with the service role, the typed e-mail must equal `invitations.email`, and the e-mailed link's mail key `k` must match (R32). | The invitee creates an account and is signed in straight away. Also: `peek` (invitation details for the join page), `resend` (a new link to the invited address), and, with no token, `email_lookup` / `email_send` (0210). | `{ token, email, password, k }`, `{ token, peek: true }`, `{ token, resend: true }`, `{ email_lookup: true, email }`, `{ email_send: true, email }` | On. Kill switch `HELM_INVITE_DIRECT_SIGNUP=false` answers `{ fallback: true }` (normal confirm-by-e-mail sign-up). A studio whose trial ended gets 409 `trial_paused` (R121). |
| `booklet-snapshot` | GET `?t=<booklet token>&k=2d\|3d` | false | Link token: `booklet_snapshot_path` (service role) returns a path only for a live link whose checklist shows that section. | Legacy streaming of 2D / 3D booklet snapshots from the private bucket. Not needed since 0083 (pictures are stored in the database). | Query `t`, `k` | 404 unless `HELM_BOOKLET_SNAPSHOT_ENABLED=true`. |
| `email-unsubscribe` | GET, POST | false | Link token: the unsubscribe token (`UNSUB_TOKEN_RE`) is checked in the database by `email_unsub_status` / `email_unsub_set` (service role). | Opt-out for non-transactional e-mail (0165). GET only redirects (303) to `APP_URL/unsubscribe?t=…` and changes nothing, so link scanners cannot unsubscribe anyone. POST with `?t=` and the body `List-Unsubscribe=One-Click` is the RFC 8058 one-click from mail providers (plain-text 200). POST JSON comes from the `/unsubscribe` page. | `?t=<token>`; or JSON `{ t, action: "status" \| "unsubscribe" \| "resubscribe" }` (4 KB cap) | Always on (no flag). A malformed or forged token gets `{ ok: false }`. |
| `billing-reminder` | POST | false | Cron secret `HELM_BILLING_CRON_SECRET` | Helm subscription "due soon" / "past due" and trial reminder e-mails (`billing_reminders`), re-checked before every send (`billing_reminder_recheck`, 0327). Resend only. | Body ignored | Dormant unless `HELM_BILLING_REMINDERS_ENABLED=true`. |
| `comms-dispatch` | POST | false | Cron secret `HELM_COMMS_SECRET` | Everything in `comms_outbox` plus related claims: payment reminders, follow-ups, trial reminders and post-trial e-mails, WhatsApp copies of bell notifications, invitation-site and booklet links, quote-expiry, delivery / vendor-request / run-sheet reminders, enquiry replies, Helm notices, and welcome e-mails (0327 database switch). | Body ignored | Auto-on per channel: e-mail when `SMTP_*` (preferred) or `RESEND_API_KEY` exist; WhatsApp when the row's studio has connected its own number (else `skipped`). Kill switch `HELM_COMMS_ENABLED=false`. |
| `pkg-client-notify` | POST | false | Cron secret `HELM_PKG_NOTIFY_SECRET` | `pkg_outbox` (0069): package accepted or declined and the booklet confirmation code (client e-mail through Resend, or WhatsApp from the studio's own number), plus staff WhatsApp alerts. | Body ignored | Dormant unless `HELM_PKG_NOTIFY_ENABLED=true`. |
| `security-alert-mailer` | POST | false | Cron secret `HELM_SECURITY_ALERT_SECRET` | Security alert e-mails from `security_alert_outbox` (0054). Since 0250 every row is for Helm HQ (`HELM_SECURITY_ALERT_HQ_TO`), never for studio members. Resend only. | Body ignored | Dormant unless `HELM_SECURITY_ALERTS_ENABLED=true`. |
| `verify-upload` | POST | false | Cron / database-webhook secret `HELM_UPLOAD_SCAN_SECRET` (DB webhook on `storage.objects` INSERT) | Claims pending uploads (`upload_scan_claim`) and checks magic bytes against extension, type and bucket allowlist. Optional AV scan. Rejected files move to the `upload-quarantine` bucket; nothing is hard-deleted. | Body ignored (64 KB cap) | Dormant unless `HELM_UPLOAD_SCAN_ENABLED=true`. |
| `welcome-mailer` | POST | false | Cron secret `HELM_WELCOME_EMAIL_SECRET` | Welcome e-mails (`welcome_email_outbox`, 0057; trial versions R119 / 0327) through the shared mailer, SMTP first. Optional: `comms-dispatch` sends the same welcomes on its own schedule. | Body ignored | Dormant unless `HELM_WELCOME_EMAILS_ENABLED=true`. Even then nothing is claimed until the database switch `helm_welcome_mail_settings.enabled` (0327) is on. |
| `razorpay-webhook` | POST | false | HMAC: `X-Razorpay-Signature` with `RAZORPAY_WEBHOOK_SECRET`, or with the studio's own webhook secret when the URL has `?org=<uuid>` (0117) | Settles client → studio payments (`razorpay_settle` / `razorpay_settle_for_org`), records other events (`razorpay_record_event`) and e-mails receipts (Resend). | Raw Razorpay event body; optional `?org=` | Fails closed: no secret gives 401. Nothing reaches it while Razorpay is not set up. |
| `razorpay-subscription-webhook` | POST | false | HMAC with `RAZORPAY_SUBSCRIPTION_WEBHOOK_SECRET` | Settles Helm's own subscription charges (`hq_settle_provider_payment`) and activates the plan (0244). | Raw Razorpay event body | Dormant (200 "dormant") unless `HELM_RAZORPAY_SUBSCRIPTIONS_ENABLED=true`. Unset secret gives 401. |
| `wa-webhook` | GET (verify), POST (events) | false | GET: `hub.verify_token` must equal `WHATSAPP_WEBHOOK_VERIFY_TOKEN`. POST: HMAC `X-Hub-Signature-256` with `WHATSAPP_APP_SECRET`. | Delivery statuses (`wa_record_event`), STOP / START opt-outs (`wa_set_opt_out`), template status and number quality updates. R129: a template's new state is also saved for the studio with that WABA ID (`wa_template_status`). Message bodies are never stored. | GET `hub.mode`, `hub.verify_token`, `hub.challenge`; POST Meta event body | 404 until both secrets are set. |
| `csp-report` | POST | false | Public: browsers send reports with no auth. The content type must be a CSP report type (else 415). | Browser Content-Security-Policy violation reports. Each one becomes one redacted log line; nothing is stored. | CSP report JSON (16 KB cap) | On. Always answers 204. `HELM_CSP_REPORTS_ENABLED=false` still answers 204 but logs nothing. |

**Deploy note.** `supabase/config.toml` is the source of truth for `verify_jwt`: `supabase functions deploy <name>` reads it (r21), and `test/r21-security.test.mjs` fails if a function is missing from the file or a `false` function loses its check in code. Passing `--no-verify-jwt` on the command line **overrides** `config.toml` (found in the 2026-10-27 release-plan check). For the 16 `verify_jwt = false` functions that changes nothing. For the 9 `verify_jwt = true` functions (`create-payment-link`, `create-subscription-checkout`, `integrations-test`, `wa-connect`, `render-photo`, `send-otp`, `send-phone-code`, `send-whatsapp`, `wa-proposal`) it would switch the gateway JWT check off, so deploy those 9 without the flag. Older deploy commands in `docs/release/RELEASE-10xx-OWNER-STEPS.md` and `docs/project/DEPLOYMENT.md` show the flag per function, and the comment at the top of `config.toml` says passing it "anyway is harmless", which holds only for the `false` group. Assumption: the 9 `true` functions on production and staging still have the gateway JWT check on (not visible from code; check each function's JWT setting in the Supabase dashboard).

---

## 5. External APIs

| Provider | Used by | Endpoint | Notes |
|---|---|---|---|
| **Resend** (email API) | **Everything through the shared mailer** (`_shared/mailer.ts`, Resend or SMTP): `client-mailer`, `integrations-test` (the e-mail test and the status badge, R154), `send-otp` (e-mail code), `invite-mailer`, `invite-signup`, `comms-dispatch`, `welcome-mailer`, and since R154g `razorpay-webhook`, `pkg-client-notify`, `billing-reminder`, `security-alert-mailer` (no function calls Resend directly any more). | `POST https://api.resend.com/emails` | Needs `RESEND_API_KEY` + `RESEND_FROM` (or the SMTP_* secrets). No fallback sender (R154g): a missing / invalid `RESEND_FROM` counts as not set up, nothing is sent and the missing setting is logged. Only the address part of `RESEND_FROM` is used. Display name: `EMAIL_BRAND_MODE` on both transports (default "Helm Events"; `studio` gives "<Studio> via Helm Events", and `comms-dispatch` may use the studio's own sender name from the Integrations page, 0150). `razorpay-webhook` uses the paying studio's name, `billing-reminder` "Helm Billing", `security-alert-mailer` "Helm Security" (all three with a plain-text part since R154g). **Reply-To is the studio**: its own reply-to (0150), else its business e-mail, else the owner's e-mail (`_shared/reply-to.mjs`, R107; `studio_email_settings_*`, `comms_outbox_email_identity`), never Helm's own sending address. Outbox sends carry an `Idempotency-Key` (`comms-<id>`, `pkg-<id>`). With no provider nothing is marked `skipped` for it: `billing-reminder` / `security-alert-mailer` / `welcome-mailer` touch no row (`no_provider`, sent later), `comms-dispatch` does not claim its e-mail-only lanes and releases `comms_outbox` e-mail rows for retry, `pkg-client-notify` releases the row for retry, `razorpay-webhook` logs `simulated`. |
| **SMTP** (for example Gmail `smtp.gmail.com`, port 465, an App Password) | Shared mailer only: **preferred** by `comms-dispatch` and `welcome-mailer` (release 1018), the **fallback** when Resend is not set for `client-mailer`, `send-otp`, `invite-mailer` and `invite-signup` | `SMTP_HOST` : `SMTP_PORT` (default 465) | Built-in client `_shared/smtp.ts`, implicit TLS on 465 (Supabase blocks 25 and 587). Needs `SMTP_HOST` + `SMTP_USER` + `SMTP_PASS`; sender `SMTP_FROM` (default `SMTP_USER`). Same body, compliance footer and List-Unsubscribe headers as Resend. The direct-Resend functions above never use SMTP. |
| **Supabase Auth email / SMTP** | Sign-up, reset, magic link; the `invite-mailer` / `invite-signup` fallback when no edge e-mail provider is set | Supabase dashboard | Custom SMTP is needed for real volume (`docs/AUTH-DASHBOARD-SETTINGS.md`). Decision needed: confirm the Auth SMTP sender also uses notifications@helm.events. |
| **Meta WhatsApp Cloud API** | **The studio's own number:** `wa-proposal`, `send-otp` (WhatsApp code), `comms-dispatch`, `pkg-client-notify`, `send-whatsapp`, `integrations-test` (test), and `wa-connect` (set-up). **Helm's own number:** `send-phone-code` only. **Inbound:** `wa-webhook`. | `https://graph.facebook.com/<WHATSAPP_API_VERSION, default v21.0>/<phone number ID>/messages`. `wa-connect` also calls `<phone number ID>`, `<WABA ID>/phone_numbers`, `<WABA ID>/subscribed_apps` and `<WABA ID>/message_templates`. | R129 (0337): **one number per studio**. Each studio connects its own WhatsApp Business number on the Integrations page. Its token, phone number ID and WABA ID are saved with `save_org_whatsapp_account` and read only with the service role (`org_whatsapp_creds`, `org_whatsapp_check_creds`); the token is never returned or logged. `wa-connect` checks the number with Meta, subscribes Helm's app to the account's webhooks, and creates Helm's templates in the studio's account (`_shared/wa-studio.mjs`: `proposal_sent`, `proposal_reminder`, `proposal_approved_pay`, `payment_received`, `proposal_approval_otp`, `helm_notice`, `helm_task_assigned`, `helm_event_reminder`; Meta reviews each one). A studio with no connected number sends no WhatsApp (409 `not_connected`, or the row is `skipped`); there is **no fallback** to Helm's number. A token Meta refuses marks the studio's account "error" (the Integrations page shows "Needs attention"). Helm's own number (`WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`) sends only the staff phone-verification code and is off in the app (`liveChannels.whatsappHelm=false`). Opt-in and STOP are honoured. |
| **Razorpay** | `create-payment-link`, `create-subscription-checkout`, webhooks | `https://api.razorpay.com/v1/...` (Payment Links, Subscriptions) | Basic auth with key id and secret (the studio's own keys for Payment Links when connected, 0117). Card/UPI data never touches Helm (Razorpay-hosted page or modal). **Switched off** in the app (`liveChannels.pay=false`, `HELM_FEATURES.payNow=false`). |
| **MSG91** (SMS OTP) | `send-otp` | `POST https://control.msg91.com/api/v5/flow/` | DLT sender and template. Non-India numbers are refused unless `MSG91_INTL=1`. **Switched off** (`liveChannels.sms=false`). |
| **OpenAI Images** (photo render) | `render-photo` | `POST https://api.openai.com/v1/images/edits` | Timeout `RENDER_TIMEOUT_MS`, model `OPENAI_IMAGE_MODEL`. Per-studio usage in `photo_render_usage`. Claude never triggers renders. |
| **AV scanner** (optional) | `verify-upload` | `HELM_AV_URL` (host must be in `HELM_AV_ALLOWED_HOSTS`) | Bearer `HELM_AV_TOKEN`. Assumption: no scanner is configured in production. |
| **Cloudflare Turnstile** | Sign-in, sign-up and reset (verified by Supabase Auth's own CAPTCHA setting); checkout "Contact sales" and the signed-out forms (`/contact-sales` and the home page form, `/<studio>/enquiry`, `/suggest`) through `captcha-verify` | `POST https://challenges.cloudflare.com/turnstile/v0/siteverify` (from `captcha-verify`) | Off while `config.captcha.siteKey` is empty. `captcha-verify` needs `TURNSTILE_SECRET_KEY` (the same secret pasted into Supabase Attack Protection); `HELM_TURNSTILE_HOSTNAMES` is optional. With no secret it answers `{ ok: true, configured: false }`. Safe order of steps: `docs/security/OWNER-DASHBOARD-STEPS-R21.md` section D. |
| **Browser CSP reports** (inbound, not a provider) | `csp-report` | `report-uri` / `Reporting-Endpoints` on production pages (`vercel.json`, `public/_headers`, generated by `scripts/gen-csp.mjs`) | One redacted log line per violation (Supabase → Edge Functions → `csp-report` → Logs): directive and the shape of the blocked and page paths, never a query string, token, e-mail or IP. Nothing is stored. |
| **Sentry** (edge errors, optional) | Any function that answers 500 through `responders().serverError` (`_shared/cors.ts` → `_shared/sentry.mjs`) | The ingest host in `SENTRY_DSN` (only a `sentry.io` ingest host is accepted) | Off unless `SENTRY_DSN` is set. An event carries only the function name, the error tag and the environment (`SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`). |

---

## 6. Webhooks and signature verification

| Webhook | Verification | Replay / safety |
|---|---|---|
| `razorpay-webhook` | `HMAC-SHA256(RAZORPAY_WEBHOOK_SECRET, rawBody)` compared in constant time with `X-Razorpay-Signature`. A malformed `?org=` gives 401 (per-studio accounts, 0117). | Settles through `razorpay_settle` / `razorpay_settle_for_org`, which are idempotent on the provider payment id. Events are logged by `razorpay_record_event`. Assumption: duplicate deliveries are no-ops at the DB level. |
| `razorpay-subscription-webhook` | Same scheme with `RAZORPAY_SUBSCRIPTION_WEBHOOK_SECRET`. Unset secret gives 401. | Events older than `RAZORPAY_EVENT_MAX_AGE_SEC` are rejected |
| `create-subscription-checkout` `verify` | `HMAC(key_secret, payment_id + "|" + subscription_id)`, constant time; the subscription must belong to the caller's studio | Only for an early "payment received" message. The webhook stays the source of truth. |
| `wa-webhook` | GET: `hub.verify_token` matched in constant time, and the challenge must be `[A-Za-z0-9_-]{1,200}`. POST: `"sha256=" + HMAC(WHATSAPP_APP_SECRET, rawBody)` compared with `X-Hub-Signature-256`. | 404 until both secrets exist. R129: delivery ticks and STOP replies for a studio's own number reach Helm only once `wa-connect` has subscribed that WhatsApp account to Helm's app (best effort). There is one `WHATSAPP_APP_SECRET` for all of them. Always 200 after a valid signature (Meta retries non-2xx); DB errors give 500. |
| `email-unsubscribe` one-click (RFC 8058) | Not a signature header: the token in `?t=` is checked in the database (`email_unsub_set`, service role). A malformed or forged token gets `{ ok: false }`. | A GET never changes anything (303 to the `/unsubscribe` page), so link scanners and previews cannot unsubscribe anyone. |
| Cron / DB webhooks | `x-helm-cron-secret` compared in constant time (`secretMatches`). Unset secret means every call gets 401. | The body is ignored. Work is **claimed from the DB**, so a caller cannot choose a bucket or path. |

---

## 7. Rate limiting

- **Edge functions** (`_shared/limits.ts` `checkLimits`):
  - First an in-memory fixed window per isolate. Keys are hashed, so no raw IP, phone or token is held.
  - Then the durable `rate_hit(bucket, key, window_s, max)` limit, shared across isolates.
  - `HELM_DURABLE_RATE_LIMIT=on|off` (default on).
  - `HELM_RATE_LIMIT_FAIL_CLOSED` (r21): by default a DB error is a 429 (fail **closed**). The one exception is a database without `rate_hit` (migration 0050 missing): that fails open with a loud log line. `false` = fail open (the in-memory limit still applies). `true` = strict (closed even when `rate_hit` is missing).
  - Responses are 429 with `Retry-After`.
- **Database limits:**
  - OTP attempts and expiry (`admin_store_otp`, `request_otp`).
  - Per-studio WhatsApp quota (`whatsapp_authorize`).
  - Invitation caps (0155).
  - MFA lockout (0050).
  - Public-link hit limiter `_a154_hit` (0154).
- **Phone codes** (`send-phone-code`): `PHONE_CODE_GLOBAL_PER_DAY` (default 2000), `PHONE_CODE_ORG_PER_DAY` (default 50), `PHONE_CODE_HOME_CC` (default `91,971`), `PHONE_CODE_HOME_COUNTRY_PER_DAY` (default 1500), `PHONE_CODE_COUNTRY_PER_DAY` (default 100, other countries), optional allowlist `PHONE_CODE_ALLOWED_CC`.
- **WhatsApp sends** (`send-whatsapp`): `WHATSAPP_DISTINCT_PER_DAY_PAID` (default 200 distinct numbers), `WHATSAPP_DISTINCT_PER_DAY_UNPAID` (default 3 new numbers), `WHATSAPP_UNPAID_PER_DAY` (default 60). Integrations WhatsApp tests: `WA_TEST_PER_DAY` (default 5 per studio).
- **Public edge endpoints:** `captcha-verify` 20 a minute per IP, and for signed-out actions also 10 per 10 minutes per IP and 600 a minute overall. `email-unsubscribe` 30 a minute per IP. `csp-report` 30 a minute per IP (over the limit, reports are dropped quietly with 204).
- **Supabase Auth:** dashboard rate limits (see `docs/AUTH-DASHBOARD-SETTINGS.md`).
- **`server.js` `/api/*`:** per-client limit returning 429 (dev only).

---

## 8. Pagination and filtering

- **List pages** use `async function sbPage(query, o)` in `store-api.js`, called as `sbPage(query, {limit, offset})`.
  - Page size is `config.pageSize`, default 25, clamped between 5 and 200. A caller limit is capped at 500.
  - The query fetches `limit + 1` rows, so `hasMore` needs no COUNT. `total` is returned only when `{count:"exact"}` was asked for.
- **Full lists** use `sbAll(build)`. It walks `.range()` in 1000-row chunks up to 20,000 rows. Beyond that the result is flagged `truncated = true` and a warning is logged; rows are never cut silently. The query must be ordered with a unique tie-breaker such as `id`.
- **Search:** `likeTerm` / `orIlike` escape `\ % _`, drop `*`, cap the term at 100 characters, and double-quote values inside `or=(…)`.
- **Ranges:** money and insight functions take `(date, date)`, for example `insights_range` and `business_pnl`.
- **Tenant filter:** applied by RLS and `current_org_id()`, never by the client.

---

## 9. `server.js` (local only)

`server.js` is a zero-dependency Node dev server. It serves `public/` (or the folder in `HELM_PUBLIC_DIR`; `HELM_PUBLIC_DIR=dist` serves the minified build locally) with the same security headers as `vercel.json` (`test/headers-parity.test.mjs`), plus a legacy layouts API that writes to `data/layouts.json`:

- `GET /api/health`
- `GET` / `POST /api/layouts`
- `GET` / `PUT` / `DELETE /api/layouts/:id`

It binds to `127.0.0.1` by default. Non-loopback use needs `LAYOUTS_API_TOKEN`. It sends no CORS headers. It is **not deployed**.

Production is static Vercel. `vercel.json` sets `installCommand` (installs the pinned minifiers in `tools/build`), `buildCommand: node scripts/build-dist.mjs` and `outputDirectory: dist`. R131: `dist/` is a minified copy of `public/` (JavaScript through terser, CSS through clean-css, HTML copied unchanged so the CSP hashes stay valid, no source maps; a file that cannot be parsed stops the build). `public/` stays the readable source in git, for tests, the local server and reviews. Clean-URL rewrites map `/<studio>/quote|proposal|portal|work|invite/<token>`, `/i/<slug>` and the `/<studio>/<page>` app routes to their pages.

Env: `PORT` (default 4173), `HOST` (default `127.0.0.1`), `LAYOUTS_API_TOKEN`, `HELM_PUBLIC_DIR`, `TRUST_PROXY=1` (trust `X-Forwarded-For` for the rate limit), `HELM_TRUSTED_TYPES=report` (Trusted Types report-only header).

---

## 10. Required environment variable / secret NAMES

Supabase injects these automatically: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.

| Group | Names |
|---|---|
| App | `APP_URL` (prod `https://www.helm.events`), `APP_ORIGIN` (read before `APP_URL` by `client-mailer` and the shared mailer), `ALLOWED_ORIGINS`, `EXTRA_ALLOWED_ORIGINS`, `ALLOW_LOCALHOST` |
| Email: Resend | `RESEND_API_KEY`, `RESEND_FROM` |
| Email: SMTP (shared mailer) | `SMTP_HOST`, `SMTP_PORT` (default 465), `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` (default `SMTP_USER`) |
| Email: wording and compliance | `EMAIL_BRAND_MODE` (`helm` default, or `studio`), `HELM_POSTAL_ADDRESS` (postal address in the footer), `UNSUB_MAILTO` (List-Unsubscribe mailto, default unsubscribe@helm.events), `MANAGER_EMAIL`, `HELM_SECURITY_ALERT_HQ_TO` |
| WhatsApp: studio numbers (R129) | **No secrets.** Each studio's token, phone number ID and WABA ID are saved in the database (`save_org_whatsapp_account`) and read only with the service role. Shared setting: `WHATSAPP_API_VERSION` (default `v21.0`). |
| WhatsApp: Helm's own number (`send-phone-code` only) | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_VERIFY_TEMPLATE` (default `phone_verification`), `WHATSAPP_VERIFY_LANG` (default `en_US`) |
| WhatsApp: webhook (Helm's Meta app) | `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` |
| WhatsApp: send rules (`send-whatsapp`) | `WHATSAPP_TEMPLATES`, `WHATSAPP_ALLOW_TEXT`, `WHATSAPP_REQUIRE_OPTIN`, `WHATSAPP_DISTINCT_PER_DAY_PAID`, `WHATSAPP_DISTINCT_PER_DAY_UNPAID`, `WHATSAPP_UNPAID_PER_DAY`; `WA_TEST_PER_DAY` (`integrations-test`) |
| WhatsApp: legacy names | `COMMS_WHATSAPP_TEMPLATE`, `WHATSAPP_TPL_TASK_ASSIGNED`, `WHATSAPP_TPL_EVENT_REMINDER`, `WHATSAPP_TPL_LANG` are still read by old helpers (`waContent` in `comms-dispatch`, `channelStatus` / `waTestContent` in `integrations-test/logic.mjs`) but not by the R129 send path, which uses the templates in `_shared/wa-studio.mjs`. `PKG_WHATSAPP_TEMPLATE` is no longer read by any function. |
| Razorpay | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_SUBSCRIPTION_WEBHOOK_SECRET`, `RAZORPAY_REQUIRE_STUDIO_ACCOUNT`, `RAZORPAY_EVENT_MAX_AGE_SEC`, `PAYMENT_LINK_TTL_MINUTES`, `HELM_RAZORPAY_SUBSCRIPTIONS_ENABLED` |
| SMS | `MSG91_AUTHKEY`, `MSG91_SENDER`, `MSG91_OTP_TEMPLATE_ID`, `MSG91_INTL` |
| Turnstile (`captcha-verify`) | `TURNSTILE_SECRET_KEY`, `HELM_TURNSTILE_HOSTNAMES` (optional) |
| Cron secrets and flags | `HELM_COMMS_SECRET` / `HELM_COMMS_ENABLED`, `HELM_PKG_NOTIFY_SECRET` / `HELM_PKG_NOTIFY_ENABLED`, `HELM_INVITE_EMAIL_SECRET` / `HELM_INVITE_EMAILS_ENABLED`, `HELM_WELCOME_EMAIL_SECRET` / `HELM_WELCOME_EMAILS_ENABLED`, `HELM_SECURITY_ALERT_SECRET` / `HELM_SECURITY_ALERTS_ENABLED`, `HELM_BILLING_CRON_SECRET` / `HELM_BILLING_REMINDERS_ENABLED`, `HELM_UPLOAD_SCAN_SECRET` / `HELM_UPLOAD_SCAN_ENABLED` |
| Other flags and kill switches | `HELM_INVITE_DIRECT_SIGNUP` (`false` = off), `HELM_BOOKLET_SNAPSHOT_ENABLED`, `HELM_CSP_REPORTS_ENABLED` (`false` = off), `HELM_INTEGRATIONS_TEST_ENABLED` (`false` = tests simulated) |
| Batch sizes | `COMMS_BATCH`, `PKG_NOTIFY_BATCH`, `INVITE_EMAIL_BATCH`, `WELCOME_EMAIL_BATCH`, `SECURITY_ALERT_BATCH`, `BILLING_REMINDER_BATCH`, `UPLOAD_SCAN_BATCH` |
| Uploads / AV | `HELM_AV_URL`, `HELM_AV_TOKEN`, `HELM_AV_ALLOWED_HOSTS`, `HELM_AV_TIMEOUT_MS`, `HELM_UPLOAD_QUARANTINE` |
| Render | `OPENAI_API_KEY`, `OPENAI_IMAGE_MODEL`, `RENDER_TIMEOUT_MS`, `RENDER_COST_USD_<QUALITY>` (the code asks for `MEDIUM` or `HIGH`) |
| Rate limits | `HELM_DURABLE_RATE_LIMIT`, `HELM_RATE_LIMIT_FAIL_CLOSED`, `PHONE_CODE_GLOBAL_PER_DAY`, `PHONE_CODE_ORG_PER_DAY`, `PHONE_CODE_HOME_CC`, `PHONE_CODE_HOME_COUNTRY_PER_DAY`, `PHONE_CODE_COUNTRY_PER_DAY`, `PHONE_CODE_ALLOWED_CC` |
| Monitoring (edge) | `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE` |
| Frontend (public, `public/config.js`) | `url`, `anonKey` (public), `liveChannels.{sms,pay,whatsapp,whatsappHelm,email}`, `captcha.siteKey` (the public Turnstile site key; never the secret), `onboarding.allowPaymentBypass` (off on helm.events), `pageSize` (optional, default 25), `window.HELM_FEATURES` (for example `integrationsPage`, `payNow`). Staging uses `config.staging.js`. |

Decision needed: the README example shows `RESEND_FROM` with `events@helm.events`, but the owner fact is **notifications@helm.events**. Set `RESEND_FROM` to the notifications address on both prod and staging.

---

## 11. Privacy and failure handling

**Privacy**
- No secret reaches the browser: provider keys exist only as edge-function secrets. `integrations-test` returns booleans, never keys.
- A studio's own WhatsApp token (R129) is stored in the database, read only with the service role (`org_whatsapp_creds`, `org_whatsapp_check_creds`), sent only to `graph.facebook.com`, and never returned or logged.
- Messages go only to contacts **on file**: the phone or email on the quote, the caller's own login email, the studio's own number. A caller cannot redirect them.
- A studio's client and crew WhatsApp messages go out from **that studio's own number**. Helm's own number is used only for the staff phone-verification code.
- WhatsApp needs opt-in (stored with its consent text). STOP replies are honoured both at claim time and immediately before each send (0155).
- Free trial: for a trial studio, `client-mailer` shows a preview instead of sending (`test_mode`), `wa-proposal` runs the simulated path, `send-otp` answers test mode, `send-whatsapp` refuses, and `create-payment-link` refuses (0179, 0187, R113, R114). `comms-dispatch` sends a trial row only if it is a link e-mail the database marked as allowed (0212, `trial-row.mjs`); everything else from a trial is skipped.
- `csp-report` stores nothing and logs only the shape of the blocked and page paths. `captcha-verify` and `email-unsubscribe` never log the token, the address, the secret or an IP.
- `MANAGER_EMAIL` copies contain **no tenant data**. Studio receipts go to `organizations.business_email`.
- Rate-limit keys are hashed, and log lines carry no IP, key or phone.
- Consent records (terms version, consent text, user agent, timestamp) are kept for approvals. See `docs/DATA-PROTECTION-REVIEW.md` and `docs/INDIA-AUDIT-2026-10.md`.
- Card and UPI data are handled only by Razorpay (PCI-DSS).
- Data export is available through `export_org_data` / `export_tenant_organization_package`.

**Failure handling**
- **Fail closed:** a missing secret means 401 or 404, and a missing RPC means the call is refused. One deliberate exception: `captcha-verify` with no `TURNSTILE_SECRET_KEY` answers `configured: false` (fail open), so the database switch `rpc_captcha_required` must stay off until the secret is set. Once configured, it fails closed (403 / 503).
- **Dormant by default:** flags plus `liveChannels`, with a simulated path so the app works without providers. A live channel with no provider secret answers "not configured" or marks rows `skipped`. A studio with no connected WhatsApp number gets `not_connected`; `send-otp` then offers e-mail (`fallback: "email"`).
- **Outbox pattern:** DB rows are claimed, sent, then marked `sent`, `failed` or `skipped`, with idempotency keys. A failed provider call does not lose the record.
- **Payments:** the webhook is the source of truth. Settlement RPCs are idempotent, and money records freeze after approval or payment.
- **Rate limiter:** fails closed by default since r21 (`HELM_RATE_LIMIT_FAIL_CLOSED=false` turns that off).
- **UI:** shows `friendlyError` text only.
- Monitoring and incident steps: `docs/OBSERVABILITY-ACTIVATION.md`, `docs/INCIDENT-RESPONSE-RUNBOOK.md`, `docs/DISASTER-RECOVERY-RUNBOOK.md`.

Decisions needed:
- (a) When to flip `liveChannels.pay`, `.sms` and `.whatsappHelm`, and the matching server flags. (`.whatsapp` and `.email` are already `true`.)
- (b) Whether to set `HELM_RATE_LIMIT_FAIL_CLOSED=true` on production.
- (c) Whether to enable the welcome, security-alert, billing-reminder and upload-scan crons. Each needs its secret and a scheduler.
- (d) Whether to remove the legacy `booklet-snapshot` function.
- (e) When to set `TURNSTILE_SECRET_KEY` and `config.captcha.siteKey`, in the safe order in `docs/security/OWNER-DASHBOARD-STEPS-R21.md` section D.
- (f) Whether to correct the `supabase/config.toml` header comment that says passing `--no-verify-jwt` is harmless (section 4 deploy note).
