#!/bin/sh
# =============================================================================
# KaraHoca backup sidecar
# =============================================================================
# Runs forever, dumping once a day at 02:30 UTC.
#
# Two dumps, because they answer different questions:
#
#   schema+business  — kh.* WITHOUT location_points. Small (megabytes), fast to
#                      restore, and contains every order, carrier, session and
#                      audit event. This is what you restore first in an
#                      emergency to get dispatching working again.
#
#   full             — everything including telemetry. Large, slow, weekly.
#
# A backup you have never restored is not a backup. `restore-drill.sh` next to
# this file exists to be run quarterly.
# =============================================================================

set -eu

BACKUP_DIR=/backups
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"

log() { echo "[backup $(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

do_backup() {
  stamp=$(date -u +%Y%m%d-%H%M)
  dow=$(date -u +%u)   # 1..7, 7 = Sunday

  mkdir -p "$BACKUP_DIR"

  # ---- Business data (no telemetry) -----------------------------------------
  business="$BACKUP_DIR/karahoca-business-$stamp.dump"
  log "dumping business data → $business"
  pg_dump \
    --format=custom \
    --compress=9 \
    --schema=kh \
    --exclude-table-data='kh.location_points*' \
    --exclude-table-data='_timescaledb_internal.*' \
    --file="$business"
  log "business dump complete ($(du -h "$business" | cut -f1))"

  # ---- Full dump, Sundays ----------------------------------------------------
  if [ "$dow" = "7" ]; then
    full="$BACKUP_DIR/karahoca-full-$stamp.dump"
    log "dumping full database → $full"
    pg_dump --format=custom --compress=9 --file="$full"
    log "full dump complete ($(du -h "$full" | cut -f1))"
  fi

  # ---- Verify the dump is readable before trusting it ------------------------
  if pg_restore --list "$business" > /dev/null 2>&1; then
    log "verified $business"
  else
    log "ERROR: $business is unreadable — NOT pruning old backups"
    return 1
  fi

  # ---- Off-site push (optional) ----------------------------------------------
  if [ -n "${BACKUP_SFTP_HOST:-}" ] && [ -n "${BACKUP_SFTP_USER:-}" ]; then
    log "pushing to ${BACKUP_SFTP_USER}@${BACKUP_SFTP_HOST}"
    if command -v sftp > /dev/null 2>&1; then
      echo "put $business ${BACKUP_SFTP_PATH:-/backups}/" \
        | sftp -o StrictHostKeyChecking=accept-new \
               "${BACKUP_SFTP_USER}@${BACKUP_SFTP_HOST}" \
        && log "off-site push ok" \
        || log "WARNING: off-site push failed"
    else
      log "WARNING: sftp not installed in this image; skipping off-site push"
    fi
  fi

  # ---- Prune ------------------------------------------------------------------
  find "$BACKUP_DIR" -name 'karahoca-business-*.dump' -mtime "+$KEEP_DAYS" -delete
  find "$BACKUP_DIR" -name 'karahoca-full-*.dump' -mtime "+$((KEEP_DAYS * 4))" -delete
  log "pruned backups older than $KEEP_DAYS days"
}

log "backup sidecar started; keeping $KEEP_DAYS days"

# Dump immediately on first start so a fresh deploy is never unprotected.
do_backup || log "initial backup failed"

while true; do
  now=$(date -u +%s)
  # 02:30 UTC today; if that has passed, tomorrow.
  target=$(date -u -d "$(date -u +%Y-%m-%d) 02:30:00" +%s 2>/dev/null || echo "")
  if [ -z "$target" ] || [ "$target" -le "$now" ]; then
    target=$((now + 86400 - (now % 86400) + 9000))
  fi
  sleep_for=$((target - now))
  log "next backup in $((sleep_for / 3600))h $(((sleep_for % 3600) / 60))m"
  sleep "$sleep_for"
  do_backup || log "scheduled backup failed"
done
