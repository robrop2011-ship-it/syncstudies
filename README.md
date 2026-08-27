# SyncStudy

Watch lectures together, in sync. A study room is a YouTube video that stays in step
for everyone in it, plus voice, chat, and shared notes tied to the timestamp you were
at when you wrote them.

This repository is a pnpm workspace monorepo. Everything about the intended design
lives in [`PLAN.md`](./PLAN.md) — it is the contract, not a historical document.
Architecture decisions that changed the plan are in [`docs/ADR/`](./docs/ADR).

**Picking this up mid-build? Read [`docs/HANDOFF.md`](./docs/HANDOFF.md) first.** It is
short, it says what is actually true about the code today rather than what was intended,
and it lists the specific things that will otherwise waste your day.

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
- **"Too many sign-in attempts"** when you have barely tried — the login limiter is 5 per
  15 minutes per handle and is **in-process**, so scripted logins lock you out of your own
  dev environment. Restart `apps/web` to clear it.
- **A room says it has ended but people are still in it** — the realtime service's room
  cache was not invalidated. See [ADR 0003](./docs/ADR/0003-redis-in-the-web-tier.md).
- **Every API route returns a plain-text `Internal Server Error`** — you ran `pnpm build`
  while `next dev` was running and it rewrote `.next/` underneath it.
  `rm -rf apps/web/.next` and restart.

More, with the reasoning, in [`docs/RUNBOOK.md`](./docs/RUNBOOK.md) §6.

---

## What is in the repo

```
apps/web        Next.js 15 (App Router). Marketing page, auth pages, dashboard,
                settings, and the room page. Owns all REST route handlers.
                  lib/sync/  clock, YouTube adapter, drift loop, the §15.3 simulator
                  lib/ink/   ephemeral annotation: batching, ageing, canvas + rAF
                  lib/call/  the WebRTC mesh transport
                  lib/socket/, lib/stores/  typed client and the per-room store
apps/realtime   Fastify + Socket.IO. Owns the authoritative room state, the video
                timeline, presence, chat, WebRTC signalling and the ink relay.
                Stateless; all room state lives in Redis with a write-behind
                snapshot to Postgres.
                  chat/      the write-behind queue, message send/dedupe, system lines
                  rooms/     RoomStore, leader election, snapshotter, cross-node bus
                  handlers/  one file per event family; context.ts holds the guard
                             every handler starts with

packages/shared The contract. Event names, Zod schemas, shared TypeScript types, the
                tuning constants, id/room-code generation, the permission resolver,
                and — most importantly — the one implementation of the video timeline
                (`positionAt`, `applyControl`, `decideControl`). Both the client and
                the server import it from here. Two implementations would drift and
                finding out why costs a week.
packages/db     Prisma schema, the singleton client, the seed script, and the one
                `messages` row → `MessageView` mapping — it lives here because both
                services read that table and two mappings would be two chances for a
                deleted message's body to escape.
packages/auth   argon2id password hashing, opaque session tokens, handle rules, and
                recovery codes. Framework-free on purpose: the socket handshake calls
                `getSessionFromCookieHeader()` with a raw header string and no
                request object.
packages/config Shared `tsconfig.base.json`.

infra/          docker-compose for local Postgres/Redis/coturn, the hardened coturn
                config, and the Fly.io config for the realtime service.
docs/           HANDOFF.md (start here), RUNBOOK.md (get it running), ADR/ (eight
                decisions where the obvious choice is wrong), BACKLOG.md.
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

## How chat works

Three properties, and each one is a decision rather than an implementation detail.

**A broadcast never waits for Postgres.** A message is assigned a uuidv7 and a server
timestamp, fanned out to the room, and *then* queued for insertion — 2 ms to the ack, 7 ms
to the row, measured against PLAN §6.5's budget of 10 ms and 2 s. The consequence is the
part worth knowing: for a few hundred milliseconds a message everyone can see does not
exist in the database, so every path that reads one back — a delete, a report, a join
snapshot — has to account for that. Two features shipped broken because of it and both of
their tests passed. See **[ADR 0006](./docs/ADR/0006-chat-is-broadcast-first.md)**.

**Retries are idempotent, across nodes.** An optimistic send carries a `client_msg_id`.
The server remembers, in Redis for two minutes, which message that id already produced, so
a retry after a reconnect re-acks the original instead of posting a second copy — and it is
in Redis rather than in process memory precisely because a reconnect is when the client
lands on a different node. A unique index on `(room_id, user_id, client_msg_id)` is the
backstop underneath it.

**Ordering is by `id`, never by `created_at`.** Ids are uuidv7, so id order is time order
— and unlike a timestamp it is a *total* order, identical on every client, with no ties to
break. That single property gives correct pagination cursors, a correct reconnect backfill
cursor, and one identical transcript on every screen. See
**[ADR 0007](./docs/ADR/0007-order-messages-by-id.md)**.

What the reader sees: history that survives a reload, `@41:12` timestamps anyone with
playback permission can click to move the whole room, links rendered as text with a real
anchor and **no unfurl of any kind**, known link-logger domains shown but not clickable,
delete-your-own / host-deletes-any as tombstones rather than gaps, and reports that freeze
a copy of the message so deleting it does not destroy the evidence.

---

## How ink works

Ink is the one feature in the app with **no durable write at all**. It is worth
understanding as the counter-example to everything else here.

A pointer moves at up to 120 Hz. Those points are buffered and flushed on a 50 ms timer, so
a drawing user sends about 20 small messages a second, each carrying only the points added
since the last flush — appended by stroke id on the receiving side, never the whole stroke
again. The server validates, checks the `annotate` permission and the room's
`annotations_enabled` policy, stamps a server timestamp, and relays to everyone except the
sender. It keeps nothing. There is no ack, because an ack per batch at 20 Hz is pure
overhead and a stroke that goes missing was a gesture nobody saw.

Rendering is a canvas and a `requestAnimationFrame` loop that **stops itself when there is
no ink** and restarts on the next stroke. React state is never touched per point or per
frame — a `setState` on the hot path re-renders the room and stutters the player on the
low-end laptops this product is for (§5.4).

Each stroke is opaque for `INK_HOLD_MS`, ramps to nothing over `INK_FADE_MS`, and is then
deleted. It ages against **server** time, so the same stroke dies at the same instant on
every screen rather than lingering on whichever machine has the slower clock.

Two things in there look like mistakes and are not. Coordinates are 0..1 against the
**picture** — the centred 16:9 rect inside the stage box — and not against the box itself,
which is not reliably 16:9. And when the active-stroke table is full, eviction takes the
*arriving author's* oldest stroke rather than the room's, so a client flooding stroke ids
can only ever cost itself. Both are [ADR 0008](./docs/ADR/0008-ink-is-ephemeral.md).


## What is and is not built

The list below is accurate as of the current commit; do not assume a feature exists
because the plan describes it.

**All ten phases of PLAN.md §14 are implemented.** You can sign up, create a room, share
the code, and have people join it. You can paste a YouTube link and watch it **in sync** —
play, pause and seek propagate, late joiners land in the right place, and a client that
falls behind is corrected automatically. You can talk about it in chat, with history that
survives a reload and `@41:12` timestamps anyone can click to take the whole room there.
You can join a voice call with camera and screen sharing. And you can keep shared notes
that several people edit at once, pin a question to the second you were confused by, and
tick off a shared checklist. And you can **draw over the video** — everyone sees the stroke
as you make it, and it fades away a few seconds later. On desktop and on mobile.

| Area | Phase | Status |
|---|---|---|
| Synchronized video playback | 4 | **Done.** Measured against the §15.3 simulator: spread p50 0.138s / p95 0.255s, 2.19 hard seeks per client-hour, no permanent divergence. |
| Chat | 5 | **Done.** History with cursor pagination, optimistic send with retry, `@mm:ss` linkification, moderation, reports with a frozen snapshot. |
| Voice, camera and screen sharing | 6 | **Done.** Full-mesh P2P with perfect negotiation, short-lived HMAC TURN credentials, the §9.5 reconnection ladder, Opus DTX, voice-activity detection, video ducking and push-to-talk. Signalling is verified by 17 integration tests; **real media between two browsers has not been verified here** — see below. |
| Shared notes, questions, checklist | 7 | **Done.** Block-locked concurrent editing where a conflict duplicates a paragraph rather than losing one, questions pinned to a timestamp and rendered as clickable ticks on the scrubber, and an attributed shared checklist. |
| Ephemeral shared ink | — | **Done.** Draw over the video with a pointer or a finger; strokes fan out live and fade after a few seconds. Nothing is stored — no table, no Redis key, no replay ([ADR 0008](./docs/ADR/0008-ink-is-ephemeral.md)). Host can switch it off per room. Verified against a live second participant: coordinates matched to four decimals. |
| UI/UX, responsive, onboarding | 8 | **Done.** Keyboard shortcuts with a sheet, a three-step coach-mark for a first-time host, legal pages, honest empty states, responsive to 375px. |
| Hardening and testing | 9 | **Done.** 77 integration tests against real Postgres and Redis, in CI. Security headers complete. Load test run — 7 of 8 §15.5 targets met. |
| Deployment | 10 | **Configured.** [`docs/VERCEL.md`](./docs/VERCEL.md) is a twenty-minute path to a personal test deployment; [`docs/DEPLOY.md`](./docs/DEPLOY.md) is the production architecture. `vercel.json`, `render.yaml`, `infra/fly.realtime.toml` and `apps/realtime/Dockerfile` are all written. Nothing is deployed from this repository — that needs accounts. |
| Avatar upload | 2 | **Not built.** The read path and the generated fallback avatar exist; the upload needs a Cloudflare R2 bucket. See [`docs/HANDOFF.md`](./docs/HANDOFF.md) §10. |

**What has not been verified from here**, stated plainly rather than left to be found:
real WebRTC media flowing between two browsers (needs two contexts with fake media
devices — the §15.4 Playwright suite), a relayed TURN connection (needs a deployed
coturn), axe-core in CI, and the §15.6 browser matrix beyond one Chromium-based browser.
[`docs/HANDOFF.md`](./docs/HANDOFF.md) §10 has the full list with reasons.

Anything in [`docs/BACKLOG.md`](./docs/BACKLOG.md) is out of scope until the MVP in
PLAN.md §13 has shipped.

### Deploying

**Vercel hosts half of this app.** `apps/web` is stateless and fits it exactly.
`apps/realtime` does not and cannot — it holds long-lived WebSockets and per-room state,
which a serverless function has no way to do. Deploy only to Vercel and you get a site
where you can sign up and create a room, and where opening that room says "Can't reach the
realtime server": video sync, chat, voice and notes all live on the socket.

[`docs/VERCEL.md`](./docs/VERCEL.md) is the two-service walkthrough — Vercel plus one
container host, Neon and Upstash — with the chicken-and-egg between `ALLOWED_ORIGINS` and
`NEXT_PUBLIC_REALTIME_URL` spelled out, because it catches everyone once.

---

## Tests

```bash
pnpm test:unit     # packages/shared and packages/auth — no database, no network
pnpm test          # everything
```

412 unit tests across four suites, covering the parts where a bug is expensive and invisible:
the video timeline and its asymmetries, control conflict resolution, YouTube URL parsing,
the chat message tokenizer (what may become a clickable link, and what may not), room and
recovery code generation, timestamp formatting, the permission resolver, password and
handle rules, recovery-code verification, and cookie parsing. The argon2 tests are
intentionally slow — the hashing parameters are the OWASP baseline and are not weakened
for the test suite; the vitest timeout is raised instead.

**The sync simulator is the regression gate for the sync engine.** `pnpm --filter
@syncstudy/web test` runs PLAN §15.3's scenario — six virtual clients, 1800 virtual
seconds, 36 000 samples, injected latency, loss, clock skew, an ad-break stall, an outage
and a late join — in under three seconds, and asserts the spread targets. Run it before and
after any change under `lib/sync/`.

### Integration tests

```bash
pnpm --filter @syncstudy/realtime test:integration
```

**77 tests against real Postgres and real Redis**, also run in CI. They boot the real
realtime server on an ephemeral port and drive real sockets through it: joins, bans,
capacity races, host transfer, chat ordering and dedupe, the atomic video transact under
concurrent seeks, WebRTC signalling authorization and the mesh caps, and the shared-notes
conflict rule.

They exist because an entire class of bug is invisible to the unit suite — stale caches,
ghost memberships, cross-node fan-out, read-after-write races against the chat queue —
and every one of those this project has actually shipped typechecked, linted and built
cleanly first.

**No test in that suite sleeps before an assertion.** A test that gives the system a
moment to catch up passes against exactly the broken code it was written to catch; two
shipped features were broken this way. See [ADR 0006](./docs/ADR/0006-chat-is-broadcast-first.md).

That suite found a real bug on its first run: two `uuidv7` values minted in the same
millisecond sorted arbitrarily against each other, which is the exact property the chat
transcript's ordering rests on ([ADR 0007](./docs/ADR/0007-order-messages-by-id.md)).

### Load test

```bash
cd apps/realtime
MAX_CONNECTIONS_PER_IP=2000 pnpm --filter @syncstudy/realtime dev   # in another terminal
npx tsx --env-file=.env scripts/load-test.mjs --sockets 500 --rooms 60 --seconds 45
```

500 sockets across 60 rooms: event-loop lag p99 11.4 ms, RSS 262 MB, broadcast p95 24 ms,
zero messages dropped, and 200 simultaneous joins to a room capped at 12 admitting exactly
12. The one §15.5 target not met is the Lua transact p99, measured on a laptop that was
also running the load generator — see [`docs/HANDOFF.md`](./docs/HANDOFF.md) §6d.

---

## Design rules

The interface is flat, bordered, and quiet: 1px borders rather than shadows, one accent
colour used only for the primary action and focus rings, no gradients on surfaces, no
glow, motion limited to 120–160 ms opacity and transform transitions, Inter at
12/13/14/16/20/28, lucide icons at 16px/1.5 stroke, and never an emoji in UI chrome.
The enforceable version of that list, including the explicit "don't do this" list, is
PLAN.md §12. These are requirements, not preferences — the brief was explicitly that this
must not look AI-generated.

Two rules are worth restating because they are easy to violate while being helpful:

- **State is never carried by colour alone** (§12.6). Every state that has a coloured dot
  also has a word next to it, and an `aria-label` that says the same thing in a sentence.
- **Never fake unbuilt functionality.** An unfinished area shows an honest empty state
  saying what goes there. A mock message list or a placeholder player is worse than
  nothing: it hides the gap from the next person and from the user.

Three greps that should return no real hits (matches inside comments explaining why a
pattern is *avoided* are expected, and there are two):

```bash
grep -rn 'bg-gradient\|backdrop-blur\|animate-pulse\|shimmer' apps/web/components apps/web/app
grep -rEn 'duration-(2[0-9]{2}|[3-9][0-9]{2})' apps/web/components apps/web/app
grep -rn 'rounded-full' apps/web/components | grep -i button
```
