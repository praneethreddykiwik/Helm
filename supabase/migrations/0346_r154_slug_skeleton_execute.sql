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
