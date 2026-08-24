/**
 * Control conflict resolution (PLAN.md §8.5).
 *
 * `decideControl` is the pure form of the Lua transact script that runs inside
 * Redis. The two must agree exactly, so this suite is also the specification the
 * Lua transliteration is checked against.
 *
 * Two mechanisms are under test and they are independent:
 *   (b) the optimistic-concurrency revision check, and
 *   (c) the control lock, which stops two people fighting over the scrubber.
 */
import { describe, expect, it } from 'vitest';
import { CONTROL_LOCK_MS } from '../constants';
import { decideControl, type VideoAnchor } from '../video';

const T0 = 1_700_000_000_000;

function anchor(overrides: Partial<VideoAnchor> = {}): VideoAnchor {
  return {
    provider: 'youtube',
    videoRef: 'dQw4w9WgXcQ',
    title: null,
    durationSec: 3600,
    status: 'playing',
    anchorPositionSec: 100,
    anchorServerMs: T0,
    playbackRate: 1,
    revision: 5,
    lastActorId: 'user-a',
    lastChangeMs: T0,
    ...overrides,
  };
}

describe('decideControl — revision check', () => {
  it('accepts a control that names the current revision', () => {
    const decision = decideControl(
      anchor({ revision: 5, lastChangeMs: T0 - 10_000 }),
      { expectedRevision: 5 },
      'user-b',
      T0,
      CONTROL_LOCK_MS,
    );
    expect(decision).toEqual({ accepted: true });
  });

  it('rejects a stale revision', () => {
    // Two people seek in the same instant. One is serialized first; the second is
    // acting on a state that no longer exists and must be told so rather than
    // silently overwriting the winner.
    const decision = decideControl(
      anchor({ revision: 5, lastChangeMs: T0 - 10_000 }),
      { expectedRevision: 4 },
      'user-b',
      T0,
      CONTROL_LOCK_MS,
    );
    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe('stale_revision');
  });

  it('rejects a revision from the future as firmly as one from the past', () => {
    const decision = decideControl(
      anchor({ revision: 5, lastChangeMs: T0 - 10_000 }),
      { expectedRevision: 9 },
      'user-b',
      T0,
      CONTROL_LOCK_MS,
    );
    expect(decision.reason).toBe('stale_revision');
  });

  it('bypasses the revision check when expectedRevision is -1', () => {
    // -1 is the resync escape hatch: the client has just reconnected and is
    // deliberately acting without a known revision.
    const decision = decideControl(
      anchor({ revision: 5, lastChangeMs: T0 - 10_000 }),
      { expectedRevision: -1 },
      'user-b',
      T0,
      CONTROL_LOCK_MS,
    );
    expect(decision).toEqual({ accepted: true });
  });

  it('checks the revision before the lock, so the reason is the more specific one', () => {
    const decision = decideControl(
      anchor({ revision: 5, lastActorId: 'user-a', lastChangeMs: T0 - 100 }),
      { expectedRevision: 4 },
      'user-b',
      T0,
      CONTROL_LOCK_MS,
    );
    expect(decision.reason).toBe('stale_revision');
  });
});

describe('decideControl — the control lock', () => {
  it('rejects a different actor inside the lock window', () => {
    const decision = decideControl(
      anchor({ lastActorId: 'user-a', lastChangeMs: T0 - 100 }),
      { expectedRevision: 5 },
      'user-b',
      T0,
      CONTROL_LOCK_MS,
    );
    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe('recently_changed');
  });

  it('never locks out the actor who made the last change', () => {
    // This is what makes scrubbing work: a drag emits several seeks in a row from
    // the same person, and each one must land.
    for (const elapsed of [0, 1, 50, CONTROL_LOCK_MS - 1]) {
      const decision = decideControl(
        anchor({ lastActorId: 'user-a', lastChangeMs: T0 - elapsed }),
        { expectedRevision: 5 },
        'user-a',
        T0,
        CONTROL_LOCK_MS,
      );
      expect(decision).toEqual({ accepted: true });
    }
  });

  it('accepts a different actor once the window has elapsed', () => {
    const decision = decideControl(
      anchor({ lastActorId: 'user-a', lastChangeMs: T0 - CONTROL_LOCK_MS - 1 }),
      { expectedRevision: 5 },
      'user-b',
      T0,
      CONTROL_LOCK_MS,
    );
    expect(decision).toEqual({ accepted: true });
  });

  it('treats exactly CONTROL_LOCK_MS as expired', () => {
    // The comparison is strictly less-than. Pinned because an off-by-one here is
    // invisible in use and would silently change the tuning constant's meaning.
    const atBoundary = decideControl(
      anchor({ lastActorId: 'user-a', lastChangeMs: T0 - CONTROL_LOCK_MS }),
      { expectedRevision: 5 },
      'user-b',
      T0,
      CONTROL_LOCK_MS,
    );
    expect(atBoundary).toEqual({ accepted: true });

    const justInside = decideControl(
      anchor({ lastActorId: 'user-a', lastChangeMs: T0 - CONTROL_LOCK_MS + 1 }),
      { expectedRevision: 5 },
      'user-b',
      T0,
      CONTROL_LOCK_MS,
    );
    expect(justInside.reason).toBe('recently_changed');
  });

  it('accepts the first-ever control on a room, even within the window', () => {
    // lastActorId === null means nobody has touched this room yet, so lastChangeMs
    // is meaningless — a fresh room's zero timestamp must not lock anyone out.
    const decision = decideControl(
      anchor({ lastActorId: null, lastChangeMs: T0 }),
      { expectedRevision: 5 },
      'user-b',
      T0,
      CONTROL_LOCK_MS,
    );
    expect(decision).toEqual({ accepted: true });

    const coldRoom = decideControl(
      { ...anchor(), lastActorId: null, lastChangeMs: 0, revision: 0 },
      { expectedRevision: 0 },
      'user-b',
      T0,
      CONTROL_LOCK_MS,
    );
    expect(coldRoom).toEqual({ accepted: true });
  });

  it('does not let expectedRevision -1 bypass the lock', () => {
    // The resync escape hatch is about the revision only. A reconnecting client
    // must still not be able to stomp on someone who just acted.
    const decision = decideControl(
      anchor({ lastActorId: 'user-a', lastChangeMs: T0 - 100 }),
      { expectedRevision: -1 },
      'user-b',
      T0,
      CONTROL_LOCK_MS,
    );
    expect(decision.reason).toBe('recently_changed');
  });

  it('honours a caller-supplied lock window rather than the constant', () => {
    const cur = anchor({ lastActorId: 'user-a', lastChangeMs: T0 - 900 });
    expect(decideControl(cur, { expectedRevision: 5 }, 'user-b', T0, 600).accepted).toBe(true);
    expect(decideControl(cur, { expectedRevision: 5 }, 'user-b', T0, 2_000).accepted).toBe(false);
    // A zero window disables the mechanism entirely, which is what the simulator
    // uses to isolate the revision check.
    expect(
      decideControl(
        anchor({ lastActorId: 'user-a', lastChangeMs: T0 }),
        { expectedRevision: 5 },
        'user-b',
        T0,
        0,
      ).accepted,
    ).toBe(true);
  });
});

describe('decideControl — the seek-war scenario end to end', () => {
  it('produces a single winner when two people seek in the same instant', () => {
    const cur = anchor({ revision: 5, lastActorId: null, lastChangeMs: 0 });

    const first = decideControl(cur, { expectedRevision: 5 }, 'user-a', T0, CONTROL_LOCK_MS);
    expect(first.accepted).toBe(true);

    // The winner's write moves the revision on and stamps the lock.
    const afterFirst = anchor({ revision: 6, lastActorId: 'user-a', lastChangeMs: T0 });

    // The loser's command was built against revision 5 and arrives 20 ms later.
    const second = decideControl(
      afterFirst,
      { expectedRevision: 5 },
      'user-b',
      T0 + 20,
      CONTROL_LOCK_MS,
    );
    expect(second.accepted).toBe(false);
    expect(second.reason).toBe('stale_revision');

    // Even after re-syncing to revision 6, user-b is held off for the rest of the
    // lock window — that is the anti-oscillation rule, not a bug.
    const retryTooSoon = decideControl(
      afterFirst,
      { expectedRevision: 6 },
      'user-b',
      T0 + 20,
      CONTROL_LOCK_MS,
    );
    expect(retryTooSoon.reason).toBe('recently_changed');

    // Once the window passes, user-b can take a turn.
    const retryLater = decideControl(
      afterFirst,
      { expectedRevision: 6 },
      'user-b',
      T0 + CONTROL_LOCK_MS + 1,
      CONTROL_LOCK_MS,
    );
    expect(retryLater.accepted).toBe(true);
  });
});
