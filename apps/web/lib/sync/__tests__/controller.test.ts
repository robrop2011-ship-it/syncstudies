/**
 * The §8.6 drift loop, exercised end to end.
 *
 * This is the cheap half of PLAN.md §15.3: the REAL `SyncController` against the
 * REAL `FakePlayer`, with injected clocks and no browser, no YouTube and no
 * network. Deterministic and fast.
 *
 * Using `FakePlayer` rather than a purpose-built stub is the point. It models the
 * three player behaviours the loop's arithmetic actually depends on — a seek
 * costs wall-clock time before playback resumes, positions are not measurable
 * during the post-seek blind window (§5.3 quirk 2), and the rate ladder is
 * coarse so the gentle rate nudge is unavailable (§5.3 quirk 4). A stub that
 * smoothed those over would green-light a loop that stutters in production.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEAD_ZONE_SEC,
  DRIFT_TICK_MS,
  IDLE_ANCHOR,
  MIN_MICRO_SEEK_GAP_MS,
  POST_SEEK_BLIND_MS,
  SEEK_LATENCY_INIT_MS,
  type PlayerAdapter,
  type VideoAnchor,
} from '@syncstudy/shared';
import { FakePlayer, type FakePlayerOptions } from '@/lib/sync/players/fake';
import { SyncController, type ControlIntent } from '@/lib/sync/controller';
import type { SyncClock, SyncStatus } from '@/lib/sync/types';

const VIDEO_REF = 'aaaaaaaaaaa';
const START_SEC = 100;
/** Long enough to clear both the load's blind window and its buffering cost. */
const SETTLE_MS = 1_000;

function anchorAt(atSec: number, serverMs: number, status: VideoAnchor['status']): VideoAnchor {
  return {
    ...IDLE_ANCHOR,
    provider: 'youtube',
    videoRef: VIDEO_REF,
    durationSec: 3_600,
    status,
    anchorPositionSec: atSec,
    anchorServerMs: serverMs,
    revision: 1,
  };
}

interface HarnessOptions extends FakePlayerOptions {
  /** Swap in a player with continuous rates, to reach the HTML5 branch. */
  player?: FakePlayer;
}

function buildHarness(opts: HarnessOptions = {}) {
  const { player: injected, ...playerOpts } = opts;
  let mono = 10_000;
  let serverMs = 1_700_000_000_000;

  const syncCalls: number[] = [];
  const sent: ControlIntent[] = [];
  const statuses: SyncStatus[] = [];
  const buffering: { buffering: boolean; positionSec: number }[] = [];
  const seeks: { target: number; atMono: number; expected: number }[] = [];
  const plays: number[] = [];
  const pauses: number[] = [];
  const rates: number[] = [];

  const player = injected ?? new FakePlayer({ ...playerOpts, now: () => mono });

  let anchor: VideoAnchor = { ...IDLE_ANCHOR };

  /** Where the room is, by the anchor, right now. */
  function expectedNow(): number {
    if (anchor.status !== 'playing') return anchor.anchorPositionSec;
    return anchor.anchorPositionSec + (serverMs - anchor.anchorServerMs) / 1000;
  }

  // Recorded by wrapping rather than by a mock, so the real implementation still
  // runs — the tests below depend on a seek actually costing time. The room's
  // position is captured WITH each seek: a playing room moves, so comparing a
  // seek target against `expectedNow()` at assertion time measures the test's own
  // elapsed time rather than the controller's aim.
  const realSeek = player.seek.bind(player);
  player.seek = (sec: number, allowSeekAhead?: boolean) => {
    seeks.push({ target: sec, atMono: mono, expected: expectedNow() });
    return realSeek(sec, allowSeekAhead);
  };
  const realPlay = player.play.bind(player);
  player.play = () => {
    plays.push(mono);
    return realPlay();
  };
  const realPause = player.pause.bind(player);
  player.pause = () => {
    pauses.push(mono);
    return realPause();
  };
  const realSetRate = player.setRate.bind(player);
  player.setRate = (rate: number) => {
    rates.push(rate);
    realSetRate(rate);
  };

  let ackOk = true;

  // Deliberately deferred: a real clock sync takes a few hundred milliseconds,
  // and the §8.9 rule under test is about what must NOT happen while one is in
  // flight. A sync that resolved instantly would make that window unobservable.
  const pendingSyncs: (() => void)[] = [];
  const clock: SyncClock = {
    now: () => serverMs,
    isReady: true,
    sync: (count?: number) => {
      syncCalls.push(count ?? 0);
      return new Promise<void>((resolve) => pendingSyncs.push(resolve));
    },
  };

  const controller = new SyncController({
    player,
    clock,
    getAnchor: () => anchor,
    canControl: () => true,
    sendControl: (cmd) => {
      sent.push(cmd);
      return Promise.resolve(
        ackOk ? { ok: true, anchor } : { ok: false, reason: 'recently_changed' as const, anchor },
      );
    },
    reportBuffering: (isBuffering, positionSec) =>
      buffering.push({ buffering: isBuffering, positionSec }),
    reportDrift: () => undefined,
    onStatus: (status) => statuses.push(status),
    now: () => mono,
  });

  /** Step the monotonic clock, the server clock, playback and timers together. */
  async function advance(ms: number, stepMs = 50): Promise<void> {
    for (let elapsed = 0; elapsed < ms; elapsed += stepMs) {
      mono += stepMs;
      serverMs += stepMs;
      player.tick(stepMs);
      // The async form flushes microtasks, so the promises the controller chains
      // off play()/load() actually resolve — without it the autoplay gate never
      // completes and every test measures a player stuck mid-handshake.
      await vi.advanceTimersByTimeAsync(stepMs);
    }
  }

  function clearLog(): void {
    seeks.length = 0;
    plays.length = 0;
    pauses.length = 0;
    rates.length = 0;
  }

  return {
    player,
    controller,
    advance,
    expectedNow,
    clearLog,
    syncCalls,
    sent,
    statuses,
    buffering,
    seeks,
    plays,
    pauses,
    rates,
    getAnchor: () => anchor,
    setAckOk: (ok: boolean) => {
      ackOk = ok;
    },
    nowServer: () => serverMs,
    /** Let every in-flight clock sync complete, then drain the microtask queue. */
    async settleClockSync(): Promise<void> {
      for (const resolve of pendingSyncs.splice(0)) resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    /**
     * Mount the way the room does: the component builds the player for the
     * current video, tells the controller it is already loaded, then the loop
     * starts. `driftSec` is signed, + meaning the player is AHEAD of the room.
     */
    async mount(
      status: 'playing' | 'paused',
      { driftSec = 0 }: { driftSec?: number } = {},
    ): Promise<void> {
      await player.load(VIDEO_REF, START_SEC, status === 'playing');
      await advance(SETTLE_MS);
      anchor = anchorAt(player.getPosition() - driftSec, serverMs, status);
      clearLog();
      controller.noteLoadedVideo(VIDEO_REF);
      controller.start();
    },
    /**
     * Shove the player off the room's timeline by a signed number of seconds,
     * then wait out the player's own blind window so the next tick can measure.
     */
    async knockOutOfSync(seconds: number): Promise<void> {
      await realSeek(expectedNow() + seconds, false);
      // Long enough for the player's own blind window to expire AND for a tick
      // to land after it — the two are independent grids.
      await advance(POST_SEEK_BLIND_MS + DRIFT_TICK_MS * 2);
    },
  };
}

/** A player with continuous rates, so the §8.6 soft-band nudge is reachable. */
class FineRatePlayer extends FakePlayer {
  readonly requestedRates: number[] = [];

  override supportsFineRates(): boolean {
    return true;
  }

  /** Records rather than snapping, so the nudge value itself is observable. */
  override setRate(rate: number): void {
    this.requestedRates.push(rate);
  }
}

describe('SyncController — §8.6 drift correction', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does nothing while inside the dead zone', async () => {
    const h = buildHarness();
    await h.mount('playing', { driftSec: DEAD_ZONE_SEC / 2 });

    await h.advance(DRIFT_TICK_MS * 8);

    expect(h.seeks).toHaveLength(0);
    expect(h.controller.getStatus().drift).toBe('in_sync');
    h.controller.stop();
  });

  it('converges a joining client onto the room without measuring first', async () => {
    const h = buildHarness();
    // Five seconds behind at the moment of mount — a late join.
    await h.mount('playing', { driftSec: -5 });

    // §8.7: a join goes straight to the anchor, and aims a seek-latency AHEAD so
    // that by the time playback resumes the position is right. Aiming AT the
    // room lands one latency behind and the next tick wants to seek again.
    const landing = h.seeks[0];
    expect((landing?.target ?? 0) - (landing?.expected ?? 0)).toBeCloseTo(
      SEEK_LATENCY_INIT_MS / 1000,
      2,
    );
    h.controller.stop();
  });

  it('hard-seeks past the expected position when drift opens up mid-session', async () => {
    const h = buildHarness();
    await h.mount('playing');
    await h.advance(DRIFT_TICK_MS * 2);
    h.clearLog();

    await h.knockOutOfSync(-5); // the hard band

    expect(h.seeks).toHaveLength(1);
    const lead = (h.seeks[0]?.target ?? 0) - (h.seeks[0]?.expected ?? 0);
    expect(lead).toBeGreaterThan(0);
    expect(lead).toBeLessThan(0.6);
    h.controller.stop();
  });

  it('status mismatch wins over position drift: room playing, player paused', async () => {
    const h = buildHarness();
    await h.mount('playing');
    await h.advance(DRIFT_TICK_MS * 2);
    h.clearLog();

    // Zero position drift; only the status is wrong. A player that is paused
    // while the room plays is infinitely out of sync one second from now.
    await h.player.pause();
    await h.advance(DRIFT_TICK_MS * 2);

    expect(h.seeks.length).toBeGreaterThan(0);
    expect(h.plays.length).toBeGreaterThan(0);
    h.controller.stop();
  });

  it('status mismatch: room paused, player playing → pause and freeze at the anchor', async () => {
    const h = buildHarness();
    await h.mount('paused');
    await h.advance(SETTLE_MS);
    h.clearLog();

    await h.player.play();
    await h.advance(DRIFT_TICK_MS * 2);

    expect(h.pauses.length).toBeGreaterThan(0);
    expect(h.seeks.map((s) => s.target)).toContain(h.getAnchor().anchorPositionSec);
    h.controller.stop();
  });

  it('leaves a paused room alone until the drift exceeds the soft band', async () => {
    const h = buildHarness();
    await h.mount('paused');
    await h.advance(SETTLE_MS);
    h.clearLog();

    await h.knockOutOfSync(0.9); // inside SOFT_MAX_SEC
    await h.advance(DRIFT_TICK_MS * 4);
    expect(h.seeks).toHaveLength(0);

    await h.knockOutOfSync(3); // outside it
    await h.advance(DRIFT_TICK_MS * 2);
    expect(h.seeks.map((s) => s.target)).toContain(h.getAnchor().anchorPositionSec);
    h.controller.stop();
  });

  it('micro-seeks at most once per MIN_MICRO_SEEK_GAP_MS in the soft band', async () => {
    // A player whose clock runs 30% slow: drift accumulates continuously at
    // 0.3 s/s, which is exactly the case the soft band exists for.
    const h = buildHarness({ rateError: 0.7 });
    await h.mount('playing');
    await h.advance(15_000);

    expect(h.seeks.length).toBeGreaterThan(1);
    for (let i = 1; i < h.seeks.length; i += 1) {
      const gap = (h.seeks[i]?.atMono ?? 0) - (h.seeks[i - 1]?.atMono ?? 0);
      expect(gap).toBeGreaterThanOrEqual(MIN_MICRO_SEEK_GAP_MS);
    }
    // …and the drift never got away: continuous correction is the whole point.
    expect(Math.abs(h.player.getPosition() - h.expectedNow())).toBeLessThan(2);
    h.controller.stop();
  });

  it('re-syncs the clock BEFORE seeking on a §8.9-sized drift', async () => {
    const h = buildHarness();
    await h.mount('playing');
    await h.advance(DRIFT_TICK_MS * 2);
    h.clearLog();
    const syncsBefore = h.syncCalls.length;

    await h.knockOutOfSync(120); // two minutes: far likelier a sleeping laptop

    // A clock re-sync was asked for, and NOTHING was seeked on the strength of a
    // reading that is probably an NTP step.
    expect(h.syncCalls.length).toBeGreaterThan(syncsBefore);
    expect(h.seeks).toHaveLength(0);

    // Once the clock has spoken the reading is believed and acted on — a real
    // two-minute jump (somebody seeked) still has to be corrected.
    await h.settleClockSync();
    expect(h.seeks).toHaveLength(1);
    h.controller.stop();
  });

  it('reports a stall after BUFFERING_REPORT_AFTER_MS and hard-seeks once on recovery', async () => {
    // An ad break: §5.3 quirk 6, the biggest source of real drift spikes.
    const h = buildHarness({ stalls: [{ atSec: START_SEC + 3, forSec: 6 }] });
    await h.mount('playing');
    await h.advance(2_000);
    h.clearLog();
    expect(h.buffering).toHaveLength(0);

    await h.advance(3_000); // into the stall, past the 1.2s reporting threshold
    expect(h.buffering[0]?.buffering).toBe(true);
    expect(h.controller.getStatus().drift).toBe('stalled');
    // Corrections are suppressed while stalled — seeking a player that is not
    // playing just makes it buffer again.
    expect(h.seeks).toHaveLength(0);

    await h.advance(6_000); // out the other side
    expect(h.buffering.at(-1)?.buffering).toBe(false);
    // One hard seek on recovery, cooldown ignored, then back in sync.
    expect(h.seeks.length).toBeGreaterThan(0);
    await h.advance(2_000);
    expect(Math.abs(h.player.getPosition() - h.expectedNow())).toBeLessThan(1);
    h.controller.stop();
  });

  it('applies an intent optimistically and does not correct it while it settles', async () => {
    const h = buildHarness();
    await h.mount('playing');
    await h.advance(DRIFT_TICK_MS);
    h.clearLog();

    void h.controller.seek(400);
    await Promise.resolve();

    // Local first: the player moved before any ack came back.
    //
    // Two different numbers on purpose. The CONTROL carries exactly what the user
    // asked for — the server compensates for flight time, so the room's timeline
    // lands on 400. The local PLAYER is aimed one seek-latency further on, because
    // it will spend that long buffering while the room keeps advancing; seeking it
    // to a flat 400 leaves the person who scrubbed permanently trailing the room
    // they just steered, inside the dead zone where nothing corrects it.
    const lead = SEEK_LATENCY_INIT_MS / 1000;
    expect(h.seeks.map((s) => s.target)).toEqual([400 + lead]);
    expect(h.sent.at(-1)).toEqual({ action: 'seek', positionSec: 400 });

    // …and the loop does not "correct" the change we just made (§5.3 quirk 2),
    // even though the anchor still says 100 and the drift is now enormous.
    await h.advance(POST_SEEK_BLIND_MS - 100);
    expect(h.seeks).toHaveLength(1);
    h.controller.stop();
  });

  it('reverts to the authoritative anchor when a control is rejected, and never retries', async () => {
    const h = buildHarness();
    await h.mount('playing');
    await h.advance(DRIFT_TICK_MS);
    h.clearLog();

    h.setAckOk(false);
    await h.controller.seek(900);

    // One emit, not two: replaying a stale seek is worse than dropping it.
    expect(h.sent.filter((c) => c.action === 'seek')).toHaveLength(1);
    // And the player is back on the room's timeline rather than left at 900.
    const revert = h.seeks.at(-1);
    expect((revert?.target ?? 0) - (revert?.expected ?? 0)).toBeCloseTo(
      SEEK_LATENCY_INIT_MS / 1000,
      1,
    );
    h.controller.stop();
  });

  it('throttles scrub emits to one per SCRUB_EMIT_INTERVAL_MS', async () => {
    const h = buildHarness();
    await h.mount('playing');
    await h.advance(DRIFT_TICK_MS);
    h.clearLog();

    // A drag: sixty pointermove events over a third of a second.
    for (let i = 0; i < 60; i += 1) {
      h.controller.previewSeek(200 + i);
      await h.advance(5, 5);
    }
    expect(h.sent.filter((c) => c.action === 'seek').length).toBeLessThanOrEqual(1);

    await h.controller.commitSeek(400);
    expect(h.sent.at(-1)).toEqual({ action: 'seek', positionSec: 400 });
    h.controller.stop();
  });

  it('nudges the rate rather than seeking when the player has fine rates', async () => {
    const fine = new FineRatePlayer();
    const h = buildHarness({ player: fine });
    await h.mount('playing');
    await h.advance(DRIFT_TICK_MS * 2);
    h.clearLog();

    await h.knockOutOfSync(-0.8); // soft band

    expect(h.seeks).toHaveLength(0);
    // Behind → speed up, by at most the ±0.10 §8.6 allows.
    const nudged = fine.requestedRates.at(-1) ?? 0;
    expect(nudged).toBeGreaterThan(1);
    expect(nudged).toBeLessThanOrEqual(1.1);
    h.controller.stop();
  });

  it('never emits a control for a user who may not drive playback', async () => {
    const h = buildHarness();
    await h.mount('playing');
    h.controller.stop();

    const viewer = new SyncController({
      player: h.player as PlayerAdapter,
      clock: { now: h.nowServer, isReady: true, sync: () => Promise.resolve() },
      getAnchor: h.getAnchor,
      canControl: () => false,
      sendControl: () => {
        throw new Error('a viewer without permission must never reach the wire');
      },
      reportBuffering: () => undefined,
      reportDrift: () => undefined,
      onStatus: () => undefined,
    });
    await expect(viewer.play()).resolves.toBeUndefined();
    await expect(viewer.pause()).resolves.toBeUndefined();
    await expect(viewer.seek(10)).resolves.toBeUndefined();
  });

  it('stop() releases the loop', async () => {
    const h = buildHarness();
    await h.mount('playing');
    await h.advance(DRIFT_TICK_MS);
    h.controller.stop();
    h.clearLog();

    await h.knockOutOfSync(-50); // wildly out of sync
    await h.advance(DRIFT_TICK_MS * 10);
    expect(h.seeks).toHaveLength(0);
    h.controller.stop(); // idempotent
  });
});
