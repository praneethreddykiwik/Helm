-- 0362_r171_staff_reminders.sql - R171 (owner, 16 Nov 2026: "special reminders: due in 10 minutes, 5 minutes, due now -
-- by e-mail right now; keep BOTH Send through WhatsApp and Send through e-mail; if WhatsApp is not set up, say so").
-- REQUIRES 0361 (staff_email_outbox, staff_email_claim), 0338 (task reminders), 0337 (studio WhatsApp), 0132 + 0274 (assign
-- WhatsApp queue), 0179 / 0183 / 0187 (trial gates).
--
-- What it does, in plain words:
--   1  staff_whatsapp_send(task): the new "Send on WhatsApp" buttons on the Operations page (Staff edit only, own studio
--      only). When the studio has no connected WhatsApp number it answers wa_not_set_up and nothing is queued. When it is
--      connected it queues the SAME message the automatic "you have been given a task" WhatsApp uses (assign_notify_outbox,
--      0132), so comms-dispatch sends it from the studio number exactly as today. One message per task and person per 10
--      minutes (the 0132 rule).
--   2  staff_email_claim is wrapped once (old body kept as staff_email_claim__pre0362): a BEFORE-the-start reminder e-mail
--      ("due in 10 min", "due now") that is still waiting more than 5 minutes after the task start is not sent any more
--      (it would arrive too late to help); the late reminders and the office alert cover that time. Nothing else changes.
--   3  _r362_dispatch_schedule(): reads the comms-dispatch timer (pg_cron) so the VERIFY below shows how often e-mails
--      actually leave. Reminders are queued every minute; they are SENT on the comms-dispatch timer.
--
-- ZERO DATA LOSS: additive + idempotent. New functions only, one function wrapped once (old body kept). Nothing dropped,
-- nothing deleted. Safe to run twice. ASCII only.

-- ---- 0) preflight ---------------------------------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.staff_email_outbox') is null or to_regprocedure('public.staff_email_claim(integer)') is null
     or to_regprocedure('public._r361_live(uuid,uuid)') is null then
    raise exception 'STOP 0362: run 0361 (staff e-mail) first'; end if;
  if to_regclass('public.task_wa_outbox') is null then raise exception 'STOP 0362: run 0338 (task reminders) first'; end if;
  if to_regprocedure('public._r337_wa_ready(uuid)') is null then raise exception 'STOP 0362: run 0337 (studio WhatsApp) first'; end if;
  if to_regprocedure('public._assign132_enqueue__pre0274(uuid,uuid,text,uuid,text,text,text,text,text)') is null
     or to_regprocedure('public._assign132_phone(text)') is null then
    raise exception 'STOP 0362: run 0132 + 0274 first'; end if;
  if to_regprocedure('public._tb179_no_send(uuid)') is null or to_regprocedure('public._sample_outbound_blocked(uuid,text)') is null then
    raise exception 'STOP 0362: run 0179 + 0187 first'; end if;
  if to_regprocedure('public.has_area(text,text)') is null or to_regprocedure('public.current_org_id()') is null then
    raise exception 'STOP 0362: has_area / current_org_id missing'; end if;
end $$;

-- ---- 1) "Send on WhatsApp" button -------------------------------------------------------------------------------------
-- { ok, name?, reason? }  reason: wa_not_set_up | no_phone | just_sent | trial | not_live | vendor | closed
create or replace function public.staff_whatsapp_send(p_task uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r171-0362
declare v_org uuid := public.current_org_id(); t public.event_tasks; v_phone text; v_name text; v_tz text; v_when text; v_ok boolean;
begin
  if auth.uid() is null or v_org is null or not public.has_area('staff', 'edit') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select * into t from public.event_tasks x where x.id = p_task and x.org_id = v_org;
  if t.id is null then raise exception 'task not found' using errcode = 'P0002'; end if;
  if coalesce(t.assignee_kind, 'in_house') <> 'in_house' then return jsonb_build_object('ok', false, 'reason', 'vendor'); end if;
  if t.status in ('completed', 'cancelled', 'rejected') then return jsonb_build_object('ok', false, 'reason', 'closed'); end if;
  -- the own WhatsApp number of the studio must be connected (Helm never sends from its own number)
  if not coalesce(public._r337_wa_ready(v_org), false) then
    return jsonb_build_object('ok', false, 'reason', 'wa_not_set_up'); end if;
  if coalesce(public._sample_outbound_blocked(v_org, null::text), false) or coalesce(public._tb179_no_send(v_org), false) then
    return jsonb_build_object('ok', false, 'reason', 'trial'); end if;
  if not public._r361_live(v_org, t.quote_id) then return jsonb_build_object('ok', false, 'reason', 'not_live'); end if;
  v_phone := public._assign132_phone(t.assignee_phone);
  v_name := t.assignee_name;
  if v_phone is null and t.crew_id is not null then
    select public._assign132_phone(cm.phone), coalesce(v_name, cm.name) into v_phone, v_name
      from public.crew_members cm where cm.id = t.crew_id and cm.org_id = v_org;
  end if;
  if v_phone is null then return jsonb_build_object('ok', false, 'reason', 'no_phone', 'name', coalesce(v_name, '')); end if;
  select coalesce(nullif(o.timezone, ''), 'Asia/Kolkata') into v_tz from public.organizations o where o.id = v_org;
  v_when := case when t.planned_start is not null
                 then to_char(t.planned_start at time zone coalesce(v_tz, 'Asia/Kolkata'), 'DD Mon HH24:MI') end;
  -- the same queue the automatic assignment WhatsApp uses (0132); an explicit office action, so not tied to the automation switch
  v_ok := public._assign132_enqueue__pre0274(v_org, t.quote_id, 'task', t.id, v_phone, v_name, t.title, v_when, null);
  if not coalesce(v_ok, false) then return jsonb_build_object('ok', false, 'reason', 'just_sent', 'name', coalesce(v_name, '')); end if;
  return jsonb_build_object('ok', true, 'name', coalesce(v_name, ''));
end $fn$;

-- ---- 2) do not send a before-the-start reminder that is already too late -------------------------------------------------
do $$
declare v_src text;
begin
  select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('public.staff_email_claim(integer)');
  if position('r171-0362' in coalesce(v_src, '')) = 0 and to_regprocedure('public.staff_email_claim__pre0362(integer)') is null then
    alter function public.staff_email_claim(integer) rename to staff_email_claim__pre0362;
  end if;
  if to_regprocedure('public.staff_email_claim__pre0362(integer)') is null then
    raise exception 'STOP 0362: staff_email_claim could not be kept as staff_email_claim__pre0362'; end if;
end $$;

create or replace function public.staff_email_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $fn$
-- r171-0362: the 0361 claim, after one extra rule - a before-the-start reminder still waiting 5 minutes after the
-- start is skipped (too_late); the late reminders take over from there
begin
  update public.staff_email_outbox set status = 'skipped', reason = 'too_late', sent_at = now(), updated_at = now()
   where kind = 'task_reminder' and status = 'pending' and sent_at is null
     and ref_start is not null and ref_start < now() - interval '5 minutes';
  return public.staff_email_claim__pre0362(p_limit);
end $fn$;

-- ---- 3) how often does comms-dispatch run? (text for the VERIFY; never fails) -----------------------------------------------
create or replace function public._r362_dispatch_schedule()
returns text language plpgsql stable security definer set search_path = '' as $fn$
-- r171-0362
declare v text;
begin
  if to_regclass('cron.job') is null then return 'no pg_cron here (staging)'; end if;
  begin
    execute 'select string_agg(j.schedule, '' / '' order by j.jobid) from cron.job j where j.command ilike ''%comms-dispatch%'''
      into v;
  exception when others then v := null;
  end;
  return coalesce(v, 'no comms-dispatch timer found');
end $fn$;

-- ---- 4) grants: the button for signed-in staff; the rest for the server only -------------------------------------------
do $$
declare f text;
begin
  foreach f in array array['public.staff_whatsapp_send(uuid)', 'public.staff_email_claim(integer)',
                           'public.staff_email_claim__pre0362(integer)', 'public._r362_dispatch_schedule()'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.staff_whatsapp_send(uuid) to authenticated';
  end if;
end $$;

-- VERIFY every line should say true (line 06 only reports how often e-mails leave)
select item, ok from (values
  ('01 Send on WhatsApp button function', to_regprocedure('public.staff_whatsapp_send(uuid)') is not null),
  ('02 button for signed-in staff only', coalesce(has_function_privilege('authenticated', 'public.staff_whatsapp_send(uuid)', 'execute') and not has_function_privilege('anon', 'public.staff_whatsapp_send(uuid)', 'execute'), false)),
  ('03 e-mail claim wrapped once (old body kept)', to_regprocedure('public.staff_email_claim__pre0362(integer)') is not null and position('r171-0362' in coalesce(pg_get_functiondef(to_regprocedure('public.staff_email_claim(integer)')), '')) > 0),
  ('04 e-mail claim server only', not has_function_privilege('authenticated', 'public.staff_email_claim(integer)', 'execute') and not has_function_privilege('authenticated', 'public.staff_email_claim__pre0362(integer)', 'execute')),
  ('05 timer info server only', not has_function_privilege('authenticated', 'public._r362_dispatch_schedule()', 'execute')),
  ('06 INFO comms-dispatch timer (best is every minute): ' || public._r362_dispatch_schedule(), true)
) v(item, ok) order by item;
