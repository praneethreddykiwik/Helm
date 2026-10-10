# Fill-only migrations and `updated_at`

## What happened with 0091 (live-round2 C4)

`0091_quote_currency_backfill.sql` only fills `quotes.currency` / `quotes.tax_snapshot` where they
are empty. It never touches pricing, totals or status. But `public.quotes` has the base-v1 trigger

```sql
create trigger quotes_set_updated before update on public.quotes
  for each row execute function set_updated_at();   -- new.updated_at = now()
```

so every backfilled row got `updated_at = <time 0091 ran>`. The Quotes list sorts and shows dates by
`updated_at`, so old confirmed quotes looked as if they had been edited on the day 0091 was applied.

Production data was **not** changed back. The original `updated_at` values are not recoverable from
the row itself, and rewriting them would be a data change on prod. This is cosmetic: totals,
payments, versions and the audit trail are unaffected.

## Rule for future fill-only migrations

A migration that only back-fills derived / empty columns must not bump `updated_at`. Inside the
migration's transaction, switch off just the touch trigger around the fill and switch it back on:

```sql
begin;
alter table public.quotes disable trigger quotes_set_updated;   -- only the touch trigger
update public.quotes set <derived_col> = ... where <derived_col> is null;
alter table public.quotes enable trigger quotes_set_updated;
commit;
```

* Disable the **named** trigger only. Never use `disable trigger all` or
  `session_replication_role = replica`: that also turns off the money / pricing / org guards.
* Keep the enable in the same transaction so a failure rolls both back (the trigger never stays off).
* `alter table ... disable trigger` needs the table owner (the Supabase SQL editor runs as
  `postgres`, which is fine) and takes a brief lock on `quotes`, so run it off-peak.
* Same pattern for other tables with a `*_set_updated` trigger (`leads`, `inventory_items`, ...).
* Migrations that change what a user sees or edits (pricing, status) **should** bump `updated_at`;
  this rule is only for invisible fills.

No change was made to `set_updated_at()` itself: it is a shared base-v1 function used by many tables,
and adding a session flag to it is not a trivially safe change.
