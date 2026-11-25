-- 0440_r255_tasks_crew.sql - R255 (owner's live test of event 11252026-01, 25 Nov 2026). Forward-only, additive, safe to run twice. ASCII only.
-- REQUIRES 0283, 0363, 0410, 0434, 0436. Paste the whole file in the Supabase SQL editor; the last statement answers one row per check.
--
-- In plain words:
--   A  E-MAIL TIMING. A change notice waits 5 quiet minutes (15 at most) so several changes make one e-mail (0363). "You can start now"
--      (0434) asked for "now", but any later change of the same person's work (accepted by the office, another task cancelled) moved
--      the whole e-mail 5 minutes back again. 0440: a notice that is due, or that carries "You can start now" / "You can go on now" /
--      "Please hold" / "Cancelled" / "No longer yours", is never pushed back. "Cancelled" and "No longer yours" wait 1 minute (so
--      cancelling several tasks still makes one e-mail), every other change still 5 minutes.
--      "You can start now" also wakes the sender at once (0410: needs the Vault secrets helm_comms_secret + helm_functions_base_url,
--      at most once per 20 seconds). Without them the e-mail goes with the sender's own timer, as before.
--   B  WORDS. Accepting a task for somebody says "Stairs: accepted for you by the office" (was "status changed from Assigned to
--      Accepted by the office"), and the line is left out of an e-mail that says "You can start now" for the same task.
--   C  DEACTIVATED LOGINS. A staff record whose login is deactivated (Settings -> Users) cannot be given new work: crew_login_off()
--      tells the pages which staff records that is (Staff view), and a task given to one is refused. The link is the record's own
--      login (crew_members.profile_id); only a record with no link is matched by the same e-mail in the same studio.
--      Tasks they already have stay as they are.
--   D  EXTRAS. event_extras: what was added on the day (extra food, an extra table): what, how many, cost, who asked, who approved,
--      time, note. Never deleted (cancelled with a reason). It NEVER changes the bill, the budget or a payment: at Wrap-up somebody
--      marks each one "bill to client" or "our cost" - a note for the people who do the money.
--      Issues - Can view / Can change; the cost is shown to Budget view and to the person who typed it; the mark needs Budget - Can change.
-- ZERO DATA LOSS: 1 new table, functions, 1 trigger. No stored row is changed. Bodies replaced are kept (<name>__pre0440).
-- SWITCH OFF (nothing deleted): alter table public.event_tasks disable trigger zz_r440_login_off;
-- ROLLBACK (manual): create _r363_note, _r363_tg_task_changed, _r436_mail, staff_update_claim again from their kept copies (<name>__pre0440; _r436_mail: _r440_kept_mail).
--   If 0363 or 0436 is ever pasted again after this file, paste this file again.

-- ---- 0) preflight -----------------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  if to_regclass('public.staff_update_outbox') is null or to_regclass('public.task_start_notices') is null then
    raise exception 'STOP 0440: run 0363 and 0436 first'; end if;
  foreach f in array array['public._r363_note(uuid,uuid,uuid,text,text[],boolean)', 'public._r363_tg_task_changed()',
      'public._r436_mail(uuid,uuid,uuid,text,text)', 'public._r436_keep(text,text)', 'public._r436_mail_items(uuid,jsonb)',
      'public.staff_update_claim(integer)', 'public.staff_update_claim__pre0436(integer)', 'public._r410_wake(text)',
      'public._r283_is_off(uuid,uuid)', 'public._r283_off_email(uuid,text)', 'public._is_system_change()', 'public.has_area(text,text)',
      'public.current_org_id()'] loop
    if to_regprocedure(f) is null then raise exception 'STOP 0440: % is missing - an earlier update is not on this database', f; end if;
  end loop;
end $$;

-- ---- 1) keep the bodies that are replaced (once) ---------------------------------------------------------------------------------
do $$ declare r record; begin
  for r in select * from (values
    ('public._r363_note(uuid,uuid,uuid,text,text[],boolean)', '_r363_note__pre0440'),
    ('public._r363_tg_task_changed()', '_r363_tg_task_changed__pre0440'),
    ('public._r436_mail(uuid,uuid,uuid,text,text)', '_r440_kept_mail'),
    ('public.staff_update_claim(integer)', 'staff_update_claim__pre0440')) v(fn, nm) loop
    if position('r255-0440' in pg_get_functiondef(to_regprocedure(r.fn))) = 0 then perform public._r436_keep(r.fn, r.nm); end if;
  end loop;
end $$;

-- ---- 2) which lines a person must know now; which lines say nothing ---------------------------------------------------------------
create or replace function public._r440_fast(p_changes jsonb)
returns boolean language sql immutable set search_path = '' as $$
  -- r255-0440
  select jsonb_typeof(p_changes) = 'array' and exists (
    select 1 from jsonb_array_elements_text(p_changes) c(v) where c.v ~ '^(You can start now|You can go on now|Please hold|Cancelled|No longer yours): ');
$$;
create or replace function public._r440_tidy(p_changes jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  -- r255-0440: the titles of 0436's start lines are cut at 70 characters
  with l as (select v, o, case when v ~ ': accepted for you by the office$' then regexp_replace(v, ': accepted for you by the office$', '')
                               when v ~ ': status changed from Assigned to Accepted by the office$' then regexp_replace(v, ': status changed from Assigned to Accepted by the office$', '') end as t
               from jsonb_array_elements_text(p_changes) with ordinality a(v, o))
  select coalesce(jsonb_agg(l.v order by l.o), '[]'::jsonb) from l
   where l.t is null or not exists (select 1 from l s where left(s.v, length('You can start now: ' || left(l.t, 70) || ' - ')) = 'You can start now: ' || left(l.t, 70) || ' - ');
$$;

-- ---- 3) the waiting notice: never pushed back when it is due or urgent (0363 body, two edits) ------------------------------------------
create or replace function public._r363_note(p_org uuid, p_quote uuid, p_crew uuid, p_phone text, p_lines text[], p_cancelled boolean default false)
returns void language plpgsql volatile security definer set search_path = '' as $fn$
-- r172-0363 r255-0440
declare v_p jsonb; v_phone text := public._assign132_phone(p_phone); v_new jsonb; v_lines text[]; v_fast boolean;
begin
  begin
    select coalesce(array_agg(left(btrim(x), 200)), '{}') into v_lines from unnest(p_lines) x where nullif(btrim(coalesce(x, '')), '') is not null;
    if coalesce(array_length(v_lines, 1), 0) = 0 then return; end if;
    if not public._r361_on(p_org) or not public._r363_can(p_org, p_quote, p_cancelled) then return; end if;
    v_p := public._r361_person(p_org, p_crew, v_phone);
    if v_p is null then return; end if;
    -- the "new work for you" e-mail still waiting for this person and event already shows the latest state
    if exists (select 1 from public.staff_email_outbox o where o.quote_id = p_quote and o.recipient = v_p ->> 'email'
                 and o.kind = 'task_assigned' and o.status = 'pending' and o.sent_at is null) then return; end if;
    v_new := to_jsonb(v_lines);
    v_fast := coalesce(p_cancelled, false) or public._r440_fast(v_new);
    insert into public.staff_update_outbox as u (org_id, quote_id, crew_id, phone, recipient, name, changes, change_count, cancelled, not_before)
    values (p_org, p_quote, (v_p ->> 'crew_id')::uuid, v_phone, v_p ->> 'email', left(v_p ->> 'name', 120), v_new,
            jsonb_array_length(v_new), coalesce(p_cancelled, false), now() + case when v_fast then interval '1 minute' else interval '5 minutes' end)
    on conflict (quote_id, recipient) where status = 'pending' and sent_at is null and claimed_at is null
    do update set
      changes = (select coalesce(jsonb_agg(z.v order by z.o), '[]'::jsonb) from (
                   select x.v, min(x.o) as o from (
                     select v, o from jsonb_array_elements(u.changes) with ordinality a(v, o)
                     union all
                     select v, 1000 + o from jsonb_array_elements(excluded.changes) with ordinality b(v, o)) x
                   group by x.v order by min(x.o) limit 30) z),
      change_count = u.change_count + excluded.change_count,
      cancelled = u.cancelled or excluded.cancelled,
      last_at = now(),
      -- r255-0440: a notice that is already due, or carries a line the person must know now, is never pushed back
      not_before = case when u.not_before <= now() then u.not_before
                        when v_fast or u.cancelled or public._r440_fast(u.changes) then least(u.not_before, now() + interval '1 minute')
                        else least(u.first_at + interval '15 minutes', now() + interval '5 minutes') end,
      updated_at = now();
  exception when others then
    raise warning 'r172-0363: change notice not queued (%)', sqlstate;
  end;
end $fn$;

-- ---- 4) the words of "accepted by the office" (0363 body, one line added) -------------------------------------------------------------
create or replace function public._r363_tg_task_changed()
returns trigger language plpgsql security definer set search_path = '' as $fn$
-- r172-0363 r255-0440: never makes the save fail
declare v_actor uuid := auth.uid(); v_lines text[] := '{}'; v_title text; v_old_phone text; v_new_phone text;
        v_label jsonb := '{"assigned":"Assigned","accepted":"Accepted","in_progress":"In progress","completed":"Done","rejected":"Declined","cancelled":"Cancelled"}';
begin
  begin
    if v_actor is null then return null; end if;   -- worker links, timers, system jobs: quiet
    if coalesce(old.assignee_kind, 'in_house') <> 'in_house' and coalesce(new.assignee_kind, 'in_house') <> 'in_house' then return null; end if;
    v_old_phone := public._assign132_phone(old.assignee_phone);
    v_new_phone := public._assign132_phone(new.assignee_phone);
    -- the person the task is for, acting on it with their own login: quiet
    if exists (select 1 from public.crew_members cm where cm.org_id = new.org_id and cm.profile_id = v_actor
                 and (cm.id = old.crew_id or cm.id = new.crew_id
                      or (public._assign132_phone(cm.phone) is not null and public._assign132_phone(cm.phone) in (v_old_phone, v_new_phone)))) then
      return null; end if;
    v_title := left(coalesce(nullif(btrim(new.title), ''), old.title, 'a task'), 120);
    -- given to someone else: the previous person is told (the new person gets the 0361 "new work" e-mail)
    if (old.crew_id, v_old_phone) is distinct from (new.crew_id, v_new_phone) then
      if coalesce(old.assignee_kind, 'in_house') = 'in_house' and old.status not in ('completed', 'cancelled', 'rejected')
         and (old.crew_id is not null or v_old_phone is not null) then
        perform public._r363_note(old.org_id, old.quote_id, old.crew_id, v_old_phone, array['No longer yours: ' || v_title]);
      end if;
      return null;
    end if;
    if coalesce(new.assignee_kind, 'in_house') <> 'in_house' or (new.crew_id is null and v_new_phone is null) then return null; end if;
    -- edits to a task that was already closed and stays closed: quiet
    if old.status in ('completed', 'cancelled', 'rejected') and new.status = old.status then return null; end if;
    if new.title is distinct from old.title then
      v_lines := v_lines || ('Renamed: "' || left(coalesce(old.title, ''), 100) || '" is now "' || left(coalesce(new.title, ''), 100) || '"'); end if;
    if new.planned_start is distinct from old.planned_start then
      v_lines := v_lines || (v_title || ': start time changed from ' || public._r363_when(old.planned_start, new.org_id) || ' to ' || public._r363_when(new.planned_start, new.org_id)); end if;
    if new.planned_end is distinct from old.planned_end then
      v_lines := v_lines || (v_title || ': finish time changed from ' || public._r363_when(old.planned_end, new.org_id) || ' to ' || public._r363_when(new.planned_end, new.org_id)); end if;
    if new.note is distinct from old.note then
      v_lines := v_lines || (v_title || ': instructions updated'); end if;
    if new.category is distinct from old.category then
      v_lines := v_lines || (v_title || ': moved to ' || left(coalesce(new.category, ''), 60)); end if;
    if new.status is distinct from old.status then
      if new.status = 'cancelled' then v_lines := v_lines || ('Cancelled: ' || v_title);
      elsif old.status in ('completed', 'cancelled', 'rejected') then v_lines := v_lines || ('Opened again: ' || v_title);
      elsif old.status = 'assigned' and new.status = 'accepted' then v_lines := v_lines || (v_title || ': accepted for you by the office');   -- r255-0440
      else v_lines := v_lines || (v_title || ': status changed from ' || coalesce(v_label ->> old.status, old.status) || ' to ' || coalesce(v_label ->> new.status, new.status) || ' by the office');
      end if;
    end if;
    if coalesce(array_length(v_lines, 1), 0) > 0 then
      perform public._r363_note(new.org_id, new.quote_id, new.crew_id, v_new_phone, v_lines);
    end if;
  exception when others then
    raise warning 'r172-0363: task change not noted (%)', sqlstate;
  end;
  return null;
end $fn$;

-- ---- 5) "You can start now" wakes the sender (0436 body + the wake) -------------------------------------------------------------------
create or replace function public._r436_mail(p_org uuid, p_quote uuid, p_crew uuid, p_phone text, p_line text)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
-- r253-0436 r255-0440
declare v_p jsonb; v_st text; v_id uuid;
begin
  if not public._r361_on(p_org) or not public._r363_can(p_org, p_quote, false) then return null; end if;
  v_p := public._r361_person(p_org, p_crew, p_phone);
  if v_p is null then return null; end if;
  insert into public.staff_update_outbox as u (org_id, quote_id, crew_id, phone, recipient, name, changes, change_count, not_before)
  values (p_org, p_quote, (v_p ->> 'crew_id')::uuid, p_phone, v_p ->> 'email', left(v_p ->> 'name', 120),
          jsonb_build_array(left(p_line, 200)), 1, now())
  on conflict (quote_id, recipient) where status = 'pending' and sent_at is null and claimed_at is null
  do update set
    changes = case when u.changes @> excluded.changes then u.changes
                   else (select coalesce(jsonb_agg(z.v order by z.o), '[]'::jsonb) from (
                           select v, o from jsonb_array_elements(excluded.changes || u.changes) with ordinality a(v, o) order by o limit 30) z) end,
    change_count = u.change_count + case when u.changes @> excluded.changes then 0 else 1 end,
    last_at = now(), not_before = now(), updated_at = now()
  returning u.status, u.id into v_st, v_id;
  if v_st = 'pending' then
    -- r255-0440: wake the sender now instead of waiting for its timer (at most once per 20 s; after the commit; never raises)
    begin perform public._r410_wake('comms-dispatch'); exception when others then null; end;
    return v_id;
  end if;
  return null;
exception when others then
  raise warning 'r253-0436: e-mail not queued (%)', sqlstate;
  return null;
end $$;

-- ---- 6) the claim (0436 body + the tidy step) -----------------------------------------------------------------------------------------
create or replace function public.staff_update_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r253-0436 r255-0440: lines of "you can start now" / "please hold" that are no longer true are taken out of the waiting notice (a notice with
-- nothing left is skipped by the kept claim: nothing_changed), then the r172-0363 claim unchanged (kept as staff_update_claim__pre0436,
-- with its 0402 try limit _r342_max_attempts());
-- each answered notice also carries start_now = the facts of its start / hold lines. An older sender ignores that field.
declare r record; v_new jsonb; v jsonb;
begin
  begin
    for r in select u.* from public.staff_update_outbox u
              where u.sent_at is null and u.status = 'pending' and (u.claimed_at is null or u.claimed_at < now() - interval '10 minutes')
                and exists (select 1 from public.task_start_notices n where n.mail_id = u.id and n.mail_line is not null)
              order by u.not_before limit 200 for update of u skip locked
    loop
      select coalesce(jsonb_agg(c.v order by c.o), '[]'::jsonb) into v_new
        from jsonb_array_elements(r.changes) with ordinality c(v, o)
       where not exists (select 1 from public.task_start_notices n where n.mail_id = r.id and to_jsonb(n.mail_line) = c.v)
          or exists (select 1 from public.task_start_notices n where n.mail_id = r.id and to_jsonb(n.mail_line) = c.v and public._r436_fresh(n, r.crew_id, r.phone));
      if jsonb_array_length(v_new) < jsonb_array_length(r.changes) then
        update public.staff_update_outbox set changes = v_new, updated_at = now(),
               change_count = greatest(jsonb_array_length(v_new), change_count - (jsonb_array_length(r.changes) - jsonb_array_length(v_new)))
         where id = r.id;
      end if;
    end loop;
  exception when others then raise warning 'r253-0436: start notices not re-checked (%)', sqlstate;
  end;
  v := public.staff_update_claim__pre0436(p_limit);
  begin
    if jsonb_typeof(v) = 'array' and jsonb_array_length(v) > 0 then
      v := (select jsonb_agg(case when jsonb_array_length(i.items) > 0 then x.e || jsonb_build_object('start_now', i.items) else x.e end order by x.o)
              from jsonb_array_elements(v) with ordinality x(e, o)
              cross join lateral (select public._r436_mail_items((x.e ->> 'id')::uuid, coalesce(x.e -> 'changes', '[]'::jsonb)) as items) i);
    end if;
  exception when others then raise warning 'r253-0436: start facts not added (%)', sqlstate;
  end;
  -- r255-0440: "accepted for you by the office" says nothing next to "You can start now" for the same task (the stored row keeps it)
  begin
    if jsonb_typeof(v) = 'array' and jsonb_array_length(v) > 0 then
      v := (select jsonb_agg(case when jsonb_typeof(x.e -> 'changes') = 'array' then jsonb_set(x.e, '{changes}', public._r440_tidy(x.e -> 'changes')) else x.e end order by x.o)
              from jsonb_array_elements(v) with ordinality x(e, o));
    end if;
  exception when others then raise warning 'r255-0440: lines not tidied (%)', sqlstate;
  end;
  return v;
end $$;

-- ---- 7) a deactivated login gets no new work -------------------------------------------------------------------------------------------
create or replace function public._r440_crew_off(p_org uuid, p_crew uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r255-0440: the record's own login; the e-mail only when the record has no login linked
  select p_org is not null and p_crew is not null and exists (
    select 1 from public.crew_members c where c.id = p_crew and c.org_id = p_org
       and case when c.profile_id is not null then public._r283_is_off(c.profile_id, p_org) else public._r283_off_email(p_org, c.email) end);
$$;
-- the staff records of my studio whose login is deactivated (ids only)
create or replace function public.crew_login_off()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r255-0440
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not coalesce(public.has_area('staff', 'view'), false) then raise exception 'not authorized' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(c.id order by c.id) from public.crew_members c
     where c.org_id = v_org and case when c.profile_id is not null then public._r283_is_off(c.profile_id, v_org) else public._r283_off_email(v_org, c.email) end), '[]'::jsonb);
end $$;
create or replace function public._r440_tg_login_off()
returns trigger language plpgsql volatile security definer set search_path = '' as $$
-- r255-0440: only a NEW person on a task is checked; restores / system changes are not
declare v_name text;
begin
  if new.crew_id is null or (tg_op = 'UPDATE' and new.crew_id is not distinct from old.crew_id) then return new; end if;
  if auth.uid() is null or coalesce(new.status, '') in ('cancelled', 'completed') or public._is_system_change() then return new; end if;
  if coalesce(public._r440_crew_off(new.org_id, new.crew_id), false) then
    select left(btrim(c.name), 80) into v_name from public.crew_members c where c.id = new.crew_id;
    raise exception '% has a deactivated login. Pick someone else, or reactivate them in Settings, Users.', coalesce(nullif(v_name, ''), 'This person')
      using errcode = '22023', hint = 'r440_login_off';
  end if;
  return new;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.event_tasks'::regclass and tgname = 'zz_r440_login_off') then
    create trigger zz_r440_login_off before insert or update of crew_id on public.event_tasks
      for each row when (new.crew_id is not null) execute function public._r440_tg_login_off();
  end if;
end $$;

-- ---- 8) extras on the day --------------------------------------------------------------------------------------------------------------
create table if not exists public.event_extras (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id),
  quote_id      uuid not null references public.quotes(id) on delete cascade,
  what          text not null,
  qty           numeric(12,2),
  cost          numeric(14,2),
  asked_by      text,
  approved_by   text,
  note          text,
  happened_at   timestamptz not null default now(),
  decision      text,
  decided_at    timestamptz,
  decided_by    uuid,
  cancelled_at  timestamptz,
  cancelled_by  uuid,
  cancel_reason text,
  created_by    uuid,
  created_name  text,
  created_at    timestamptz not null default now(),
  request_id    uuid,
  constraint event_extras_what_chk440 check (char_length(btrim(what)) between 1 and 200),
  constraint event_extras_qty_chk440 check (qty is null or (qty > 0 and qty <= 1000000)),
  constraint event_extras_cost_chk440 check (cost is null or (cost >= 0 and cost <= 1000000000)),
  constraint event_extras_text_chk440 check (char_length(coalesce(asked_by, '')) <= 120 and char_length(coalesce(approved_by, '')) <= 120 and char_length(coalesce(note, '')) <= 500 and char_length(coalesce(cancel_reason, '')) <= 300),
  constraint event_extras_decision_chk440 check (decision is null or decision in ('bill', 'our_cost'))
);
comment on table public.event_extras is 'r255-0440: what was added on the event day (extra food, an extra table). A list only: it never changes the bill, the budget or a payment. Rows are cancelled, never deleted.';
create index if not exists event_extras_quote440 on public.event_extras (quote_id, created_at desc);
create index if not exists event_extras_org440 on public.event_extras (org_id);
create unique index if not exists event_extras_request_uk440 on public.event_extras (org_id, request_id) where request_id is not null;
alter table public.event_extras enable row level security;   -- no policy: read and written through the functions below only
do $$ declare r text; v_def text; begin
  revoke all on table public.event_extras from public;
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on table public.event_extras from %I', r); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant select on table public.event_extras to service_role'; end if;
  if to_regprocedure('public.tg_quote_org_match()') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.event_extras'::regclass and tgname = 'zz_quote_org_match') then
    create trigger zz_quote_org_match before insert or update on public.event_extras for each row execute function public.tg_quote_org_match();
  end if;
  if to_regprocedure('public.tg_studio_read_only()') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.event_extras'::regclass and tgname = 'zzz_studio_read_only') then
    create trigger zzz_studio_read_only before insert or update or delete on public.event_extras for each row execute function public.tg_studio_read_only('org_id');
  end if;
  -- free-trial retention (0184): goes with the studio's events (patched in place once, like 0434)
  if to_regprocedure('public._tr184_purge_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
    if position('''event_extras''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''event_issues'', ', ''))) / length('''event_issues'', ') <> 1 then
        raise notice '0440: _tr184_purge_tables has an unexpected body - left unchanged';
      else execute replace(v_def, '''event_issues'', ', '''event_issues'', ''event_extras'', '); end if;
    end if;
  end if;
end $$;

-- may I? (the event's studio = mine; the area on top). Answers the studio.
create or replace function public._r440_event(p_quote uuid, p_need text)
returns uuid language plpgsql stable security definer set search_path = '' as $$
-- r255-0440
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not coalesce(public.has_area('issues', p_need), false)
     or not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = v_org and q.deleted_at is null) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return v_org;
end $$;
create or replace function public._r440_name(p_user uuid)
returns text language sql stable security definer set search_path = '' as $$
  -- r255-0440
  select left(coalesce(nullif(btrim(p.full_name), ''), nullif(split_part(coalesce(p.email, ''), '@', 1), '')), 80) from public.profiles p where p.id = p_user;
$$;
create or replace function public.event_extras_list(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r255-0440: a list, no money effect. Cost: Budget view, or the person who typed it.
declare v_org uuid := public._r440_event(p_quote, 'view'); v_cost boolean := coalesce(public.has_area('budget', 'view'), false);
begin
  return jsonb_build_object('can_edit', coalesce(public.has_area('issues', 'edit'), false), 'see_cost', v_cost,
    'can_decide', coalesce(public.has_area('budget', 'edit'), false),
    'items', coalesce((select jsonb_agg(z.j order by z.at desc, z.id) from (
      select x.id, x.happened_at as at, jsonb_build_object('id', x.id, 'what', x.what, 'qty', x.qty, 'asked_by', x.asked_by, 'approved_by', x.approved_by, 'note', x.note,
               'cost', case when v_cost or x.created_by = auth.uid() then x.cost end, 'at', x.happened_at, 'by', x.created_name,
               'decision', x.decision, 'decided_by', public._r440_name(x.decided_by),
               'cancelled_at', x.cancelled_at, 'cancel_reason', x.cancel_reason, 'cancelled_by', public._r440_name(x.cancelled_by)) as j
        from public.event_extras x where x.quote_id = p_quote and x.org_id = v_org order by x.happened_at desc, x.id limit 300) z), '[]'::jsonb));
end $$;
create or replace function public.event_extra_add(p_quote uuid, p_item jsonb, p_request uuid default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r255-0440: one extra. p_request = once per press (the same press twice answers the first row).
declare v_org uuid := public._r440_event(p_quote, 'edit'); v_id uuid; v_what text; v_qty numeric; v_cost numeric; q record;
        f_txt constant text[] := array['asked_by', 'approved_by'];
begin
  select x.status, x.lifecycle_stage into q from public.quotes x where x.id = p_quote;
  if coalesce(q.status, '') in ('cancelled', 'lost') or coalesce(q.lifecycle_stage, '') in ('closed', 'cancelled', 'archived') then
    raise exception 'This event is closed or cancelled - nothing can be added.' using errcode = '22023', hint = 'r440_closed'; end if;
  if p_request is not null then
    select x.id into v_id from public.event_extras x where x.org_id = v_org and x.request_id = p_request;
    if v_id is not null then return jsonb_build_object('id', v_id, 'same', true); end if;
  end if;
  v_what := btrim(regexp_replace(coalesce(p_item ->> 'what', ''), '[[:cntrl:][:space:]]+', ' ', 'g'));
  if char_length(v_what) < 1 or char_length(v_what) > 200 then raise exception 'Say what was added (up to 200 characters).' using errcode = '22023', hint = 'r440_what'; end if;
  begin
    v_qty := nullif(btrim(coalesce(p_item ->> 'qty', '')), '')::numeric; v_cost := nullif(btrim(coalesce(p_item ->> 'cost', '')), '')::numeric;
  exception when others then raise exception 'Use numbers for how many and the cost.' using errcode = '22023', hint = 'r440_number'; end;
  if v_qty = 'NaN'::numeric or v_cost = 'NaN'::numeric or v_qty <= 0 or v_qty > 1000000 or v_cost < 0 or v_cost > 1000000000 then
    raise exception 'Check how many and the cost.' using errcode = '22023', hint = 'r440_number'; end if;
  insert into public.event_extras (org_id, quote_id, what, qty, cost, asked_by, approved_by, note, created_by, created_name, request_id)
  values (v_org, p_quote, v_what, round(v_qty, 2), round(v_cost, 2), left(nullif(btrim(coalesce(p_item ->> f_txt[1], '')), ''), 120), left(nullif(btrim(coalesce(p_item ->> f_txt[2], '')), ''), 120),
          left(nullif(btrim(coalesce(p_item ->> 'note', '')), ''), 500), auth.uid(), public._r440_name(auth.uid()), p_request)
  on conflict (org_id, request_id) where request_id is not null do nothing returning id into v_id;
  if v_id is null then select x.id into v_id from public.event_extras x where x.org_id = v_org and x.request_id = p_request; end if;
  return jsonb_build_object('id', v_id);
end $$;
create or replace function public.event_extra_cancel(p_id uuid, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r255-0440: the undo - the row stays, with the reason
declare v_q uuid; v_r text := btrim(regexp_replace(coalesce(p_reason, ''), '[[:cntrl:][:space:]]+', ' ', 'g'));
begin
  select x.quote_id into v_q from public.event_extras x where x.id = p_id and x.org_id = public.current_org_id();
  if v_q is null then raise exception 'not authorized' using errcode = '42501'; end if;
  perform public._r440_event(v_q, 'edit');
  if char_length(v_r) < 3 or char_length(v_r) > 300 then raise exception 'Give a reason (3 to 300 characters).' using errcode = '22023', hint = 'r440_reason'; end if;
  update public.event_extras set cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = v_r where id = p_id and cancelled_at is null;
  return jsonb_build_object('id', p_id, 'changed', found);
end $$;
create or replace function public.event_extra_decide(p_id uuid, p_decision text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r255-0440: a mark for the people who do the money ('bill' | 'our_cost' | null = not decided). NO money is changed here.
declare v_q uuid;
begin
  select x.quote_id into v_q from public.event_extras x where x.id = p_id and x.org_id = public.current_org_id();
  if v_q is null then raise exception 'not authorized' using errcode = '42501'; end if;
  perform public._r440_event(v_q, 'view');
  if not coalesce(public.has_area('budget', 'edit'), false) then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_decision is not null and p_decision not in ('bill', 'our_cost') then raise exception 'invalid_decision' using errcode = '22023', hint = 'r440_decision'; end if;
  update public.event_extras set decision = p_decision, decided_at = case when p_decision is null then null else now() end,
         decided_by = case when p_decision is null then null else auth.uid() end
   where id = p_id and cancelled_at is null and decision is distinct from p_decision;
  return jsonb_build_object('id', p_id, 'changed', found);
end $$;

-- ---- 9) grants -----------------------------------------------------------------------------------------------------------------------------
do $$ declare f text; r text; begin
  foreach f in array array['public._r440_fast(jsonb)', 'public._r440_tidy(jsonb)', 'public._r440_crew_off(uuid,uuid)', 'public._r440_tg_login_off()',
      'public._r440_event(uuid,text)', 'public._r440_name(uuid)', 'public._r436_mail(uuid,uuid,uuid,text,text)'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
  end loop;
  -- the replaced ones keep exactly what they had: server only (_r363_*: service_role, 0363)
  foreach f in array array['public._r363_note(uuid,uuid,uuid,text,text[],boolean)', 'public._r363_tg_task_changed()', 'public.staff_update_claim(integer)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon, authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
  foreach f in array array['public.crew_login_off()', 'public.event_extras_list(uuid)', 'public.event_extra_add(uuid,jsonb,uuid)',
      'public.event_extra_cancel(uuid,text)', 'public.event_extra_decide(uuid,text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    foreach r in array array['authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('grant execute on function %s to %I', f, r); end if;
    end loop;
  end loop;
end $$;

do $$ begin
  if to_regclass('public.helm_schema_markers') is not null then
    insert into public.helm_schema_markers(num, name) values (440, '0440_r255_tasks_crew') on conflict (num) do nothing;
  end if;
end $$;

notify pgrst, 'reload schema';

-- ---- 10) CHECK (read only): every row must say true; rows starting with INFO are for reading ----------------------------------------------------
select c.check, c.ok from (values
  ('01 a due or urgent notice is never pushed back', position('r255-0440' in pg_get_functiondef('public._r363_note(uuid,uuid,uuid,text,text[],boolean)'::regprocedure)) > 0
      and public._r440_fast('["You can start now: A - B is done"]') and public._r440_fast('["Cancelled: A"]') and not public._r440_fast('["A: instructions updated"]')),
  ('02 new words for accepted by the office', position('accepted for you by the office' in pg_get_functiondef('public._r363_tg_task_changed()'::regprocedure)) > 0),
  ('03 the line is left out next to You can start now', public._r440_tidy('["You can start now: A - B is done","A: accepted for you by the office","C: accepted for you by the office"]')
      = '["You can start now: A - B is done","C: accepted for you by the office"]'::jsonb),
  ('04 You can start now wakes the sender', position('_r410_wake' in pg_get_functiondef('public._r436_mail(uuid,uuid,uuid,text,text)'::regprocedure)) > 0),
  ('05 the claim keeps the 0436 checks', position('r253-0436' in pg_get_functiondef('public.staff_update_claim(integer)'::regprocedure)) > 0
      and position('_r440_tidy' in pg_get_functiondef('public.staff_update_claim(integer)'::regprocedure)) > 0),
  ('06 a deactivated login is refused new work', exists (select 1 from pg_trigger where tgrelid = 'public.event_tasks'::regclass and tgname = 'zz_r440_login_off' and tgenabled <> 'D')),
  ('07 extras table, row security on, no direct access', (select relrowsecurity from pg_class where oid = 'public.event_extras'::regclass)
      and not has_table_privilege('authenticated', 'public.event_extras', 'select') and not has_table_privilege('anon', 'public.event_extras', 'select')),
  ('08 the new functions are not open to signed-out people', not has_function_privilege('anon', 'public.crew_login_off()', 'execute') and not has_function_privilege('anon', 'public.event_extras_list(uuid)', 'execute')
      and not has_function_privilege('anon', 'public.event_extra_add(uuid,jsonb,uuid)', 'execute') and has_function_privilege('authenticated', 'public.event_extra_add(uuid,jsonb,uuid)', 'execute')),
  ('09 the helpers are server only', not has_function_privilege('authenticated', 'public._r440_crew_off(uuid,uuid)', 'execute') and not has_function_privilege('authenticated', 'public._r440_event(uuid,text)', 'execute')),
  ('10 the old bodies are kept', to_regprocedure('public._r363_note__pre0440(uuid,uuid,uuid,text,text[],boolean)') is not null and to_regprocedure('public.staff_update_claim__pre0440(integer)') is not null),
  ('INFO the sender timer (best: * * * * *): ' || coalesce(public._r362_dispatch_schedule(), 'not scheduled here'), true),
  ('INFO wake at once: ' || coalesce(public._r410_wake_ready('comms-dispatch'), '?'), true)
) c("check", ok);
