# Deployment — Hetzner + Coolify

## Server sizing

| Fleet | Hetzner | Monthly | Headroom |
|---|---|---|---|
| ≤ 25 trucks | CPX31 (4 vCPU / 8 GB / 160 GB) | ~€15 | comfortable |
| ≤ 150 trucks | **CCX23 (4 dedicated vCPU / 16 GB / 160 GB)** | ~€25 | recommended baseline |
| ≤ 500 trucks | CCX33 (8 / 32 GB / 240 GB) | ~€50 | with a Postgres replica |

Pick a **dedicated-vCPU (CCX)** line, not shared. Postgres compression jobs and
TimescaleDB background workers are exactly the bursty CPU pattern that shared
vCPUs throttle.

Storage: 160 GB NVMe holds ~4 GB/year of compressed telemetry at 250 trucks
(see [data model](02-data-model.md)) plus backups, with room to spare.

---

## 1. Provision

```bash
# On a fresh Ubuntu 24.04 Hetzner box, as root
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
```

Then, before anything else:

```bash
ufw default deny incoming
ufw allow 22/tcp
ufw allow 80,443/tcp
ufw allow 8000/tcp          # Coolify UI — restrict to your office IP if possible
ufw enable

# Postgres and Redis must NEVER be reachable from the internet.
# They are only on the compose bridge network; do not add ufw rules for them.
```

## 2. DNS

| Record | Value |
|---|---|
| `track.karahoca.com` → A | server IP — API + realtime + QR landing |
| `panel.karahoca.com` → A | server IP — dispatcher dashboard |

Two hostnames rather than one with paths: the API is called by phones on hostile
networks and the dashboard by staff browsers, and keeping them separate means a
CORS or CSP change on one cannot break the other.

> **The actual KaraHoca deployment uses one hostname**, `track.karahoca.com`,
> with Traefik path routing: priority 100 for `/api`, `/realtime` and `/t/` to
> the API, priority 1 catch-all to the dashboard. One hostname means one
> certificate to obtain on a box where obtaining certificates is already the
> hard part (see below). The two-hostname split above is the better shape once
> the fleet outgrows a single server.

## 3. Generate secrets

```bash
for name in JWT_USER_SECRET JWT_DRIVER_SECRET INGEST_KEY_SECRET POSTGRES_PASSWORD; do
  echo "$name=$(openssl rand -base64 48)"
done
```

Paste them into Coolify's environment editor.

> **`INGEST_KEY_SECRET` is effectively permanent.** It envelope-encrypts every
> stored per-session HMAC key. Rotating it makes all of them undecryptable and
> forces a re-claim on every live session — meaning every truck currently on the
> road goes dark until a dispatcher phones the driver with a new code. Back it
> up somewhere you would back up a root password.

## 4. Deploy

In Coolify: **New Resource → Docker Compose**, point at this repository,
`docker-compose.yml` at the root.

Coolify supplies the reverse proxy and TLS, so leave the `edge` profile off.
Map the two domains:

| Service | Port | Domain |
|---|---|---|
| `api` | 4000 | `track.karahoca.com` |
| `web` | 3000 | `panel.karahoca.com` |

**Health checks** — point Coolify at `/api/v1/health/ready` for `api`. It checks
Postgres and Redis and returns 503 when either is down, so a database blip
briefly pulls the instance from rotation instead of returning 500s to trucks.

**Build args.** `NEXT_PUBLIC_*` is inlined into the web bundle at build time, not
read at runtime. Changing `NEXT_PUBLIC_API_URL` requires a rebuild, not a
restart. This trips everyone up once.

## 5. First boot

`migrate` runs to completion and `api` waits on
`service_completed_successfully`, so schema and application can never start out
of order.

On first boot with an empty `kh.users`, `BootstrapService` creates the admin from
`ADMIN_EMAIL` / `ADMIN_PASSWORD`. Then:

1. Sign in at `https://panel.karahoca.com`.
2. Change the password.
3. **Delete `ADMIN_PASSWORD` from Coolify's environment** and redeploy.

Optional demo data:

```bash
docker compose run --rm migrate node /app/migrate.mjs --seed
```

## 6. Build and publish the driver APK

```bash
cd android
./gradlew assembleRelease -PkhApiBaseUrl=https://track.karahoca.com/api/v1/
```

Serve the APK at `https://track.karahoca.com/downloads/karahoca-tracker.apk` —
the QR landing page's `S.browser_fallback_url` points there, so a driver who
scans a code on a phone without the app gets the installer instead of an error.

Any static host works; the simplest is an `nginx:alpine` service with a mounted
volume, or Coolify's own static-site resource on the same domain.

---

## Deploying onto a box that already runs Coolify

`infra/compose.hetzner.yml` is the variant for this case. Two things about it
are non-obvious and both were learned the hard way.

### Never name a service `postgres` or `redis` on a shared Docker network

To be routed by Coolify's Traefik, your `api` and `web` containers must join
the external `coolify` network. Docker then resolves DNS across **every**
attached network, and there is no way to scope a lookup to one of them.

Coolify's own control-plane containers hold these aliases on that network:

```
coolify-db     aliases = [coolify-db, postgres]
coolify-redis  aliases = [coolify-redis, redis]
```

So a service named `postgres` in your compose file means your application
resolves `postgres` to **the database that runs the hosting platform**. The
first deploy of this project failed with `NOAUTH Authentication required` from
Coolify's Redis — which was luck. Had the credentials happened to match, the
tracking API would have been pointed at Coolify's own database.

The services are therefore called `kh-postgres` and `kh-redis`. Renaming them
back to generic names reintroduces the collision silently.

### Port 80 must be open, and "the sites work" does not prove it is

Traefik under Coolify obtains every certificate with the ACME **HTTP-01**
challenge, which Let's Encrypt performs over **plain HTTP on port 80**. Port 443
being open is irrelevant to issuance.

On the KaraHoca box, inbound TCP/80 is filtered by the **Hetzner Cloud
Firewall** — a layer above the machine, invisible to `ufw`, `iptables`, Docker
and Coolify alike. Every ACME order had been failing hourly since July. Nobody
noticed, because certificates issued *before* the block are valid for 90 days
and the sites kept serving them. The failure surfaces only at renewal, 30 days
before expiry, and by then it is a countdown rather than a bug report.

Diagnose it by comparing 80 against 443 **from outside the server** — a loopback
or hairpin `curl` to the public IP succeeds even when the port is filtered
upstream, which is exactly how this stays hidden:

```bash
# From a machine that is not the server
for p in 80 443; do nc -z -w5 SERVER_IP $p && echo "$p open" || echo "$p filtered"; done
```

If the host is innocent, `iptables -L INPUT` is an empty ACCEPT chain, `ufw` is
inactive, and `nft list ruleset` shows DNAT plus forward-accept rules for 80 that
are shape-identical to the working 443 rules — with non-zero packet counters.
Then the block is upstream and only the cloud console can clear it.

Audit expiry dates rather than trusting that HTTPS currently works:

```bash
docker exec coolify-proxy sh -c 'cat /traefik/acme.json' \
  | jq -r '.[].Certificates[]? | .domain.main'
echo | openssl s_client -servername HOST -connect SERVER_IP:443 2>/dev/null \
  | openssl x509 -noout -enddate -issuer
```

`issuer=CN = TRAEFIK DEFAULT CERT` means that hostname has **no** certificate
and is serving Traefik's self-signed placeholder to real visitors.

`infra/after-port80.sh` runs the full post-unblock verification: confirms 80 is
reachable, signals Traefik to retry ACME without restarting `coolify-proxy`
(restarting it would drop every live site), waits for a Let's Encrypt issuer,
and then checks health, TLS chain validity and the Socket.IO handshake from the
public internet.

**If port 80 genuinely cannot be opened**, switch the resolver to the
**TLS-ALPN-01** challenge, which runs entirely over 443. It requires editing
Coolify's Traefik *static* configuration and recreating `coolify-proxy`, so it
costs a brief outage on every site the box hosts — schedule it, do not improvise
it.

### Size for the box you actually have, not the box in ADR-012

The root `docker-compose.yml` asks Postgres for `shared_buffers=4GB` and
`effective_cache_size=12GB`. On a shared 4 GB server hosting live sites that is
an immediate OOM for somebody else's application. The Hetzner variant caps
every container explicitly:

| Service | Container cap | Notable setting |
|---|---|---|
| `kh-postgres` | 640 MB | `shared_buffers=160MB`, 2 background workers |
| `kh-redis` | 80 MB | `maxmemory=48mb`, LRU |
| `api` | 320 MB | Node heap 224 MB — **below** the cap, so V8 GCs before the kernel kills |
| `web` | 288 MB | Node heap 200 MB |

The build is capped too. Next.js sizes its compiler heap from *total* host
memory and will grow past what is actually free; the OOM killer then picks the
largest process, which is somebody else's app rather than the build. Hence
`NODE_BUILD_MEMORY` in the web Dockerfile and one-service-at-a-time builds in
`deploy-hetzner.sh`, which also refuses to start below 900 MB free.

## Operations

### Watch it work

```bash
docker compose logs -f api | grep -E 'Recovered|OFFLINE|silent|Expired'
```

```sql
-- Ingest health, last hour
SELECT date_trunc('minute', received_at) AS minute,
       count(*)                      AS batches,
       sum(accepted_count)           AS points,
       count(*) FILTER (WHERE is_offline_sync) AS offline_syncs,
       round(avg(lag_sec))           AS avg_lag_sec,
       max(lag_sec)                  AS worst_lag_sec
FROM kh.ingest_batches
WHERE received_at > now() - interval '1 hour'
GROUP BY 1 ORDER BY 1 DESC;
```

```sql
-- Trucks that have gone quiet
SELECT reference, order_number, driver_name, driver_phone,
       seconds_since_fix / 60 AS minutes_silent, last_battery_pct
FROM kh.v_live_fleet
WHERE status = 'ACTIVE' AND seconds_since_fix > 900
ORDER BY seconds_since_fix DESC;
```

```sql
-- Storage and compression effectiveness
SELECT hypertable_name,
       pg_size_pretty(before_compression_total_bytes) AS before,
       pg_size_pretty(after_compression_total_bytes)  AS after,
       round(before_compression_total_bytes::numeric
             / nullif(after_compression_total_bytes, 0), 1) AS ratio
FROM hypertable_compression_stats('kh.location_points');
```

### Backups

Live since 2026-08-12 and running as a first-class service, not a profile —
see **[09 — Backup and restore](09-backup-and-restore.md)**, which is the
single source of truth for schedule, retention, the drill and the exact
restore procedure.

In brief: nightly at 02:30 UTC into `/opt/karahoca/backups`, one business dump
(`kh.*` minus telemetry) and one full dump, 30-day retention, and a restore
drill every Sunday that actually restores the dump and checks the hypertable,
the continuous aggregate, compression and row counts.

**Do not restore this database with a bare `pg_restore`.** It carries
TimescaleDB, and a plain restore silently returns `location_points` as an
ordinary table — no error, no hypertable, no compression, no retention policy.
The `timescaledb_pre_restore()` / `timescaledb_post_restore()` sequence in
document 09 is not optional. An earlier version of this section printed the
bare-`pg_restore` recipe, which would have produced exactly that broken result
in an emergency.

### Scaling, in order

1. **Vertical.** CCX23 → CCX33. Raise `shared_buffers` to 25% and
   `effective_cache_size` to 75% of the new RAM.
2. **API replicas.** Add `deploy.replicas: 3`. The API is stateless and the
   Socket.IO Redis adapter already handles cross-replica fan-out. Nothing else
   changes.
3. **Dedicated database host** + streaming replica; point read-only reporting at
   the replica.
4. **Split ingest** into its own service against the same database, so a backlog
   storm cannot slow the dashboard.

Kubernetes is not on this list. Revisit it when step 4 is exhausted, which for
this workload is somewhere past 2,000 concurrent trucks.

### Upgrades

```bash
git pull && docker compose up -d --build
```

Migrations are append-only and checksum-verified — `migrate.mjs` refuses to
silently re-run a changed file. `docker compose run --rm migrate node /app/migrate.mjs --status`
lists pending work without applying it.

The API drains cleanly on SIGTERM (`dumb-init` + `enableShutdownHooks`), and
trucks buffer through the restart window, so a redeploy costs nothing but a few
seconds of latency.

### Security checklist

- [ ] Postgres and Redis have **no** published ports in production (the
      `postgres-dev-ports` socat shim is `--profile dev` only).
- [ ] `INGEST_REQUIRE_HMAC=true`.
- [ ] `ADMIN_PASSWORD` removed from the environment after first boot.
- [ ] `CORS_ORIGINS` lists the dashboard origin explicitly, not `*`.
- [ ] Coolify UI (:8000) firewalled to known IPs.
- [ ] Certificate pinning enabled in the APK once the production cert is stable
      (see the commented block in `network_security_config.xml`; pin a backup
      key and set an expiration so renewal day cannot brick the fleet).
- [ ] The three secrets stored somewhere other than this server.
