# Handoff — start here

You are picking up SyncStudy mid-build. This document is the entry point: what exists,
what is true about it, what to build next, and the specific things that will waste your
day if nobody tells you.

**Read in this order:**

1. This file, in full. It is short.
2. [`docs/RUNBOOK.md`](./RUNBOOK.md) — get it running before you read any code.
3. [`PLAN.md`](../PLAN.md) — the blueprint. 20 sections. **§8 is the product.**
4. [`docs/ADR/`](./ADR) — seven decisions where the obvious choice is wrong. Each exists
   because someone would otherwise "fix" it back and break something quietly.
   [`docs/ADR/README.md`](./ADR/README.md) is a one-line index of all seven; **0006 and
   0007 are the two you need before you touch chat.**
5. [`docs/BACKLOG.md`](./BACKLOG.md) — everything deliberately not being built yet.

**§10 is the short list of things Phases 1–4 left open.** All four are blocked on
credentials or accounts rather than on code; read it before you assume something is
missing by accident.

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

**Verify against the running stack, not just the type system.** Every serious bug found in
this project — the room-code oracle, the stale room cache, the ghost memberships, the
reconnect that could never succeed, the hard-seek counter that measured the wrong thing,
the two chat read-after-write races — typechecked perfectly. The way they were found was
running real clients against real Postgres and Redis and watching what actually happened.

**A test that sleeps before asserting is a test that will pass against broken code.** Two
Phase 5 features shipped broken with green tests for exactly this reason. If you are
testing that something you just wrote can be read back, do not give the system time to
catch up first — that time is the bug.

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
| 4 — Video sync | **Done, measured, and verified in a browser.** See §4 for the numbers |
| 5 — Chat | **Done and verified against real Postgres and Redis.** See §5 |
| 6 — Voice/WebRTC | **Done.** Mesh P2P, perfect negotiation, TURN credential minting, screen share, ducking, PTT. Server half verified against the live stack (30 checks) and by 17 integration tests. **Real media has not been verified between two browsers** — see §11 |
| 7 — Study tools | **Done and verified.** Block-locked shared notes, timestamped questions with scrubber ticks, shared checklist. 43 live-stack checks, 16 integration tests, and a browser pass |
| 8 — UI polish | **Done.** Shortcut sheet, onboarding coach-marks, legal pages, responsive to 375px, honest empty states everywhere. **No axe-core in CI and no visual-regression snapshots** — see §11 |
| 9 — Hardening | **Done.** 77 integration tests against real Postgres and Redis, in CI. HSTS added, `connect-src` narrowed to the realtime origin. Load test written and run: 7 of 8 §15.5 targets met — see §6 |
| 10 — Deploy | **Prepared, not deployed.** Dockerfile, Fly config, `docs/DEPLOY.md`, `SECURITY.md`, moderation runbook, in-room feedback capture. Deploying needs accounts this repo does not have |

**The whole server half of video sync was built in Phase 3** and is tested:
`packages/shared/src/video.ts`, `apps/realtime/src/handlers/video.ts`, and the atomic Lua
transact in `apps/realtime/src/scripts/transactVideo.lua`.

**"Not started" here means genuinely nothing runs**, but never that nothing is prepared.
Every unbuilt event family is registered, authenticated, permission-checked and
rate-limited, and acks `not_implemented` — a client that calls one gets a straight answer
instead of hanging on a callback that never fires. Filling one in is a body, not a wiring
job.

### What a person can actually do today

Sign up, sign in, recover an account with a recovery code, edit their profile and privacy
settings, create a room, share the code, have someone join it, see live presence, use
host controls (kick, ban, promote, transfer, end room), watch a YouTube lecture in sync,
talk about it in chat — including clicking a `@41:12` to take the whole room there —
join a voice call with camera and screen sharing, write in a shared document that other
people are editing at the same time, pin a question to 41:12 and click its tick to bring
the room back, and keep a shared checklist. On desktop and on mobile.

**Not yet:** avatar upload (see §10). Everything else in PLAN §13.2's MVP scope is built.

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

**`video:waiting` is now wired** (it was the last open Phase 4 item). The server's
auto-pause reaches the client as `waiting` in the room store, a "Waiting for Sam" state
in `SyncStatus`, and a "Paused — waiting for Sam" line in the transcript, which is what
§8.10 asked for. The client mirrors the server's 10 s cap locally, so a lost clearing
broadcast leaves a stale label for at most as long as the server would have waited anyway.
Verified end to end against the live stack — see §5.

---

## 5. Phase 5 — chat

**Built and verified against real Postgres and Redis**, with two socket clients and in a
real browser.

### What exists

| Piece | File |
|---|---|
| Write-behind queue (§6.5) | `apps/realtime/src/chat/writeBehind.ts` |
| Send, dedupe, system lines | `apps/realtime/src/chat/service.ts` |
| Table reads + tombstones | `apps/realtime/src/chat/messages.ts` |
| Row → view, shared by both services | `packages/db/src/messages.ts` |
| Handlers (send / delete / typing) | `apps/realtime/src/handlers/chat.ts` |
| Cursor pagination | `apps/web/app/api/rooms/[room]/messages/route.ts` |
| Reports + frozen snapshot | `apps/web/app/api/reports/route.ts` |
| Tokenizer (links, `@mm:ss`, blocklist) | `apps/web/lib/chat/{linkify,blocklist}.ts` |
| UI | `apps/web/components/room/chat/` |

### The three decisions worth knowing

**1. A broadcast never waits for Postgres.** `ChatService.deliver()` assigns a uuidv7 and a
server timestamp, emits to the room, and *then* queues the INSERT. Measured on the live
stack: ack in **2 ms**, row in Postgres in **7 ms**, against §6.5's budget of 10 ms and 2 s.
`ss_write_behind_depth` is the metric that tells you the queue is losing; `/health` reports
`pendingWrites` for the same reason. On SIGTERM the queue is drained before Prisma
disconnects — an unwritten message is the one piece of state in this system that is
reconstructible from nowhere.

**2. Dedupe is in Redis, not in memory.** `clientMsgId` → the `MessageView` it already
produced, for two minutes. The retry that needs this is the one that follows a reconnect,
and a reconnect is exactly when the client lands on a *different node*, so an in-process map
would miss the only case it exists for. A retry re-acks the original message and broadcasts
nothing; verified, including that Postgres ends up with exactly one row.

**3. Ordering is by `id`, never by `created_at`.** Ids are uuidv7, so id order is time
order — and unlike a timestamp it is a *total* order, identical on every client, with no
ties to break. The same property makes `id < cursor` a correct pagination cursor and makes
"newest message I hold" a valid backfill cursor.

Decisions 1 and 3 are written up as [ADR 0006](./ADR/0006-chat-is-broadcast-first.md) and
[ADR 0007](./ADR/0007-order-messages-by-id.md), because both look like something a
reasonable person would simplify.

### Verified end to end

**61 checks against real Postgres and Redis**, with two socket clients, plus a browser
pass. The ones worth knowing passed:

| What | Result |
|---|---|
| Ack latency / row in Postgres | **2 ms** / **7 ms** (§6.5 budget: 10 ms, 2 s) |
| Retry with the same `clientMsgId` | re-acks the **original** id, broadcasts nothing, exactly **one** row |
| Identical body 3× in 30 s | first two pass, third refused `duplicate` (§11.6) |
| Reconnect with `lastMessageId` | backfill contains everything missed, excludes what was held |
| Pagination | 50 per page, strictly older, oldest-first, no overlap; bad cursor is a 400 |
| Delete | tombstone kept, body retained for review, **API never returns a deleted body** |
| A member deleting the host's message | refused (§11.2 `canActOn`) |
| Report, then delete the message | snapshot survives; a report for a non-existent id is still 201 |
| Locked chat | member refused `chat_locked`, host still sends |
| History for a room you are not in | 404, same as a room that does not exist |
| `userId` in a `chat:send` payload | ignored — identity comes from the session |

**In a real browser**, a message containing `<script>alert(1)</script>`, a Wikipedia link
and `https://grabify.link/x` rendered as: the script tag **escaped to text with zero
`<script>` elements in the DOM**, the Wikipedia link as an `<a>` carrying
`rel="noopener noreferrer nofollow" target="_blank"`, and the grabify host as
non-clickable text with a warning and a screen-reader explanation. The unread badge
counted two arriving messages and ignored the accompanying "Sam joined" system line.

Separately, **13 checks for §8.10 `wait_for_slow`**: the room auto-pauses with no actor,
`video:waiting` names a person rather than a uuid, the deadline is inside the 10 s cap, and
an empty `waitingFor` clears it when the slow client recovers.

### Bugs the live-stack run found (both fixed)

Both typechecked, linted and built cleanly, and both were invisible to a test that slept
before asserting:

1. **You could not delete a message you had just sent.** `chat:delete` reads Postgres;
   the message was still in the write-behind queue, so the server answered "That message no
   longer exists." Fixed by draining this node's queue before the lookup, plus one short
   retry for the cross-node case. The test that found it now has its sleeps deliberately
   removed, with a comment saying why.
2. **A report filed immediately had no evidence attached.** `POST /api/reports` freezes a
   copy of the message (§11.6) by reading Postgres — from the *web* process, which has no
   queue to drain. The reports that matter most are the ones filed the second something
   abusive appears, and those were exactly the ones arriving with a null snapshot. Fixed
   with a short bounded retry.

### Known, and worth your attention

**The cross-node write-behind window.** A joiner's snapshot reads Postgres after draining
*this* node's queue. A message broadcast by another node in the preceding ~250 ms is in
that node's queue, not the database. It cannot be lost or reordered — the socket joins the
room channel before the snapshot is built, and the client dedupes by id — but a joiner can
miss one message until they reload. Closing it entirely means a Redis list of recent
messages, which is a new key in §7.3 and more machinery than a 250 ms window deserves.
Measure before building it.

**Typing indicators are server-only.** `chat:typing` broadcasts correctly; no client
renders it, because the indicator is v1.1 (§3.5 H9, and the backlog). Do not "finish" it
without moving it out of the backlog first.

**Replies are validated but unused.** `replyToId` is in the schema and the column exists,
so `chat:send` verifies the target is in the same room rather than ignoring it. No client
sends one — replies are v1.1 (§3.5 H7).

---

## 6. Phases 6-10: what was built, and what it was measured against

### 6a. Phase 6 — voice calls

| Piece | File |
|---|---|
| TURN credential minting (§9.3) | `apps/realtime/src/rtc/turn.ts` |
| Signaling relay, caps, screenshare lock | `apps/realtime/src/handlers/rtc.ts` |
| `CallTransport` seam (§9.7) | `apps/web/lib/call/types.ts` |
| `MeshTransport` — perfect negotiation, trickle ICE, the §9.5 ladder | `apps/web/lib/call/mesh.ts` |
| Device acquisition and its failure copy | `apps/web/lib/call/media.ts` |
| Opus DTX/mono/FEC munge | `apps/web/lib/call/sdp.ts` |
| Local VAD with hysteresis | `apps/web/lib/call/vad.ts` |
| Ducking, PTT, auto-rejoin | `apps/web/lib/call/provider.tsx` |
| UI | `apps/web/components/room/call/` |

Three decisions worth knowing:

**Mesh membership is the presence hash, not a second registry.** `inCall`,
`camOn` and `sharing` already live in `room:{id}:presence`, which every node
reads and the participant list renders. A separate call registry would be a
second source of truth for "who is in the call", and the two would disagree the
first time a node died.

**Teardown is driven by the socket, not by ICE.** `rtc:peer_left` goes out on
disconnect (~5 s) rather than waiting for an ICE timeout (~30 s), and the room
seat survives the 45 s grace period independently. Someone who drops is out of
the call immediately and still in the room.

**The camera cap downgrades rather than refuses.** Hitting `MESH_VIDEO_MAX`
joins you audio-only with a notice. The point of the room is the voice; a full
camera grid is not a reason to keep somebody out of the conversation.

### 6b. Phase 7 — study tools

The document lives in Redis as blocks (`room:{id}:notes`) and is serialised to
`room_notes.content` by a 2-second debounce. A conflict keeps the server's text
and preserves the loser's as a new block **below** it — worst case a duplicated
paragraph, never lost work. See Amendment A3 for the four contract changes.

Note items and checklist items are written to Postgres **synchronously**, unlike
chat. The reason is the ack: `notes:item_create` answers with the created row,
and a write-behind ack would be a promise rather than a fact.

### 6c. Phase 9 — the testing gap, closed

`apps/realtime/src/__integration__/` — **77 tests against real Postgres and real
Redis**, in CI, run with:

```bash
pnpm --filter @syncstudy/realtime test:integration
```

They boot the real server on an ephemeral port through `createServer()` (the
refactor §10 used to ask for) and mint sessions with `@syncstudy/auth` directly,
so they need no web app and dodge the in-process login rate limiter.

**No test in that suite sleeps before an assertion.** That is ADR 0006's rule,
generalised. The one place a wait appears it is the subject of the assertion,
and it is commented as such.

That suite found a real bug on its first run: `uuidv7` drew fresh randomness
every call, so two ids minted in the same millisecond sorted arbitrarily — the
exact property ADR 0007 rests on. Fixed per RFC 9562 §6.2 (Amendment A4).

### 6d. Load test — 7 of 8 §15.5 targets

```bash
cd apps/realtime
# The per-IP cap fires at 13 sockets from 127.0.0.1, so raise it for the run.
MAX_CONNECTIONS_PER_IP=2000 pnpm --filter @syncstudy/realtime dev
npx tsx --env-file=.env scripts/load-test.mjs --sockets 500 --rooms 60 --seconds 45
```

| Target | Measured |
|---|---|
| 200 simultaneous joins to a room capped at 12 | **exactly 12 admitted** |
| 500 sockets across 60 rooms | **500 joined** |
| Event-loop lag p99 < 50 ms | **11.4 ms** |
| RSS < 700 MB | **262 MB** |
| Broadcast p95 < 80 ms | **24 ms** over 2250 samples |
| 50 msg/s sustained, zero dropped | **0 refused of 2250** |
| Video controls accepted | **240 of 240** |
| Lua transact p99 < 3 ms | **not met** — p95 ≤10 ms, mean 3.03 ms |

The last one is the honest gap, and the caveat matters: this was measured on one
laptop that was simultaneously running Postgres, Redis, a Next dev server, the
realtime service **and** the 500-socket generator. p50 is under 1 ms. Re-measure
with the generator on a different machine before treating it as a regression —
the load test prints that note itself when it sees this shape.

Writing this test also exposed two things worth keeping: the load generator was
not connecting room hosts, so every `video:set` was permission-denied and the
transact histogram read zero calls while looking busy; and `ss_redis_transact_ms`
had no bucket at 3 ms, so the §15.5 target it is measured against fell inside a
bucket and could be neither passed nor failed honestly. Both fixed.

## 7. Things that will waste your day

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

**A message is broadcast before it is in Postgres.** Anything that reads `messages` back
within a few hundred milliseconds of a send — a delete, a report, a snapshot — must account
for the write-behind queue. Two shipped features were broken by exactly this and both
passed their tests, because the tests slept first. If you write a new reader, write its
test *without* a sleep.

**`chat:send` is 5 / 5 s with a burst of 10, and three breaches disconnect the socket for
60 s.** A test script that sends in a tight loop strikes out in under a second and then
talks to a socket the server has hung up on. Pace scripted sends at ~1/s, or insert
history rows directly.

**The per-IP connection cap fires at 13 sockets from one address.** Every socket
in a load test comes from 127.0.0.1, so a run measures the cap rather than the
server. `MAX_CONNECTIONS_PER_IP=2000 pnpm dev` for the run only — raising it in
production lets one machine open ten thousand sockets.

**Fast Refresh eats dialog state.** A React edit while a dialog is open remounts
the component, clearing what was typed and closing it. If a manual browser check
of a form "silently did nothing", check whether you had just saved a file.

**The playhead ref is written by a requestAnimationFrame loop, so it is 0 in a
tab that is not painting.** Anything that needs the current position at a moment
in time — pinning a question, filing feedback — must call
`controller.getPlayheadSec()` rather than read `usePlayheadRef()`. The ref is for
rendering; the method is for deciding. This was a real bug: `?` in a
just-restored background tab pinned a question at 0:00.

**A socket.io client keeps the Node event loop alive forever.** A verification script that
throws still will not exit; it hangs with the failure invisible inside a buffered pipe.
Disconnect every socket and call `process.exit()` on the failure path.

---

## 8. Verification you should run before any commit

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build

# And, with Postgres and Redis up — this is where the real bugs are:
pnpm --filter @syncstudy/realtime test:integration
```

Design-rule audit (all of these should return 0 real hits — matches inside comments
explaining why a pattern is *avoided* are expected):

```bash
grep -rn 'bg-gradient\|backdrop-blur\|animate-pulse\|shimmer' apps/web/components apps/web/app
grep -rEn 'duration-(2[0-9]{2}|[3-9][0-9]{2})' apps/web/components apps/web/app
grep -rn 'rounded-full' apps/web/components | grep -i button
```

Then, for anything touching rooms, sockets, playback **or chat**, run it against the live
stack per RUNBOOK §5. **Typechecking is not verification** — every bug in §4 and §5 of this
document typechecked, linted and built cleanly first.

For chat specifically, the read-back paths are the ones that break: write the test
*without* a sleep before the assertion, or it will pass against broken code. See
[ADR 0006](./ADR/0006-chat-is-broadcast-first.md).

---

## 9. Where things live

```
PLAN.md                        the blueprint — 20 sections, §8 is the product
docs/HANDOFF.md                this file
docs/RUNBOOK.md                dev environment, including the no-Docker path
docs/ADR/                      seven decisions where the obvious choice is wrong
docs/BACKLOG.md                deliberately not being built yet

packages/shared/               THE CONTRACT — Zod schemas, typed socket event maps,
                               the authoritative video timeline, all tuning constants
packages/auth/                 argon2id, opaque sessions, recovery codes, handle rules
packages/db/                   Prisma schema + migrations + seed, and the one
                               messages row → MessageView mapping both apps use

apps/realtime/                 Fastify + Socket.IO. Rooms, presence, host controls,
                               the authoritative timeline behind an atomic Lua transact
  server.ts                    createServer() — the factory the tests boot
  index.ts                     the boot script, and nothing else
  chat/                        write-behind queue, send/dedupe/system lines, table reads
  notes/                       block store, debounced persistence, item + checklist CRUD
  rtc/                         TURN credential minting
  rooms/                       RoomStore, leader election, snapshotter, room bus
  handlers/                    one file per event family; context.ts is the guard
  __integration__/             77 tests against real Postgres and Redis
  scripts/                     live-stack verification and the §15.5 load test
apps/web/                      Next.js 15. Marketing, auth, dashboard, settings, room
  lib/sync/                    clock, player adapter, sync controller, simulator
  lib/socket/                  typed client, provider, connection lifecycle
  lib/call/                    CallTransport seam, MeshTransport, media, VAD, SDP munge
  lib/stores/                  per-room zustand stores (context, not singletons)
  lib/chat/                    message tokenizer + the bundled link blocklist
  components/room/chat/        transcript, composer, report dialog
  components/room/call/        control bar, camera tiles, screen-share stage, audio
  components/room/notes/       block editor, pinned items, checklist

infra/                         docker-compose, hardened coturn, fly.io config
```

Three seams exist specifically so later phases are swaps rather than rewrites. Do not
compromise them: **`RoomStore`** (Redis → anything), **`CallTransport`** (mesh → SFU),
**`PlayerAdapter`** (YouTube → anything). All three now have a real implementation
behind them, which is the point at which a seam either holds or turns out to have
been imaginary. They held.

```
docs/DEPLOY.md                 the order of operations, and what bites where
docs/MODERATION.md             the SQL that IS the moderation tool (see BACKLOG)
SECURITY.md                    disclosure policy, and what is already defended
```

---

## 10. Open items

Three of the four original open items are now closed. What is left is genuinely
blocked on something that is not code, plus what Phases 6–10 could not verify
from here.

| Item | Why it is still open |
|---|---|
| Avatar upload | Needs a Cloudflare R2 bucket and credentials. The **read** half exists — `users.avatar_key`, `avatarUrlFor()`, `NEXT_PUBLIC_AVATAR_BASE_URL`, and the deterministic generated fallback in `components/ui/avatar.tsx`. Missing: `POST /api/me/avatar` (multipart → magic-byte check → `sharp` → two sizes → R2) and the UI on `/settings/profile`. **Note before building it:** the realtime service puts the raw `avatar_key` on `socket.data.avatarUrl` and on message authors, while the web app resolves it to a URL. Both are null today because nobody can upload one, so the inconsistency is dormant — resolve it (one helper, one convention) in the same change that ships uploads, or participant and message avatars will break. |
| Staging + production deploys | Needs Vercel, Fly.io, Neon and Upstash accounts. Everything else is written: `infra/fly.realtime.toml`, `apps/realtime/Dockerfile`, and `docs/DEPLOY.md` with the order of operations and the things that bite. |
| Sentry | Needs a DSN. `pino` structured logging and Prometheus metrics are in place; error reporting is not. |

### What Phases 6–10 could not verify from here

Stated plainly rather than left to be discovered:

- **Real WebRTC media between two browsers.** The signaling half is verified
  three ways (30 live-stack checks, 17 integration tests, and the browser's
  permission-denied path with the right copy). What has not run is two browsers
  actually exchanging audio, because that needs two browser contexts with fake
  media devices — `--use-fake-device-for-media-stream`. That is the Playwright
  suite in §15.4, and it is the highest-value remaining test.
- **A relayed (TURN) connection.** `TURN_SECRET` is unset in dev by design, so
  every ICE grant here is STUN-only. §14 Phase 6's "before moving on" gate — a
  relayed connection from a network with UDP blocked — needs a deployed coturn.
- **E2E specs (§15.4).** Playwright is not installed. The integration layer
  covers every socket path; what it cannot cover is two real browsers converging
  on the same second, which is the assertion §15.4 exists for.
- **axe-core in CI and visual-regression snapshots (§14 Phase 8.6).** The
  accessibility work is done by construction — every icon button has an
  `aria-label`, state is never colour alone, targets are 44px below `lg`, focus
  rings are on everything — but it has not been machine-checked.
- **Lua transact p99** — see §6d. Needs a two-machine measurement.
- **The §15.6 browser matrix.** Verified in one Chromium-based browser at 1440px
  and 375px. iOS Safari is the highest-risk cell in that table and has not been
  touched.
