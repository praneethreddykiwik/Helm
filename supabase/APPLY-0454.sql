-- APPLY-0454 (R271: Settings > Links going out - every link the studio sent, in one list, and a way to turn each one off). Run on STAGING, then Canada production, then HELM-PROD-MUMBAI.
-- Safe to run twice. It stops before changing anything if something it needs is missing. If 0260 is ever pasted again, paste 0454 after it.
-- Same content as supabase/migrations/0454_r271_links.sql. The last result lists one row per check.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '5min';
-- 0454_r271_links.sql - R271 Settings > "Links going out": every link the studio has handed out, in one list, and a way to turn each off.
-- Forward-only, additive, safe to run twice. ASCII only.
-- REQUIRES 0039 (link age), 0042 (shelf gates), 0065 (client booklet), 0241 (delivery links), 0256 (vendor request links),
--          0260 (cancel stops links: _a260_link_state), 0261 (link views), 0284 (invitation new link), 0363 (staff links).
--
-- In plain words (owner, 27 Nov 2026: "We send out many links from my studio ... add a tab in Settings to manage all the links in one
-- place, and to turn them off"):
--   Studio admins see every link that went out - client page / approval, event booklet, proposal, invitation website, crew task links,
--   crew home links, vendor request links, delivery links and team join links - newest first: the event, who it is for (a name, never
--   the link itself), Live / Expired / Turned off / Event cancelled / Paused, when it was made, when it ends, when it was last opened.
--   "Turn off" uses the studio's own switch for that kind of link:
--     Event booklet      -> booklet_revoke (0065)                 Proposal          -> publish_proposal(false) (0039)
--     Invitation website -> publish_event_site(false) (0022)       Crew task link    -> revoked_at on that one link (as 0042 does per phone)
--     Crew home link     -> revoked_at on that link (as 0363)      Team join link    -> status revoked (as the Users page does)
--     Client page / approval, vendor request link, delivery link: these have no switch that keeps the link (revoke_approval_token wipes the
--       link and changes the approval status), so a row in the NEW table link_offs turns them off; the one link gate every page already
--       asks (_a260_link_state, 0260) answers "paused" for them -> the page shows "This link has expired. Please ask your event planner
--       to share it again." (no event details). "Turn back on" closes that row (on_at); the link works again as before.
--   "Turn back on" also for a proposal (publish_proposal(true)) and an invitation website (publish_event_site(true); a cancelled event still
--   refuses); "New link" for an invitation website (event_site_new_link) and a crew home link (staff_link_regenerate).
--   Every change writes one audit_log row (studio_link.off / studio_link.on / studio_link.new). Admins only, own studio only.
-- ZERO DATA LOSS: 1 new table (link_offs: rows are never deleted; "back on" stamps on_at; the studio match + read-only guards, in the free-trial clean-up list like the links), functions, 1 wrapper of _a260_link_state (old body
-- kept as _a260_link_state__pre0454). No row, column or token is removed; turning off only sets a timestamp or a status.
-- Paste again after 0260 is ever pasted again (0260 would put the old gate back and links turned off here would work again).

do $$ begin
  if to_regprocedure('public._a260_link_state(text,text)') is null or to_regprocedure('public._a260_quote_state(uuid)') is null then
    raise exception 'STOP 0454: apply 0260 first'; end if;
  if to_regprocedure('public.booklet_revoke(uuid)') is null or to_regprocedure('public.publish_proposal(uuid,boolean)') is null
     or to_regprocedure('public.publish_event_site(uuid,boolean)') is null or to_regprocedure('public.event_site_new_link(uuid)') is null then
    raise exception 'STOP 0454: apply 0065 + 0284 + 0334 first'; end if;
  if to_regclass('public.vendor_request_links') is null or to_regclass('public.delivery_links') is null or to_regclass('public.staff_links') is null
     or to_regclass('public.client_link_opens') is null or to_regprocedure('public.staff_link_regenerate(uuid)') is null then
    raise exception 'STOP 0454: apply 0241 + 0256 + 0261 + 0363 first'; end if;
  if to_regprocedure('public._a42_quote_shelved(uuid)') is null or to_regprocedure('public._a42_expire_open_otps(uuid)') is null
     or to_regprocedure('public.approval_link_age_until(uuid)') is null or to_regprocedure('public.is_admin()') is null then
    raise exception 'STOP 0454: apply 0039 + 0042 first'; end if;
end $$;

-- ---- 1) the switch for links that have no switch of their own (server only) -------------------------------------------------------
create table if not exists public.link_offs (
  id       uuid primary key default gen_random_uuid(),
  org_id   uuid not null references public.organizations(id) on delete cascade,
  kind     text not null check (kind in ('approval', 'vendor', 'delivery')),
  ref_id   uuid not null,          -- approval: the event (quote) id; vendor / delivery: a one-way id of that link (never the link)
  quote_id uuid,
  off_at   timestamptz not null default now(),
  off_by   uuid,
  on_at    timestamptz,             -- "Turn back on": stamped here, the row stays
  on_by    uuid
);
comment on table public.link_offs is 'r271-0454: links turned off in Settings > Links going out. Rows are never deleted; on_at = turned back on.';
create unique index if not exists link_offs_live_uk on public.link_offs(kind, ref_id) where on_at is null;
create index if not exists link_offs_org_ix on public.link_offs(org_id, kind);
alter table public.link_offs enable row level security;
revoke all on table public.link_offs from public, anon, authenticated;
do $$ begin   -- a row always belongs to its event's studio (G4, as every table with quote_id + org_id)
  if to_regprocedure('public.tg_quote_org_match()') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.link_offs'::regclass and tgname = 'zz_quote_org_match') then
    create trigger zz_quote_org_match before insert or update on public.link_offs for each row execute function public.tg_quote_org_match();
  end if;
  if to_regprocedure('public.tg_studio_read_only()') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.link_offs'::regclass and tgname = 'zzz_studio_read_only') then
    create trigger zzz_studio_read_only before insert or update or delete on public.link_offs for each row execute function public.tg_studio_read_only('org_id');
  end if;
end $$;
-- free-trial retention (0184): the switch rows go with the studio's events, like the links themselves (patched in place once, like 0448)
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_purge_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
    if position('''link_offs''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''event_issues'', ', ''))) / length('''event_issues'', ') <> 1 then
        raise notice '0454: _tr184_purge_tables has an unexpected body - left unchanged';
      else execute replace(v_def, '''event_issues'', ', '''event_issues'', ''link_offs'', '); end if;
    end if;
  end if;
end $$;

-- a one-way id for a link whose only key is its token / token hash (md5 of a salted value: the link cannot be worked out from it)
create or replace function public._r271_ref(p_kind text, p_val text)
returns uuid language sql immutable set search_path = '' as $$
  -- r271-0454
  select case when p_val is null then null else md5('r271:' || coalesce(p_kind, '') || ':' || p_val)::uuid end;
$$;
revoke all on function public._r271_ref(text, text) from public, anon, authenticated, service_role;

-- is this link turned off here? (fast "no" while nothing is turned off)
create or replace function public._r271_off(p_kind text, p_ref text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
-- r271-0454
begin
  if p_ref is null or p_kind not in ('approval', 'vendor', 'delivery') then return false; end if;
  if not exists (select 1 from public.link_offs o where o.on_at is null) then return false; end if;
  if p_kind = 'approval' then
    if p_ref !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
    return exists (select 1 from public.quotes q join public.link_offs o on o.kind = 'approval' and o.ref_id = q.id and o.on_at is null
                    where q.approval_token = p_ref::uuid);
  end if;
  if p_ref !~ '^[0-9a-f]{64}$' then return false; end if;
  return exists (select 1 from public.link_offs o where o.kind = p_kind and o.on_at is null
                    and o.ref_id = public._r271_ref(p_kind, encode(pg_catalog.sha256(convert_to(p_ref, 'UTF8')), 'hex')));
end $$;
revoke all on function public._r271_off(text, text) from public, anon, authenticated, service_role;

-- ---- 2) the one link gate (0260) also knows the links turned off here ------------------------------------------------------------
do $$ begin
  if to_regprocedure('public._a260_link_state__pre0454(text,text)') is null then
    alter function public._a260_link_state(text, text) rename to _a260_link_state__pre0454;
  end if;
end $$;
revoke all on function public._a260_link_state__pre0454(text, text) from public, anon, authenticated, service_role;
create or replace function public._a260_link_state(p_kind text, p_ref text)
returns text language plpgsql stable security definer set search_path = '' as $$
-- r271-0454: a link turned off in Settings > Links going out answers like a paused link (the page's "This link has expired" card)
declare v text := public._a260_link_state__pre0454(p_kind, p_ref);
begin
  if v is not null then return v; end if;
  if public._r271_off(p_kind, p_ref) then return 'paused'; end if;
  return null;
end $$;
revoke all on function public._a260_link_state(text, text) from public, anon, authenticated, service_role;

-- ---- 3) who may use the list ------------------------------------------------------------------------------------------------------
create or replace function public._r271_admin()
returns uuid language plpgsql stable security definer set search_path = '' as $$
-- r271-0454: the studio of a signed-in studio admin, else refused
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not coalesce(public.is_admin(), false) then
    raise exception 'Only a studio admin can manage the links going out.' using errcode = '42501';
  end if;
  return v_org;
end $$;
revoke all on function public._r271_admin() from public, anon, authenticated, service_role;

-- ---- 4) the list (no link / token / hash ever leaves this function) ---------------------------------------------------------------
create or replace function public.studio_links_list(p_kind text default null, p_quote uuid default null, p_limit integer default 200,
                                                     p_before timestamptz default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r271-0454
declare v_org uuid := public._r271_admin(); v_lim integer := least(greatest(coalesce(p_limit, 200), 1), 500); v_rows jsonb; v_n integer;
begin
  if p_kind is not null and p_kind not in ('approval', 'booklet', 'proposal', 'site', 'crew', 'staff', 'vendor', 'delivery', 'team') then
    raise exception 'unknown kind of link' using errcode = '22023'; end if;
  with b as (
    -- client page / approval (also the client portal and payment steps: the same link)
    select 'approval'::text k, q.id rid, q.id qid, coalesce(i.issued_at, q.created_at) at0, nullif(btrim(q.client ->> 'name'), '') who,
           q.approval_token_expires_at exp0, op.last_opened_at seen0,
           exists (select 1 from public.link_offs o where o.kind = 'approval' and o.ref_id = q.id and o.on_at is null) off0,
           false dead0, false used0, q.approval_token tok, null::uuid req, null::uuid crew, false newok
      from public.quotes q
      left join public.client_link_issued i on i.kind = 'quote' and i.token = q.approval_token
      left join public.client_link_opens op on op.quote_id = q.id and op.kind = 'quote'
     where q.org_id = v_org and q.approval_token is not null
    union all
    -- event booklet
    select 'booklet', bk.id, bk.quote_id, bk.created_at, nullif(btrim(q.client ->> 'name'), ''), bk.expires_at, op.last_opened_at,
           bk.revoked_at is not null, false, false, null::uuid, null::uuid, null::uuid, false
      from public.client_booklets bk join public.quotes q on q.id = bk.quote_id and q.org_id = bk.org_id
      left join public.client_link_opens op on op.quote_id = bk.quote_id and op.kind = 'booklet'
     where bk.org_id = v_org
    union all
    -- proposal (one per event: the id is the event)
    select 'proposal', pr.quote_id, pr.quote_id, coalesce(i.issued_at, pr.updated_at), nullif(btrim(q.client ->> 'name'), ''), null::timestamptz,
           null::timestamptz, not coalesce(pr.published, false), false, false, pr.share_token, null::uuid, null::uuid, false
      from public.event_proposal pr join public.quotes q on q.id = pr.quote_id and q.org_id = pr.org_id
      left join public.client_link_issued i on i.kind = 'proposal' and i.token = pr.share_token
     where pr.org_id = v_org and pr.share_token is not null
    union all
    -- invitation website (once it has been published it has a link)
    select 'site', s.id, s.quote_id, s.published_at, nullif(btrim(q.client ->> 'name'), ''), null::timestamptz, null::timestamptz,
           s.status <> 'published', false, false, null::uuid, null::uuid, null::uuid, true
      from public.event_sites s join public.quotes q on q.id = s.quote_id and q.org_id = s.org_id
     where s.org_id = v_org and s.published_at is not null and s.slug is not null
    union all
    -- crew task link (one per person per event)
    select 'crew', public._r271_ref('work', w.token::text), w.quote_id, w.created_at, coalesce(nullif(btrim(w.name), ''), 'Crew member'),
           w.expires_at, null::timestamptz, w.revoked_at is not null, false, false, w.token, null::uuid, null::uuid, false
      from public.work_tokens w join public.quotes q on q.id = w.quote_id and q.org_id = w.org_id
     where w.org_id = v_org
    union all
    -- crew home link (one live per person, no event)
    select 'staff', l.id, null::uuid, l.created_at, coalesce(nullif(btrim(cm.name), ''), 'Crew member'), null::timestamptz, l.last_used_at,
           l.revoked_at is not null, not coalesce(cm.active, false), false, null::uuid, null::uuid, l.crew_id, coalesce(cm.active, false)
      from public.staff_links l left join public.crew_members cm on cm.id = l.crew_id and cm.org_id = l.org_id
     where l.org_id = v_org
    union all
    -- vendor request link
    select 'vendor', public._r271_ref('vendor', vl.token_hash), r.quote_id, vl.created_at,
           coalesce(nullif(btrim(vd.name), ''), nullif(btrim(r.vendor_name), ''), 'Vendor'), vl.expires_at, vl.last_used_at,
           exists (select 1 from public.link_offs o where o.kind = 'vendor' and o.ref_id = public._r271_ref('vendor', vl.token_hash) and o.on_at is null),
           false, false, null::uuid, r.id, null::uuid, false
      from public.vendor_request_links vl join public.vendor_requests r on r.id = vl.request_id and r.org_id = vl.org_id
      left join public.vendors vd on vd.id = r.vendor_id and vd.org_id = r.org_id
     where vl.org_id = v_org
    union all
    -- delivery link
    select 'delivery', public._r271_ref('delivery', dl.token_hash), d.quote_id, dl.created_at,
           coalesce(nullif(btrim(d.party_name), ''), nullif(btrim(vd.name), ''), 'Supplier'), dl.expires_at, dl.last_used_at,
           exists (select 1 from public.link_offs o where o.kind = 'delivery' and o.ref_id = public._r271_ref('delivery', dl.token_hash) and o.on_at is null),
           d.status = 'cancelled', false, null::uuid, null::uuid, null::uuid, false
      from public.delivery_links dl join public.delivery_commitments d on d.id = dl.commitment_id and d.org_id = dl.org_id
      left join public.vendors vd on vd.id = d.vendor_id and vd.org_id = d.org_id
     where dl.org_id = v_org
    union all
    -- team join link (invite e-mail)
    select 'team', iv.id, null::uuid, iv.created_at, iv.email, iv.expires_at, iv.accepted_at,
           iv.status = 'revoked', iv.status not in ('pending', 'revoked', 'accepted'), iv.status = 'accepted',
           null::uuid, null::uuid, null::uuid, false
      from public.invitations iv
     where iv.org_id = v_org
  ), pg as (
    select * from b
     where (p_kind is null or b.k = p_kind) and (p_quote is null or b.qid = p_quote) and (p_before is null or b.at0 < p_before)
     order by b.at0 desc nulls last, b.rid
     limit v_lim + 1
  ), x as (
    select pg.*, q.code, q.title,
           case when pg.qid is null then null else public._a260_quote_state(pg.qid) end qs,
           case when pg.qid is null then false else coalesce(public._a42_quote_shelved(pg.qid), false) end shelved,
           nullif(least(coalesce(pg.exp0, 'infinity'::timestamptz),
                        coalesce(case pg.k when 'approval' then public.approval_link_age_until(pg.tok)
                                           when 'proposal' then public.proposal_link_age_until(pg.tok)
                                           when 'crew'     then public.work_link_age_until(pg.tok)
                                           when 'site'     then public.event_site_live_until(pg.rid) end, 'infinity'::timestamptz)),
                  'infinity'::timestamptz) exp
      from pg left join public.quotes q on q.id = pg.qid and q.org_id = v_org
  ), y as (
    select x.*,
           case when x.used0 then 'used'
                when x.qs = 'cancelled' then 'cancelled'
                when x.off0 then 'off'
                when x.qs = 'paused' and x.k <> 'site' then 'paused'
                when x.dead0 or x.shelved or (x.exp is not null and x.exp <= now()) then 'expired'
                else 'live' end st
      from x
  )
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'kind', y.k, 'id', y.rid, 'quote_id', y.qid, 'event_code', y.code, 'event_title', y.title, 'who', y.who,
           'status', y.st, 'created_at', y.at0, 'expires_at', y.exp, 'last_opened_at', y.seen0,
           'request_id', y.req, 'crew_id', y.crew,
           'can_off', not y.off0 and not y.used0,
           'can_on', y.off0 and y.k in ('approval', 'vendor', 'delivery', 'proposal', 'site') and y.qs is distinct from 'cancelled',
           'can_new', y.newok and y.qs is distinct from 'cancelled')) order by y.at0 desc nulls last, y.rid), '[]'::jsonb),
         (select count(*) from pg)
    into v_rows, v_n
    from (select * from y order by y.at0 desc nulls last, y.rid limit v_lim) y;
  return jsonb_build_object('rows', v_rows, 'more', coalesce(v_n, 0) > v_lim,
    'kinds', jsonb_build_array('approval', 'booklet', 'proposal', 'site', 'crew', 'staff', 'vendor', 'delivery', 'team'));
end $$;

-- ---- 5) turn one link off (each kind through its own switch) ----------------------------------------------------------------------
create or replace function public.studio_link_off(p_kind text, p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r271-0454
declare v_org uuid := public._r271_admin(); v_me uuid := auth.uid(); v_q uuid; v_n integer := 0; v_ok boolean; v_email text; v_ref uuid;
begin
  if p_id is null then raise exception 'which link?' using errcode = '22023'; end if;
  if p_kind = 'approval' then
    select q.id into v_q from public.quotes q where q.id = p_id and q.org_id = v_org and q.approval_token is not null for update;
    if v_q is null then raise exception 'That link was not found.' using errcode = 'P0002'; end if;
    insert into public.link_offs(org_id, kind, ref_id, quote_id, off_by) values (v_org, 'approval', v_q, v_q, v_me)
      on conflict (kind, ref_id) where on_at is null do nothing;
    get diagnostics v_n = row_count;
    perform public._a42_expire_open_otps(v_q);                              -- as revoke_approval_token does: open codes stop too
  elsif p_kind = 'booklet' then
    select b.quote_id, b.revoked_at is null into v_q, v_ok from public.client_booklets b where b.id = p_id and b.org_id = v_org;
    if v_q is null then raise exception 'That link was not found.' using errcode = 'P0002'; end if;
    if v_ok then v_n := public.booklet_revoke(v_q); end if;                -- 0065: every live booklet link of that event
  elsif p_kind = 'proposal' then
    select pr.quote_id, coalesce(pr.published, false) into v_q, v_ok from public.event_proposal pr where pr.quote_id = p_id and pr.org_id = v_org;
    if v_q is null then raise exception 'That link was not found.' using errcode = 'P0002'; end if;
    if v_ok then perform public.publish_proposal(v_q, false); v_n := 1; end if;
  elsif p_kind = 'site' then
    select s.quote_id, s.status = 'published' into v_q, v_ok from public.event_sites s where s.id = p_id and s.org_id = v_org;
    if not found then raise exception 'That link was not found.' using errcode = 'P0002'; end if;
    if v_ok then perform public.publish_event_site(p_id, false); v_n := 1; end if;
  elsif p_kind = 'crew' then
    select w.quote_id into v_q from public.work_tokens w where w.org_id = v_org and public._r271_ref('work', w.token::text) = p_id;
    if not found then raise exception 'That link was not found.' using errcode = 'P0002'; end if;
    update public.work_tokens w set revoked_at = now()
     where w.org_id = v_org and w.revoked_at is null and public._r271_ref('work', w.token::text) = p_id;
    get diagnostics v_n = row_count;
    if v_n > 0 then
      insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, org_id, changed)
        values (v_me, (select u.email from auth.users u where u.id = v_me), 'work_links.revoked', 'work_tokens', null, v_q, v_org,
                jsonb_build_object('count', v_n, 'reason', 'settings_links'));
    end if;
  elsif p_kind = 'staff' then
    if not exists (select 1 from public.staff_links l where l.id = p_id and l.org_id = v_org) then
      raise exception 'That link was not found.' using errcode = 'P0002'; end if;
    update public.staff_links l set revoked_at = now() where l.id = p_id and l.org_id = v_org and l.revoked_at is null;
    get diagnostics v_n = row_count;
  elsif p_kind in ('vendor', 'delivery') then
    if p_kind = 'vendor' then
      select r.quote_id into v_q from public.vendor_request_links vl join public.vendor_requests r on r.id = vl.request_id and r.org_id = vl.org_id
       where vl.org_id = v_org and public._r271_ref('vendor', vl.token_hash) = p_id;
    else
      select d.quote_id into v_q from public.delivery_links dl join public.delivery_commitments d on d.id = dl.commitment_id and d.org_id = dl.org_id
       where dl.org_id = v_org and public._r271_ref('delivery', dl.token_hash) = p_id;
    end if;
    if not found then raise exception 'That link was not found.' using errcode = 'P0002'; end if;
    insert into public.link_offs(org_id, kind, ref_id, quote_id, off_by) values (v_org, p_kind, p_id, v_q, v_me)
      on conflict (kind, ref_id) where on_at is null do nothing;
    get diagnostics v_n = row_count;
  elsif p_kind = 'team' then
    if not exists (select 1 from public.invitations iv where iv.id = p_id and iv.org_id = v_org) then
      raise exception 'That link was not found.' using errcode = 'P0002'; end if;
    update public.invitations iv set status = 'revoked' where iv.id = p_id and iv.org_id = v_org and iv.status = 'pending';
    get diagnostics v_n = row_count;
  else
    raise exception 'unknown kind of link' using errcode = '22023';
  end if;
  if v_n > 0 then
    select u.email into v_email from auth.users u where u.id = v_me;
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
      values (v_me, v_email, 'studio_link.off', 'studio_links', p_kind || ':' || p_id::text, v_q, jsonb_build_object('kind', p_kind, 'count', v_n), v_org);
  end if;
  return jsonb_build_object('ok', true, 'kind', p_kind, 'id', p_id, 'changed', v_n > 0);
end $$;

-- ---- 6) several at once (each one on its own: one that fails does not stop the others) ---------------------------------------------
create or replace function public.studio_links_off(p_items jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r271-0454
declare v_org uuid := public._r271_admin(); it jsonb; v_done integer := 0; v_fail jsonb := '[]'::jsonb; r jsonb;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Tick the links to turn off first.' using errcode = '22023'; end if;
  if jsonb_array_length(p_items) > 100 then raise exception 'At most 100 links at a time.' using errcode = '22023'; end if;
  for it in select e from jsonb_array_elements(p_items) e loop
    begin
      if jsonb_typeof(it) <> 'object' or coalesce(it ->> 'id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'which link?' using errcode = '22023'; end if;
      r := public.studio_link_off(it ->> 'kind', (it ->> 'id')::uuid);
      if coalesce((r ->> 'changed')::boolean, false) then v_done := v_done + 1; end if;
    exception when others then
      v_fail := v_fail || jsonb_build_array(jsonb_build_object('kind', left(it ->> 'kind', 20), 'id', left(it ->> 'id', 40), 'error', left(sqlerrm, 200)));
    end;
  end loop;
  return jsonb_build_object('ok', jsonb_array_length(v_fail) = 0, 'turned_off', v_done, 'failed', v_fail);
end $$;

-- ---- 7) turn back on (only where a safe way exists) ----------------------------------------------------------------------------
create or replace function public.studio_link_on(p_kind text, p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r271-0454
declare v_org uuid := public._r271_admin(); v_me uuid := auth.uid(); v_q uuid; v_n integer := 0; v_email text;
begin
  if p_id is null then raise exception 'which link?' using errcode = '22023'; end if;
  if p_kind in ('approval', 'vendor', 'delivery') then
    select o.quote_id into v_q from public.link_offs o where o.kind = p_kind and o.ref_id = p_id and o.org_id = v_org and o.on_at is null;
    if not found then return jsonb_build_object('ok', true, 'kind', p_kind, 'id', p_id, 'changed', false); end if;
    if public._a260_quote_cancelled(v_q) then raise exception 'This event is cancelled - restore it first.' using errcode = '22023'; end if;
    update public.link_offs o set on_at = now(), on_by = v_me where o.kind = p_kind and o.ref_id = p_id and o.org_id = v_org and o.on_at is null;
    get diagnostics v_n = row_count;
  elsif p_kind = 'proposal' then
    select pr.quote_id into v_q from public.event_proposal pr where pr.quote_id = p_id and pr.org_id = v_org and not coalesce(pr.published, false);
    if v_q is not null then
      if public._a260_quote_cancelled(v_q) then raise exception 'This event is cancelled - restore it first.' using errcode = '22023'; end if;
      perform public.publish_proposal(v_q, true); v_n := 1;
    end if;
  elsif p_kind = 'site' then
    select s.quote_id into v_q from public.event_sites s where s.id = p_id and s.org_id = v_org and s.status <> 'published';
    if found then perform public.publish_event_site(p_id, true); v_n := 1; end if;   -- a cancelled event refuses (0260 trigger)
  else
    raise exception 'This link cannot be turned back on here. Open its page to send a new one.' using errcode = '22023';
  end if;
  if v_n > 0 then
    select u.email into v_email from auth.users u where u.id = v_me;
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
      values (v_me, v_email, 'studio_link.on', 'studio_links', p_kind || ':' || p_id::text, v_q, jsonb_build_object('kind', p_kind), v_org);
  end if;
  return jsonb_build_object('ok', true, 'kind', p_kind, 'id', p_id, 'changed', v_n > 0);
end $$;

-- ---- 8) a new link (the old one stops; the new one is copied on its own page) -----------------------------------------------------
create or replace function public.studio_link_new(p_kind text, p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r271-0454: answers ok only - the new link is never returned here
declare v_org uuid := public._r271_admin(); v_me uuid := auth.uid(); v_q uuid; v_crew uuid; v_email text;
begin
  if p_id is null then raise exception 'which link?' using errcode = '22023'; end if;
  if p_kind = 'site' then
    select s.quote_id into v_q from public.event_sites s where s.id = p_id and s.org_id = v_org;
    if not found then raise exception 'That link was not found.' using errcode = 'P0002'; end if;
    perform public.event_site_new_link(p_id);
  elsif p_kind = 'staff' then
    select l.crew_id into v_crew from public.staff_links l where l.id = p_id and l.org_id = v_org;
    if v_crew is null then raise exception 'That link was not found.' using errcode = 'P0002'; end if;
    perform public.staff_link_regenerate(v_crew);
  else
    raise exception 'A new link for this one is made on its own page.' using errcode = '22023';
  end if;
  select u.email into v_email from auth.users u where u.id = v_me;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
    values (v_me, v_email, 'studio_link.new', 'studio_links', p_kind || ':' || p_id::text, v_q, jsonb_build_object('kind', p_kind), v_org);
  return jsonb_build_object('ok', true, 'kind', p_kind, 'id', p_id, 'changed', true);
end $$;

do $$ declare f text; r text; begin
  foreach f in array array['studio_links_list(text,uuid,integer,timestamptz)', 'studio_link_off(text,uuid)', 'studio_links_off(jsonb)',
                           'studio_link_on(text,uuid)', 'studio_link_new(text,uuid)'] loop
    execute format('revoke all on function public.%s from public', f);
    foreach r in array array['anon', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function public.%s from %I', f, r); end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function public.%s to authenticated', f); end if;
  end loop;
  if to_regclass('public.helm_schema_markers') is not null then
    insert into public.helm_schema_markers(num, name) values (454, '0454_r271_links') on conflict (num) do nothing;
  end if;
end $$;

notify pgrst, 'reload schema';

-- ---- CHECK (read only): every row must say true -------------------------------------------------------------------------------
select c."check", c.ok from (values
  ('01 the switch table is there, closed to the app', to_regclass('public.link_offs') is not null
      and (select c2.relrowsecurity from pg_class c2 where c2.oid = 'public.link_offs'::regclass)
      and not has_table_privilege('authenticated', 'public.link_offs', 'select') and not has_table_privilege('anon', 'public.link_offs', 'select')),
  ('02 the link gate knows links turned off', position('r271-0454' in pg_get_functiondef('public._a260_link_state(text,text)'::regprocedure)) > 0
      and to_regprocedure('public._a260_link_state__pre0454(text,text)') is not null
      and not has_function_privilege('anon', 'public._a260_link_state__pre0454(text,text)', 'execute')),
  ('03 the list and the switches: signed-in only, never anon', has_function_privilege('authenticated', 'public.studio_links_list(text,uuid,integer,timestamptz)', 'execute')
      and has_function_privilege('authenticated', 'public.studio_link_off(text,uuid)', 'execute')
      and has_function_privilege('authenticated', 'public.studio_links_off(jsonb)', 'execute')
      and has_function_privilege('authenticated', 'public.studio_link_on(text,uuid)', 'execute')
      and has_function_privilege('authenticated', 'public.studio_link_new(text,uuid)', 'execute')
      and not has_function_privilege('anon', 'public.studio_links_list(text,uuid,integer,timestamptz)', 'execute')
      and not has_function_privilege('anon', 'public.studio_link_off(text,uuid)', 'execute')
      and not has_function_privilege('anon', 'public.studio_links_off(jsonb)', 'execute')),
  ('04 helpers server only, search_path pinned', not has_function_privilege('authenticated', 'public._r271_off(text,text)', 'execute')
      and not has_function_privilege('authenticated', 'public._r271_admin()', 'execute') and not has_function_privilege('anon', 'public._r271_ref(text,text)', 'execute')
      and (select bool_and(p.proconfig @> array['search_path=""']) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('studio_links_list', 'studio_link_off', 'studio_links_off', 'studio_link_on', 'studio_link_new', '_r271_off', '_r271_admin', '_r271_ref'))),
  ('05 turning off uses the existing switches', position('booklet_revoke' in pg_get_functiondef('public.studio_link_off(text,uuid)'::regprocedure)) > 0
      and position('publish_proposal' in pg_get_functiondef('public.studio_link_off(text,uuid)'::regprocedure)) > 0
      and position('publish_event_site' in pg_get_functiondef('public.studio_link_off(text,uuid)'::regprocedure)) > 0),
  ('06 admins only, every change in the activity log', position('is_admin' in pg_get_functiondef('public._r271_admin()'::regprocedure)) > 0
      and position('studio_link.off' in pg_get_functiondef('public.studio_link_off(text,uuid)'::regprocedure)) > 0
      and position('studio_link.on' in pg_get_functiondef('public.studio_link_on(text,uuid)'::regprocedure)) > 0)
) c("check", ok);
commit;
