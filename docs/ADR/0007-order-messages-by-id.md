# ADR 0007 — The transcript is ordered by `id`, never by `created_at`

- **Status:** Accepted
- **Date:** 2026-08-25
- **Applies to:** `packages/db/src/messages.ts`, `apps/realtime/src/chat/messages.ts`,
  `apps/web/app/api/rooms/[room]/messages/route.ts`, `apps/web/lib/stores/room-store.ts`

## Context

`messages` has a `created_at TIMESTAMPTZ` column and an `id UUID` primary key. Ordering a
transcript by `created_at` is the obvious choice, it reads better in a query, and there is
already an index for it (`messages_room_time_idx`). It is also wrong, in three ways that
only show up once a room is busy:

1. **It is not a total order.** Two messages can share a millisecond. Postgres will then
   return them in whatever order the plan happens to produce, which can differ between two
   clients fetching the same page — and *will* differ between a page served from a
   sequential scan and the same page served from an index. Two people scrolling the same
   conversation see it in two different orders, and neither is wrong.
2. **It cannot be a cursor.** `WHERE created_at < $1` either skips messages that share the
   boundary timestamp or returns them twice, depending on whether you use `<` or `<=`.
   Keyset pagination needs a strict total order and a timestamp is not one.
3. **It is a clock.** `created_at` defaults to `now()`, so a row written by the queue
   carries the time of the *write*, not the time of the broadcast — the two differ by the
   flush interval, and under load they differ by more. The ordering that a reader
   experienced live would not be the ordering they get back on reload.

Ids are uuidv7 (PLAN.md §7.2). The first 48 bits are a big-endian millisecond timestamp
and the remaining 74 are random, and Postgres compares `uuid` bytewise — so id order *is*
time order, and it is total, and it is fixed at the moment the server assigned it rather
than at the moment the row landed.

## Decision

**Every ordering, comparison and cursor in the chat path uses `id`.**

- `ORDER BY id DESC` for both pagination directions, reversed in application code so a
  page is handed to the client oldest-first.
- `id < cursor` for scroll-up (`?before=`), `id > cursor` for reconnect backfill.
- The client sorts its store by the same key, and by the id it was given rather than one
  it derived, so every participant renders one identical sequence.
- `created_at` is still selected, stored and displayed. It is what a human reads on the
  message. It is never what the machine sorts on.

A message that has not been acked yet has no server id, so the client sorts it under `~`
— a byte greater than every hex digit, which puts pending messages after everything the
server has confirmed. That is also where a person expects the thing they just typed to be.

## Consequences

- **Do not "fix" a query to `ORDER BY created_at`** because the index name mentions time,
  or because a timestamp reads more naturally. The index that matters here is the primary
  key.
- Ids must keep being generated with `uuidv7()` from `packages/shared/src/ids.ts`. A
  `uuidv4` anywhere in this path silently destroys both the ordering and the btree
  locality that made a growing `messages` table cheap to page through.
- The same property makes "the newest message I hold" a valid backfill cursor, which is
  what `room:join`'s and `room:resync`'s `lastMessageId` is (§10.2).
- `messages_room_time_idx` on `(room_id, created_at DESC)` is now unused by application
  queries. It is left in place: it is what a human debugging a moderation report will
  reach for, and it costs one index on a table nobody writes to at high rate.
