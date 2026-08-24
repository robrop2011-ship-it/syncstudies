# SyncStudy

Watch lectures together, in sync. A study room is a YouTube video that stays in step
for everyone in it, plus voice, chat, and shared notes tied to the timestamp you were
at when you wrote them.

This repository is a pnpm workspace monorepo. Everything about the intended design
lives in [`PLAN.md`](./PLAN.md) — it is the contract, not a historical document.
Architecture decisions that changed the plan are in [`docs/ADR/`](./docs/ADR).

---

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node | 22 or newer | `node -v`. Enforced by `engines` in `package.json`. |
| pnpm | 9.15.4 | `corepack enable && corepack prepare --activate` reads it from `packageManager`. |
| Docker | any recent | Runs Postgres, Redis, and coturn locally. Docker Desktop or colima both work. |

No global Postgres, Redis, or Prisma installation is needed. Nothing is installed
outside the repo.

---

## From clone to a running dev environment

```bash
git clone <repo-url> syncstudy
cd syncstudy

# 1. Dependencies for every workspace package, in one pass.
pnpm install

# 2. Environment. The defaults are wired to the Docker services below, so the
#    copies work as-is; you do not have to edit anything to get started.
cp .env.example .env
cp apps/web/.env.example apps/web/.env.local
cp apps/realtime/.env.example apps/realtime/.env

# 3. Postgres 5432, Redis 6379, coturn 3478 — in the background.
pnpm services:up

# 4. Create the schema and generate the Prisma client.
pnpm db:push

# 5. Two users and one room to look at.
pnpm db:seed

# 6. Next.js on :3000 and the realtime service on :4000, together.
pnpm dev
```

Open <http://localhost:3000>.

**Seeded login:** handle `priya`, password `studytogether1` (there is a second
account, `sam`, with the same password — use it in a second browser profile to test
two participants in one room).

When you are finished: `pnpm services:down`. That stops the containers and keeps your
data. To throw the database away and start clean, run
`docker compose -f infra/docker-compose.dev.yml down -v`, then repeat steps 3–5.

### Everyday commands

| Command | What it does |
|---|---|
| `pnpm dev` | Web and realtime together, both with hot reload. |
| `pnpm dev:web` / `pnpm dev:realtime` | One at a time, when you want clean logs. |
| `pnpm typecheck` | `tsc --noEmit` across every package. |
| `pnpm lint` | ESLint across every package that defines a lint script. |
| `pnpm test` | Every suite. |
| `pnpm test:unit` | Only `packages/*` — pure logic, no Docker required. |
| `pnpm db:push` | Sync the Prisma schema into the dev database (no migration file). |
| `pnpm db:migrate` | Create and apply a named migration. Use this once the schema is real. |
| `pnpm db:studio` | Prisma Studio, to look at rows. |
| `pnpm format` | Prettier over the repo. |

### If something is wrong

- **`ECONNREFUSED 127.0.0.1:5432`** — the containers are not up. `pnpm services:up`,
  then `docker compose -f infra/docker-compose.dev.yml ps` and check that `postgres`
  reports `healthy`, not just `running`.
- **`@prisma/client did not initialize yet`** — the generated client is missing. Run
  `pnpm db:generate`. This also happens after a fresh clone if you skip step 4.
- **Port 5432 or 6379 already taken** by a local Postgres or Redis — create
  `infra/.env` with `POSTGRES_PORT=5433` (or `REDIS_PORT=6380`) and update the
  matching URL in your `.env` files.

---

## What is in the repo

```
apps/web        Next.js 15 (App Router). Marketing page, auth pages, dashboard,
                settings, and the room page. Owns all REST route handlers.
apps/realtime   Fastify + Socket.IO. Owns the authoritative room state, the video
                timeline, presence, and WebRTC signalling. Stateless; all room state
                lives in Redis with a write-behind snapshot to Postgres.

packages/shared The contract. Event names, Zod schemas, shared TypeScript types, the
                tuning constants, id/room-code generation, the permission resolver,
                and — most importantly — the one implementation of the video timeline
                (`positionAt`, `applyControl`, `decideControl`). Both the client and
                the server import it from here. Two implementations would drift and
                finding out why costs a week.
packages/db     Prisma schema, the singleton client, and the seed script.
packages/auth   argon2id password hashing, opaque session tokens, handle rules, and
                recovery codes. Framework-free on purpose: the socket handshake calls
                `getSessionFromCookieHeader()` with a raw header string and no
                request object.
packages/config Shared `tsconfig.base.json`.

infra/          docker-compose for local Postgres/Redis/coturn, the hardened coturn
                config, and the Fly.io config for the realtime service.
docs/           ADRs and the backlog of things deliberately not being built yet.
```

Workspace packages are consumed as **TypeScript source** — each `package.json` points
`main` at `src/index.ts` — so there is no build step between them and no stale `dist`
to debug. Import them as `@syncstudy/shared`, `@syncstudy/auth`, `@syncstudy/db`.

TypeScript is strict everywhere, including `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`. Both flags change how you write code: indexing an array
gives you `T | undefined`, and an optional property declared `x?: string` will not
accept an explicit `undefined` unless it is declared `x?: string | undefined`.

---

## How the sync engine works

The server never stores "where the video is". It stores an **anchor**: a position, the
server timestamp at which that position was true, a status, and a playback rate. While
a room is playing, the current position is a pure function of wall-clock time —
`positionAt(anchor, serverNow)` — so there is nothing to keep updating and nothing to
broadcast on a timer. Each client measures its own offset from the server clock with a
short burst of NTP-style ping samples, then runs a 2 Hz loop comparing its player's
position against the anchor: inside a 0.35 s dead zone it does nothing, in the middle
band it micro-seeks, and only past 2 s does it hard-seek. Controls are optimistic
locally and carry the revision the client believed was current, so two people scrubbing
at the same moment cannot both apply — one is serialized first and the other is told
`stale_revision` and re-syncs rather than retrying a stale intent.

The full derivation, the deliberate asymmetry between play/pause/seek, the drift
ladder, the join and reconnect paths, and the numbers to tune are in
**[PLAN.md §8](./PLAN.md)**. Read that section before changing anything in
`packages/shared/src/video.ts`.

---

## What is NOT built yet

This is a partially built repository. The list below is accurate as of the current
commit; do not assume a feature exists because the plan describes it.

**In the repository today:** Phase 1 (workspace, tooling, CI) and Phase 2 (accounts,
sessions, recovery codes, profile and settings pages) are complete. Phase 3 is
**partially** landed: the realtime service implements room join/leave/resync,
presence, host controls and the authoritative video timeline, but there is no room
page and no rooms REST API yet — the dashboard reads Postgres directly.

**Not implemented yet.** This table is the authoritative statement of what is missing:

| Area | Phase in PLAN.md §14 | Status |
|---|---|---|
| Room page (`/r/[code]`) and room creation UI | Phase 3 | **Not started.** The dashboard already links to `/r/{code}` and `/rooms/new`; both are 404 today. |
| Rooms REST API (create / list / preview / join / patch / delete) | Phase 3 | **Not started.** `app/(app)/dashboard/page.tsx` queries Prisma directly in the meantime. |
| Synchronized video playback — client half | Phase 4 | **Client not started.** The server half is done: `packages/shared/src/video.ts` (unit-tested), `apps/realtime/src/handlers/video.ts`, and the Redis transact in `apps/realtime/src/scripts/transactVideo.lua`. What is missing is the browser side — the `PlayerAdapter`, the clock sync, and the drift loop. |
| Chat | Phase 5 | Not started. Schema and event types exist and the `chat:*` events are registered and guarded, but they ack `not_implemented`. No UI. |
| Voice calls and WebRTC | Phase 6 | Not started. coturn is configured and runs locally, and the `rtc:*` events are registered and rate-limited, but they ack `not_implemented` — no signalling relay and no peer connections. |
| Shared notes, questions, checklist | Phase 7 | Not started. |
| The sync simulator (PLAN.md §15.3) | Phase 4 | Not started. This is the highest-leverage test asset in the project and should be built with the sync engine, not after it. |
| Integration tests (Testcontainers) and E2E (Playwright) | Phases 3–9 | Not started. CI already runs Postgres and Redis service containers so these are a new file, not a CI change. |
| Deployment to Vercel/Fly/Neon/Upstash | Phase 10 | Config is written (`infra/fly.realtime.toml`); nothing is deployed. |

Anything in [`docs/BACKLOG.md`](./docs/BACKLOG.md) is out of scope until the MVP in
PLAN.md §13 has shipped.

---

## Tests

```bash
pnpm test:unit     # packages/shared and packages/auth — no database, no network
pnpm test          # everything
```

The unit suites cover the parts where a bug is expensive and invisible: the video
timeline and its asymmetries, control conflict resolution, YouTube URL parsing, room
and recovery code generation, timestamp formatting, the permission resolver, password
and handle rules, recovery-code verification, and cookie parsing. The argon2 tests are
intentionally slow — the hashing parameters are the OWASP baseline and are not weakened
for the test suite; the vitest timeout is raised instead.

---

## Design rules

The interface is flat, bordered, and quiet: 1px borders rather than shadows, one accent
colour used only for the primary action and focus rings, no gradients on surfaces, no
glow, motion limited to 120–160 ms opacity and transform transitions, Inter at
12/13/14/16/20/28, lucide icons at 16px/1.5 stroke, and never an emoji in UI chrome.
The enforceable version of that list, including the explicit "don't do this" list, is
PLAN.md §12.
