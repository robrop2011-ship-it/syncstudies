# ADR 0006 — Chat is broadcast first, and every reader must account for it

- **Status:** Accepted
- **Date:** 2026-08-25
- **Applies to:** `apps/realtime/src/chat/`, `apps/realtime/src/handlers/chat.ts`,
  `apps/realtime/src/handlers/room.ts`, `apps/web/app/api/reports/route.ts`

## Context

PLAN.md §6.5 says a chat message is broadcast immediately with a server-assigned id and
timestamp, and the INSERT is *enqueued* behind it: broadcast in under 10 ms, database
within 2 s. Measured on the live stack, the real numbers are a **2 ms ack** and a **7 ms
row**. That rule exists so a database having a bad afternoon costs the room a lagging
transcript rather than a frozen chat box, and it is not in question.

What was not written down is the other half of it. **For a few hundred milliseconds, a
message that everyone in the room can see does not exist in Postgres.** Every path that
reads a message back inherits that window, and the ones that do are not obviously
"chat" code:

| Reader | What it wanted | What it got |
|---|---|---|
| `chat:delete` | the row, to authorize and tombstone it | `not_found` |
| `POST /api/reports` | the body, to freeze as evidence (§11.6) | a report with a null snapshot |
| `room:join` snapshot | the last 50 messages | one message short |

Two of those three shipped broken. Both typechecked, linted and built cleanly. Both had
tests, and **both tests passed**, because each slept a few hundred milliseconds before
asserting — enough for the queue to flush, and therefore enough to hide the bug from the
only thing that could have caught it.

The user-visible symptoms were, respectively: deleting a message you had just sent
answered *"That message no longer exists"*, and a report filed the instant something
abusive appeared arrived with no evidence attached. The second is worse than it sounds,
because the reports that matter most are exactly the ones filed fastest.

## Decision

**Write-behind stays. Readers change.**

1. **A reader that runs on the realtime service drains its own queue first.**
   `ChatService.settle()` is a *bounded* drain — the join path and `chat:delete` call it,
   and a database that has stopped answering costs a joiner a missing recent message
   rather than a hung join.
2. **A miss is retried once, briefly.** Draining the local queue does nothing about a
   message written by *another node*. `findMessageForModeration` retries after 150 ms; a
   moderation action may spend that, and silently refusing to delete something that
   exists may not.
3. **The web tier, which has no queue to drain, retries too.** `POST /api/reports`
   re-reads up to three times at 150 ms before giving up on the snapshot.
4. **Deletes are not write-behind.** A tombstone is written synchronously. Telling six
   people a message is gone while the write sits in a queue that is allowed to drop
   items is the wrong way round.
5. **The join path subscribes before it reads.** `socket.join(roomChannel)` happens
   *before* `buildSnapshot`, so a message that lands in between arrives twice — once
   live, once in the history — rather than not at all. The client dedupes by id. **Late
   is acceptable; lost and out-of-order are not.**
6. **On SIGTERM the queue is drained fully, before Prisma disconnects.** Unlike video
   state, an unwritten message is reconstructible from nowhere.

## Consequences

- `ChatService.settle()` calls look removable. They are not. If you are tempted to delete
  one because "the message is obviously there", it is there *on your screen*, which is the
  whole point of this ADR.
- **Write the test without the sleep.** A read-back test that sleeps first is testing
  nothing. The two live-stack scripts that found these bugs have their sleeps deliberately
  removed with a comment saying why.
- One window is still open and is accepted: a message broadcast by another node in the
  preceding ~250 ms is in that node's queue, not the database, so a joiner can miss it
  until they reload. It cannot be lost or reordered — see point 5. Closing it entirely
  means a Redis list of recent messages, which is a new key in §7.3 and more machinery
  than a 250 ms window deserves. Measure before building it.
- `ss_write_behind_depth` is the metric that says this is going wrong, and
  `ss_write_behind_dropped_total` is the one that says it already has. `GET /health`
  reports `pendingWrites` for the same reason — but deliberately does not fail on it,
  because a backed-up queue is a reason to look, not a reason to pull a node holding live
  sockets out of rotation.
