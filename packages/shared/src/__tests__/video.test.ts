/**
 * The authoritative video timeline (PLAN.md §8.2, §8.4).
 *
 * These are the highest-value unit tests in the repository. Everything the room
 * page and the realtime service believe about "where the video is" comes from
 * `positionAt` and `applyControl`; a sign error or a missing clamp here shows up
 * as "sync feels broken sometimes" and takes a week to find from the outside.
 *
 * The asymmetry between play, pause and seek is deliberate and documented in
 * video.ts. It is pinned here so nobody "tidies it up" into consistency.
 */
import { describe, expect, it } from 'vitest';
import {
  IDLE_ANCHOR,
  applyControl,
  applySetVideo,
  clampToDuration,
  freezeAnchor,
  positionAt,
  type ControlAction,
  type ControlCommand,
  type VideoAnchor,
} from '../video';

/** A fixed server epoch, so every assertion is an exact number. */
const T0 = 1_700_000_000_000;

function anchor(overrides: Partial<VideoAnchor> = {}): VideoAnchor {
  return {
    provider: 'youtube',
    videoRef: 'dQw4w9WgXcQ',
    title: 'Lecture 4 — Eigenvalues',
    durationSec: 3600,
    status: 'paused',
    anchorPositionSec: 0,
    anchorServerMs: T0,
    playbackRate: 1,
    revision: 7,
    lastActorId: 'user-a',
    lastChangeMs: T0,
    ...overrides,
  };
}

function control(action: ControlAction, extra: Partial<ControlCommand> = {}): ControlCommand {
  return { action, clientSentAtMs: T0, expectedRevision: -1, ...extra };
}

describe('positionAt', () => {
  it('advances a playing anchor by wall-clock time', () => {
    const a = anchor({ status: 'playing', anchorPositionSec: 100, anchorServerMs: T0 });
    expect(positionAt(a, T0)).toBe(100);
    expect(positionAt(a, T0 + 2_500)).toBe(102.5);
    expect(positionAt(a, T0 + 60_000)).toBe(160);
  });

  it('freezes a paused anchor no matter how much time passes', () => {
    const a = anchor({ status: 'paused', anchorPositionSec: 100 });
    expect(positionAt(a, T0)).toBe(100);
    expect(positionAt(a, T0 + 60_000)).toBe(100);
    expect(positionAt(a, T0 + 86_400_000)).toBe(100);
  });

  it('freezes an ended anchor', () => {
    const a = anchor({ status: 'ended', anchorPositionSec: 3600 });
    expect(positionAt(a, T0 + 60_000)).toBe(3600);
  });

  it('reports zero for an idle room regardless of the clock', () => {
    expect(positionAt(IDLE_ANCHOR, 0)).toBe(0);
    expect(positionAt(IDLE_ANCHOR, T0)).toBe(0);
  });

  it('scales elapsed time by the playback rate', () => {
    const fast = anchor({ status: 'playing', anchorPositionSec: 100, playbackRate: 2 });
    expect(positionAt(fast, T0 + 2_000)).toBe(104);

    const slow = anchor({ status: 'playing', anchorPositionSec: 100, playbackRate: 0.5 });
    expect(positionAt(slow, T0 + 2_000)).toBe(101);
  });

  it('clamps to the duration rather than running past the end', () => {
    const a = anchor({
      status: 'playing',
      anchorPositionSec: 119,
      durationSec: 120,
    });
    expect(positionAt(a, T0 + 5_000)).toBe(120);
    expect(positionAt(a, T0 + 5_000_000)).toBe(120);
  });

  it('does not clamp upward when the duration is unknown', () => {
    const a = anchor({ status: 'playing', anchorPositionSec: 0, durationSec: null });
    expect(positionAt(a, T0 + 10_000_000)).toBe(10_000);
  });

  it('clamps to zero when the clock reads before the anchor', () => {
    // A client whose clock estimate briefly runs backwards must not be handed a
    // negative position — the player would reject it and the drift loop would
    // read the rejection as an enormous drift.
    const a = anchor({ status: 'playing', anchorPositionSec: 1 });
    expect(positionAt(a, T0 - 5_000)).toBe(0);
  });

  it('treats a zero anchor as inert while idle or paused', () => {
    // IDLE_ANCHOR has anchorServerMs === 0. That is only safe because it is never
    // `playing`: a playing anchor with a zero server time would derive an epoch-
    // scale position, and only the duration clamp stands between that and the UI.
    const cold = { ...IDLE_ANCHOR, anchorPositionSec: 42, status: 'paused' as const };
    expect(positionAt(cold, T0)).toBe(42);

    const broken = { ...IDLE_ANCHOR, status: 'playing' as const, durationSec: 600 };
    expect(positionAt(broken, T0)).toBe(600);
  });
});

describe('clampToDuration', () => {
  it('clamps below zero and above the duration', () => {
    expect(clampToDuration(-10, { durationSec: 100 })).toBe(0);
    expect(clampToDuration(50, { durationSec: 100 })).toBe(50);
    expect(clampToDuration(500, { durationSec: 100 })).toBe(100);
  });

  it('only clamps the lower bound when the duration is unknown', () => {
    expect(clampToDuration(-1, { durationSec: null })).toBe(0);
    expect(clampToDuration(99_999, { durationSec: null })).toBe(99_999);
  });
});

describe('applyControl — play', () => {
  it('resumes from the stored position and re-anchors to now', () => {
    const a = anchor({ status: 'paused', anchorPositionSec: 90 });
    const next = applyControl(a, control('play'), T0 + 1_000);

    expect(next.status).toBe('playing');
    expect(next.anchorPositionSec).toBe(90);
    expect(next.anchorServerMs).toBe(T0 + 1_000);
    expect(positionAt(next, T0 + 3_000)).toBe(92);
  });

  it('re-anchors without jumping when the room is already playing', () => {
    const a = anchor({ status: 'playing', anchorPositionSec: 100 });
    const next = applyControl(a, control('play'), T0 + 3_000);

    expect(next.anchorPositionSec).toBe(103);
    expect(next.anchorServerMs).toBe(T0 + 3_000);
    expect(positionAt(next, T0 + 3_000)).toBe(103);
  });

  it('ignores the client-reported position, so a lagging client cannot rewind the room', () => {
    // The asymmetry that matters most in a real session: participant B's player is
    // 40 seconds behind because their tab was backgrounded. B presses play. If the
    // server trusted B's number, everyone else would be yanked back 40 seconds.
    const a = anchor({ status: 'paused', anchorPositionSec: 500 });
    const next = applyControl(a, control('play', { positionSec: 460 }), T0 + 1_000);
    expect(next.anchorPositionSec).toBe(500);

    const playing = anchor({ status: 'playing', anchorPositionSec: 500 });
    const next2 = applyControl(playing, control('play', { positionSec: 0 }), T0 + 3_000);
    expect(next2.anchorPositionSec).toBe(503);
  });
});

describe('applyControl — pause', () => {
  it('freezes at the server-derived position, not at the position the client reported', () => {
    // The client's number is one one-way delay stale. Trusting it rewinds the room
    // a little on every pause, and those rewinds accumulate over a long session.
    const a = anchor({ status: 'playing', anchorPositionSec: 100 });
    const next = applyControl(a, control('pause', { positionSec: 90 }), T0 + 4_000);

    expect(next.status).toBe('paused');
    expect(next.anchorPositionSec).toBe(104);
    expect(next.anchorServerMs).toBe(T0 + 4_000);
  });

  it('is idempotent on an already-paused room', () => {
    const a = anchor({ status: 'paused', anchorPositionSec: 250 });
    const next = applyControl(a, control('pause'), T0 + 10_000);

    expect(next.status).toBe('paused');
    expect(next.anchorPositionSec).toBe(250);
    expect(next.anchorServerMs).toBe(T0 + 10_000);
  });

  it('does not drift over repeated pause/play cycles', () => {
    let a = anchor({ status: 'paused', anchorPositionSec: 300 });
    let t = T0;
    for (let i = 0; i < 20; i += 1) {
      a = applyControl(a, control('play', { clientSentAtMs: t }), t);
      t += 5_000;
      a = applyControl(a, control('pause', { clientSentAtMs: t }), t);
      t += 1_000;
    }
    // 20 cycles × 5 s of playback, and not one frame lost to a stale client number.
    expect(a.anchorPositionSec).toBe(400);
  });
});

describe('applyControl — seek', () => {
  it('takes the client target verbatim while the room is paused', () => {
    // A seek is an intent about the video, not a measurement of now, so there is
    // nothing in flight to compensate for when nothing is moving.
    const a = anchor({ status: 'paused', anchorPositionSec: 10 });
    const next = applyControl(
      a,
      control('seek', { positionSec: 600, clientSentAtMs: T0 - 400 }),
      T0,
    );
    expect(next.anchorPositionSec).toBe(600);
    expect(next.status).toBe('paused');
  });

  it('adds the in-flight time while the room is playing', () => {
    const a = anchor({ status: 'playing', anchorPositionSec: 10 });
    const next = applyControl(
      a,
      control('seek', { positionSec: 600, clientSentAtMs: T0 - 300 }),
      T0,
    );
    expect(next.anchorPositionSec).toBeCloseTo(600.3, 6);
  });

  it('scales the in-flight compensation by the playback rate', () => {
    const a = anchor({ status: 'playing', anchorPositionSec: 10, playbackRate: 2 });
    const next = applyControl(
      a,
      control('seek', { positionSec: 600, clientSentAtMs: T0 - 500 }),
      T0,
    );
    expect(next.anchorPositionSec).toBe(601);
  });

  it('caps the in-flight compensation at one second', () => {
    // Without the cap, a request delayed by a 30 s mobile stall would land the whole
    // room 30 s past where the user pointed.
    const a = anchor({ status: 'playing', anchorPositionSec: 10 });
    const atCap = applyControl(
      a,
      control('seek', { positionSec: 600, clientSentAtMs: T0 - 1_000 }),
      T0,
    );
    expect(atCap.anchorPositionSec).toBe(601);

    const wayOver = applyControl(
      a,
      control('seek', { positionSec: 600, clientSentAtMs: T0 - 30_000 }),
      T0,
    );
    expect(wayOver.anchorPositionSec).toBe(601);
  });

  it('never applies negative compensation when the client clock runs ahead', () => {
    const a = anchor({ status: 'playing', anchorPositionSec: 10 });
    const next = applyControl(
      a,
      control('seek', { positionSec: 600, clientSentAtMs: T0 + 5_000 }),
      T0,
    );
    expect(next.anchorPositionSec).toBe(600);
  });

  it('falls back to the current room position when no target is given', () => {
    const a = anchor({ status: 'playing', anchorPositionSec: 100 });
    const next = applyControl(a, control('seek', { clientSentAtMs: T0 + 2_000 }), T0 + 2_000);
    expect(next.anchorPositionSec).toBe(102);
  });

  it('clamps a target below zero and above the duration', () => {
    const a = anchor({ status: 'paused', durationSec: 3600 });
    expect(applyControl(a, control('seek', { positionSec: -30 }), T0).anchorPositionSec).toBe(0);
    expect(applyControl(a, control('seek', { positionSec: 9_999 }), T0).anchorPositionSec).toBe(
      3600,
    );
  });

  it('ends the video when seeking past the end of a playing room', () => {
    const a = anchor({ status: 'playing', anchorPositionSec: 10, durationSec: 3600 });
    const next = applyControl(a, control('seek', { positionSec: 3600 }), T0);

    expect(next.status).toBe('ended');
    expect(next.anchorPositionSec).toBe(3600);
  });

  it('leaves a paused room paused when seeking to the end', () => {
    // Scrubbing to the end of a paused video is a normal thing to do while looking
    // for something; it must not fire the "video finished" path.
    const a = anchor({ status: 'paused', anchorPositionSec: 10, durationSec: 3600 });
    const next = applyControl(a, control('seek', { positionSec: 3600 }), T0);

    expect(next.status).toBe('paused');
    expect(next.anchorPositionSec).toBe(3600);
  });

  it('leaves the status alone when the duration is unknown', () => {
    const a = anchor({ status: 'playing', anchorPositionSec: 10, durationSec: null });
    const next = applyControl(a, control('seek', { positionSec: 999_999 }), T0);

    expect(next.status).toBe('playing');
    expect(next.anchorPositionSec).toBe(999_999);
  });
});

describe('applyControl — rate', () => {
  it('re-anchors at the current position before changing the rate', () => {
    const a = anchor({ status: 'playing', anchorPositionSec: 100 });
    const next = applyControl(a, control('rate', { rate: 1.5 }), T0 + 2_000);

    expect(next.playbackRate).toBe(1.5);
    expect(next.anchorPositionSec).toBe(102);
    expect(next.anchorServerMs).toBe(T0 + 2_000);
    // The two seconds already played were at 1×; only what follows runs at 1.5×.
    expect(positionAt(next, T0 + 4_000)).toBe(105);
  });

  it('changes the rate of a paused room without moving it', () => {
    const a = anchor({ status: 'paused', anchorPositionSec: 100 });
    const next = applyControl(a, control('rate', { rate: 0.75 }), T0 + 9_000);

    expect(next.status).toBe('paused');
    expect(next.playbackRate).toBe(0.75);
    expect(next.anchorPositionSec).toBe(100);
  });

  it('defaults to 1× when no rate is supplied', () => {
    const a = anchor({ status: 'playing', anchorPositionSec: 100, playbackRate: 2 });
    expect(applyControl(a, control('rate'), T0).playbackRate).toBe(1);
  });
});

describe('applyControl — bookkeeping', () => {
  const actions: ControlAction[] = ['play', 'pause', 'seek', 'rate'];

  it('increments the revision for every accepted control', () => {
    for (const action of actions) {
      const a = anchor({ revision: 41 });
      const next = applyControl(a, control(action, { positionSec: 5, rate: 1 }), T0 + 1_000);
      expect(next.revision).toBe(42);
    }
  });

  it('increments monotonically across a sequence', () => {
    let a = anchor({ revision: 0 });
    const seen: number[] = [];
    for (const action of [...actions, ...actions]) {
      a = applyControl(a, control(action, { positionSec: 5, rate: 1 }), T0 + 1_000);
      seen.push(a.revision);
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('stamps lastChangeMs with the server time for every action', () => {
    for (const action of actions) {
      const next = applyControl(anchor(), control(action, { rate: 1 }), T0 + 8_888);
      expect(next.lastChangeMs).toBe(T0 + 8_888);
    }
  });

  it('leaves lastActorId to the caller', () => {
    // applyControl is pure timeline maths; the transact wrapper records who did it.
    // Pinned so a future refactor does not quietly start overwriting it here.
    const next = applyControl(anchor({ lastActorId: 'user-a' }), control('pause'), T0);
    expect(next.lastActorId).toBe('user-a');
  });

  it('never mutates the anchor it was given', () => {
    const a = anchor({ status: 'playing', anchorPositionSec: 100 });
    const before = { ...a };
    applyControl(a, control('seek', { positionSec: 900 }), T0 + 5_000);
    expect(a).toEqual(before);
  });
});

describe('applySetVideo', () => {
  it('resets the timeline to paused at zero', () => {
    const a = anchor({ status: 'playing', anchorPositionSec: 1_200, playbackRate: 1.5 });
    const next = applySetVideo(
      a,
      { provider: 'youtube', videoRef: 'M7lc1UVf-VE', title: 'Lecture 5', durationSec: 2400 },
      T0 + 1_000,
    );

    expect(next.status).toBe('paused');
    expect(next.anchorPositionSec).toBe(0);
    expect(next.anchorServerMs).toBe(T0 + 1_000);
    expect(next.playbackRate).toBe(1);
    expect(next.videoRef).toBe('M7lc1UVf-VE');
    expect(next.title).toBe('Lecture 5');
    expect(next.durationSec).toBe(2400);
    expect(next.revision).toBe(a.revision + 1);
  });

  it('nulls the title and duration when they are not supplied', () => {
    const next = applySetVideo(anchor(), { provider: 'youtube', videoRef: 'M7lc1UVf-VE' }, T0);
    expect(next.title).toBeNull();
    expect(next.durationSec).toBeNull();
  });
});

describe('freezeAnchor', () => {
  it('stops a playing room at its current position', () => {
    const a = anchor({ status: 'playing', anchorPositionSec: 100 });
    const frozen = freezeAnchor(a, T0 + 30_000);

    expect(frozen.status).toBe('paused');
    expect(frozen.anchorPositionSec).toBe(130);
    expect(frozen.anchorServerMs).toBe(T0 + 30_000);
  });

  it('never advances a cold room, however long it has been empty', () => {
    // The failure this prevents: a room that was playing when the last person left,
    // reopened three days later, landing at the end of the video.
    const a = anchor({ status: 'playing', anchorPositionSec: 100 });
    const once = freezeAnchor(a, T0 + 30_000);
    const threeDaysLater = freezeAnchor(once, T0 + 30_000 + 3 * 86_400_000);

    expect(threeDaysLater.anchorPositionSec).toBe(130);
    expect(threeDaysLater.status).toBe('paused');
    expect(positionAt(threeDaysLater, T0 + 30_000 + 7 * 86_400_000)).toBe(130);
  });

  it('leaves an idle room idle at zero', () => {
    const frozen = freezeAnchor(IDLE_ANCHOR, T0);
    expect(frozen.status).toBe('idle');
    expect(frozen.anchorPositionSec).toBe(0);
  });

  it('leaves an ended room ended', () => {
    const a = anchor({ status: 'ended', anchorPositionSec: 3600 });
    const frozen = freezeAnchor(a, T0 + 60_000);
    expect(frozen.status).toBe('ended');
    expect(frozen.anchorPositionSec).toBe(3600);
  });

  it('never leaves a stored anchor in the playing state', () => {
    const statuses = ['idle', 'playing', 'paused', 'ended'] as const;
    for (const status of statuses) {
      const frozen = freezeAnchor(anchor({ status, anchorPositionSec: 10 }), T0 + 1_000);
      expect(frozen.status).not.toBe('playing');
    }
  });

  it('does not bump the revision — freezing is storage, not a control', () => {
    const a = anchor({ status: 'playing', revision: 12 });
    expect(freezeAnchor(a, T0 + 1_000).revision).toBe(12);
  });
});
