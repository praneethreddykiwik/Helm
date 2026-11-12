-- APPLY-0344 (R149 missing indexes + comms_outbox_unsub). Run on STAGING first, then production. Safe to run twice.
-- Plain create index holds writes to these tables until the paste finishes, a second or two on todays small tables.
-- If it stops with a deadlock or timeout message nothing was applied, just run it again.
-- For a big table run APPLY-0344-CONCURRENT.sql first, one line at a time, then this file.
begin;
-- 0344_r149_missing_indexes.sql - R149 missing indexes + comms_outbox_unsub. Forward-only, additive, safe to run twice.
-- Indexes only via create index if not exists. Nothing dropped or deleted. No row, column, policy or grant widened.
-- comms_outbox_unsub below is the 0165 function, byte for byte. Notes: supabase/migrations/MANIFEST entry 0344.
do $$
declare v_missing text;
begin
  select string_agg(x.t || '.' || x.c, ', ') into v_missing
    from (values
      ('chat_reactions', 'org_id'), ('client_booklets', 'org_id'), ('client_link_opens', 'org_id'),
      ('event_checkin_sites', 'org_id'), ('event_files', 'org_id'), ('inbox_person_prefs', 'org_id'),
      ('notification_mutes', 'org_id'), ('open_shift_claims', 'org_id'), ('package_selections', 'org_id'),
      ('pkg_credits', 'org_id'), ('profiles', 'org_id'), ('quotation_versions', 'org_id'),
      ('quote_validity_log', 'org_id'), ('user_dashboard_prefs', 'org_id'), ('user_recent_records', 'org_id'),
      ('leads', 'quote_id'), ('assign_notify_outbox', 'quote_id'), ('task_wa_outbox', 'quote_id'),
      ('notifications', 'quote_id'), ('comms_outbox', 'quote_id'), ('comms_outbox', 'org_id'),
      ('delivery_commitments', 'org_id'), ('delivery_reminder_sends', 'commitment_id'),
      ('delivery_reminder_sends', 'org_id'), ('vendor_request_sends', 'request_id'),
      ('vendor_bills', 'booking_id'), ('vendor_bills', 'vendor_id'), ('vendor_bills', 'file_id'),
      ('event_costs', 'booking_id'), ('vendor_invoices', 'booking_id'), ('event_resources', 'need_id'),
      ('lead_enquiries', 'lead_id'), ('welcome_email_outbox', 'org_id'), ('event_tasks', 'planned_start')
    ) x(t, c)
   where not exists (select 1 from pg_attribute a
                      where a.attrelid = to_regclass('public.' || x.t) and a.attname = x.c and not a.attisdropped);
  if v_missing is not null then
    raise exception 'STOP 0344: missing table or column % - apply the earlier migrations first', v_missing; end if;
  if to_regprocedure('public.email_is_opted_out(uuid, text)') is null or to_regprocedure('public.email_unsub_token(uuid, text)') is null then
    raise exception 'STOP 0344: email_is_opted_out or email_unsub_token missing - apply 0165 first'; end if;
end $$;

-- a) tables whose row security filters on org_id but had no index starting with org_id
create index if not exists ix_chat_reactions_org_id_0344 on public.chat_reactions (org_id);
create index if not exists ix_client_booklets_org_id_0344 on public.client_booklets (org_id);
create index if not exists ix_client_link_opens_org_id_0344 on public.client_link_opens (org_id);
create index if not exists ix_event_checkin_sites_org_id_0344 on public.event_checkin_sites (org_id);
create index if not exists ix_event_files_org_id_0344 on public.event_files (org_id);
create index if not exists ix_inbox_person_prefs_org_id_0344 on public.inbox_person_prefs (org_id);
create index if not exists ix_notification_mutes_org_id_0344 on public.notification_mutes (org_id);
create index if not exists ix_open_shift_claims_org_id_0344 on public.open_shift_claims (org_id);
create index if not exists ix_package_selections_org_id_0344 on public.package_selections (org_id);
create index if not exists ix_pkg_credits_org_id_0344 on public.pkg_credits (org_id);
create index if not exists ix_profiles_org_id_0344 on public.profiles (org_id);
create index if not exists ix_quotation_versions_org_id_0344 on public.quotation_versions (org_id);
create index if not exists ix_quote_validity_log_org_id_0344 on public.quote_validity_log (org_id);
create index if not exists ix_user_dashboard_prefs_org_id_0344 on public.user_dashboard_prefs (org_id);
create index if not exists ix_user_recent_records_org_id_0344 on public.user_recent_records (org_id);

-- b) lookups used by triggers, server functions, scheduled jobs and deletes
create index if not exists ix_leads_quote_id_0344 on public.leads (quote_id);
create index if not exists ix_assign_notify_outbox_quote_id_0344 on public.assign_notify_outbox (quote_id);
create index if not exists ix_task_wa_outbox_org_id_quote_id_0344 on public.task_wa_outbox (org_id, quote_id);
create index if not exists ix_notifications_quote_id_0344 on public.notifications (quote_id);
create index if not exists ix_comms_outbox_quote_id_0344 on public.comms_outbox (quote_id);
create index if not exists ix_comms_outbox_org_id_created_at_0344 on public.comms_outbox (org_id, created_at);
create index if not exists ix_delivery_commitments_org_id_0344 on public.delivery_commitments (org_id);
create index if not exists ix_delivery_reminder_sends_commitment_id_0344 on public.delivery_reminder_sends (commitment_id);
create index if not exists ix_delivery_reminder_sends_org_id_created_at_0344 on public.delivery_reminder_sends (org_id, created_at);
create index if not exists ix_vendor_request_sends_request_id_0344 on public.vendor_request_sends (request_id);
create index if not exists ix_vendor_bills_booking_id_0344 on public.vendor_bills (booking_id);
create index if not exists ix_vendor_bills_vendor_id_0344 on public.vendor_bills (vendor_id);
create index if not exists ix_vendor_bills_file_id_0344 on public.vendor_bills (file_id);
create index if not exists ix_event_costs_booking_id_0344 on public.event_costs (booking_id);
create index if not exists ix_vendor_invoices_booking_id_0344 on public.vendor_invoices (booking_id);
create index if not exists ix_event_resources_need_id_0344 on public.event_resources (need_id);
create index if not exists ix_lead_enquiries_lead_id_0344 on public.lead_enquiries (lead_id);
create index if not exists ix_welcome_email_outbox_org_id_0344 on public.welcome_email_outbox (org_id);
create index if not exists ix_event_tasks_planned_start_0344 on public.event_tasks (planned_start);

-- c) comms_outbox_unsub exactly as in 0165 (it was missing from APPLY-0165, so follow-up e-mails were skipped)
create or replace function public.comms_outbox_unsub(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- email-unsub-0165
declare v_org uuid; v_to text;
begin
  select c.org_id, c.recipient into v_org, v_to from public.comms_outbox c where c.id = p_id;
  if v_org is null then return jsonb_build_object('ok', false); end if;
  return jsonb_build_object('ok', true, 'opted_out', public.email_is_opted_out(v_org, v_to),
                            'token', public.email_unsub_token(v_org, v_to));
end $$;

do $$
begin
  execute 'revoke all on function public.comms_outbox_unsub(uuid) from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.comms_outbox_unsub(uuid) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.comms_outbox_unsub(uuid) from authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.comms_outbox_unsub(uuid) to service_role'; end if;
end $$;

commit;

-- VERIFY every line should say true
select item, ok from (values
  ('01 all 34 R149 indexes are there', (select count(*) from pg_index i join pg_class c on c.oid = i.indexrelid where c.relnamespace = 'public'::regnamespace and c.relname like 'ix%' and right(c.relname, 5) = '_0344') = 34),
  ('02 every R149 index is valid and ready', (select count(*) from pg_index i join pg_class c on c.oid = i.indexrelid where c.relnamespace = 'public'::regnamespace and c.relname like 'ix%' and right(c.relname, 5) = '_0344' and i.indisvalid and i.indisready) = 34),
  ('03 every table filtered by org_id in row security has an index starting with org_id', not exists (select 1 from pg_policies p join pg_class c on c.relname = p.tablename and c.relnamespace = 'public'::regnamespace join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped where p.schemaname = 'public' and (coalesce(p.qual, '') ~ '\morg_id\M' or coalesce(p.with_check, '') ~ '\morg_id\M') and not exists (select 1 from pg_index i where i.indrelid = c.oid and i.indkey[0] = a.attnum))),
  ('04 quote to lead sync lookup has its index', exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'leads' and indexname = 'ix_leads_quote_id_0344')),
  ('05 comms_outbox_unsub is back with the 0165 body', position('email-unsub-0165' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.comms_outbox_unsub(uuid)')), '')) > 0),
  ('06 comms_outbox_unsub for the dispatcher only', coalesce(has_function_privilege('service_role', to_regprocedure('public.comms_outbox_unsub(uuid)'), 'execute') and not has_function_privilege('anon', to_regprocedure('public.comms_outbox_unsub(uuid)'), 'execute') and not has_function_privilege('authenticated', to_regprocedure('public.comms_outbox_unsub(uuid)'), 'execute'), false)),
  ('07 comms_outbox_unsub answers ok false for an unknown row', coalesce((public.comms_outbox_unsub('00000000-0000-0000-0000-000000000000') ->> 'ok') = 'false', false))
) v(item, ok) order by item;
