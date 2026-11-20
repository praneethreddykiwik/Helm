# Off-site backups (R238, FILE-06 / BAK-01)

Supabase keeps one daily backup inside Supabase. This folder makes a **second copy outside Supabase**, encrypted,
so a lost project, a bad migration or a deleted bucket can still be recovered.

**Nothing runs automatically.** There is no cron job, no GitHub Action and no Supabase change. The owner runs it by
hand (weekly is the plan) from `~/helm-local`, never from the iCloud Desktop folder.

## What it does

| Step | What | Safe because |
|---|---|---|
| 1 | `pg_dump` of the database (schema + data, custom format) | every connection is opened with `default_transaction_read_only=on`: Postgres itself refuses any write |
| 2 | exact row count of every table (`row-counts.sql`) | one read-only SELECT |
| 3 | copy of every Storage bucket (`storage_copy.py`) | list + download only (no upload / move / delete in the code) |
| 4 | one archive, encrypted with **age** or **gpg** to your public key; the plain copy is deleted | only the encrypted file stays on disk |
| 5 | optional: `rclone copy --immutable` to a remote you choose | copies only, never deletes on the remote |

## One-time setup (owner)

```bash
brew install postgresql@17 age rclone      # gpg works too: brew install gnupg
age-keygen -o ~/.helm-secrets/helm-backup.agekey   # PRIVATE key: keep it safe + a second copy offline
grep 'public key' ~/.helm-secrets/helm-backup.agekey  # the age1... public key -> AGE_RECIPIENT
rclone config                               # optional: a remote such as Backblaze B2 / Google Drive -> RCLONE_REMOTE
```

## Each week

```bash
cd ~/helm-local
export DATABASE_URL='...'                   # Supabase -> Connect -> Session pooler (paste in this terminal only)
export SUPABASE_URL='https://<ref>.supabase.co'
export SUPABASE_SERVICE_ROLE_KEY='...'      # Supabase -> Settings -> API keys (never save it in the repo)
export AGE_RECIPIENT='age1...'
export BACKUP_LABEL=prod
export RCLONE_REMOTE='b2:helm-backups/weekly'   # optional (placeholder name)
bash scripts/backup/helm-offsite-backup.sh --dry-run   # shows the plan, connects to nothing
bash scripts/backup/helm-offsite-backup.sh
unset DATABASE_URL SUPABASE_SERVICE_ROLE_KEY
```

The archive lands in `~/helm-backups/helm-prod-<time>.tar.age` (+ a `.sha256`). Old archives are never deleted by the
script; prune them yourself when you are sure newer ones restore.

## Once a month

Run the restore drill in [RESTORE-DRILL.md](RESTORE-DRILL.md) on the newest archive. A backup that was never restored
is only a hope.
