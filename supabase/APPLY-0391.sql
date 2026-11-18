-- APPLY-0391 (Audit B, login and accounts: remove unused signed-in table permissions - belt and braces).
-- Run on STAGING first, then production. Safe to run twice. Needs nothing new.
-- What it does: row-level security already refuses these writes for signed-in users; this removes the unused permission
-- underneath so a future loose rule can never bring it back to life (activity log, role switches, studios, chat deletes,
-- client approval codes). Reading is unchanged. No row is read, changed or deleted.
-- Paste the whole file into the Supabase SQL editor and press Run. The last result lists checks - every ok must be true.
begin;
-- 0391_b_auth_dead_grants.sql - CANONICAL forward-only. Audit B (login and accounts, 18 Nov 2026). ASCII only.
-- REQUIRES nothing new: every statement is guarded (a missing table or role is skipped).
--
-- In plain words:
--   Row-level security already stops signed-in users from writing these tables (there is no rule that lets them),
--   but the tables still carried the old "signed-in users may write" table permission underneath. Today that
--   permission does nothing. If a later change ever added a loose rule to one of these tables, the permission
--   would quietly come back to life - for example a staff member could then edit or delete the activity log.
--   This file removes ONLY those unused permissions (belt and braces):
--     audit_log           insert / update / delete   (the activity log is written by the database itself)
--     role_access         insert / update / delete   (Settings -> Roles saves through admin_set_role_access)
--     organizations       insert / delete            (studios are created / closed by server functions)
--     chat_conversations  delete                     (chat changes go through chat_* functions)
--     chat_messages       delete                     (a message "delete" is an update; that stays)
--     chat_reactions      update                     (reactions go through chat_react)
--     quote_otps          select / insert / update / delete  (client approval codes: only server functions)
--   Reading stays exactly as it is (audit_log / role_access / organizations / chat_* reads are unchanged).
--   No row is read, changed or deleted. No policy, function, trigger or column is touched. Safe to run twice.
--   The only visible difference: a direct write the rules already refused now fails with "permission denied"
--   instead of quietly changing nothing. The app never makes these writes (checked: public/*.js, edge functions,
--   database functions that run as the signed-in user).
-- Undo (manual, not recommended): grant the same privileges back to authenticated, e.g.
--   grant insert, update, delete on public.audit_log to authenticated;

do $$
declare
  r record;
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then return; end if;
  for r in select * from (values
      ('public.audit_log',          'insert, update, delete'),
      ('public.role_access',        'insert, update, delete'),
      ('public.organizations',      'insert, delete'),
      ('public.chat_conversations', 'delete'),
      ('public.chat_messages',      'delete'),
      ('public.chat_reactions',     'update'),
      ('public.quote_otps',         'select, insert, update, delete')
    ) v(tbl, privs)
  loop
    if to_regclass(r.tbl) is not null then
      execute format('revoke %s on table %s from authenticated', r.privs, r.tbl);
      -- the same privileges never belonged to the signed-out role either
      if exists (select 1 from pg_roles where rolname = 'anon') then
        execute format('revoke %s on table %s from anon', r.privs, r.tbl);
      end if;
    end if;
  end loop;
end $$;

select item, ok from (values
  ('01 activity log: signed-in users cannot insert / update / delete (reading unchanged)',
     to_regclass('public.audit_log') is null
     or (not has_table_privilege('authenticated', 'public.audit_log', 'insert, update, delete')
         and not has_any_column_privilege('authenticated', 'public.audit_log', 'insert, update'))),
  ('02 role switches: signed-in users cannot insert / update / delete directly (admin_set_role_access still works)',
     to_regclass('public.role_access') is null
     or (not has_table_privilege('authenticated', 'public.role_access', 'insert, update, delete')
         and not has_any_column_privilege('authenticated', 'public.role_access', 'insert, update')
         and has_function_privilege('authenticated', 'public.admin_set_role_access(text,text,boolean,boolean)', 'execute'))),
  ('03 studios: signed-in users cannot insert / delete a studio row directly (update for admins unchanged)',
     to_regclass('public.organizations') is null
     or (not has_table_privilege('authenticated', 'public.organizations', 'insert, delete')
         and not has_any_column_privilege('authenticated', 'public.organizations', 'insert'))),
  ('04 chat: no direct delete of conversations / messages, no direct update of reactions',
     (to_regclass('public.chat_conversations') is null or not has_table_privilege('authenticated', 'public.chat_conversations', 'delete'))
     and (to_regclass('public.chat_messages') is null or not has_table_privilege('authenticated', 'public.chat_messages', 'delete'))
     and (to_regclass('public.chat_reactions') is null
          or (not has_table_privilege('authenticated', 'public.chat_reactions', 'update')
              and not has_any_column_privilege('authenticated', 'public.chat_reactions', 'update')))),
  ('05 client approval codes (quote_otps): no signed-in or signed-out privilege at all',
     to_regclass('public.quote_otps') is null
     or not exists (select 1 from unnest(array['anon', 'authenticated']) r
                     where has_table_privilege(r, 'public.quote_otps', 'select, insert, update, delete')
                        or has_any_column_privilege(r, 'public.quote_otps', 'select, insert, update'))),
  ('06 reads the app makes are unchanged (audit_log / role_access / organizations / chat_* select)',
     (select bool_and(to_regclass(t) is null or has_table_privilege('authenticated', t, 'select'))
        from unnest(array['public.audit_log', 'public.role_access', 'public.organizations',
                          'public.chat_conversations', 'public.chat_messages', 'public.chat_reactions']) t)),
  ('07 every table in public still has row-level security on',
     not exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
                  and not c.relrowsecurity))
) v(item, ok) order by item;
commit;
