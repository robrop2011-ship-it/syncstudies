/**
 * FakePlayer (PLAN.md §15.3).
 *
 * These are the guardrails on the simulator's foundation. If the fake player
 * lies about seek latency, stalls or rate error, every drift number the harness
 * produces is fiction — and the tuning table in §8.6 gets tuned against fiction.
 *
 * Everything here is driven by `tick(deltaMs)`. No fake timers, no `await` on a
 * clock, no tolerance for scheduling jitter: the same inputs produce byte-identical
 * outputs, which is the entire point of the fake.
 */
import { describe, expect, it } from 'vitest';
import { HARD_SEEK_AT_SEC, POST_SEEK_BLIND_MS, type PlayerState } from '@syncstudy/shared';

import { FakePlayer, type FakePlayerOptions } from '@/lib/sync/players/fake';

const VIDEO = 'dQw4w9WgXcQ';

/** Ready to measure and playing at position 0, with the blind window elapsed. */
async function playing(options: FakePlayerOptions = {}): Promise<FakePlayer> {
  const player = new FakePlayer({ durationSec: 3_600, seekLatencyMs: 0, ...options });
  await player.load(VIDEO, 0, false);
  player.tick(POST_SEEK_BLIND_MS);
  await player.play();
  return player;
}

describe('position advances with tick', () => {
  it('advances one second of video per second of wall clock at rate 1', async () => {
    const player = await playing();

    player.tick(1_000);
    expect(player.getPosition()).toBeCloseTo(1, 9);

    player.tick(9_000);
    expect(player.getPosition()).toBeCloseTo(10, 9);
    expect(player.getState()).toBe('playing');
  });

  it('does not advance while paused or cued', async () => {
    const player = new FakePlayer({ durationSec: 600, seekLatencyMs: 0 });
    await player.load(VIDEO, 42, false);

    expect(player.getState()).toBe('cued');
    player.tick(5_000);
    expect(player.getPosition()).toBe(42);

    await player.play();
    player.tick(1_000);
    await player.pause();
    player.tick(10_000);
    expect(player.getPosition()).toBeCloseTo(43, 9);
  });

  it('splits a tick at the end of the video rather than overrunning it', async () => {
    const player = await playing({ durationSec: 10 });

    player.tick(30_000);
    expect(player.getPosition()).toBe(10);
    expect(player.getState()).toBe('ended');
  });

  it('is deterministic: one big tick equals many small ones', async () => {
    const coarse = await playing({ stalls: [{ atSec: 4, forSec: 2 }] });
    const fine = await playing({ stalls: [{ atSec: 4, forSec: 2 }] });

    coarse.tick(10_000);
    for (let i = 0; i < 200; i += 1) fine.tick(50);

    expect(fine.getPosition()).toBeCloseTo(coarse.getPosition(), 6);
    expect(fine.getState()).toBe(coarse.getState());
  });
});

describe('seek latency is observed', () => {
  it('moves the playhead immediately but buffers before playback resumes', async () => {
    const player = await playing({ seekLatencyMs: 250 });
    player.tick(1_000);

    await player.seek(300);

    // The frame is at the target straight away — that is what a scrubber shows.
    expect(player.getPosition()).toBe(300);
    // But playback has not resumed, which is exactly why §8.6 seeks to
    // `expected + estimatedSeekLatency()` instead of to `expected`.
    expect(player.getState()).toBe('buffering');

    player.tick(249);
    expect(player.getState()).toBe('buffering');
    expect(player.getPosition()).toBe(300);

    player.tick(1);
    expect(player.getState()).toBe('playing');

    player.tick(500);
    expect(player.getPosition()).toBeCloseTo(300.5, 9);
  });

  it('lands 250ms behind when the caller forgets to compensate', async () => {
    // The regression this models: a hard seek to the room's expected position
    // that ignores seek latency arrives late by exactly that latency, and the
    // very next drift tick sees drift again.
    const player = await playing({ seekLatencyMs: 250 });
    player.tick(1_000);

    const roomExpected = 500;
    await player.seek(roomExpected);
    player.tick(250);

    expect(player.getPosition()).toBe(roomExpected);
    // Meanwhile the room has moved on by the latency.
    const roomNow = roomExpected + 0.25;
    expect(roomNow - player.getPosition()).toBeCloseTo(0.25, 9);
  });

  it('costs nothing for a scrub preview (allowSeekAhead: false)', async () => {
    const player = await playing({ seekLatencyMs: 250 });
    player.tick(1_000);

    await player.seek(120, false);

    expect(player.getPosition()).toBe(120);
    expect(player.getState()).toBe('playing');
  });

  it('autoplaying a load buffers for the same cost as a seek', async () => {
    const player = new FakePlayer({ durationSec: 600, seekLatencyMs: 400 });
    await player.load(VIDEO, 0, true);

    expect(player.getState()).toBe('buffering');
    player.tick(399);
    expect(player.getState()).toBe('buffering');
    player.tick(1);
    expect(player.getState()).toBe('playing');
  });
});

describe('a stall freezes position', () => {
  it('holds the playhead for the stall duration while wall clock runs on', async () => {
    const player = await playing({ stalls: [{ atSec: 10, forSec: 4 }] });

    player.tick(9_000);
    expect(player.getPosition()).toBeCloseTo(9, 9);
    expect(player.getState()).toBe('playing');

    // Crossing the trigger starts the stall at exactly 10s, not up to a tick late.
    player.tick(2_000);
    expect(player.getPosition()).toBeCloseTo(10, 9);
    expect(player.getState()).toBe('buffering');

    player.tick(2_999);
    expect(player.getPosition()).toBeCloseTo(10, 9);
    expect(player.getState()).toBe('buffering');

    player.tick(1);
    expect(player.getState()).toBe('playing');

    player.tick(1_000);
    expect(player.getPosition()).toBeCloseTo(11, 9);
  });

  it('leaves the room ahead by the stall length — the §8.10 drift spike', async () => {
    const stalled = await playing({ stalls: [{ atSec: 10, forSec: 4 }] });
    const healthy = await playing();

    stalled.tick(20_000);
    healthy.tick(20_000);

    expect(healthy.getPosition() - stalled.getPosition()).toBeCloseTo(4, 9);
    expect(healthy.getPosition() - stalled.getPosition()).toBeGreaterThan(HARD_SEEK_AT_SEC);
  });

  it('does not replay a stall the playhead has already been seeked past', async () => {
    const player = await playing({ stalls: [{ atSec: 10, forSec: 4 }] });

    await player.seek(600, false);
    player.tick(5_000);

    expect(player.getState()).toBe('playing');
    expect(player.getPosition()).toBeCloseTo(605, 9);
  });

  it('re-arms a stall when the playhead is seeked back before it', async () => {
    const player = await playing({ stalls: [{ atSec: 10, forSec: 4 }] });

    player.tick(11_000);
    expect(player.getState()).toBe('buffering');
    player.tick(4_000);

    await player.seek(0, false);
    player.tick(11_000);
    expect(player.getState()).toBe('buffering');
  });

  it('reports a smaller buffered fraction while stalled', async () => {
    const player = await playing({ durationSec: 100, stalls: [{ atSec: 10, forSec: 4 }] });

    player.tick(5_000);
    const healthy = player.getBufferedFraction();

    player.tick(6_000);
    expect(player.getState()).toBe('buffering');
    expect(player.getBufferedFraction()).toBeLessThan(healthy);
  });
});

describe('isReadyForMeasurement', () => {
  it('is false until a video is loaded', () => {
    const player = new FakePlayer();
    expect(player.isReadyForMeasurement()).toBe(false);
  });

  it('goes false after a seek and recovers after POST_SEEK_BLIND_MS', async () => {
    const player = await playing({ seekLatencyMs: 250 });
    player.tick(1_000);
    expect(player.isReadyForMeasurement()).toBe(true);

    await player.seek(300);
    // Quirk 2's window: a measurement taken here would read the pre-seek
    // position and the drift loop would "correct" a gap that does not exist.
    expect(player.isReadyForMeasurement()).toBe(false);

    player.tick(POST_SEEK_BLIND_MS - 1);
    expect(player.isReadyForMeasurement()).toBe(false);

    player.tick(1);
    expect(player.isReadyForMeasurement()).toBe(true);
  });

  it('blinds measurement after a load as well, since a load is a seek', async () => {
    const player = new FakePlayer({ durationSec: 600, seekLatencyMs: 0 });
    await player.load(VIDEO, 90, false);

    expect(player.isReadyForMeasurement()).toBe(false);
    player.tick(POST_SEEK_BLIND_MS);
    expect(player.isReadyForMeasurement()).toBe(true);
  });

  it('is false once destroyed', async () => {
    const player = await playing();
    player.tick(1_000);
    expect(player.isReadyForMeasurement()).toBe(true);

    player.destroy();
    expect(player.isReadyForMeasurement()).toBe(false);

    const before = player.getPosition();
    player.tick(5_000);
    expect(player.getPosition()).toBe(before);
  });
});

describe('rate error', () => {
  it('accumulates into a hard-seek-sized gap over ten minutes', async () => {
    const perfect = await playing();
    const fast = await playing({ rateError: 1.002 });

    perfect.tick(600_000);
    fast.tick(600_000);

    expect(fast.getPosition() - perfect.getPosition()).toBeCloseTo(1.2, 6);
    // This is the whole reason a drift loop exists rather than a one-time
    // alignment at join (§8.6).
    expect(fast.getPosition() - perfect.getPosition()).toBeLessThan(HARD_SEEK_AT_SEC);
  });

  it('scales with the playback rate as well', async () => {
    const player = await playing({ rateError: 1.01 });
    player.setRate(1.5);

    player.tick(10_000);
    expect(player.getPosition()).toBeCloseTo(10 * 1.5 * 1.01, 9);
  });
});

describe('coarse rates, exactly as YouTube behaves', () => {
  it('never claims fine rate support', async () => {
    const player = await playing();
    expect(player.supportsFineRates()).toBe(false);
    expect(player.getAvailableRates()).not.toContain(1.05);
  });

  it('snaps a 1.05x nudge to 1.0, closing no drift at all', async () => {
    const player = await playing();
    player.setRate(1.05);
    expect(player.getRate()).toBe(1);

    player.tick(10_000);
    expect(player.getPosition()).toBeCloseTo(10, 9);
  });

  it('snaps a slightly larger nudge to 1.25 and overshoots', async () => {
    const player = await playing();
    player.setRate(1.2);
    expect(player.getRate()).toBe(1.25);
  });
});

describe('events', () => {
  it('reports every state transition in order', async () => {
    const seen: PlayerState[] = [];
    const player = new FakePlayer({ durationSec: 600, seekLatencyMs: 100 });
    player.on('statechange', (state) => seen.push(state));

    await player.load(VIDEO, 0, false);
    await player.play();
    player.tick(1_000);
    await player.seek(100);
    player.tick(100);
    await player.pause();

    expect(seen).toEqual(['cued', 'playing', 'buffering', 'playing', 'paused']);
  });

  it('fires ready late, so a subscriber that arrives after load still hears it', async () => {
    const player = new FakePlayer();
    await player.load(VIDEO, 0, false);

    let fired = 0;
    player.on('ready', () => {
      fired += 1;
    });
    expect(fired).toBe(1);
  });

  it('stops delivering events after destroy', async () => {
    const player = await playing();
    let changes = 0;
    player.on('statechange', () => {
      changes += 1;
    });

    player.destroy();
    await player.play();
    player.tick(1_000);

    expect(changes).toBe(0);
  });
});

describe('getPositionPrecise', () => {
  it('timestamps samples on the simulated clock by default', async () => {
    const player = await playing();
    player.tick(1_000);

    const sample = player.getPositionPrecise();
    expect(sample.position).toBeCloseTo(1, 9);
    expect(sample.measuredAtMs).toBe(POST_SEEK_BLIND_MS + 1_000);
  });

  it('uses a caller-supplied clock when the harness has its own timebase', async () => {
    let harnessNow = 5_000;
    const player = new FakePlayer({ durationSec: 600, seekLatencyMs: 0, now: () => harnessNow });
    await player.load(VIDEO, 0, false);
    harnessNow += POST_SEEK_BLIND_MS;
    await player.play();

    player.tick(1_000);
    harnessNow += 1_000;

    expect(player.getPositionPrecise().measuredAtMs).toBe(6_700);
    expect(player.isReadyForMeasurement()).toBe(true);
  });
});
