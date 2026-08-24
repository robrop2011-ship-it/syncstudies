# syntax=docker/dockerfile:1
#
# Realtime service image (PLAN.md §16.3).
#
# Build context is the REPO ROOT, not this directory — the service consumes the
# workspace packages as TypeScript source, so it needs them present.
#
#   docker build -f apps/realtime/Dockerfile .
#
# Only the four workspace packages this service actually imports are copied.
# Pulling in apps/web would double the image and rebuild it on every frontend
# commit.

FROM node:22-alpine AS base
# Prisma's query engine needs OpenSSL on Alpine; without it the client fails at
# runtime with a confusing "could not locate the query engine" error.
RUN apk add --no-cache openssl
RUN corepack enable
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

# ── dependencies ────────────────────────────────────────────────────────────
# Manifests only, so a source-only change reuses this layer.
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages/config/package.json ./packages/config/
COPY packages/shared/package.json ./packages/shared/
COPY packages/db/package.json ./packages/db/
COPY packages/auth/package.json ./packages/auth/
COPY apps/realtime/package.json ./apps/realtime/
RUN pnpm install --frozen-lockfile --filter @syncstudy/realtime...

# ── build ───────────────────────────────────────────────────────────────────
# There is no bundling step: workspace packages resolve to their `src/index.ts`
# and tsx compiles on demand. The only build work is generating the Prisma
# client and proving the service typechecks before it can ship.
FROM deps AS build
COPY packages/config ./packages/config
COPY packages/shared ./packages/shared
COPY packages/db ./packages/db
COPY packages/auth ./packages/auth
COPY apps/realtime ./apps/realtime
RUN pnpm --filter @syncstudy/db exec prisma generate
RUN pnpm --filter @syncstudy/realtime typecheck

# ── runtime ─────────────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app

# Never run as root. The `node` user ships with the image.
USER node
WORKDIR /app/apps/realtime
EXPOSE 4000

# Matches the Fly health check; a failing Redis or Postgres returns 503.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/health >/dev/null || exit 1

# Fly sends SIGTERM and waits; src/index.ts flushes leader rooms before exiting.
STOPSIGNAL SIGTERM
CMD ["pnpm", "start"]
