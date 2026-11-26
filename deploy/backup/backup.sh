#!/bin/sh
# Nightly PostgreSQL backups for TicketManager. Runs in the `backup` service (postgres image).
#
#   backup.sh          run forever: back up at BACKUP_TIME every day (and now, if the last
#                      good backup is more than a day old)
#   backup.sh once     take one backup now (docker compose exec backup sh /scripts/backup.sh once)
#
# Each backup is one file, /backups/ticketmanager-YYYY-MM-DD-HHMMSS.dump (pg_dump custom format).
# It holds everything, uploaded bills and generated ZIPs included, because files live in the
# database. Backups older than BACKUP_KEEP_DAYS are deleted. Each run is recorded in the
# backup_runs table so Admins see it on the dashboard.
set -eu

DIR=/backups
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
AT="${BACKUP_TIME:-02:30}"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S %Z') backup: $*"; }

record() { # status file size error started
  psql -v ON_ERROR_STOP=1 -q \
    -v status="$1" -v file="$2" -v size="$3" -v error="$4" -v started="$5" <<'SQL' ||
insert into backup_runs (status, file, size_bytes, error, started_at)
values (:'status', nullif(:'file', ''), nullif(:'size', '')::bigint, nullif(:'error', ''), :'started');
SQL
    log "could not record the run in backup_runs"
}

backup_once() {
  started=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  name="ticketmanager-$(date '+%Y-%m-%d-%H%M%S').dump"
  tmp="$DIR/.$name.partial"
  mkdir -p "$DIR"
  log "starting $name"
  if ! err=$(pg_dump --format=custom --compress=6 --no-owner --file="$tmp" 2>&1); then
    rm -f "$tmp"
    log "FAILED: $err"
    record failed "" "" "pg_dump: $err" "$started"
    return 1
  fi
  # A dump that pg_restore can't read is no backup.
  if ! err=$(pg_restore --list "$tmp" 2>&1 >/dev/null); then
    rm -f "$tmp"
    log "FAILED verification: $err"
    record failed "" "" "verify: $err" "$started"
    return 1
  fi
  mv "$tmp" "$DIR/$name"
  size=$(wc -c <"$DIR/$name" | tr -d ' ')
  date -u '+%Y-%m-%dT%H:%M:%SZ' >"$DIR/.last-success"
  record ok "$name" "$size" "" "$started"
  log "done $name ($size bytes)"
  find "$DIR" -maxdepth 1 -name 'ticketmanager-*.dump' -mtime +"$KEEP_DAYS" -print -delete |
    while read -r old; do log "deleted old backup $old"; done
}

seconds_until_next() {
  now=$(date +%s)
  next=$(date -d "$(date +%Y-%m-%d) $AT" +%s 2>/dev/null || date -d "$AT" +%s)
  [ "$next" -gt "$now" ] || next=$((next + 86400))
  echo $((next - now))
}

if [ "${1:-}" = "once" ]; then
  backup_once
  exit $?
fi

log "nightly at $AT ($TZ), keeping $KEEP_DAYS days, into $DIR"
# Catch up after downtime (or a fresh or restored database): back up now unless this database
# recorded a good backup in the last 24 hours.
recent=$(psql -tAc "select count(*) from backup_runs where status = 'ok' and finished_at > now() - interval '24 hours'" 2>/dev/null || echo 0)
if [ "${recent:-0}" = "0" ]; then
  backup_once || true
fi
while true; do
  wait=$(seconds_until_next)
  log "next backup in $((wait / 60)) minutes"
  sleep "$wait"
  backup_once || true
  sleep 60
done
