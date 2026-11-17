-- APPLY-0371 (R188 crew settings / days off fix: the crew settings and the inbox settings each get their own reader). Run on STAGING first, then production. Safe to run twice.
-- Fixes: crew settings switches ignored and the staff link showing no days off. Only function bodies change (each caller reads its own settings); no table, column or row is touched. If it stops with a STOP message nothing was applied.
-- If PR #422 (0370) is applied AFTER this file, run this file once more afterwards (it then moves 0370's crew_set_availability to the crew reader too).
begin;
-- 0371_r188_r23_cfg_split.sql - R188 (owner bug, 17 Nov 2026). Forward-only, additive, safe to run twice. ASCII only.
-- REQUIRES 0265 (crew settings + crew link), 0266 (inbox settings), 0274 (_r25_crew_cfg + _r25_inbox_cfg).
--
-- In plain words:
--   Two different features once used the SAME internal name public._r23_cfg(uuid):
--     0265 = the studio's CREW settings (availability, open shifts, self check-in, geofence, pay basis ...),
--     0266 = the studio's INBOX settings (inbox e-mails, digest, bell).
--   Whichever was created last won. With the 0266 one live, every crew switch read as "empty": the crew link listed
--   no days off (a day marked off WAS saved, it just never came back), open shifts / self check-in / pay basis
--   fell back to "off" or to their defaults, and saving a crew switch in Control Center changed nothing anyone saw.
--   0274 papered over it by making _r23_cfg answer BOTH sets of keys - but re-running an older paste file (0265 or
--   0266) puts one half back and the bug returns.
--   This migration gives each caller its own reader so the clash can never come back:
--   1  _r23_cfg is set (again) to the 0274 answer (crew + inbox keys) for anything that still calls it - e.g. an
--      open branch written before this fix. Same text as 0274, so the 0274 check still matches.
--   2  every crew caller now calls _r25_crew_cfg (the crew reader 0274 added) and every inbox caller calls
--      _r25_inbox_cfg (the inbox reader 0274 added). Each caller's LIVE body is read and only the reader's name is
--      changed in it (pg_get_functiondef + replace), so wrappers / later in-place edits (0270, 0283, 0299, 0369, 0370 ...)
--      are kept exactly; same name, arguments, owner, grants, security definer and search_path. A caller that does not
--      exist or no longer calls _r23_cfg is left alone.
--   No table, column or row is touched. Nothing is dropped or deleted. Goes after 0368 (0369 / 0370: either order).

-- ---- 0) preflight -------------------------------------------------------------------------------------------------------------
do $$
declare v text;
begin
  foreach v in array array['public._r23_cfg(uuid)', 'public._r25_crew_cfg(uuid)', 'public._r25_inbox_cfg(uuid)',
                           'public.get_crew_settings()', 'public.admin_get_inbox_settings()'] loop
    if to_regprocedure(v) is null then raise exception 'STOP 0371: % missing (run 0265, 0266 and 0274 first)', v; end if;
  end loop;
end $$;

-- ---- 1) the shared name keeps answering both (exactly the 0274 body) ----------------------------------------------------------
create or replace function public._r23_cfg(p_org uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- r25-automations-0274: inbox (0266) + crew (0265) settings in one answer
  select public._r25_inbox_cfg(p_org) || public._r25_crew_cfg(p_org);
$$;
revoke all on function public._r23_cfg(uuid) from public, anon, authenticated;

-- ---- 2) each caller reads its own settings --------------------------------------------------------------------------------------
do $$
declare r record; v_oid regprocedure; v_def text;
begin
  for r in select * from (values
      -- crew settings (0265)
      ('public.get_crew_settings()', 'public._r25_crew_cfg('),
      ('public.crew_link_home__pre0299(uuid)', 'public._r25_crew_cfg('),
      ('public.crew_link_home(uuid)', 'public._r25_crew_cfg('),
      ('public.crew_set_availability(uuid,date,text,text)', 'public._r25_crew_cfg('),
      ('public.crew_claim_shift(uuid,uuid)', 'public._r25_crew_cfg('),
      ('public.crew_check(uuid,text,numeric,numeric,numeric)', 'public._r25_crew_cfg('),
      ('public.open_shift_post(uuid,text,date,time,time,numeric,text,integer,text,text,text,text)', 'public._r25_crew_cfg('),
      ('public.open_shifts_for_event(uuid)', 'public._r25_crew_cfg('),
      ('public.event_timesheet(uuid)', 'public._r25_crew_cfg('),
      ('public._r21_cost_lines(uuid,uuid)', 'public._r25_crew_cfg('),
      -- inbox settings (0266)
      ('public._r23_mode(uuid,uuid)', 'public._r25_inbox_cfg('),
      ('public._r23_my_settings(uuid,uuid)', 'public._r25_inbox_cfg('),
      ('public.admin_get_inbox_settings()', 'public._r25_inbox_cfg('),
      ('public.admin_set_inbox_settings(jsonb)', 'public._r25_inbox_cfg('),
      ('public.bell_feed__pre0299(integer)', 'public._r25_inbox_cfg('),
      ('public.bell_feed(integer)', 'public._r25_inbox_cfg('),
      ('public._r23_queue_digests()', 'public._r25_inbox_cfg(')
    ) t(fn, reader)
  loop
    v_oid := to_regprocedure(r.fn);
    if v_oid is null then continue; end if;
    v_def := pg_get_functiondef(v_oid);
    if position('public._r23_cfg(' in v_def) = 0 then continue; end if;
    execute replace(v_def, 'public._r23_cfg(', r.reader);
  end loop;
end $$;

-- VERIFY every line should say true
select item, ok from (values
  ('01 nobody but the shared name calls _r23_cfg', not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
     and p.proname <> '_r23_cfg' and position('public._r23_cfg(' in p.prosrc) > 0)),
  ('02 crew settings + crew link read the crew reader', position('public._r25_crew_cfg(' in (select prosrc from pg_proc where oid = 'public.get_crew_settings()'::regprocedure)) > 0
     and position('public._r25_crew_cfg(' in (select prosrc from pg_proc where oid = 'public.crew_set_availability(uuid,date,text,text)'::regprocedure)) > 0
     and position('public._r25_crew_cfg(' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('public.crew_link_home__pre0299(uuid)')),
                                                     (select prosrc from pg_proc where oid = 'public.crew_link_home(uuid)'::regprocedure))) > 0),
  ('03 inbox settings read the inbox reader', position('public._r25_inbox_cfg(' in (select prosrc from pg_proc where oid = 'public.admin_get_inbox_settings()'::regprocedure)) > 0
     and position('public._r25_inbox_cfg(' in (select prosrc from pg_proc where oid = 'public._r23_mode(uuid,uuid)'::regprocedure)) > 0),
  ('04 shared name answers both (crew + inbox keys), server only', public._r23_cfg('00000000-0000-4000-8000-000000000371'::uuid) ? 'availability'
     and public._r23_cfg('00000000-0000-4000-8000-000000000371'::uuid) ? 'digest_default'
     and not has_function_privilege('authenticated', 'public._r23_cfg(uuid)', 'execute')),
  ('05 crew link still open to staff links, settings still office only', has_function_privilege('anon', 'public.crew_link_home(uuid)', 'execute')
     and not has_function_privilege('anon', 'public.get_crew_settings()', 'execute')
     and not has_function_privilege('anon', 'public.admin_set_inbox_settings(jsonb)', 'execute'))
) v(item, ok) order by item;
commit;
