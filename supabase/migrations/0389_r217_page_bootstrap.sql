-- 0389_r217_page_bootstrap.sql - R217 (owner 18 Nov 2026, PAGE-SPEED-REPORT: "signed-in pages feel slow because of
-- waiting"). Forward-only, additive, read-only, safe to run twice. ASCII only.
-- REQUIRES 0041 (my_profile_status), 0056 (my_checkout_status), 0116 / 0183 (my_trial_org), 0180 (my_trial_status),
--          my_demo_status, my_subscription, 0304 (password_change_required), 0381 (my_test_studio), phase29 (role_access),
--          get_pricing_config, 0086 (get_item_rate_cards).
--
-- In plain words:
--   Every signed-in page starts by asking the database the same small questions, one request each: which studio am I
--   in, must I finish my profile / pick a plan / change my temporary password, what is my role, what may my role see
--   and change, is this a free trial (and has it ended), is it a demo / test studio, what is my plan, and the studio's
--   pricing settings (phone country, tax) + item rate cards. From India each
--   request is a trip to Canada and back (about 250 ms), and the role and its access switches were two trips in a row.
--   page_bootstrap() answers all of them in ONE request. It does not decide anything itself: each answer comes from
--   the SAME function the page calls today (current_org_id(), my_profile_status(), my_checkout_status(),
--   password_change_required(), my_trial_org(), my_trial_status(), my_demo_status(), my_subscription(),
--   my_test_studio(), get_pricing_config(), get_item_rate_cards()), and the role + access switches are the same rows the page reads today, picked by the same rule
--   as the table's own read policy ("ra read": my studio = current_org_id(), a client login sees client rows only via
--   user_role()). One answer that fails is simply left out (listed under "errors") and the page asks for that one the
--   old way. Only for the signed-in caller (auth.uid()), only inside their own studio. Reads only: no table, policy or
--   existing function is created, changed or dropped; nothing is written.
--
-- Answer: {"v": 1, "parts": {<name>: <the same answer the old call gives>}, "errors": {<name>: <sqlstate>}}
--   parts.current_org_id, my_profile_status, my_checkout_status, password_change_required, my_trial_org,
--   my_trial_status, my_demo_status, my_subscription, my_test_studio, get_pricing_config, get_item_rate_cards = that
--   function's answer;
--   parts.profile_role = profiles.role of my own row (the page's "profiles?select=role&id=eq.<me>" read; left out when
--   there is no row); parts.role_access = [{area, can_view, can_edit}] for that role (the page's
--   "role_access?select=area,can_view,can_edit&role=eq.<role>" read; only when I am in a studio).

create or replace function public.page_bootstrap()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r217-0389: one read-only startup answer for a signed-in page; every part = the existing call's own answer
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_role text;
  v_found boolean := false;
  p jsonb := '{}'::jsonb;
  e jsonb := '{}'::jsonb;
begin
  if v_uid is null then raise exception 'not signed in' using errcode = '42501'; end if;

  begin v_org := public.current_org_id(); p := p || jsonb_build_object('current_org_id', v_org);
  exception when others then e := e || jsonb_build_object('current_org_id', sqlstate); end;
  begin p := p || jsonb_build_object('my_profile_status', public.my_profile_status());
  exception when others then e := e || jsonb_build_object('my_profile_status', sqlstate); end;
  begin p := p || jsonb_build_object('my_checkout_status', public.my_checkout_status());
  exception when others then e := e || jsonb_build_object('my_checkout_status', sqlstate); end;
  begin p := p || jsonb_build_object('password_change_required', public.password_change_required());
  exception when others then e := e || jsonb_build_object('password_change_required', sqlstate); end;

  -- my own profiles row (policy profiles_select: id = auth.uid())
  begin
    select pr.role into v_role from public.profiles pr where pr.id = v_uid;
    v_found := found;
    if v_found then p := p || jsonb_build_object('profile_role', v_role); end if;
  exception when others then e := e || jsonb_build_object('profile_role', sqlstate); v_found := false; end;

  -- that role's access switches, the rows policy "ra read" shows me (only inside a studio)
  if v_found and v_org is not null then
    begin
      p := p || jsonb_build_object('role_access', coalesce((
        select jsonb_agg(jsonb_build_object('area', ra.area, 'can_view', ra.can_view, 'can_edit', ra.can_edit) order by ra.area)
          from public.role_access ra
         where ra.role = coalesce(v_role, 'client')
           and ra.org_id = (select public.current_org_id())
           and (coalesce((select public.user_role()), '') <> 'client' or ra.role = 'client')), '[]'::jsonb));
    exception when others then e := e || jsonb_build_object('role_access', sqlstate); end;
  end if;

  begin p := p || jsonb_build_object('my_trial_org', public.my_trial_org());
  exception when others then e := e || jsonb_build_object('my_trial_org', sqlstate); end;
  begin p := p || jsonb_build_object('my_trial_status', public.my_trial_status());
  exception when others then e := e || jsonb_build_object('my_trial_status', sqlstate); end;
  begin p := p || jsonb_build_object('my_demo_status', public.my_demo_status());
  exception when others then e := e || jsonb_build_object('my_demo_status', sqlstate); end;
  begin p := p || jsonb_build_object('my_subscription', public.my_subscription());
  exception when others then e := e || jsonb_build_object('my_subscription', sqlstate); end;
  begin p := p || jsonb_build_object('my_test_studio', public.my_test_studio());
  exception when others then e := e || jsonb_build_object('my_test_studio', sqlstate); end;
  -- studio settings every page reads at start (phone country / tax from the pricing config, item rate cards)
  begin p := p || jsonb_build_object('get_pricing_config', public.get_pricing_config());
  exception when others then e := e || jsonb_build_object('get_pricing_config', sqlstate); end;
  begin p := p || jsonb_build_object('get_item_rate_cards', public.get_item_rate_cards());
  exception when others then e := e || jsonb_build_object('get_item_rate_cards', sqlstate); end;

  return jsonb_build_object('v', 1, 'parts', p, 'errors', e);
end $$;

revoke all on function public.page_bootstrap() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.page_bootstrap() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'revoke all on function public.page_bootstrap() from service_role'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.page_bootstrap() to authenticated'; end if;
end $$;

comment on function public.page_bootstrap() is
  'r217-0389: one read-only startup answer for a signed-in page (studio, sign-in steps, role + access switches, trial / demo / test studio / plan, pricing settings + rate cards). Each part is the existing call''s own answer; a failed part is listed under errors and the page asks it the old way.';
