# =============================================================================
# KaraHoca API — multi-stage build
# =============================================================================
# @node-rs/argon2 ships prebuilt N-API binaries, so no python3/make/g++ layer is
# needed. That keeps the final image around 220 MB and the build under a minute
# on a Hetzner CCX23.
# =============================================================================

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json nest-cli.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app

# dumb-init reaps zombies and forwards SIGTERM, which is what makes
# app.enableShutdownHooks() actually drain the pg pool on redeploy.
RUN apk add --no-cache dumb-init curl tzdata \
 && cp /usr/share/zoneinfo/Europe/Istanbul /etc/localtime \
 && echo "Europe/Istanbul" > /etc/timezone

ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=768" \
    TZ=UTC

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

USER node
EXPOSE 4000

HEALTHCHECK --interval=20s --timeout=5s --start-period=25s --retries=3 \
  CMD curl -fsS http://127.0.0.1:4000/api/v1/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
