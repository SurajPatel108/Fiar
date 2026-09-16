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

use_container=false
if ! command -v pg_restore >/dev/null 2>&1; then
  : "${FIAR_PG_TOOLS_CONTAINER:?PostgreSQL client tools are unavailable; FIAR_PG_TOOLS_CONTAINER is required}"
  case "$FIAR_PG_TOOLS_CONTAINER" in *[!A-Za-z0-9_.-]*) echo "FIAR_PG_TOOLS_CONTAINER is invalid" >&2; exit 2 ;; esac
  use_container=true
fi

cleanup() {
  if [ "$use_container" = true ]; then
    docker exec "$FIAR_PG_TOOLS_CONTAINER" dropdb --if-exists --force --maintenance-db="$FIAR_ADMIN_DATABASE_URL" "$database" >/dev/null 2>&1 || true
  else
    dropdb --if-exists --force --maintenance-db="$FIAR_ADMIN_DATABASE_URL" "$database" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

base_url=${FIAR_ADMIN_DATABASE_URL%/*}
restore_url="$base_url/$database"
if [ "$use_container" = true ]; then
  docker exec "$FIAR_PG_TOOLS_CONTAINER" createdb --maintenance-db="$FIAR_ADMIN_DATABASE_URL" "$database"
  docker exec -i "$FIAR_PG_TOOLS_CONTAINER" pg_restore --dbname="$restore_url" --no-owner --no-acl < "$FIAR_BACKUP_FILE"
  docker exec -i "$FIAR_PG_TOOLS_CONTAINER" psql --dbname="$restore_url" --no-psqlrc < "$(dirname "$0")/../sql/backup-check.sql"
else
  createdb --maintenance-db="$FIAR_ADMIN_DATABASE_URL" "$database"
  pg_restore --dbname="$restore_url" --no-owner --no-acl "$FIAR_BACKUP_FILE"
  psql --dbname="$restore_url" --file="$(dirname "$0")/../sql/backup-check.sql" --no-psqlrc
fi
echo "Isolated restore verification passed"
