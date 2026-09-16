#!/bin/sh
set -eu

: "${FIAR_DATABASE_URL:?FIAR_DATABASE_URL is required}"
: "${FIAR_BACKUP_FILE:?FIAR_BACKUP_FILE is required}"

case "$FIAR_BACKUP_FILE" in
  /*) ;;
  *) echo "FIAR_BACKUP_FILE must be an absolute path" >&2; exit 2 ;;
esac

umask 077
pg_dump --dbname="$FIAR_DATABASE_URL" --format=custom --no-owner --no-acl --file="$FIAR_BACKUP_FILE"
echo "Backup created at the requested path"
