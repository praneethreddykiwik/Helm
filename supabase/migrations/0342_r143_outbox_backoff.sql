-- 0342_r143_outbox_backoff.sql - R143 outbox retry backoff + WhatsApp STOP START order. Forward-only, additive, safe to run twice. Notes in MANIFEST.
do $$
begin
  if to_regclass('public.comms_outbox') is null or to_regprocedure('public.comms_outbox_claim(integer)') is null then
    raise exception 'STOP 0342: comms_outbox / comms_outbox_claim missing - run 0078 first'; end if;
  if to_regclass('public.whatsapp_opt_outs') is null or to_regprocedure('public.wa_set_opt_out(text,text,boolean)') is null
     or to_regprocedure('public.wa_record_event(text,text,text,text,text,text,jsonb)') is null then
    raise exception 'STOP 0342: whatsapp_opt_outs / wa_set_opt_out / wa_record_event missing - run 0117 first'; end if;
end $$;

create or replace function public._r342_queue_cols(p_table text)
returns text[] language sql immutable set search_path = '' as $$
  select case
    when p_table in ('trial_reminders', 'trial_retention_notices') then array['email_claimed_at', 'email_attempts', 'email_sent_at']
    when p_table in ('comms_outbox', 'pkg_outbox', 'security_alert_outbox', 'welcome_email_outbox', 'invite_email_outbox',
                     'assign_notify_outbox', 'helm_notice_outbox', 'vendor_request_sends', 'lead_enquiries')
      then array['claimed_at', 'attempts', 'sent_at']
  end;
$$;

create or replace function public._r342_max_attempts(p_kind text default null)
returns integer language sql stable set search_path = '' as $$
  select case when coalesce(current_setting('helm.retry_backoff', true), '') = 'off' then 5
              when p_kind = 'pkg_otp' then 5
              else 8 end;
$$;

create or replace function public._r342_backoff(p_attempts integer)
returns interval language sql volatile set search_path = '' as $$
  select make_interval(secs => s.m * 60 * (1 + 0.1 * random()))
    from (select case when coalesce(p_attempts, 0) <= 1 then 1 when p_attempts = 2 then 2 when p_attempts = 3 then 4
                      when p_attempts = 4 then 8 when p_attempts = 5 then 16 when p_attempts = 6 then 30 else 60 end as m) s;
$$;

do $$ declare t text; begin
  foreach t in array array['comms_outbox', 'pkg_outbox', 'security_alert_outbox', 'welcome_email_outbox', 'invite_email_outbox',
                           'trial_reminders', 'trial_retention_notices', 'assign_notify_outbox', 'helm_notice_outbox',
                           'vendor_request_sends', 'lead_enquiries'] loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I add column if not exists next_attempt_at timestamptz', t);
      execute format('comment on column public.%I.next_attempt_at is %L', t,
        'r143-0342: after a failed send the earliest next try (backoff 1 2 4 8 16 30 60 min). Null = not waiting.');
    end if;
  end loop;
end $$;

create or replace function public._r342_tg_backoff()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r143-0342
declare c text[]; o jsonb; n jsonb; v_try integer; v_next timestamptz; v_nb timestamptz; v_patch jsonb := '{}'::jsonb;
begin
  if coalesce(current_setting('helm.retry_backoff', true), '') = 'off' then return NEW; end if;
  begin
    c := public._r342_queue_cols(TG_TABLE_NAME);
    if c is null then return NEW; end if;
    o := to_jsonb(OLD); n := to_jsonb(NEW);
    v_try := coalesce((n ->> c[2])::integer, 0);
    if v_try = 0 or v_try < coalesce((o ->> c[2])::integer, 0) then
      if (n ->> 'next_attempt_at') is not null then NEW := jsonb_populate_record(NEW, jsonb_build_object('next_attempt_at', null)); end if;
      return NEW;
    end if;
    if (o ->> c[1]) is null or (n ->> c[1]) is not null or (n ->> c[3]) is not null then return NEW; end if;
    if TG_TABLE_NAME = 'pkg_outbox' and coalesce(n ->> 'kind', '') = 'pkg_otp' then return NEW; end if;
    v_next := now() + public._r342_backoff(v_try);
    if coalesce(current_setting('helm.send_window', true), '') <> 'off'
       and to_regprocedure('public._sw290_not_before(text,jsonb,timestamptz)') is not null then
      v_nb := public._sw290_not_before(TG_TABLE_NAME, n, v_next);
      if v_nb is not null and v_nb > v_next then v_next := v_nb; v_patch := jsonb_build_object('not_before', v_nb); end if;
    end if;
    v_patch := v_patch || jsonb_build_object('next_attempt_at', v_next, c[1], v_next - interval '10 minutes');
    NEW := jsonb_populate_record(NEW, v_patch);
  exception when others then
    raise warning 'r143-0342: retry wait not applied (%)', sqlstate;
  end;
  return NEW;
end $$;

do $$ declare t text; c text[]; begin
  foreach t in array array['comms_outbox', 'pkg_outbox', 'security_alert_outbox', 'welcome_email_outbox', 'invite_email_outbox',
                           'trial_reminders', 'trial_retention_notices', 'assign_notify_outbox', 'helm_notice_outbox',
                           'vendor_request_sends', 'lead_enquiries'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    c := public._r342_queue_cols(t);
    execute format('create or replace trigger zz_r342_backoff before update of %I on public.%I for each row execute function public._r342_tg_backoff()', c[1], t);
  end loop;
end $$;

create or replace function public._r342_keep(p_fn text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare v_oid oid := to_regprocedure(p_fn); v_name text; v_types text; v_def text; v_pre text; r text;
begin
  if v_oid is null then return; end if;
  select p.proname, oidvectortypes(p.proargtypes) into v_name, v_types from pg_proc p where p.oid = v_oid;
  v_pre := format('public.%I(%s)', v_name || '__pre0342', v_types);
  if to_regprocedure(v_pre) is null then
    v_def := pg_get_functiondef(v_oid);
    v_def := regexp_replace(v_def, '^CREATE OR REPLACE FUNCTION public\.' || v_name || '\(',
                            'CREATE OR REPLACE FUNCTION public.' || v_name || '__pre0342(');
    if position(v_name || '__pre0342(' in v_def) = 0 then raise exception 'r143-0342: could not keep %', p_fn; end if;
    execute v_def;
  end if;
  execute format('revoke all on function %s from public', v_pre);
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', v_pre, r); end if;
  end loop;
end $$;

do $do$ declare f text[]; v_oid oid; v_def text; v_n integer;
begin
  foreach f slice 1 in array array[
    array['public.comms_outbox_claim(integer)', 'attempts >= 5', 'attempts >= public._r342_max_attempts()', 'optional'],
    array['public.comms_outbox_claim__pre0155(integer)', 'attempts >= 5', 'attempts >= public._r342_max_attempts()', 'required'],
    array['public.comms_outbox_claim__pre0200(integer)', 'attempts >= 5', 'attempts >= public._r342_max_attempts()', 'required'],
    array['public.comms_outbox_claim__pre0261(integer)', 'attempts >= 5', 'attempts >= public._r342_max_attempts()', 'required'],
    array['public.comms_outbox_claim__pre0262(integer)', 'attempts >= 5', 'attempts >= public._r342_max_attempts()', 'required'],
    array['public._qv262_claim(integer)', 'attempts >= 5', 'attempts >= public._r342_max_attempts()', 'required'],
    array['public.pkg_outbox_claim__pre0155(integer)', 'attempts >= 5', 'attempts >= public._r342_max_attempts(kind)', 'required'],
    array['public.security_alert_outbox_claim(integer)', 'attempts >= 5', 'attempts >= public._r342_max_attempts()', 'required'],
    array['public.welcome_email_outbox_claim(integer)', 'attempts >= 5', 'attempts >= public._r342_max_attempts()', 'required'],
    array['public.invite_email_outbox_claim__pre0155(integer, uuid)', 'attempts >= 5', 'attempts >= public._r342_max_attempts()', 'required'],
    array['public.trial_reminder_email_claim(integer)', 'email_attempts >= 5', 'email_attempts >= public._r342_max_attempts()', 'required'],
    array['public.trial_retention_email_claim(integer)', 'email_attempts >= 5', 'email_attempts >= public._r342_max_attempts()', 'required'],
    array['public.trial_followup_email_claim(integer)', 'email_attempts >= 5', 'email_attempts >= public._r342_max_attempts()', 'required'],
    array['public.assign_notify_claim__pre0283(integer)', 'attempts >= 5', 'attempts >= public._r342_max_attempts()', 'required'],
    array['public.helm_notice_outbox_claim(integer)', 'attempts >= 5', 'attempts >= public._r342_max_attempts()', 'required'],
    array['public.vendor_request_claim(integer, text)', 'attempts >= 5', 'attempts >= public._r342_max_attempts()', 'required'],
    array['public.enquiry_reply_claim(integer)', 'attempts >= 5', 'attempts >= public._r342_max_attempts()', 'required']] loop
    v_oid := to_regprocedure(f[1]);
    if v_oid is null then raise notice '0342: % not on this database - left unchanged', f[1]; continue; end if;
    v_def := pg_get_functiondef(v_oid);
    if position('_r342_max_attempts' in v_def) > 0 then continue; end if;
    v_n := (length(v_def) - length(replace(v_def, f[2], ''))) / length(f[2]);
    if v_n = 0 and f[4] = 'optional' then continue; end if;
    if v_n <> 1 then raise notice '0342: % has an unexpected body - left unchanged (gives up after 5 tries)', f[1]; continue; end if;
    perform public._r342_keep(f[1]);
    execute replace(v_def, f[2], f[3]);
  end loop;
end $do$;

alter table public.whatsapp_opt_outs add column if not exists last_event_at timestamptz;
comment on column public.whatsapp_opt_outs.last_event_at is
  'r143-0342: time of the STOP or START message (Meta timestamp) that set opted_out. An older or replayed message never overrides a newer one.';

create or replace function public.wa_set_opt_out(p_phone_number_id text, p_phone text, p_opted_out boolean, p_event_at timestamptz, p_message_id text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r143-0342
declare v_org uuid; v_phone text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'); v_out boolean := coalesce(p_opted_out, true);
  v_at timestamptz := least(coalesce(p_event_at, now()), now() + interval '1 day');
  v_mid text := case when p_message_id ~ '^[A-Za-z0-9_.:=+/-]{1,150}$' then p_message_id end;
  v_rec jsonb; v_id bigint; v_cur boolean;
begin
  if v_phone !~ '^[0-9]{8,15}$' then return jsonb_build_object('result', 'ignored'); end if;
  select a.org_id into v_org from public.org_whatsapp_accounts a where a.phone_number_id = p_phone_number_id;
  if v_mid is not null then
    v_rec := public.wa_record_event('optout:' || v_mid, p_phone_number_id, case when v_out then 'opt_out' else 'opt_in' end, v_mid,
                                    case when v_out then 'opted_out' else 'opted_in' end, v_phone, '{}'::jsonb);
    if coalesce(v_rec ->> 'result', '') = 'replay' then
      select w.opted_out into v_cur from public.whatsapp_opt_outs w
       where w.phone = v_phone and coalesce(w.org_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(v_org, '00000000-0000-0000-0000-000000000000'::uuid);
      return jsonb_build_object('result', 'replay', 'opted_out', v_cur);
    end if;
  end if;
  insert into public.whatsapp_opt_outs as w (phone, org_id, opted_out, source, updated_at, last_event_at)
    values (v_phone, v_org, v_out, 'reply', now(), v_at)
  on conflict (phone, coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid))
    do update set opted_out = excluded.opted_out, updated_at = now(), last_event_at = excluded.last_event_at
     where excluded.last_event_at > coalesce(w.last_event_at, w.updated_at)
        or (excluded.last_event_at = coalesce(w.last_event_at, w.updated_at) and excluded.opted_out)
  returning w.id into v_id;
  if v_id is null then
    select w.opted_out into v_cur from public.whatsapp_opt_outs w
     where w.phone = v_phone and coalesce(w.org_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(v_org, '00000000-0000-0000-0000-000000000000'::uuid);
    return jsonb_build_object('result', 'stale', 'opted_out', v_cur);
  end if;
  return jsonb_build_object('result', 'recorded', 'opted_out', v_out);
end $$;
revoke all on function public.wa_set_opt_out(text, text, boolean, timestamptz, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.wa_set_opt_out(text, text, boolean, timestamptz, text) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public.wa_set_opt_out(text, text, boolean, timestamptz, text) from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function public.wa_set_opt_out(text, text, boolean, timestamptz, text) to service_role; end if;
end $$;

do $do$ declare v_src text; begin
  select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('public.wa_set_opt_out(text,text,boolean)');
  if position('r143-0342' in v_src) > 0 then return; end if;
  if position('integration-accounts-0117' in v_src) = 0 then
    raise notice '0342: wa_set_opt_out with three arguments is not the known 0117 body - left unchanged';
    return;
  end if;
  perform public._r342_keep('public.wa_set_opt_out(text,text,boolean)');
  execute $fn$
create or replace function public.wa_set_opt_out(p_phone_number_id text, p_phone text, p_opted_out boolean)
returns jsonb language plpgsql security definer set search_path = public as $body$
-- r143-0342
begin
  return public.wa_set_opt_out(p_phone_number_id, p_phone, p_opted_out, null::timestamptz, null::text);
end $body$
$fn$;
end $do$;

do $$ declare f text; r text; begin
  foreach f in array array['public._r342_queue_cols(text)', 'public._r342_max_attempts(text)', 'public._r342_backoff(integer)',
                           'public._r342_tg_backoff()', 'public._r342_keep(text)'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on function public._r342_keep(text) from service_role';
    execute 'revoke all on function public._r342_tg_backoff() from service_role';
  end if;
end $$;
