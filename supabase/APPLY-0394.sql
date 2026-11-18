-- APPLY-0394 (audit E: menu package changes show in the Audit log).
-- Run on STAGING first, then production. Safe to run twice. Needs 0042 / 0340 (public.tg_audit) first - already on both.
-- What it does: puts the SAME shared audit trigger every other price-feeding catalogue list already has (plate types,
-- chair types, venues, inventory items, pricing settings) on menu packages (menu_templates). After this, adding,
-- changing or removing a menu package - its price per plate, dishes or guest limits - shows in Audit log with who did
-- it and the old -> new values. Nothing else is created, changed, dropped or deleted; no row is touched.
-- Paste the whole file into the Supabase SQL editor and press Run. The last result lists checks - every ok must be true.
begin;
-- 0394_e_menu_package_audit.sql - audit E (operations, 18 Nov 2026). CANONICAL forward-only.
-- REQUIRES 0042 / 0340 (public.tg_audit()), the menu_templates table (menu packages).
--
-- In plain words:
--   Menu packages (menu_templates: name, price per plate, dishes, guest limits) can be added and changed by any studio
--   member allowed to edit the catalogue, straight from the page. Every other catalogue list that feeds a price -
--   plate types, chair types, venues, inventory items, the pricing settings - already writes WHO changed WHAT to the
--   studio Audit log through the shared audit trigger (public.tg_audit(), trigger name audit_trg). Menu packages did
--   not: a changed price per plate only raised the "prices changed" notice, with no record of who changed it or from
--   what to what. This puts the SAME shared trigger on menu_templates, exactly like 0125 (leads) and 0135 did.
--   From now on an added / changed / removed menu package shows in Audit log with the person and the old -> new values.
--   No table, column, policy or row is created, changed or deleted; no existing function is changed.
--   Additive + idempotent (drop trigger if exists + create): safe to run twice. ASCII only.

drop trigger if exists audit_trg on public.menu_templates;
create trigger audit_trg after insert or delete or update on public.menu_templates
  for each row execute function public.tg_audit();

select item, ok from (values
  ('01 menu_templates has audit_trg: AFTER INSERT / UPDATE / DELETE, FOR EACH ROW, calling public.tg_audit()',
     exists (select 1 from pg_trigger t
              where t.tgrelid = 'public.menu_templates'::regclass and t.tgname = 'audit_trg' and not t.tgisinternal
                and t.tgfoid = to_regprocedure('public.tg_audit()')
                and (t.tgtype & 1) = 1          -- row level
                and (t.tgtype & 2) = 0          -- after
                and (t.tgtype & 4) = 4 and (t.tgtype & 8) = 8 and (t.tgtype & 16) = 16)),   -- insert, delete, update
  ('02 exactly one audit_trg on menu_templates (re-run safe)',
     (select count(*) from pg_trigger t where t.tgrelid = 'public.menu_templates'::regclass and t.tgname = 'audit_trg') = 1),
  ('03 tg_audit unchanged: still security definer with the audit-via-0340 body',
     (select p.prosecdef and position('audit-via-0340' in p.prosrc) > 0 from pg_proc p where p.oid = to_regprocedure('public.tg_audit()'))),
  ('04 the other menu_templates triggers are still there (price notice, no hard delete, read-only studio)',
     (select count(*) from pg_trigger t where t.tgrelid = 'public.menu_templates'::regclass and not t.tgisinternal
        and t.tgname in ('zz_r3_menu_price_changed', 'zzzzz_r55_no_hard_delete', 'zzz_studio_read_only')) = 3),
  ('05 the existing catalogue audit triggers are untouched (plate_types, chair_types, venues, inventory_items)',
     (select count(*) from pg_trigger t where t.tgname = 'audit_trg' and t.tgrelid in
        ('public.plate_types'::regclass, 'public.chair_types'::regclass, 'public.venues'::regclass, 'public.inventory_items'::regclass)) = 4)
) v(item, ok) order by item;
commit;
