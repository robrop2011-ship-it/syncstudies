/**
 * How long this client's player actually takes to land a seek (PLAN.md §8.6).
 *
 * The reason this file exists, in one sentence: seeking to `expected` puts you
 * `latency` behind, because by the time the player is really playing again the
 * room has moved on. So the drift loop seeks to `expected + estimatedSeekLatency()`
 * and the seek lands *on* the room instead of one seek-latency behind it —
 * otherwise every hard seek is immediately followed by a tick that measures
 * ~250 ms of drift and wants to seek again, which is a stutter loop that looks
 * exactly like a broken player.
 *
 * It is measured rather than assumed because the spread is enormous: a warm
 * buffered seek on a desktop is ~90 ms, a cold seek on a phone on hotel Wi-Fi is
 * closer to a second, and a single constant is wrong for both. EWMA with
 * α = SEEK_LATENCY_ALPHA, seeded at SEEK_LATENCY_INIT_MS, clamped to
 * [SEEK_LATENCY_MIN_MS, SEEK_LATENCY_MAX_MS].
 *
 * The subtle part is deciding when a seek has "landed", because
 * `getCurrentTime()` keeps returning the PRE-seek value for 100–400 ms after
 * `seekTo()` (§5.3 quirk 2). Checking only `state === 'playing'` would therefore
 * measure the wrong thing on a backward seek, where the stale value is already
 * past the target. `observe()` requires the reported position to be *inside a
 * window around the target* — which the stale value is not, in either direction.
 */
import {
  DEAD_ZONE_SEC,
  SEEK_LATENCY_ALPHA,
  SEEK_LATENCY_INIT_MS,
  SEEK_LATENCY_MAX_MS,
  SEEK_LATENCY_MIN_MS,
  type PlayerState,
} from '@syncstudy/shared';

/**
 * How close the reported position must be to the target to count as "landed".
 *
 * Deliberately the dead zone: that is the resolution below which we have already
 * decided two positions are indistinguishable, so it is the smallest honest
 * tolerance available. Anything tighter would reject real landings on a player
 * that reports at 4 Hz.
 */
const SETTLE_TOLERANCE_SEC = DEAD_ZONE_SEC;

/**
 * Beyond this, whatever we measured was not a seek — it was an ad break or a
 * rebuffer that happened to start with a seek. Folding a 30-second stall into
 * the estimate would push it to the clamp ceiling and keep it there for minutes,
 * making every subsequent seek overshoot by 1.2 s.
 */
const ABANDON_AFTER_MS = SEEK_LATENCY_MAX_MS * 4;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export class SeekLatencyEstimator {
  private valueMs = SEEK_LATENCY_INIT_MS;
  private pending: { targetSec: number; startedAtMs: number } | null = null;
  private readonly now: () => number;

  /** `now` is injectable so the simulator can drive it without a real clock. */
  constructor(now?: () => number) {
    this.now = now ?? (() => performance.now());
  }

  get millis(): number {
    return this.valueMs;
  }

  /** The form the drift loop actually uses: `expected + estimator.seconds`. */
  get seconds(): number {
    return this.valueMs / 1000;
  }

  /** Call immediately before `player.seek(targetSec)`. */
  begin(targetSec: number): void {
    this.pending = { targetSec, startedAtMs: this.now() };
  }

  /** The seek was superseded, rejected, or the player went away. */
  cancel(): void {
    this.pending = null;
  }

  /**
   * Feed every position observation in — from the tick loop and from the
   * player's own `statechange`, since the state change is usually the earlier
   * and therefore more accurate of the two.
   */
  observe(state: PlayerState, positionSec: number, playbackRate = 1): void {
    const pending = this.pending;
    if (pending === null) return;

    const elapsedMs = this.now() - pending.startedAtMs;
    if (elapsedMs > ABANDON_AFTER_MS) {
      this.pending = null;
      return;
    }
    // "Playing at the new position" — a player that seeked and then sat in
    // `buffering` has not finished the thing we are timing.
    if (state !== 'playing') return;
    if (!Number.isFinite(positionSec)) return;

    // Playback keeps advancing while we wait, so the upper bound has to grow
    // with the wait. The lower bound does not: nothing moves backwards.
    const advanced = Math.max(0, elapsedMs / 1000) * (playbackRate > 0 ? playbackRate : 1);
    if (positionSec < pending.targetSec - SETTLE_TOLERANCE_SEC) return;
    if (positionSec > pending.targetSec + SETTLE_TOLERANCE_SEC + advanced) return;

    this.pending = null;
    this.valueMs = clamp(
      this.valueMs * (1 - SEEK_LATENCY_ALPHA) + elapsedMs * SEEK_LATENCY_ALPHA,
      SEEK_LATENCY_MIN_MS,
      SEEK_LATENCY_MAX_MS,
    );
  }

  /** A new video (or a cold resume) invalidates everything we learned. */
  reset(): void {
    this.valueMs = SEEK_LATENCY_INIT_MS;
    this.pending = null;
  }
}
