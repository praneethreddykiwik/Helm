-- APPLY-0346 (R154 studio settings save fix - look-alike helper EXECUTE for signed-in users). Run on STAGING first, then production. Safe to run twice.
-- Grants only. Takes a moment. If it stops with a timeout message nothing was applied, just run it again.
begin;
-- 0346_r154_slug_skeleton_execute.sql - R154 studio settings save fix. Forward-only, additive, safe to run twice.
-- Grants only. Nothing dropped or deleted. No row, column, table, policy or function body changed.
-- Why: 0257 built two look-alike indexes on public._r23_slug_skeleton(text), one on organizations and one on
-- org_slug_history, and in the same file took EXECUTE on that helper away from signed-in users. Postgres checks
-- EXECUTE on an index function as the person whose UPDATE writes the new index entry, so a studio admin saving
-- Settings or onboarding failed with 42501 permission denied for function _r23_slug_skeleton whenever the row
-- could not be updated in place on its page (on and off, depending on free space and autovacuum).
-- The helper is a pure text fold (lower case, look-alike letters folded). It reads no table and returns only
-- a folded copy of its own argument. Signed-in users get EXECUTE back. anon and PUBLIC stay without it.
-- Notes: supabase/migrations/MANIFEST entry 0346.
do $$
begin
  if to_regprocedure('public._r23_slug_skeleton(text)') is null then
    raise exception 'STOP 0346: public._r23_slug_skeleton(text) is missing - apply 0257 first'; end if;
  if (select p.provolatile from pg_proc p where p.oid = to_regprocedure('public._r23_slug_skeleton(text)')) <> 'i'
     or (select p.prosecdef from pg_proc p where p.oid = to_regprocedure('public._r23_slug_skeleton(text)')) then
    raise exception 'STOP 0346: public._r23_slug_skeleton(text) is not the 0257 immutable invoker helper on this database'; end if;
end $$;

do $$
begin
  execute 'revoke all on function public._r23_slug_skeleton(text) from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public._r23_slug_skeleton(text) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public._r23_slug_skeleton(text) to authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public._r23_slug_skeleton(text) to service_role'; end if;
end $$;

commit;

-- VERIFY every line should say true
select item, ok from (values
  ('01 look-alike helper is there', to_regprocedure('public._r23_slug_skeleton(text)') is not null),
  ('02 signed-in users can run the look-alike helper', coalesce(has_function_privilege('authenticated', to_regprocedure('public._r23_slug_skeleton(text)'), 'execute'), false)),
  ('03 anon still cannot run the look-alike helper', coalesce(not has_function_privilege('anon', to_regprocedure('public._r23_slug_skeleton(text)'), 'execute'), false)),
  ('04 the server role can run the look-alike helper', coalesce(has_function_privilege('service_role', to_regprocedure('public._r23_slug_skeleton(text)'), 'execute'), false)),
  ('05 helper is still immutable and not security definer', coalesce((select p.provolatile = 'i' and not p.prosecdef from pg_proc p where p.oid = to_regprocedure('public._r23_slug_skeleton(text)')), false)),
  ('06 helper body unchanged since 0257', position('r23-studio-name-0257' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._r23_slug_skeleton(text)')), '')) > 0),
  ('07 no index on a public table uses a function signed-in users cannot run', not exists (select 1 from pg_index i join pg_class c on c.oid = i.indrelid join pg_depend d on d.classid = 'pg_class'::regclass and d.objid = i.indexrelid and d.refclassid = 'pg_proc'::regclass where c.relnamespace = 'public'::regnamespace and not has_function_privilege('authenticated', d.refobjid, 'execute')))
) v(item, ok) order by item;
