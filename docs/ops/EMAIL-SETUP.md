# Email in Helm (owner guide)

Plain English. In the app the same guide is on **/<studio>/integrations → Email invites**.

## What is e-mailed today
| E-mail | Sent by | Turned on by |
|---|---|---|
| Staff invitation ("<Admin> invited you to join <Studio> on Helm as <Role>" + Join button) | edge function `invite-mailer` (migration 0131) | deploy + it is ON by default |
| Welcome, security alerts, billing reminders | `comms-dispatch` (welcome lane) / `welcome-mailer`, `security-alert-mailer`, `billing-reminder` | see `supabase/functions/README.md` + "Schedules for the mailers" below |
| Package choice / booklet code to clients, payment receipts | `pkg-client-notify`, `razorpay-webhook` | see `supabase/functions/README.md` |
| Payment reminders / follow-ups to clients | `comms-dispatch` (0078) | studio switches in Control Center → Notifications |

The studio never copies the invite link any more: Helm e-mails it within ~2 minutes. **Copy link** stays as
a backup and **Resend email** re-sends (max once per 10 minutes per invite).

## Who it comes from
- **Now (no Resend account):** leave `RESEND_API_KEY` unset. `invite-mailer` sends through **Supabase Auth's own
  mailer** (new address → "Invite user" e-mail, existing account → "Magic link"). Both land on
  `<APP_URL>/login?invite=<token>`. Supabase's built-in mailer is limited to a few e-mails per hour, so for real
  use set **custom SMTP**: Supabase → Authentication → SMTP Settings → e.g. Google Workspace (`smtp.gmail.com`,
  port 465, the account + an **app password**). Then e-mails come from that account.
- **Later (branded):** Resend with your own domain → `Helm <hello@helm.events>`. Set the key and it switches
  automatically; nothing else changes.

Sending "from the studio admin's own Gmail" is not possible without that person's mailbox password, so Helm sends
from one Helm address and names the studio + admin inside the e-mail.

## Steps (staging `xizehqgeyjcfpzrdymly` first, then production `nqltzgiwznphugcfhmbm`)
1. SQL editor: paste `supabase/APPLY-0131.sql`. Every check row must be `true` (re-check any time with
   `supabase/VERIFY-0131.sql`). Optional, for the status card: `supabase/APPLY-0134.sql`.
2. Supabase → Authentication → URL Configuration → Redirect URLs: add `https://www.helm.events/login*`
   (staging: your staging site + `/login*`).
3. Deploy:
   ```bash
   supabase functions deploy invite-mailer --no-verify-jwt --project-ref <ref>
   ```
4. Secrets:
   ```bash
   supabase secrets set --project-ref <ref> \
     HELM_INVITE_EMAIL_SECRET="$(openssl rand -hex 32)" \
     APP_URL="https://www.helm.events"
   # later, branded e-mail (shared with the other mailers):
   #   RESEND_API_KEY="re_..."  RESEND_FROM="Helm <hello@helm.events>"
   ```
5. Safety-net schedule (the Staff page also flushes right after an invite), every 2 minutes:
   ```sql
   select cron.schedule('invite-mailer', '*/2 * * * *', $$
     select net.http_post('https://<ref>.supabase.co/functions/v1/invite-mailer',
       '{}'::jsonb, '{}'::jsonb, jsonb_build_object('x-helm-cron-secret', '<the secret>'), 15000) $$);
   ```
6. Test: invite your own second address from Control Center → User control. Then
   `select status, count(*) from public.invite_email_outbox group by 1;` → one `sent` row.

## Studio sender name + reply-to + Send test (0150)
1. SQL editor: paste `supabase/APPLY-0150.sql` (every VERIFY row `true`). It adds two optional columns to
   `comms_settings` (`email_from_name`, `email_reply_to`; NULL = unchanged behaviour) - no row is changed.
2. Deploy: `supabase functions deploy comms-dispatch --no-verify-jwt --project-ref <ref>` (reads the two settings)
   and `supabase functions deploy integrations-test --project-ref <ref>` (status + Send test).
3. Integrations page → Email card: set **Sender name** and **Reply-to e-mail**, Save, **Send test e-mail to me**.
   - **Simulated**: no e-mail provider is set (neither `RESEND_API_KEY` + `RESEND_FROM` nor `SMTP_HOST` + `SMTP_USER` + `SMTP_PASS`);
     the result shows the From / Reply-to it would use. Nothing is sent. (R154: before, SMTP-only also read Simulated.)
   - **Live**: sent through the shared mailer (Resend first, else SMTP) to the signed-in admin's OWN login address (never an address from the page).
   - Changing the **Reply-to** needs two-step sign-in on the admin's account (0285); the Sender name alone does not.
   Client e-mails then go out as `"<Sender name>" <address in RESEND_FROM>` with `Reply-To: <reply-to>`.
   The sending ADDRESS is always Helm's verified domain (RESEND_FROM); only the display name and reply-to are per studio.

## Resend (when you want branded e-mail)
1. resend.com → sign up → **Domains → Add domain** `helm.events`.
2. Add the DNS records it shows (SPF `TXT`, DKIM `CNAME`/`TXT`, optional DMARC) at your DNS provider; wait for
   **Verified**.
3. **API Keys → Create** (Sending access). Copy once → `RESEND_API_KEY`.
4. `RESEND_FROM="Helm <hello@helm.events>"`.

## One mailer, no fallback sender (R154g)
Every Helm e-mail now goes through the shared mailer `supabase/functions/_shared/mailer.ts` (Resend when
`RESEND_API_KEY` + `RESEND_FROM` are set, else SMTP with `SMTP_HOST` + `SMTP_USER` + `SMTP_PASS`): `client-mailer`,
`send-otp`, `invite-mailer`, `integrations-test`, `welcome-mailer`, `comms-dispatch`, and since R154g also
`billing-reminder`, `security-alert-mailer`, `pkg-client-notify` and `razorpay-webhook` (they used to call Resend
directly and silently did nothing on an SMTP-only setup).
- **No fallback sender.** The old `onboarding@resend.dev` default is gone. `RESEND_API_KEY` without a valid
  `RESEND_FROM` (or SMTP without `SMTP_FROM` / an address in `SMTP_USER`) counts as *not set up*: nothing is sent and
  the log says which setting is missing (names only, never a value).
- **No provider is not a skip.** `billing-reminder` leaves reminders unsent and `security-alert-mailer` claims nothing
  (answer `{"status":"no_provider"}`) - both send once e-mail is set up. `pkg-client-notify` releases the e-mail row for a
  later try (`retry`; the database gives up after 8 tries with backoff, so set e-mail up promptly). `razorpay-webhook`
  logs the receipt as `simulated` (the payment itself is always settled).
- **Display name** follows `EMAIL_BRAND_MODE` on both transports (default "Helm Events"; `studio` -> the studio's sender
  name or "<Studio> via Helm Events"). Billing / security / payment mails keep "Helm Billing" / "Helm Security" / the
  paying studio's name, and now carry a plain-text part next to the HTML.

## Schedules for the mailers (cron) - owner choice, never created by a migration
No migration creates the sender schedules (each needs its own secret and the owner's choice of frequency). Check what
exists with the READ-ONLY query `supabase/CHECK-EMAIL-CRONS.sql` (one row per job; never shows the command text). A
function whose `calls_...` column is `false` in every row has no schedule. Add only the ones you want, staging first:

1. Store the function's secret in Vault once (SQL editor; use the SAME value you set with `supabase secrets set`):
   ```sql
   select vault.create_secret('<the secret value>', '<vault name from the table>');
   ```
2. Create the job (replace `<ref>`, `<job name>`, `<schedule>`, `<function>`, `<vault name>`):
   ```sql
   select cron.schedule('<job name>', '<schedule>', $$
     select net.http_post(
       url := 'https://<ref>.supabase.co/functions/v1/<function>',
       headers := jsonb_build_object('Content-Type', 'application/json',
         'x-helm-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = '<vault name>')),
       body := '{}'::jsonb,
       timeout_milliseconds := 15000);
   $$);
   ```
3. Re-run `supabase/CHECK-EMAIL-CRONS.sql`: the new row is `active = true`, its `calls_...` column `true`,
   `secret_from_vault = true`.

| Function | Secret (`supabase secrets set`) | Vault name (suggested) | Job name | Suggested schedule | Also needs |
|---|---|---|---|---|---|
| `comms-dispatch` | `HELM_COMMS_SECRET` | `helm_comms_secret` | `helm_comms_dispatch` | `*/5 * * * *` | runs unless `HELM_COMMS_ENABLED=false` |
| `invite-mailer` | `HELM_INVITE_EMAIL_SECRET` | `helm_invite_email_secret` | `invite-mailer` | `*/2 * * * *` | the Staff page also flushes right after an invite |
| `billing-reminder` | `HELM_BILLING_CRON_SECRET` | `helm_billing_cron_secret` | `helm_billing_reminder` | `15 * * * *` (hourly) | `HELM_BILLING_REMINDERS_ENABLED=true`, 0327 applied |
| `security-alert-mailer` | `HELM_SECURITY_ALERT_SECRET` | `helm_security_alert_secret` | `helm_security_alerts` | `*/5 * * * *` | `HELM_SECURITY_ALERTS_ENABLED=true`, `HELM_SECURITY_ALERT_HQ_TO` |
| `pkg-client-notify` | `HELM_PKG_NOTIFY_SECRET` | `helm_pkg_notify_secret` | `helm_pkg_notify` | `*/2 * * * *` (codes expire in 10 min) | `HELM_PKG_NOTIFY_ENABLED=true` |
| `welcome-mailer` (optional) | `HELM_WELCOME_EMAIL_SECRET` | `helm_welcome_email_secret` | `helm_welcome_mailer` | `*/10 * * * *` | `HELM_WELCOME_EMAILS_ENABLED=true`; not needed while `comms-dispatch` runs |

To pause a job: `select cron.alter_job(<jobid>, active := false);` (jobid from the check query). Nothing is deleted.

## If something is wrong
- Status card says **Simulated** → rows were marked `skipped`: function not deployed, or SMTP/Resend not set (or
  `RESEND_FROM` / `SMTP_FROM` missing - there is no fallback sender).
- A mailer never runs → `supabase/CHECK-EMAIL-CRONS.sql` (read only) shows whether a cron job calls it.
- Nothing in the outbox → 0131 not applied (or the invite was created before 0131: press Resend email).
- Emergency stop: `supabase secrets set HELM_INVITE_EMAILS_ENABLED=false --project-ref <ref>`. No data is touched.
- Logs never contain addresses or tokens.
