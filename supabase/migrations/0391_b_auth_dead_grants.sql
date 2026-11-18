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
