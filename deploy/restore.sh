#!/usr/bin/env bash
# Restores TicketManager from a backup file made by the backup service.
#
#   ./deploy/restore.sh backups/ticketmanager-2026-11-26-0230.dump
#   ./deploy/restore.sh --yes <file>      (no question asked; for scripts and drills)
#
# Run it from the repository folder on the server. It stops the app, replaces the WHOLE
# database with the backup, and starts the app again. Anything entered after the backup was
# taken is lost, so take a fresh backup first if the current data matters:
#   docker compose exec backup sh /scripts/backup.sh once
set -euo pipefail

yes=false
if [[ "${1:-}" == "--yes" ]]; then yes=true; shift; fi
file="${1:-}"
if [[ -z "$file" || ! -f "$file" ]]; then
  echo "Usage: $0 [--yes] <backup file>" >&2
  echo "Backups: $(ls -1t backups/ticketmanager-*.dump 2>/dev/null | head -5 | tr '\n' ' ')" >&2
  exit 1
fi

file="$(cd "$(dirname "$file")" && pwd)/$(basename "$file")"
cd "$(dirname "$0")/.."
compose() { docker compose "$@"; }

echo "Restoring from $file ($(du -h "$file" | cut -f1))."
echo "This REPLACES all TicketManager data with the backup."
if ! $yes; then
  read -r -p "Type RESTORE to continue: " answer
  [[ "$answer" == "RESTORE" ]] || { echo "Cancelled."; exit 1; }
fi

echo "1/5 Checking the backup file can be read"
compose up -d --wait postgres
compose exec -T postgres pg_restore --list >/dev/null <"$file"

echo "2/5 Stopping the app"
compose stop web api worker backup

echo "3/5 Recreating the database"
compose exec -T postgres sh -ec '
  psql -q -U ticketmanager -d postgres -v ON_ERROR_STOP=1 \
    -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = '\''ticketmanager'\'' and pid <> pg_backend_pid();" \
    -c "drop database if exists ticketmanager;" \
    -c "create database ticketmanager owner ticketmanager;"'

echo "4/5 Loading the backup"
compose exec -T postgres pg_restore -U ticketmanager -d ticketmanager --no-owner --exit-on-error <"$file"

echo "5/5 Starting the app (it applies any newer database migrations)"
compose up -d --wait

echo "Restored from $file."
compose exec -T postgres psql -U ticketmanager -d ticketmanager -tAc \
  "select 'Users: ' || count(*) from users union all select 'Vouchers: ' || count(*) from vouchers union all select 'Files: ' || count(*) from files;"
