#!/usr/bin/env bash
# =============================================================================
# Deploy KaraHoca Shipping onto the shared Hetzner box. Run ON the server.
# =============================================================================
#   /opt/karahoca/infra/deploy-hetzner.sh
#
# The box already runs karahoca.com and clonelens.com. Every step below is
# written on the assumption that breaking those is far worse than failing to
# deploy, so the script refuses rather than risks.
# =============================================================================
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/karahoca}"
COMPOSE="docker compose -f $DEPLOY_DIR/infra/compose.hetzner.yml --env-file $DEPLOY_DIR/.env.hetzner"
MIN_FREE_MB="${MIN_FREE_MB:-900}"

log()  { echo -e "\033[36m[deploy]\033[0m $*"; }
ok()   { echo -e "\033[32m[deploy]\033[0m $*"; }
warn() { echo -e "\033[33m[deploy]\033[0m $*"; }
die()  { echo -e "\033[31m[deploy] $*\033[0m" >&2; exit 1; }

cd "$DEPLOY_DIR"

# ---------------------------------------------------------------------------
# 0. Refuse to start if the box cannot afford it
# ---------------------------------------------------------------------------
avail=$(free -m | awk '/Mem:/ {print $7}')
log "available memory: ${avail} MB (need ≥ ${MIN_FREE_MB} MB to build safely)"
if [ "$avail" -lt "$MIN_FREE_MB" ]; then
  die "Not enough free memory. Building here would risk the live sites.
       Free something up, or build the images elsewhere and push them."
fi

[ -f .env.hetzner ] || die ".env.hetzner is missing — run generate-env first."
docker network inspect coolify >/dev/null 2>&1 || die "The 'coolify' network does not exist."

# ---------------------------------------------------------------------------
# 1. Build ONE SERVICE AT A TIME
# ---------------------------------------------------------------------------
# Parallel builds are the default and would run the Next.js compiler and the
# Nest compiler concurrently, roughly doubling peak memory on a box that does
# not have it to spare.
# ---------------------------------------------------------------------------
log "building migrate…"
$COMPOSE build migrate
log "building api…"
$COMPOSE build api
log "building web… (the memory-hungry one)"
$COMPOSE build web
ok "images built"

# ---------------------------------------------------------------------------
# 2. Data layer first, and wait for it to be genuinely healthy
# ---------------------------------------------------------------------------
# kh-postgres / kh-redis, never postgres / redis: those names are already taken
# on the shared `coolify` network by Coolify's own control-plane containers.
log "starting kh-postgres + kh-redis…"
$COMPOSE up -d --remove-orphans kh-postgres kh-redis

log "waiting for postgres…"
for i in $(seq 1 60); do
  if $COMPOSE exec -T kh-postgres pg_isready -q 2>/dev/null; then break; fi
  [ "$i" -eq 60 ] && die "postgres never became ready"
  sleep 3
done
ok "postgres is ready"

# ---------------------------------------------------------------------------
# 3. Migrations, then the application
# ---------------------------------------------------------------------------
log "applying migrations…"
$COMPOSE run --rm migrate node migrate.mjs --seed

log "starting api + web…"
$COMPOSE up -d api web

# ---------------------------------------------------------------------------
# 4. Verify from inside, before trusting the proxy
# ---------------------------------------------------------------------------
log "waiting for the API to report healthy…"
for i in $(seq 1 40); do
  if $COMPOSE exec -T api curl -fsS http://127.0.0.1:4000/api/v1/health >/dev/null 2>&1; then break; fi
  [ "$i" -eq 40 ] && { $COMPOSE logs --tail=40 api; die "API never became healthy"; }
  sleep 3
done
ok "API is healthy inside the container"

echo
log "container state:"
$COMPOSE ps --format '  {{.Service}}\t{{.Status}}'

echo
log "memory after deploy:"
free -m | sed 's/^/  /'
docker stats --no-stream --format '  {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}' \
  $($COMPOSE ps -q 2>/dev/null) 2>/dev/null || true

echo
ok "deployed. Traefik will obtain the certificate on the first HTTPS request."
echo "  https://${APP_DOMAIN:-track.karahoca.com}/api/v1/health"
