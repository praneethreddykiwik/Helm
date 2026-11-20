# Restore drill (monthly, ~15 minutes)

Goal: prove the newest off-site archive really opens and holds the data. It restores into a **throwaway local
Postgres** on your Mac and compares row counts. It never touches production or staging.

## 1. A throwaway Postgres (its own folder + port)

```bash
export PATH=/opt/homebrew/opt/postgresql@17/bin:$PATH LC_ALL=C
DRILL=$(mktemp -d /tmp/helm-drill.XXXX)
initdb -D "$DRILL/data" -U "$(whoami)" --auth=trust >/dev/null
pg_ctl -D "$DRILL/data" -o "-p 55499 -k $DRILL" -l "$DRILL/log" start
export PGHOST=127.0.0.1 PGPORT=55499
createdb helm_drill
# Supabase roles the dump mentions (only names - no passwords, nothing to log in with)
psql -d helm_drill -c "do \$\$ declare r text; begin foreach r in array array['anon','authenticated','service_role','supabase_admin','supabase_auth_admin','supabase_storage_admin','authenticator','dashboard_user'] loop if not exists (select 1 from pg_roles where rolname = r) then execute format('create role %I nologin', r); end if; end loop; end \$\$;"
```

## 2. Decrypt + unpack (into the throwaway folder)

```bash
A=~/helm-backups/helm-prod-<time>.tar.age            # the newest archive
(cd ~/helm-backups && shasum -a 256 -c "$(basename "$A").sha256")   # must say OK
age -d -i ~/.helm-secrets/helm-backup.agekey "$A" | tar -C "$DRILL" -xf -
#   gpg instead: gpg --decrypt "$A" | tar -C "$DRILL" -xf -
B=$(ls -d "$DRILL"/helm-*)
(cd "$B" && sed -n '/--- sha256/,$p' MANIFEST.txt | tail -n +2 | shasum -a 256 -c -)   # every part OK
```

## 3. Restore

```bash
pg_restore --dbname=helm_drill --no-owner --no-privileges --exit-on-error --schema=public "$B/database.dump" \
  || pg_restore --dbname=helm_drill --no-owner --no-privileges "$B/database.dump"   # full restore; Supabase-only extensions may print errors
```

A Supabase dump can mention extensions / schemas a plain local Postgres does not have (pg_net, pg_cron, vault ...);
errors about those are expected in the second form. The public tables are what the check below compares.

## 4. Check the row counts

```bash
psql -d helm_drill -X -q -A -t -F '|' -f scripts/backup/row-counts.sql > "$DRILL/restored-counts.txt"
grep '^public\.' "$B/row-counts.txt"     | sort > "$DRILL/a.txt"
grep '^public\.' "$DRILL/restored-counts.txt" | sort > "$DRILL/b.txt"
diff "$DRILL/a.txt" "$DRILL/b.txt" && echo "RESTORE DRILL: row counts match"
ls "$B/storage" 2>/dev/null && find "$B/storage" -type f | wc -l      # files per bucket came back
```

The counts were taken a moment after the dump, so on a busy day one or two tables (logs, queues) may differ by a few
rows. Everything else must match exactly. Open one or two Storage files (a photo, a PDF) to see they are real.

## 5. Throw it away

```bash
pg_ctl -D "$DRILL/data" stop
rm -rf "$DRILL"            # the decrypted copy is deleted too
unset PGHOST PGPORT
```

Write the date + "counts match" in OWNER-TODO.md. If anything did not match, keep the archive and tell the developer.
