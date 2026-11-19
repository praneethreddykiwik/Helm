-- DELETE-0398-RETIRED-ROLE-USERS.sql - R229 (owner decision 18 Nov 2026: "Delete those users too").
-- OWNER-RUN ONLY. NOT part of APPLY-0398 and never run automatically. Run APPLY-0398 first.
--
-- What it does, in plain words:
--   Deletes, in every studio, the LOGINS whose role is Event coordinator (coordinator) or Designer (designer).
--   Crew logins are NOT touched (Crew is only disabled). No other role is touched. A studio owner, any admin and any
--   Helm HQ / platform account is never deleted, even if their role says coordinator / designer.
--   Their work history is KEPT: quotes, tasks, the audit log, chat messages, payments and the rest stay; where a row
--   points at the deleted person (for example "created by"), that pointer is emptied, which the app shows as a
--   deleted / unknown user - the row itself stays. Their Staff Directory record (if any) is kept and unlinked.
--   Personal rows that only belong to that login (sign-in sessions, two-step factors, chat memberships, their own
--   notification ticks and dashboard settings) go with the login, as Supabase always does.
--   BEFORE anything is changed, a copy of every affected row (profile, login, staff record, every pointer emptied,
--   every personal row removed) is written to public._r398_backup, so a mistake can be put back by hand.
--   After the people are gone, the access-matrix rows (role_access) of the two removed roles are deleted too (copied
--   to public._r398_backup first).
--   This CANNOT be undone by the app. Only the copies in public._r398_backup can be used to rebuild by hand.
--
-- HOW TO RUN (two steps, Supabase -> SQL editor, staging first, then production):
--   STEP 1 - read-only. Paste ONLY the "STEP 1" block below and press Run. It lists exactly who would be deleted
--            (studio, name, e-mail, role, last sign-in) and how many history rows point at each of them. Nothing changes.
--            Reassign anyone you want to KEEP to another role first (Settings -> Users & invites), then run STEP 1 again.
--   STEP 2 - type the number of people STEP 1 listed into v_expected (look for "TYPE THE NUMBER HERE"), then paste
--            the "STEP 2" block and press Run. If the number of people is different from the number you typed (someone
--            was added or reassigned meanwhile) it STOPS and changes nothing. Otherwise it backs up, empties the
--            pointers, deletes the logins in one transaction and ends with check rows (every ok must be true).
--   Pasting the whole file at once is safe: STEP 2 stops with "type the number" until you type it.
-- ASCII only. No temp tables, no session settings.

-- =====================================================================================================================
-- STEP 1 (read-only): who would be deleted, and how much history points at them
-- =====================================================================================================================
with victims as (
  select p.id, p.org_id, p.role, p.email, p.full_name
    from public.profiles p
   where p.role in ('coordinator', 'designer')
     and not exists (select 1 from public.organizations o where o.id = p.org_id and o.created_by = p.id)
     and public._r283_owner(p.org_id) is distinct from p.id
     and not exists (select 1 from public.platform_admins pa where pa.user_id = p.id or lower(pa.email) = lower(p.email))
), refs as (
  select c.conrelid::regclass::text as tbl, a.attname::text as col
    from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
   where c.contype = 'f' and c.confrelid in ('auth.users'::regclass, 'public.profiles'::regclass)
     and not (c.conrelid = 'public.profiles'::regclass and a.attname = 'id')
), hist as (
  select v.id, sum((xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %s where %I = %L', r.tbl, r.col, v.id), false, true, '')))[1]::text::int) as n
    from victims v cross join refs r group by v.id
)
select o.name as studio, coalesce(nullif(btrim(v.full_name), ''), '(no name)') as name, v.email,
       case v.role when 'coordinator' then 'Event coordinator' else 'Designer' end as role,
       u.last_sign_in_at as last_sign_in, coalesce(h.n, 0) as history_rows_pointing_at_them,
       count(*) over () as people_to_delete
  from victims v
  left join public.organizations o on o.id = v.org_id
  left join auth.users u on u.id = v.id
  left join hist h on h.id = v.id
 order by o.name, v.email;

-- =====================================================================================================================
-- STEP 2 (deletes): type the number of people STEP 1 listed, then run this block
-- =====================================================================================================================
begin;
do $r398d$
declare
  v_expected int := null;   -- <<< TYPE THE NUMBER HERE (the people_to_delete number from STEP 1), e.g. 3
  v_run timestamptz := now();
  v_ids uuid[]; v_n int; v_cnt int; v_left int; r record;
begin
  if v_expected is null then
    raise exception 'STOP: type the number of people from STEP 1 into v_expected first. Nothing was changed.';
  end if;
  if to_regclass('public._r398_backup') is null then
    raise exception 'STOP: run APPLY-0398 first (the backup table is missing). Nothing was changed.';
  end if;
  select coalesce(array_agg(p.id), '{}') into v_ids
    from public.profiles p
   where p.role in ('coordinator', 'designer')
     and not exists (select 1 from public.organizations o where o.id = p.org_id and o.created_by = p.id)
     and public._r283_owner(p.org_id) is distinct from p.id
     and not exists (select 1 from public.platform_admins pa where pa.user_id = p.id or lower(pa.email) = lower(p.email));
  v_n := coalesce(array_length(v_ids, 1), 0);
  if v_n <> v_expected then
    raise exception 'STOP: you typed % but % people have the role Event coordinator / Designer right now. Run STEP 1 again. Nothing was changed.', v_expected, v_n;
  end if;
  -- belt and braces: only these two roles, never an admin
  if exists (select 1 from public.profiles p where p.id = any (v_ids) and p.role not in ('coordinator', 'designer')) then
    raise exception 'STOP: a person outside the two removed roles was selected. Nothing was changed.';
  end if;

  if v_n > 0 then
    -- 1) copies first
    insert into public._r398_backup(run_at, kind, tbl, user_id, row_data)
      select v_run, 'profile', 'public.profiles', p.id, to_jsonb(p) from public.profiles p where p.id = any (v_ids);
    insert into public._r398_backup(run_at, kind, tbl, user_id, row_data)
      select v_run, 'auth_user', 'auth.users', u.id, to_jsonb(u) from auth.users u where u.id = any (v_ids);
    insert into public._r398_backup(run_at, kind, tbl, user_id, row_data)
      select v_run, 'staff', 'public.crew_members', c.profile_id, to_jsonb(c) from public.crew_members c where c.profile_id = any (v_ids);

    -- 2) every row that points at them: copy it; a history pointer is emptied (the row stays)
    for r in
      select c.conrelid::regclass as tbl, a.attname::text as col, c.confdeltype as dt, a.attnotnull as nn,
             coalesce(array_length(c.conkey, 1), 0) as k
        from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
       where c.contype = 'f' and c.confrelid in ('auth.users'::regclass, 'public.profiles'::regclass)
         and not (c.conrelid = 'public.profiles'::regclass and a.attname = 'id')
       order by 1, 2
    loop
      execute format('select count(*) from %s where %I = any ($1)', r.tbl, r.col) into v_cnt using v_ids;
      continue when v_cnt = 0;
      if r.k <> 1 then raise exception 'STOP: % has a multi-column link to a person - not handled. Nothing was changed.', r.tbl; end if;
      execute format('insert into public._r398_backup(run_at, kind, tbl, col, user_id, row_data) '
                     || 'select $2, %L, %L, %L, t.%I, to_jsonb(t) from %s t where t.%I = any ($1)',
                     case when r.dt = 'c' then 'cascade_row' else 'ref_nulled' end, r.tbl::text, r.col, r.col, r.tbl, r.col)
        using v_ids, v_run;
      if r.dt in ('a', 'r') then
        if r.nn then
          raise exception 'STOP: %.% must always name a person and cannot be emptied (% rows). Nothing was changed.', r.tbl, r.col, v_cnt;
        end if;
        execute format('update %s set %I = null where %I = any ($1)', r.tbl, r.col, r.col) using v_ids;
      end if;
      -- set null ('n') / cascade ('c'): the delete below does it, the rows are copied above
    end loop;

    -- 3) the logins (their profile goes with the login)
    delete from public.profiles p where p.id = any (v_ids);
    get diagnostics v_cnt = row_count;
    if v_cnt <> v_expected then raise exception 'STOP: % profiles deleted, expected %. Everything was undone.', v_cnt, v_expected; end if;
    delete from auth.users u where u.id = any (v_ids);
  end if;

  -- 4) the access-matrix rows of the two removed roles, once nobody holds them
  select count(*) into v_left from public.profiles p where p.role in ('coordinator', 'designer');
  if v_left = 0 then
    insert into public._r398_backup(run_at, kind, tbl, row_data)
      select v_run, 'role_access', 'public.role_access', to_jsonb(ra) from public.role_access ra where ra.role in ('coordinator', 'designer');
    delete from public.role_access ra where ra.role in ('coordinator', 'designer');
  else
    raise notice '% login(s) with a removed role were kept (studio owner / HQ) - their role_access rows are kept too.', v_left;
  end if;
  raise notice 'R398 delete: % people deleted (copies in public._r398_backup, run_at %).', v_n, v_run;
end $r398d$;

select item, ok from (values
  ('01 no Event coordinator / Designer login left (except a studio owner / HQ account, never deleted)',
     not exists (select 1 from public.profiles p where p.role in ('coordinator', 'designer')
                  and not exists (select 1 from public.organizations o where o.id = p.org_id and o.created_by = p.id)
                  and public._r283_owner(p.org_id) is distinct from p.id
                  and not exists (select 1 from public.platform_admins pa where pa.user_id = p.id or lower(pa.email) = lower(p.email)))),
  ('02 every deleted profile has a copy in _r398_backup',
     not exists (select 1 from public._r398_backup b where b.kind = 'profile'
                  and exists (select 1 from public.profiles p where p.id = b.user_id))
     and (select count(*) from public._r398_backup b where b.kind = 'profile') = (select count(*) from public._r398_backup b where b.kind = 'auth_user')),
  ('03 no login left without a profile and no profile without a login for the deleted people',
     not exists (select 1 from public._r398_backup b where b.kind = 'auth_user' and exists (select 1 from auth.users u where u.id = b.user_id))),
  ('04 every studio that lost someone still has its admin(s)',
     not exists (select 1 from public._r398_backup b where b.kind = 'profile' and b.row_data ->> 'org_id' is not null
                  and not exists (select 1 from public.profiles p where p.org_id = (b.row_data ->> 'org_id')::uuid and p.role = 'admin'))),
  ('05 Crew logins untouched (no crew profile in the backup)',
     not exists (select 1 from public._r398_backup b where b.kind = 'profile' and b.row_data ->> 'role' = 'crew'))
) v(item, ok) order by item;
commit;
