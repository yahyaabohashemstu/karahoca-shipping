# 09 — Backup and restore

Until 2026-08-12 there was no backup of this database. Not a broken one — none.
The `backup` service in `docker-compose.yml` sat behind a `profiles: ["backup"]`
guard and was never part of the deployed stack, there was no cron entry and no
systemd timer, and Coolify's scheduled-backup feature only applies to databases
it manages as their own resource, which this one is not. The only artifact on
the box was a single hand-made dump taken the night of the Coolify migration.

## What runs now

A `backup` sidecar in `docker-compose.coolify.yml`, built from
`infra/backup.Dockerfile`, wrapping `infra/backup.sh`.

| | |
|---|---|
| Schedule | 02:30 UTC daily, plus once immediately on deploy |
| Restore drill | Sundays, and on deploy |
| Output | `/opt/karahoca/backups` on the host (bind mount, survives redeploys) |
| Retention | 30 days |
| Health | container goes unhealthy if no full dump in 26 h |

A sidecar rather than a host cron: the schedule then lives in git and is
recreated automatically on any rebuild, instead of in a crontab that nothing
recreates and no one remembers.

### Two dumps per night

`karahoca-business-<stamp>.dump` — `kh.*` without telemetry. Every order,
customer, carrier, session and audit event. This is the one you restore first
in an emergency, because it is what gets dispatching working again.

`karahoca-full-<stamp>.dump` — everything, including `location_points` and the
TimescaleDB catalogs. This is the one that rebuilds the database.

Both are a few hundred kilobytes today. The split earns its keep later: one
truck at a ten-second cadence writes ~8,600 rows a day, so telemetry will come
to dominate the full dump while the business tables stay small — and at 3 a.m.
it is the business tables you want.

Each full dump is written with a `.manifest` of row counts taken immediately
*before* the dump, which is what makes the drill's assertion meaningful.

## The restore drill, and why it is not optional

This database carries TimescaleDB, PostGIS and timescaledb_toolkit.
`pg_dump` warns outright that the Timescale catalog has circular foreign keys,
and a plain `pg_restore` into a fresh database does **not** give you back a
working hypertable — `location_points` comes back as an ordinary table and
nothing tells you. `pg_restore --list` succeeding proves the file is readable
and nothing more.

So the sidecar restores what it produced:

1. `CREATE DATABASE karahoca_drill`
2. `CREATE EXTENSION timescaledb` — **before** the restore, because
   `timescaledb_pre_restore()` is a function inside it
3. `SELECT timescaledb_pre_restore()`
4. `pg_restore -d karahoca_drill --no-owner --no-privileges`
5. `SELECT timescaledb_post_restore()`
6. assert `location_points` is a hypertable with ≥ 1 chunk
7. assert every table in the manifest restored to ≥ its recorded count
8. `DROP DATABASE karahoca_drill`

Verified against production on 2026-08-12: hypertable restored with 1 chunk,
and orders 4/4, customers 3/3, tracking_sessions 10/10, session_events 169/169,
location_points 309/309.

Run it by hand at any time:

```bash
docker exec $(docker ps --format '{{.Names}}' | grep '^backup-') /usr/local/bin/backup.sh drill
```

`/opt/karahoca/backups/.last-drill-passed` holds the timestamp of the last pass.

## Restoring for real

```bash
# 1. Get the dump onto the box (skip if restoring in place)
scp karahoca-full-YYYYMMDD-HHMM.dump root@host:/opt/karahoca/backups/

# 2. Restore into a NEW database first. Never straight over the live one —
#    you want the old data still there if the dump turns out to be wrong.
C=$(docker ps --format '{{.Names}}' | grep '^kh-postgres-' | head -1)
docker exec "$C" psql -U karahoca -d postgres -c 'CREATE DATABASE karahoca_restored'
docker exec "$C" psql -U karahoca -d karahoca_restored \
  -c 'CREATE EXTENSION IF NOT EXISTS timescaledb' \
  -c 'SELECT timescaledb_pre_restore()'
docker exec "$C" pg_restore -U karahoca -d karahoca_restored --no-owner --no-privileges \
  /backups/karahoca-full-YYYYMMDD-HHMM.dump
docker exec "$C" psql -U karahoca -d karahoca_restored -c 'SELECT timescaledb_post_restore()'

# 3. Check it before cutting over
docker exec "$C" psql -U karahoca -d karahoca_restored \
  -c 'SELECT count(*) FROM kh.orders' \
  -c 'SELECT hypertable_name, num_chunks FROM timescaledb_information.hypertables'

# 4. Cut over: stop the API, rename, restart.
```

For the business dump the same sequence applies minus the Timescale steps, but
the target database must already have the extensions — the dump is
`--schema=kh` only and carries no `CREATE EXTENSION`.

## Off-site, since 2026-08-13

The dumps still land on the same disk as the database — that has not changed —
but they no longer only live there.

`D:\karahoca\backups\pull-backups.ps1` on the office machine pulls every new
dump and manifest over SSH, verifies each one by sha256 against the server copy
before keeping it, and prunes at 90 days (longer than the server's 30: an
off-site copy is the one you still want when you discover the corruption
started six weeks ago). It is registered as the Windows scheduled task
**KaraHoca backup pull**, daily at 06:00 local — three and a half hours after
the server's 02:30 UTC dump — and it logs to `D:\karahoca\backups\pull.log`.
It warns in that log when the newest off-site dump is more than two days old,
because a pull that silently stops is the same as no backup at all.

First run: 21 files, all hash-verified.

```powershell
# run it now
schtasks /run /tn "KaraHoca backup pull"
# remove it
schtasks /delete /tn "KaraHoca backup pull" /f
```

**This is not as good as a Storage Box and is not meant to be.** It depends on
a particular computer being switched on. `BACKUP_SFTP_HOST` / `_USER` / `_PATH`
are still plumbed and still empty, and setting them against a Hetzner Storage
Box (BX11, ~EUR 3.81/mo, same datacentre network, SFTP out of the box) gives a
target that does not sleep. What follows is the reasoning for why that is
worth doing.

## The gap that is still open

**These dumps sit on the same physical disk as the database they protect.**

That covers what actually goes wrong most of the time: a bad migration, a
dropped table, a delete without a WHERE clause, a corrupted row. It does not
cover a lost disk, a lost server, or a mistaken `docker volume rm`. A backup on
the same disk is not a backup — the architecture decision record said so before
any of this was written.

Closing it needs somewhere off the box. Set these and the sidecar starts
pushing every dump there on the same schedule:

```
BACKUP_SFTP_HOST=uNNNNN.your-storagebox.de
BACKUP_SFTP_USER=uNNNNN
BACKUP_SFTP_PATH=/karahoca
```

plus an SSH key the container can use. A Hetzner Storage Box (BX11, ~€3.81/mo,
1 TB) is the obvious fit — same provider, same datacentre network, SFTP out of
the box. Hetzner's own server backups (20% of the server price) are an
alternative but they snapshot the whole machine, which is coarser and slower to
restore from than a 160 KB dump.
