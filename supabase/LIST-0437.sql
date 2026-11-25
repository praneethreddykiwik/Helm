-- LIST-0437 (R254) - READ ONLY: one SELECT, it changes nothing. Run it before and after APPLY-0437 (any time), on each database.
-- Part 1: bookings that were probably turned from "paid" back to "sent" when an approval link was made: approval_status "sent", confirmed
--         (status or stage), money received, the client never approved, the price not changed since. will_repair = the database itself
--         shows it was "paid" before (its audit line paid -> sent, or the "booked by advance" note of 0435): only these are touched by
--         REPAIR-0437. "no" = look at it yourself.
-- Part 2: duplicate day-of rows (same event, same kind, same person / booking). While there are any, 0437 leaves the one-row guard out.
select 'part 1: approval' as part, q.org_id::text as studio_id, q.code as item, q.id::text as id,
       concat_ws(', ', 'status ' || q.status, 'stage ' || coalesce(q.lifecycle_stage, '-'), 'received ' || p.net::text || ' ' || coalesce(q.currency, '')) as details,
       case when e.ok then 'yes' else 'no' end as will_repair
  from public.quotes q
  cross join lateral (select coalesce(sum(x.amount), 0) as net from public.quote_payments x where x.quote_id = q.id and x.status = 'paid') p
  cross join lateral (select exists (select 1 from public.audit_log a where a.quote_id = q.id and a.entity = 'quotes' and a.changed -> 'approval_status' = '["paid", "sent"]'::jsonb)
                          or exists (select 1 from public.quote_advance_log l where l.quote_id = q.id and l.kind = 'advance_confirm') as ok) e
 where q.approval_status = 'sent' and q.deleted_at is null and coalesce(q.status, '') <> 'cancelled' and not coalesce(q.consent_stale, false)
   and (q.status = 'confirmed' or coalesce(public._a52_stage_idx(q.lifecycle_stage), 0) >= 5)
   and p.net > 0 and not exists (select 1 from public.quote_consents c where c.quote_id = q.id and c.agreed)
union all
select 'part 2: duplicate day-of rows', d.org_id::text, max(d.who), d.ref_id::text, 'event ' || d.quote_id::text || ', kind ' || d.kind || ', rows ' || count(*), 'no'
  from public.event_day d where d.ref_id is not null group by d.org_id, d.quote_id, d.kind, d.ref_id having count(*) > 1
order by 1, 6 desc, 2, 3;
