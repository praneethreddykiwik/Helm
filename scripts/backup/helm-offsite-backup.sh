#!/usr/bin/env bash
set -euo pipefail
# helm-offsite-backup.sh - R238 (FILE-06 / BAK-01): a weekly OFF-SITE copy of the Helm database + Storage files.
#
# In plain words: makes ONE encrypted archive that holds
#   * a pg_dump of the database (schema + data, custom format) - read-only: every connection is opened with
#     default_transaction_read_only=on, so this script CANNOT change a row;
#   * a copy of every Storage bucket's files (list + download only, through the Storage API with the service key);
#   * a manifest: the time, the row count of every table (read in the same read-only way) and a SHA-256 of each part;
# then encrypts it (age, or gpg) to a public key you choose, deletes the unencrypted copy, and - only if you set
# RCLONE_REMOTE - copies the encrypted archive to that remote. Nothing is ever deleted on Supabase or on the remote.
#
# Nothing runs automatically: no cron, no CI job. The owner runs it by hand (or adds a weekly reminder / launchd job
# on their own machine) from ~/helm-local. Secrets come ONLY from the environment (never from this repo):
#   DATABASE_URL              required  - the Supabase "Session pooler" or direct connection string (Dashboard ->
#                                         Connect). Use a read-only role if you have one.
#   SUPABASE_URL              optional  - https://<ref>.supabase.co  (needed for the Storage copy)
#   SUPABASE_SERVICE_ROLE_KEY optional  - service key, used only as a request header for list + download
#   AGE_RECIPIENT             one of    - an age public key (age1...)          -> archive.tar.age
#   GPG_RECIPIENT             these two - a gpg key id / e-mail in your keyring -> archive.tar.gpg
#   HELM_BACKUP_DIR           optional  - where archives go (default ~/helm-backups; keep it OFF the iCloud Desktop)
#   RCLONE_REMOTE             optional  - e.g. "b2:helm-backups/weekly" (placeholder: set up with `rclone config` first)
#   BACKUP_LABEL              optional  - a word in the file name, e.g. prod / staging (default: backup)
#   SKIP_STORAGE=1            optional  - database only
#
# Usage:  bash scripts/backup/helm-offsite-backup.sh [--dry-run]
#   --dry-run  checks the tools and settings and prints the plan; connects to nothing, writes nothing.
# Restore test: scripts/backup/RESTORE-DRILL.md (into a throwaway local Postgres, never into production).

DRY=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown option: $a (see --help)" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf 'STOP: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# ---- settings (never printed: only whether they are set) ----------------------------------------------------------
[ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL is not set (export it in this terminal only - never save it in the repo)"
case "${DATABASE_URL}" in postgres://*|postgresql://*) ;; *) die "DATABASE_URL must start with postgres:// or postgresql://" ;; esac
if [ -n "${AGE_RECIPIENT:-}" ]; then ENC=age; have age || die "age is not installed (brew install age), or set GPG_RECIPIENT instead"
elif [ -n "${GPG_RECIPIENT:-}" ]; then ENC=gpg; have gpg || die "gpg is not installed (brew install gnupg)"
else die "set AGE_RECIPIENT (age public key) or GPG_RECIPIENT - archives are never written unencrypted"; fi
have pg_dump || die "pg_dump is not installed (brew install postgresql@17)"
have psql || die "psql is not installed (brew install postgresql@17)"
have python3 || die "python3 is needed for the Storage copy"
DO_STORAGE=1
if [ "${SKIP_STORAGE:-0}" = "1" ]; then DO_STORAGE=0
elif [ -z "${SUPABASE_URL:-}" ] || [ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  say "note: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set - Storage files are NOT copied this time"; DO_STORAGE=0; fi
if [ -n "${RCLONE_REMOTE:-}" ]; then have rclone || die "RCLONE_REMOTE is set but rclone is not installed (brew install rclone)"; fi
LABEL="$(printf '%s' "${BACKUP_LABEL:-backup}" | tr -cd 'A-Za-z0-9_-' | cut -c1-24)"; [ -n "$LABEL" ] || LABEL=backup
OUT_DIR="${HELM_BACKUP_DIR:-$HOME/helm-backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="helm-${LABEL}-${STAMP}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say "Helm off-site backup - plan"
say "  database      : pg_dump --format=custom (schema + data), read-only session"
say "  storage       : $([ "$DO_STORAGE" = 1 ] && echo 'every bucket, list + download only' || echo 'skipped')"
say "  encryption    : $ENC"
say "  local folder  : $OUT_DIR/$NAME.tar.$ENC"
say "  remote copy   : ${RCLONE_REMOTE:-none (RCLONE_REMOTE not set)}"
if [ "$DRY" = 1 ]; then say "dry run: nothing connected, nothing written."; exit 0; fi

# every connection to the source database is read-only - a write would fail inside Postgres itself
export PGOPTIONS="${PGOPTIONS:-} -c default_transaction_read_only=on"
export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-15}"

umask 077
mkdir -p "$OUT_DIR"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/helm-backup.XXXXXX")"
PLAIN="$WORK/$NAME"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT
mkdir -p "$PLAIN"

say "1/4 database dump ..."
pg_dump --dbname="$DATABASE_URL" --format=custom --compress=6 --no-owner --no-privileges \
  --file="$PLAIN/database.dump"
say "    $(du -h "$PLAIN/database.dump" | cut -f1) written"

say "2/4 row counts (for the restore check) ..."
psql --dbname="$DATABASE_URL" -X -q -A -t -F '|' -v ON_ERROR_STOP=1 -f "$HERE/row-counts.sql" > "$PLAIN/row-counts.txt"
say "    $(wc -l < "$PLAIN/row-counts.txt" | tr -d ' ') tables counted"

if [ "$DO_STORAGE" = 1 ]; then
  say "3/4 storage files ..."
  python3 -I "$HERE/storage_copy.py" "$PLAIN/storage"
else
  say "3/4 storage files: skipped"
fi

{
  echo "helm off-site backup"
  echo "created_utc=$STAMP"
  echo "label=$LABEL"
  echo "pg_dump=$(pg_dump --version)"
  echo "storage=$([ "$DO_STORAGE" = 1 ] && echo copied || echo skipped)"
  echo "--- sha256"
  (cd "$PLAIN" && find . -type f ! -name MANIFEST.txt -print0 | sort -z | xargs -0 shasum -a 256)
} > "$PLAIN/MANIFEST.txt"

say "4/4 encrypt ..."
TARBALL="$WORK/$NAME.tar"
tar -C "$WORK" -cf "$TARBALL" "$NAME"
if [ "$ENC" = age ]; then
  age -r "$AGE_RECIPIENT" -o "$OUT_DIR/$NAME.tar.age" "$TARBALL"
else
  gpg --batch --yes --trust-model always --encrypt -r "$GPG_RECIPIENT" -o "$OUT_DIR/$NAME.tar.gpg" "$TARBALL"
fi
# the unencrypted copy never stays on disk
rm -f "$TARBALL"; rm -f "${PLAIN}/database.dump"; rm -rf "$PLAIN"
ARCHIVE="$OUT_DIR/$NAME.tar.$ENC"
(cd "$OUT_DIR" && shasum -a 256 "$NAME.tar.$ENC" > "$NAME.tar.$ENC.sha256")
say "    $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"

if [ -n "${RCLONE_REMOTE:-}" ]; then
  say "remote copy -> $RCLONE_REMOTE"
  rclone copy --immutable "$ARCHIVE" "$RCLONE_REMOTE"
  rclone copy --immutable "$ARCHIVE.sha256" "$RCLONE_REMOTE"
fi
say "done. Keep the age / gpg PRIVATE key somewhere safe and separate (without it the archive cannot be opened)."
