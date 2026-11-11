-- APPLY-0344-CONCURRENT (R149, optional). Only for big tables - for todays small tables APPLY-0344.sql alone is fine.
-- Builds the same 34 indexes WITHOUT holding writes, using create index concurrently.
-- HOW TO RUN - one line at a time. Select ONE create index line, press Run, wait for Success, then the next line.
-- Do not run the whole file at once. The SQL editor wraps several lines in one transaction and concurrently refuses to run inside one.
-- No begin and no commit in this file on purpose. Every line is safe to run twice. Nothing is dropped or deleted.
-- AFTER the last line run APPLY-0344.sql once. Its index lines are then no-ops, it adds comms_outbox_unsub and shows VERIFY.
-- If a line fails half way, the check at the bottom shows that index with valid = false. Stop and ask before doing anything else.

create index concurrently if not exists ix_chat_reactions_org_id_0344 on public.chat_reactions (org_id);
create index concurrently if not exists ix_client_booklets_org_id_0344 on public.client_booklets (org_id);
create index concurrently if not exists ix_client_link_opens_org_id_0344 on public.client_link_opens (org_id);
create index concurrently if not exists ix_event_checkin_sites_org_id_0344 on public.event_checkin_sites (org_id);
create index concurrently if not exists ix_event_files_org_id_0344 on public.event_files (org_id);
create index concurrently if not exists ix_inbox_person_prefs_org_id_0344 on public.inbox_person_prefs (org_id);
create index concurrently if not exists ix_notification_mutes_org_id_0344 on public.notification_mutes (org_id);
create index concurrently if not exists ix_open_shift_claims_org_id_0344 on public.open_shift_claims (org_id);
create index concurrently if not exists ix_package_selections_org_id_0344 on public.package_selections (org_id);
create index concurrently if not exists ix_pkg_credits_org_id_0344 on public.pkg_credits (org_id);
create index concurrently if not exists ix_profiles_org_id_0344 on public.profiles (org_id);
create index concurrently if not exists ix_quotation_versions_org_id_0344 on public.quotation_versions (org_id);
create index concurrently if not exists ix_quote_validity_log_org_id_0344 on public.quote_validity_log (org_id);
create index concurrently if not exists ix_user_dashboard_prefs_org_id_0344 on public.user_dashboard_prefs (org_id);
create index concurrently if not exists ix_user_recent_records_org_id_0344 on public.user_recent_records (org_id);
create index concurrently if not exists ix_leads_quote_id_0344 on public.leads (quote_id);
create index concurrently if not exists ix_assign_notify_outbox_quote_id_0344 on public.assign_notify_outbox (quote_id);
create index concurrently if not exists ix_task_wa_outbox_org_id_quote_id_0344 on public.task_wa_outbox (org_id, quote_id);
create index concurrently if not exists ix_notifications_quote_id_0344 on public.notifications (quote_id);
create index concurrently if not exists ix_comms_outbox_quote_id_0344 on public.comms_outbox (quote_id);
create index concurrently if not exists ix_comms_outbox_org_id_created_at_0344 on public.comms_outbox (org_id, created_at);
create index concurrently if not exists ix_delivery_commitments_org_id_0344 on public.delivery_commitments (org_id);
create index concurrently if not exists ix_delivery_reminder_sends_commitment_id_0344 on public.delivery_reminder_sends (commitment_id);
create index concurrently if not exists ix_delivery_reminder_sends_org_id_created_at_0344 on public.delivery_reminder_sends (org_id, created_at);
create index concurrently if not exists ix_vendor_request_sends_request_id_0344 on public.vendor_request_sends (request_id);
create index concurrently if not exists ix_vendor_bills_booking_id_0344 on public.vendor_bills (booking_id);
create index concurrently if not exists ix_vendor_bills_vendor_id_0344 on public.vendor_bills (vendor_id);
create index concurrently if not exists ix_vendor_bills_file_id_0344 on public.vendor_bills (file_id);
create index concurrently if not exists ix_event_costs_booking_id_0344 on public.event_costs (booking_id);
create index concurrently if not exists ix_vendor_invoices_booking_id_0344 on public.vendor_invoices (booking_id);
create index concurrently if not exists ix_event_resources_need_id_0344 on public.event_resources (need_id);
create index concurrently if not exists ix_lead_enquiries_lead_id_0344 on public.lead_enquiries (lead_id);
create index concurrently if not exists ix_welcome_email_outbox_org_id_0344 on public.welcome_email_outbox (org_id);
create index concurrently if not exists ix_event_tasks_planned_start_0344 on public.event_tasks (planned_start);

-- CHECK (read only) every row should say valid = true and 34 rows in total
select c.relname as index_name, i.indisvalid as valid from pg_index i join pg_class c on c.oid = i.indexrelid
 where c.relnamespace = 'public'::regnamespace and c.relname like 'ix%' and right(c.relname, 5) = '_0344' order by 1;
