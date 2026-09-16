#!/bin/sh
set -eu

: "${FIAR_DATABASE_URL:?FIAR_DATABASE_URL is required}"
: "${FIAR_BACKUP_FILE:?FIAR_BACKUP_FILE is required}"

case "$FIAR_BACKUP_FILE" in
  /*) ;;
  *) echo "FIAR_BACKUP_FILE must be an absolute path" >&2; exit 2 ;;
esac

umask 077
if command -v pg_dump >/dev/null 2>&1; then
  pg_dump --dbname="$FIAR_DATABASE_URL" --format=custom --no-owner --no-acl --file="$FIAR_BACKUP_FILE"
elif [ -n "${FIAR_PG_TOOLS_CONTAINER:-}" ]; then
  case "$FIAR_PG_TOOLS_CONTAINER" in *[!A-Za-z0-9_.-]*) echo "FIAR_PG_TOOLS_CONTAINER is invalid" >&2; exit 2 ;; esac
  docker exec "$FIAR_PG_TOOLS_CONTAINER" pg_dump --dbname="$FIAR_DATABASE_URL" --format=custom --no-owner --no-acl > "$FIAR_BACKUP_FILE"
else
  echo "pg_dump is unavailable; install PostgreSQL 16 client tools or set FIAR_PG_TOOLS_CONTAINER" >&2
  exit 2
fi
echo "Backup created at the requested path"
