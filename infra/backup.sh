#!/bin/sh
# =============================================================================
# KaraHoca backup sidecar
# =============================================================================
# Nightly logical dumps at 02:30 UTC, plus a weekly restore drill that actually
# restores what it produced. Runs as a long-lived container rather than a host
# cron so the schedule ships with the stack instead of living in someone's
# crontab, invisible to git and lost on the next server rebuild.
#
# Subcommands, so a human can do by hand exactly what the loop does:
#
#   backup.sh            the scheduling loop (container entrypoint)
#   backup.sh dump       one dump cycle, now
#   backup.sh drill      restore the newest full dump and verify it, now
#
# TWO DUMPS, because they answer different questions:
#
#   business  kh.* WITHOUT telemetry. Small and fast. This is what you restore
#             first in an emergency to get dispatching working again.
#   full      everything, including location_points and the TimescaleDB
#             catalogs. This is the one that can rebuild the whole database.
#
# At the current size both are a few hundred kilobytes and both run nightly.
# The split earns its keep later: one truck at a 10-second cadence produces
# ~8,600 rows a day, so telemetry will eventually dominate the dump while the
# business tables stay tiny — and it is the business tables you need at 3 a.m.
#
# WHY THE RESTORE DRILL IS NOT OPTIONAL: this database carries TimescaleDB,
# PostGIS and timescaledb_toolkit. pg_dump warns outright that the Timescale
# catalog has circular foreign keys, and a plain `pg_restore` into a fresh
# database does NOT reproduce a working hypertable. The dump file being
# readable proves nothing about any of that. The drill below performs the real
# pre_restore/post_restore sequence and checks the hypertable came back.
# =============================================================================

set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
# Refuse to dump when the filesystem is this close to full. Backups must never
# be the thing that fills a shared 75 GB disk and takes the live site down.
MIN_FREE_MB="${BACKUP_MIN_FREE_MB:-2048}"
DRILL_DB="${BACKUP_DRILL_DB:-karahoca_drill}"
# Tables whose row counts are recorded at dump time and re-checked after the
# drill restore. Append-only tables are fine here: the manifest is written
# before the dump, so restored >= manifest is the correct assertion.
VERIFY_TABLES="${BACKUP_VERIFY_TABLES:-orders customers vehicles drivers tracking_sessions session_events location_points}"

log() { echo "[backup $(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }
die() { log "ERROR: $*"; return 1; }

free_mb() { df -Pm "$BACKUP_DIR" | awk 'NR==2 {print $4}'; }

q() { psql -X -q -v ON_ERROR_STOP=1 -tAc "$1"; }

# -----------------------------------------------------------------------------
# Dump
# -----------------------------------------------------------------------------
do_dump() {
  mkdir -p "$BACKUP_DIR"

  avail=$(free_mb)
  if [ "$avail" -lt "$MIN_FREE_MB" ]; then
    log "only ${avail} MB free (need ${MIN_FREE_MB}); pruning early and skipping this cycle"
    prune
    return 1
  fi

  stamp=$(date -u +%Y%m%d-%H%M)
  business="$BACKUP_DIR/karahoca-business-$stamp.dump"
  full="$BACKUP_DIR/karahoca-full-$stamp.dump"
  manifest="$BACKUP_DIR/karahoca-full-$stamp.manifest"

  # Counts BEFORE the dump, so the drill can assert restored >= recorded. A
  # count taken afterwards would race every truck currently uploading.
  #
  # The assertion direction only holds for tables that never shrink. The
  # retention policy on location_points is `drop_after: 2 years`, so the first
  # chunk it can delete is in 2028 — if that interval is ever shortened to
  # something a dump could straddle, this comparison starts producing false
  # alarms and needs a tolerance.
  : > "$manifest"
  for t in $VERIFY_TABLES; do
    n=$(q "SELECT count(*) FROM kh.$t" 2>/dev/null || echo skip)
    [ "$n" = "skip" ] || echo "$t $n" >> "$manifest"
  done
  log "manifest: $(tr '\n' ' ' < "$manifest")"

  log "dumping business data"
  pg_dump --format=custom --compress=9 \
    --schema=kh \
    --exclude-table-data='kh.location_points' \
    --file="$business"

  log "dumping full database"
  pg_dump --format=custom --compress=9 --file="$full"

  # Readability is the floor, not the bar. The drill is what clears the bar.
  for f in "$business" "$full"; do
    pg_restore --list "$f" > /dev/null 2>&1 || die "unreadable dump: $f"
  done

  log "dumps ok — business $(du -h "$business" | cut -f1), full $(du -h "$full" | cut -f1)"
  push_offsite "$business" "$full" "$manifest"
  prune
}

# -----------------------------------------------------------------------------
# Restore drill — the part that turns a file into a backup
# -----------------------------------------------------------------------------
do_drill() {
  [ "$DRILL_DB" != "${PGDATABASE:-}" ] || die "drill database equals the live database — refusing"

  full=$(ls -1t "$BACKUP_DIR"/karahoca-full-*.dump 2>/dev/null | head -1)
  [ -n "$full" ] || die "no full dump to drill"
  manifest="${full%.dump}.manifest"
  log "drilling $full"

  # WITH (FORCE): a drill that died mid-run, or a psql session someone left
  # open against the scratch database, would otherwise make DROP DATABASE fail
  # and every subsequent drill fail with it.
  psql -X -q -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $DRILL_DB WITH (FORCE)" > /dev/null
  psql -X -q -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $DRILL_DB" > /dev/null

  # timescaledb must exist BEFORE the restore: pre_restore() is a function in
  # the extension, and without that call the Timescale catalog restores as
  # inert rows and location_points comes back as an ordinary table.
  psql -X -q -d "$DRILL_DB" -v ON_ERROR_STOP=1 \
    -c "CREATE EXTENSION IF NOT EXISTS timescaledb" \
    -c "SELECT timescaledb_pre_restore()" > /dev/null

  # Not ON_ERROR_STOP: the dump re-issues CREATE EXTENSION for extensions that
  # already exist in the fresh database, which is noise, not failure. The row
  # comparison below is the real verdict.
  pg_restore -d "$DRILL_DB" --no-owner --no-privileges "$full" > /dev/null 2>&1 || true

  psql -X -q -d "$DRILL_DB" -v ON_ERROR_STOP=1 \
    -c "SELECT timescaledb_post_restore()" > /dev/null

  failures=0

  chunks=$(psql -X -q -d "$DRILL_DB" -tAc \
    "SELECT coalesce(sum(num_chunks),0) FROM timescaledb_information.hypertables WHERE hypertable_name='location_points'" 2>/dev/null || echo 0)
  if [ "${chunks:-0}" -ge 1 ]; then
    log "  hypertable location_points restored with $chunks chunk(s)  OK"
  else
    log "  hypertable location_points did NOT come back as a hypertable  FAIL"
    failures=$((failures + 1))
  fi

  # The continuous aggregate is a second hypertable plus a catalog entry that
  # post_restore has to re-register. Verified by hand on 2026-08-12 that it
  # does survive — this row exists so that if it ever stops surviving, the
  # drill says so instead of a dispatcher discovering it during a restore.
  caggs=$(psql -X -q -d "$DRILL_DB" -tAc \
    "SELECT count(*) FROM timescaledb_information.continuous_aggregates" 2>/dev/null || echo 0)
  if [ "${caggs:-0}" -ge 1 ]; then
    log "  continuous aggregate(s) restored: $caggs  OK"
  else
    log "  continuous aggregate did not survive the restore  FAIL"
    failures=$((failures + 1))
  fi

  # Compression first fires 14 days after a chunk closes, so for the first two
  # weeks of this database's life every dump contained only uncompressed
  # chunks. Once it starts, a restore that silently decompressed would balloon
  # storage and change query plans without failing anything. Compared against
  # the live side rather than asserted absolutely: "same as production" is the
  # property that matters, and it holds before and after compression begins.
  live_comp=$(psql -X -q -tAc \
    "SELECT count(*) FROM timescaledb_information.chunks WHERE is_compressed" 2>/dev/null || echo -1)
  drill_comp=$(psql -X -q -d "$DRILL_DB" -tAc \
    "SELECT count(*) FROM timescaledb_information.chunks WHERE is_compressed" 2>/dev/null || echo -2)
  if [ "$drill_comp" -ge "$live_comp" ] 2>/dev/null; then
    log "  compressed chunks restored=$drill_comp live=$live_comp  OK"
  else
    log "  compressed chunks restored=$drill_comp live=$live_comp — compression was lost  FAIL"
    failures=$((failures + 1))
  fi

  if [ -f "$manifest" ]; then
    while read -r t expected; do
      [ -n "${t:-}" ] || continue
      got=$(psql -X -q -d "$DRILL_DB" -tAc "SELECT count(*) FROM kh.$t" 2>/dev/null || echo -1)
      if [ "$got" -ge "$expected" ] 2>/dev/null; then
        log "  kh.$t restored=$got recorded=$expected  OK"
      else
        log "  kh.$t restored=$got recorded=$expected  FAIL"
        failures=$((failures + 1))
      fi
    done < "$manifest"
  else
    log "  no manifest beside this dump; row counts unverified"
  fi

  psql -X -q -d postgres -c "DROP DATABASE IF EXISTS $DRILL_DB" > /dev/null

  if [ "$failures" -eq 0 ]; then
    log "RESTORE DRILL PASSED for $full"
    date -u +%Y-%m-%dT%H:%M:%SZ > "$BACKUP_DIR/.last-drill-passed"
  else
    log "RESTORE DRILL FAILED with $failures problem(s) — the backups are NOT trustworthy"
    return 1
  fi
}

# -----------------------------------------------------------------------------
# Off-site (optional) and pruning
# -----------------------------------------------------------------------------
push_offsite() {
  [ -n "${BACKUP_SFTP_HOST:-}" ] && [ -n "${BACKUP_SFTP_USER:-}" ] || {
    log "no off-site target configured — these dumps live on the same disk as the database"
    return 0
  }
  command -v sftp > /dev/null 2>&1 || { log "WARNING: sftp missing in this image; off-site skipped"; return 0; }
  for f in "$@"; do
    echo "put $f ${BACKUP_SFTP_PATH:-/backups}/" \
      | sftp -o StrictHostKeyChecking=accept-new "${BACKUP_SFTP_USER}@${BACKUP_SFTP_HOST}" > /dev/null \
      && log "off-site: $(basename "$f") ok" \
      || log "WARNING: off-site push failed for $(basename "$f")"
  done
}

prune() {
  find "$BACKUP_DIR" -name 'karahoca-business-*.dump' -mtime "+$KEEP_DAYS" -delete
  find "$BACKUP_DIR" -name 'karahoca-full-*.dump'     -mtime "+$KEEP_DAYS" -delete
  find "$BACKUP_DIR" -name 'karahoca-full-*.manifest' -mtime "+$KEEP_DAYS" -delete
  log "kept the last $KEEP_DAYS days; $(free_mb) MB free"
}

# -----------------------------------------------------------------------------
# Entry
# -----------------------------------------------------------------------------
case "${1:-loop}" in
  dump)  do_dump; exit $? ;;
  drill) do_drill; exit $? ;;
  loop)  ;;
  *)     echo "usage: backup.sh [loop|dump|drill]" >&2; exit 2 ;;
esac

log "sidecar started — nightly 02:30 UTC, ${KEEP_DAYS}-day retention, drill on Sundays"

# Dump immediately, so a freshly deployed stack is never unprotected while it
# waits for the first 02:30.
do_dump || log "initial dump failed"
do_drill || log "initial drill failed"

while true; do
  now=$(date -u +%s)
  # Next 02:30 UTC. Computed arithmetically rather than with `date -d`, which
  # busybox does not implement the way GNU coreutils does.
  target=$((now - (now % 86400) + 9000))
  [ "$target" -gt "$now" ] || target=$((target + 86400))
  wait_for=$((target - now))
  log "next dump in $((wait_for / 3600))h $(((wait_for % 3600) / 60))m"
  sleep "$wait_for"

  do_dump || log "scheduled dump failed"
  # Sunday. A drill every night would be pure cost; never drilling is how you
  # find out the backups were broken on the day you needed them.
  [ "$(date -u +%u)" = "7" ] && { do_drill || log "scheduled drill failed"; }
done
