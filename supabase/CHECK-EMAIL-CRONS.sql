-- CHECK-EMAIL-CRONS.sql (R154g) - READ ONLY. Paste in the Supabase SQL editor (staging, then production).
-- One SELECT on cron.job. It changes nothing and never shows the job command text (a command can carry a secret).
-- One row per scheduled job: its name, schedule, whether it is active, and true / false per e-mail function
-- telling whether the job command calls that function.
-- How to read it: a function whose column is false in EVERY row has no cron job yet - add one with the
-- templates in docs/ops/EMAIL-SETUP.md (section Schedules for the mailers). A job with active = false does not run.
-- welcome-mailer is optional (comms-dispatch already sends the welcome e-mails).
-- Error relation cron.job does not exist = pg_cron is not enabled (Database, Extensions, pg_cron), so no job runs.
select j.jobid,
       j.jobname,
       j.schedule,
       j.active,
       position('comms-dispatch' in j.command) > 0        as calls_comms_dispatch,
       position('invite-mailer' in j.command) > 0         as calls_invite_mailer,
       position('billing-reminder' in j.command) > 0      as calls_billing_reminder,
       position('security-alert-mailer' in j.command) > 0 as calls_security_alert_mailer,
       position('pkg-client-notify' in j.command) > 0     as calls_pkg_client_notify,
       position('welcome-mailer' in j.command) > 0        as calls_welcome_mailer,
       position('vault.decrypted_secrets' in j.command) > 0            as secret_from_vault
  from cron.job j
 order by j.jobname;
