-- REPAIR-0437 (R254) - the OWNER runs this, after APPLY-0437, only when LIST-0437 shows rows with will_repair = yes.
-- It sets approval_status back to "paid" for exactly those rows. Nothing else is written to the booking: no message goes out, no payment
-- plan is made and no payment date is moved (those two automatic steps are switched off for this one change, then on again).
-- Every row gets an audit line (action approval_status_repair_0437). A row that cannot be changed is left and shown as a notice.
-- Running it twice is safe (the second time there is nothing left to do). It waits at most 5 seconds for a lock.
-- The last result lists what was changed, ever, by this file.
-- UNDO (puts exactly these rows back to "sent", only if they still say "paid"); run the lines without the dashes:
--   update public.quotes q set approval_status = 'sent' where q.approval_status = 'paid'
--      and exists (select 1 from public.audit_log a where a.quote_id = q.id and a.action = 'approval_status_repair_0437');
begin;
set local lock_timeout = '5s';
set local statement_timeout = '2min';
alter table public.quotes disable trigger zzz_pst_auto_schedule;
alter table public.quotes disable trigger zzzz_r321_resync_on_approval;
do $$
declare r record; n integer := 0;
begin
  for r in
    select q.id, q.org_id, q.code from public.quotes q
     where q.approval_status = 'sent' and q.deleted_at is null and coalesce(q.status, '') <> 'cancelled' and not coalesce(q.consent_stale, false)
       and (q.status = 'confirmed' or coalesce(public._a52_stage_idx(q.lifecycle_stage), 0) >= 5)
       and (select coalesce(sum(x.amount), 0) from public.quote_payments x where x.quote_id = q.id and x.status = 'paid') > 0
       and not exists (select 1 from public.quote_consents c where c.quote_id = q.id and c.agreed)
       and (exists (select 1 from public.audit_log a where a.quote_id = q.id and a.entity = 'quotes' and a.changed -> 'approval_status' = '["paid", "sent"]'::jsonb)
            or exists (select 1 from public.quote_advance_log l where l.quote_id = q.id and l.kind = 'advance_confirm'))
     for update of q
  loop
    begin
      update public.quotes set approval_status = 'paid' where id = r.id and approval_status = 'sent';
      insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
        values (null, 'helm:maintenance', 'approval_status_repair_0437', 'quotes', r.id::text, r.id,
                jsonb_build_object('approval_status', jsonb_build_array('sent', 'paid'), 'why', 'turned back to sent when an approval link was made'), r.org_id);
      n := n + 1;
    exception when others then raise notice 'REPAIR 0437: % left as it is (%)', coalesce(r.code, r.id::text), sqlerrm;
    end;
  end loop;
  raise notice 'REPAIR 0437: % booking(s) set back to paid', n;
end $$;
set constraints all immediate;
alter table public.quotes enable trigger zzz_pst_auto_schedule;
alter table public.quotes enable trigger zzzz_r321_resync_on_approval;
select q.code, q.id, q.approval_status as now, max(a.at) as repaired_at
  from public.audit_log a join public.quotes q on q.id = a.quote_id where a.action = 'approval_status_repair_0437' group by 1, 2, 3 order by 4 desc;
commit;
