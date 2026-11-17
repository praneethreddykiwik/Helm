-- APPLY-0375 (R193 prod log errors: booklet reads answer "nothing" instead of HTTP 500). Run on STAGING first, then production. Safe to run twice.
-- The share-booklet reads (booklet_current, booklet_image_info, booklet_staff_image, booklet_layout_auto_on) answer null / {} / ok false
-- for an event that is not in your studio or was deleted (was "event not found" = HTTP 500 in the log). Who may call them is unchanged.
-- Paste the whole file into the Supabase SQL editor and press Run. The last result lists checks - every ok must be true.
begin;
-- 0375_r193_booklet_soft_reads.sql - R193 (prod log errors, 16-17 Nov 2026). Forward-only, additive, safe to run twice.
-- ASCII only.
-- REQUIRES 0065 (_booklet_staff_quote, client_booklets), 0083 (client_booklet_images, booklet_image_info,
--          booklet_staff_image), 0220 (booklet_current + booklet_layout_auto_on bodies, _bk220_layout_auto_on,
--          _bk_sections_norm, _bk_sections_all).
--
-- In plain words:
--   The production log showed bursts of three HTTP 500 answers (booklet_layout_auto_on, booklet_current,
--   booklet_image_info) with "event not found" (P0002). The Share-booklet card on the quote page asked about an
--   event that is not in the signed-in person's studio any more (deleted / discarded draft, or a link from another
--   studio after switching). PostgREST turns P0002 into a 500 "server error", so the log filled with what looked
--   like crashes. These four calls only READ (or, for layout_auto_on, only touch the caller's own live link):
--     booklet_current, booklet_image_info, booklet_staff_image, booklet_layout_auto_on
--   They now answer "nothing here" for an event that is not in the caller's studio (or was deleted):
--     booklet_current -> null (same as "no live link"), booklet_image_info -> {} (no pictures),
--     booklet_staff_image -> null (no picture), booklet_layout_auto_on -> {ok:false, changed:false} (no live link).
--   That is exactly what the caller would see for an event of their own that has no link / pictures, so nothing
--   about another studio's event is revealed (before, the error only said "not found" too).
--   AUTHORIZATION IS UNCHANGED: signed out, no studio, a client account, or a role without quotes VIEW (EDIT for
--   layout_auto_on) is still refused with 42501 "not authorized" (PostgREST: 401 / 403). Writes (booklet_share,
--   booklet_revoke, booklet_set_sections, booklet_put_image, booklet_set_image_variants, ...) keep the strict
--   _booklet_staff_quote and still raise for an unknown event.
--   NEW helper _booklet_staff_quote_soft(quote, edit): the same checks as _booklet_staff_quote, but returns null
--   (instead of raising P0002) when the event is not in the caller's studio or was deleted. Not callable by the app.
--
-- Changes: one new function + four functions re-issued in place (same inputs, same answers for a real event of the
-- caller's studio, same grants). No table, column, policy or row is created, changed or deleted.
-- Undo: re-run the 0083 / 0220 bodies of the four functions; drop function public._booklet_staff_quote_soft(uuid, boolean).

do $$ begin
  if to_regprocedure('public._booklet_staff_quote(uuid,boolean)') is null then
    raise exception '0375: _booklet_staff_quote is not installed (apply 0065 first)'; end if;
  if to_regprocedure('public._bk220_layout_auto_on(uuid,integer)') is null or to_regprocedure('public._bk_sections_all()') is null then
    raise exception '0375: the 0220 booklet helpers are not installed (apply 0220 first)'; end if;
  if to_regclass('public.client_booklet_images') is null then
    raise exception '0375: client_booklet_images is not installed (apply 0083 first)'; end if;
end $$;

-- ---- 1) the soft helper: same authorization as _booklet_staff_quote, null for an event that is not mine -------------
create or replace function public._booklet_staff_quote_soft(p_quote_id uuid, p_edit boolean)
returns uuid language plpgsql stable security definer set search_path = '' as $$
-- r193-0375: _booklet_staff_quote without the P0002 (a read of an unknown / other-studio / deleted event = null)
declare v_me uuid := auth.uid(); v_org uuid := public.current_org_id(); v_role text; v_q uuid;
begin
  if v_me is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  select p.role into v_role from public.profiles p where p.id = v_me and p.org_id = v_org;
  if v_role is null or v_role = 'client' then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public.has_area('quotes', case when p_edit then 'edit' else 'view' end) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if p_quote_id is null then return null; end if;
  select q.id into v_q from public.quotes q where q.id = p_quote_id and q.org_id = v_org and q.deleted_at is null;
  if v_q is null then return null; end if;
  return v_org;
end $$;
revoke all on function public._booklet_staff_quote_soft(uuid, boolean) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._booklet_staff_quote_soft(uuid, boolean) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._booklet_staff_quote_soft(uuid, boolean) from authenticated'; end if;
end $$;

-- ---- 2) booklet_current: the 0220 body; an event that is not mine -> null (= no live link) ----------------------------
create or replace function public.booklet_current(p_quote_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- booklet-layout-0220: the 0065 body + sections, image_variants, sections_set_at
-- r193-0375: unknown / other-studio / deleted event -> null (was P0002 = HTTP 500)
declare v_org uuid; r public.client_booklets;
begin
  v_org := public._booklet_staff_quote_soft(p_quote_id, false);
  if v_org is null then return null; end if;
  select * into r from public.client_booklets b
   where b.quote_id = p_quote_id and b.org_id = v_org and b.revoked_at is null
   order by b.created_at desc limit 1;
  if r.id is null then return null; end if;
  return jsonb_build_object('id', r.id, 'token', r.token, 'expires_at', r.expires_at, 'created_at', r.created_at,
                            'expired', r.expires_at <= now(), 'shared_versions', to_jsonb(r.shared_versions),
                            'terms', r.terms, 'note', r.note,
                            'sections', public._bk_sections_all() || coalesce(case when jsonb_typeof(r.sections) = 'object' then r.sections end, '{}'::jsonb),
                            'image_variants', r.image_variants, 'sections_set_at', r.sections_set_at);
end $$;

-- ---- 3) booklet_layout_auto_on: the 0220 body; an event that is not mine -> {ok:false, changed:false} ------------------
create or replace function public.booklet_layout_auto_on(p_quote_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- booklet-layout-0220
-- r193-0375: unknown / other-studio / deleted event -> {ok:false, changed:false} (was P0002 = HTTP 500)
declare v_org uuid; b public.client_booklets; v_changed boolean := false;
begin
  v_org := public._booklet_staff_quote_soft(p_quote_id, true);
  if v_org is null then return jsonb_build_object('ok', false, 'changed', false); end if;
  select x.* into b from public.client_booklets x
   where x.quote_id = p_quote_id and x.org_id = v_org and x.revoked_at is null
   order by x.created_at desc limit 1;
  if b.id is null then return jsonb_build_object('ok', false, 'changed', false); end if;
  v_changed := public._bk220_layout_auto_on(b.id);
  select x.* into b from public.client_booklets x where x.id = b.id;
  return jsonb_build_object('ok', true, 'changed', v_changed, 'sections', public._bk_sections_norm(b.sections));
end $$;

-- ---- 4) booklet_image_info: the 0083 body; an event that is not mine -> {} ---------------------------------------------
create or replace function public.booklet_image_info(p_quote_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- booklet-images-0083
-- r193-0375: unknown / other-studio / deleted event -> {} (was P0002 = HTTP 500)
declare v_org uuid; r jsonb := '{}'::jsonb; x record;
begin
  v_org := public._booklet_staff_quote_soft(p_quote_id, false);
  if v_org is null then return r; end if;
  for x in select i.kind, i.variant, max(i.created_at) as at from public.client_booklet_images i
            where i.quote_id = p_quote_id and i.org_id = v_org group by i.kind, i.variant loop
    r := jsonb_set(case when r ? x.kind then r else r || jsonb_build_object(x.kind, '{}'::jsonb) end,
                   array[x.kind, x.variant], to_jsonb(x.at));
  end loop;
  return r;
end $$;

-- ---- 5) booklet_staff_image: the 0083 body; an event that is not mine -> null --------------------------------------------
create or replace function public.booklet_staff_image(p_quote_id uuid, p_kind text, p_variant text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- booklet-images-0083
-- r193-0375: unknown / other-studio / deleted event -> null (was P0002 = HTTP 500)
declare v_org uuid; i public.client_booklet_images;
begin
  v_org := public._booklet_staff_quote_soft(p_quote_id, false);
  if v_org is null then return null; end if;
  select * into i from public.client_booklet_images x
   where x.quote_id = p_quote_id and x.org_id = v_org and x.kind = p_kind and x.variant = p_variant
   order by x.created_at desc, x.id desc limit 1;
  if i.id is null then return null; end if;
  return jsonb_build_object('mime', i.mime, 'data', translate(encode(i.data, 'base64'), E'\n\r', ''), 'created_at', i.created_at, 'bytes', i.bytes);
end $$;

-- ---- 6) grants: exactly as before (signed-in callers; each function checks the studio and the role inside) ------------
do $$ declare s text; begin
  foreach s in array array['public.booklet_current(uuid)', 'public.booklet_layout_auto_on(uuid)',
                           'public.booklet_image_info(uuid)', 'public.booklet_staff_image(uuid, text, text)'] loop
    execute format('revoke all on function %s from public', s);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', s); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', s); end if;
  end loop;
end $$;

-- ---- checks: every ok must be true ---------------------------------------------------------------------------------
select item, ok from (values
  ('01 soft helper installed, server only',
     to_regprocedure('public._booklet_staff_quote_soft(uuid,boolean)') is not null
     and (not exists (select 1 from pg_roles where rolname = 'authenticated')
          or not has_function_privilege('authenticated', 'public._booklet_staff_quote_soft(uuid,boolean)', 'execute'))
     and (not exists (select 1 from pg_roles where rolname = 'anon')
          or not has_function_privilege('anon', 'public._booklet_staff_quote_soft(uuid,boolean)', 'execute'))),
  ('02 four booklet reads carry the r193-0375 body',
     position('r193-0375' in pg_get_functiondef(to_regprocedure('public.booklet_current(uuid)'))) > 0
     and position('r193-0375' in pg_get_functiondef(to_regprocedure('public.booklet_image_info(uuid)'))) > 0
     and position('r193-0375' in pg_get_functiondef(to_regprocedure('public.booklet_staff_image(uuid,text,text)'))) > 0
     and position('r193-0375' in pg_get_functiondef(to_regprocedure('public.booklet_layout_auto_on(uuid)'))) > 0),
  ('03 signed-in callers keep execute, signed-out callers have none',
     (not exists (select 1 from pg_roles where rolname = 'authenticated')
      or (has_function_privilege('authenticated', 'public.booklet_current(uuid)', 'execute')
          and has_function_privilege('authenticated', 'public.booklet_image_info(uuid)', 'execute')
          and has_function_privilege('authenticated', 'public.booklet_staff_image(uuid,text,text)', 'execute')
          and has_function_privilege('authenticated', 'public.booklet_layout_auto_on(uuid)', 'execute')))
     and (not exists (select 1 from pg_roles where rolname = 'anon')
      or (not has_function_privilege('anon', 'public.booklet_current(uuid)', 'execute')
          and not has_function_privilege('anon', 'public.booklet_image_info(uuid)', 'execute')
          and not has_function_privilege('anon', 'public.booklet_staff_image(uuid,text,text)', 'execute')
          and not has_function_privilege('anon', 'public.booklet_layout_auto_on(uuid)', 'execute')))),
  ('04 definer + empty search_path kept',
     (select bool_and(p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""']) from pg_proc p
       where p.oid in (to_regprocedure('public.booklet_current(uuid)'), to_regprocedure('public.booklet_image_info(uuid)'),
                       to_regprocedure('public.booklet_staff_image(uuid,text,text)'), to_regprocedure('public.booklet_layout_auto_on(uuid)'),
                       to_regprocedure('public._booklet_staff_quote_soft(uuid,boolean)')))),
  ('05 the strict helper (used by the writes) is still there', to_regprocedure('public._booklet_staff_quote(uuid,boolean)') is not null)
) v(item, ok) order by item;
commit;
