# syntax=docker/dockerfile:1
#
# Web application image (PLAN.md §16.3).
#
# Build context is the REPO ROOT, not this directory — the app consumes the
# workspace packages as TypeScript source, so it needs them present.
#
#   docker build -f apps/web/Dockerfile .
#
# Deliberately mirrors apps/realtime/Dockerfile: same base, same layer order, so
# a fix applied to one is obvious to apply to the other. Only the four workspace
# packages this app imports are copied — pulling in apps/realtime would rebuild
# this image on every backend commit.
#
# There is no `output: 'standalone'`. next.config.ts already carries
# `outputFileTracingIncludes` for Prisma's query engine, which exists for
# Vercel's tracer; in a container the whole workspace is present anyway, so the
# runtime stage keeps node_modules and runs `next start` directly. One less
# mechanism to get wrong.

FROM node:22-alpine AS base
# Prisma's query engine needs OpenSSL on Alpine. Without it the image builds,
# deploys, and fails on the first database call with "could not locate the
# query engine" — long after the deploy reported success.
RUN apk add --no-cache openssl
RUN corepack enable
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

# ── dependencies ────────────────────────────────────────────────────────────
# Manifests only, so a source-only change reuses this layer.
#
# devDependencies are installed on purpose: `next build` needs typescript,
# tailwind and the eslint config. NODE_ENV is therefore NOT set to production
# until after this step — setting it earlier makes pnpm skip devDependencies and
# the build fails on a missing compiler.
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages/config/package.json ./packages/config/
COPY packages/shared/package.json ./packages/shared/
COPY packages/db/package.json ./packages/db/
COPY packages/auth/package.json ./packages/auth/
COPY apps/web/package.json ./apps/web/
RUN pnpm install --frozen-lockfile --filter @syncstudy/web...

# ── build ───────────────────────────────────────────────────────────────────
FROM deps AS build
COPY packages/config ./packages/config
COPY packages/shared ./packages/shared
COPY packages/db ./packages/db
COPY packages/auth ./packages/auth
COPY apps/web ./apps/web

# The client must exist before `next build`, which typechecks route handlers
# that import it through @syncstudy/db.
RUN pnpm --filter @syncstudy/db exec prisma generate

# NEXT_PUBLIC_* IS INLINED INTO THE BROWSER BUNDLE HERE, at build time.
#
# Supplying these only as runtime environment does nothing at all: the deploy
# succeeds, the marketing page renders, and the room says "Offline" forever,
# because the compiled bundle holds whatever was present during this step.
# Changing one later is a rebuild, not a restart.
#
# NEXT_PUBLIC_REALTIME_URL is doubly load-bearing: next.config.ts derives the
# CSP `connect-src` from it. Wrong value and the browser blocks the socket with
# a console error and no server-side symptom whatsoever.
ARG NEXT_PUBLIC_REALTIME_URL
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_AVATAR_BASE_URL=""
ENV NEXT_PUBLIC_REALTIME_URL=$NEXT_PUBLIC_REALTIME_URL
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_AVATAR_BASE_URL=$NEXT_PUBLIC_AVATAR_BASE_URL
ENV NODE_ENV=production

RUN pnpm --filter @syncstudy/web build

# ── runtime ─────────────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app

# Never run as root. The `node` user ships with the image.
USER node
WORKDIR /app/apps/web

# `next start` reads PORT from the environment. Railway, Render and Fly all
# inject their own; this default is what `docker run` with no -e gets.
ENV PORT=3000
EXPOSE 3000

STOPSIGNAL SIGTERM
CMD ["pnpm", "start"]
