-- r143-outbox-backoff-0342.sql - R143: a failed send waits before it is tried again (1 / 2 / 4 / 8 / 16 / 30 / 60 minutes,
-- small jitter), the claim skips a row that is still waiting, the give-up point is 8 tries instead of 5, the old expiry
-- rules and the 10 minute lease are unchanged, codes / task / run-sheet / delivery reminders keep today's behaviour, and
-- a late or replayed WhatsApp START can never undo a newer STOP (newest message wins, a duplicate event is ignored).
-- Proves: (1) structure, privileges, kept bodies; (2) the schedule; (3) claim skips a waiting row, takes it after;
-- (4) the cap on every queue (7 tries -> still alive, 8 -> failed; package codes still 5); (5) expiry unchanged; (6) the
-- time-sensitive queues unchanged; (7) a resend starts fresh; (8) the test switch = the old behaviour; (9) the send
-- window still holds a retry; (10) STOP / START ordering + replay; (11) re-apply changes nothing. Local disposable PG only.
-- Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0342_r143_outbox_backoff.sql
\ir ../../supabase/migrations/0342_r143_outbox_backoff.sql
set client_min_messages = warning;
begin;
set local helm.retry_backoff = 'on';   -- run-all.sh switches the backoff off for the older suites
set local helm.send_window = 'off';
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;
create temp table _kv(k text primary key, v text); grant all on _kv to anon, authenticated, service_role;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_detail, '<null>') end); end $$;
grant execute on function pg_temp.t(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform set_config('request.jwt.claims', '', false); end $$;
create or replace function pg_temp.svc() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"service_role"}', false); perform set_config('role', 'service_role', false); end $$;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _kv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _kv where k = p_k $$;
-- the seconds a row waits: between base and base + 10 percent (jitter), lease = next try - 10 minutes
create or replace function pg_temp.waits(p_table text, p_id uuid, p_min integer) returns text language plpgsql as $$
declare v_lease text := (public._r342_queue_cols(p_table))[1]; v_next timestamptz; v_cl timestamptz; s numeric;
begin
  execute format('select next_attempt_at, %I from public.%I where id = $1', v_lease, p_table) into v_next, v_cl using p_id;
  s := extract(epoch from v_next - now());
  if v_next is null then return 'no next_attempt_at'; end if;
  if s < p_min * 60 - 0.01 or s > p_min * 66 + 0.01 then return 'waits ' || s || ' s, expected ' || p_min || ' min + <= 10 pct'; end if;
  if v_cl is distinct from v_next - interval '10 minutes' then return 'lease ' || coalesce(v_cl::text, 'null') || ' next ' || v_next::text; end if;
  return 'ok';
end $$;
-- "the waiting time is over" (the transaction clock cannot move): next try + lease moved into the past
create or replace function pg_temp.time_passes(p_table text, p_id uuid) returns void language plpgsql as $$
declare v_lease text := (public._r342_queue_cols(p_table))[1];
begin
  execute format('update public.%I set next_attempt_at = now() - interval ''1 second'', %I = now() - interval ''10 minutes 1 second'' where id = $1',
                 p_table, v_lease) using p_id;
end $$;
create or replace function pg_temp.in_claim(p_claim jsonb, p_id uuid) returns boolean language sql as $$
  select exists (select 1 from jsonb_array_elements(coalesce(p_claim, '[]'::jsonb)) e where e ->> 'id' = p_id::text) $$;

-- ---- 1) structure ----------------------------------------------------------------------------------------------------
do $$ declare q text[] := array['comms_outbox', 'pkg_outbox', 'security_alert_outbox', 'welcome_email_outbox', 'invite_email_outbox',
                                 'trial_reminders', 'trial_retention_notices', 'assign_notify_outbox', 'helm_notice_outbox',
                                 'vendor_request_sends', 'lead_enquiries'];
  slow text[] := array['task_wa_outbox', 'runsheet_reminder_sends', 'delivery_reminder_sends'];
  claims text[] := array['public.comms_outbox_claim__pre0155(integer)', 'public.comms_outbox_claim__pre0200(integer)',
    'public.comms_outbox_claim__pre0261(integer)', 'public.comms_outbox_claim__pre0262(integer)', 'public._qv262_claim(integer)',
    'public.pkg_outbox_claim__pre0155(integer)', 'public.security_alert_outbox_claim(integer)', 'public.welcome_email_outbox_claim(integer)',
    'public.invite_email_outbox_claim__pre0155(integer, uuid)', 'public.trial_reminder_email_claim(integer)',
    'public.trial_retention_email_claim(integer)', 'public.trial_followup_email_claim(integer)', 'public.assign_notify_claim__pre0283(integer)',
    'public.helm_notice_outbox_claim(integer)', 'public.vendor_request_claim(integer, text)', 'public.enquiry_reply_claim(integer)'];
  f text; bad text := ''; v_pre text; n integer;
begin
  perform pg_temp.su();
  select string_agg(t, ',') into bad from unnest(q) t
   where not exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = t
                       and c.column_name = 'next_attempt_at' and c.data_type = 'timestamp with time zone' and c.is_nullable = 'YES');
  perform pg_temp.t('1a next_attempt_at (nullable) on the 11 message queues', bad is null, bad);
  select string_agg(t, ',') into bad from unnest(q) t
   where not exists (select 1 from pg_trigger g where g.tgrelid = ('public.' || t)::regclass and g.tgname = 'zz_r342_backoff' and not g.tgisinternal
                       and pg_get_triggerdef(g.oid) like '%BEFORE UPDATE OF ' || (public._r342_queue_cols(t))[1] || ' ON public.' || t || ' FOR EACH ROW%');
  perform pg_temp.t('1b one backoff trigger per queue, only on a lease change (BEFORE UPDATE OF the claim lease)', bad is null, bad);
  perform pg_temp.t('1c task reminders / run-sheet / delivery reminders: no backoff column, no trigger (they keep their clock time)',
    not exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = any (slow) and c.column_name = 'next_attempt_at')
    and not exists (select 1 from pg_trigger g where g.tgname = 'zz_r342_backoff' and g.tgrelid::regclass::text = any (slow)));
  bad := '';
  foreach f in array claims loop
    if position('attempts >= 5' in (select prosrc from pg_proc where oid = to_regprocedure(f))) > 0
       or position('_r342_max_attempts(' in (select prosrc from pg_proc where oid = to_regprocedure(f))) = 0 then bad := bad || f || ' '; end if;
  end loop;
  perform pg_temp.t('1d the 16 live claim steps give up at _r342_max_attempts (8), none still at 5', bad = '', bad);
  bad := '';
  foreach f in array claims || array['public.wa_set_opt_out(text, text, boolean)'] loop
    v_pre := regexp_replace(f, '\(', '__pre0342(');
    if to_regprocedure(v_pre) is null then bad := bad || 'missing ' || v_pre || ' '; continue; end if;
    if has_function_privilege('anon', v_pre, 'execute') or has_function_privilege('authenticated', v_pre, 'execute')
       or has_function_privilege('service_role', v_pre, 'execute') then bad := bad || 'callable ' || v_pre || ' '; end if;
    if (select prosecdef from pg_proc where oid = to_regprocedure(v_pre)) is distinct from (select prosecdef from pg_proc where oid = to_regprocedure(f))
       or (select proconfig from pg_proc where oid = to_regprocedure(v_pre)) is distinct from (select proconfig from pg_proc where oid = to_regprocedure(f))
       or (select pg_get_function_arguments(oid) from pg_proc where oid = to_regprocedure(v_pre)) is distinct from (select pg_get_function_arguments(oid) from pg_proc where oid = to_regprocedure(f))
       or (select prorettype from pg_proc where oid = to_regprocedure(v_pre)) is distinct from (select prorettype from pg_proc where oid = to_regprocedure(f))
    then bad := bad || 'shape ' || f || ' '; end if;
  end loop;
  perform pg_temp.t('1e the 17 previous bodies kept once as __pre0342 (same arguments / definer / search_path), no privilege for anon, authenticated or service_role', bad = '', bad);
  bad := '';
  foreach f in array claims loop
    if f like 'public.wa_set%' then continue; end if;
    if position('attempts >= 5' in (select prosrc from pg_proc where oid = to_regprocedure(regexp_replace(f, '\(', '__pre0342(')))) = 0 then bad := bad || f || ' '; end if;
  end loop;
  perform pg_temp.t('1f each kept body is the old one (still gives up at 5)', bad = '', bad);
  perform pg_temp.t('1g the outward claims keep their grants (service role yes, app no)',
    has_function_privilege('service_role', 'public.comms_outbox_claim(integer)', 'execute')
    and not has_function_privilege('authenticated', 'public.comms_outbox_claim(integer)', 'execute')
    and has_function_privilege('service_role', 'public.enquiry_reply_claim(integer)', 'execute')
    and not has_function_privilege('anon', 'public.vendor_request_claim(integer, text)', 'execute')
    and has_function_privilege('service_role', 'public.comms_outbox_claim__pre0155(integer)', 'execute'));
  perform pg_temp.t('1h the helpers are not callable from the app (the copy helper and trigger not even by the service role)',
    not has_function_privilege('anon', 'public._r342_backoff(integer)', 'execute')
    and not has_function_privilege('authenticated', 'public._r342_max_attempts(text)', 'execute')
    and not has_function_privilege('authenticated', 'public._r342_queue_cols(text)', 'execute')
    and not has_function_privilege('service_role', 'public._r342_keep(text)', 'execute')
    and not has_function_privilege('authenticated', 'public._r342_keep(text)', 'execute')
    and not has_function_privilege('service_role', 'public._r342_tg_backoff()', 'execute'));
  perform pg_temp.t('1i task / run-sheet / delivery claims untouched (still 5 tries, no 0342 helper)',
    position('attempts >= 5' in (select prosrc from pg_proc where oid = to_regprocedure('public.task_wa_claim(integer)'))) > 0
    and position('attempts >= 5' in (select prosrc from pg_proc where oid = to_regprocedure('public.runsheet_reminder_claim__pre0283(integer)'))) > 0
    and position('attempts >= 5' in (select prosrc from pg_proc where oid = to_regprocedure('public.delivery_reminder_claim(integer)'))) > 0
    and to_regprocedure('public.task_wa_claim__pre0342(integer)') is null and to_regprocedure('public.delivery_reminder_claim__pre0342(integer)') is null);
  select count(*) into n from pg_proc where proname like '%\_\_pre0342' escape '\';
  perform pg_temp.t('1j 17 kept copies (16 claim steps + the 3-argument wa_set_opt_out), plus the outer comms claim only where it carries its own cap',
    n = 17 + case when to_regprocedure('public.comms_outbox_claim__pre0342(integer)') is null then 0 else 1 end, n::text);
  perform pg_temp.t('1k no live step of the client message chain still gives up at 5',
    not exists (select 1 from pg_proc where proname like 'comms\_outbox\_claim%' escape '\' and proname not like '%\_\_pre0342' escape '\'
                  and position('attempts >= 5' in prosrc) > 0)
    and position('attempts >= 5' in (select prosrc from pg_proc where oid = to_regprocedure('public._qv262_claim(integer)'))) = 0);
end $$;

-- ---- 2) the schedule (comms_outbox, retry after try 1 .. 8) --------------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; v_id uuid := 'a0000000-0000-4000-8000-000000034201';
  mins integer[] := array[1, 2, 4, 8, 16, 30, 60, 60]; k integer; bad text := ''; w text;
begin
  perform pg_temp.su();
  insert into public.comms_outbox(id, org_id, quote_id, purpose, channel, recipient, payload, dedupe_key)
    values (v_id, a, 'a0000000-0000-4000-8000-00000000da01', 'follow_up', 'email', 'r143.sched@example.test', '{"stage":"fu1"}', 'r143:sched');
  for k in 1 .. 8 loop
    perform pg_temp.su();
    update public.comms_outbox set claimed_at = now(), attempts = k where id = v_id;   -- the claim of try k
    perform pg_temp.svc();
    perform public.comms_outbox_mark(v_id, 'retry');                                   -- the send failed
    perform pg_temp.su();
    w := pg_temp.waits('comms_outbox', v_id, mins[k]);
    if w <> 'ok' then bad := bad || 'try ' || k || ': ' || w || ' / '; end if;
  end loop;
  perform pg_temp.t('2a after try 1..8 the row waits 1, 2, 4, 8, 16, 30, 60, 60 minutes (+ at most 10 pct), lease = next try - 10 min', bad = '', bad);
  perform pg_temp.t('2b a waiting row is still pending, unsent, nothing else changed',
    exists (select 1 from public.comms_outbox where id = v_id and status = 'pending' and sent_at is null and attempts = 8
              and recipient = 'r143.sched@example.test' and payload = '{"stage":"fu1"}'::jsonb));
  perform pg_temp.t('2c the backoff helper: 1 2 4 8 16 30 60 60 minutes, never shorter, jitter at most 10 pct',
    (select bool_and(extract(epoch from public._r342_backoff(i)) between m * 60 and m * 66)
       from (values (0, 1), (1, 1), (2, 2), (3, 4), (4, 8), (5, 16), (6, 30), (7, 60), (8, 60), (40, 60)) v(i, m)));
  perform pg_temp.t('2d give-up point: 8 tries (package codes 5)', public._r342_max_attempts() = 8 and public._r342_max_attempts('pkg_otp') = 5
    and public._r342_max_attempts('pkg_selected') = 8);
  -- the total waiting window covers a multi-hour outage
  perform pg_temp.t('2e total wait before giving up = 1+2+4+8+16+30+60 = 121 minutes (plus the sender runs)',
    (select sum(m) from unnest(mins[1:7]) m) = 121);
end $$;

-- ---- 3) the claim skips a waiting row and takes it once the wait is over -------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; s uuid := 'a0000000-0000-4000-8000-000000034202';
  p uuid := 'a0000000-0000-4000-8000-000000034203'; c uuid := 'a0000000-0000-4000-8000-000000034204'; r jsonb; r2 jsonb;
begin
  perform pg_temp.su();
  insert into public.security_alert_outbox(id, alert_type, org_id) values (s, 'mfa_disabled', a);
  insert into public.pkg_outbox(id, org_id, quote_id, audience, channel, kind, recipient, dedupe_key)
    values (p, a, 'a0000000-0000-4000-8000-00000000da01', 'client', 'email', 'pkg_selected', 'r143.pkg@example.test', 'r143:pkg1');
  perform pg_temp.svc();
  r := public.security_alert_outbox_claim(100);
  perform public.security_alert_outbox_mark(s, 'retry');
  r2 := public.security_alert_outbox_claim(100);
  perform pg_temp.su();
  perform pg_temp.t('3a security alert: the first claim hands it out', pg_temp.in_claim(r, s), r::text);
  perform pg_temp.t('3b right after the failure the claim skips it (still pending, the try not counted again)',
    not pg_temp.in_claim(r2, s) and exists (select 1 from public.security_alert_outbox where id = s and status = 'pending' and attempts = 1 and sent_at is null)
    and pg_temp.waits('security_alert_outbox', s, 1) = 'ok', r2::text);
  perform pg_temp.time_passes('security_alert_outbox', s);
  perform pg_temp.svc();
  r := public.security_alert_outbox_claim(100);
  perform pg_temp.su();
  perform pg_temp.t('3c once the wait is over it is claimed again (try 2)', pg_temp.in_claim(r, s)
    and exists (select 1 from public.security_alert_outbox where id = s and attempts = 2), r::text);
  -- the package queue (0155 wrapper + 0069 core)
  perform pg_temp.svc();
  r := public.pkg_outbox_claim(100);
  perform public.pkg_outbox_mark(p, 'retry');
  r2 := public.pkg_outbox_claim(100);
  perform pg_temp.su();
  perform pg_temp.t('3d package e-mail: claimed, failed, then waits 1 minute and the claim skips it meanwhile',
    pg_temp.in_claim(r, p) and not pg_temp.in_claim(r2, p) and pg_temp.waits('pkg_outbox', p, 1) = 'ok'
    and exists (select 1 from public.pkg_outbox where id = p and status = 'pending' and attempts = 1), r::text || ' / ' || r2::text);
  perform pg_temp.time_passes('pkg_outbox', p);
  perform pg_temp.svc();
  r := public.pkg_outbox_claim(100);
  perform pg_temp.su();
  perform pg_temp.t('3e package e-mail: claimed again after the wait', pg_temp.in_claim(r, p), r::text);
  -- the client message chain: a waiting row is neither handed out nor re-checked (so never skipped while it waits)
  insert into public.comms_outbox(id, org_id, quote_id, purpose, channel, recipient, payload, dedupe_key, attempts, claimed_at)
    values (c, a, 'a0000000-0000-4000-8000-00000000da01', 'follow_up', 'email', 'r143.chain@example.test', '{"stage":"fu1"}', 'r143:chain', 1, now());
  perform pg_temp.svc();
  perform public.comms_outbox_mark(c, 'retry');
  r := public.comms_outbox_claim(100);
  perform pg_temp.su();
  perform pg_temp.t('3f client message chain: a waiting row is skipped by every claim step (still pending, unsent, try 1)',
    not pg_temp.in_claim(r, c) and exists (select 1 from public.comms_outbox where id = c and status = 'pending' and sent_at is null and attempts = 1),
    coalesce(r::text, '') || ' ' || (select status || '/' || attempts from public.comms_outbox where id = c));
  perform pg_temp.time_passes('comms_outbox', c);
  perform pg_temp.svc();
  r := public.comms_outbox_claim(100);
  perform pg_temp.su();
  perform pg_temp.t('3g ... and after the wait the claim looks at it again (re-checked as before: automatic follow-ups are off here -> skipped)',
    exists (select 1 from public.comms_outbox where id = c and status = 'skipped' and attempts = 1), (select status || '/' || attempts from public.comms_outbox where id = c));
end $$;

-- ---- 4) the give-up point on every queue: 7 tries -> still alive, 8 -> failed ---------------------------------------
create temp table _cap(tbl text, id uuid, start integer);
create or replace function pg_temp.st(p_tbl text, p_id uuid) returns text language plpgsql as $$
declare v_s text; v_n integer;
begin
  execute format('select %I, %I from public.%I where id = $1',
    case when p_tbl in ('trial_reminders', 'trial_retention_notices') then 'email_status' when p_tbl = 'lead_enquiries' then 'reply_status' else 'status' end,
    (public._r342_queue_cols(p_tbl))[2], p_tbl) into v_s, v_n using p_id;
  return coalesce(v_s, '?') || '/' || coalesce(v_n::text, '?');
end $$;
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; q uuid := 'a0000000-0000-4000-8000-00000000da01';
  v_lead uuid; v_req uuid; v_u uuid; p text; t integer; v_id uuid; bad text := ''; n integer; r record;
begin
  perform pg_temp.su();
  insert into public.vendor_requests(org_id, quote_id, vendor_name, what, when_at, agreed_amount, respond_by)
    values (a, q, 'R143 Vendor', 'Chairs', now() + interval '5 days', 1000, now() + interval '2 days') returning id into v_req;
  insert into public.leads(org_id, name) values (a, 'R143 Lead') returning id into v_lead;
  foreach t in array array[7, 8] loop
    -- the client message chain: core (follow_up), invitation site, booklet, nudge, quote expiry
    foreach p in array array['core', 'invite_site', 'booklet_link', 'nudge', 'quote_expiry'] loop
      insert into public.comms_outbox(org_id, quote_id, purpose, channel, recipient, payload, dedupe_key, attempts)
        values (a, q, case when p in ('core', 'nudge') then 'follow_up' else p end, 'email', 'r143.cap@example.test',
                case when p = 'nudge' then '{"r23":"nudge","stage":"nudge"}'::jsonb else '{"stage":"fu1"}'::jsonb end,
                'r143:cap:' || p || ':' || t, t) returning id into v_id;
      insert into _cap values ('comms_outbox', v_id, t);
    end loop;
    insert into public.pkg_outbox(org_id, quote_id, audience, channel, kind, recipient, dedupe_key, attempts)
      values (a, q, 'client', 'email', 'pkg_selected', 'r143.cap@example.test', 'r143:cap:pkg:' || t, t) returning id into v_id;
    insert into _cap values ('pkg_outbox', v_id, t);
    insert into public.security_alert_outbox(alert_type, org_id, attempts) values ('mfa_disabled', a, t) returning id into v_id;
    insert into _cap values ('security_alert_outbox', v_id, t);
    v_u := auth.seed_user('r143.w' || t || '@a.test');
    insert into public.welcome_email_outbox(user_id, org_id, kind, email, attempts, created_at)
      values (v_u, a, 'member', 'r143.w' || t || '@a.test', t, now() - interval '1 hour') returning id into v_id;
    insert into _cap values ('welcome_email_outbox', v_id, t);
    insert into public.invitations(org_id, email, role) values (a, 'r143.i' || t || '@example.test', 'sales');
    update public.invite_email_outbox set attempts = t where email = 'r143.i' || t || '@example.test' returning id into v_id;
    insert into _cap values ('invite_email_outbox', v_id, t);
    insert into public.trial_reminders(org_id, milestone, trial_ends_at, dedupe_key, email_attempts)
      values (a, case when t = 7 then 'd5' else 'd7' end, now() + interval '2 days', 'r143:cap:tr:' || t, t) returning id into v_id;
    insert into _cap values ('trial_reminders', v_id, t);
    insert into public.trial_retention_notices(org_id, kind, expired_at, dedupe_key, email_attempts)
      values (a, 'x7', now() - interval '7 days', 'r143:cap:x7:' || t, t) returning id into v_id;
    insert into _cap values ('trial_retention_notices', v_id, t);
    insert into public.trial_retention_notices(org_id, kind, expired_at, dedupe_key, email_attempts)
      values (a, 'x0', now() - interval '1 day', 'r143:cap:x0:' || t, t) returning id into v_id;
    insert into _cap values ('trial_retention_notices', v_id, t);
    insert into public.assign_notify_outbox(org_id, quote_id, item_kind, item_id, phone, body, attempts, updated_at)
      values (a, q, 'task', gen_random_uuid(), '91980003420' || t, 'r143 cap ' || t, t, now() - interval '5 minutes') returning id into v_id;
    insert into _cap values ('assign_notify_outbox', v_id, t);
    insert into public.helm_notice_outbox(kind, org_id, payload, dedupe_key, attempts)
      values ('inbox_digest', a, '{"mode":"instant_important","ids":[]}', 'r143:cap:hn:' || t, t) returning id into v_id;
    insert into _cap values ('helm_notice_outbox', v_id, t);
    insert into public.vendor_request_sends(org_id, request_id, kind, channel, recipient, dedupe_key, attempts)
      values (a, v_req, 'request', 'email', 'r143.v@example.test', 'r143:cap:v:' || t, t) returning id into v_id;
    insert into _cap values ('vendor_request_sends', v_id, t);
    insert into public.lead_enquiries(org_id, lead_id, attempts) values (a, v_lead, t) returning id into v_id;
    insert into _cap values ('lead_enquiries', v_id, t);
  end loop;
  insert into public.pkg_outbox(org_id, quote_id, audience, channel, kind, recipient, dedupe_key, attempts) values
    (a, q, 'client', 'email', 'pkg_otp', 'r143.cap@example.test', 'r143:cap:otp:4', 4),
    (a, q, 'client', 'email', 'pkg_otp', 'r143.cap@example.test', 'r143:cap:otp:5', 5);
  perform pg_temp.svc();
  perform public.comms_outbox_claim(100);
  perform public.pkg_outbox_claim(100);
  perform public.security_alert_outbox_claim(100);
  perform public.welcome_email_outbox_claim(100);
  perform public.invite_email_outbox_claim(100, null);
  perform public.trial_reminder_email_claim(100);
  perform public.trial_followup_email_claim(100);      -- first: its own sweep for x0 / x2 / x14
  perform public.trial_retention_email_claim(100);
  perform public.assign_notify_claim(100);
  perform public.helm_notice_outbox_claim(100);
  perform public.vendor_request_claim(100, 'email');
  perform public.enquiry_reply_claim(100);
  perform pg_temp.su();
  select count(*) into n from _cap;
  -- a row may be handed out a last time (its 8th try) or closed by its re-check, but never given up before 8 tries
  for r in select c.tbl, c.id, c.start, pg_temp.st(c.tbl, c.id) s from _cap c loop
    if split_part(r.s, '/', 1) = 'failed' and split_part(r.s, '/', 2)::integer < 8 then bad := bad || r.tbl || ' ' || r.s || ' '; end if;
  end loop;
  perform pg_temp.t('4a no queue gives up on a row with fewer than 8 tries (16 claim steps, 11 queues)', bad = '' and n = 32, bad || ' rows ' || n);
  bad := '';
  for r in select c.tbl, c.id, pg_temp.st(c.tbl, c.id) s from _cap c where c.start = 8 loop
    if split_part(r.s, '/', 1) <> 'failed' then bad := bad || r.tbl || ' ' || r.s || ' '; end if;
  end loop;
  perform pg_temp.t('4b after 8 tries every queue gives up (failed, kept): the 5 client message steps and the 10 other queues', bad = '', bad);
  perform pg_temp.t('4c package codes keep the 5-try rule (5 -> failed, 4 -> still alive)',
    (select status from public.pkg_outbox where dedupe_key = 'r143:cap:otp:5') = 'failed'
    and (select status from public.pkg_outbox where dedupe_key = 'r143:cap:otp:4') <> 'failed');
  perform pg_temp.t('4d failed rows are kept (nothing deleted)',
    (select count(*) from _cap c where pg_temp.st(c.tbl, c.id) not like '?%') = 32);
end $$;

-- ---- 5) expiry rules unchanged, also for a row that is waiting -----------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; q uuid := 'a0000000-0000-4000-8000-00000000da01'; v_u uuid;
begin
  perform pg_temp.su();
  insert into public.comms_outbox(id, org_id, quote_id, purpose, channel, recipient, payload, dedupe_key, attempts, claimed_at, created_at)
    values ('a0000000-0000-4000-8000-000000034251', a, q, 'follow_up', 'email', 'r143.old@example.test', '{"stage":"fu1"}', 'r143:exp:3d', 2, now(), now() - interval '3 days 1 minute');
  insert into public.trial_reminders(id, org_id, milestone, trial_ends_at, dedupe_key, email_attempts, email_claimed_at, created_at)
    values ('a0000000-0000-4000-8000-000000034252', a, 'd5', now() + interval '2 days', 'r143:exp:tr', 2, now(), now() - interval '2 days 1 minute');
  v_u := auth.seed_user('r143.exp@a.test');
  insert into public.welcome_email_outbox(id, user_id, org_id, kind, email, attempts, claimed_at, created_at)
    values ('a0000000-0000-4000-8000-000000034253', v_u, a, 'member', 'r143.exp@a.test', 2, now(), now() - interval '48 hours 1 minute');
  insert into public.pkg_outbox(id, org_id, quote_id, audience, channel, kind, recipient, dedupe_key, created_at)
    values ('a0000000-0000-4000-8000-000000034254', a, q, 'client', 'email', 'pkg_otp', 'r143.otp@example.test', 'r143:exp:otp', now() - interval '11 minutes');
  perform pg_temp.svc();
  perform public.comms_outbox_mark('a0000000-0000-4000-8000-000000034251', 'retry');
  perform public.trial_reminder_email_mark('a0000000-0000-4000-8000-000000034252', 'retry');
  perform public.welcome_email_outbox_mark('a0000000-0000-4000-8000-000000034253', 'retry');
  perform pg_temp.su();
  perform pg_temp.t('5a the three rows are waiting (backoff set)',
    (select next_attempt_at from public.comms_outbox where id = 'a0000000-0000-4000-8000-000000034251') > now()
    and (select next_attempt_at from public.trial_reminders where id = 'a0000000-0000-4000-8000-000000034252') > now()
    and (select next_attempt_at from public.welcome_email_outbox where id = 'a0000000-0000-4000-8000-000000034253') > now());
  perform pg_temp.svc();
  perform public.comms_outbox_claim(100);
  perform public.trial_reminder_email_claim(100);
  perform public.welcome_email_outbox_claim(100);
  perform public.pkg_outbox_claim(100);
  perform pg_temp.su();
  perform pg_temp.t('5b client message older than 3 days: closed as skipped although it was waiting (3-day rule unchanged)',
    (select status from public.comms_outbox where id = 'a0000000-0000-4000-8000-000000034251') = 'skipped');
  perform pg_temp.t('5c trial e-mail older than 2 days: skipped (2-day rule unchanged)',
    (select email_status from public.trial_reminders where id = 'a0000000-0000-4000-8000-000000034252') = 'skipped');
  perform pg_temp.t('5d welcome older than 48 hours: skipped / expired (0327 rule unchanged)',
    exists (select 1 from public.welcome_email_outbox where id = 'a0000000-0000-4000-8000-000000034253' and status = 'skipped' and skip_reason = 'expired'));
  perform pg_temp.t('5e package code older than 10 minutes: skipped (code rule unchanged)',
    (select status from public.pkg_outbox where id = 'a0000000-0000-4000-8000-000000034254') = 'skipped');
  perform pg_temp.t('5f the claim lease is still 10 minutes (a row claimed 9 minutes ago is not handed out again)',
    position('claimed_at < now() - interval ''10 minutes''' in (select prosrc from pg_proc where oid = to_regprocedure('public.comms_outbox_claim__pre0155(integer)'))) > 0
    and position('claimed_at < now() - interval ''10 minutes''' in (select prosrc from pg_proc where oid = to_regprocedure('public.security_alert_outbox_claim(integer)'))) > 0);
end $$;

-- ---- 6) codes and clock-time reminders keep today's behaviour -------------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; q uuid := 'a0000000-0000-4000-8000-00000000da01';
  o uuid := 'a0000000-0000-4000-8000-000000034261'; r jsonb;
begin
  perform pg_temp.su();
  insert into public.pkg_outbox(id, org_id, quote_id, audience, channel, kind, recipient, dedupe_key, payload)
    values (o, a, q, 'client', 'email', 'pkg_otp', 'r143.code@example.test', 'r143:otp:now', '{"otp":"123456"}');
  perform pg_temp.svc();
  r := public.pkg_outbox_claim(100);
  perform public.pkg_outbox_mark(o, 'retry');
  r := public.pkg_outbox_claim(100);
  perform pg_temp.su();
  perform pg_temp.t('6a a package code that failed is tried again at once (no wait), as before',
    pg_temp.in_claim(r, o) and exists (select 1 from public.pkg_outbox where id = o and next_attempt_at is null and attempts = 2), coalesce(r::text, ''));
  perform pg_temp.t('6b task reminders: retry still clears the lease at once (queue unchanged)',
    position('claimed_at = null' in (select prosrc from pg_proc where oid = to_regprocedure('public.task_wa_mark(uuid, text, text, text)'))) > 0
    and position('interval ''5 minutes''' in (select prosrc from pg_proc where oid = to_regprocedure('public.task_wa_claim(integer)'))) > 0
    and position('interval ''2 hours''' in (select prosrc from pg_proc where oid = to_regprocedure('public.task_wa_claim(integer)'))) > 0);
end $$;

-- ---- 7) a resend (attempts back to 0) starts fresh -----------------------------------------------------------------
do $$ declare v_id uuid; begin
  perform pg_temp.su();
  insert into public.invitations(org_id, email, role) values ('a0000000-0000-4000-8000-000000000001', 'r143.resend@example.test', 'sales');
  select id into v_id from public.invite_email_outbox where email = 'r143.resend@example.test';
  update public.invite_email_outbox set claimed_at = now(), attempts = 1 where id = v_id;
  perform pg_temp.svc();
  perform public.invite_email_outbox_mark(v_id, 'retry');
  perform pg_temp.su();
  perform pg_temp.t('7a invitation e-mail failed -> waits 1 minute', pg_temp.waits('invite_email_outbox', v_id, 1) = 'ok');
  update public.invite_email_outbox set status = 'pending', sent_at = null, claimed_at = null, attempts = 0 where id = v_id;   -- the 0131 resend
  perform pg_temp.t('7b "Resend" (tries back to 0): no wait carried over, handed out at once',
    exists (select 1 from public.invite_email_outbox where id = v_id and next_attempt_at is null and claimed_at is null and attempts = 0));
end $$;

-- ---- 8) the test switch (helm.retry_backoff = off) = the behaviour before 0342 -------------------------------------
do $$ declare v_id uuid := 'a0000000-0000-4000-8000-000000034281'; begin
  perform pg_temp.su();
  perform set_config('helm.retry_backoff', 'off', true);
  insert into public.security_alert_outbox(id, alert_type, org_id, attempts, claimed_at) values (v_id, 'mfa_disabled', 'a0000000-0000-4000-8000-000000000001', 1, now());
  perform pg_temp.svc();
  perform public.security_alert_outbox_mark(v_id, 'retry');
  perform pg_temp.su();
  perform pg_temp.t('8a switch off: a retry clears the lease at once, no wait, give-up point 5 (older suites)',
    exists (select 1 from public.security_alert_outbox where id = v_id and claimed_at is null and next_attempt_at is null)
    and public._r342_max_attempts() = 5);
  perform set_config('helm.retry_backoff', 'on', true);
end $$;

-- ---- 9) the 0290 send window still holds a retry ------------------------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; c uuid := 'a0000000-0000-4000-8000-000000034291';
  s uuid := 'a0000000-0000-4000-8000-000000034292'; t time; st time; v_exp timestamptz; v_cl timestamptz; v_nx timestamptz; v_nb timestamptz;
begin
  perform pg_temp.su();
  perform set_config('helm.send_window', 'on', true);
  t := (now() at time zone public.studio_timezone(a))::time;
  if t < time '22:00' then st := (date_trunc('minute', date '2000-01-01' + t) + interval '61 minutes')::time;
    insert into public.studio_send_windows(org_id, client_start, client_end, staff_start, staff_end, enabled) values (a, st, time '24:00', st, time '24:00', true)
      on conflict (org_id) do update set client_start = st, client_end = time '24:00', staff_start = st, staff_end = time '24:00', enabled = true;
  else st := time '02:00';   -- 22:00 - 24:00 now: the window opens at 02:00, at least two hours away
    insert into public.studio_send_windows(org_id, client_start, client_end, staff_start, staff_end, enabled) values (a, st, time '12:00', st, time '12:00', true)
      on conflict (org_id) do update set client_start = st, client_end = time '12:00', staff_start = st, staff_end = time '12:00', enabled = true;
  end if;
  v_exp := public.send_window_next(a, 'client', now() + interval '2 minutes');
  insert into public.comms_outbox(id, org_id, quote_id, purpose, channel, recipient, payload, dedupe_key, attempts, claimed_at)
    values (c, a, 'a0000000-0000-4000-8000-00000000da01', 'follow_up', 'email', 'r143.win@example.test', '{"stage":"fu1"}', 'r143:win', 1, now());
  insert into public.security_alert_outbox(id, alert_type, org_id, attempts, claimed_at) values (s, 'mfa_disabled', a, 1, now());
  perform pg_temp.svc();
  perform public.comms_outbox_mark(c, 'retry');
  perform public.security_alert_outbox_mark(s, 'retry');
  perform pg_temp.su();
  select claimed_at, next_attempt_at, not_before into v_cl, v_nx, v_nb from public.comms_outbox where id = c;
  perform pg_temp.t('9a a failed automatic follow-up while the studio window is closed waits for the window (not 1 minute, not at night)',
    v_exp > now() + interval '30 minutes' and v_nx = v_exp and v_nb = v_exp and v_cl = v_exp - interval '10 minutes',
    v_exp::text || ' next ' || coalesce(v_nx::text, 'null') || ' nb ' || coalesce(v_nb::text, 'null') || ' lease ' || coalesce(v_cl::text, 'null'));
  perform pg_temp.t('9b a security alert at the same moment just backs off (never held by the window)',
    pg_temp.waits('security_alert_outbox', s, 1) = 'ok');
  perform set_config('helm.send_window', 'off', true);
end $$;

-- ---- 10) WhatsApp STOP / START: newest message wins, a replayed event is ignored -----------------------------------
do $$ declare p1 text := '919800034301'; p2 text := '919800034302'; p3 text := '919800034303'; p4 text := '919800034304';
  t0 timestamptz := now() - interval '3 hours'; r jsonb; v boolean; n integer;
begin
  perform pg_temp.svc();
  r := public.wa_set_opt_out('r143-unknown-number', p1, true, t0 + interval '2 hours', 'wamid.r143.m1');
  perform pg_temp.t('10a STOP (12:00) recorded', r ->> 'result' = 'recorded' and (r ->> 'opted_out')::boolean, r::text);
  r := public.wa_set_opt_out('r143-unknown-number', p1, false, t0 + interval '1 hour', 'wamid.r143.m2');
  perform pg_temp.su();
  select opted_out into v from public.whatsapp_opt_outs where phone = p1 and org_id is null;
  perform pg_temp.t('10b an OLDER START (11:00) arriving late is ignored - still opted out', r ->> 'result' = 'stale' and v, r::text);
  perform pg_temp.svc();
  r := public.wa_set_opt_out('r143-unknown-number', p1, false, t0 + interval '1 hour', 'wamid.r143.m2');
  perform pg_temp.su();
  perform pg_temp.t('10c the same START delivered again (Meta retry) = replay, ignored, still opted out',
    r ->> 'result' = 'replay' and (select opted_out from public.whatsapp_opt_outs where phone = p1 and org_id is null), r::text);
  perform pg_temp.svc();
  r := public.wa_set_opt_out('r143-unknown-number', p1, false, t0 + interval '2 hours 30 minutes', 'wamid.r143.m3');
  perform pg_temp.su();
  perform pg_temp.t('10d a NEWER START (12:30) re-subscribes',
    r ->> 'result' = 'recorded' and not (select opted_out from public.whatsapp_opt_outs where phone = p1 and org_id is null)
    and (select last_event_at from public.whatsapp_opt_outs where phone = p1 and org_id is null) = t0 + interval '2 hours 30 minutes', r::text);
  perform pg_temp.svc();
  r := public.wa_set_opt_out('r143-unknown-number', p1, true, t0 + interval '2 hours', 'wamid.r143.m1');
  perform pg_temp.su();
  perform pg_temp.t('10e the old STOP replayed after that = replay, the newer START stays',
    r ->> 'result' = 'replay' and not (select opted_out from public.whatsapp_opt_outs where phone = p1 and org_id is null), r::text);
  perform pg_temp.svc();
  r := public.wa_set_opt_out('r143-unknown-number', p1, true, t0 + interval '1 hour 30 minutes', 'wamid.r143.m9');
  perform pg_temp.su();
  perform pg_temp.t('10f an OLDER STOP (11:30, new id) arriving after the newer START is ignored too (newest wins both ways)',
    r ->> 'result' = 'stale' and not (select opted_out from public.whatsapp_opt_outs where phone = p1 and org_id is null), r::text);
  -- the same second: STOP wins whichever arrives first
  perform pg_temp.svc();
  perform public.wa_set_opt_out('r143-unknown-number', p2, true, t0, 'wamid.r143.s1');
  r := public.wa_set_opt_out('r143-unknown-number', p2, false, t0, 'wamid.r143.s2');
  perform public.wa_set_opt_out('r143-unknown-number', p3, false, t0, 'wamid.r143.s3');
  perform public.wa_set_opt_out('r143-unknown-number', p3, true, t0, 'wamid.r143.s4');
  perform pg_temp.su();
  perform pg_temp.t('10g STOP and START in the same second: STOP wins in either order',
    r ->> 'result' = 'stale' and (select opted_out from public.whatsapp_opt_outs where phone = p2 and org_id is null)
    and (select opted_out from public.whatsapp_opt_outs where phone = p3 and org_id is null));
  select count(*) into n from public.integration_webhook_events where provider = 'whatsapp' and event_id like 'optout:wamid.r143.%';
  perform pg_temp.t('10h each message id recorded once (m1 m2 m3 m9 s1..s4 = 8), with type + status, never the text',
    n = 8 and exists (select 1 from public.integration_webhook_events where event_id = 'optout:wamid.r143.m2' and event_type = 'opt_in' and status = 'opted_in' and ref = 'wamid.r143.m2')
    and exists (select 1 from public.integration_webhook_events where event_id = 'optout:wamid.r143.m1' and event_type = 'opt_out' and status = 'opted_out'), n::text);
  -- an older row (before 0342, no event time): compared with its last change
  insert into public.whatsapp_opt_outs(phone, org_id, opted_out, source, updated_at) values (p4, null, true, 'reply', now() - interval '1 hour');
  perform pg_temp.svc();
  r := public.wa_set_opt_out('r143-unknown-number', p4, false, now() - interval '2 hours', 'wamid.r143.l1');
  perform pg_temp.su();
  perform pg_temp.t('10i a row from before 0342: a START older than its last change is ignored',
    r ->> 'result' = 'stale' and (select opted_out from public.whatsapp_opt_outs where phone = p4 and org_id is null), r::text);
  perform pg_temp.svc();
  r := public.wa_set_opt_out('r143-unknown-number', p4, false, now() - interval '30 minutes', 'wamid.r143.l2');
  perform pg_temp.su();
  perform pg_temp.t('10j ... and a newer START applies', r ->> 'result' = 'recorded' and not (select opted_out from public.whatsapp_opt_outs where phone = p4 and org_id is null), r::text);
  -- the old 3-argument call still works (an older wa-webhook deploy): applied as now, the event time kept up to date
  perform pg_temp.svc();
  r := public.wa_set_opt_out('r143-unknown-number', p1, true);
  perform pg_temp.su();
  perform pg_temp.t('10k the old 3-argument call still works (applied now, last_event_at = now)',
    r ->> 'result' = 'recorded' and (select opted_out and last_event_at = now() from public.whatsapp_opt_outs where phone = p1 and org_id is null), r::text);
  perform pg_temp.svc();
  r := public.wa_set_opt_out('r143-unknown-number', '12', true, now(), 'wamid.r143.bad');
  perform pg_temp.su();
  perform pg_temp.t('10l a bad phone number is ignored and records nothing',
    r ->> 'result' = 'ignored' and not exists (select 1 from public.integration_webhook_events where event_id = 'optout:wamid.r143.bad'), r::text);
  perform pg_temp.t('10m who may call: service role only (both versions), never anon / authenticated',
    has_function_privilege('service_role', 'public.wa_set_opt_out(text, text, boolean, timestamptz, text)', 'execute')
    and has_function_privilege('service_role', 'public.wa_set_opt_out(text, text, boolean)', 'execute')
    and not has_function_privilege('anon', 'public.wa_set_opt_out(text, text, boolean, timestamptz, text)', 'execute')
    and not has_function_privilege('authenticated', 'public.wa_set_opt_out(text, text, boolean, timestamptz, text)', 'execute')
    and not has_function_privilege('authenticated', 'public.wa_set_opt_out(text, text, boolean)', 'execute')
    and (select prosecdef from pg_proc where oid = to_regprocedure('public.wa_set_opt_out(text, text, boolean, timestamptz, text)'))
    and (select proconfig from pg_proc where oid = to_regprocedure('public.wa_set_opt_out(text, text, boolean)')) = array['search_path=public']);
  perform pg_temp.svc();
  r := public.wa_set_opt_out('r143-unknown-number', '919800034305', true, now() + interval '5 days', 'wamid.r143.f1');
  perform pg_temp.su();
  perform pg_temp.t('10n a message time far in the future is capped at one day ahead (a wrong clock cannot freeze the state)',
    r ->> 'result' = 'recorded' and (select last_event_at from public.whatsapp_opt_outs where phone = '919800034305' and org_id is null) = now() + interval '1 day', r::text);
end $$;

-- ---- 11) re-applying 0342 changes nothing --------------------------------------------------------------------------
create temp table _before as
  select (select md5(string_agg(proname || prosrc, ',' order by proname, oid)) from pg_proc where proname ~ '(claim|_r342_|wa_set_opt_out)') f,
         (select count(*) from pg_proc where proname like '%\_\_pre0342' escape '\') k,
         (select md5(string_agg(to_jsonb(c)::text, ',' order by c.id)) from public.comms_outbox c) q,
         (select md5(string_agg(to_jsonb(w)::text, ',' order by w.id)) from public.whatsapp_opt_outs w) w;
set client_min_messages = error;
\ir ../../supabase/migrations/0342_r143_outbox_backoff.sql
set client_min_messages = warning;
set local helm.retry_backoff = 'on';
select pg_temp.t('11a re-apply: same function bodies, same kept copies, no queue row or opt-out row changed',
  (select f from _before) = (select md5(string_agg(proname || prosrc, ',' order by proname, oid)) from pg_proc where proname ~ '(claim|_r342_|wa_set_opt_out)')
  and (select k from _before) >= 17
  and (select count(*) from pg_proc where proname like '%\_\_pre0342' escape '\') = (select k from _before)
  and (select q from _before) = (select md5(string_agg(to_jsonb(c)::text, ',' order by c.id)) from public.comms_outbox c)
  and (select w from _before) = (select md5(string_agg(to_jsonb(w)::text, ',' order by w.id)) from public.whatsapp_opt_outs w));

do $$ declare n int; f int; r record; begin
  select count(*), count(*) filter (where result <> 'PASS') into n, f from _rs;
  for r in select * from _rs where result <> 'PASS' loop raise warning '% -> %', r.name, r.result; end loop;
  if f = 0 then raise warning 'R143-OUTBOX-BACKOFF-0342: ALL PASS (%/%)', n, n;
  else raise warning 'R143-OUTBOX-BACKOFF-0342: % FAILED of %', f, n; end if;
end $$;
rollback;
