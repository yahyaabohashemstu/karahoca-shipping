# Migration runner. Runs to completion and exits; Compose gates the API on it.
FROM node:22-alpine

WORKDIR /app

# The lockfile and `npm ci`, for the reason given in apps/api/Dockerfile.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY migrate.mjs ./
COPY migrations ./migrations
COPY seed ./seed

# Never run migrations as root against a mounted volume.
USER node

ENTRYPOINT ["node", "migrate.mjs"]
