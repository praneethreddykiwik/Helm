# Runbook: which migrations does a database really have?

The APPLY files you paste into the Supabase SQL editor change the database, but they do not write down
what they did. So production keeps no record of its own migrations. `supabase/CHECK-PROD-MIGRATIONS.sql`
answers the question by looking: for every migration in `supabase/migrations/MANIFEST` it checks that the
things the migration makes are there (functions with their argument types, tables, columns, indexes,
policies, triggers, constraints, cron jobs, storage buckets, realtime tables, and the latest function
bodies).

The checker is **read only**: one SELECT, it changes nothing, and you can run it as often as you like.

## When

After every release, once that release's APPLY files are pasted. **STAGING first, then PRODUCTION.**

## How (about 5 minutes)

1. Take the file from `main`: `supabase/CHECK-PROD-MIGRATIONS.sql`. Never edit it by hand. It is
   generated (`node scripts/gen-check-prod.mjs`), and CI fails if it falls behind MANIFEST, so the copy
   on `main` always lists every migration.
   Copy it to the clipboard: `LANG=en_US.UTF-8 pbcopy < supabase/CHECK-PROD-MIGRATIONS.sql`
   (The older `CHECK-PROD-MIGRATIONS.sql` on the Desktop covers 0288 to 0302 only. This file replaces it.)
2. In the Supabase dashboard, open the **staging** project, then **SQL editor**, then **New query**.
   Paste the file and press **Run**. It takes a second or two and shows one grid.
3. Read the grid (see below). Problems are listed first.
4. Fix every `missing` or `partial` row (see below), then run the checker again until none are left.
5. Repeat steps 2 to 4 on **production**.

## Reading the grid

| column | meaning |
|---|---|
| `migration` | the migration file (`0312_r96_cancel_task` means `supabase/migrations/0312_r96_cancel_task.sql`) |
| `status` | see the next table |
| `found` | objects found / objects checked, e.g. `15/16` |
| `missing_objects` | the first 5 objects that were not found (`(+N more)` when there are more) |
| `note` | why a migration is optional or skipped, or which rows could not be checked here |

| status | what it means | what to do |
|---|---|---|
| `missing` | none of the migration's objects are on this database | paste its APPLY file |
| `partial` | some objects are there, some are not | paste its APPLY file |
| `optional` | not applied everywhere on purpose (for example 0117, Razorpay, which is dormant) | nothing |
| `skip` | changes only data or grants, so there is nothing to look up by name | nothing |
| `superseded` | later migrations re-made everything it made, and they are checked instead | nothing |
| `not visible` | its only object is a cron job or a realtime table this login cannot see | nothing (see the note) |
| `present` | everything was found | nothing |

How to read the names in `missing_objects`:

- `fn public.cancel_task(uuid,text)`: the function with these argument types does not exist.
- `body public.f(uuid)`: the function exists, but the live text is not this migration's version (an
  older APPLY was pasted, or something edited the function later).
- `pre *__pre0329`: the migration keeps old function bodies as `<name>__pre0329`, and none were found.
- `table` / `column public.t.c` / `index` / `policy P on public.t` / `trigger T on public.t` /
  `constraint C on public.t` / `cron JOB` / `bucket ID` / `publication supabase_realtime has public.t` /
  `marker public.f(args) TEXT` (the function body should contain TEXT).

## Fixing `missing` / `partial`: paste the APPLY file

**APPLY files are the way to fix a missing or partial row.** For migration `NNNN`, paste
`supabase/APPLY-NNNN.sql` (or the release bundle that contains it) into the SQL editor of the same
project. They are additive and safe to run twice. The last grid of each APPLY file should show
`ok = true` on every row.

- Work oldest first (lowest number first). A later migration can need an earlier one. If it does, its
  precheck STOPS before changing anything and names the file to paste first.
- Then run the checker again. The row should now say `present`.
- If a row is still `partial` after its APPLY file ran cleanly, the APPLY file is behind its migration.
  Do not try other files. Ask the developer for a fix-up APPLY file. Known case (2026-11-11):
  `APPLY-0165.sql` does not contain `comms_outbox_unsub(uuid)`, although the migration does.
- If no `APPLY-NNNN.sql` exists for a number, ask the developer to prepare one. Never paste a migration
  or phase file that was not prepared for the SQL editor.

Known differences on 2026-11-11 (staging and production): **0312** (`cancel_task`, office cancels a crew
task) is missing, so paste `APPLY-0312.sql`. **0165** is partial (`comms_outbox_unsub`), so ask for a
fix-up APPLY. **0117** is optional and should stay that way (Razorpay is dormant).

## Cron jobs and realtime

Cron jobs are checked only where `cron.job` exists and can be read by your login. Realtime tables are
checked only where the `supabase_realtime` publication exists. Otherwise those rows are not counted, and
the `note` column says `not checked here (...)`. A cron job that a different database user scheduled may
also be hidden from you by cron's own security.

## For developers

- A new migration appears in the checker automatically. After adding it to MANIFEST, run
  `node scripts/gen-check-prod.mjs` and commit `supabase/CHECK-PROD-MIGRATIONS.sql`.
  `npm run ci` and GitHub CI (`--check`) fail when you forget.
- `node scripts/gen-check-prod.mjs --list NNNN` prints what is checked for one migration.
- If a migration makes nothing the parser can see (data or grants only, or everything built with
  dynamic SQL), the generator stops and asks for an entry in `supabase/check-prod-overrides.json`.
  Use `status` `skip` or `optional` with a `note`, or `add` objects to check (for example a trigger
  created with `format('... on public.%I')`).
- `scripts/db-test/run-all.sh` runs the checker on a freshly migrated local database and fails on any
  `missing` / `partial` row, so a misread migration is caught before the owner ever sees it. To silence
  an object that exists only conditionally, use that migration's `ignore` list in the overrides file.
- Known limits: the checker sees what a migration makes, not data changes or grants. An object that a
  later migration re-makes also counts for the earlier one. Re-issued functions are checked by body only
  for their latest author.

## APPLY file template (from 0401 on)

Every new `supabase/APPLY-NNNN.sql` opens its transaction with these two lines, right after `begin;`:

```sql
begin;
set local lock_timeout = '5s';         -- wait at most 5 s for a table / function lock, then stop (nothing changed)
set local statement_timeout = '5min';  -- one statement never runs longer than 5 minutes
-- ... the migration body ...
-- ... the check rows (every ok must be true) ...
commit;
```

Why: a paste that waits for a lock held by the app queues every app write behind it (PART-A DB-05). With
`lock_timeout` the paste stops with an error after 5 seconds instead and changes nothing (the transaction
rolls back) - just run it again a little later. `set local` lasts only until `commit`, so nothing else
changes (no role or database setting). Keep APPLY files additive, idempotent, ASCII, without temp tables
or other session state, and end them with check rows.

### Every new migration records its number (R242, 0412)

From 0412 on the app asks the database which updates are in (`helm_schema_version()`, signed-in, numbers only) and
hides a feature whose SQL is not pasted yet ("database update pending") instead of failing with "function not found".
So every NEW migration ends with one line (idempotent, numbers only):

```sql
insert into public.helm_schema_markers(num, name) values (413, '0413_short_name') on conflict (num) do nothing;
```

Page code that needs migration NNNN asks `await BPStore.schema.has(NNNN)`: `true` = in, `false` = not in (hide the
feature, say the update is pending), `null` = unknown (a database before 0412 - just try, as before). Updates
0381-0412 are also found by one object each (`_r412_probes()`), so they need no marker row.
