-- APPLY-0447 (R259: one vendor flow - products and prices, the vendor's answer, approve, invoice e-mails, invoice lines). Run on STAGING first, then Canada production, then HELM-PROD-MUMBAI.
-- Safe to run twice. It stops before changing anything if a function it needs is missing.
-- Same content as supabase/migrations/0447_r259_vendor_flow.sql. The last result lists one row per check.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '5min';
-- 0447_r259_vendor_flow.sql - R259 (owner, 25 Nov 2026: vendors answer available, enter their price per product, attach a PDF or photo; the studio
-- approves; after the event "please send your invoice" goes out by itself). Forward-only, additive, safe to run twice. ASCII only. Paste the whole file
-- in the Supabase SQL editor; the last statement answers one row per check. The pages work without it (they behave as before).
-- REQUIRES 0256, 0260, 0274, 0300, 0334, 0342, 0361. Uses 0373 / 0404 as they are.
--
-- In plain words:
--   A  ASK. vendor_request_ask(p): a request with up to 30 products (name, quantity, optional agreed price each). The agreed total is their sum, or a
--      typed total, or nothing ("the vendor tells us the price"). It is a 0256 request (same booking, e-mail queue, link).
--   B  ANSWER. On the link: available (price per product or one total, lower quantities, delivery / other charges, discount, note, one PDF / photo) or
--      not available (with the reason). It can be changed until the studio confirms. Exactly the agreed prices and the full quantities = confirmed at
--      once, as Accept does today; everything else waits for the studio. Older offers are kept as superseded (vendor_offers).
--   C  APPROVE. vendor_offer_review: approve (booking confirmed at that amount by the 0256 accept step; a one-product booking takes the quantity) /
--      ask to change / decline. Right = Vendors edit, the one that records an answer today. Every step is in vendor_request_log.
--   D  PLEASE SEND YOUR INVOICE. 10:00 studio time the day after the event, again 3 and 7 days later; only for requests confirmed after this file and
--      before that day. Stops when an invoice or a bill is in, or the request / booking / event is cancelled. One switch per studio (Settings,
--      Automations: vendor_invoice_ask, ON). By hand: vendor_invoice_ask - also for a booked vendor without a request, up to 60 days after the event.
--   E  INVOICE LINES. vendor_invoice_submit also takes products, charges, discount and (outside India) one tax amount; the taxable value must be their
--      sum. Review works as before. vendor_bills rows get the event's currency; the one tax amount counts as a cost unless it is ticked as claimable.
--   F  The request e-mail names the event by type, never by title (as 0300 does on the page); e-mails carry the product list.
--
-- ZERO DATA LOSS: 1 new table, new columns (nullable or with a default), 2 check constraints widened, functions (old bodies kept once as __pre0447).
-- No stored row is changed or deleted. SWITCH OFF the automatic mail everywhere, one line:
--   create or replace function public._r447_ask_on(p_org uuid) returns boolean language sql stable security definer set search_path = '' as 'select false';

-- ---- 0) preflight ---------------------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  foreach f in array array['public._vr256_text(public.vendor_requests,text,text,text)', 'public._vr256_inv(public.vendor_invoices,boolean)', 'public._vr256_row(public.vendor_requests)',
      'public._vr256_public(public.vendor_requests)', 'public._vr256_on_accept(uuid,text,uuid,text)', 'public._vr256_issue(public.vendor_requests,text)', 'public._vr256_block(public.vendor_requests,text)',
      'public._vr256_queue(public.vendor_requests,text,text)', 'public.tg_vr256_guard()', 'public.vendor_invoice_submit__pre0260(text,jsonb)', 'public.vendor_invoice_review(uuid,text,text,jsonb)',
      'public.vendor_invoice_upload_ok(text)', 'public.vendor_invoice_file_visible(text)', 'public.vendor_request_reassign(uuid,uuid,numeric,text)', 'public.vendor_request_save(jsonb)',
      'public.vendor_request_claim(integer,text)', 'public.vendor_requests_tick()', 'public.vendor_requests_summary(uuid)', 'public.automation_overview()', 'public.automation_switch(text,boolean)',
      'public._r361_on(uuid)', 'public._r125_ref_closed(text,text)', 'public._a260_link_state(text,text)', 'public._r342_max_attempts(text)', 'public._r300_event_label(text)', 'public._r300_tg_vendor_invoice_file()',
      'public.studio_timezone(uuid)', 'public._tb179_no_send(uuid)', 'public._trial_locked(uuid)', 'public.tg_studio_read_only()', 'public.tg_quote_org_match()', 'public.rate_hit(text,text,integer,integer)'] loop
    if to_regprocedure(f) is null and not (f like 'public._r342_max_attempts%' and exists (select 1 from pg_proc where proname = '_r342_max_attempts' and pronamespace = 'public'::regnamespace)) then
      raise exception 'STOP 0447: % is missing - an earlier update is not on this database; nothing was changed', f; end if;
  end loop;
end $$;

-- ---- 1) keep helper (same shape as _r445_keep) ------------------------------------------------------------------------------------
create or replace function public._r447_keep(p_fn text)
returns void language plpgsql volatile security definer set search_path = '' as $$
-- r259-0447
declare v_oid oid := to_regprocedure(p_fn); v_name text; v_types text; v_def text; v_pre text; r text;
begin
  if v_oid is null then return; end if;
  select p.proname, oidvectortypes(p.proargtypes) into v_name, v_types from pg_proc p where p.oid = v_oid;
  v_pre := format('public.%I(%s)', v_name || '__pre0447', v_types);
  if to_regprocedure(v_pre) is null then
    v_def := pg_get_functiondef(v_oid);
    v_def := regexp_replace(v_def, '^CREATE OR REPLACE FUNCTION public\.' || v_name || '\(', 'CREATE OR REPLACE FUNCTION public.' || v_name || '__pre0447(');
    if position(v_name || '__pre0447(' in v_def) = 0 then raise exception 'r259-0447: could not keep %', p_fn; end if;
    execute v_def;
  end if;
  execute format('revoke all on function %s from public', v_pre);
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', v_pre, r); end if;
  end loop;
end $$;

-- ---- 2) columns + the offers table ------------------------------------------------------------------------------------------------
alter table public.vendor_requests add column if not exists lines jsonb;
alter table public.vendor_requests add column if not exists price_open boolean not null default false;
alter table public.vendor_requests add column if not exists invoice_only boolean not null default false;
alter table public.vendor_requests add column if not exists asked_amount numeric;
alter table public.vendor_requests add column if not exists confirmed_at timestamptz;
alter table public.vendor_requests add column if not exists declined_by text;
alter table public.vendor_requests add column if not exists client_key uuid;
alter table public.vendor_invoice_grants add column if not exists purpose text not null default 'invoice';
alter table public.vendor_invoices add column if not exists lines jsonb;
alter table public.vendor_invoices add column if not exists charges numeric;
alter table public.vendor_invoices add column if not exists discount numeric;
alter table public.vendor_invoices add column if not exists tax_amount numeric;
alter table public.vendor_invoices add column if not exists client_key uuid;
alter table public.automation_settings add column if not exists vendor_invoice_ask_enabled boolean not null default true;

create table if not exists public.vendor_offers (
  id           uuid primary key default gen_random_uuid(),
  seq          bigint generated always as identity,
  org_id       uuid not null references public.organizations(id) on delete cascade,
  quote_id     uuid not null references public.quotes(id) on delete cascade,
  request_id   uuid not null references public.vendor_requests(id) on delete cascade,
  mode         text not null,
  lines        jsonb not null,
  lines_total  numeric not null default 0,
  charges      numeric not null default 0,
  discount     numeric not null default 0,
  total        numeric not null,
  note         text,
  storage_path text,
  mime         text,
  status       text not null default 'offered',
  via          text not null default 'link',
  review_note  text,
  reviewed_at  timestamptz,
  reviewed_by  uuid,
  created_at   timestamptz not null default clock_timestamp(),
  constraint vendor_offers_mode_chk447 check (mode in ('lines', 'total')),
  constraint vendor_offers_status_chk447 check (status in ('offered', 'change_asked', 'approved', 'declined', 'superseded', 'withdrawn')),
  constraint vendor_offers_via_chk447 check (via in ('link', 'studio')),
  constraint vendor_offers_money_chk447 check (lines_total >= 0 and charges >= 0 and discount >= 0 and total >= 0 and total < 1000000000000),
  constraint vendor_offers_lines_chk447 check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) between 1 and 30),
  constraint vendor_offers_text_chk447 check (char_length(coalesce(note, '')) <= 500 and char_length(coalesce(review_note, '')) <= 500 and coalesce(note, '') !~ '[<>]'),
  constraint vendor_offers_file_chk447 check ((storage_path is null and mime is null)
    or (storage_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(pdf|jpg|png|webp)$' and mime in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')))
);
comment on table public.vendor_offers is 'r259-0447: what a vendor answered to a request (quantities, prices, total, note, one file). Content never changes; older answers stay as superseded.';
create index if not exists vendor_offers_request447 on public.vendor_offers (request_id, seq desc);
create index if not exists vendor_offers_org447 on public.vendor_offers (org_id);
create index if not exists vendor_offers_quote447 on public.vendor_offers (quote_id);
create unique index if not exists vendor_offers_one_open447 on public.vendor_offers (request_id) where status in ('offered', 'change_asked');
create unique index if not exists vendor_offers_path447 on public.vendor_offers (storage_path) where storage_path is not null;
create unique index if not exists vendor_requests_key447 on public.vendor_requests (org_id, client_key) where client_key is not null;
create unique index if not exists vendor_invoices_key447 on public.vendor_invoices (request_id, client_key) where client_key is not null;
create index if not exists vendor_requests_confirmed447 on public.vendor_requests (quote_id) where status = 'accepted' and confirmed_at is not null;

do $$ declare r text; v_def text; begin
  alter table public.vendor_offers enable row level security;
  revoke all on table public.vendor_offers from public;
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on table public.vendor_offers from %I', r); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant select on table public.vendor_offers to service_role; end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.vendor_offers'::regclass and tgname = 'zz_quote_org_match') then
    create trigger zz_quote_org_match before insert or update on public.vendor_offers for each row execute function public.tg_quote_org_match(); end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.vendor_offers'::regclass and tgname = 'zzz_studio_read_only') then
    create trigger zzz_studio_read_only before insert or update or delete on public.vendor_offers for each row execute function public.tg_studio_read_only('org_id'); end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.vendor_offers'::regclass and tgname = 'a300_vendor_invoice_file') then
    create trigger a300_vendor_invoice_file before insert on public.vendor_offers for each row execute function public._r300_tg_vendor_invoice_file(); end if;
  -- checks added / widened once (idempotent by what they say now; every stored row satisfies them)
  if not exists (select 1 from pg_constraint where conrelid = 'public.vendor_requests'::regclass and conname = 'vendor_requests_flow_chk447') then
    alter table public.vendor_requests add constraint vendor_requests_flow_chk447 check ((declined_by is null or declined_by in ('vendor', 'studio'))
      and (lines is null or (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) between 1 and 30)) and (asked_amount is null or asked_amount >= 0)); end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.vendor_invoice_grants'::regclass and conname = 'vendor_invoice_grants_purpose_chk447') then
    alter table public.vendor_invoice_grants add constraint vendor_invoice_grants_purpose_chk447 check (purpose in ('invoice', 'offer')); end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.vendor_invoices'::regclass and conname = 'vendor_invoices_flow_chk447') then
    alter table public.vendor_invoices add constraint vendor_invoices_flow_chk447 check ((lines is null or (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) between 1 and 30))
      and coalesce(charges, 0) >= 0 and coalesce(discount, 0) >= 0 and coalesce(tax_amount, 0) >= 0 and (coalesce(tax_amount, 0) = 0 or (cgst = 0 and sgst = 0 and igst = 0))); end if;
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c where c.conrelid = 'public.vendor_invoices'::regclass and c.conname = 'vendor_invoices_total_ck';
  if position('tax_amount' in coalesce(v_def, '')) = 0 then
    alter table public.vendor_invoices drop constraint if exists vendor_invoices_total_ck;
    alter table public.vendor_invoices add constraint vendor_invoices_total_ck check (abs(total_amount - (taxable_amount + cgst + sgst + igst + coalesce(tax_amount, 0))) < 0.005);
  end if;
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c where c.conrelid = 'public.vendor_request_sends'::regclass and c.conname = 'vendor_request_sends_kind_check';
  if position('invoice_ask' in coalesce(v_def, '')) = 0 then
    alter table public.vendor_request_sends drop constraint if exists vendor_request_sends_kind_check;
    alter table public.vendor_request_sends add constraint vendor_request_sends_kind_check check (kind in ('request', 'reminder', 'change', 'confirmed', 'invoice_ask', 'invoice_auto'));
  end if;
  -- free-trial retention (0184): offers go with the studio's events (patched in place once)
  if to_regprocedure('public._tr184_purge_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
    if position('''vendor_offers''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''vendor_invoice_grants'', ', ''))) / length('''vendor_invoice_grants'', ') <> 1 then
        raise notice '0447: _tr184_purge_tables has an unexpected body - left unchanged';
      else execute replace(v_def, '''vendor_invoice_grants'', ', '''vendor_offers'', ''vendor_invoice_grants'', '); end if;
    end if;
  end if;
end $$;

do $$ declare f text; begin
  foreach f in array array['public._vr256_text(public.vendor_requests,text,text,text)', 'public._vr256_inv(public.vendor_invoices,boolean)', 'public._vr256_row(public.vendor_requests)',
      'public._vr256_public(public.vendor_requests)', 'public._vr256_on_accept(uuid,text,uuid,text)', 'public.tg_vr256_guard()', 'public.vendor_invoice_submit__pre0260(text,jsonb)',
      'public.vendor_invoice_review(uuid,text,text,jsonb)', 'public.vendor_invoice_upload_ok(text)', 'public.vendor_invoice_file_visible(text)', 'public.vendor_request_reassign(uuid,uuid,numeric,text)',
      'public.vendor_request_claim(integer,text)', 'public.vendor_requests_tick()', 'public.vendor_requests_summary(uuid)', 'public.automation_overview()', 'public.automation_switch(text,boolean)'] loop
    perform public._r447_keep(f);
  end loop;
end $$;

-- ---- 3) small helpers (server only) ------------------------------------------------------------------------------------------------
-- a number from the page: 0 or more, at most 2 decimals, below the cap
create or replace function public._r447_num(p jsonb, p_label text, p_max numeric)
returns numeric language plpgsql immutable set search_path = '' as $$
-- r259-0447
declare v numeric;
begin
  if p is null or jsonb_typeof(p) = 'null' then return null; end if;
  if jsonb_typeof(p) <> 'number' then raise exception 'enter a number for %', p_label using errcode = '22023', hint = 'r447_num'; end if;
  v := (p #>> '{}')::numeric;
  if v < 0 or v > p_max then raise exception 'enter % between 0 and %', p_label, p_max using errcode = '22023', hint = 'r447_num'; end if;
  if v <> round(v, 2) then raise exception 'enter % with at most 2 decimals', p_label using errcode = '22023', hint = 'r447_num'; end if;
  return v;
end $$;

create or replace function public._r447_txt(p text, p_label text, p_min integer, p_max integer)
returns text language plpgsql immutable set search_path = '' as $$
-- r259-0447
declare v text := nullif(btrim(regexp_replace(coalesce(p, ''), '[[:cntrl:][:space:]]+', ' ', 'g')), '');
begin
  if char_length(coalesce(v, '')) < p_min or char_length(coalesce(v, '')) > p_max then
    raise exception 'enter % (% to % characters)', p_label, p_min, p_max using errcode = '22023', hint = 'r447_text'; end if;
  if coalesce(v, '') ~ '[<>]' then raise exception 'the % may not contain < or >', p_label using errcode = '22023', hint = 'r447_text'; end if;
  return v;
end $$;

create or replace function public._r447_uuid(p text)
returns uuid language sql immutable set search_path = '' as $$
  -- r259-0447
  select case when p ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p::uuid end;
$$;

create or replace function public._r447_cur(p_org uuid, p_quote uuid)
returns text language sql stable security definer set search_path = '' as $$
  -- r259-0447: the event's currency, else the studio's
  select coalesce((select x.c from (select upper(btrim(coalesce(nullif(btrim(q.currency), ''), q.pricing ->> 'currency', ''))) as c from public.quotes q where q.id = p_quote and q.org_id = p_org) x where x.c ~ '^[A-Z]{3}$'),
                  (select upper(btrim(o.currency)) from public.organizations o where o.id = p_org and upper(btrim(coalesce(o.currency, ''))) ~ '^[A-Z]{3}$'), 'INR');
$$;
create or replace function public._r447_gst(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r259-0447: GST fields only for a studio in India (an empty country is India, as everywhere)
  select coalesce((select upper(nullif(btrim(coalesce(o.country, o.brand #>> '{billing,country}', '')), '')) from public.organizations o where o.id = p_org), 'IN') = 'IN';
$$;

-- the products of a request; an older request (no list) is one product made from what / quantity / agreed amount. p_money = with prices, p_inner = with the need
create or replace function public._r447_lines(p_r public.vendor_requests, p_money boolean, p_inner boolean)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r259-0447
declare v jsonb := p_r.lines; v_q numeric;
begin
  if v is null then
    v_q := coalesce(round(p_r.qty, 2), 1); if v_q <= 0 then v_q := 1; end if;
    v := jsonb_build_array(jsonb_build_object('id', 'l1', 'name', left(p_r.what, 120), 'unit', null, 'qty', v_q, 'need_id', null,
           'price', case when not p_r.price_open and round(round(p_r.agreed_amount / v_q, 2) * v_q, 2) = p_r.agreed_amount then round(p_r.agreed_amount / v_q, 2) end));
  end if;
  return (select jsonb_agg((x.v - 'need_id' - 'price') || case when p_money then jsonb_build_object('price', x.v -> 'price') else '{}'::jsonb end
                           || case when p_inner then jsonb_build_object('need_id', x.v -> 'need_id') else '{}'::jsonb end order by x.n)
            from jsonb_array_elements(v) with ordinality x(v, n));
end $$;

create or replace function public._r447_offer(p_o public.vendor_offers, p_money boolean, p_studio boolean)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- r259-0447
  select jsonb_build_object('id', p_o.id, 'mode', p_o.mode, 'status', p_o.status, 'note', p_o.note, 'via', p_o.via, 'review_note', p_o.review_note,
      'has_file', p_o.storage_path is not null, 'at', p_o.created_at, 'at_text', public._dl241_when(p_o.created_at, p_o.org_id),
      'lines', (select jsonb_agg(case when p_money then x.v else x.v - 'price' - 'total' - 'asked_price' end order by x.n) from jsonb_array_elements(p_o.lines) with ordinality x(v, n)))
    || case when p_money then jsonb_build_object('lines_total', p_o.lines_total, 'charges', p_o.charges, 'discount', p_o.discount, 'total', p_o.total) else '{}'::jsonb end
    || case when p_studio and p_money then jsonb_build_object('storage_path', p_o.storage_path, 'mime', p_o.mime, 'reviewed_text', public._dl241_when(p_o.reviewed_at, p_o.org_id),
         'reviewed_by', case when p_o.reviewed_by is not null then public._vr256_label(p_o.reviewed_by) end) else '{}'::jsonb end;
$$;

-- what was agreed in the end (the approved answer, else the request as it was accepted): the invoice form starts from this
create or replace function public._r447_confirmed(p_r public.vendor_requests)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r259-0447
declare o public.vendor_offers;
begin
  if p_r.status <> 'accepted' then return null; end if;
  select * into o from public.vendor_offers x where x.request_id = p_r.id and x.org_id = p_r.org_id and x.status = 'approved' order by x.seq desc limit 1;
  if o.id is null then
    return jsonb_build_object('lines', public._r447_lines(p_r, true, false), 'charges', 0, 'discount', 0, 'total', case when p_r.price_open or (p_r.invoice_only and p_r.agreed_amount = 0) then null else p_r.agreed_amount end);
  end if;
  return jsonb_build_object('lines', (select coalesce(jsonb_agg(jsonb_build_object('id', x.v ->> 'id', 'name', x.v ->> 'name', 'unit', x.v -> 'unit', 'qty', x.v -> 'qty', 'price', x.v -> 'price') order by x.n), '[]'::jsonb)
        from jsonb_array_elements(o.lines) with ordinality x(v, n) where (x.v ->> 'qty')::numeric > 0),
    'charges', o.charges, 'discount', o.discount, 'total', o.total);
end $$;

-- a vendor who said "not available" may still change their mind while nothing else happened with it
create or replace function public._r447_can_reopen(p_r public.vendor_requests)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r259-0447
  select p_r.status = 'rejected' and coalesce(p_r.declined_by, '') = 'vendor' and p_r.replaced_by is null
     and (p_r.booking_id is null or (exists (select 1 from public.event_resources b where b.id = p_r.booking_id and b.status <> 'cancelled' and b.vendor_id is not distinct from p_r.vendor_id)
          and not exists (select 1 from public.vendor_requests x where x.booking_id = p_r.booking_id and x.id <> p_r.id and x.status in ('sent', 'accepted'))));
$$;

create or replace function public._r447_ask_on(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r259-0447: "Please send your invoice" e-mails, on unless the studio switched them off
  select coalesce((select s.vendor_invoice_ask_enabled from public.automation_settings s where s.org_id = p_org), true);
$$;

create or replace function public._r447_last_day(p_quote uuid)
returns date language sql stable security definer set search_path = '' as $$
  -- r259-0447: the event's last day (0424 may or may not be there)
  select coalesce((to_jsonb(q) ->> 'event_end_date')::date, q.event_date) from public.quotes q where q.id = p_quote;
$$;

-- an invoice (or a bill typed by the studio) is in
create or replace function public._r447_invoice_in(p_r public.vendor_requests)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r259-0447
  select exists (select 1 from public.vendor_invoices i where i.request_id = p_r.id and i.status in ('submitted', 'queried', 'approved'))
      or (p_r.booking_id is not null and exists (select 1 from public.vendor_bills b where b.booking_id = p_r.booking_id and b.org_id = p_r.org_id and b.status <> 'void'));
$$;

-- may this vendor be asked for an invoice (now)? null = yes
create or replace function public._r447_ask_block(p_r public.vendor_requests)
returns text language plpgsql stable security definer set search_path = '' as $$
-- r259-0447
declare q record;
begin
  if p_r.status is distinct from 'accepted' then return 'not_confirmed'; end if;
  select x.status, x.deleted_at, x.lifecycle_stage into q from public.quotes x where x.id = p_r.quote_id and x.org_id = p_r.org_id;
  if not found or q.deleted_at is not null or q.status in ('cancelled', 'lost') or coalesce(q.lifecycle_stage, '') in ('cancelled', 'archived') then return 'event_closed'; end if;
  if p_r.booking_id is null or not exists (select 1 from public.event_resources b where b.id = p_r.booking_id and b.status <> 'cancelled') then return 'booking_cancelled'; end if;
  if public._r447_invoice_in(p_r) then return 'invoice_in'; end if;
  return null;
end $$;

-- queue one e-mail of the new kinds (never for a trial / sample / read-only studio); answers {queued, reason}
create or replace function public._r447_queue(p_r public.vendor_requests, p_kind text, p_slot text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r259-0447
declare v_id uuid; v_block text;
begin
  if p_r.contact_email is null then return jsonb_build_object('queued', false, 'reason', 'no_email'); end if;
  insert into public.vendor_request_sends(org_id, request_id, kind, channel, recipient, dedupe_key)
    values (p_r.org_id, p_r.id, p_kind, 'email', p_r.contact_email, 'vr:' || p_r.id || ':' || p_slot || ':email')
    on conflict (dedupe_key) do nothing returning id into v_id;
  if v_id is null then return jsonb_build_object('queued', false, 'reason', 'already'); end if;
  v_block := public._vr256_block(p_r, p_r.contact_email);
  if v_block is not null then
    update public.vendor_request_sends set status = 'skipped', reason = left(v_block, 60), sent_at = now() where id = v_id;
    return jsonb_build_object('queued', false, 'reason', v_block);
  end if;
  return jsonb_build_object('queued', true);
end $$;

-- ---- 4) guards ---------------------------------------------------------------------------------------------------------------------
-- an offer's content never changes; a decided one is final
create or replace function public._r447_tg_offer()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r259-0447
begin
  if (to_jsonb(new) - 'status' - 'review_note' - 'reviewed_at' - 'reviewed_by') is distinct from (to_jsonb(old) - 'status' - 'review_note' - 'reviewed_at' - 'reviewed_by') then
    raise exception 'A vendor''s answer cannot be changed - a new one replaces it.' using errcode = '42501'; end if;
  if old.status not in ('offered', 'change_asked') and new.status is distinct from old.status then
    raise exception 'This offer was already answered.' using errcode = '22023', hint = 'r447_stale'; end if;
  return new;
end $$;
drop trigger if exists ab_r447_offer on public.vendor_offers;
create trigger ab_r447_offer before update on public.vendor_offers for each row execute function public._r447_tg_offer();

create or replace function public.tg_vr256_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
-- vendor-requests-0256 + r259-0447: who declined is kept; a vendor who was not available may answer again; invoice lines never change
begin
  if new.org_id is distinct from old.org_id or new.quote_id is distinct from old.quote_id then
    raise exception 'A vendor request cannot move to another event.' using errcode = '42501'; end if;
  if tg_table_name = 'vendor_invoices' then
    if new.request_id is distinct from old.request_id or new.invoice_no is distinct from old.invoice_no
       or new.taxable_amount is distinct from old.taxable_amount or new.cgst is distinct from old.cgst
       or new.sgst is distinct from old.sgst or new.igst is distinct from old.igst or new.total_amount is distinct from old.total_amount
       or new.lines is distinct from old.lines or new.charges is distinct from old.charges or new.discount is distinct from old.discount or new.tax_amount is distinct from old.tax_amount
       or new.storage_path is distinct from old.storage_path or new.invoice_date is distinct from old.invoice_date then
      raise exception 'A submitted invoice cannot be changed - ask the vendor to send a corrected one.' using errcode = '42501'; end if;
    if old.status in ('approved', 'rejected', 'superseded') and new.status is distinct from old.status then
      raise exception 'This invoice was already decided.' using errcode = '22023'; end if;
    if old.bill_id is not null and new.bill_id is distinct from old.bill_id then
      raise exception 'The bill of an approved invoice cannot change.' using errcode = '42501'; end if;
  else
    if old.status in ('rejected', 'cancelled', 'reassigned') and new.status is distinct from old.status
       and not (old.status = 'rejected' and new.status = 'sent' and public._r447_can_reopen(old)) then
      raise exception 'This vendor request is closed.' using errcode = '22023'; end if;
    if new.status = 'rejected' and old.status <> 'rejected' and new.declined_by is not distinct from old.declined_by then new.declined_by := 'vendor'; end if;
    if new.status = 'sent' and old.status = 'rejected' then new.declined_by := null; end if;
  end if;
  return new;
end $$;

-- a request that is answered / closed another way: its open offer is kept as superseded (or withdrawn when the vendor said no)
create or replace function public._r447_tg_request_done()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r259-0447
begin
  if new.status is distinct from old.status and new.status <> 'sent' then
    update public.vendor_offers set status = case when new.status = 'rejected' and coalesce(new.declined_by, '') = 'vendor' then 'withdrawn' else 'superseded' end
     where request_id = new.id and status in ('offered', 'change_asked');
  end if;
  return null;
end $$;
drop trigger if exists zz_r447_request_done on public.vendor_requests;
create trigger zz_r447_request_done after update of status on public.vendor_requests for each row execute function public._r447_tg_request_done();

-- ---- 5) bodies that change (kept as __pre0447) ----------------------------------------------------------------------------------------
create or replace function public._vr256_text(p_r public.vendor_requests, p_event text, p_note text, p_extra text)
returns text language plpgsql stable security definer set search_path = '' as $$
-- r259-0447: two more notices; every other one is the kept body. No money.
declare v text; v_what text; v_code text;
begin
  if p_event not in ('offer', 'offer_again', 'booked') then return public._vr256_text__pre0447(p_r, p_event, p_note, p_extra); end if;
  v_what := p_r.what || case when p_r.qty is not null then ' x' || trim(to_char(p_r.qty, 'FM9999999990.##'), '.') else '' end;
  select q.code into v_code from public.quotes q where q.id = p_r.quote_id;
  v := case p_event when 'booked' then chr(9989) || ' Price approved: ' || p_r.vendor_name || ' is booked for ' || v_what || ' (' || public._dl241_when(p_r.when_at, p_r.org_id) || ')'
       else chr(128172) || ' ' || p_r.vendor_name || ' is available and sent ' || case when p_event = 'offer_again' then 'a new price' else 'a price' end || ' for ' || v_what || ' - waiting for your approval' end;
  if v_code is not null then v := v || ' ' || chr(183) || ' ' || v_code; end if;
  return left(v, 600);
end $$;

create or replace function public._vr256_inv(p_i public.vendor_invoices, p_studio boolean)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- r259-0447: + the products of the invoice
  select public._vr256_inv__pre0447(p_i, p_studio) || jsonb_build_object('lines', p_i.lines, 'charges', coalesce(p_i.charges, 0), 'discount', coalesce(p_i.discount, 0), 'tax_amount', coalesce(p_i.tax_amount, 0));
$$;

create or replace function public._r447_state(p_r public.vendor_requests)
returns text language plpgsql stable security definer set search_path = '' as $$
-- r259-0447: asked | available | change | declined | confirmed | invoice_asked | invoice_received | invoice_query | invoice_approved | paid | closed
declare v text;
begin
  if p_r.status in ('cancelled', 'reassigned') then return 'closed'; end if;
  if p_r.status = 'rejected' then return 'declined'; end if;
  if p_r.status = 'sent' then
    select o.status into v from public.vendor_offers o where o.request_id = p_r.id and o.status in ('offered', 'change_asked') limit 1;
    return case v when 'offered' then 'available' when 'change_asked' then 'change' else 'asked' end;
  end if;
  if exists (select 1 from public.vendor_invoices i where i.request_id = p_r.id and i.status = 'submitted') then return 'invoice_received'; end if;
  if exists (select 1 from public.vendor_invoices i where i.request_id = p_r.id and i.status = 'queried') then return 'invoice_query'; end if;
  if exists (select 1 from public.vendor_invoices i where i.request_id = p_r.id and i.status = 'approved') then
    return case when exists (select 1 from public.vendor_invoices i where i.request_id = p_r.id and i.status = 'approved'
        and coalesce((select sum(p.amount) from public.vendor_payouts p where p.bill_id = i.bill_id), 0) + 0.005 < i.total_amount) then 'invoice_approved' else 'paid' end;
  end if;
  if exists (select 1 from public.vendor_request_log l where l.request_id = p_r.id and l.event = 'invoice_asked') then return 'invoice_asked'; end if;
  return 'confirmed';
end $$;

create or replace function public._vr256_row(p_r public.vendor_requests)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r259-0447: the kept answer + products, the vendor's offers, where it stands, the event's currency
declare v jsonb := public._vr256_row__pre0447(p_r); v_money boolean := coalesce((v ->> 'can_money')::boolean, false); o public.vendor_offers; v_open boolean; l record;
begin
  select * into o from public.vendor_offers x where x.request_id = p_r.id and x.org_id = p_r.org_id order by x.seq desc limit 1;
  v_open := coalesce(o.status = 'offered', false) and p_r.status = 'sent';
  select x.at, x.note into l from public.vendor_request_log x where x.request_id = p_r.id and x.event = 'invoice_asked' order by x.at desc limit 1;
  v := v || jsonb_build_object('flow', 447, 'lines', public._r447_lines(p_r, v_money, true), 'has_lines', p_r.lines is not null, 'price_open', p_r.price_open, 'invoice_only', p_r.invoice_only,
    'declined_by', p_r.declined_by, 'state', public._r447_state(p_r), 'offer_open', v_open, 'offer', case when o.id is not null then public._r447_offer(o, v_money, true) end,
    'offers', coalesce((select jsonb_agg(public._r447_offer(x, v_money, true) order by x.seq desc) from (select z.* from public.vendor_offers z where z.request_id = p_r.id and z.org_id = p_r.org_id order by z.seq desc limit 10) x), '[]'::jsonb),
    'gst', public._r447_gst(p_r.org_id), 'currency', public._r447_cur(p_r.org_id, p_r.quote_id), 'invoice_asked_text', public._dl241_when(l.at, p_r.org_id),
    'ask_block', public._r447_ask_block(p_r), 'ask_auto', p_r.confirmed_at is not null and public._r447_ask_on(p_r.org_id));
  if v_open then v := v || jsonb_build_object('overdue_reply', false); end if;
  if v_money then
    v := v || jsonb_build_object('asked_amount', p_r.asked_amount, 'confirmed', public._r447_confirmed(p_r));
    if p_r.price_open then v := v || jsonb_build_object('agreed_amount', null, 'over_agreed', false); end if;
  end if;
  return v;
end $$;

create or replace function public._vr256_public(p_r public.vendor_requests)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r259-0447: the kept answer (0300: the event by type, never by title) + the vendor's own products, their last answer, currency + tax kind
declare v jsonb := public._vr256_public__pre0447(p_r); o public.vendor_offers; v_lock boolean := coalesce(public._trial_locked(p_r.org_id), false);
begin
  select * into o from public.vendor_offers x where x.request_id = p_r.id and x.org_id = p_r.org_id and (p_r.status <> 'accepted' or x.status = 'approved') order by x.seq desc limit 1;
  return v || jsonb_build_object('flow', 447, 'lines', public._r447_lines(p_r, true, false), 'price_open', p_r.price_open, 'invoice_only', p_r.invoice_only,
    'agreed_amount', case when p_r.price_open or (p_r.invoice_only and p_r.agreed_amount = 0) then null else p_r.agreed_amount end,
    'currency', public._r447_cur(p_r.org_id, p_r.quote_id), 'gst', public._r447_gst(p_r.org_id), 'declined_by', p_r.declined_by,
    'today', to_char((now() at time zone public.studio_timezone(p_r.org_id))::date, 'YYYY-MM-DD'),
    'offer', case when o.id is not null then public._r447_offer(o, true, false) end, 'confirmed', public._r447_confirmed(p_r),
    'can_respond', not v_lock and (p_r.status = 'sent' or public._r447_can_reopen(p_r)), 'max_lines', 30);
end $$;

-- accept: no booking without a price; when it was confirmed is kept; a one-product booking takes the quantity the vendor brings
create or replace function public._vr256_on_accept(p_id uuid, p_kind text, p_actor uuid, p_label text)
returns void language plpgsql volatile security definer set search_path = '' as $$
-- r259-0447
declare r public.vendor_requests; o public.vendor_offers; v_q numeric; b record;
begin
  select * into r from public.vendor_requests x where x.id = p_id for update;
  if r.price_open then raise exception 'enter the price first - open the request and press Available' using errcode = '22023', hint = 'r447_price_open'; end if;
  perform public._vr256_on_accept__pre0447(p_id, p_kind, p_actor, p_label);
  update public.vendor_requests set confirmed_at = coalesce(confirmed_at, now()) where id = p_id;
  select * into o from public.vendor_offers x where x.request_id = p_id and x.status = 'approved' order by x.seq desc limit 1;
  if o.id is not null and jsonb_array_length(o.lines) = 1 and r.booking_id is not null then
    v_q := (o.lines -> 0 ->> 'qty')::numeric;
    select x.id, x.qty into b from public.event_resources x where x.id = r.booking_id and x.org_id = r.org_id and x.status <> 'cancelled' for update;
    if b.id is not null and b.qty is not null and v_q > 0 and b.qty is distinct from v_q and (o.lines -> 0 ->> 'asked_qty')::numeric is not distinct from b.qty then
      update public.event_resources set qty = v_q, updated_at = now() where id = b.id;
      perform public._vr256_log(p_id, r.org_id, 'booking_quantity', 'Booking quantity ' || trim(to_char(b.qty, 'FM9999999990.##'), '.') || ' -> ' || trim(to_char(v_q, 'FM9999999990.##'), '.'), p_kind, p_actor, p_label);
    end if;
  end if;
end $$;

create or replace function public.vendor_request_reassign(p_id uuid, p_vendor uuid, p_agreed numeric default null, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r259-0447: the kept reassign; the new request keeps the products (and "tell us your price" when no amount was typed)
declare v jsonb; o public.vendor_requests; n public.vendor_requests; v_same boolean;
begin
  select * into o from public.vendor_requests x where x.id = p_id and x.org_id = public.current_org_id();
  if o.invoice_only then raise exception 'this is only an invoice request - book the new vendor on the Resource plan' using errcode = '22023'; end if;
  v := public.vendor_request_reassign__pre0447(p_id, p_vendor, case when o.price_open and p_agreed is null then 0 else p_agreed end, p_note);
  select * into n from public.vendor_requests x where x.id = (v ->> 'id')::uuid and x.org_id = public.current_org_id() for update;
  if n.id is null or (o.lines is null and not o.price_open) then return v; end if;
  v_same := p_agreed is null or p_agreed = o.agreed_amount;
  update public.vendor_requests set price_open = o.price_open and p_agreed is null, asked_amount = case when o.price_open and p_agreed is null then null else n.agreed_amount end,
      lines = case when o.lines is null or v_same then o.lines else (select jsonb_agg(x.v || jsonb_build_object('price', null) order by x.n) from jsonb_array_elements(o.lines) with ordinality x(v, n)) end
   where id = n.id returning * into n;
  if n.price_open and n.booking_id is not null then update public.event_resources set cost = null, updated_at = now() where id = n.booking_id and org_id = n.org_id and status = 'enquiry'; end if;
  return public._vr256_row(n) || jsonb_build_object('link', v -> 'link', 'queued', v -> 'queued');
end $$;

create or replace function public.vendor_requests_summary(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r259-0447: the kept counts + prices waiting for approval
begin
  return public.vendor_requests_summary__pre0447(p_quote) || jsonb_build_object('offers_to_review', (select count(*) from public.vendor_offers o join public.vendor_requests r on r.id = o.request_id
    where r.quote_id = p_quote and r.org_id = public.current_org_id() and r.status = 'sent' and o.status = 'offered'));
end $$;

-- ---- 6) the studio asks ----------------------------------------------------------------------------------------------------------------
create or replace function public.vendor_request_ask(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r259-0447
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); k text; x record; v_key uuid; r public.vendor_requests; v_lines jsonb := '[]'::jsonb; v_n integer := 0; v_name text; v_unit text;
  v_qty numeric; v_price numeric; v_need uuid; v_all boolean := true; v_sum numeric := 0; v_total numeric; v_open boolean; v_what text := ''; v_row jsonb; v_link jsonb; v_queued integer := 0; v_quote uuid;
begin
  if v_me is null or v_org is null or not public._vr256_can('assign') then raise exception 'not authorized' using errcode = '42501'; end if;
  if p is null or jsonb_typeof(p) <> 'object' or octet_length(p::text) > 30000 then raise exception 'request must be an object' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('quote_id', 'vendor_id', 'booking_id', 'lines', 'agreed_total', 'when_at', 'where_text', 'details', 'respond_by', 'send', 'key') then raise exception 'unknown field %', k using errcode = '22023'; end if;
  end loop;
  v_key := public._r447_uuid(p ->> 'key'); v_quote := public._r447_uuid(p ->> 'quote_id');
  if v_key is not null then
    perform pg_catalog.pg_advisory_xact_lock(hashtextextended('r447:ask:' || v_org::text || v_key::text, 0));   -- the same press twice = one request
    select * into r from public.vendor_requests q where q.org_id = v_org and q.client_key = v_key;
    if r.id is not null then return public._vr256_row(r) || jsonb_build_object('same', true, 'link', case when r.status in ('sent', 'accepted') then public._vr256_issue(r, 'copy') end, 'queued', 0); end if;
  end if;
  if jsonb_typeof(p -> 'lines') is distinct from 'array' or jsonb_array_length(p -> 'lines') not between 1 and 30 then raise exception 'add 1 to 30 products' using errcode = '22023'; end if;
  for x in select e.v from jsonb_array_elements(p -> 'lines') with ordinality e(v, n) order by e.n loop
    if jsonb_typeof(x.v) <> 'object' then raise exception 'a product must be an object' using errcode = '22023'; end if;
    for k in select jsonb_object_keys(x.v) loop if k not in ('name', 'qty', 'unit', 'price', 'need_id') then raise exception 'unknown field %', k using errcode = '22023'; end if; end loop;
    v_n := v_n + 1; v_name := public._r447_txt(x.v ->> 'name', 'the product name', 1, 120); v_unit := public._r447_txt(x.v ->> 'unit', 'the unit', 0, 20);
    v_qty := public._r447_num(x.v -> 'qty', 'the quantity', 1000000); v_price := public._r447_num(x.v -> 'price', 'the price', 10000000000);
    if v_qty is null or v_qty <= 0 then raise exception 'enter the quantity of % (above 0)', v_name using errcode = '22023'; end if;
    v_need := public._r447_uuid(x.v ->> 'need_id');
    if v_need is not null and not exists (select 1 from public.event_resource_needs e where e.id = v_need and e.quote_id = v_quote and e.org_id = v_org) then v_need := null; end if;
    if v_price is null then v_all := false; else v_sum := v_sum + round(v_qty * v_price, 2); end if;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('id', 'l' || v_n, 'name', v_name, 'unit', v_unit, 'qty', v_qty, 'price', v_price, 'need_id', v_need));
    v_what := v_what || case when v_n > 1 then ', ' else '' end || v_name;
  end loop;
  v_total := case when v_all then v_sum else public._r447_num(p -> 'agreed_total', 'the agreed total', 999999999999) end;
  v_open := v_total is null;
  if v_total >= 1000000000000 then raise exception 'the agreed total is too large' using errcode = '22023'; end if;
  if char_length(v_what) > 200 then v_what := left(v_what, 190) || '...'; end if;
  v_row := public.vendor_request_save(jsonb_build_object('quote_id', p -> 'quote_id', 'vendor_id', p -> 'vendor_id', 'booking_id', p -> 'booking_id', 'what', v_what,
    'qty', case when v_n = 1 then v_lines -> 0 -> 'qty' else 'null'::jsonb end, 'when_at', p -> 'when_at', 'where_text', p -> 'where_text', 'details', p -> 'details', 'agreed_amount', coalesce(v_total, 0),
    'respond_by', p -> 'respond_by', 'send', false));
  v_link := v_row -> 'link';
  update public.vendor_requests set lines = v_lines, price_open = v_open, asked_amount = v_total, client_key = v_key, currency = public._r447_cur(v_org, quote_id)
   where id = (v_row ->> 'id')::uuid and org_id = v_org returning * into r;
  -- no price agreed yet: the booking made for this request has no cost yet (not 0)
  if v_open and r.booking_created then update public.event_resources set cost = null, updated_at = now() where id = r.booking_id and org_id = v_org and status = 'enquiry'; end if;
  if coalesce((p ->> 'send')::boolean, true) then v_queued := public._vr256_queue(r, 'request', 'request'); end if;
  return public._vr256_row(r) || jsonb_build_object('link', v_link, 'queued', v_queued);
end $$;

-- ---- 7) the vendor answers ----------------------------------------------------------------------------------------------------------------
-- stores one answer of a locked, open request (older ones become superseded) and confirms it when it is exactly what was agreed
create or replace function public._r447_offer_put(p_r public.vendor_requests, p jsonb, p_via text, p_actor uuid, p_label text, p_token_hash text)
returns public.vendor_offers language plpgsql volatile security definer set search_path = '' as $$
-- r259-0447
declare r public.vendor_requests := p_r; o public.vendor_offers; g public.vendor_invoice_grants; v_ask jsonb; a record; e jsonb; v_seen text[] := '{}'; v_id text; v_key uuid := public._r447_uuid(p ->> 'key');
  v_mode text := coalesce(p ->> 'mode', 'lines'); v_lines jsonb := '[]'::jsonb; v_q numeric; v_pr numeric; v_tot numeric; v_sum numeric := 0; v_qsum numeric := 0; v_ch numeric; v_di numeric; v_total numeric; v_note text;
  v_same boolean := true; v_path text; v_again boolean; k text;
begin
  for k in select jsonb_object_keys(p) loop
    if k not in ('available', 'reason', 'mode', 'lines', 'charges', 'discount', 'total', 'note', 'file_path', 'key', 'approve') then raise exception 'unknown field %', k using errcode = '22023'; end if;
  end loop;
  if v_mode not in ('lines', 'total') then raise exception 'unknown answer' using errcode = '22023'; end if;
  if jsonb_typeof(p -> 'lines') is distinct from 'array' or jsonb_array_length(p -> 'lines') > 30 then raise exception 'enter the products' using errcode = '22023'; end if;
  v_ask := public._r447_lines(r, true, false);
  if jsonb_array_length(p -> 'lines') <> jsonb_array_length(v_ask) then raise exception 'the products changed - please open the link again' using errcode = '22023', hint = 'r447_lines'; end if;
  for a in select x.v from jsonb_array_elements(v_ask) with ordinality x(v, n) order by x.n loop
    v_id := a.v ->> 'id'; e := null;
    select y.v into e from jsonb_array_elements(p -> 'lines') y(v) where jsonb_typeof(y.v) = 'object' and y.v ->> 'id' = v_id limit 1;
    if e is null or v_id = any(v_seen) then raise exception 'the products changed - please open the link again' using errcode = '22023', hint = 'r447_lines'; end if;
    for k in select jsonb_object_keys(e) loop if k not in ('id', 'qty', 'price') then raise exception 'unknown field %', k using errcode = '22023'; end if; end loop;
    v_seen := v_seen || v_id;
    v_q := public._r447_num(e -> 'qty', 'the quantity of ' || (a.v ->> 'name'), 1000000); v_pr := public._r447_num(e -> 'price', 'the price of ' || (a.v ->> 'name'), 10000000000);
    if v_q is null then raise exception 'enter the quantity of %', a.v ->> 'name' using errcode = '22023'; end if;
    if v_q > (a.v ->> 'qty')::numeric then raise exception 'the quantity of % cannot be more than %', a.v ->> 'name', trim(to_char((a.v ->> 'qty')::numeric, 'FM9999999990.##'), '.') using errcode = '22023'; end if;
    if v_mode = 'total' then v_pr := null; elsif v_pr is null and v_q > 0 then raise exception 'enter the price of %', a.v ->> 'name' using errcode = '22023'; end if;
    v_tot := case when v_mode = 'lines' then round(v_q * coalesce(v_pr, 0), 2) end;
    v_sum := v_sum + coalesce(v_tot, 0); v_qsum := v_qsum + v_q;
    if v_q <> (a.v ->> 'qty')::numeric then v_same := false; end if;
    if v_mode = 'lines' and jsonb_typeof(a.v -> 'price') = 'number' and v_pr is distinct from (a.v ->> 'price')::numeric then v_same := false; end if;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('id', v_id, 'name', a.v ->> 'name', 'unit', a.v -> 'unit', 'asked_qty', a.v -> 'qty', 'asked_price', a.v -> 'price', 'qty', v_q, 'price', v_pr, 'total', v_tot));
  end loop;
  if v_qsum <= 0 then raise exception 'enter a quantity for at least one product, or choose Not available' using errcode = '22023'; end if;
  v_ch := coalesce(public._r447_num(p -> 'charges', 'the delivery / other charges', 10000000000), 0);
  v_di := coalesce(public._r447_num(p -> 'discount', 'the discount', 10000000000), 0);
  v_total := public._r447_num(p -> 'total', 'the total', 999999999999);
  if v_mode = 'total' then
    if v_total is null then raise exception 'enter the total price' using errcode = '22023'; end if;
    if v_ch > 0 or v_di > 0 then raise exception 'enter one total price with everything in it' using errcode = '22023'; end if;
  else
    if v_di > v_sum + v_ch then raise exception 'the discount cannot be more than the price' using errcode = '22023'; end if;
    if v_total is not null and abs(v_total - (v_sum + v_ch - v_di)) > 0.005 then raise exception 'the total does not match the products - please check the prices' using errcode = '22023', hint = 'r447_total'; end if;
    v_total := v_sum + v_ch - v_di;
  end if;
  if v_total >= 1000000000000 then raise exception 'the total is too large' using errcode = '22023'; end if;
  if v_total <= 0 and (r.price_open or r.agreed_amount > 0) then raise exception 'enter your price (above 0)' using errcode = '22023'; end if;
  v_note := public._r447_txt(p ->> 'note', 'the note', 0, 500);
  v_path := btrim(coalesce(p ->> 'file_path', ''));
  if v_path <> '' then
    select * into g from public.vendor_invoice_grants x where x.path = v_path and x.token_hash = p_token_hash and x.request_id = r.id and x.purpose = 'offer'
       and x.used_at is null and x.expires_at > now() - interval '15 minutes' for update;
    if g.id is null then raise exception 'upload not found or expired - please attach the file again' using errcode = '42501'; end if;
    if not exists (select 1 from storage.objects s where s.bucket_id = 'vendor-invoices' and s.name = g.path) then raise exception 'the file did not arrive - please attach it again' using errcode = '22023'; end if;
  end if;
  v_again := exists (select 1 from public.vendor_offers x where x.request_id = r.id);
  update public.vendor_offers set status = 'superseded' where request_id = r.id and status in ('offered', 'change_asked');
  if r.status = 'rejected' then update public.vendor_requests set status = 'sent', updated_at = now() where id = r.id returning * into r; end if;
  insert into public.vendor_offers(id, org_id, quote_id, request_id, mode, lines, lines_total, charges, discount, total, note, storage_path, mime, via)
    values (coalesce(v_key, gen_random_uuid()), r.org_id, r.quote_id, r.id, v_mode, v_lines, v_sum, v_ch, v_di, v_total, v_note, g.path, g.mime, p_via) returning * into o;
  if g.id is not null then update public.vendor_invoice_grants set used_at = now() where id = g.id; end if;
  if v_same and not r.price_open and v_ch = 0 and v_di = 0 and abs(v_total - r.agreed_amount) < 0.005 then
    update public.vendor_offers set status = 'approved', reviewed_at = now() where id = o.id returning * into o;
    update public.vendor_requests set status = 'accepted', response_note = v_note, responded_at = now(), responded_via = p_via, updated_at = now() where id = r.id returning * into r;
    perform public._vr256_log(r.id, r.org_id, 'accepted', coalesce(v_note, 'At the agreed price'), case when p_via = 'link' then 'link' else 'user' end, p_actor, p_label);
    perform public._vr256_on_accept(r.id, case when p_via = 'link' then 'link' else 'user' end, p_actor, p_label);
    perform public._vr256_announce(r.id, 'accepted', v_note, null);
  else
    update public.vendor_requests set responded_at = now(), responded_via = p_via, response_note = v_note, no_response_at = null, updated_at = now() where id = r.id;
    perform public._vr256_log(r.id, r.org_id, 'offer', 'Total ' || trim(to_char(v_total, 'FM999999999990.00')) || case when not v_same then ' (not exactly as asked)' else '' end || case when g.id is not null then ', with a file' else '' end || coalesce(' - ' || v_note, ''),
      case when p_via = 'link' then 'link' else 'user' end, p_actor, p_label);
    perform public._vr256_announce(r.id, case when v_again then 'offer_again' else 'offer' end, null, null);
  end if;
  return o;
end $$;

create or replace function public.vendor_link_offer(p_token text, p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r259-0447: the link page's answer (signed out: the 64-hex token is the only key)
declare l public.vendor_request_links; r public.vendor_requests; o public.vendor_offers; v text; v_key uuid; v_label text; v_note text;
begin
  if coalesce(p_token, '') !~ '^[0-9a-f]{64}$' or public._r125_ref_closed('vendor', p_token) then return jsonb_build_object('ok', false); end if;
  v := public._a260_link_state('vendor', p_token);
  if v is not null then return jsonb_build_object('ok', false, 'reason', v); end if;
  if public.rate_hit('vendor_link_offer', left(public._vr256_hash(p_token), 32), 600, 20) > 0 then return jsonb_build_object('ok', false, 'reason', 'rate'); end if;
  l := public._vr256_link(p_token);
  if l.token_hash is null then return jsonb_build_object('ok', false); end if;
  if p is null or jsonb_typeof(p) <> 'object' or octet_length(p::text) > 20000 or jsonb_typeof(p -> 'available') is distinct from 'boolean' then raise exception 'unknown answer' using errcode = '22023'; end if;
  select * into r from public.vendor_requests x where x.id = l.request_id and x.org_id = l.org_id for update;
  if r.id is null then return jsonb_build_object('ok', false); end if;
  v_key := public._r447_uuid(p ->> 'key'); v_label := left(r.vendor_name || ' (vendor link)', 160);
  if v_key is not null then
    select * into o from public.vendor_offers x where x.id = v_key;
    if o.id is not null then
      if o.request_id <> r.id then raise exception 'please open the link again' using errcode = '42501'; end if;
      return public._vr256_public(r);   -- the same press twice
    end if;
  end if;
  if (p ->> 'available')::boolean is false and r.status = 'rejected' and coalesce(r.declined_by, '') = 'vendor' then return public._vr256_public(r); end if;
  if coalesce(public._trial_locked(r.org_id), false) or not (r.status = 'sent' or public._r447_can_reopen(r)) then
    return public._vr256_public(r) || jsonb_build_object('ok', false, 'reason', 'closed'); end if;
  update public.vendor_request_links set uses = uses + 1, last_used_at = now() where token_hash = l.token_hash;
  if (p ->> 'available')::boolean then
    perform public._r447_offer_put(r, p, 'link', null, v_label, l.token_hash);
  else
    v_note := public._r447_txt(p ->> 'reason', 'why you cannot take this', 3, 500);
    update public.vendor_requests set status = 'rejected', declined_by = 'vendor', response_note = v_note, responded_at = now(), responded_via = 'link', updated_at = now() where id = r.id;
    perform public._vr256_log(r.id, r.org_id, 'rejected', v_note, 'link', null, v_label);
    perform public._vr256_announce(r.id, 'rejected', v_note, null);
  end if;
  select * into r from public.vendor_requests x where x.id = l.request_id;
  return public._vr256_public(r);
end $$;

-- one-time upload grant for the vendor's own quotation (same bucket, same limits as an invoice)
create or replace function public.vendor_offer_upload(p_token text, p_mime text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r259-0447
declare l public.vendor_request_links; r public.vendor_requests; v_mime text := lower(btrim(coalesce(p_mime, ''))); v_ext text; v_path text; n integer; v text;
begin
  if coalesce(p_token, '') !~ '^[0-9a-f]{64}$' or public._r125_ref_closed('vendor', p_token) then raise exception 'link not valid' using errcode = '42501'; end if;
  v := public._a260_link_state('vendor', p_token);
  if v is not null then return jsonb_build_object('ok', false, 'reason', v); end if;
  l := public._vr256_link(p_token);
  if l.token_hash is null then raise exception 'link not valid' using errcode = '42501'; end if;
  select * into r from public.vendor_requests x where x.id = l.request_id and x.org_id = l.org_id;
  if r.id is null or not (r.status = 'sent' or public._r447_can_reopen(r)) then raise exception 'this request was already answered or closed' using errcode = '22023'; end if;
  if coalesce(public._trial_locked(r.org_id), false) then raise exception 'This studio is read-only' using errcode = '25006'; end if;
  v_ext := case v_mime when 'application/pdf' then 'pdf' when 'image/jpeg' then 'jpg' when 'image/png' then 'png' when 'image/webp' then 'webp' end;
  if v_ext is null then raise exception 'the file must be a PDF, JPEG, PNG or WebP file' using errcode = '22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(hashtextextended('helm:vendor-invoice:' || l.token_hash, 0));
  select count(*) into n from public.vendor_invoice_grants g where g.token_hash = l.token_hash and g.created_at > now() - interval '1 hour';
  if n >= 20 then raise exception 'too many uploads from this link - try again in an hour' using errcode = '54000'; end if;
  v_path := r.org_id::text || '/' || r.quote_id::text || '/' || r.id::text || '/' || gen_random_uuid()::text || '.' || v_ext;
  insert into public.vendor_invoice_grants(token_hash, request_id, org_id, quote_id, path, mime, purpose) values (l.token_hash, r.id, r.org_id, r.quote_id, v_path, v_mime, 'offer');
  return jsonb_build_object('bucket', 'vendor-invoices', 'path', v_path, 'mime', v_mime, 'max_bytes', 10485760);
end $$;

-- storage policies point at these two functions (same function, body replaced in place)
create or replace function public.vendor_invoice_upload_ok(p_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
-- r125-0334 + r259-0447: or a quotation file of an open request (a one-time grant of that link)
begin
  if public._r125_closed(public._r125_path_org(p_name)) then return false; end if;
  return public.vendor_invoice_upload_ok__pre0447(p_name)
    or (coalesce(p_name, '') ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(pdf|jpg|png|webp)$'
        and exists (select 1 from public.vendor_invoice_grants g join public.vendor_request_links l on l.token_hash = g.token_hash and l.expires_at > now()
                      join public.vendor_requests r on r.id = g.request_id and (r.status = 'sent' or public._r447_can_reopen(r))
                     where g.path = p_name and g.purpose = 'offer' and g.used_at is null and g.expires_at > now())
        and not exists (select 1 from storage.objects o where o.bucket_id = 'vendor-invoices' and o.name = p_name));
end $$;
create or replace function public.vendor_invoice_file_visible(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r259-0447: + the file of an offer
  select public.vendor_invoice_file_visible__pre0447(p_name)
      or (public._vr256_can('money') and exists (select 1 from public.vendor_offers o where o.storage_path = p_name and o.org_id = public.current_org_id()));
$$;

-- ---- 8) the studio answers an offer -------------------------------------------------------------------------------------------------------
create or replace function public.vendor_offer_review(p_offer uuid, p_action text, p_note text default null, p_send boolean default true)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r259-0447
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); o public.vendor_offers; r public.vendor_requests; v_note text; v_label text; v_q jsonb;
begin
  if v_me is null or v_org is null or not public._vr256_can('assign') or not public._vr256_can('money') then raise exception 'not authorized' using errcode = '42501'; end if;
  if coalesce(public._trial_locked(v_org), false) then raise exception 'This studio is read-only' using errcode = '25006'; end if;
  if p_action is null or p_action not in ('approve', 'change', 'decline') then raise exception 'unknown action' using errcode = '22023'; end if;
  v_note := public._r447_txt(p_note, 'a message to the vendor', case when p_action = 'approve' then 0 else 3 end, 500);
  select * into o from public.vendor_offers x where x.id = p_offer and x.org_id = v_org;
  if o.id is null then raise exception 'offer not found' using errcode = 'P0002'; end if;
  select * into r from public.vendor_requests x where x.id = o.request_id and x.org_id = v_org for update;
  select * into o from public.vendor_offers x where x.id = p_offer for update;
  if o.status = 'approved' and p_action = 'approve' then return public._vr256_row(r) || jsonb_build_object('same', true); end if;
  if o.status <> 'offered' or r.status <> 'sent' then raise exception 'The vendor sent a newer answer, or this one was already decided. Look again.' using errcode = '22023', hint = 'r447_stale'; end if;
  v_label := public._vr256_label(v_me);
  if p_action = 'approve' then
    if exists (select 1 from public.quotes q where q.id = r.quote_id and (q.deleted_at is not null or q.status in ('cancelled', 'lost'))) then raise exception 'This event is cancelled.' using errcode = '22023'; end if;
    update public.vendor_offers set status = 'approved', review_note = v_note, reviewed_at = now(), reviewed_by = v_me where id = o.id;
    update public.vendor_requests set status = 'accepted', asked_amount = coalesce(asked_amount, case when not price_open then agreed_amount end), agreed_amount = o.total, price_open = false,
        qty = case when jsonb_array_length(o.lines) = 1 and qty is not null then (o.lines -> 0 ->> 'qty')::numeric else qty end,
        responded_at = coalesce(responded_at, now()), responded_via = coalesce(responded_via, o.via), updated_at = now()
     where id = r.id returning * into r;
    perform public._vr256_log(r.id, v_org, 'offer_approved', 'Total ' || trim(to_char(o.total, 'FM999999999990.00')) || coalesce(' (asked ' || trim(to_char(r.asked_amount, 'FM999999999990.00')) || ')', '') || coalesce(' - ' || v_note, ''), 'user', v_me, v_label);
    perform public._vr256_on_accept(r.id, 'user', v_me, v_label);
    perform public._vr256_announce(r.id, 'booked', null, null);
    if coalesce(p_send, true) then v_q := public._r447_queue(r, 'confirmed', 'confirmed:' || o.id); end if;
  elsif p_action = 'change' then
    update public.vendor_offers set status = 'change_asked', review_note = v_note, reviewed_at = now(), reviewed_by = v_me where id = o.id;
    update public.vendor_requests set respond_by = greatest(respond_by, least(now() + interval '48 hours', greatest(when_at - interval '2 hours', now() + interval '2 hours'))), no_response_at = null, updated_at = now() where id = r.id returning * into r;
    perform public._vr256_log(r.id, v_org, 'offer_change', v_note, 'user', v_me, v_label);
    if coalesce(p_send, true) then v_q := public._r447_queue(r, 'change', 'change:' || o.id); end if;
  else
    update public.vendor_offers set status = 'declined', review_note = v_note, reviewed_at = now(), reviewed_by = v_me where id = o.id;
    update public.vendor_requests set status = 'rejected', declined_by = 'studio', updated_at = now() where id = r.id returning * into r;
    perform public._vr256_log(r.id, v_org, 'offer_declined', v_note, 'user', v_me, v_label);
  end if;
  select * into r from public.vendor_requests x where x.id = r.id;
  return public._vr256_row(r) || jsonb_build_object('mail', v_q);
end $$;

-- the vendor told their price by phone: the same record (p.approve = confirm it at once)
create or replace function public.vendor_request_record_offer(p_id uuid, p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r259-0447
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); r public.vendor_requests; o public.vendor_offers; v_key uuid;
begin
  if v_me is null or v_org is null or not public._vr256_can('assign') then raise exception 'not authorized' using errcode = '42501'; end if;
  if coalesce(public._trial_locked(v_org), false) then raise exception 'This studio is read-only' using errcode = '25006'; end if;
  if p is null or jsonb_typeof(p) <> 'object' or octet_length(p::text) > 20000 then raise exception 'unknown answer' using errcode = '22023'; end if;
  if coalesce(p ->> 'file_path', '') <> '' then raise exception 'unknown field file_path' using errcode = '22023'; end if;
  select * into r from public.vendor_requests x where x.id = p_id and x.org_id = v_org for update;
  if r.id is null then raise exception 'request not found' using errcode = 'P0002'; end if;
  v_key := public._r447_uuid(p ->> 'key');
  if v_key is not null then
    select * into o from public.vendor_offers x where x.id = v_key;
    if o.id is not null then
      if o.request_id <> r.id then raise exception 'not authorized' using errcode = '42501'; end if;
      return public._vr256_row(r);
    end if;
  end if;
  if r.status <> 'sent' then raise exception 'this request was already answered or closed' using errcode = '22023'; end if;
  o := public._r447_offer_put(r, p, 'studio', v_me, public._vr256_label(v_me) || ' (for ' || r.vendor_name || ')', null);
  if o.status = 'offered' and coalesce((p ->> 'approve')::boolean, false) then return public.vendor_offer_review(o.id, 'approve', null, false); end if;
  select * into r from public.vendor_requests x where x.id = p_id;
  return public._vr256_row(r);
end $$;

-- ---- 9) "please send your invoice" ----------------------------------------------------------------------------------------------------------
-- who is asked: a confirmed request, or the booked vendor without one. Answers the request (or a would-be one, id null) after every check.
create or replace function public._r447_ask_target(p jsonb, p_lock boolean)
returns public.vendor_requests language plpgsql volatile security definer set search_path = '' as $$
-- r259-0447
declare v_org uuid := public.current_org_id(); r public.vendor_requests; b public.event_resources; v public.vendors; q record; v_last date; v_why text; v_tz text := public.studio_timezone(v_org); v_rid uuid; v_bid uuid;
begin
  v_rid := public._r447_uuid(p ->> 'request_id'); v_bid := public._r447_uuid(p ->> 'booking_id');
  if v_rid is not null then
    if p_lock then select * into r from public.vendor_requests x where x.id = v_rid and x.org_id = v_org for update; else select * into r from public.vendor_requests x where x.id = v_rid and x.org_id = v_org; end if;
    if r.id is null then raise exception 'request not found' using errcode = 'P0002'; end if;
  elsif v_bid is not null then
    if p_lock then select * into b from public.event_resources x where x.id = v_bid and x.org_id = v_org for update; else select * into b from public.event_resources x where x.id = v_bid and x.org_id = v_org; end if;
    if b.id is null then raise exception 'booking not found' using errcode = 'P0002'; end if;
    select * into r from public.vendor_requests x where x.booking_id = b.id and x.org_id = v_org and x.status in ('sent', 'accepted') order by x.created_at desc limit 1;
    if r.id is null then
      if b.status not in ('booked', 'confirmed', 'delivered') then raise exception 'This vendor is not booked for the event yet.' using errcode = '22023', hint = 'r447_ask'; end if;
      select * into v from public.vendors x where x.id = b.vendor_id and x.org_id = v_org;
      if v.id is null then raise exception 'Pick the vendor on the booking first.' using errcode = '22023', hint = 'r447_ask'; end if;
      select x.status, x.deleted_at, x.event_date, x.lifecycle_stage into q from public.quotes x where x.id = b.quote_id and x.org_id = v_org;
      if not found or q.deleted_at is not null or q.status in ('cancelled', 'lost') or coalesce(q.lifecycle_stage, '') in ('cancelled', 'archived') then raise exception 'This event is cancelled.' using errcode = '22023', hint = 'r447_ask'; end if;
      v_last := public._r447_last_day(b.quote_id);
      if v_last is not null and v_last < (now() at time zone v_tz)::date - 60 then raise exception 'The event was more than 60 days ago. Add the bill on the Settlement page instead.' using errcode = '22023', hint = 'r447_ask'; end if;
      if exists (select 1 from public.vendor_bills x where x.booking_id = b.id and x.org_id = v_org and x.status <> 'void') then raise exception 'A bill of this vendor is already entered.' using errcode = '22023', hint = 'r447_ask'; end if;
      r := null; r.org_id := v_org; r.quote_id := b.quote_id; r.vendor_id := v.id; r.vendor_name := left(btrim(v.name), 120); r.booking_id := b.id; r.booking_created := false; r.what := left(coalesce(nullif(btrim(b.label), ''), v.name), 200);
      r.qty := case when b.qty > 0 and b.qty <= 1000000 then b.qty end; r.agreed_amount := coalesce(round(b.cost, 2), 0); r.currency := public._r447_cur(v_org, b.quote_id); r.status := 'accepted'; r.invoice_only := true; r.price_open := false;
      r.when_at := coalesce((coalesce(q.event_date, v_last)::timestamp + time '12:00') at time zone v_tz, now()); r.reminders_on := false;
      r.contact_email := case when public._dl241_email_ok(v.email) then lower(btrim(v.email)) end;
      r.contact_phone := case when regexp_replace(coalesce(v.phone, ''), '[\s().-]', '', 'g') ~ '^\+[1-9][0-9]{7,14}$' then regexp_replace(v.phone, '[\s().-]', '', 'g') end;
      return r;
    end if;
    if p_lock then select * into r from public.vendor_requests x where x.id = r.id for update; end if;
  else raise exception 'choose the vendor' using errcode = '22023'; end if;
  v_why := public._r447_ask_block(r);
  if v_why = 'not_confirmed' then raise exception '% has not confirmed this request yet.', r.vendor_name using errcode = '22023', hint = 'r447_ask'; end if;
  if v_why = 'event_closed' then raise exception 'This event is cancelled.' using errcode = '22023', hint = 'r447_ask'; end if;
  if v_why = 'booking_cancelled' then raise exception 'This booking was cancelled.' using errcode = '22023', hint = 'r447_ask'; end if;
  if v_why = 'invoice_in' and not (exists (select 1 from public.vendor_invoices i where i.request_id = r.id and i.status = 'queried') and not exists (select 1 from public.vendor_invoices i where i.request_id = r.id and i.status in ('submitted', 'approved'))) then
    raise exception 'An invoice or a bill of this vendor is already in.' using errcode = '22023', hint = 'r447_ask'; end if;
  -- the vendor's e-mail was added later: use it (the stored one is never overwritten)
  if r.contact_email is null then r.contact_email := (select lower(btrim(x.email)) from public.vendors x where x.id = r.vendor_id and x.org_id = v_org and public._dl241_email_ok(x.email)); end if;
  return r;
end $$;

-- what would be sent, before anything is (nothing is written)
create or replace function public.vendor_invoice_ask_preview(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r259-0447
declare v_org uuid := public.current_org_id(); r public.vendor_requests; v_block text;
begin
  if auth.uid() is null or v_org is null or not public._vr256_can('assign') then raise exception 'not authorized' using errcode = '42501'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'choose the vendor' using errcode = '22023'; end if;
  r := public._r447_ask_target(p, false);
  v_block := case when r.contact_email is null then 'no_email' else public._vr256_block(r, r.contact_email) end;
  return jsonb_build_object('request_id', r.id, 'invoice_only', coalesce(r.invoice_only, false), 'vendor_name', r.vendor_name, 'to', r.contact_email, 'phone', r.contact_phone, 'can_send', v_block is null, 'why', v_block,
    'studio', (select o.name from public.organizations o where o.id = v_org), 'event', (select coalesce(public._r300_event_label(q.event_type), 'Event') from public.quotes q where q.id = r.quote_id),
    'event_date', (select to_char(q.event_date, 'DD/MM/YYYY') from public.quotes q where q.id = r.quote_id), 'currency', public._r447_cur(v_org, r.quote_id),
    'confirmed', case when public._vr256_can('money') then public._r447_confirmed(r) end, 'what', r.what,
    'last_asked', (select public._dl241_when(max(l.at), v_org) from public.vendor_request_log l where l.request_id = r.id and l.event = 'invoice_asked'));
end $$;

create or replace function public.vendor_invoice_ask(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r259-0447
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); r public.vendor_requests; k text; v_label text; v_key uuid; v_q jsonb; v_link jsonb; v_send boolean;
begin
  if v_me is null or v_org is null or not public._vr256_can('assign') then raise exception 'not authorized' using errcode = '42501'; end if;
  if coalesce(public._trial_locked(v_org), false) then raise exception 'This studio is read-only' using errcode = '25006'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'choose the vendor' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(p) loop if k not in ('request_id', 'booking_id', 'send', 'key') then raise exception 'unknown field %', k using errcode = '22023'; end if; end loop;
  if public.rate_hit('vendor_invoice_ask', v_me::text, 3600, 120) > 0 then raise exception 'Too many requests - try again later' using errcode = '54000'; end if;
  v_key := coalesce(public._r447_uuid(p ->> 'key'), gen_random_uuid()); v_send := coalesce((p ->> 'send')::boolean, true);
  r := public._r447_ask_target(p, true); v_label := public._vr256_label(v_me);
  if r.id is null then
    insert into public.vendor_requests(org_id, quote_id, vendor_id, vendor_name, contact_email, contact_phone, booking_id, booking_created, what, qty, when_at, agreed_amount, currency, respond_by, status, responded_at, responded_via,
        reminders_on, created_by, invoice_only, confirmed_at)
      values (v_org, r.quote_id, r.vendor_id, r.vendor_name, r.contact_email, r.contact_phone, r.booking_id, false, r.what, r.qty, r.when_at, r.agreed_amount, r.currency, now(), 'accepted', now(), 'studio', false, v_me, true, now())
      returning * into r;
    perform public._vr256_log(r.id, v_org, 'invoice_request', 'Only for the invoice: the vendor was booked without a request', 'user', v_me, v_label);
  elsif r.contact_email is not null then
    update public.vendor_requests set contact_email = r.contact_email, updated_at = now() where id = r.id and contact_email is null;
  end if;
  if v_send then
    if exists (select 1 from public.vendor_request_sends s where s.request_id = r.id and s.kind = 'invoice_ask' and s.status in ('pending', 'sent') and s.created_at > now() - interval '10 minutes') then
      v_q := jsonb_build_object('queued', false, 'reason', 'recent');
    else v_q := public._r447_queue(r, 'invoice_ask', 'ask:' || v_key); end if;
  else v_q := jsonb_build_object('queued', false, 'reason', 'link'); end if;
  if coalesce(v_q ->> 'reason', '') not in ('recent', 'already') then
    perform public._vr256_log(r.id, v_org, 'invoice_asked', case when coalesce((v_q ->> 'queued')::boolean, false) then 'E-mail' else 'Link to share' end, 'user', v_me, v_label); end if;
  v_link := public._vr256_issue(r, 'copy');
  return public._vr256_row(r) || jsonb_build_object('link', v_link, 'mail', v_q);
end $$;

-- ---- 10) the invoice with its products --------------------------------------------------------------------------------------------------------
create or replace function public.vendor_invoice_submit__pre0260(p_token text, p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- vendor-requests-0256 + r259-0447: products, charges, discount, one tax amount outside India, the same press twice; reached through the 0260 + 0334 gates
declare l public.vendor_request_links; r public.vendor_requests; g public.vendor_invoice_grants; i public.vendor_invoices; k text;
  v_no text; v_date date; v_tax numeric; v_c numeric; v_s numeric; v_ig numeric; v_gstin text; v_notes text; v_old public.vendor_invoices;
  v_path text; v_rep uuid; x record; v_lines jsonb; v_sum numeric := 0; v_ch numeric; v_di numeric; v_ot numeric; v_key uuid; v_gst boolean; v_q numeric; v_pr numeric;
begin
  if coalesce(p_token, '') !~ '^[0-9a-f]{64}$' then return jsonb_build_object('ok', false); end if;
  if public.rate_hit('vendor_invoice_submit', left(public._vr256_hash(p_token), 32), 3600, 10) > 0 then return jsonb_build_object('ok', false, 'reason', 'rate'); end if;
  l := public._vr256_link(p_token);
  if l.token_hash is null then return jsonb_build_object('ok', false); end if;
  if p is null or jsonb_typeof(p) <> 'object' or octet_length(p::text) > 20000 then raise exception 'invoice must be an object' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('invoice_no', 'invoice_date', 'taxable_amount', 'cgst', 'sgst', 'igst', 'vendor_gstin', 'notes', 'file_path', 'replaces_id', 'lines', 'charges', 'discount', 'tax', 'key') then
      raise exception 'unknown field %', k using errcode = '22023'; end if;
  end loop;
  select * into r from public.vendor_requests y where y.id = l.request_id and y.org_id = l.org_id for update;
  if r.id is null then return jsonb_build_object('ok', false); end if;
  v_key := public._r447_uuid(p ->> 'key');
  if v_key is not null then
    select * into i from public.vendor_invoices y where y.request_id = r.id and y.client_key = v_key;
    if i.id is not null then return public._vr256_public(r) || jsonb_build_object('submitted', i.invoice_no); end if;   -- the same press twice
  end if;
  if r.status <> 'accepted' or coalesce(public._trial_locked(r.org_id), false) then
    return public._vr256_public(r) || jsonb_build_object('ok', false, 'reason', 'closed'); end if;
  v_no := upper(regexp_replace(btrim(coalesce(p ->> 'invoice_no', '')), '\s+', '', 'g'));
  if v_no !~ '^[A-Z0-9/-]{1,16}$' then raise exception 'invoice number: up to 16 letters, digits, - or /' using errcode = '22023'; end if;
  begin v_date := (p ->> 'invoice_date')::date; exception when others then raise exception 'enter the invoice date' using errcode = '22023'; end;
  if v_date is null or v_date > current_date + 1 or v_date < current_date - 400 then raise exception 'the invoice date must be within the last 400 days' using errcode = '22023'; end if;
  foreach k in array array['taxable_amount', 'cgst', 'sgst', 'igst'] loop
    if p ? k and jsonb_typeof(p -> k) not in ('number', 'null') then raise exception '% must be a number', k using errcode = '22023'; end if;
  end loop;
  v_tax := round(coalesce((p ->> 'taxable_amount')::numeric, 0), 2);
  v_c := round(coalesce((p ->> 'cgst')::numeric, 0), 2); v_s := round(coalesce((p ->> 'sgst')::numeric, 0), 2); v_ig := round(coalesce((p ->> 'igst')::numeric, 0), 2);
  if v_tax <= 0 or v_tax >= 1000000000000 then raise exception 'enter the taxable value (above 0)' using errcode = '22023'; end if;
  if v_c < 0 or v_s < 0 or v_ig < 0 then raise exception 'GST cannot be negative' using errcode = '22023'; end if;
  if v_ig > 0 and (v_c > 0 or v_s > 0) then raise exception 'charge IGST (other state) OR CGST + SGST (same state), not both' using errcode = '22023'; end if;
  if abs(v_c - v_s) > 1 then raise exception 'CGST and SGST must be the same amount' using errcode = '22023'; end if;
  if v_c + v_s + v_ig > v_tax * 0.40 then raise exception 'the GST looks too high for this taxable value' using errcode = '22023'; end if;
  -- r259: one tax amount outside India (GST stays GST in India)
  v_gst := public._r447_gst(r.org_id); v_ot := coalesce(public._r447_num(p -> 'tax', 'the tax', 999999999999), 0);
  if v_ot > 0 and v_gst then raise exception 'charge CGST + SGST or IGST, not a single tax amount' using errcode = '22023'; end if;
  if v_ot > 0 and v_c + v_s + v_ig > 0 then raise exception 'charge GST or one tax amount, not both' using errcode = '22023'; end if;
  if v_ot > v_tax * 0.40 then raise exception 'the tax looks too high for this amount' using errcode = '22023'; end if;
  -- r259: the products (when the page sends them): their sum is the taxable value
  if p ? 'lines' and jsonb_typeof(p -> 'lines') <> 'null' then
    if jsonb_typeof(p -> 'lines') <> 'array' or jsonb_array_length(p -> 'lines') not between 1 and 30 then raise exception 'enter 1 to 30 products' using errcode = '22023'; end if;
    v_lines := '[]'::jsonb;
    for x in select e.v from jsonb_array_elements(p -> 'lines') with ordinality e(v, n) order by e.n loop
      if jsonb_typeof(x.v) <> 'object' then raise exception 'enter the products' using errcode = '22023'; end if;
      for k in select jsonb_object_keys(x.v) loop if k not in ('name', 'unit', 'qty', 'price') then raise exception 'unknown field %', k using errcode = '22023'; end if; end loop;
      k := public._r447_txt(x.v ->> 'name', 'the product name', 1, 120);
      v_q := public._r447_num(x.v -> 'qty', 'the quantity of ' || k, 1000000); v_pr := public._r447_num(x.v -> 'price', 'the price of ' || k, 10000000000);
      if v_q is null or v_q <= 0 then raise exception 'enter the quantity of % (above 0)', k using errcode = '22023'; end if;
      if v_pr is null then raise exception 'enter the price of %', k using errcode = '22023'; end if;
      v_sum := v_sum + round(v_q * v_pr, 2);
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('name', k, 'unit', public._r447_txt(x.v ->> 'unit', 'the unit', 0, 20), 'qty', v_q, 'price', v_pr, 'total', round(v_q * v_pr, 2)));
    end loop;
    v_ch := coalesce(public._r447_num(p -> 'charges', 'the delivery / other charges', 10000000000), 0); v_di := coalesce(public._r447_num(p -> 'discount', 'the discount', 10000000000), 0);
    if abs(v_tax - (v_sum + v_ch - v_di)) > 0.005 then raise exception 'the products do not add up to the taxable value - please check the prices' using errcode = '22023', hint = 'r447_total'; end if;
  elsif p ? 'charges' or p ? 'discount' then raise exception 'enter the products' using errcode = '22023';
  end if;
  v_gstin := nullif(upper(regexp_replace(coalesce(p ->> 'vendor_gstin', ''), '\s+', '', 'g')), '');
  if v_gstin is not null and v_gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' then raise exception 'the GSTIN looks wrong (15 characters, e.g. 36ABCDE1234F1Z5)' using errcode = '22023'; end if;
  if v_gstin is null and v_c + v_s + v_ig > 0 then raise exception 'enter your GSTIN - it is needed when GST is charged' using errcode = '22023'; end if;
  v_notes := public._vr256_clean(p ->> 'notes', 500);
  if char_length(coalesce(p ->> 'notes', '')) > 500 or coalesce(v_notes, '') ~ '[<>]' then raise exception 'notes: up to 500 characters, no < or >' using errcode = '22023'; end if;
  -- the file: an unused grant from THIS link for THIS request, uploaded (object exists), window closed at most 15 minutes ago
  v_path := btrim(coalesce(p ->> 'file_path', ''));
  if v_path = '' then raise exception 'attach the invoice (PDF or photo)' using errcode = '22023'; end if;
  select * into g from public.vendor_invoice_grants y where y.path = v_path and y.token_hash = l.token_hash and y.request_id = r.id and y.purpose = 'invoice'
     and y.used_at is null and y.expires_at > now() - interval '15 minutes' for update;
  if g.id is null then raise exception 'upload not found or expired - please attach the invoice again' using errcode = '42501'; end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'vendor-invoices' and o.name = g.path) then
    raise exception 'the invoice file did not arrive - please attach it again' using errcode = '22023'; end if;
  -- a corrected invoice after a query replaces the queried one (kept as superseded)
  if nullif(p ->> 'replaces_id', '') is not null then
    begin v_rep := (p ->> 'replaces_id')::uuid; exception when others then raise exception 'bad invoice' using errcode = '22023'; end;
    select * into v_old from public.vendor_invoices y where y.id = v_rep and y.request_id = r.id for update;
    if v_old.id is null or v_old.status <> 'queried' then raise exception 'only a queried invoice can be replaced' using errcode = '22023'; end if;
    update public.vendor_invoices set status = 'superseded' where id = v_old.id;
  end if;
  if r.vendor_id is not null and exists (select 1 from public.vendor_invoices y where y.org_id = r.org_id and y.vendor_id = r.vendor_id
       and y.invoice_no = v_no and y.fy = public._vr256_fy(v_date) and y.status in ('submitted', 'queried', 'approved')) then
    raise exception 'invoice % was already sent this financial year - use a new invoice number', v_no using errcode = '23505'; end if;
  insert into public.vendor_invoices(org_id, quote_id, request_id, vendor_id, booking_id, invoice_no, invoice_date, fy, taxable_amount,
      cgst, sgst, igst, total_amount, vendor_gstin, notes, storage_path, mime, replaces_id, lines, charges, discount, tax_amount, client_key)
    values (r.org_id, r.quote_id, r.id, r.vendor_id, r.booking_id, v_no, v_date, public._vr256_fy(v_date), v_tax,
      v_c, v_s, v_ig, v_tax + v_c + v_s + v_ig + v_ot, v_gstin, v_notes, g.path, g.mime, v_old.id, v_lines, v_ch, v_di, case when v_ot > 0 then v_ot end, v_key)
    returning * into i;
  update public.vendor_invoice_grants set used_at = now() where id = g.id;
  update public.vendor_request_links set uses = uses + 1, last_used_at = now() where token_hash = l.token_hash;
  perform public._vr256_log(r.id, r.org_id, 'invoice_submitted', 'Invoice ' || v_no || case when v_old.id is not null then ' (corrected, replaces the queried one)' else '' end,
    'link', null, left(r.vendor_name || ' (vendor link)', 160));
  perform public._vr256_announce(r.id, 'invoice', null, v_no);
  return public._vr256_public(r) || jsonb_build_object('submitted', i.invoice_no);
end $$;

-- review: the bill gets the event's currency, and the one tax amount (outside India; a cost unless ticked as claimable). Text edit of the 0256 body.
do $$ declare v_def text := pg_get_functiondef('public.vendor_invoice_review(uuid,text,text,jsonb)'::regprocedure);
  a text := 'gst_amount, gst_claimable, created_by)'; b text := 'i.total_amount, v_due, round(i.cgst + i.sgst + i.igst, 2), v_claim, v_me)';
begin
  if position('r259-0447' in v_def) > 0 then return; end if;
  if (length(v_def) - length(replace(v_def, a, ''))) <> length(a) or (length(v_def) - length(replace(v_def, b, ''))) <> length(b) then
    raise exception 'STOP 0447: vendor_invoice_review has an unexpected body - nothing was changed'; end if;
  execute replace(replace(v_def, a, 'gst_amount, gst_claimable, created_by, currency) /* r259-0447 */'),
    b, 'i.total_amount, v_due, round(i.cgst + i.sgst + i.igst + coalesce(i.tax_amount, 0), 2), case when coalesce(i.tax_amount, 0) > 0 then coalesce(v_claim, false) else v_claim end, v_me, public._r447_cur(v_org, i.quote_id))');
end $$;

-- ---- 11) the scheduler + the dispatcher --------------------------------------------------------------------------------------------------------
create or replace function public.vendor_requests_tick()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- vendor-requests-0256 + r259-0447: a vendor whose price waits for the studio is not reminded; "please send your invoice" after the event
declare r public.vendor_requests; x record; v_n integer := 0; v_nr integer := 0; v_ask integer := 0; v_fire timestamptz; i integer; v_days integer[] := array[1, 4, 8];
begin
  for r in select y.* from public.vendor_requests y join public.quotes q on q.id = y.quote_id and q.org_id = y.org_id
            where y.status = 'sent' and q.deleted_at is null and q.status <> 'cancelled' and y.created_at > now() - interval '40 days'
              and not exists (select 1 from public.vendor_offers o where o.request_id = y.id and o.status = 'offered') loop
    begin
      for i in 1 .. 2 loop
        v_fire := r.created_at + make_interval(hours => 24 * i);
        if now() >= v_fire and now() < v_fire + interval '6 hours' and v_fire < r.respond_by + interval '1 hour' then
          v_n := v_n + public._vr256_queue(r, 'reminder', 'reminder' || i);
        end if;
      end loop;
      if r.no_response_at is null and now() >= r.respond_by then
        update public.vendor_requests set no_response_at = now() where id = r.id and no_response_at is null;
        perform public._vr256_log(r.id, r.org_id, 'no_response', null, 'system', null, 'Helm (no reply)');
        perform public._vr256_announce(r.id, 'no_response', null, null);
        v_nr := v_nr + 1;
      end if;
    exception when others then raise warning 'vendor-requests-0256: tick skipped one request (%)', sqlstate;
    end;
  end loop;
  -- the day after the event at 10:00 studio time, again 3 and 7 days later; once per slot; only requests confirmed after 0447 and before the first slot
  for x in select y as rq, coalesce((to_jsonb(q) ->> 'event_end_date')::date, q.event_date) as last_day, public.studio_timezone(y.org_id) as tz
             from public.vendor_requests y join public.quotes q on q.id = y.quote_id and q.org_id = y.org_id
            where y.status = 'accepted' and y.confirmed_at is not null and not y.invoice_only and y.contact_email is not null and q.deleted_at is null and q.status not in ('cancelled', 'lost')
              and not coalesce(q.is_demo, false) and coalesce((to_jsonb(q) ->> 'event_end_date')::date, q.event_date) between current_date - 10 and current_date + 1 loop
    begin
      r := x.rq;
      if r.confirmed_at >= ((x.last_day + 1)::timestamp + time '10:00') at time zone x.tz then continue; end if;
      foreach i in array v_days loop
        v_fire := ((x.last_day + i)::timestamp + time '10:00') at time zone x.tz;
        if now() >= v_fire and now() < v_fire + interval '10 hours' and public._r447_ask_on(r.org_id) and public._r447_ask_block(r) is null
           and not exists (select 1 from public.vendor_request_sends s where s.request_id = r.id and s.kind = 'invoice_ask' and s.status in ('pending', 'sent') and s.created_at > now() - interval '20 hours')
           and not exists (select 1 from public.vendor_request_sends s where s.dedupe_key = 'vr:' || r.id || ':invoice' || i || ':email') then
          if coalesce((public._r447_queue(r, 'invoice_auto', 'invoice' || i) ->> 'queued')::boolean, false) then
            perform public._vr256_log(r.id, r.org_id, 'invoice_asked', 'E-mail, sent by Helm', 'system', null, 'Helm');
            v_ask := v_ask + 1;
          end if;
        end if;
      end loop;
    exception when others then raise warning 'r259-0447: invoice ask skipped for one request (%)', sqlstate;
    end;
  end loop;
  -- an e-mail of the new kinds nobody could send for two days is closed (never sent late)
  update public.vendor_request_sends set status = 'skipped', reason = 'stale', sent_at = now()
   where sent_at is null and status = 'pending' and kind in ('change', 'confirmed', 'invoice_ask', 'invoice_auto') and created_at < now() - interval '48 hours';
  return jsonb_build_object('queued', v_n, 'no_response', v_nr, 'invoice_asks', v_ask);
end $$;

-- the dispatcher (old and new version of comms-dispatch call this): only request / reminder rows, as before; + the products, the event by type
create or replace function public.vendor_request_claim(p_limit integer default 25, p_channel text default 'email')
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- vendor-requests-0256 + r41-sendwin-0290 + r143-0342 + r259-0447
declare s record; v_out jsonb := '[]'::jsonb; v_link jsonb; v_ident jsonb; r public.vendor_requests;
begin
  if p_channel not in ('email', 'whatsapp') then raise exception 'bad channel' using errcode = '22023'; end if;
  update public.vendor_request_sends set status = 'failed', sent_at = now() where sent_at is null and channel = p_channel and kind in ('request', 'reminder') and attempts >= public._r342_max_attempts();
  update public.vendor_request_sends set status = 'skipped', reason = 'stale', sent_at = now()
   where sent_at is null and channel = p_channel and kind in ('request', 'reminder') and coalesce(not_before, created_at) < now() - interval '12 hours' /* r41-sendwin-0290 */;
  for s in select x.* from public.vendor_request_sends x
            where x.sent_at is null and x.status = 'pending' and x.channel = p_channel and x.kind in ('request', 'reminder')
              and (x.claimed_at is null or x.claimed_at < now() - interval '10 minutes')
            order by x.created_at limit greatest(1, least(coalesce(p_limit, 25), 100)) for update of x skip locked loop
    select * into r from public.vendor_requests q where q.id = s.request_id and q.org_id = s.org_id;
    if r.id is null or r.status <> 'sent'
       or (s.kind = 'reminder' and exists (select 1 from public.vendor_offers o where o.request_id = r.id and o.status = 'offered'))
       or not exists (select 1 from public.quotes q where q.id = r.quote_id and q.deleted_at is null and q.status <> 'cancelled')
       or public._vr256_block(r, s.recipient) is not null
       or s.recipient is distinct from (case when s.channel = 'email' then r.contact_email else r.contact_phone end) then
      update public.vendor_request_sends set status = 'skipped', reason = 'recheck', sent_at = now() where id = s.id;
      continue;
    end if;
    v_link := public._vr256_issue(r, s.channel);
    select jsonb_build_object('from_name', cs.email_from_name, 'reply_to', cs.email_reply_to) into v_ident
      from public.comms_settings cs where cs.org_id = r.org_id;
    update public.vendor_request_sends set claimed_at = now(), attempts = attempts + 1 where id = s.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object('id', s.id, 'to', s.recipient, 'channel', s.channel, 'kind', s.kind,
      'vendor_name', r.vendor_name, 'what', r.what, 'qty', r.qty, 'when_text', public._dl241_when(r.when_at, r.org_id),
      'respond_by_text', public._dl241_when(r.respond_by, r.org_id),
      'event', (select coalesce(public._r300_event_label(q.event_type), 'Event') from public.quotes q where q.id = r.quote_id),
      'event_date', (select to_char(q.event_date, 'DD/MM/YYYY') from public.quotes q where q.id = r.quote_id),
      'studio', (select o.name from public.organizations o where o.id = r.org_id),
      'flow', 447, 'price_open', r.price_open, 'where_text', r.where_text, 'lines', public._r447_lines(r, false, false),
      'token', v_link ->> 'token', 'identity', coalesce(v_ident, '{}'::jsonb)));
  end loop;
  return v_out;
end $$;

-- the new e-mails: change asked, booking confirmed, please send your invoice (comms-dispatch from R259; an older one leaves them waiting)
create or replace function public.vendor_flow_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r259-0447
declare s record; v_out jsonb := '[]'::jsonb; v_link jsonb; v_ident jsonb; r public.vendor_requests; o public.vendor_offers; v_ok boolean;
begin
  update public.vendor_request_sends set status = 'failed', sent_at = now() where sent_at is null and status = 'pending' and kind in ('change', 'confirmed', 'invoice_ask', 'invoice_auto') and attempts >= public._r342_max_attempts();
  for s in select x.* from public.vendor_request_sends x
            where x.sent_at is null and x.status = 'pending' and x.channel = 'email' and x.kind in ('change', 'confirmed', 'invoice_ask', 'invoice_auto')
              and (x.claimed_at is null or x.claimed_at < now() - interval '10 minutes') and x.created_at > now() - interval '48 hours'
            order by x.created_at limit greatest(1, least(coalesce(p_limit, 25), 100)) for update of x skip locked loop
    select * into r from public.vendor_requests q where q.id = s.request_id and q.org_id = s.org_id;
    select * into o from public.vendor_offers q where q.request_id = s.request_id order by q.seq desc limit 1;
    v_ok := r.id is not null and s.recipient is not distinct from r.contact_email and public._vr256_block(r, s.recipient) is null
      and exists (select 1 from public.quotes q where q.id = r.quote_id and q.deleted_at is null and q.status not in ('cancelled', 'lost'))
      and case s.kind when 'change' then r.status = 'sent' and coalesce(o.status = 'change_asked', false) and position(o.id::text in s.dedupe_key) > 0
                      when 'confirmed' then r.status = 'accepted'
                      when 'invoice_ask' then public._r447_ask_block(r) is null or not exists (select 1 from public.vendor_invoices i where i.request_id = r.id and i.status in ('submitted', 'approved')) and public._r447_ask_block(r) = 'invoice_in'
                        and exists (select 1 from public.vendor_invoices i where i.request_id = r.id and i.status = 'queried')
                      else public._r447_ask_block(r) is null and public._r447_ask_on(r.org_id) and s.created_at > now() - interval '24 hours' end;
    if not coalesce(v_ok, false) then
      update public.vendor_request_sends set status = 'skipped', reason = 'recheck', sent_at = now() where id = s.id; continue; end if;
    v_link := public._vr256_issue(r, 'email');
    select jsonb_build_object('from_name', cs.email_from_name, 'reply_to', cs.email_reply_to) into v_ident from public.comms_settings cs where cs.org_id = r.org_id;
    update public.vendor_request_sends set claimed_at = now(), attempts = attempts + 1 where id = s.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object('id', s.id, 'to', s.recipient, 'channel', 'email', 'kind', s.kind, 'vendor_name', r.vendor_name, 'what', r.what, 'qty', r.qty,
      'when_text', public._dl241_when(r.when_at, r.org_id), 'where_text', r.where_text, 'respond_by_text', public._dl241_when(r.respond_by, r.org_id),
      'event', (select coalesce(public._r300_event_label(q.event_type), 'Event') from public.quotes q where q.id = r.quote_id), 'event_date', (select to_char(q.event_date, 'DD/MM/YYYY') from public.quotes q where q.id = r.quote_id),
      'studio', (select g.name from public.organizations g where g.id = r.org_id), 'currency', public._r447_cur(r.org_id, r.quote_id), 'flow', 447,
      'confirmed', public._r447_confirmed(r), 'message', case when s.kind = 'change' then o.review_note end, 'token', v_link ->> 'token', 'identity', coalesce(v_ident, '{}'::jsonb)));
  end loop;
  return v_out;
end $$;

-- ---- 12) the switch (Settings, Automations) -------------------------------------------------------------------------------------------------------
create or replace function public.automation_overview()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r259-0447: the r170-0361 overview + "please send your invoice" e-mails
begin
  return jsonb_set(public.automation_overview__pre0447(), '{on,vendor_invoice_ask}', to_jsonb(public._r447_ask_on(public.current_org_id())), true);
end $$;
create or replace function public.automation_switch(p_key text, p_on boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r259-0447: vendor_invoice_ask is written here; every other key goes to the r170-0361 body unchanged
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); v_old boolean;
begin
  if p_key is distinct from 'vendor_invoice_ask' then perform public.automation_switch__pre0447(p_key, p_on); return public.automation_overview(); end if;
  if v_me is null or v_org is null or coalesce(public.user_role(), '') = 'client' or not public.has_area('controls', 'edit') then
    raise exception 'Only a studio admin (or someone allowed to edit Settings) can switch automations on or off.' using errcode = '42501'; end if;
  if coalesce(public._trial_locked(v_org), false) then raise exception 'This studio is read-only' using errcode = '25006'; end if;
  if p_on is null then raise exception 'Choose on or off.' using errcode = '22023'; end if;
  v_old := public._r447_ask_on(v_org);
  insert into public.automation_settings(org_id, updated_by) values (v_org, v_me) on conflict (org_id) do nothing;
  update public.automation_settings set vendor_invoice_ask_enabled = p_on, updated_at = now(), updated_by = v_me where org_id = v_org;
  begin
    insert into public.audit_log(actor, action, entity, entity_id, changed, org_id) values (v_me, 'automation.switch', 'automation', p_key, jsonb_build_object('key', p_key, 'from', v_old, 'to', p_on), v_org);
  exception when others then raise warning 'r259-0447: audit skipped (%)', sqlstate;
  end;
  return public.automation_overview();
end $$;

-- ---- 13) grants -------------------------------------------------------------------------------------------------------------------------------------
do $$ declare f text; r text; begin
  foreach f in array array['public._r447_keep(text)', 'public._r447_num(jsonb,text,numeric)', 'public._r447_txt(text,text,integer,integer)', 'public._r447_uuid(text)', 'public._r447_cur(uuid,uuid)', 'public._r447_gst(uuid)',
      'public._r447_lines(public.vendor_requests,boolean,boolean)', 'public._r447_offer(public.vendor_offers,boolean,boolean)', 'public._r447_confirmed(public.vendor_requests)', 'public._r447_can_reopen(public.vendor_requests)',
      'public._r447_ask_on(uuid)', 'public._r447_last_day(uuid)', 'public._r447_invoice_in(public.vendor_requests)', 'public._r447_ask_block(public.vendor_requests)', 'public._r447_queue(public.vendor_requests,text,text)',
      'public._r447_tg_offer()', 'public._r447_tg_request_done()', 'public._r447_state(public.vendor_requests)', 'public._r447_offer_put(public.vendor_requests,jsonb,text,uuid,text,text)', 'public._r447_ask_target(jsonb,boolean)',
      'public.tg_vr256_guard()', 'public._vr256_text(public.vendor_requests,text,text,text)', 'public._vr256_inv(public.vendor_invoices,boolean)', 'public._vr256_row(public.vendor_requests)', 'public._vr256_public(public.vendor_requests)',
      'public._vr256_on_accept(uuid,text,uuid,text)', 'public.vendor_invoice_submit__pre0260(text,jsonb)', 'public.vendor_requests_tick()', 'public.vendor_request_claim(integer,text)', 'public.vendor_flow_claim(integer)'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function public.vendor_invoice_submit__pre0260(text, jsonb) from service_role;
    grant execute on function public.vendor_requests_tick() to service_role;
    grant execute on function public.vendor_request_claim(integer, text) to service_role;
    grant execute on function public.vendor_flow_claim(integer) to service_role;
  end if;
  foreach f in array array['public.vendor_request_ask(jsonb)', 'public.vendor_offer_review(uuid,text,text,boolean)', 'public.vendor_request_record_offer(uuid,jsonb)', 'public.vendor_invoice_ask(jsonb)', 'public.vendor_invoice_ask_preview(jsonb)',
      'public.vendor_request_reassign(uuid,uuid,numeric,text)', 'public.vendor_requests_summary(uuid)', 'public.vendor_invoice_review(uuid,text,text,jsonb)', 'public.vendor_invoice_file_visible(text)', 'public.automation_overview()', 'public.automation_switch(text,boolean)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    foreach r in array array['authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('grant execute on function %s to %I', f, r); end if;
    end loop;
  end loop;
  foreach f in array array['public.vendor_link_offer(text,jsonb)', 'public.vendor_offer_upload(text,text)', 'public.vendor_invoice_upload_ok(text)'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('grant execute on function %s to %I', f, r); end if;
    end loop;
  end loop;
end $$;

do $$ begin
  if to_regclass('public.helm_schema_markers') is not null then
    insert into public.helm_schema_markers(num, name) values (447, '0447_r259_vendor_flow') on conflict (num) do nothing;
  end if;
end $$;

notify pgrst, 'reload schema';

-- ---- 14) CHECK (read only): every row must say true -----------------------------------------------------------------------------------------------------
select c.check, c.ok from (values
  ('01 the offers table is there, row security on, no direct access', (select bool_and(c.relrowsecurity and not has_table_privilege('authenticated', c.oid, 'select,insert,update,delete') and not has_table_privilege('anon', c.oid, 'select,insert,update,delete'))
      from pg_class c where c.oid = 'public.vendor_offers'::regclass)),
  ('02 its guards are there (own studio, read-only studio, content never changes, file check)', (select count(*) = 4 from pg_trigger where tgrelid = 'public.vendor_offers'::regclass and tgname in ('zz_quote_org_match', 'zzz_studio_read_only', 'ab_r447_offer', 'a300_vendor_invoice_file'))),
  ('03 the vendor''s page may only answer and upload', has_function_privilege('anon', 'public.vendor_link_offer(text,jsonb)', 'execute') and has_function_privilege('anon', 'public.vendor_offer_upload(text,text)', 'execute')
      and not has_function_privilege('anon', 'public.vendor_request_ask(jsonb)', 'execute') and not has_function_privilege('anon', 'public.vendor_offer_review(uuid,text,text,boolean)', 'execute')
      and not has_function_privilege('anon', 'public.vendor_invoice_ask(jsonb)', 'execute') and not has_function_privilege('anon', 'public.vendor_request_record_offer(uuid,jsonb)', 'execute')),
  ('04 helpers, the dispatcher and the scheduler are server only', not has_function_privilege('authenticated', 'public.vendor_flow_claim(integer)', 'execute') and not has_function_privilege('authenticated', 'public.vendor_request_claim(integer,text)', 'execute')
      and not has_function_privilege('authenticated', 'public._r447_offer_put(public.vendor_requests,jsonb,text,uuid,text,text)', 'execute') and not has_function_privilege('anon', 'public.vendor_invoice_submit__pre0260(text,jsonb)', 'execute')),
  ('05 old bodies kept, closed to the app', (select count(*) = 16 and bool_and(not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')) from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.proname like '%\_\_pre0447')),
  ('06 search_path pinned on every new function', (select bool_and(coalesce(p.proconfig @> array['search_path=""'], false)) from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like '\_r447%'
      or p.proname in ('vendor_request_ask', 'vendor_link_offer', 'vendor_offer_upload', 'vendor_offer_review', 'vendor_request_record_offer', 'vendor_invoice_ask', 'vendor_invoice_ask_preview', 'vendor_flow_claim')))),
  ('07 links still pass the cancelled and free-trial checks', position('_a260_link_state' in pg_get_functiondef('public.vendor_link_offer(text,jsonb)'::regprocedure)) > 0 and position('_r125_ref_closed' in pg_get_functiondef('public.vendor_link_offer(text,jsonb)'::regprocedure)) > 0
      and position('_r125_closed' in pg_get_functiondef('public.vendor_invoice_upload_ok(text)'::regprocedure)) > 0),
  ('08 the send queue knows the new e-mails, the old dispatcher never gets them', position('invoice_auto' in (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'public.vendor_request_sends'::regclass and c.conname = 'vendor_request_sends_kind_check')) > 0
      and position('x.kind in (''request'', ''reminder'')' in pg_get_functiondef('public.vendor_request_claim(integer,text)'::regprocedure)) > 0),
  ('09 no older request is asked for an invoice by itself', not exists (select 1 from public.vendor_requests r where r.status = 'accepted' and r.confirmed_at is not null and r.confirmed_at < r.responded_at)),
  ('10 the automatic invoice e-mail has its switch (on unless switched off)', (select column_default = 'true' from information_schema.columns where table_schema = 'public' and table_name = 'automation_settings' and column_name = 'vendor_invoice_ask_enabled')
      and position('vendor_invoice_ask' in pg_get_functiondef('public.automation_switch(text,boolean)'::regprocedure)) > 0),
  ('11 the bill of an approved invoice takes the event''s currency', position('r259-0447' in pg_get_functiondef('public.vendor_invoice_review(uuid,text,text,jsonb)'::regprocedure)) > 0),
  ('12 the free-trial clean-up knows the table', to_regprocedure('public._tr184_purge_tables()') is null or position('vendor_offers' in pg_get_functiondef('public._tr184_purge_tables()'::regprocedure)) > 0)
) c("check", ok);
commit;
