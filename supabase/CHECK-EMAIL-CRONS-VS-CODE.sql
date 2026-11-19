-- CHECK-EMAIL-CRONS-VS-CODE.sql (R236) - READ ONLY. Paste in the Supabase SQL editor (staging, then production).
-- Compares the LIVE e-mail sender cron jobs with what the code (migration 0402) describes. Works before and after
-- APPLY-0402. It changes nothing and never shows a job's command text or any secret value (only Vault secret NAMES).
--
-- One row per mailer job. How to read it:
--   verdict = 'same as code'        the job runs the code command (select public.ops_kick_mailer('<function>'))
--             'yours (kept)'        a hand-made job with this name - 0402 never changes it. Fine while it works; to switch
--                                   it to the code version (reads the secret from Vault by name, fails loudly when it is
--                                   missing) run, by hand:  select public.ops_mailer_cron_adopt('<job>');
--             'other job calls it'  no job with this name, but another job already calls this function
--             'MISSING'             no job calls this function: APPLY-0402 creates it once the Vault secret is there
--   schedule_same_as_code / active / calls_the_function / secret_from_vault: true is what you want
--   secret_written_in_job = true means the command itself contains a secret header without Vault - rotate that secret
--   vault_secret_present: the Vault secret NAME exists (value never shown)
--   last_run / last_status: from the job history (cron.job_run_details, kept 7 days)
-- helm_billing_reminder and helm_welcome_mailer are optional (billing reminders are dormant by owner decision;
-- comms-dispatch already sends the welcome e-mails), so MISSING is fine for those two.
-- Error "relation cron.job does not exist" = pg_cron is not enabled (Database, Extensions), so no job runs at all.
with code(job, fn, schedule, vault_secret, optional) as (values
    ('helm_comms_dispatch',   'comms-dispatch',        '*/5 * * * *',  'helm_comms_secret',          false),
    ('invite-mailer',         'invite-mailer',         '*/2 * * * *',  'helm_invite_email_secret',   false),
    ('helm_security_alerts',  'security-alert-mailer', '*/5 * * * *',  'helm_security_alert_secret', false),
    ('helm_pkg_notify',       'pkg-client-notify',     '*/2 * * * *',  'helm_pkg_notify_secret',     false),
    ('helm_billing_reminder', 'billing-reminder',      '15 * * * *',   'helm_billing_cron_secret',   true),
    ('helm_welcome_mailer',   'welcome-mailer',        '*/10 * * * *', 'helm_welcome_email_secret',  true)
),
live as (
  select c.job, c.fn, c.schedule as code_schedule, c.vault_secret, c.optional,
         j.jobid, j.schedule as live_schedule, j.active,
         lower(btrim(regexp_replace(regexp_replace(coalesce(j.command, ''), '\s+', ' ', 'g'), ';\s*$', '')))
           = 'select public.ops_kick_mailer(' || quote_literal(c.fn) || ')' as is_code,
         position('/functions/v1/' || c.fn in coalesce(j.command, '')) > 0
           or position('ops_kick_mailer(' || quote_literal(c.fn) || ')' in coalesce(j.command, '')) > 0 as calls_fn,
         position('vault.decrypted_secrets' in coalesce(j.command, '')) > 0 as reads_vault,
         position('x-helm-cron-secret' in coalesce(j.command, '')) > 0 as has_secret_header,
         (select string_agg(o.jobname, ', ' order by o.jobname) from cron.job o
           where o.jobname <> c.job and (position('/functions/v1/' || c.fn in o.command) > 0
                                         or position('ops_kick_mailer(' || quote_literal(c.fn) || ')' in o.command) > 0)) as other_jobs
    from code c left join cron.job j on j.jobname = c.job
)
select l.job,
       l.fn as edge_function,
       case when l.jobid is not null and l.is_code then 'same as code'
            when l.jobid is not null then 'yours (kept)'
            when l.other_jobs is not null then 'other job calls it'
            when l.optional then 'MISSING (optional)'
            else 'MISSING' end as verdict,
       l.code_schedule,
       l.live_schedule,
       (l.live_schedule = l.code_schedule) as schedule_same_as_code,
       l.active,
       (l.is_code or l.calls_fn) as calls_the_function,
       (l.is_code or l.reads_vault) as secret_from_vault,
       (l.jobid is not null and not l.is_code and l.has_secret_header and not l.reads_vault) as secret_written_in_job,
       l.other_jobs,
       l.vault_secret,
       exists (select 1 from vault.secrets s where s.name = l.vault_secret) as vault_secret_present,
       exists (select 1 from vault.secrets s where s.name in ('helm_functions_base_url', 'helm_wa_worker_url')) as functions_address_in_vault,
       (select max(d.start_time) from cron.job_run_details d where d.jobid = l.jobid) as last_run,
       (select d.status from cron.job_run_details d where d.jobid = l.jobid order by d.start_time desc limit 1) as last_status
  from live l
 order by l.optional, l.job;
