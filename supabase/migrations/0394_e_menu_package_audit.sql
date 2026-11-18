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
