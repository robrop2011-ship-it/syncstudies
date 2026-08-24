# ADR 0004 — `POST /api/rooms/:code/join` is a pre-flight check and writes nothing

- **Status:** Accepted
- **Date:** 2026-08-24
- **Applies to:** `apps/web/app/api/rooms/[room]/join/route.ts`

## Context

The obvious shape for a join endpoint is "validate, then create the membership row". That
is what it originally did, and it produced a room that locks itself shut.

`room_participants.left_at` has exactly **one** writer: `recordLeave` in the realtime
service, reached from the socket disconnect path. A row opened by the REST route is
therefore a row only a socket can ever close. Every join that stops before a clean socket
teardown leaves a member who is permanently "present":

- the user reads the passcode screen and closes the tab
- the socket never connects (blocked WebSocket, corporate proxy, refused handshake)
- the browser is killed between the REST call and the socket connect

The same route then counts those open rows as a **hard 409 capacity gate**. Enough
abandoned joins and the room is full with nobody in it, and no user action can clear it.

## Decision

The route validates and answers. It does not write membership.

It still checks, in order: unknown code (404), ended/archived (410), banned (403),
passcode (403), capacity (409 — advisory). It updates `rooms.last_active_at` and returns
`{ roomId, code, role }`. It creates no `room_participants` row.

Membership is written by `recordJoin` on the socket path, at the moment the user is
genuinely present. `resolveMembership` already treats a missing row as `member`, so
nothing downstream needs the row to exist earlier.

## Consequences

- The value of the route is **a straight answer before a WebSocket is opened**, on a page
  that can render it inline — not a socket error after the room has already painted.
- Its capacity check is advisory and can read stale. The authoritative one is the atomic
  Redis check in `addParticipantIfRoom` on the socket path, which is the only place that
  can be correct under concurrent joins anyway.
- **Do not "fix" the missing insert.** If a future change needs a durable row before the
  socket connects, it also needs a way to close that row without a socket — a TTL, a
  sweeper, or a distinct `pending` state that capacity does not count.
