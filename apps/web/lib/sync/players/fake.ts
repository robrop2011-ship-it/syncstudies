/**
 * A deterministic PlayerAdapter for the sync simulator and unit tests
 * (PLAN.md §15.3, §5.3).
 *
 * The simulator's whole value is that it is deterministic and fast: it runs the
 * real `SyncController` and the real server logic against fake players and a
 * fake transport, so `DEAD_ZONE_SEC`, `HARD_SEEK_AT_SEC` and `CONTROL_LOCK_MS`
 * can be tuned in minutes instead of by hand-testing with friends. That only
 * holds if nothing in here reaches for a clock or a random number. So:
 *
 *   - no `setTimeout`, no `setInterval`, no `Date.now()`, no `performance.now()`;
 *   - no `Math.random()`;
 *   - time advances ONLY through `tick(deltaMs)`, driven by the harness;
 *   - the caller may supply `now()` to put `measuredAtMs` on the harness's own
 *     timebase; otherwise the player's internal simulated wall clock is used.
 *
 * ── WHAT IS MODELLED, AND WHY ────────────────────────────────────────────────
 * Exactly the three things that actually cause drift in the field:
 *
 *   1. SEEK LATENCY. A seek does not land instantly; the player buffers for a
 *      while and only then resumes. This is why §8.6 seeks to
 *      `expected + estimatedSeekLatency()` rather than to `expected` — without
 *      modelling it, every correction in the simulator would land perfectly and
 *      the seek-latency EWMA would never be exercised.
 *   2. STALLS. An ad break or a bad connection freezes position for seconds
 *      while wall-clock time keeps running. This is the input that produces the
 *      5–30 s drift spikes of §5.3(6) and drives `wait_for_slow` (§8.10).
 *   3. RATE ERROR. Two players decoding the same stream do not advance at
 *      exactly the same speed. A 0.2 % error is 7 seconds over an hour, which is
 *      well past `HARD_SEEK_AT_SEC` — this is what makes the drift loop
 *      necessary at all, rather than a one-time alignment at join.
 *
 * ── WHAT IS DELIBERATELY NOT MODELLED ────────────────────────────────────────
 * YouTube's ~4 Hz position quantisation (§5.3 quirk 1). `getPositionPrecise()`
 * here always returns a fresh sample. That is on purpose: the simulator is
 * measuring the sync ALGORITHM, and folding in a sampling artefact of one
 * particular player would make the tuning table in §8.6 describe YouTube's
 * quantiser rather than our control loop. `DEAD_ZONE_SEC` is already sized for
 * that artefact.
 */
import {
  POST_SEEK_BLIND_MS,
  SEEK_LATENCY_INIT_MS,
  type PlayerAdapter,
  type PlayerState,
  type PositionSample,
} from '@syncstudy/shared';
import { PlayerEmitter } from './emitter';

export interface FakePlayerOptions {
  durationSec?: number;
  /** Wall-clock ms a seek takes before playback resumes. Default 250. */
  seekLatencyMs?: number;
  /** Scheduled stalls, e.g. an ad break: [{ atSec, forSec }]. */
  stalls?: { atSec: number; forSec: number }[];
  /** Multiplier on how fast this player's clock advances (1 = perfect). */
  rateError?: number;
  now?: () => number;
}

/** A typical lecture. Long enough that a 30-minute simulator run stays inside it. */
const DEFAULT_DURATION_SEC = 3_600;

/**
 * Seconds of video a healthy player keeps buffered ahead of the playhead. Only
 * shapes `getBufferedFraction()`, which the scrubber renders (§12.4).
 */
const BUFFER_AHEAD_SEC = 30;

/**
 * The same coarse ladder YouTube exposes (§5.3 quirk 4), and `setRate` snaps to
 * it the same way. The simulator MUST see this, because it is what makes the
 * gentle rate-nudge correction impossible and the micro-seek branch the real
 * one: a fake player with continuous rates would validate a code path that
 * never runs in production.
 */
const COARSE_RATES: readonly number[] = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

/** Guards the sub-stepping loop in `tick` against a pathological schedule. */
const MAX_TICK_STEPS = 64;

/** Floor on a sub-step, so floating-point noise can never stall the loop. */
const MIN_STEP_MS = 1e-6;

interface ScheduledStall {
  atSec: number;
  forSec: number;
  fired: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export class FakePlayer extends PlayerEmitter implements PlayerAdapter {
  private readonly durationSec: number;
  private readonly seekLatencyMs: number;
  private readonly rateError: number;
  private readonly stalls: ScheduledStall[];
  private readonly nowFn: (() => number) | null;

  /** Simulated wall clock, in ms. Advanced only by `tick`. */
  private wallMs = 0;
  private positionSec = 0;
  private state: PlayerState = 'unstarted';
  /**
   * What the player is trying to do, as distinct from what it is doing. A stall
   * during playback leaves `state === 'buffering'` while intent stays `playing`,
   * which is how it knows to resume rather than stay stopped.
   */
  private intent: 'playing' | 'paused' = 'paused';

  private loadedRef: string | null = null;
  private muted = false;
  private volume = 1;
  private rate = 1;
  private destroyed = false;

  /** Wall-clock instant a pending seek finishes buffering; null when idle. */
  private seekDoneAtMs: number | null = null;
  /** Wall-clock instant the current stall ends; null when not stalled. */
  private stallDoneAtMs: number | null = null;
  /** Mirrors the YouTube adapter's post-seek blind window (§5.3 quirk 2). */
  private suppressUntilMs = 0;

  constructor(opts: FakePlayerOptions = {}) {
    super();
    this.durationSec = opts.durationSec ?? DEFAULT_DURATION_SEC;
    this.seekLatencyMs = opts.seekLatencyMs ?? SEEK_LATENCY_INIT_MS;
    this.rateError = opts.rateError ?? 1;
    this.nowFn = opts.now ?? null;
    // `atSec` is a position IN THE VIDEO, not a wall-clock offset — an ad break
    // happens at a point in the lecture. Sorted so `nextStepMs` can stop at the
    // first one ahead of the playhead.
    this.stalls = (opts.stalls ?? [])
      .map((s) => ({ atSec: s.atSec, forSec: s.forSec, fired: false }))
      .sort((a, b) => a.atSec - b.atSec);
  }

  /**
   * Advance simulated time. The simulator drives this instead of a real clock.
   *
   * The delta is walked in sub-steps that stop at every scheduled event — a seek
   * completing, a stall ending, a stall's position being reached, the end of the
   * video — so a 500 ms tick that contains a 4 s ad break's trigger point starts
   * the stall at exactly the right position rather than up to 500 ms late. That
   * precision is what makes two runs with different `tickMs` produce the same
   * answer, which is the property the whole harness rests on.
   */
  tick(deltaMs: number): void {
    if (this.destroyed || !(deltaMs > 0)) return;

    let remaining = deltaMs;
    for (let guard = 0; remaining > 0 && guard < MAX_TICK_STEPS; guard += 1) {
      this.settle();
      const step = Math.max(MIN_STEP_MS, Math.min(remaining, this.nextStepMs()));
      this.wallMs += step;
      if (this.state === 'playing') {
        this.positionSec = clamp(
          this.positionSec + (step / 1000) * this.effectiveSpeed(),
          0,
          this.durationSec,
        );
      }
      remaining -= step;
    }
    this.settle();
  }

  /** Seconds of video consumed per second of wall clock. */
  private effectiveSpeed(): number {
    return this.rate * this.rateError;
  }

  /** Wall-clock ms until the next thing that changes behaviour. */
  private nextStepMs(): number {
    if (this.seekDoneAtMs !== null) return this.seekDoneAtMs - this.wallMs;
    if (this.stallDoneAtMs !== null) return this.stallDoneAtMs - this.wallMs;
    if (this.state !== 'playing') return Number.POSITIVE_INFINITY;

    const speed = this.effectiveSpeed();
    if (speed <= 0) return Number.POSITIVE_INFINITY;

    let soonest = ((this.durationSec - this.positionSec) / speed) * 1000;
    for (const stall of this.stalls) {
      if (stall.fired || stall.atSec <= this.positionSec) continue;
      soonest = Math.min(soonest, ((stall.atSec - this.positionSec) / speed) * 1000);
      break; // sorted, so the first one ahead is the nearest
    }
    return soonest;
  }

  /** Fire every event that is due at the current instant. */
  private settle(): void {
    if (this.seekDoneAtMs !== null && this.wallMs >= this.seekDoneAtMs) {
      this.seekDoneAtMs = null;
      this.setState(this.intent === 'playing' ? 'playing' : 'paused');
    }

    if (this.stallDoneAtMs !== null && this.wallMs >= this.stallDoneAtMs) {
      this.stallDoneAtMs = null;
      this.setState(this.intent === 'playing' ? 'playing' : 'paused');
    }

    if (this.state === 'playing') {
      for (const stall of this.stalls) {
        if (stall.fired || stall.atSec > this.positionSec) continue;
        stall.fired = true;
        this.stallDoneAtMs = this.wallMs + stall.forSec * 1000;
        this.setState('buffering');
        break;
      }
    }

    if (this.state === 'playing' && this.positionSec >= this.durationSec) {
      this.intent = 'paused';
      this.setState('ended');
    }
  }

  private setState(next: PlayerState): void {
    if (this.state === next) return;
    this.state = next;
    this.emit('statechange', next);
  }

  private nowMs(): number {
    return this.nowFn === null ? this.wallMs : this.nowFn();
  }

  /**
   * Re-arm the stall schedule around the current playhead.
   *
   * Called after every position jump. Stalls strictly behind the playhead count
   * as consumed — seeking past an ad break skips it, which is what actually
   * happens — and everything ahead is armed again, so seeking BACKWARDS over one
   * makes it fire a second time. Without this, a seek from 00:10 to 15:00 would
   * immediately trigger the ad break scheduled at 05:00.
   */
  private armStalls(): void {
    for (const stall of this.stalls) stall.fired = stall.atSec < this.positionSec;
  }

  // ── PlayerAdapter ─────────────────────────────────────────────────────────

  load(videoRef: string, startAtSec: number, autoplay: boolean): Promise<void> {
    if (this.destroyed) return Promise.resolve();

    this.loadedRef = videoRef;
    this.positionSec = clamp(startAtSec, 0, this.durationSec);
    // A fresh load re-arms the schedule: the ad break at 05:00 plays again if
    // the room loads the same lecture again.
    this.armStalls();
    this.stallDoneAtMs = null;
    this.suppressUntilMs = this.nowMs() + POST_SEEK_BLIND_MS;

    if (autoplay) {
      // Loading buffers for the same wall-clock cost as a seek — it is the same
      // operation from the network's point of view.
      this.intent = 'playing';
      this.seekDoneAtMs = this.wallMs + this.seekLatencyMs;
      this.setState('buffering');
    } else {
      this.intent = 'paused';
      this.seekDoneAtMs = null;
      this.setState('cued');
    }

    // No gesture policy to model, so unlike the YouTube adapter this never
    // rejects. A test that wants blocked autoplay should assert on the real
    // adapter's `AutoplayBlockedError`, not fake one here.
    this.emit('ready', undefined);
    return Promise.resolve();
  }

  play(): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    this.intent = 'playing';
    // Mid-stall or mid-seek the intent is recorded but the state is not forced:
    // `settle()` lands on `playing` when the buffer clears. Overriding here
    // would model a player that can play while it has nothing to play.
    if (this.state !== 'buffering') this.setState('playing');
    return Promise.resolve();
  }

  pause(): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    this.intent = 'paused';
    if (this.state === 'playing') this.setState('paused');
    return Promise.resolve();
  }

  seek(sec: number, allowSeekAhead?: boolean): Promise<void> {
    if (this.destroyed) return Promise.resolve();

    this.positionSec = clamp(sec, 0, this.durationSec);
    this.suppressUntilMs = this.nowMs() + POST_SEEK_BLIND_MS;
    // A stall belongs to the position it was scheduled at, not to the playhead;
    // seeking away from one ends it.
    this.stallDoneAtMs = null;
    this.armStalls();

    // `allowSeekAhead: false` is the scrub-preview form (§8.5c — a drag emits at
    // most one seek every SCRUB_EMIT_INTERVAL_MS, and the frames in between are
    // previews). It moves the playhead without asking the network for anything,
    // so it costs no latency.
    if (allowSeekAhead === false) {
      // Resolve from `intent`, guarding only on a still-pending seek.
      //
      // The old guard was `state !== 'buffering'`, which deadlocked: seeking away
      // from a stall clears `stallDoneAtMs` above — and that was the only pending
      // event that would ever have ended the buffering state — so if a stall was
      // in progress the guard failed, nothing rescheduled, and the player sat in
      // `buffering` for the rest of the run. A real seek has `seekDoneAtMs` to
      // bring it back; a preview has nothing, so it must settle here.
      if (this.seekDoneAtMs === null) {
        this.setState(this.intent === 'playing' ? 'playing' : 'paused');
      }
      return Promise.resolve();
    }

    this.seekDoneAtMs = this.wallMs + this.seekLatencyMs;
    this.setState('buffering');
    return Promise.resolve();
  }

  getPosition(): number {
    return this.positionSec;
  }

  getPositionPrecise(): PositionSample {
    // Always fresh — see "what is deliberately not modelled" at the top.
    return { position: this.positionSec, measuredAtMs: this.nowMs() };
  }

  getDuration(): number {
    return this.durationSec;
  }

  getState(): PlayerState {
    return this.state;
  }

  getBufferedFraction(): number {
    if (this.durationSec <= 0) return 0;
    const ahead = this.state === 'buffering' ? 0 : BUFFER_AHEAD_SEC;
    return clamp((this.positionSec + ahead) / this.durationSec, 0, 1);
  }

  mute(): void {
    this.muted = true;
  }

  unMute(): void {
    this.muted = false;
  }

  isMuted(): boolean {
    return this.muted;
  }

  setVolume(zeroToOne: number): void {
    this.volume = clamp(zeroToOne, 0, 1);
  }

  getVolume(): number {
    return this.volume;
  }

  getAvailableRates(): number[] {
    return [...COARSE_RATES];
  }

  /**
   * Snaps to the nearest available rate, exactly as YouTube's
   * `setPlaybackRate()` does. Asking for 1.05 gets you 1.0 and closes no drift
   * at all — which is the behaviour §8.6's micro-seek branch exists to avoid,
   * and which the simulator must therefore reproduce rather than smooth over.
   */
  setRate(rate: number): void {
    let best = COARSE_RATES[0] ?? 1;
    for (const candidate of COARSE_RATES) {
      if (Math.abs(candidate - rate) < Math.abs(best - rate)) best = candidate;
    }
    if (best === this.rate) return;
    this.rate = best;
    this.emit('ratechange', best);
  }

  getRate(): number {
    return this.rate;
  }

  /** False, for the same reason the YouTube adapter says false (§5.3 quirk 4). */
  supportsFineRates(): boolean {
    return false;
  }

  isReadyForMeasurement(): boolean {
    if (this.destroyed || this.loadedRef === null) return false;
    return this.nowMs() >= this.suppressUntilMs;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearListeners();
  }
}
