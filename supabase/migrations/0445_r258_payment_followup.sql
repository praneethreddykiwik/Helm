-- 0445_r258_payment_followup.sql - R258 (owner, 25 Nov 2026: "you need to remind the studio ... don't remind that person directly ...
-- the second payment needs OTP and payment, third payment for us, everything same"). Forward-only, additive, safe to run twice. ASCII only.
-- REQUIRES 0264, 0266, 0274, 0285, 0290, 0388, 0401, 0404, 0435, 0443. Paste the whole file in the Supabase SQL editor; the last
-- statement answers one row per check. The pages work without it (the new parts stay hidden).
--
-- In plain words:
--   A  THE STUDIO IS REMINDED. For every unpaid payment with a date: a bell to the people with Finance edit - the working day before
--      (Sundays are skipped), on the due day, and every 3 days while it is late - at 10:00 studio time (the time and on / off are in
--      Settings, Payment schedules). It says what is LEFT. Once per slot. It stops when the payment is paid, waived or voided, its date
--      changes (a new date starts new slots), the event is closed / cancelled / archived or not approved yet. Inside the staff send window
--      (0290) only. A person who chose instant or daily inbox e-mails gets it by e-mail too (the 0266 setting); a trial: bell only.
--   B  THE CLIENT IS NOT REMINDED BY ITSELF. The automatic client payment reminders are off for a studio that never switched them on since
--      0274 (no stored setting is changed here). "Send reminder to the client" is a button: payment_reminder_preview shows the exact words,
--      payment_reminder_send_now (0078) queues it, payment_followup_get says when and by whom it was last sent.
--   C  A part-paid payment says "the rest of Rs. X" in the reminder.
--   D  THE CLIENT'S "PAY THIS PAYMENT" STEP on the event's own private link: a one-time code to the e-mail / WhatsApp on the quote, how to
--      pay, "I have paid" with a reference. It records NO money: it makes a notice the studio sees and records as today. The codes live in
--      their own table, so a payment code can never approve a quote and an approval code can never confirm a payment.
--
-- ZERO DATA LOSS: 3 new tables, 2 new columns with a default, functions, 1 index, 3 restrictive policies, 1 cron job (only where pg_cron is). No stored row
-- is changed or deleted. Bodies that change are kept once as <name>__pre0445 (server only).
-- SWITCH OFF the studio reminders everywhere, one line:  select cron.unschedule('helm_payment_team_tick');

-- ---- 0) preflight ---------------------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  foreach f in array array['public._r443_left(uuid)', 'public._r435_held(uuid)', 'public._pst_today(uuid)', 'public._pst_pay_details(uuid)', 'public._comms_quote_live(uuid)',
      'public._comms_quote_cur(uuid)', 'public._comms_money(numeric,text)', 'public._comms_date(date,uuid)', 'public._comms_queue_pay(uuid,text,text,boolean,uuid)',
      'public._comms_channels(jsonb,text)', 'public._comms_client_to(jsonb,text,uuid)', 'public._comms_cfg(uuid)', 'public.helm_invoice_total(uuid)',
      'public._r23_area(uuid,text,text,text)', 'public._r23_important(text)', 'public._r23_label(text,jsonb)', 'public._r283_is_off(uuid,uuid)', 'public._r388_vis(uuid,uuid)',
      'public._r401_vis(uuid,uuid)', 'public.bell_feed(integer)', 'public.notification_type_of(text,text)', 'public.send_window_next(uuid,text,timestamptz)',
      'public.studio_timezone(uuid)', 'public.public_get_quote(uuid)', 'public._r341_limit(text,integer,integer)', 'public._tb179_no_send(uuid)', 'public._trial_locked(uuid)',
      'public._is_trial_org(uuid)', 'public._wa151_token_quote(uuid)', 'public._wa151_quote_e164(uuid)', 'public._tl173_guard()', 'public.has_area(text,text)', 'public.current_org_id()',
      'public.payment_reminder_send_now(uuid)', 'public.tg_studio_read_only()', 'public.tg_quote_org_match()', 'extensions.crypt(text,text)', 'extensions.gen_salt(text)'] loop
    if to_regprocedure(f) is null then raise exception 'STOP 0445: % is missing - an earlier update is not on this database; nothing was changed', f; end if;
  end loop;
  if to_regclass('public.payment_schedule_settings') is null or to_regclass('public.payment_milestones') is null or to_regclass('public.comms_outbox') is null then
    raise exception 'STOP 0445: the payment schedule tables are missing - nothing was changed'; end if;
end $$;

-- ---- 1) keep helper (same shape as _r443_keep) ------------------------------------------------------------------------------------
create or replace function public._r445_keep(p_fn text)
returns void language plpgsql volatile security definer set search_path = '' as $$
-- r258-0445
declare v_oid oid := to_regprocedure(p_fn); v_name text; v_types text; v_def text; v_pre text; r text;
begin
  if v_oid is null then return; end if;
  select p.proname, oidvectortypes(p.proargtypes) into v_name, v_types from pg_proc p where p.oid = v_oid;
  v_pre := format('public.%I(%s)', v_name || '__pre0445', v_types);
  if to_regprocedure(v_pre) is null then
    v_def := pg_get_functiondef(v_oid);
    v_def := regexp_replace(v_def, '^CREATE OR REPLACE FUNCTION public\.' || v_name || '\(', 'CREATE OR REPLACE FUNCTION public.' || v_name || '__pre0445(');
    if position(v_name || '__pre0445(' in v_def) = 0 then raise exception 'r258-0445: could not keep %', p_fn; end if;
    execute v_def;
  end if;
  execute format('revoke all on function %s from public', v_pre);
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', v_pre, r); end if;
  end loop;
end $$;

-- ---- 2) settings + tables (server only: read and written through the functions below) -----------------------------------------------
alter table public.payment_schedule_settings add column if not exists team_remind boolean not null default true;
alter table public.payment_schedule_settings add column if not exists team_remind_at time not null default time '10:00';

create table if not exists public.payment_team_reminders (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id),
  quote_id     uuid not null references public.quotes(id) on delete cascade,
  milestone_id uuid not null,
  slot         text not null,
  left_amount  numeric,
  people       integer not null default 0,
  created_at   timestamptz not null default now(),
  constraint payment_team_reminders_slot_chk445 check (slot ~ '^(before|due|late):[0-9-]{10}(:[0-9]{1,3})?$'),
  constraint payment_team_reminders_once445 unique (milestone_id, slot)
);
create table if not exists public.payment_claims (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id),
  quote_id     uuid not null references public.quotes(id) on delete cascade,
  milestone_id uuid not null,
  amount       numeric not null,
  method       text not null,
  reference    text,
  code_ok      boolean not null default false,
  status       text not null default 'open',
  created_at   timestamptz not null default now(),
  closed_at    timestamptz,
  closed_by    uuid,
  closed_name  text,
  constraint payment_claims_amount_chk445 check (amount > 0 and amount < 1000000000),
  constraint payment_claims_method_chk445 check (method in ('upi', 'bank', 'cash', 'card', 'other')),
  constraint payment_claims_status_chk445 check (status in ('open', 'recorded', 'not_received')),
  constraint payment_claims_text_chk445 check (char_length(coalesce(reference, '')) <= 80 and coalesce(reference, '') !~ '[<>[:cntrl:]]' and char_length(coalesce(closed_name, '')) <= 80)
);
create table if not exists public.payment_codes (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id),
  quote_id     uuid not null references public.quotes(id) on delete cascade,
  milestone_id uuid not null,
  channel      text not null,
  code_hash    text,
  attempts     integer not null default 0,
  expires_at   timestamptz not null,
  sent_at      timestamptz,
  verified_at  timestamptz,
  proof        uuid,
  used_at      timestamptz,
  created_at   timestamptz not null default now(),
  constraint payment_codes_channel_chk445 check (channel in ('email', 'whatsapp'))
);
comment on table public.payment_team_reminders is 'r258-0445: one row per payment and slot = the studio was reminded (never twice).';
comment on table public.payment_claims is 'r258-0445: "I have paid" from the client''s own link. A notice, never money: the studio records the payment as before.';
comment on table public.payment_codes is 'r258-0445: one-time codes of the client''s "Pay this payment" step (hash only). Never an approval code (quote_otps) and never a consent.';
create index if not exists payment_team_reminders_quote445 on public.payment_team_reminders (quote_id, created_at desc);
create index if not exists payment_team_reminders_org445 on public.payment_team_reminders (org_id);
create index if not exists payment_claims_quote445 on public.payment_claims (quote_id, created_at desc);
create index if not exists payment_claims_org445 on public.payment_claims (org_id);
create unique index if not exists payment_claims_one_open445 on public.payment_claims (milestone_id) where status = 'open';
create index if not exists payment_codes_quote445 on public.payment_codes (quote_id, created_at desc);
create index if not exists payment_codes_sent445 on public.payment_codes (sent_at) where sent_at is not null;
create index if not exists payment_codes_org445 on public.payment_codes (org_id, created_at desc);
create index if not exists ix_payment_milestones_open_due_0445 on public.payment_milestones (due_date) where status in ('due', 'invoiced');

do $$ declare t text; r text; v_def text; begin
  foreach t in array array['payment_team_reminders', 'payment_claims', 'payment_codes'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public', t);
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on table public.%I from %I', t, r); end if;
    end loop;
    if t <> 'payment_codes' and exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant select on table public.%I to service_role', t); end if;
    if not exists (select 1 from pg_trigger where tgrelid = ('public.' || t)::regclass and tgname = 'zz_quote_org_match') then
      execute format('create trigger zz_quote_org_match before insert or update on public.%I for each row execute function public.tg_quote_org_match()', t); end if;
    if not exists (select 1 from pg_trigger where tgrelid = ('public.' || t)::regclass and tgname = 'zzz_studio_read_only') then
      execute format('create trigger zzz_studio_read_only before insert or update or delete on public.%I for each row execute function public.tg_studio_read_only(''org_id'')', t); end if;
  end loop;
  -- free-trial retention (0184): they go with the studio's events (patched in place once)
  if to_regprocedure('public._tr184_purge_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
    if position('''payment_claims''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''payment_overdue_alerts'', ', ''))) / length('''payment_overdue_alerts'', ') <> 1 then
        raise notice '0445: _tr184_purge_tables has an unexpected body - left unchanged';
      else execute replace(v_def, '''payment_overdue_alerts'', ', '''payment_overdue_alerts'', ''payment_team_reminders'', ''payment_claims'', ''payment_codes'', '); end if;
    end if;
  end if;
end $$;

-- ---- 3) helpers (server only) -------------------------------------------------------------------------------------------------------
create or replace function public._r445_cfg(p_org uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- r258-0445
  select jsonb_build_object('on', coalesce(s.team_remind, true), 'at', to_char(coalesce(s.team_remind_at, time '10:00'), 'HH24:MI'))
    from (select 1) one left join public.payment_schedule_settings s on s.org_id = p_org;
$$;
-- the people who collect money: Finance edit in this studio, active, not a client / crew login
create or replace function public._r445_people(p_org uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- r258-0445
  select coalesce(jsonb_agg(p.id::text order by p.id), '[]'::jsonb) from public.profiles p
   where p_org is not null and p.org_id = p_org and lower(coalesce(p.role, '')) not in ('', 'client', 'crew', 'worker')
     and not public._r283_is_off(p.id, p_org) and public._r23_area(p_org, p.role, 'finance', 'edit');
$$;
-- the working day before a day (Helm keeps no studio working days: Sundays are skipped)
create or replace function public._r445_day_before(p date)
returns date language sql immutable set search_path = '' as $$
  select case when extract(isodow from p - 1) = 7 then p - 2 else p - 1 end;
$$;
-- which reminder belongs to this day: before:<due> / due:<due> / late:<due>:<n> (every 3 days: 1-3 days late = 0, 4-6 = 1 ...); null = none
create or replace function public._r445_slot(p_due date, p_today date)
returns text language sql immutable set search_path = '' as $$
  select case when p_due is null or p_today is null then null
              when p_today < p_due then case when p_today >= public._r445_day_before(p_due) then 'before:' || to_char(p_due, 'YYYY-MM-DD') end
              when p_today = p_due then 'due:' || to_char(p_due, 'YYYY-MM-DD')
              when p_today - p_due <= 180 then 'late:' || to_char(p_due, 'YYYY-MM-DD') || ':' || ((p_today - p_due - 1) / 3)::text end;
$$;
-- the rupee sign with Indian commas (the bell); another currency as the mails write it
create or replace function public._r445_money(p numeric, p_cur text)
returns text language sql immutable set search_path = '' as $$
  select case when coalesce(p_cur, 'INR') <> 'INR' then public._comms_money(p, p_cur)
    else chr(8377) || case when x.w ~ '^[0-9]{4,}$' then regexp_replace(left(x.w, -3), '([0-9])(?=([0-9]{2})+$)', '\1,', 'g') || ',' || right(x.w, 3) else x.w end
         || case when x.f > 0 then '.' || lpad(x.f::text, 2, '0') else '' end end
    from (select trunc(round(coalesce(p, 0), 2))::text as w, (round((round(coalesce(p, 0), 2) - trunc(round(coalesce(p, 0), 2))) * 100))::integer as f) x;
$$;
-- "Second payment (50%)" -> "second payment"
create or replace function public._r445_name(p text)
returns text language sql immutable set search_path = '' as $$
  select left(case when x.n ~ '^[A-Z][a-z]' then lower(left(x.n, 1)) || substr(x.n, 2) else x.n end, 80)
    from (select coalesce(nullif(btrim(regexp_replace(coalesce(p, ''), '\s*\([0-9]+(\.[0-9]+)?%\)\s*$', '')), ''), 'payment') as n) x;
$$;
-- the client's phone as it may be shown to call (digits, spaces, + only)
create or replace function public._r445_phone(p_client jsonb)
returns text language sql immutable set search_path = '' as $$
  select case when length(regexp_replace(x.v, '[^0-9]', '', 'g')) between 7 and 15 then left(x.v, 24) end
    from (select btrim(regexp_replace(coalesce(p_client ->> 'phone', ''), '[^0-9+ -]', '', 'g')) as v) x;
$$;
-- " (the rest of Rs. 1,15,080)" when part of the payment is in
create or replace function public._r445_rest(p_milestone uuid, p_cur text)
returns text language sql stable security definer set search_path = '' as $$
  -- r258-0445
  select coalesce((select case when public._r443_left(m.id) < m.amount - 0.5 then ' (the rest of ' || public._comms_money(m.amount, p_cur) || ')' end
                     from public.payment_milestones m where m.id = p_milestone), '');
$$;

-- ---- 4) the reminder of the studio ----------------------------------------------------------------------------------------------------
create or replace function public._r445_text(p_client text, p_label text, p_left numeric, p_amount numeric, p_cur text, p_due date, p_today date, p_phone text, p_org uuid)
returns text language sql stable security definer set search_path = '' as $$
  -- r258-0445
  select left(coalesce(nullif(btrim(p_client), ''), 'The client') || '''s ' || public._r445_name(p_label)
    || case when p_left < p_amount - 0.5 then ': ' || public._r445_money(p_left, p_cur) || ' of ' || public._r445_money(p_amount, p_cur) || ' is left and ' else ' of ' || public._r445_money(p_left, p_cur) || ' ' end
    || case when p_due = p_today then 'is due today'
            when p_due = p_today + 1 then 'is due tomorrow'
            when p_due > p_today then 'is due on ' || public._comms_date(p_due, p_org)
            else 'was due on ' || public._comms_date(p_due, p_org) || ', ' || (p_today - p_due) || case when p_today - p_due = 1 then ' day' else ' days' end || ' late' end || '.'
    || case when p_phone is not null then ' Call ' || p_phone || ', or press Send reminder.' else ' Press Send reminder.' end, 300);
$$;

create or replace function public.payment_team_tick(p_now timestamptz default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r258-0445: every 15 minutes (pg_cron / service role). Nothing open near its date = one index lookup.
declare v_now timestamptz := coalesce(p_now, now()); r record; v_cfg jsonb; v_org uuid; v_on boolean := false; v_today date; v_slot text; v_left numeric;
  v_people jsonb; v_id uuid; v_sent integer := 0; v_cur text; v_text text; v_trial boolean;
begin
  for r in select m.id, m.org_id, m.quote_id, m.label, m.amount, m.due_date, q.code, q.client, coalesce(q.is_demo, false) as demo
             from public.payment_milestones m join public.quotes q on q.id = m.quote_id and q.org_id = m.org_id
            where m.status in ('due', 'invoiced') and m.due_date between (v_now at time zone 'UTC')::date - 181 and (v_now at time zone 'UTC')::date + 3
              and coalesce(m.amount, 0) > 0 and m.voided_at is null
              and q.deleted_at is null and q.archived_at is null and coalesce(q.status, '') <> 'cancelled' and coalesce(q.lifecycle_stage, '') <> 'closed'
            order by m.org_id, m.due_date, m.id limit 10000
  loop
    begin
      if v_org is distinct from r.org_id then                        -- the studio's own clock, setting and people: once per studio
        v_org := r.org_id; v_on := false; v_people := null;
        v_cfg := public._r445_cfg(v_org);
        if coalesce((v_cfg ->> 'on')::boolean, true) and not coalesce(public._trial_locked(v_org), false)
           and (v_now at time zone public.studio_timezone(v_org))::time >= (v_cfg ->> 'at')::time
           and public.send_window_next(v_org, 'staff', v_now) = v_now then
          v_on := true; v_today := (v_now at time zone public.studio_timezone(v_org))::date; v_trial := coalesce(public._is_trial_org(v_org), false);
        end if;
      end if;
      continue when not v_on;
      continue when r.demo and not v_trial;                          -- the sample event only shows reminders in a free trial
      v_slot := public._r445_slot(r.due_date, v_today);
      continue when v_slot is null or public._r435_held(r.quote_id);
      -- the studio switched the older overdue bell on and it already rang for this payment: the first late one is that bell
      continue when v_slot like 'late:%:0' and exists (select 1 from public.payment_overdue_alerts a where a.milestone_id = r.id and a.due_date = r.due_date);
      continue when exists (select 1 from public.payment_team_reminders t where t.milestone_id = r.id and t.slot = v_slot);
      v_left := public._r443_left(r.id);
      continue when v_left <= 0.5;
      if v_people is null then v_people := public._r445_people(v_org); end if;
      v_id := null;
      insert into public.payment_team_reminders(org_id, quote_id, milestone_id, slot, left_amount, people)
        values (v_org, r.quote_id, r.id, v_slot, v_left, jsonb_array_length(v_people))
        on conflict (milestone_id, slot) do nothing returning id into v_id;
      continue when v_id is null or jsonb_array_length(v_people) = 0;
      v_cur := coalesce(public._comms_quote_cur(r.quote_id), 'INR');
      v_text := public._r445_text(r.client ->> 'name', r.label, v_left, r.amount, v_cur, r.due_date, v_today, public._r445_phone(r.client), v_org);
      -- the client already said it is paid: check the account first
      if exists (select 1 from public.payment_claims c where c.milestone_id = r.id and c.status = 'open' and not public._r445_claim_done(c.id)) then
        v_text := regexp_replace(v_text, ' (Call [^,]*, or p|P)ress Send reminder\.$', ' The client says it is paid: check your account and record it.');
      end if;
      insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
        values (r.quote_id, 'in_app', 'payment_followup', 'simulated',
                jsonb_build_object('label', v_text, 'via', 'comms', 'source', '0445', 'milestone_id', r.id, 'event_code', r.code, 'due_date', r.due_date,
                                   'days', r.due_date - v_today, 'slot', split_part(v_slot, ':', 1), 'notify', v_people), v_org);
      v_sent := v_sent + 1;
    exception when others then raise warning 'r258-0445: payment % reminder skipped (%)', r.id, sqlstate;
    end;
  end loop;
  return jsonb_build_object('payment_followups', v_sent);
end $$;

-- a claim is done with when the studio recorded at least that much money after it, or nothing of the payment is left
create or replace function public._r445_claim_done(p_claim uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r258-0445
  select coalesce((select public._r443_left(c.milestone_id) <= 0.5
     or coalesce((select sum(p.amount) from public.quote_payments p where p.quote_id = c.quote_id and p.status = 'paid' and p.created_at > c.created_at), 0) >= c.amount - 0.5
    from public.payment_claims c where c.id = p_claim), true);
$$;

-- ---- 5) the bell, the inbox and its e-mails: the two new notices only for the people named on them --------------------------------------
do $do$
declare r record; v_def text; v_new text; e jsonb; v_ok boolean;
begin
  for r in select * from (values
    ('public._r388_vis(uuid,uuid)', jsonb_build_array(jsonb_build_array('(''task_escalated'', ''vendor_bill_due'', ''team_signin'')',
        '(''task_escalated'', ''vendor_bill_due'', ''team_signin'', ''payment_followup'', ''payment_claimed'' /* r258-0445 */)'))),
    ('public._r401_vis(uuid,uuid)', jsonb_build_array(jsonb_build_array('(''task_escalated'', ''vendor_bill_due'', ''team_signin'')',
        '(''task_escalated'', ''vendor_bill_due'', ''team_signin'', ''payment_followup'', ''payment_claimed'' /* r258-0445 */)'))),
    ('public._r23_important(text)', jsonb_build_array(jsonb_build_array('''payment_received'', ''payment'',', '''payment_received'', ''payment_followup'', ''payment_claimed'' /* r258-0445 */, ''payment'','))),
    ('public._r23_label(text,jsonb)', jsonb_build_array(jsonb_build_array('when ''payment'' then ''Payment update''',
        'when ''payment_followup'' then coalesce(nullif(d ->> ''label'', ''''), ''A client payment is due'') when ''payment_claimed'' then coalesce(nullif(d ->> ''label'', ''''), ''A client says a payment is paid'') /* r258-0445 */ when ''payment'' then ''Payment update'''))),
    ('public._comms_queue_pay(uuid,text,text,boolean,uuid)', jsonb_build_array(jsonb_build_array('public._comms_money(public._r443_left(m.id), public._comms_quote_cur(q.id)),',
        'public._comms_money(public._r443_left(m.id), public._comms_quote_cur(q.id)) || public._r445_rest(m.id, public._comms_quote_cur(q.id)) /* r258-0445 */,')))
  ) v(fn, edits) loop
    v_def := pg_get_functiondef(to_regprocedure(r.fn));
    if position('r258-0445' in v_def) > 0 then continue; end if;             -- already done (second run)
    v_new := v_def;
    for e in select y from jsonb_array_elements(r.edits) y loop
      if (length(v_new) - length(replace(v_new, e ->> 0, ''))) / length(e ->> 0) <> 1 then v_new := null; exit; end if;
      v_new := replace(v_new, e ->> 0, e ->> 1);
    end loop;
    if v_new is null then raise notice '0445: % has an unexpected body - left unchanged', r.fn; continue; end if;
    perform public._r445_keep(r.fn);
    execute v_new;
  end loop;
  if position('r258-0445' in pg_get_functiondef('public.notification_type_of(text,text)'::regprocedure)) = 0 then
    perform public._r445_keep('public.notification_type_of(text,text)');
    execute $fn$
create or replace function public.notification_type_of(p_kind text, p_channel text default null)
returns text language sql immutable security definer set search_path = '' as $f$
  -- r258-0445: both new notices follow the person's existing "Client payment overdue" choice (the r205-0383 rule kept below)
  select case when lower(btrim(coalesce(p_kind, ''))) in ('payment_followup', 'payment_claimed') then 'payment_overdue'
              else public.notification_type_of__pre0445(p_kind, p_channel) end;
$f$
$fn$;
  end if;
  if position('r258-0445' in pg_get_functiondef('public.bell_feed(integer)'::regprocedure)) = 0 then
    perform public._r445_keep('public.bell_feed(integer)');
    execute $fn$
create or replace function public.bell_feed(p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $f$
-- r258-0445: the kept bell (bell_feed__pre0445 = the r205-0383 body on the r190-0373 and r186-0369 ones) unchanged, minus payment_followup / payment_claimed rows the caller is not named on
declare v jsonb := public.bell_feed__pre0445(p_limit); v_uid text := auth.uid()::text; v_org uuid := public.current_org_id();
begin
  if v is null or jsonb_typeof(v -> 'items') <> 'array' then return v; end if;
  if not exists (select 1 from jsonb_array_elements(v -> 'items') e where e ->> 'kind' in ('payment_followup', 'payment_claimed')) then return v; end if;
  return jsonb_set(v, '{items}', coalesce((
    select jsonb_agg(e.i order by e.o)
      from jsonb_array_elements(v -> 'items') with ordinality e(i, o)
     where coalesce(e.i ->> 'kind', '') not in ('payment_followup', 'payment_claimed')
        or (v_uid is not null and exists (select 1 from public.notifications n
                                           where n.id::text = e.i ->> 'id' and n.org_id = v_org and jsonb_typeof(n.detail -> 'notify') = 'array'
                                             and (n.detail -> 'notify') ? v_uid))), '[]'::jsonb));
end $f$
$fn$;
  end if;
  -- direct reads of the table: only the people named on it; never written by the app
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notifications' and policyname = 'r445_pay_read') then
    create policy r445_pay_read on public.notifications as restrictive for select to authenticated
      using (coalesce(kind, '') not in ('payment_followup', 'payment_claimed')
             or (jsonb_typeof(detail -> 'notify') = 'array' and (detail -> 'notify') ? ((select auth.uid())::text)));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notifications' and policyname = 'r445_pay_ins') then
    create policy r445_pay_ins on public.notifications as restrictive for insert to authenticated
      with check (coalesce(kind, '') not in ('payment_followup', 'payment_claimed'));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notifications' and policyname = 'r445_pay_upd') then
    create policy r445_pay_upd on public.notifications as restrictive for update to authenticated
      using (coalesce(kind, '') not in ('payment_followup', 'payment_claimed'))
      with check (coalesce(kind, '') not in ('payment_followup', 'payment_claimed'));
  end if;
end $do$;

-- ---- 6) Settings: remind the studio (on / off + the time) --------------------------------------------------------------------------------
create or replace function public.payment_team_settings_get()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r258-0445
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not (public.has_area('controls', 'view') or public.has_area('finance', 'view')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  return public._r445_cfg(v_org) || jsonb_build_object('can_edit', public.has_area('controls', 'edit'));
end $$;
create or replace function public.payment_team_settings_set(p_on boolean, p_at text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r258-0445
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid();
begin
  if v_me is null or v_org is null or not public.has_area('controls', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_on is null then raise exception 'Choose on or off.' using errcode = '22023'; end if;
  if coalesce(p_at, '') !~ '^(0[89]|1[0-9]):(00|30)$' then raise exception 'Choose a time between 08:00 and 19:30.' using errcode = '22023'; end if;
  insert into public.payment_schedule_settings(org_id) values (v_org) on conflict (org_id) do nothing;
  update public.payment_schedule_settings s set team_remind = p_on, team_remind_at = p_at::time, updated_at = now(), updated_by = v_me where s.org_id = v_org;
  insert into public.audit_log(actor, action, entity, entity_id, changed, org_id)
    values (v_me, 'payment_schedule.settings', 'payment_schedule_settings', v_org::text, jsonb_build_object('team_remind', p_on, 'team_remind_at', p_at), v_org);
  return public.payment_team_settings_get();
end $$;

-- ---- 7) the studio's side of one event: last reminder, what the client says, where it can be sent -----------------------------------------
create or replace function public._r445_left_row(m public.payment_milestones)
returns boolean language sql stable security definer set search_path = '' as $$
  select m.status in ('due', 'invoiced') and coalesce(m.amount, 0) > 0 and m.voided_at is null and public._r443_left(m.id) > 0.5;
$$;
create or replace function public.payment_followup_get(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r258-0445: Finance view, own studio
declare v_org uuid := public.current_org_id(); q public.quotes; v_cfg jsonb; v_rows jsonb; v_wa boolean;
begin
  if auth.uid() is null or v_org is null or not public.has_area('finance', 'view') then raise exception 'not authorized' using errcode = '42501'; end if;
  select * into q from public.quotes x where x.id = p_quote and x.org_id = v_org;
  if q.id is null then raise exception 'event not found' using errcode = '42501'; end if;
  v_cfg := public._comms_cfg(v_org);
  v_wa := exists (select 1 from public.org_whatsapp_accounts a where a.org_id = v_org and a.status = 'connected');
  select coalesce(jsonb_object_agg(m.id::text, jsonb_strip_nulls(jsonb_build_object(
      'left', public._r443_left(m.id), 'open', public._r445_left_row(m),
      'reminder', (select jsonb_build_object('at', c.created_at, 'status', c.status, 'channel', c.channel,
                            'by', left(coalesce(nullif(btrim(p.full_name), ''), nullif(split_part(coalesce(p.email, ''), '@', 1), '')), 80))
                     from public.comms_outbox c left join public.profiles p on p.id = c.created_by and p.org_id = v_org
                    where c.quote_id = q.id and c.milestone_id = m.id and c.purpose = 'pay_reminder' and coalesce((c.payload ->> 'manual')::boolean, false)
                    order by c.created_at desc limit 1),
      'claim', (select jsonb_build_object('id', c.id, 'at', c.created_at, 'amount', c.amount, 'method', c.method, 'reference', c.reference, 'code', c.code_ok)
                  from public.payment_claims c where c.milestone_id = m.id and c.quote_id = q.id and c.status = 'open' and not public._r445_claim_done(c.id)),
      'told', (select max(t.created_at) from public.payment_team_reminders t where t.milestone_id = m.id)))), '{}'::jsonb)
    into v_rows from public.payment_milestones m where m.quote_id = q.id and m.org_id = v_org;
  return jsonb_build_object('rows', v_rows, 'team', public._r445_cfg(v_org), 'held', public._r435_held(q.id), 'live', public._comms_quote_live(q.id),
    'can_send', public.has_area('finance', 'edit') or public.has_area('quotes', 'edit'), 'can_edit', public.has_area('finance', 'edit'),
    'trial', public._tb179_no_send(v_org), 'demo', coalesce(q.is_demo, false), 'auto', coalesce((v_cfg ->> 'pay_enabled')::boolean, false),
    'phone', public._r445_phone(q.client), 'name', left(nullif(btrim(coalesce(q.client ->> 'name', '')), ''), 120), 'wa', v_wa);
end $$;

-- the exact words (and where they go) of "Send reminder to the client": made by the function that queues it, then taken back
create or replace function public.payment_reminder_preview(p_milestone uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r258-0445: nothing is queued, nothing is sent
declare v_org uuid := public.current_org_id(); m public.payment_milestones; q public.quotes; v_cfg jsonb; v_items jsonb := '[]'::jsonb; v_today date; v_txt text; v_n integer := 0; v_wa boolean;
begin
  if auth.uid() is null or v_org is null or not (public.has_area('finance', 'edit') or public.has_area('quotes', 'edit')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  perform public._tl173_guard();
  select * into m from public.payment_milestones x where x.id = p_milestone and x.org_id = v_org;
  if m.id is null then raise exception 'payment not found' using errcode = '42501'; end if;
  select * into q from public.quotes x where x.id = m.quote_id and x.org_id = v_org;
  if q.id is null then raise exception 'payment not found' using errcode = '42501'; end if;
  if not public._r445_left_row(m) then raise exception 'Nothing is left to pay on this payment.' using errcode = '22023'; end if;
  v_cfg := public._comms_cfg(v_org);
  if not exists (select 1 from unnest(public._comms_channels(v_cfg, 'pay_channels')) c where public._comms_client_to(q.client, c, v_org) is not null) then
    raise exception 'Add the client''s e-mail to the event first.' using errcode = '22023'; end if;
  v_today := public._pst_today(v_org);
  v_txt := case when m.due_date is null then 'due' when m.due_date < v_today then 'overdue' when m.due_date = v_today then 'due today' else 'due soon' end;
  begin
    v_n := public._comms_queue_pay(m.id, 'manual', v_txt, true, auth.uid());
    select coalesce(jsonb_agg(jsonb_build_object('channel', c.channel, 'to', c.recipient, 'subject', c.payload ->> 'subject', 'text', c.payload ->> 'text', 'status', c.status) order by c.channel), '[]'::jsonb)
      into v_items from public.comms_outbox c where c.milestone_id = m.id and c.purpose = 'pay_reminder' and c.dedupe_key like 'pay:now:%' and c.created_at = now();
    raise exception 'r258-undo' using errcode = 'P0445';              -- takes the queued rows back
  exception when sqlstate 'P0445' then null;
  end;
  v_wa := exists (select 1 from public.org_whatsapp_accounts a where a.org_id = v_org and a.status = 'connected');
  return jsonb_build_object('items', v_items, 'already', v_n = 0, 'wa', v_wa);
end $$;

-- the studio answers "Client says paid": not received (the client may say it again) or recorded
create or replace function public.payment_claim_close(p_claim uuid, p_status text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r258-0445
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); c public.payment_claims;
begin
  if v_me is null or v_org is null or not public.has_area('finance', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  if coalesce(p_status, '') not in ('recorded', 'not_received') then raise exception 'unknown answer' using errcode = '22023'; end if;
  update public.payment_claims x set status = p_status, closed_at = now(), closed_by = v_me,
         closed_name = (select left(coalesce(nullif(btrim(p.full_name), ''), nullif(split_part(coalesce(p.email, ''), '@', 1), '')), 80) from public.profiles p where p.id = v_me)
   where x.id = p_claim and x.org_id = v_org and x.status = 'open' returning * into c;
  if c.id is null then
    if exists (select 1 from public.payment_claims x where x.id = p_claim and x.org_id = v_org) then return jsonb_build_object('closed', true, 'already', true); end if;
    raise exception 'notice not found' using errcode = '42501';
  end if;
  insert into public.audit_log(actor, action, entity, entity_id, quote_id, changed, org_id)
    values (v_me, 'payment_claim.' || p_status, 'payment_claims', c.id::text, c.quote_id, jsonb_build_object('amount', c.amount, 'milestone_id', c.milestone_id), v_org);
  return jsonb_build_object('closed', true);
end $$;

-- ---- 8) the client's "Pay this payment" step (the event's own private link) -----------------------------------------------------------------
-- the event of a link, when the step may be used: a live link, approved / confirmed, not cancelled / closed, not a trial / sample event
create or replace function public._r445_quote(p_token uuid)
returns public.quotes language plpgsql stable security definer set search_path = '' as $$
-- r258-0445
declare v_q uuid := public._wa151_token_quote(p_token); q public.quotes;
begin
  if v_q is null then return null; end if;
  select * into q from public.quotes x where x.id = v_q;
  if not public._comms_quote_live(q.id) or public._r435_held(q.id) or coalesce(q.is_demo, false) or public._tb179_no_send(q.org_id) then return null; end if;
  return q;
end $$;
-- the payments the client may pay now: the first open one, and every open one that is due
create or replace function public._r445_payable(p_quote uuid)
returns setof public.payment_milestones language sql stable security definer set search_path = '' as $$
  select (x.m).* from (
    select m, row_number() over (order by m.due_date nulls last, m.seq, m.created_at, m.id) as n, public._pst_today(m.org_id) as today
      from public.payment_milestones m where m.quote_id = p_quote and public._r445_left_row(m)) x
   where x.n = 1 or (x.m).due_date <= x.today;
$$;
-- where a code can go: the contact on the event only, shown masked
create or replace function public._r445_channels(p_quote uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- r258-0445
  select jsonb_strip_nulls(jsonb_build_object(
    'email', case when x.em ~ '^[^\s@<>"'',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$' then left(split_part(x.em, '@', 1), 1) || '***@' || split_part(x.em, '@', 2) end,
    'whatsapp', case when x.ph is not null and exists (select 1 from public.org_whatsapp_accounts a where a.org_id = x.org and a.status = 'connected')
                     then '+' || repeat('*', greatest(0, length(x.ph) - 5)) || right(x.ph, 4) end))
    from (select btrim(coalesce(q.client ->> 'email', '')) as em, public._wa151_quote_e164(q.id) as ph, q.org_id as org from public.quotes q where q.id = p_quote) x;
$$;
-- is a code asked for? Only once the code sender of this database really sent one (send-otp of R258): before that nobody could get one.
create or replace function public._r445_code_needed(p_quote uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public._r445_channels(p_quote) <> '{}'::jsonb and exists (select 1 from public.payment_codes k where k.sent_at is not null);
$$;

create or replace function public.public_payment_steps(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r258-0445: the link is checked first (public_get_quote: expired / cancelled / limits); this one event only
declare q public.quotes; v_rows jsonb; v_pay jsonb;
begin
  perform public._r341_limit('pay_steps', 600, 240);
  perform public.public_get_quote(p_token);
  q := public._r445_quote(p_token);
  if q.id is null then return jsonb_build_object('on', false); end if;
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', m.id, 'label', m.label, 'due_date', m.due_date, 'amount', m.amount, 'left', public._r443_left(m.id),
           'claim', (select jsonb_build_object('at', c.created_at, 'amount', c.amount, 'reference', c.reference) from public.payment_claims c
                      where c.milestone_id = m.id and c.status = 'open' and not public._r445_claim_done(c.id))))
           order by m.due_date nulls last, m.seq, m.created_at, m.id), '[]'::jsonb)
    into v_rows from public._r445_payable(q.id) m;
  v_pay := public._pst_pay_details(q.id);
  return jsonb_build_object('on', jsonb_array_length(v_rows) > 0, 'rows', v_rows, 'today', public._pst_today(q.org_id), 'channels', public._r445_channels(q.id),
    'code', public._r445_code_needed(q.id), 'pay', case when v_pay ->> 'upi' is null and v_pay ->> 'note' is null then null else v_pay - 'link' end);
end $$;

-- send-otp (service role): may a payment code go out, and where to? { id, quote_id, email | to, masked }
create or replace function public.payment_code_begin(p_token uuid, p_milestone uuid, p_channel text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r258-0445
declare q public.quotes; v_ch jsonb; v_last timestamptz; v_n30 integer; v_n24 integer; v_day integer; v_id uuid; v_e164 text;
begin
  if p_channel is null or p_channel not in ('email', 'whatsapp') then raise exception 'bad channel' using errcode = '22023'; end if;
  q := public._r445_quote(p_token);
  if q.id is null then raise exception 'invalid link' using errcode = 'HL404'; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:paycode:' || q.id::text, 0));
  if not exists (select 1 from public._r445_payable(q.id) m where m.id = p_milestone) then raise exception 'nothing to pay' using errcode = 'HL404'; end if;
  v_ch := public._r445_channels(q.id);
  if not (v_ch ? p_channel) then raise exception 'no contact on file' using errcode = 'HL403'; end if;
  select max(k.created_at), count(*) filter (where k.created_at > now() - interval '30 minutes'), count(*)
    into v_last, v_n30, v_n24 from public.payment_codes k where k.quote_id = q.id and k.created_at > now() - interval '24 hours';
  select count(*) into v_day from public.payment_codes k where k.org_id = q.org_id and k.created_at > now() - interval '24 hours';
  if v_last > now() - interval '30 seconds' or v_n30 >= 4 or v_n24 >= 10 or v_day >= 200 then raise exception 'too many codes' using errcode = 'HL429'; end if;
  update public.payment_codes k set expires_at = now() where k.quote_id = q.id and k.verified_at is null and k.expires_at > now();   -- one live code per event
  insert into public.payment_codes(org_id, quote_id, milestone_id, channel, expires_at) values (q.org_id, q.id, p_milestone, p_channel, now() + interval '10 minutes') returning id into v_id;
  v_e164 := public._wa151_quote_e164(q.id);
  return jsonb_build_object('id', v_id, 'quote_id', q.id, 'org_id', q.org_id, 'masked', v_ch ->> p_channel, 'resends_left', greatest(0, 3 - v_n30))
    || case when p_channel = 'email' then jsonb_build_object('email', btrim(q.client ->> 'email')) else jsonb_build_object('to', substr(v_e164, 2)) end;
end $$;
create or replace function public.payment_code_set(p_id uuid, p_code text)
returns void language plpgsql volatile security definer set search_path = '' as $$
-- r258-0445: the hash only
begin
  if coalesce(p_code, '') !~ '^[0-9]{6}$' then raise exception 'bad code' using errcode = '22023'; end if;
  update public.payment_codes k set code_hash = extensions.crypt(p_code, extensions.gen_salt('bf'))
   where k.id = p_id and k.code_hash is null and k.verified_at is null and k.expires_at > now();
  if not found then raise exception 'no open code' using errcode = 'HL404'; end if;
end $$;

create or replace function public.payment_code_sent(p_id uuid)
returns void language sql volatile security definer set search_path = '' as $$
  -- r258-0445: it really went out
  update public.payment_codes k set sent_at = now() where k.id = p_id and k.code_hash is not null and k.sent_at is null;
$$;

create or replace function public.public_payment_code_verify(p_token uuid, p_milestone uuid, p_code text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r258-0445: 5 tries, 10 minutes, once. Never touches quote_otps / quote_consents / the approval.
declare q public.quotes; k public.payment_codes; v_proof uuid;
begin
  perform public._r341_limit('pay_code', 600, 60);
  perform public.public_get_quote(p_token);
  q := public._r445_quote(p_token);
  if q.id is null then raise exception 'invalid link' using errcode = '42501'; end if;
  select * into k from public.payment_codes x where x.quote_id = q.id and x.milestone_id = p_milestone and x.code_hash is not null and x.verified_at is null and x.expires_at > now()
   order by x.created_at desc limit 1 for update;
  if k.id is null then return jsonb_build_object('ok', false, 'error', 'no_active_code'); end if;
  if k.attempts >= 5 then return jsonb_build_object('ok', false, 'error', 'locked'); end if;
  if p_code is null or extensions.crypt(p_code, k.code_hash) is distinct from k.code_hash then
    update public.payment_codes x set attempts = x.attempts + 1 where x.id = k.id;
    return jsonb_build_object('ok', false, 'error', 'incorrect_code', 'remaining', greatest(0, 4 - k.attempts));
  end if;
  v_proof := gen_random_uuid();
  update public.payment_codes x set verified_at = now(), proof = v_proof where x.id = k.id;
  return jsonb_build_object('ok', true, 'proof', v_proof);
end $$;

create or replace function public.public_payment_claim(p_token uuid, p_milestone uuid, p_amount numeric, p_method text, p_reference text default null, p_proof uuid default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r258-0445: "I have paid" = a notice to the studio. No money is recorded, no payment / milestone row is touched.
declare q public.quotes; m public.payment_milestones; v_ref text; v_ok boolean := false; v_id uuid; v_people jsonb; v_cur text; v_max numeric; c public.payment_claims; v_k uuid;
begin
  perform public._r341_limit('pay_claim', 600, 30);
  perform public.public_get_quote(p_token);
  q := public._r445_quote(p_token);
  if q.id is null then raise exception 'invalid link' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:payclaim:' || q.id::text, 0));
  select x.* into m from public._r445_payable(q.id) x where x.id = p_milestone;
  if m.id is null then raise exception 'This payment is not open any more. Please reload the page.' using errcode = '22023'; end if;
  if coalesce(p_method, '') not in ('upi', 'bank', 'cash', 'card', 'other') then raise exception 'Choose how you paid.' using errcode = '22023'; end if;
  v_ref := nullif(left(btrim(regexp_replace(regexp_replace(coalesce(p_reference, ''), '[<>[:cntrl:]]', ' ', 'g'), '\s+', ' ', 'g')), 80), '');
  if p_method in ('upi', 'bank') and v_ref is null then raise exception 'Enter the reference number of your payment.' using errcode = '22023'; end if;
  select sum(public._r443_left(x.id)) into v_max from public.payment_milestones x where x.quote_id = q.id and public._r445_left_row(x);
  if p_amount is null or not (p_amount > 0) or p_amount > coalesce(v_max, 0) + 0.5 or p_amount >= 1000000000 then
    raise exception 'Enter the amount you paid (not more than what is left to pay).' using errcode = '22023'; end if;
  select * into c from public.payment_claims x where x.milestone_id = m.id and x.status = 'open';
  if c.id is not null and not public._r445_claim_done(c.id) then
    return jsonb_build_object('ok', true, 'already', true, 'at', c.created_at, 'amount', c.amount); end if;
  if (select count(*) from public.payment_claims x where x.quote_id = q.id and x.created_at > now() - interval '24 hours') >= 6 then
    raise exception 'You already told your planner several times today. Please call them.' using errcode = '22023'; end if;
  if p_proof is not null then
    select k.id into v_k from public.payment_codes k where k.quote_id = q.id and k.milestone_id = m.id and k.proof = p_proof and k.used_at is null and k.verified_at > now() - interval '2 hours' for update;
    v_ok := v_k is not null;
  end if;
  if not v_ok and public._r445_code_needed(q.id) then
    raise exception 'Please confirm with the one-time code first.' using errcode = '22023', hint = 'code_needed'; end if;
  if v_k is not null then update public.payment_codes k set used_at = now() where k.id = v_k; end if;
  if c.id is not null then update public.payment_claims x set status = 'recorded', closed_at = now() where x.id = c.id; end if;   -- an answered one (money recorded after it)
  insert into public.payment_claims(org_id, quote_id, milestone_id, amount, method, reference, code_ok)
    values (q.org_id, q.id, m.id, round(p_amount, 2), p_method, v_ref, v_ok) returning id into v_id;
  insert into public.audit_log(actor, action, entity, entity_id, quote_id, changed, org_id)
    values (null, 'payment_claim.client_says_paid', 'payment_claims', v_id::text, q.id, jsonb_build_object('amount', round(p_amount, 2), 'method', p_method, 'code', v_ok), q.org_id);
  v_people := public._r445_people(q.org_id); v_cur := coalesce(public._comms_quote_cur(q.id), 'INR');
  if jsonb_array_length(v_people) > 0 then
    begin
      insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
        values (q.id, 'in_app', 'payment_claimed', 'simulated', jsonb_build_object(
          'label', left(coalesce(nullif(btrim(q.client ->> 'name'), ''), 'The client') || ' says ' || public._r445_money(p_amount, v_cur) || ' of the ' || public._r445_name(m.label) || ' is paid'
                        || coalesce(' (reference ' || v_ref || ')', '') || '. Check your account, then record it.' || case when v_ok then '' else ' Not confirmed with a code.' end, 300),
          'via', 'comms', 'source', '0445', 'milestone_id', m.id, 'claim_id', v_id, 'event_code', q.code, 'notify', v_people), q.org_id);
    exception when others then raise warning 'r258-0445: bell notice skipped (%)', sqlstate;
    end;
  end if;
  return jsonb_build_object('ok', true, 'at', now(), 'amount', round(p_amount, 2));
end $$;

-- ---- 9) grants: helpers and kept bodies server only; staff functions signed-in only; the three link functions also signed out ------------------
do $$ declare p record; r text; begin
  for p in select x.oid::regprocedure::text as f, x.proname as n from pg_proc x where x.pronamespace = 'public'::regnamespace
     and (x.proname like '\_r445\_%' or x.proname like '%\_\_pre0445' or x.proname in ('payment_team_tick', 'payment_code_begin', 'payment_code_set', 'payment_code_sent', 'payment_team_settings_get',
          'payment_team_settings_set', 'payment_followup_get', 'payment_reminder_preview', 'payment_claim_close', 'public_payment_steps', 'public_payment_code_verify', 'public_payment_claim')) loop
    execute format('revoke all on function %s from public', p.f);
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if not exists (select 1 from pg_roles where rolname = r) then continue; end if;
      execute format('revoke all on function %s from %I', p.f, r);
      if p.n in ('payment_team_tick', 'payment_code_begin', 'payment_code_set', 'payment_code_sent') then
        if r = 'service_role' then execute format('grant execute on function %s to %I', p.f, r); end if;
      elsif p.n like 'public\_%' then execute format('grant execute on function %s to %I', p.f, r);
      elsif p.n not like '\_r445\_%' and p.n not like '%\_\_pre0445' and r = 'authenticated' then execute format('grant execute on function %s to %I', p.f, r);
      end if;
    end loop;
  end loop;
end $$;

-- ---- 10) pg_cron, ONLY if it is already installed (never created here): every 15 minutes, away from the other quarter-hour jobs --------------------
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      if not exists (select 1 from cron.job where jobname = 'helm_payment_team_tick') then
        perform cron.schedule('helm_payment_team_tick', '4,19,34,49 * * * *', 'select public.payment_team_tick()'); end if;
    exception when others then raise notice 'pg_cron present but helm_payment_team_tick could not be scheduled (%); schedule it by hand', sqlerrm;
    end;
  end if;
end $$;

do $$ begin
  if to_regclass('public.helm_schema_markers') is not null then
    insert into public.helm_schema_markers(num, name) values (445, '0445_r258_payment_followup') on conflict (num) do nothing;
  end if;
end $$;

notify pgrst, 'reload schema';

-- ---- 11) CHECK (read only): every row must say true ------------------------------------------------------------------------------------------------
select c.check, c.ok from (values
  ('01 the three tables are server only', (select count(*) = 3 and bool_and(t.relrowsecurity) and not bool_or(has_table_privilege('anon', t.oid, 'select') or has_table_privilege('authenticated', t.oid, 'select')
      or has_table_privilege('authenticated', t.oid, 'insert')) from pg_class t where t.relnamespace = 'public'::regnamespace and t.relname in ('payment_team_reminders', 'payment_claims', 'payment_codes'))),
  ('02 automatic client reminders are off unless a studio switched them on', (public._comms_cfg('00000000-0000-0000-0000-000000000000') ->> 'pay_enabled') = 'false'),
  ('03 and a new settings row starts with them off', (select position('false' in pg_get_expr(d.adbin, d.adrelid)) > 0 from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
      where d.adrelid = 'public.comms_settings'::regclass and a.attname = 'pay_enabled')),
  ('04 the studio is reminded at 10:00 unless it says otherwise', public._r445_cfg('00000000-0000-0000-0000-000000000000') = '{"on": true, "at": "10:00"}'::jsonb),
  ('05 the bell and the inbox know the two notices', position('r258-0445' in pg_get_functiondef('public._r388_vis(uuid,uuid)'::regprocedure)) > 0
      and position('r258-0445' in pg_get_functiondef('public._r401_vis(uuid,uuid)'::regprocedure)) > 0 and position('r258-0445' in pg_get_functiondef('public.bell_feed(integer)'::regprocedure)) > 0
      and public.notification_type_of('payment_followup', 'in_app') = 'payment_overdue' and public.notification_type_of('payment_claimed', 'in_app') = 'payment_overdue'),
  ('06 only the people named read them, the app never writes them', (select count(*) = 3 from pg_policies where schemaname = 'public' and tablename = 'notifications' and policyname like 'r445\_pay\_%')),
  ('07 instant inbox e-mails know them', public._r23_important('payment_followup') and public._r23_important('payment_claimed') and public._r23_label('payment_followup', '{"label":"x"}'::jsonb) = 'x'),
  ('08 a part-paid reminder says the rest', position('_r445_rest(m.id' in pg_get_functiondef('public._comms_queue_pay(uuid,text,text,boolean,uuid)'::regprocedure)) > 0),
  ('09 Sunday is skipped, every 3 days late', public._r445_slot('2026-11-16', '2026-11-14') = 'before:2026-11-16' and public._r445_slot('2026-11-16', '2026-11-13') is null
      and public._r445_slot('2026-11-16', '2026-11-16') = 'due:2026-11-16' and public._r445_slot('2026-11-16', '2026-11-19') = 'late:2026-11-16:0' and public._r445_slot('2026-11-16', '2026-11-20') = 'late:2026-11-16:1'),
  ('10 the link functions answer signed-out people, the code makers never', has_function_privilege('anon', 'public.public_payment_steps(uuid)', 'execute') and has_function_privilege('anon', 'public.public_payment_claim(uuid,uuid,numeric,text,text,uuid)', 'execute')
      and has_function_privilege('anon', 'public.public_payment_code_verify(uuid,uuid,text)', 'execute') and not has_function_privilege('anon', 'public.payment_code_begin(uuid,uuid,text)', 'execute')
      and not has_function_privilege('authenticated', 'public.payment_code_set(uuid,text)', 'execute')),
  ('11 helpers and kept bodies are server only, search_path pinned', (select count(*) >= 20 and bool_and(not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute'))
      and bool_and(coalesce(p.proconfig @> array['search_path=""'], false)) from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like '\_r445\_%' or p.proname like '%\_\_pre0445'))),
  ('12 the timer is scheduled (or this database has no pg_cron)', has_function_privilege('service_role', 'public.payment_team_tick(timestamptz)', 'execute') and not has_function_privilege('authenticated', 'public.payment_team_tick(timestamptz)', 'execute')
      and case when to_regclass('cron.job') is null then true
               else (xpath('//n/text()', query_to_xml('select count(*) as n from cron.job where jobname = ''helm_payment_team_tick''', false, true, '')))[1]::text = '1' end)
) c("check", ok);
