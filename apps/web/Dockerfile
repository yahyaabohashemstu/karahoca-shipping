# =============================================================================
# KaraHoca web command center
# =============================================================================
# NEXT_PUBLIC_* variables are inlined at BUILD time, not read at runtime, so the
# API URL and map style must be build args. Changing them requires a rebuild —
# which is why docker-compose passes them through as build.args.
# =============================================================================

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund

FROM node:22-alpine AS build
WORKDIR /app

ARG NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1
ARG NEXT_PUBLIC_MAP_STYLE=https://tiles.openfreemap.org/styles/liberty

# Cap the compiler's heap. Left unbounded, Next sizes its heap from TOTAL host
# memory and will happily grow past what is actually free — which on a shared
# box means the OOM killer picks a victim, and the victim is whichever process
# is largest, not whichever is newest. Building the tracking dashboard must
# never be able to take down the company website.
ARG NODE_BUILD_MEMORY=1536

ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_MAP_STYLE=$NEXT_PUBLIC_MAP_STYLE \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_OPTIONS=--max-old-space-size=$NODE_BUILD_MEMORY

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache curl

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# `output: standalone` produces a server bundling only what is imported.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/login || exit 1

CMD ["node", "server.js"]
