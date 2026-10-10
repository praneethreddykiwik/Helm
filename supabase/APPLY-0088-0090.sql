-- APPLY-0088-0090.sql  --  ONE paste: 0088 (smart import: custom fields + import mappings + batch RPC),
-- 0089 (country tax India / UAE / USA: studio country, per-quote currency + tax snapshot, tax-exempt)
-- and 0090 (client portal shows the quote's own currency).
-- Run on STAGING first, then PROD, AFTER APPLY-0085-0086 (needs 0079, 0082, 0084).
-- Idempotent: safe to paste twice. Pure ASCII. Nothing existing is deleted or rewritten.
-- The LAST result grid is the combined VERIFY: every ok = true.

-- ===================== prerequisites =====================
do $$ begin
  if to_regprocedure('public.has_area(text,text)') is null then raise exception 'APPLY-0088-0090: has_area missing'; end if;
  if to_regprocedure('public._a84_phone_ok(text)') is null then raise exception 'APPLY-0088-0090: apply 0084 first'; end if;
  if to_regprocedure('public.helm_quote_total__pretax(jsonb)') is null then raise exception 'APPLY-0088-0090: apply 0079 first'; end if;
  if to_regprocedure('public.public_get_portal__pre0082(uuid)') is null then raise exception 'APPLY-0088-0090: apply 0082 first'; end if;
end $$;

-- ===================== 0088 =====================
-- 0088_smart_import.sql - CANONICAL forward-only. Smart import (any spreadsheet layout) + custom fields.
--
-- In plain words:
--   1. Staff (crew_members), inventory (inventory_items), menu dishes (dish_catalog) and vendors get a
--      new "attributes" column (jsonb object, default {}). Anything a studio's sheet has that we do not
--      have a real column for (bank IFSC, joining date, allergens, warehouse, ...) is kept there, so no
--      information from an import is lost. Size-capped (64 keys of plain values, 16 KB).
--   2. custom_field_defs: per studio + entity, the list of custom fields (key, label, type, order).
--      Everyone in the studio can read them; admins (controls EDIT) add / rename / hide them in Control
--      Center. Fields are never deleted (active=false hides one; the stored values stay).
--   3. import_mappings: per studio + entity, the column mapping the studio last confirmed, so the next
--      import of the same sheet is pre-mapped. Written by people who may edit that entity.
--   4. smart_import_batch(entity, rows, defs): imports up to 500 rows in one call. Each row is either
--      "create" or "update" (update only when the user chose it for that row, and only of a row in the
--      caller's own studio). Update writes only the fields the sheet supplied and MERGES attributes
--      (existing custom values the sheet does not mention are kept). Each row succeeds or fails on its
--      own; the result lists created / updated / error per row. Gated by has_area(<entity area>, 'edit'),
--      suspended (read-only) studios and the password-change gate. Never deletes anything.
--   Additive + idempotent: safe to run twice. No existing row or column is changed.

do $$ begin
  if to_regprocedure('public.has_area(text,text)') is null or to_regprocedure('public.current_org_id()') is null then
    raise exception '0088: has_area / current_org_id are not installed (apply the earlier migrations first)'; end if;
  if to_regprocedure('public._a84_phone_ok(text)') is null then
    raise exception '0088: _a84_phone_ok(text) is not installed (apply 0084 first)'; end if;
end $$;

-- ---------------------------------------------------------------- 1. attributes columns
alter table public.crew_members    add column if not exists attributes jsonb not null default '{}'::jsonb;
alter table public.inventory_items add column if not exists attributes jsonb not null default '{}'::jsonb;
alter table public.dish_catalog    add column if not exists attributes jsonb not null default '{}'::jsonb;
alter table public.vendors         add column if not exists attributes jsonb not null default '{}'::jsonb;

-- object of at most 64 keys whose values are plain (string / number / boolean / null), <= 16 KB
create or replace function public._a88_attrs_ok(p jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select p is not null and jsonb_typeof(p) = 'object' and pg_column_size(p) <= 16384
    and (select count(*) from jsonb_object_keys(p)) <= 64
    and not exists (select 1 from jsonb_each(p) e
                    where e.key !~ '^[a-z0-9_]{1,48}$' or jsonb_typeof(e.value) in ('object', 'array'));
$$;

do $$ declare t text; begin
  foreach t in array array['crew_members', 'inventory_items', 'dish_catalog', 'vendors'] loop
    if not exists (select 1 from pg_constraint where conname = t || '_a88_attrs_ck') then
      execute format('alter table public.%I add constraint %I check (public._a88_attrs_ok(attributes))', t, t || '_a88_attrs_ck');
    end if;
  end loop;
end $$;

-- entity -> access-matrix area (the same areas the tables' own RLS policies use)
create or replace function public._a88_area(p_entity text)
returns text language sql immutable set search_path = '' as $$
  select case p_entity when 'staff' then 'staff' when 'inventory' then 'inventory'
                       when 'menu' then 'controls' when 'vendors' then 'vendors' end;
$$;

-- ---------------------------------------------------------------- 2. custom field definitions
create table if not exists public.custom_field_defs (
  org_id     uuid        not null default public.current_org_id(),
  entity     text        not null,
  key        text        not null,
  label      text        not null,
  type       text        not null default 'text',
  position   integer     not null default 0,
  active     boolean     not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, entity, key)
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'custom_field_defs_entity_ck') then
    alter table public.custom_field_defs add constraint custom_field_defs_entity_ck check (entity in ('staff', 'inventory', 'menu', 'vendors')); end if;
  if not exists (select 1 from pg_constraint where conname = 'custom_field_defs_key_ck') then
    alter table public.custom_field_defs add constraint custom_field_defs_key_ck check (key ~ '^[a-z0-9_]{1,48}$'); end if;
  if not exists (select 1 from pg_constraint where conname = 'custom_field_defs_label_ck') then
    alter table public.custom_field_defs add constraint custom_field_defs_label_ck check (length(btrim(label)) between 1 and 80); end if;
  if not exists (select 1 from pg_constraint where conname = 'custom_field_defs_type_ck') then
    alter table public.custom_field_defs add constraint custom_field_defs_type_ck check (type in ('text', 'number', 'date', 'bool')); end if;
  if not exists (select 1 from pg_constraint where conname = 'custom_field_defs_pos_ck') then
    alter table public.custom_field_defs add constraint custom_field_defs_pos_ck check (position between 0 and 10000); end if;
  if not exists (select 1 from pg_constraint where conname = 'custom_field_defs_org_fk') then
    alter table public.custom_field_defs add constraint custom_field_defs_org_fk foreign key (org_id) references public.organizations(id); end if;
end $$;

-- ---------------------------------------------------------------- 3. remembered mappings
create table if not exists public.import_mappings (
  org_id     uuid        not null default public.current_org_id(),
  entity     text        not null,
  mapping    jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid        null default auth.uid(),
  primary key (org_id, entity)
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'import_mappings_entity_ck') then
    alter table public.import_mappings add constraint import_mappings_entity_ck check (entity in ('staff', 'inventory', 'menu', 'vendors')); end if;
  if not exists (select 1 from pg_constraint where conname = 'import_mappings_shape_ck') then
    alter table public.import_mappings add constraint import_mappings_shape_ck check (jsonb_typeof(mapping) = 'object' and pg_column_size(mapping) <= 65536); end if;
  if not exists (select 1 from pg_constraint where conname = 'import_mappings_org_fk') then
    alter table public.import_mappings add constraint import_mappings_org_fk foreign key (org_id) references public.organizations(id); end if;
end $$;

-- ---------------------------------------------------------------- RLS + grants (tenant-scoped, no deletes)
alter table public.custom_field_defs enable row level security;
alter table public.import_mappings enable row level security;
revoke all on table public.custom_field_defs from public;
revoke all on table public.import_mappings from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.custom_field_defs from anon';
    execute 'revoke all on table public.import_mappings from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.custom_field_defs from authenticated';
    execute 'revoke all on table public.import_mappings from authenticated';
    execute 'grant select, insert, update on table public.custom_field_defs to authenticated';
    execute 'grant select, insert, update on table public.import_mappings to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update on table public.custom_field_defs to service_role';
    execute 'grant select, insert, update on table public.import_mappings to service_role';
  end if;
end $$;

drop policy if exists "a88 cfd read" on public.custom_field_defs;
create policy "a88 cfd read" on public.custom_field_defs for select to authenticated
  using (org_id = (select public.current_org_id()));
drop policy if exists "a88 cfd ins" on public.custom_field_defs;
create policy "a88 cfd ins" on public.custom_field_defs for insert to authenticated
  with check (org_id = (select public.current_org_id()) and public.has_area('controls', 'edit')
              and not (select public.helm_pw_change_pending()));
drop policy if exists "a88 cfd upd" on public.custom_field_defs;
create policy "a88 cfd upd" on public.custom_field_defs for update to authenticated
  using (org_id = (select public.current_org_id()) and public.has_area('controls', 'edit'))
  with check (org_id = (select public.current_org_id()) and public.has_area('controls', 'edit')
              and not (select public.helm_pw_change_pending()));

drop policy if exists "a88 map read" on public.import_mappings;
create policy "a88 map read" on public.import_mappings for select to authenticated
  using (org_id = (select public.current_org_id()) and public.has_area(public._a88_area(entity), 'view'));
drop policy if exists "a88 map ins" on public.import_mappings;
create policy "a88 map ins" on public.import_mappings for insert to authenticated
  with check (org_id = (select public.current_org_id()) and public.has_area(public._a88_area(entity), 'edit')
              and not (select public.helm_pw_change_pending()));
drop policy if exists "a88 map upd" on public.import_mappings;
create policy "a88 map upd" on public.import_mappings for update to authenticated
  using (org_id = (select public.current_org_id()) and public.has_area(public._a88_area(entity), 'edit'))
  with check (org_id = (select public.current_org_id()) and public.has_area(public._a88_area(entity), 'edit')
              and not (select public.helm_pw_change_pending()));

-- a row can never be moved to another studio, and org/key/entity never change
create or replace function public._a88_tg_pin_keys()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.org_id is distinct from old.org_id or new.entity is distinct from old.entity
       or (tg_table_name = 'custom_field_defs' and (to_jsonb(new) ->> 'key') is distinct from (to_jsonb(old) ->> 'key')) then
      raise exception 'studio, entity and key cannot be changed' using errcode = '42501';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
revoke all on function public._a88_tg_pin_keys() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._a88_tg_pin_keys() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._a88_tg_pin_keys() from authenticated'; end if;
end $$;

do $$ declare t text; begin
  foreach t in array array['custom_field_defs', 'import_mappings'] loop
    if not exists (select 1 from pg_trigger where tgname = 'zz_a88_pin_keys' and tgrelid = ('public.' || t)::regclass) then
      execute format('create trigger zz_a88_pin_keys before insert or update on public.%I for each row execute function public._a88_tg_pin_keys()', t);
    end if;
    if not exists (select 1 from pg_trigger where tgname = 'zzz_studio_read_only' and tgrelid = ('public.' || t)::regclass) then
      execute format('create trigger zzz_studio_read_only before insert or update or delete on public.%I for each row execute function public.tg_studio_read_only(''org_id'')', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------- 4. batch import RPC
-- helpers: trimmed text (empty -> null, capped); numeric (null on blank, error on junk)
create or replace function public._a88_txt(p jsonb, k text, cap int default 300)
returns text language sql immutable set search_path = '' as $$
  select left(nullif(btrim(coalesce(p ->> k, '')), ''), cap);
$$;
create or replace function public._a88_num(p jsonb, k text)
returns numeric language plpgsql immutable set search_path = '' as $$
declare v numeric;
begin
  if p ->> k is null or btrim(p ->> k) = '' then return null; end if;
  v := (p ->> k)::numeric;
  if v < 0 or v >= 1000000000000 then raise exception '% must be between 0 and 999,999,999,999', k using errcode = '22023'; end if;
  return v;
exception when invalid_text_representation then
  raise exception '% must be a number', k using errcode = '22023';
end $$;

create or replace function public.smart_import_batch(p_entity text, p_rows jsonb, p_defs jsonb default '[]'::jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- smart-import-0088
declare
  v_org uuid := public.current_org_id();
  v_area text := public._a88_area(p_entity);
  v_out jsonb := '[]'::jsonb;
  r jsonb; f jsonb; a jsonb; d jsonb;
  v_i int; v_act text; v_id uuid; v_new uuid; v_err text;
  v_name text; v_phone text; v_email text; v_skills jsonb; v_kind text; v_emp text;
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if v_area is null then raise exception 'unknown import type' using errcode = '22023'; end if;
  if not public.has_area(v_area, 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  if to_regprocedure('public._studio_writable(uuid)') is not null and not public._studio_writable(v_org) then
    raise exception 'studio is read-only' using errcode = '42501'; end if;
  if to_regprocedure('public.helm_pw_change_pending()') is not null and public.helm_pw_change_pending() then
    raise exception 'change your password first' using errcode = '42501'; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then raise exception 'rows must be a list' using errcode = '22023'; end if;
  if jsonb_array_length(p_rows) > 500 then raise exception 'at most 500 rows per batch' using errcode = '22023'; end if;
  if octet_length(p_rows::text) > 2097152 then raise exception 'batch too large (2 MB max)' using errcode = '22023'; end if;

  -- register custom field labels for keys the import introduces (existing definitions are never renamed)
  if p_defs is not null and jsonb_typeof(p_defs) = 'array' then
    if jsonb_array_length(p_defs) > 64 then raise exception 'too many custom fields (64 max)' using errcode = '22023'; end if;
    for d in select * from jsonb_array_elements(p_defs) loop
      if jsonb_typeof(d) = 'object' and coalesce(d ->> 'key', '') ~ '^[a-z0-9_]{1,48}$'
         and length(btrim(coalesce(d ->> 'label', ''))) between 1 and 80 then
        insert into public.custom_field_defs(org_id, entity, key, label, type, position)
        values (v_org, p_entity, d ->> 'key', btrim(d ->> 'label'),
                case when d ->> 'type' in ('text', 'number', 'date', 'bool') then d ->> 'type' else 'text' end,
                coalesce((select max(position) + 1 from public.custom_field_defs c where c.org_id = v_org and c.entity = p_entity), 0))
        on conflict (org_id, entity, key) do nothing;
      end if;
    end loop;
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_i := null; v_id := null; v_new := null; v_err := null;
    begin
      if jsonb_typeof(r) <> 'object' then raise exception 'row must be an object' using errcode = '22023'; end if;
      v_i := nullif(r ->> 'i', '')::int;
      v_act := coalesce(r ->> 'action', 'create');
      f := coalesce(r -> 'fields', '{}'::jsonb);
      a := coalesce(r -> 'attributes', '{}'::jsonb);
      if jsonb_typeof(f) <> 'object' then raise exception 'fields must be an object' using errcode = '22023'; end if;
      if not public._a88_attrs_ok(a) then raise exception 'custom fields are too large or not plain values' using errcode = '22023'; end if;
      if v_act not in ('create', 'update') then raise exception 'action must be create or update' using errcode = '22023'; end if;
      if v_act = 'update' then
        v_id := (r ->> 'id')::uuid;
        if v_id is null then raise exception 'update needs the id of the existing row' using errcode = '22023'; end if;
      end if;
      v_name := public._a88_txt(f, 'name', 300);
      if v_act = 'create' and v_name is null then raise exception 'name is required' using errcode = '22023'; end if;
      if (f ? 'name') and v_name is null then raise exception 'name cannot be blank' using errcode = '22023'; end if;

      if p_entity in ('staff', 'vendors') then
        v_phone := public._a88_txt(f, 'phone', 40); v_email := public._a88_txt(f, 'email', 254);
        if not public._a84_phone_ok(v_phone) then raise exception 'Phone numbers need 7-15 digits (an optional leading + is fine).' using errcode = '22023'; end if;
        v_err := public.helm_contact_ok(v_phone, v_email);
        if v_err is not null then raise exception '%', v_err using errcode = '22023'; end if;
      end if;

      if p_entity = 'staff' then
        if v_phone is null and (v_act = 'create' or (f ? 'phone')) then
          raise exception 'Phone is required for staff.' using errcode = '22023'; end if;
        v_skills := case when jsonb_typeof(f -> 'skills') = 'array' then
          coalesce((select jsonb_agg(left(btrim(x), 60)) from (select x from jsonb_array_elements_text(f -> 'skills') x where btrim(x) <> '' limit 40) s), '[]'::jsonb)
          else null end;
        v_emp := public._a88_txt(f, 'emp_type', 20);
        if v_emp is not null and v_emp not in ('full_time', 'part_time', 'on_call') then v_emp := null; end if;
        if v_act = 'create' then
          insert into public.crew_members(org_id, name, phone, email, role, department, emp_type, day_rate, skills, notes, attributes)
          values (v_org, v_name, v_phone, v_email, public._a88_txt(f, 'role', 120), public._a88_txt(f, 'department', 120), v_emp,
                  public._a88_num(f, 'day_rate'), coalesce(v_skills, '[]'::jsonb), public._a88_txt(f, 'notes', 4000), a)
          returning id into v_new;
        else
          update public.crew_members c set
            name = case when f ? 'name' then v_name else c.name end,
            phone = case when f ? 'phone' then v_phone else c.phone end,
            email = case when f ? 'email' then v_email else c.email end,
            role = case when f ? 'role' then public._a88_txt(f, 'role', 120) else c.role end,
            department = case when f ? 'department' then public._a88_txt(f, 'department', 120) else c.department end,
            emp_type = case when f ? 'emp_type' then v_emp else c.emp_type end,
            day_rate = case when f ? 'day_rate' then public._a88_num(f, 'day_rate') else c.day_rate end,
            skills = case when v_skills is not null then v_skills else c.skills end,
            notes = case when f ? 'notes' then public._a88_txt(f, 'notes', 4000) else c.notes end,
            attributes = c.attributes || a
          where c.id = v_id and c.org_id = v_org returning c.id into v_new;
        end if;
      elsif p_entity = 'inventory' then
        if v_act = 'create' then
          insert into public.inventory_items(org_id, name, category, total_qty, unit, unit_cost, notes, attributes)
          values (v_org, v_name, public._a88_txt(f, 'category', 120), coalesce(public._a88_num(f, 'total_qty'), 0),
                  coalesce(public._a88_txt(f, 'unit', 30), 'pcs'), coalesce(public._a88_num(f, 'unit_cost'), 0),
                  public._a88_txt(f, 'notes', 4000), a)
          returning id into v_new;
        else
          update public.inventory_items i set
            name = case when f ? 'name' then v_name else i.name end,
            category = case when f ? 'category' then public._a88_txt(f, 'category', 120) else i.category end,
            total_qty = case when f ? 'total_qty' then coalesce(public._a88_num(f, 'total_qty'), i.total_qty) else i.total_qty end,
            unit = case when f ? 'unit' then coalesce(public._a88_txt(f, 'unit', 30), i.unit) else i.unit end,
            unit_cost = case when f ? 'unit_cost' then coalesce(public._a88_num(f, 'unit_cost'), i.unit_cost) else i.unit_cost end,
            notes = case when f ? 'notes' then public._a88_txt(f, 'notes', 4000) else i.notes end,
            attributes = i.attributes || a
          where i.id = v_id and i.org_id = v_org returning i.id into v_new;
        end if;
      elsif p_entity = 'menu' then
        v_kind := coalesce(public._a88_txt(f, 'kind', 20), 'veg');
        if v_kind not in ('veg', 'nonveg', 'special') then v_kind := 'veg'; end if;
        if v_act = 'create' then
          insert into public.dish_catalog(org_id, name, category, kind, attributes)
          values (v_org, v_name, coalesce(public._a88_txt(f, 'category', 120), 'Other'), v_kind, a)
          returning id into v_new;
        else
          update public.dish_catalog m set
            name = case when f ? 'name' then v_name else m.name end,
            category = case when f ? 'category' then coalesce(public._a88_txt(f, 'category', 120), m.category) else m.category end,
            kind = case when f ? 'kind' then v_kind else m.kind end,
            attributes = m.attributes || a
          where m.id = v_id and m.org_id = v_org returning m.id into v_new;
        end if;
      else -- vendors
        v_kind := public._a88_txt(f, 'kind', 20);
        if v_kind is not null and v_kind not in ('vendor', 'freelancer', 'rental', 'supplier') then v_kind := null; end if;
        if v_act = 'create' then
          insert into public.vendors(org_id, name, category, phone, email, kind, notes, attributes)
          values (v_org, v_name, public._a88_txt(f, 'category', 120), v_phone, v_email, coalesce(v_kind, 'vendor'),
                  public._a88_txt(f, 'notes', 4000), a)
          returning id into v_new;
        else
          update public.vendors x set
            name = case when f ? 'name' then v_name else x.name end,
            category = case when f ? 'category' then public._a88_txt(f, 'category', 120) else x.category end,
            phone = case when f ? 'phone' then v_phone else x.phone end,
            email = case when f ? 'email' then v_email else x.email end,
            kind = case when v_kind is not null then v_kind else x.kind end,
            notes = case when f ? 'notes' then public._a88_txt(f, 'notes', 4000) else x.notes end,
            attributes = x.attributes || a
          where x.id = v_id and x.org_id = v_org returning x.id into v_new;
        end if;
      end if;

      if v_new is null then raise exception 'that row no longer exists in your studio' using errcode = '42501'; end if;
      v_out := v_out || jsonb_build_array(jsonb_build_object('i', v_i, 'status', case when v_act = 'create' then 'created' else 'updated' end, 'id', v_new));
    exception when others then
      v_out := v_out || jsonb_build_array(jsonb_build_object('i', v_i, 'status', 'error',
        'error', case when sqlstate = '23505' then 'A record with this name already exists.' else left(sqlerrm, 300) end));
    end;
  end loop;
  return v_out;
end $$;

do $$ declare f text; begin
  foreach f in array array['public._a88_attrs_ok(jsonb)', 'public._a88_area(text)', 'public._a88_txt(jsonb,text,integer)', 'public._a88_num(jsonb,text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    -- _a88_attrs_ok / _a88_area run inside CHECK constraints and RLS policies evaluated as the caller
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
  f := 'public.smart_import_batch(text,jsonb,jsonb)';
  execute format('revoke all on function %s from public', f);
  if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
end $$;

-- ===================== 0089 =====================
-- 0089_country_tax.sql - CANONICAL forward-only. Country tax for India / UAE / USA.
--
-- In plain words:
--   * Every studio can be in India (GST 18%, CGST+SGST or IGST), the UAE (VAT 5%, TRN)
--     or the USA (sales tax at the state's rate, optional EIN). The browser table lives in
--     public/country-profile.js (window.HelmCountry); the money is still ONE rate per quote
--     (pricing.gstPct) so the D8 server pricing authority stays the single source of truth.
--   * New money rule: a TAX-EXEMPT client (pricing.taxExempt = true, e.g. a US resale /
--     nonprofit certificate) is priced with no tax. helm_quote_total (0079 wrapper) now
--     prices such a quote at gstPct 0, exactly like store-api.js pricing._canon.
--   * New columns (all nullable, no defaults that change rows):
--       organizations.country / tax_region / tax_rate_override - mirrored from the studio's
--         billing details (brand.billing.country / state) whenever the brand is saved.
--       quotes.currency / tax_snapshot - stamped from the quote's OWN pricing whenever its
--         pricing is written, so a saved/sent/paid quote keeps the currency and tax it was
--         priced with even after the studio changes country.
--   * Nothing is backfilled, updated or deleted: existing rows stay byte-identical until the
--     next time the app itself writes them. India studios with no country = India, as before.
--   Additive + idempotent (add column if not exists, create or replace, drop trigger if exists).
--
-- Research (Oct 2026): India event management SAC 998596 at 18% (unchanged by the Sept 2025
-- GST rate rationalisation); UAE VAT 5%, 15-digit TRN, "Tax Invoice" wording, VAT shown in
-- AED (VAT Executive Regulation Art. 59); US state base sales-tax rates per Tax Foundation
-- 2026 table (AK/DE/MT/NH/OR = 0%); service taxability varies by state -> studio override.
-- ============================================================================

do $$ begin
  if to_regprocedure('public.helm_quote_total__pretax(jsonb)') is null then
    raise exception '0089: apply 0079_country_tax.sql first (helm_quote_total__pretax missing)';
  end if;
end $$;

-- 1) studio country / region / rate override (nullable = India / not set)
alter table public.organizations add column if not exists country text;
alter table public.organizations add column if not exists tax_region text;
alter table public.organizations add column if not exists tax_rate_override numeric;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'organizations_country_0089_chk') then
    alter table public.organizations add constraint organizations_country_0089_chk
      check (country is null or country ~ '^[A-Z]{2}$') not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'organizations_tax_rate_0089_chk') then
    alter table public.organizations add constraint organizations_tax_rate_0089_chk
      check (tax_rate_override is null or (tax_rate_override >= 0 and tax_rate_override <= 100)) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'organizations_tax_region_0089_chk') then
    alter table public.organizations add constraint organizations_tax_region_0089_chk
      check (tax_region is null or length(tax_region) <= 60) not valid;
  end if;
end $$;

create or replace function public.helm_org_country_sync()
returns trigger language plpgsql security definer set search_path = '' as $$
-- country-tax-0089: mirror brand.billing.country/state into the typed columns (never clears them)
declare b jsonb; c text; r text;
begin
  b := case when jsonb_typeof(new.brand) = 'object' then new.brand -> 'billing' else null end;
  if b is not null and jsonb_typeof(b) = 'object' then
    c := upper(btrim(coalesce(b ->> 'country', '')));
    if c ~ '^[A-Z]{2}$' then new.country := c; end if;
    r := left(btrim(coalesce(b ->> 'state', '')), 60);
    if r <> '' then new.tax_region := r; end if;
  end if;
  return new;
end $$;
revoke all on function public.helm_org_country_sync() from public;
drop trigger if exists zz_org_country_sync on public.organizations;
create trigger zz_org_country_sync before insert or update of brand on public.organizations
  for each row execute function public.helm_org_country_sync();

-- 2) per-quote currency + tax snapshot
alter table public.quotes add column if not exists currency text;
alter table public.quotes add column if not exists tax_snapshot jsonb;

create or replace function public.helm_quote_tax_snapshot()
returns trigger language plpgsql security definer set search_path = '' as $$
-- country-tax-0089: stamp currency + tax facts from THIS quote's pricing (runs after the total is enforced)
declare p jsonb; cc text; cur text; rate numeric; ex boolean; incl boolean;
begin
  p := new.pricing;
  if p is null or jsonb_typeof(p) <> 'object' then return new; end if;
  cc := upper(coalesce(nullif(btrim(p ->> 'taxCountry'), ''), 'IN'));
  if cc !~ '^[A-Z]{2}$' then cc := 'IN'; end if;
  cur := upper(coalesce(nullif(btrim(p ->> 'currency'), ''), case cc when 'AE' then 'AED' when 'US' then 'USD' else 'INR' end));
  if cur !~ '^[A-Z]{3}$' then cur := 'INR'; end if;
  ex := lower(coalesce(p ->> 'taxExempt', '')) = 'true';
  incl := lower(coalesce(p ->> 'taxInclusive', '')) = 'true';
  rate := case when ex then 0
               when coalesce(p ->> 'gstPct', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (p ->> 'gstPct')::numeric else null end;
  new.currency := cur;
  new.tax_snapshot := jsonb_strip_nulls(jsonb_build_object(
    'country', cc, 'currency', cur,
    'taxName', coalesce(nullif(left(p ->> 'taxName', 24), ''), case cc when 'AE' then 'VAT' when 'US' then 'Sales tax' when 'IN' then 'GST' else 'Tax' end),
    'rate', rate, 'exempt', ex, 'inclusive', incl,
    'region', nullif(left(coalesce(p ->> 'taxRegion', ''), 60), ''),
    'placeOfSupply', case when cc = 'IN' then coalesce(nullif(p ->> 'placeOfSupply', ''), 'intra') else null end,
    'total', case when jsonb_typeof(p -> 'total') = 'number' then p -> 'total' else null end,
    'v', 89));
  return new;
end $$;
revoke all on function public.helm_quote_tax_snapshot() from public;
drop trigger if exists zzz_quote_tax_snapshot on public.quotes;
create trigger zzz_quote_tax_snapshot before insert or update of pricing on public.quotes
  for each row execute function public.helm_quote_tax_snapshot();

-- 3) D8: authoritative total honours taxExempt (else EXACTLY the 0079 behaviour)
create or replace function public.helm_quote_total(p jsonb)
returns numeric language plpgsql immutable security definer set search_path = '' as $$
-- country-tax-0079: taxInclusive -> price at gstPct 0, else unchanged
-- country-tax-0089: taxExempt   -> price at gstPct 0 (no tax for an exempt client)
begin
  if p is not null and jsonb_typeof(p) = 'object'
     and (lower(coalesce(p ->> 'taxInclusive', '')) = 'true' or lower(coalesce(p ->> 'taxExempt', '')) = 'true') then
    return public.helm_quote_total__pretax(p || jsonb_build_object('gstPct', 0));
  end if;
  return public.helm_quote_total__pretax(p);
end $$;

revoke all on function public.helm_quote_total(jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.helm_quote_total(jsonb) from anon;
    revoke all on function public.helm_org_country_sync() from anon;
    revoke all on function public.helm_quote_tax_snapshot() from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.helm_org_country_sync() from authenticated;
    revoke all on function public.helm_quote_tax_snapshot() from authenticated;
    grant execute on function public.helm_quote_total(jsonb) to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.helm_quote_total(jsonb) to service_role;
  end if;
end $$;

-- ===================== 0090 =====================
-- 0090_portal_quote_currency.sql - CANONICAL forward-only. Client portal shows the quote's OWN money.
--
-- In plain words:
--   The signed-out client portal (public_get_portal) formatted amounts as Indian rupees because it
--   could not read the studio's settings. It now also returns the quote's own currency and tax
--   snapshot (stamped by 0089 from the quote's pricing), so a UAE / US studio's client sees AED / $.
--   Nothing else changes: the 0082 rule (never hand out brand.billing on the portal) is kept, the
--   token check is the same (the 0082 chain), and no table, row or grant is added or removed.
--   Additive + idempotent (create or replace only). Needs 0082 and 0089.
-- ============================================================================

do $$ begin
  if to_regprocedure('public.public_get_portal__pre0082(uuid)') is null then
    raise exception '0090: apply 0082_r4_sql_fixes.sql first (public_get_portal__pre0082 missing)';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quotes' and column_name = 'tax_snapshot') then
    raise exception '0090: apply 0089_country_tax.sql first (quotes.tax_snapshot missing)';
  end if;
end $$;

create or replace function public.public_get_portal(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- portal-brand-r4-0082: never hand out brand.billing on the signed-out portal
-- portal-currency-0090: + the quote's own currency / tax_snapshot (display only)
declare v jsonb; cur text; snap jsonb;
begin
  v := public.public_get_portal__pre0082(p_token);
  if jsonb_typeof(v -> 'studio') = 'object' and jsonb_typeof(v #> '{studio,brand}') = 'object' then
    v := jsonb_set(v, '{studio,brand}', (v #> '{studio,brand}') - 'billing');
  end if;
  select q.currency, q.tax_snapshot into cur, snap from public.quotes q where q.approval_token = p_token limit 1;
  if v is not null and jsonb_typeof(v) = 'object' then
    v := v || jsonb_build_object('currency', cur,
      'tax', case when jsonb_typeof(snap) = 'object'
                  then jsonb_strip_nulls(jsonb_build_object('country', snap -> 'country', 'currency', snap -> 'currency',
                         'taxName', snap -> 'taxName', 'rate', snap -> 'rate', 'exempt', snap -> 'exempt',
                         'inclusive', snap -> 'inclusive', 'region', snap -> 'region'))
                  else null end);
  end if;
  return v;
end $$;
revoke all on function public.public_get_portal(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'grant execute on function public.public_get_portal(uuid) to anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.public_get_portal(uuid) to authenticated'; end if;
end $$;

-- COMBINED VERIFY (ALL ok = true)
select item, ok from (values
  ('0088 01 attributes column on crew_members', exists (select 1 from information_schema.columns where table_schema='public' and table_name='crew_members' and column_name='attributes')),
  ('0088 02 attributes column on inventory_items', exists (select 1 from information_schema.columns where table_schema='public' and table_name='inventory_items' and column_name='attributes')),
  ('0088 03 attributes column on dish_catalog', exists (select 1 from information_schema.columns where table_schema='public' and table_name='dish_catalog' and column_name='attributes')),
  ('0088 04 attributes column on vendors', exists (select 1 from information_schema.columns where table_schema='public' and table_name='vendors' and column_name='attributes')),
  ('0088 05 attributes size checks on 4 tables', (select count(*) from pg_constraint where conname in ('crew_members_a88_attrs_ck','inventory_items_a88_attrs_ck','dish_catalog_a88_attrs_ck','vendors_a88_attrs_ck')) = 4),
  ('0088 06 custom_field_defs table with RLS on', coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.custom_field_defs')), false)),
  ('0088 07 import_mappings table with RLS on', coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.import_mappings')), false)),
  ('0088 08 custom_field_defs checks + org fk', (select count(*) from pg_constraint where conname in ('custom_field_defs_entity_ck','custom_field_defs_key_ck','custom_field_defs_label_ck','custom_field_defs_type_ck','custom_field_defs_pos_ck','custom_field_defs_org_fk')) = 6),
  ('0088 09 import_mappings checks + org fk', (select count(*) from pg_constraint where conname in ('import_mappings_entity_ck','import_mappings_shape_ck','import_mappings_org_fk')) = 3),
  ('0088 10 cfd policies read/ins/upd', (select count(*) from pg_policies where schemaname='public' and tablename='custom_field_defs' and policyname in ('a88 cfd read','a88 cfd ins','a88 cfd upd')) = 3),
  ('0088 11 mapping policies read/ins/upd', (select count(*) from pg_policies where schemaname='public' and tablename='import_mappings' and policyname in ('a88 map read','a88 map ins','a88 map upd')) = 3),
  ('0088 12 no delete grants, anon no access', not has_table_privilege('authenticated','public.custom_field_defs','delete') and not has_table_privilege('authenticated','public.import_mappings','delete') and not has_table_privilege('anon','public.custom_field_defs','select') and not has_table_privilege('anon','public.import_mappings','select')),
  ('0088 13 pin-keys + read-only triggers', (select count(*) from pg_trigger where tgname in ('zz_a88_pin_keys','zzz_studio_read_only') and tgrelid in (to_regclass('public.custom_field_defs'), to_regclass('public.import_mappings'))) = 4),
  ('0088 14 smart_import_batch: authenticated yes, anon no', has_function_privilege('authenticated','public.smart_import_batch(text,jsonb,jsonb)','execute') and not has_function_privilege('anon','public.smart_import_batch(text,jsonb,jsonb)','execute')),
  ('0088 15 smart_import_batch gated by has_area edit', (select prosrc like '%has_area%' and prosrc like '%edit%' from pg_proc where oid = 'public.smart_import_batch(text,jsonb,jsonb)'::regprocedure)),
  ('0088 16 helpers not callable by anon', not has_function_privilege('anon','public._a88_attrs_ok(jsonb)','execute') and not has_function_privilege('anon','public._a88_area(text)','execute')),
  ('0088 17 validator rejects non-object', not public._a88_attrs_ok('[]'::jsonb) and public._a88_attrs_ok('{}'::jsonb)),
  ('0089 01 organizations country/tax_region/tax_rate_override', (select count(*) from information_schema.columns where table_schema='public' and table_name='organizations' and column_name in ('country','tax_region','tax_rate_override')) = 3),
  ('0089 02 quotes currency + tax_snapshot', (select count(*) from information_schema.columns where table_schema='public' and table_name='quotes' and column_name in ('currency','tax_snapshot')) = 2),
  ('0089 03 org country/rate/region checks', (select count(*) from pg_constraint where conname in ('organizations_country_0089_chk','organizations_tax_rate_0089_chk','organizations_tax_region_0089_chk')) = 3),
  ('0089 04 org country sync trigger', exists (select 1 from pg_trigger where tgname='zz_org_country_sync' and tgrelid='public.organizations'::regclass)),
  ('0089 05 quote tax snapshot trigger', exists (select 1 from pg_trigger where tgname='zzz_quote_tax_snapshot' and tgrelid='public.quotes'::regclass)),
  ('0089 06 exempt priced at 0%', public.helm_quote_total('{"gstPct":18,"chairs":10,"chairPrice":500,"taxExempt":true}'::jsonb) = 5000),
  ('0089 07 India total unchanged', public.helm_quote_total('{"gstPct":18,"chairs":10,"chairPrice":500}'::jsonb) = 5900),
  ('0089 08 trigger fns internal only', not has_function_privilege('authenticated','public.helm_org_country_sync()','execute') and not has_function_privilege('anon','public.helm_quote_tax_snapshot()','execute')),
  ('0089 09 helm_quote_total: authenticated yes, anon no', has_function_privilege('authenticated','public.helm_quote_total(jsonb)','execute') and not has_function_privilege('anon','public.helm_quote_total(jsonb)','execute')),
  ('0089 10 definer fns search_path empty', (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('helm_quote_total','helm_quote_tax_snapshot','helm_org_country_sync') and p.prosecdef and p.proconfig @> array['search_path=""']) = 3),
  ('0090 01 portal returns currency/tax (0090 body)', (select prosrc like '%portal-currency-0090%' and prosrc like '%billing%' from pg_proc where oid='public.public_get_portal(uuid)'::regprocedure)),
  ('0090 02 portal: anon yes, definer + empty search_path', has_function_privilege('anon','public.public_get_portal(uuid)','execute') and (select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid='public.public_get_portal(uuid)'::regprocedure)),
  ('0090 03 pre-0082 inner fn still not public', not has_function_privilege('anon','public.public_get_portal__pre0082(uuid)','execute'))
) v(item, ok)
order by item;
