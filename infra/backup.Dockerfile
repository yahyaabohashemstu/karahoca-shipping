# =============================================================================
# Backup sidecar image
# =============================================================================
# The script is BAKED IN rather than bind-mounted, and that is not a style
# preference. Coolify materialises only the rendered docker-compose.yaml into
# /data/coolify/applications/<uuid>/ — the repository checkout is a temporary
# build directory that is cleaned up afterwards. A `./infra/backup.sh:…` mount
# would therefore resolve to a path that does not exist, and Docker's response
# to that is to silently create an empty *directory* and mount it over the
# script. The container then fails on every start with "can't open … is a
# directory", which reads like a corrupt image rather than a missing file.
#
# Building it goes through the same mechanism the api, web and migrate services
# already use, so the script stays in git and ships with the deploy.
#
# postgres:16-alpine for the client tools only; the entrypoint replaces the
# server. The major version matches the server (PG 16.6 via timescaledb-ha) —
# pg_dump refuses to dump a server newer than itself, so this must be bumped in
# step with the database image.
# =============================================================================
FROM postgres:16-alpine

# For the off-site push. The script degrades gracefully without it, but a
# missing binary is a silent way for off-site backups to never happen.
RUN apk add --no-cache openssh-client

COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh

ENTRYPOINT ["/bin/sh", "/usr/local/bin/backup.sh"]
