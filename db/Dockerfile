# Migration runner. Runs to completion and exits; Compose gates the API on it.
FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY migrate.mjs ./
COPY migrations ./migrations
COPY seed ./seed

# Never run migrations as root against a mounted volume.
USER node

ENTRYPOINT ["node", "migrate.mjs"]
