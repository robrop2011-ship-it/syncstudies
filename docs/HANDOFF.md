# Handoff — start here

You are picking up SyncStudy mid-build. This document is the entry point: what exists,
what is true about it, what to build next, and the specific things that will waste your
day if nobody tells you.

**Read in this order:**

1. This file, in full. It is short.
2. [`docs/RUNBOOK.md`](./RUNBOOK.md) — get it running before you read any code.
3. [`PLAN.md`](../PLAN.md) — the blueprint. 20 sections. **§8 is the product.**
4. [`docs/ADR/`](./ADR) — five decisions where the obvious choice is wrong. Each exists
   because someone would otherwise "fix" it back and break something quietly.
5. [`docs/BACKLOG.md`](./BACKLOG.md) — everything deliberately not being built yet.

---

## 1. What SyncStudy is

Private study rooms where 2–6 students watch the same YouTube lecture in **sync**, talk
over WebRTC, chat, and keep shared notes pinned to video timestamps. One tab instead of
four apps and manual "ok, pause, 3-2-1".

The whole product rests on one idea, and if you internalise nothing else, internalise
this: **the server stores an anchor, not a position.** Room state is
`{status, anchorPositionSec, anchorServerMs, rate, revision}`, and both sides derive the
current position from the same `positionAt()` function in
`packages/shared/src/video.ts`. There is exactly one implementation of that function in
the codebase, imported by client and server. Two implementations would drift apart and
you would lose a week finding out why.

---

## 2. Ground rules for working here

**PLAN.md is the source of truth. Amend it before amending the architecture.** It has
already been amended once (Amendment A1, at the top) when the product direction changed.
If you make a decision that contradicts it, change the plan in the same commit.

**Run `pnpm build`, not just `pnpm typecheck`.** A whole class of module-resolution error
is invisible to `tsc` and only appears in the bundler (ADR 0002). CI runs both.

**Verify against the running stack, not just the type system.** Several bugs found here —
the room-code oracle, the stale room cache, the ghost memberships, the reconnect that
could never succeed — all typechecked perfectly. The way they were found was running two
socket clients against real Postgres and Redis and watching what actually happened.

**Do not fake unbuilt functionality.** Every unfinished area shows an honest empty state
naming the phase it arrives in. A mock message list or a fake player is worse than
nothing: it makes the gap invisible to the next person and to the user.

**The visual rules in PLAN.md §12 are requirements, not taste.** The user explicitly asked
that this not look AI-generated. That means: 1px borders instead of shadows, one accent
colour used only for the primary action, no gradients on surfaces, no glow, no
backdrop-blur, motion capped at 160ms on opacity/transform only, no shimmer or pulse,
Lucide icons instead of emoji, no rounded-full buttons. There is a grep-able audit in
§7 below.

---

## 3. Current state

| Phase | Status |
|---|---|
| 1 — Foundation | **Done.** pnpm monorepo, strict TS, CI, Docker + no-Docker dev paths |
| 2 — Accounts | **Done and verified against real Postgres.** Username + password, no email (ADR 0001), one-time recovery codes, sessions, profile/privacy/account settings |
| 3 — Rooms | **Done and verified end to end.** Rooms REST API, room page, client socket layer, `ServerClock`, presence, host controls |
| 4 — Video sync | **See §4.** |
| 5 — Chat | Not started. Socket handlers registered, guarded and rate-limited; they ack `not_implemented` |
| 6 — Voice/WebRTC | Not started. coturn config written and hardened; `rtc:*` handlers ack `not_implemented` |
| 7 — Study tools | Not started. Schema exists |
| 8 — UI polish | Partial. Auth and room surfaces are done to §12; no full a11y or visual-regression pass |
| 9 — Hardening | Partial. Rate limits, CSP, authorization done; **no integration tests, no E2E, no load test** |
| 10 — Deploy | Not started. `infra/fly.realtime.toml` written; nothing deployed |

**The whole server half of video sync was built in Phase 3** and is tested:
`packages/shared/src/video.ts`, `apps/realtime/src/handlers/video.ts`, and the atomic Lua
transact in `apps/realtime/src/scripts/transactVideo.lua`.

### What a person can actually do today

Sign up, sign in, recover an account with a recovery code, edit their profile and privacy
settings, create a room, share the code, have someone join it, see live presence, and use
host controls (kick, ban, promote, transfer, end room). On desktop and on mobile.

---

## 4. Phase 4 — video synchronization

**Built and verified against a real YouTube video in a real browser.** A host can paste a
link, everyone loads it at the same position, and play/pause/seek propagate.

### What exists

| Piece | File |
|---|---|
| Clock sync (§8.3) | `apps/web/lib/sync/clock.ts` |
| Drift loop (§8.6) | `apps/web/lib/sync/controller.ts` |
| Seek-latency EWMA | `apps/web/lib/sync/seek-latency.ts` |
| YouTube adapter, 7 quirks (§5.3) | `apps/web/lib/sync/players/youtube.ts` |
| Deterministic fake player | `apps/web/lib/sync/players/fake.ts` |
| Embeddability probe | `apps/web/app/api/video/probe/` |
| Player UI, scrubber, autoplay gate | `apps/web/components/room/{VideoStage,PlayerControls,Scrubber,AutoplayGate,SyncStatus,SetVideoForm}.tsx` |
| Simulator (§15.3) | `apps/web/lib/sync/sim/` |

### Verified end to end

**In a real browser**, playing a 3Blue1Brown lecture, with an independent Node socket
client deriving position from the same anchor:

- playback tracked at **effectiveRate 1.000** over an 18s window, status held "In sync"
- spread between the browser and the independent client ~0.5s, at the measurement floor
  of a whole-second UI readout
- a scrubber seek propagated: `revision` 2→3, `anchorPositionSec` 0→423.3
- the probe resolves a real video's title and **rejects `169.254.169.254`** and malformed
  input before any fetch happens

**In the simulator** — §15.3's scenario, six clients, 1800 virtual seconds, 36 000 samples,
seed 7. Latencies 25–220ms with jitter, 2% loss, one clock 2.4s wrong, one 4s ad-break
stall, one 25s outage, one joining at t=900s:

| Metric | Measured | Target |
|---|---|---|
| spreadP50 | **0.138 s** | < 0.25 |
| spreadP95 | **0.255 s** | < 0.60 |
| hard seeks / client / hour | **2.19** | < 4 |
| divergedForever | **false** | false |

`pnpm --filter @syncstudy/web test` runs the whole thing in under 3 seconds. **It is the
regression gate for any change to the sync engine — run it before and after.**

The harness was validated by mutation: flipping the sign in `ServerClock` drives spreadP95
from 0.255 to 4.975 and fails five assertions; stripping the guards from `decideControl`
turns the conflict test's verdict to `'split'`. The clock-skew scenario is deep-equal to
the zero-skew run on every statistic, so the offset arithmetic cancels the skew exactly
rather than approximately.

### Bugs the simulator found (all fixed)

Worth reading, because each was invisible to typecheck, lint, and the browser:

1. **The hard-seek counter measured room activity, not sync failure.** `hardSeekTo()`
   incremented telemetry from all four of its call sites, but only one is §8.6's hard
   band; the rest are ordinary events (someone pressed play, a join, an autoplay tap).
   The tell was that the *same* 15 seeks scored 5.47/h over 1800s and 2.61/h over 3600s —
   a failure rate that halves because you kept watching is not measuring failure. It also
   made the §15.3 gate unpassable and would have alerted on `ss_hard_seeks_total` in
   normal use.
2. **The person who scrubbed ended up permanently behind the room they steered.**
   `applyLocalSeek` was the one seek in the file that did not add the estimated seek
   latency. The server compensates for flight time so the *room* lands on target, but the
   local player then buffers and resumes ~150–450ms late — inside `DEAD_ZONE_SEC`, so
   nothing ever corrected it. Fixing it took that client's driftP95 from 0.298 to 0.057.
3. **Refused autoplay was handled as a broken video.** The adapter reports "the browser
   said no" on the same `error` channel as "this video is embed-denied"; the controller
   treated both as fatal and parked `driftState` at `idle`, so a client whose only problem
   was an autoplay policy would stop correcting forever and silently desync.
4. **Dismissing the autoplay prompt never unmuted.** The player stayed muted with the
   "tap for sound" affordance gone — a silent lecture and no way back.

### Known, and worth your attention

**Cold-start catch-up.** When the host presses play on a freshly loaded video, the server
anchors at that instant, but the YouTube player can take seconds to produce frame one. The
client is then behind by its own startup latency and the ladder seeks it forward — observed
at roughly 20s of gap closing over the first minute, converging cleanly to <1s.

This is the design working, not a bug, but §8.7's `JOIN_LOAD_LEAD_SEC` only compensates on
**join**; the first-play-of-a-cold-video path has no equivalent lead. If early-session
catch-up seeks prove annoying in real use, the fix is a small lead on the play anchor, or
anchoring `play` at the moment the initiator's player actually reports `playing`. Measure
before changing it — the constants are tunable against the simulator, which is exactly what
it is for.

**Not wired:** `video:waiting` (the `wait_for_slow` broadcast) has no UI. The room behaves
correctly — the server's auto-pause arrives as an ordinary anchor — but nobody sees
"Paused — waiting for Sam". Needs a store field plus a line in `SyncStatus`.

---

## 5. What to build next, in order

### 5a. Phase 5 — Chat (4–5 days)

The cheapest remaining win, and independent of everything else. Server handlers are
already registered, authorized and rate-limited in `apps/realtime/src/handlers/chat.ts` —
they just ack `not_implemented`.

- `messages` table already exists, with the uuidv7 + `client_msg_id` unique partial index
  that makes optimistic-send retries idempotent. Use it.
- Broadcast immediately with a server-assigned id and timestamp; enqueue the INSERT
  write-behind. **Never block a broadcast on a DB write** (PLAN §6.5).
- Cursor pagination on uuidv7, virtualized list above 200 messages.
- `@41:12` in a message linkifies to a room seek. Cheap, delightful, and it is the
  feature that makes chat feel like part of the video rather than bolted on.
- **No link unfurls.** SSRF plus phishing-preview surface, for no real gain (§3.5 H5).

### 5b. Phase 6 — Voice calls (8–11 days)

The hardest remaining phase after sync, and the one with real ops attached.

- Mesh P2P only. Enforced caps `MESH_AUDIO_MAX = 8`, `MESH_VIDEO_MAX = 4` — the arithmetic
  is in PLAN §9.1 and the constraint is upload bandwidth and N−1 simultaneous encoders on
  student laptops, not download.
- **Perfect negotiation is mandatory**, not optional. Without it two peers renegotiating
  at the same moment (both enabling camera) hit `InvalidStateError` and the call dies
  silently. Politeness is decided by comparing user ids, so both sides compute it
  independently with no extra round trip.
- TURN credentials are short-lived HMAC, issued per join. **Never ship a static TURN
  username/password to the browser** — anyone with devtools then owns a free relay.
- Deploy coturn before writing the client. `infra/coturn/turnserver.conf` is already
  hardened; the `denied-peer-ip` block is what stops it becoming a proxy into your own
  network.
- Build `MeshTransport` behind the `CallTransport` interface from PLAN §9.7 so the SFU
  swap later is a factory call rather than a rewrite.

### 5c. Phase 7 — Study tools (5–7 days)

Shared notes (block-locked last-write-wins per §8.12, **not** a CRDT yet), timestamped
notes/questions/bookmarks rendered as ticks on the scrubber, and the shared checklist.
The scrubber was built in Phase 4 specifically so these ticks have somewhere to live.

### 5d. Phase 9 — the testing gap (6–8 days)

This is the largest quality risk in the project right now. There are **zero integration
tests and zero E2E tests**. CI already provisions Postgres and Redis service containers,
so these are new files rather than a CI change.

- Integration: Vitest + Testcontainers against real Postgres and Redis, one happy path and
  one rejection path per socket event.
- E2E: Playwright with multiple browser contexts — the sync specs in PLAN §15.4 need two
  real browsers to mean anything.
- Load: the targets are in §15.5.

---

## 6. Things that will waste your day

**The realtime service and the web app are two deploys.** The web app is stateless and can
be serverless. The realtime service must be a long-lived container — it holds WebSocket
connections and per-room state. Never `auto_stop_machines` it.

**Redis is the live truth; Postgres is the durable truth.** Everything in Redis is either
reconstructible from Postgres within 15s or inherently ephemeral. That is deliberate: it
is what lets a cheap Redis tier be acceptable and what makes a Redis outage a degraded
five minutes instead of a total one.

**A durable write that another service caches is only half a write.** Any REST route that
touches `rooms` must invalidate `room:{id}:meta` and `code:{code}` (ADR 0003).

**Identity comes from the session, never from a payload.** A `userId` field in a socket
event or request body is a red flag; every handler reads `socket.data.userId`.

**Every socket handler starts with a permission assertion.** There is one resolver,
`packages/shared/src/permissions.ts`. If you find yourself writing `if (role === 'host')`
in a handler, add a `Permission` instead.

**The login rate limiter is in-process and will lock you out of your own dev
environment** after five scripted logins. Restart `apps/web` to clear it.

**`socket.io-client` in Node drops a `Cookie` set via `extraHeaders` when
`withCredentials: true`.** Test scripts need `withCredentials: false`. Browsers are fine.

**Run two realtime instances locally before trusting multi-node behaviour.** A
single-instance staging environment hides the leader-election and cross-node fan-out bug
class entirely, until launch day.

---

## 7. Verification you should run before any commit

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Design-rule audit (all of these should return 0 real hits — matches inside comments
explaining why a pattern is *avoided* are expected):

```bash
grep -rn 'bg-gradient\|backdrop-blur\|animate-pulse\|shimmer' apps/web/components apps/web/app
grep -rEn 'duration-(2[0-9]{2}|[3-9][0-9]{2})' apps/web/components apps/web/app
grep -rn 'rounded-full' apps/web/components | grep -i button
```

Then, for anything touching rooms, sockets or playback, run it against the live stack
per RUNBOOK §5. **Typechecking is not verification.**

---

## 8. Where things live

```
PLAN.md                        the blueprint — 20 sections, §8 is the product
docs/HANDOFF.md                this file
docs/RUNBOOK.md                dev environment, including the no-Docker path
docs/ADR/                      five decisions where the obvious choice is wrong
docs/BACKLOG.md                deliberately not being built yet

packages/shared/               THE CONTRACT — Zod schemas, typed socket event maps,
                               the authoritative video timeline, all tuning constants
packages/auth/                 argon2id, opaque sessions, recovery codes, handle rules
packages/db/                   Prisma schema + migrations + seed

apps/realtime/                 Fastify + Socket.IO. Rooms, presence, host controls,
                               the authoritative timeline behind an atomic Lua transact
apps/web/                      Next.js 15. Marketing, auth, dashboard, settings, room
  lib/sync/                    clock, player adapter, sync controller, simulator
  lib/socket/                  typed client, provider, connection lifecycle
  lib/stores/                  per-room zustand store (context, not a singleton)

infra/                         docker-compose, hardened coturn, fly.io config
```

Three seams exist specifically so later phases are swaps rather than rewrites. Do not
compromise them: **`RoomStore`** (Redis → anything), **`CallTransport`** (mesh → SFU),
**`PlayerAdapter`** (YouTube → anything).
