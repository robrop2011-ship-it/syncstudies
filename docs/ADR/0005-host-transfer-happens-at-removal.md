# ADR 0005 — One disconnect-grace timer, and host transfer happens at removal

- **Status:** Accepted
- **Date:** 2026-08-24
- **Applies to:** `apps/realtime/src/handlers/presence.ts`, `packages/shared/src/constants.ts`

## Context

The natural reading of PLAN.md §2.3/§2.4 is two timers: remove a disconnected participant
after `DISCONNECT_GRACE_MS` (45s), and transfer the host after `HOST_TRANSFER_DELAY_MS`
(60s). That is what was built, and it left rooms permanently hostless.

Because 45 < 60, the removal timer always fired first. Removal calls
`removeParticipantAndBroadcast`, which calls `grace.cancel()`, which cleared **both**
timers — including the transfer timer that was the only thing scheduled to promote a
successor. The transfer callback was unreachable on the normal path.

The deeper problem is that the two-timer design is wrong even when it works. Between
removal and transfer, `rooms.host_id` points at somebody who is no longer in the
participant list, so for that window nobody can kick, mute, or change room settings.

## Decision

**One timer**, whose delay depends on the role, and transfer happens at removal.

- `DISCONNECT_GRACE_MS` (45s) — how long any participant stays listed as `reconnecting`.
- `HOST_DISCONNECT_GRACE_MS` (60s) — the host's longer window, because removing them also
  hands the room to somebody else: a costlier, noisier event than a member briefly
  vanishing. (`HOST_TRANSFER_DELAY_MS` was renamed to this; the old name described a
  mechanism that no longer exists.)
- When the host actually leaves the list — deliberately, by kick, or by timeout —
  `promoteNewHost` runs in the same step, with `reason: 'timeout' | 'left'`.

Regression tests live in `apps/realtime/src/__tests__/graceTimers.test.ts`. The key one
asserts that arming for a host and advancing past the *member* deadline does nothing; it
fails immediately against the two-timer implementation. It has been mutation-tested.

## Consequences

- A host who reconnects within 60s keeps the room. Past that they return as a member, and
  `room_events` records `host_changed` with `reason: 'timeout'`.
- `HOST_DISCONNECT_GRACE_MS` must stay strictly greater than `DISCONNECT_GRACE_MS`; a test
  asserts it.
- **Do not re-introduce a separate transfer timer.** A room whose `host_id` names an absent
  user cannot be moderated by anyone, which is worse than transferring slightly early.
