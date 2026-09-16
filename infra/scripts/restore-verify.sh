#!/bin/sh
set -eu

: "${FIAR_ADMIN_DATABASE_URL:?FIAR_ADMIN_DATABASE_URL is required}"
: "${FIAR_BACKUP_FILE:?FIAR_BACKUP_FILE is required}"

suffix=$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')
database="${FIAR_RESTORE_DATABASE:-fiar_restore_$suffix}"
if ! printf '%s' "$database" | grep -Eq '^fiar_restore_[a-z0-9_]+$'; then
  echo "Restore database name must begin fiar_restore_ and contain only lowercase letters, numbers, or underscores" >&2
  exit 2
fi
case "$database" in
  fiar|postgres|template0|template1|fiar_restore_) echo "Protected database name refused" >&2; exit 2 ;;
esac

cleanup() { dropdb --if-exists --force --maintenance-db="$FIAR_ADMIN_DATABASE_URL" "$database" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

createdb --maintenance-db="$FIAR_ADMIN_DATABASE_URL" "$database"
base_url=${FIAR_ADMIN_DATABASE_URL%/*}
restore_url="$base_url/$database"
pg_restore --dbname="$restore_url" --no-owner --no-acl "$FIAR_BACKUP_FILE"
psql --dbname="$restore_url" --file="$(dirname "$0")/../sql/backup-check.sql" --no-psqlrc
echo "Isolated restore verification passed"
