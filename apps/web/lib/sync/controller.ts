'use client';

/**
 * The drift loop (PLAN.md §8.6). This is the product.
 *
 * The shape of the whole design, so the code below reads as one idea rather than
 * fifteen special cases:
 *
 *   The server owns the timeline and publishes an ANCHOR, never a position. Every
 *   500 ms this client asks two questions — where does the anchor say the room is
 *   (`positionAt(anchor, clock.now())`), and where is my player actually — and
 *   applies THE SMALLEST INTERVENTION THAT CLOSES THE GAP. Nothing → rate nudge →
 *   micro-seek → hard seek. A hard seek is visible and rude; it is the last
 *   resort, not the strategy (§8.1 rule 3).
 *
 * Four things in here are not obvious and are all load-bearing:
 *
 *  1. **Status mismatch beats position drift.** A player that is paused while the
 *     room plays is infinitely out of sync a second from now, so it is fixed
 *     before any arithmetic about tenths of a second.
 *  2. **`estimatedSeekLatency()` is added to every corrective seek.** Without it
 *     every hard seek lands one seek-latency behind and the very next tick wants
 *     to seek again — a stutter loop indistinguishable from a broken player.
 *  3. **A huge drift is treated as a clock event, not a playback event** (§8.9).
 *     A laptop waking from sleep steps `Date.now()` by minutes. Seeking on that
 *     reading is violent and, if it was a clock event, wrong.
 *  4. **Corrections give up.** After three failures the loop backs off
 *     exponentially and reports 'poor' rather than seek-looping forever: a client
 *     that cannot converge is better off slightly behind and watchable than
 *     perfectly synced and stuttering.
 *
 * The controller is HEADLESS (§5.2): no React, no rendering, no setState at tick
 * rate. It publishes `SyncStatus` through `onStatus` only when a field actually
 * changed, and the live playhead never goes through it at all (`getPlayheadSec`
 * is read from a rAF loop through a ref).
 */
import {
  isAutoplayGateCode,
  PLAYER_ERROR_AUTOPLAY_BLOCKED,
  PLAYER_ERROR_AUTOPLAY_MUTED,
  BUFFERING_REPORT_AFTER_MS,
  CLOCK_SAMPLES_JOIN,
  CLOCK_SAMPLES_RESYNC,
  CLOCK_SAMPLES_VISIBLE,
  CLOCK_SAMPLE_SPACING_MS,
  CLOCK_SANITY_DRIFT_SEC,
  DEAD_ZONE_SEC,
  DRIFT_TICK_MS,
  HARD_SEEK_AT_SEC,
  JOIN_LOAD_LEAD_SEC,
  MIN_HARD_SEEK_GAP_MS,
  MIN_MICRO_SEEK_GAP_MS,
  POST_SEEK_BLIND_MS,
  SCRUB_EMIT_INTERVAL_MS,
  SOFT_MAX_SEC,
  clampToDuration,
  positionAt,
  type ControlAck,
  type PlayerAdapter,
  type PlayerErrorInfo,
  type PlayerState,
  type VideoAnchor,
} from '@syncstudy/shared';
import type { Schemas } from '@syncstudy/shared';
import { SeekLatencyEstimator } from '@/lib/sync/seek-latency';
import {
  IDLE_SYNC_STATUS,
  syncStatusEquals,
  type DriftState,
  type SyncClock,
  type SyncStatus,
} from '@/lib/sync/types';

/**
 * The wire command minus the two fields the transport owns. `clientSentAtMs` has
 * to be in SERVER time and `expectedRevision` has to be read at the instant of
 * the emit; both belong to whoever holds the clock and the store — the provider —
 * rather than to the loop (§8.4).
 */
export type ControlIntent = Omit<Schemas.VideoControl, 'clientSentAtMs' | 'expectedRevision'>;

export interface SyncControllerDeps {
  player: PlayerAdapter;
  /** `ServerClock` satisfies this; see SyncClock for why it is not named directly. */
  clock: SyncClock;
  /** Current authoritative anchor, read fresh on every tick. */
  getAnchor: () => VideoAnchor;
  /** True when this user may drive playback (canControlVideo). */
  canControl: () => boolean;
  /** Emit video:control and resolve with the server's ack. */
  sendControl: (cmd: ControlIntent) => Promise<ControlAck>;
  reportBuffering: (buffering: boolean, positionSec: number) => void;
  reportDrift: (t: {
    driftP50: number;
    driftP95: number;
    hardSeeks: number;
    clockOffsetMs: number;
  }) => void;
  onStatus: (status: SyncStatus) => void;
  /** Injectable monotonic clock, for the simulator (§15.3). Defaults to performance.now. */
  now?: () => number;
}

export type AnchorReason = 'control' | 'heartbeat' | 'resync' | 'set_video' | 'snapshot';

// ── the §8.6 numbers that shared/constants.ts does not name ─────────────────
// Everything that IS in @syncstudy/shared is imported above; these are the rest
// of the §8.6 pseudocode, named here rather than written inline at the use site.

/** Below this a micro-seek costs more (a visible hitch) than the drift it fixes. */
const MICRO_SEEK_MIN_SEC = 0.6;
/** `clamp(drift / 4, -0.10, 0.10)` — the soft-band rate nudge. */
const RATE_NUDGE_DIVISOR = 4;
const RATE_NUDGE_MAX = 0.1;
/** Used when the computed delta rounds to zero, so the restore window stays finite. */
const RATE_NUDGE_FLOOR = 0.05;
/** Cap the correction window so a nudge always resolves before the next user action. */
const RATE_RESTORE_MAX_MS = 4_000;
/** "After 3 consecutive failed corrections set quality 'poor'." */
const MAX_CONSECUTIVE_FAILURES = 3;
/** "…and back off exponentially (cap 8x)." */
const MAX_BACKOFF = 8;
/** Ticks of genuine calm before we take the 'poor' label back off. */
const QUALITY_RECOVERY_TICKS = 6;
/** §8.9: more wall-clock than this between ticks means the machine slept. */
const COLD_RESUME_GAP_MS = 30_000;
/** §8.7 step 6: the first ticks after a join may hard-seek without the cooldown. */
const JOIN_CONVERGENCE_TICKS = 3;
/** Telemetry cadence (§8.6: "every 30s call reportDrift"). */
const TELEMETRY_INTERVAL_MS = 30_000;
/** Window for `hardSeeksLastMinute`. */
const HARD_SEEK_WINDOW_MS = 60_000;
/** Two minutes of samples at DRIFT_TICK_MS: a stable p95, bounded memory. */
const DRIFT_SAMPLE_LIMIT = 240;
/**
 * Hysteresis on the published `driftSec`. A player reporting at 4 Hz makes the
 * measurement jitter by ±0.125 s forever; without this the room would re-render
 * twice a second to redraw a number nobody is reading (§5.4).
 */
const DRIFT_PUBLISH_EPSILON_SEC = 0.25;
/** Never extrapolate the displayed playhead further than this between samples. */
const PLAYHEAD_EXTRAPOLATION_MAX_SEC = 0.5;
/** A drag that never gets its pointerup must not freeze the scrubber forever. */
const SCRUB_PREVIEW_TTL_MS = 2_000;

interface TickOptions {
  /** Ignore MIN_HARD_SEEK_GAP_MS / MIN_MICRO_SEEK_GAP_MS for this one evaluation. */
  bypassCooldown?: boolean;
  /** For `resyncNow()`, which is an explicit user action and outranks the pause. */
  bypassPause?: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = clamp(Math.floor((sorted.length - 1) * p), 0, sorted.length - 1);
  return sorted[index] ?? 0;
}

/**
 * Where a joining client should load the video (§8.7 step 4).
 *
 * Aims JOIN_LOAD_LEAD_SEC ahead of the room when it is playing, because loading
 * and buffering take real time and landing behind means the first thing a new
 * joiner experiences is a correction. Exported so the component that constructs
 * the player and the controller that reloads it share one implementation.
 */
export function joinStartPositionSec(anchor: VideoAnchor, serverNowMs: number): number {
  const at = positionAt(anchor, serverNowMs);
  if (anchor.status !== 'playing') return at;
  return clampToDuration(at + JOIN_LOAD_LEAD_SEC, anchor);
}

/**
 * A mutable slot, so the socket layer can hand authoritative anchors to a
 * controller that does not exist yet.
 *
 * The controller cannot be built until a `PlayerAdapter` is attached, which
 * happens in a descendant component, while `video:state` starts arriving the
 * moment the socket connects. The alternative — the sync layer registering its
 * own socket listeners — makes the ORDER in which the store and the controller
 * see an anchor depend on listener registration order, and the controller reads
 * the anchor back out of the store. This way one handler updates the store and
 * then tells the controller, always in that order.
 */
export interface SyncBridge {
  controller: SyncController | null;
}

export function createSyncBridge(): SyncBridge {
  return { controller: null };
}

export class SyncController {
  private readonly deps: SyncControllerDeps;
  private readonly player: PlayerAdapter;
  private readonly mono: () => number;
  private readonly seekLatency: SeekLatencyEstimator;

  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = true;

  // ── measurement gates (all monotonic; §8.9 forbids Date.now for elapsed) ──
  private lastTickMono: number | null = null;
  private suppressUntilMono = 0;
  private lastHardSeekMono = Number.NEGATIVE_INFINITY;
  private lastMicroSeekMono = Number.NEGATIVE_INFINITY;
  private joinConvergenceTicks = JOIN_CONVERGENCE_TICKS;

  // ── failure handling (§8.6 step 5) ───────────────────────────────────────
  private consecutiveFailures = 0;
  private backoff = 1;
  private calmTicks = 0;

  // ── buffering (§8.10) ────────────────────────────────────────────────────
  private bufferingSinceMono: number | null = null;
  private bufferingReported = false;
  /** §5.3 quirk 6: one hard seek is allowed the moment a stall ends. */
  private recoveringFromStall = false;

  // ── clock sanity (§8.9) ──────────────────────────────────────────────────
  private clockSyncPending = false;
  private clockSanityTripped = false;

  // ── autoplay gate (§8.7) ─────────────────────────────────────────────────
  private gestureGranted = false;
  private gateRunning = false;
  /**
   * Distinct from `needsGesture`, and the distinction matters.
   *
   * `needsGesture` means "offer the user a tap" — which is also true in the happy
   * path, where muted autoplay WORKED and the tap is only an offer of sound.
   * This flag means "a play() attempt was actually refused", and it is the one
   * the drift loop checks before deciding not to fight the player. Conflating
   * them makes a successful muted autoplay permanently disable the
   * room-is-playing-but-we-are-paused correction, which is the single most
   * important correction there is.
   */
  private playbackBlocked = false;

  // ── intents ──────────────────────────────────────────────────────────────
  private transportConnected = true;
  private scrubPreviewSec: number | null = null;
  private scrubUntilMono = 0;
  private lastScrubEmitMono = Number.NEGATIVE_INFINITY;

  // ── rate nudge ───────────────────────────────────────────────────────────
  private rateRestoreTimer: ReturnType<typeof setTimeout> | null = null;
  private nudgedRate = false;

  // ── anchor bookkeeping ───────────────────────────────────────────────────
  private lastRevision = Number.NEGATIVE_INFINITY;
  private loadedVideoRef: string | null = null;
  private pendingEvaluation: ReturnType<typeof setTimeout> | null = null;

  // ── telemetry ────────────────────────────────────────────────────────────
  private driftSamples: number[] = [];
  private hardSeekTimes: number[] = [];
  private hardSeeksSinceReport = 0;
  private telemetryTimer: ReturnType<typeof setInterval> | null = null;

  // ── the published status, one field per SyncStatus key ───────────────────
  private driftState: DriftState = 'idle';
  private publishedDriftSec = 0;
  private autoSyncPaused = false;
  private autoSyncTimer: ReturnType<typeof setTimeout> | null = null;
  private bufferingFlag = false;
  private playerError: PlayerErrorInfo | null = null;
  private needsGesture = false;
  private mutedForAutoplay = false;
  private status: SyncStatus = { ...IDLE_SYNC_STATUS };
  private published = false;

  // ── playhead smoothing ───────────────────────────────────────────────────
  private playheadSample: { position: number; atMono: number } | null = null;
  private lastPlayhead: number | null = null;
  /** Null until the user (or the UI's initial read) has expressed a level. */
  private userVolume: number | null = null;
  private duckFactor = 1;

  private unsubscribes: (() => void)[] = [];
  private onVisibility: (() => void) | null = null;

  constructor(deps: SyncControllerDeps) {
    this.deps = deps;
    this.player = deps.player;
    this.mono = deps.now ?? (() => performance.now());
    this.seekLatency = new SeekLatencyEstimator(this.mono);
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /** Begin the drift loop. Idempotent. */
  start(): void {
    if (this.timer !== null) return;
    this.stopped = false;
    this.lastTickMono = null;
    this.joinConvergenceTicks = JOIN_CONVERGENCE_TICKS;

    this.unsubscribes.push(
      this.player.on('statechange', (state) => {
        this.observePlayerState(state);
      }),
    );
    this.unsubscribes.push(
      this.player.on('error', (error) => {
        // An adapter reports a REFUSED play on the same channel as a BROKEN video
        // (see PLAYER_ERROR_AUTOPLAY_* in the PlayerAdapter contract). They need
        // opposite handling: a refusal is a gate the user can clear with one tap,
        // and treating it as a fatal video error parks driftState at 'idle' — so
        // the loop stops correcting forever and the room silently desyncs for a
        // client whose only problem was an autoplay policy.
        if (isAutoplayGateCode(error.code)) {
          this.playbackBlocked = error.code === PLAYER_ERROR_AUTOPLAY_BLOCKED;
          this.setGesturePrompt(error.code === PLAYER_ERROR_AUTOPLAY_MUTED);
          return;
        }
        // An embed-denied video is not a drift problem and no amount of seeking
        // fixes it. Stop correcting and let the UI say so (§5.3 quirk 5).
        this.playerError = error;
        this.driftState = 'idle';
        this.publish();
      }),
    );

    // §8.9: a background tab has its timers throttled and a sleeping laptop stops
    // them entirely. Coming back must re-sync the clock and re-evaluate at once,
    // with the hard-seek cooldown out of the way — the cooldown exists to stop
    // seek loops, and this is the one moment a seek is certainly warranted.
    if (typeof document !== 'undefined') {
      const handler = (): void => {
        if (document.visibilityState !== 'visible') return;
        this.requestClockResync(CLOCK_SAMPLES_VISIBLE);
      };
      this.onVisibility = handler;
      document.addEventListener('visibilitychange', handler);
    }

    this.timer = setInterval(() => {
      this.tick();
    }, DRIFT_TICK_MS);

    this.telemetryTimer = setInterval(() => {
      this.flushTelemetry();
    }, TELEMETRY_INTERVAL_MS);

    // Seed from whatever the store already holds: the snapshot normally lands
    // before a player exists, so the join anchor is already waiting for us.
    const anchor = this.deps.getAnchor();
    if (anchor.status !== 'idle' && anchor.videoRef !== null) this.applyAnchor(anchor, 'snapshot');
    else this.publish();
  }

  /** Stop the loop and release every timer and listener. Idempotent. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.telemetryTimer !== null) {
      clearInterval(this.telemetryTimer);
      this.telemetryTimer = null;
    }
    if (this.autoSyncTimer !== null) {
      clearTimeout(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
    if (this.pendingEvaluation !== null) {
      clearTimeout(this.pendingEvaluation);
      this.pendingEvaluation = null;
    }
    this.restoreRate();
    if (this.onVisibility !== null) {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', this.onVisibility);
      }
      this.onVisibility = null;
    }
    for (const off of this.unsubscribes) off();
    this.unsubscribes = [];
    this.seekLatency.cancel();
    // Deliberately NOT destroying the player: this controller borrowed it from
    // whoever mounted the iframe, and destroying someone else's DOM on unmount is
    // how a re-render loses a player it was about to reuse.
  }

  /**
   * Tell the controller which video the attached player already has loaded.
   *
   * The component that owns the iframe constructs the player for the current
   * anchor's `videoRef`, so without this the controller's first `applyAnchor`
   * would see "not loaded" and call `load()` on a video that is already there —
   * a visible reload of the thing the user is watching.
   */
  noteLoadedVideo(videoRef: string | null): void {
    this.loadedVideoRef = videoRef;
  }

  // ── authoritative state ──────────────────────────────────────────────────

  /** Apply an authoritative anchor (from video:state or a snapshot). */
  applyAnchor(anchor: VideoAnchor, reason: AnchorReason): void {
    if (this.stopped) return;

    // A snapshot IS the truth, including after a room reset that rewound the
    // revision. Everything else is a stream that can be delivered late or twice,
    // and an anchor that rewinds the revision would undo a newer one (§8.5b).
    if (reason !== 'snapshot' && anchor.revision < this.lastRevision) return;
    this.lastRevision = anchor.revision;

    if (anchor.status === 'idle' || anchor.videoRef === null) {
      this.loadedVideoRef = null;
      this.setDriftState('idle');
      return;
    }

    if (anchor.videoRef !== this.loadedVideoRef) {
      // A new video: everything we learned about the old one is worthless.
      this.loadedVideoRef = anchor.videoRef;
      this.seekLatency.reset();
      this.resetConvergence();
      this.playerError = null;
      const startAt = joinStartPositionSec(anchor, this.deps.clock.now());
      this.suppressFor(POST_SEEK_BLIND_MS);
      void this.player
        .load(anchor.videoRef, startAt, false)
        .then(() => {
          if (this.stopped) return;
          this.runAutoplayGate(this.deps.getAnchor());
        })
        .catch(() => undefined);
      return;
    }

    if (reason === 'snapshot' || reason === 'set_video') {
      // A join, a late join, or a reconnect: the player's own position is either
      // meaningless or stale, so put it where the anchor says without measuring.
      this.resetConvergence();
      this.forceToAnchor(anchor);
      return;
    }

    // A heartbeat is a liveness signal carrying state we already have; the loop
    // picks it up on its own schedule. Forcing an evaluation on it would make
    // every client in the room re-measure in lockstep every 10 s for nothing.
    if (reason === 'heartbeat') return;

    // Somebody pressed something. Everyone else should feel it now rather than up
    // to DRIFT_TICK_MS later — but not before our own post-seek blind window has
    // passed, or we would measure a stale position and "correct" a change we just
    // made ourselves (§5.3 quirk 2).
    this.scheduleEvaluation();
  }

  /**
   * The transport is up or down (§8.8).
   *
   * While it is down there is nothing authoritative to compare against, so the
   * loop keeps measuring but stops correcting — and playback deliberately keeps
   * running. A 20-second Wi-Fi blip should cost a dimmed avatar, not a pause in
   * the middle of a sentence (§2.3).
   */
  setTransportConnected(connected: boolean): void {
    this.transportConnected = connected;
    if (!connected) this.seekLatency.cancel();
  }

  // ── user intents (§8.4) ──────────────────────────────────────────────────

  /**
   * Every intent is applied LOCALLY FIRST. A play button that waits for a round
   * trip feels broken even at 40 ms, and the server's answer arrives inside the
   * suppress window anyway. If it says no, `forceToAnchor` puts us back.
   *
   * When this user has no playback permission we do nothing at all — no local
   * change, no emit. The UI renders "Ask host to unlock" instead of a control
   * that visibly works and then undoes itself (§8.5a).
   */
  async play(): Promise<void> {
    if (!this.deps.canControl()) return;
    this.gestureGranted = true;
    this.clearGesturePrompt();
    void this.attemptPlay();
    this.suppressFor(POST_SEEK_BLIND_MS);
    await this.send({ action: 'play' });
  }

  async pause(): Promise<void> {
    if (!this.deps.canControl()) return;
    this.gestureGranted = true;
    void this.player.pause().catch(() => undefined);
    this.suppressFor(POST_SEEK_BLIND_MS);
    await this.send({ action: 'pause' });
  }

  async seek(positionSec: number): Promise<void> {
    if (!this.deps.canControl()) return;
    this.gestureGranted = true;
    const target = this.clampToVideo(positionSec);
    this.applyLocalSeek(target);
    await this.send({ action: 'seek', positionSec: target });
  }

  /**
   * Scrubbing, drag phase (§8.5c).
   *
   * The thumb follows the pointer through the playhead ref alone — no emit per
   * pointermove, because six people each emitting sixty events a second is a seek
   * war with itself. One intermediate seek every SCRUB_EMIT_INTERVAL_MS keeps the
   * room roughly with you while you drag; the real one lands on pointerup.
   */
  previewSeek(positionSec: number): void {
    const target = this.clampToVideo(positionSec);
    const mono = this.mono();
    this.scrubPreviewSec = target;
    this.scrubUntilMono = mono + SCRUB_PREVIEW_TTL_MS;
    this.suppressFor(POST_SEEK_BLIND_MS);
    if (!this.deps.canControl()) return;
    if (mono - this.lastScrubEmitMono < SCRUB_EMIT_INTERVAL_MS) return;
    this.lastScrubEmitMono = mono;
    // `allowSeekAhead: false` is the scrubbing form: move the playhead without
    // asking the network for an unbuffered position. Mid-drag that request would
    // be thrown away by the next frame anyway, and on a slow connection issuing
    // one every 400 ms is what makes a scrub feel like wading.
    this.applyLocalSeek(target, false);
    void this.send({ action: 'seek', positionSec: target });
  }

  /** Scrubbing, pointerup. Call this on pointercancel too, or the preview sticks. */
  async commitSeek(positionSec: number): Promise<void> {
    this.scrubPreviewSec = null;
    this.scrubUntilMono = 0;
    this.lastScrubEmitMono = this.mono();
    await this.seek(positionSec);
  }

  /**
   * The §8.7 autoplay gate, resolved by a real user gesture.
   *
   * Call this synchronously from the event handler: on iOS the gesture's
   * permission to start audio does not survive an await, so the player is touched
   * before anything is awaited.
   */
  async acceptGesture(): Promise<void> {
    this.gestureGranted = true;
    this.player.unMute();
    const anchor = this.deps.getAnchor();
    if (anchor.status === 'playing') {
      // Seek then play, both inside the gesture: landing at the room's position
      // is the entire point of tapping.
      this.hardSeekTo(positionAt(anchor, this.deps.clock.now()) + this.seekLatency.seconds, anchor);
      const started = await this.attemptPlay();
      if (!started) return;
    }
    this.clearGesturePrompt();
    this.scheduleEvaluation();
  }

  // ── escape hatches (PLAN risk R4) ────────────────────────────────────────

  /** "Re-sync now" — the button a user reaches for when they can feel the lag. */
  resyncNow(): void {
    this.resetConvergence();
    this.suppressUntilMono = 0;
    this.clockSanityTripped = false;
    this.requestClockResync(CLOCK_SAMPLES_RESYNC, { bypassPause: true });
  }

  /**
   * "Leave me alone" — stop correcting for a while.
   *
   * The escape hatch for the failure mode we cannot fully engineer away: a player
   * that fights the loop during a live discussion, where a correction every few
   * seconds is worse than being ten seconds behind.
   */
  pauseAutoSync(durationMs: number): void {
    this.autoSyncPaused = true;
    if (this.autoSyncTimer !== null) clearTimeout(this.autoSyncTimer);
    this.restoreRate();
    this.autoSyncTimer = setTimeout(() => {
      this.autoSyncTimer = null;
      this.resumeAutoSync();
    }, Math.max(0, durationMs));
    this.publish();
  }

  resumeAutoSync(): void {
    if (this.autoSyncTimer !== null) {
      clearTimeout(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
    if (!this.autoSyncPaused) return;
    this.autoSyncPaused = false;
    this.resetConvergence();
    this.publish();
    this.tick({ bypassCooldown: true });
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  // ── read-only player access for the UI ───────────────────────────────────
  // Narrow on purpose. The controller is the seam for everything on the shared
  // TIMELINE. Volume is not on the timeline — but it is on the same player, and
  // the room's mute button has to be able to clear `mutedForAutoplay`.

  /**
   * The live playhead, smoothed. Read from a rAF loop, never from render.
   *
   * YouTube reports `getCurrentTime()` at about 4 Hz (§5.3 quirk 1), so a scrubber
   * driven straight off it advances in visible 250 ms steps. We extrapolate from
   * the last CHANGED sample using a monotonic clock, cap the extrapolation, and
   * refuse to move backwards by less than a second — a sub-second rewind at a
   * sample boundary is an artefact of the player's resolution, not something that
   * happened to the video.
   */
  getPlayheadSec(): number {
    const mono = this.mono();
    if (this.scrubPreviewSec !== null && mono < this.scrubUntilMono) return this.scrubPreviewSec;

    const anchor = this.deps.getAnchor();
    const raw = this.safePosition();

    if (this.playheadSample === null || this.playheadSample.position !== raw) {
      this.playheadSample = { position: raw, atMono: mono };
    }
    if (this.player.getState() !== 'playing') {
      this.lastPlayhead = raw;
      return raw;
    }

    const rate = anchor.playbackRate > 0 ? anchor.playbackRate : 1;
    const ahead = Math.min(
      PLAYHEAD_EXTRAPOLATION_MAX_SEC,
      Math.max(0, (mono - this.playheadSample.atMono) / 1000) * rate,
    );
    const estimate = clampToDuration(this.playheadSample.position + ahead, anchor);
    const previous = this.lastPlayhead;
    if (previous !== null && estimate < previous && previous - estimate < 1) return previous;
    this.lastPlayhead = estimate;
    return estimate;
  }

  getDurationSec(): number {
    const fromPlayer = this.player.getDuration();
    if (Number.isFinite(fromPlayer) && fromPlayer > 0) return fromPlayer;
    return this.deps.getAnchor().durationSec ?? 0;
  }

  getBufferedFraction(): number {
    return this.player.getBufferedFraction();
  }

  /** Clears `mutedForAutoplay`: an explicit unmute is an answer to the gate. */
  setMuted(muted: boolean): void {
    if (muted) this.player.mute();
    else this.player.unMute();
    if (!muted && (this.mutedForAutoplay || this.needsGesture)) {
      this.gestureGranted = true;
      this.clearGesturePrompt();
    }
  }

  isMuted(): boolean {
    return this.player.isMuted();
  }

  /**
   * The volume the USER asked for, which is not always the volume the player is
   * at: while someone in the call is speaking, `setDuck` scales it down (C5).
   * Keeping the two apart means the slider does not walk down the screen every
   * time a peer says something, and restoring is exact rather than approximate.
   */
  setVolume(zeroToOne: number): void {
    this.userVolume = clamp(zeroToOne, 0, 1);
    this.applyVolume();
  }

  getVolume(): number {
    return this.userVolume ?? this.player.getVolume();
  }

  /**
   * Scale the room video's volume by `factor` without touching what the user
   * chose (PLAN.md §9.4 C5 — duck to 35% while a peer speaks, restore after).
   * The ramp is the caller's job; this is the setter it ramps.
   */
  setDuck(factor: number): void {
    const next = clamp(factor, 0, 1);
    if (Math.abs(next - this.duckFactor) < 0.005) return;
    this.duckFactor = next;
    this.applyVolume();
  }

  private applyVolume(): void {
    const base = this.userVolume ?? this.player.getVolume();
    if (!Number.isFinite(base)) return;
    this.player.setVolume(clamp(base * this.duckFactor, 0, 1));
  }

  // ── the loop ─────────────────────────────────────────────────────────────

  private tick(opts: TickOptions = {}): void {
    if (this.stopped) return;

    const mono = this.mono();
    const previous = this.lastTickMono;
    this.lastTickMono = mono;

    // §8.9, measured with a monotonic clock and never with Date.now — the whole
    // point is that Date.now is the thing that just jumped.
    if (previous !== null && mono - previous > COLD_RESUME_GAP_MS) {
      this.beginColdResume();
      return;
    }

    if (!this.deps.clock.isReady) return;

    const anchor = this.deps.getAnchor();
    if (anchor.status === 'idle' || anchor.videoRef === null) {
      this.setDriftState('idle');
      return;
    }

    const playerState = this.player.getState();
    const rawPosition = this.safePosition();
    this.seekLatency.observe(playerState, rawPosition, anchor.playbackRate);

    // Buffering bookkeeping runs BEFORE the measurement gates: it needs only the
    // player's state, and a stalled client has to be reported as stalled whether
    // or not this tick is allowed to trust a position (§8.10).
    if (this.trackBuffering(playerState, rawPosition, anchor, mono)) return;

    if (!this.player.isReadyForMeasurement()) return;
    if (mono < this.suppressUntilMono) return;
    if (this.autoSyncPaused && opts.bypassPause !== true) return;

    const expected = positionAt(anchor, this.deps.clock.now());
    const drift = rawPosition - expected;
    if (!Number.isFinite(drift)) return;

    this.recordDriftSample(drift, mono);

    // §8.9: a single huge reading is far more likely to be a laptop waking or an
    // NTP step than the video actually moving. Re-sync the clock and re-evaluate
    // BEFORE seeking. If the reading survives the re-sync it was real — somebody
    // seeked half an hour — and the re-evaluation will act on it.
    if (Math.abs(drift) > CLOCK_SANITY_DRIFT_SEC && !this.clockSanityTripped) {
      this.clockSanityTripped = true;
      this.setDriftState('resyncing', drift);
      this.requestClockResync(CLOCK_SAMPLES_JOIN);
      return;
    }
    if (Math.abs(drift) <= CLOCK_SANITY_DRIFT_SEC) this.clockSanityTripped = false;

    // A clock sync is in flight, which means our idea of "now" is under review.
    // Correcting against a number we have already decided not to trust — for the
    // whole 200-400 ms the sync takes — would defeat the check above: the gate
    // trips once, and every tick after it would seek on the same bad reading.
    if (this.clockSyncPending) {
      this.setDriftState('resyncing', drift);
      return;
    }

    if (!this.transportConnected) {
      this.setDriftState(this.classify(anchor, drift), drift);
      return;
    }

    const bypassCooldown =
      opts.bypassCooldown === true || this.joinConvergenceTicks > 0 || this.recoveringFromStall;
    if (this.joinConvergenceTicks > 0) this.joinConvergenceTicks -= 1;

    // ── 1. Status mismatch always wins over position drift ─────────────────
    if (anchor.status === 'playing' && playerState !== 'playing') {
      if (this.playbackBlocked) {
        // iOS will not start playback without a gesture and hammering play() just
        // produces a stream of rejected promises. The UI is showing a "Tap to
        // resume" bar; wait for it (§8.9, mobile row).
        this.setDriftState('stalled', drift);
        return;
      }
      this.hardSeekTo(expected + this.seekLatency.seconds, anchor);
      void this.attemptPlay();
      this.calmTicks = 0;
      this.setDriftState('resyncing', drift);
      return;
    }
    if (anchor.status !== 'playing' && playerState === 'playing') {
      void this.player.pause().catch(() => undefined);
      this.softSeekTo(anchor.anchorPositionSec, anchor);
      this.calmTicks = 0;
      this.setDriftState('correcting', drift);
      return;
    }
    if (anchor.status !== 'playing') {
      // Paused: correct only when we are meaningfully off the frozen position.
      // Everything below this line is about a moving target and does not apply.
      if (Math.abs(drift) > SOFT_MAX_SEC) {
        this.softSeekTo(anchor.anchorPositionSec, anchor);
        this.calmTicks = 0;
        this.setDriftState('correcting', drift);
        return;
      }
      this.noteCalm(drift);
      return;
    }

    const mag = Math.abs(drift);

    // ── 2. Dead zone. Most ticks land here, and that is the design ─────────
    if (mag < DEAD_ZONE_SEC) {
      this.noteCalm(drift);
      return;
    }

    // ── 3. Soft band ───────────────────────────────────────────────────────
    if (mag < HARD_SEEK_AT_SEC) {
      if (this.player.supportsFineRates()) {
        this.nudgeRate(drift, mag, anchor);
      } else if (
        mag > MICRO_SEEK_MIN_SEC &&
        (bypassCooldown || mono - this.lastMicroSeekMono > MIN_MICRO_SEEK_GAP_MS)
      ) {
        // YouTube's rate list has no 1.05× (§5.3 quirk 4), so the gentle nudge is
        // unavailable. Under 1.2 s a seek reads as a tiny hitch.
        this.microSeekTo(expected + this.seekLatency.seconds, anchor, mono);
      }
      this.calmTicks = 0;
      this.setDriftState('correcting', drift);
      return;
    }

    // ── 4. Hard band ───────────────────────────────────────────────────────
    const gap = MIN_HARD_SEEK_GAP_MS * this.backoff;
    if (!bypassCooldown && mono - this.lastHardSeekMono < gap) {
      // We seeked recently and are STILL in the hard band: that correction
      // failed. Counting a failure here rather than at the seek is what makes the
      // backoff respond to failure instead of to activity.
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        this.backoff = Math.min(MAX_BACKOFF, this.backoff * 2);
      }
      this.calmTicks = 0;
      this.setDriftState('resyncing', drift);
      return;
    }

    this.hardSeekTo(expected + this.seekLatency.seconds, anchor, true);
    if (this.player.getState() !== 'playing') void this.attemptPlay();
    this.calmTicks = 0;
    this.setDriftState('resyncing', drift);
  }

  // ── correction primitives ────────────────────────────────────────────────

  /**
   * The mechanics of a large seek: clamp, measure, jump, blind the loop.
   *
   * `countsAsFailure` decides whether this seek is *telemetry*. Only §8.6 step 4
   * — the hard band, a drift correction that failed to be avoided — is a sync
   * failure. The other three callers are ordinary room activity:
   *   - the status-mismatch branch (someone pressed play, we are catching up)
   *   - `forceToAnchor` (join, snapshot, reconnect, a rejected control reverting)
   *   - `acceptGesture` (the user tapped the autoplay bar)
   *
   * Counting all four made `hardSeeksPerHour` scale with how much the room was
   * *used* rather than how badly it was syncing: the simulator measured the same
   * 15 seeks as 5.47/h over 1800s and 2.61/h over 3600s. A failure rate that
   * halves because you kept watching is not measuring failure. It also meant the
   * §15.3 regression gate could never pass in an active room, `ss_hard_seeks_total`
   * alerted on normal use, and the UI over-reported.
   *
   * The COOLDOWN (`lastHardSeekMono`) is armed for all four on purpose — it exists
   * to stop seek storms, and a seek is a seek regardless of why it happened.
   */
  private hardSeekTo(positionSec: number, anchor: VideoAnchor, countsAsFailure = false): void {
    const target = this.clampToVideo(positionSec, anchor);
    const mono = this.mono();
    this.seekLatency.begin(target);
    void this.player.seek(target, true).catch(() => {
      this.seekLatency.cancel();
    });
    this.lastHardSeekMono = mono;
    if (countsAsFailure) {
      this.hardSeekTimes.push(mono);
      this.hardSeeksSinceReport += 1;
    }
    this.recoveringFromStall = false;
    this.forgetPlayhead();
    this.suppressFor(POST_SEEK_BLIND_MS);
  }

  private microSeekTo(positionSec: number, anchor: VideoAnchor, mono: number): void {
    this.lastMicroSeekMono = mono;
    // The post-stall allowance is for ONE corrective seek, of either size. Left
    // set, it would bypass the micro-seek gap on every tick until the drift fell
    // back into the dead zone — a hitch every 500 ms right after an ad break.
    this.recoveringFromStall = false;
    const target = this.clampToVideo(positionSec, anchor);
    this.seekLatency.begin(target);
    void this.player.seek(target, true).catch(() => {
      this.seekLatency.cancel();
    });
    this.forgetPlayhead();
    this.suppressFor(POST_SEEK_BLIND_MS);
  }

  /** A seek to a stationary target — no latency compensation, none is meaningful. */
  private softSeekTo(positionSec: number, anchor: VideoAnchor): void {
    const target = this.clampToVideo(positionSec, anchor);
    this.seekLatency.cancel();
    void this.player.seek(target, true).catch(() => undefined);
    this.forgetPlayhead();
    this.suppressFor(POST_SEEK_BLIND_MS);
  }

  /**
   * The HTML5 path: close the gap smoothly instead of jumping (§8.6 step 3).
   *
   * Closing `drift` at a rate delta of `d` takes `drift / d` seconds, so the
   * restore is scheduled for exactly that — capped at 4 s so the correction
   * always finishes before the user does anything else, and never re-nudged while
   * one is already running, which would compound the deltas.
   */
  private nudgeRate(drift: number, mag: number, anchor: VideoAnchor): void {
    if (this.rateRestoreTimer !== null) return;
    const base = anchor.playbackRate > 0 ? anchor.playbackRate : 1;
    // Ahead → positive delta → slow down.
    const delta = clamp(drift / RATE_NUDGE_DIVISOR, -RATE_NUDGE_MAX, RATE_NUDGE_MAX);
    const next = base * (1 - delta / base);
    if (!Number.isFinite(next) || next <= 0) return;

    this.player.setRate(next);
    this.nudgedRate = true;
    const windowMs = Math.min(
      RATE_RESTORE_MAX_MS,
      (mag / Math.abs(delta === 0 ? RATE_NUDGE_FLOOR : delta)) * 1000,
    );
    this.rateRestoreTimer = setTimeout(() => {
      this.rateRestoreTimer = null;
      this.restoreRate();
    }, windowMs);
  }

  private restoreRate(): void {
    if (this.rateRestoreTimer !== null) {
      clearTimeout(this.rateRestoreTimer);
      this.rateRestoreTimer = null;
    }
    if (!this.nudgedRate) return;
    this.nudgedRate = false;
    const rate = this.deps.getAnchor().playbackRate;
    this.player.setRate(rate > 0 ? rate : 1);
  }

  /**
   * Put the player where the anchor says, without measuring anything.
   *
   * Used on a join, on a rejected intent and on a cold resume — the three cases
   * where the player's own position is either meaningless or actively misleading,
   * so a measurement-based correction would compute a wrong answer confidently.
   */
  private forceToAnchor(anchor: VideoAnchor): void {
    if (anchor.status === 'idle' || anchor.videoRef === null) return;

    if (anchor.status !== 'playing') {
      void this.player.pause().catch(() => undefined);
      this.softSeekTo(anchor.anchorPositionSec, anchor);
      this.clearGesturePrompt();
      return;
    }

    // Already playing and already in the dead zone (a reconnect after a blip, the
    // common case): seeking would be a jolt in exchange for nothing (§8.8).
    const expected = positionAt(anchor, this.deps.clock.now());
    const settled =
      this.player.getState() === 'playing' &&
      this.player.isReadyForMeasurement() &&
      Math.abs(this.safePosition() - expected) < DEAD_ZONE_SEC;
    if (!settled) this.hardSeekTo(expected + this.seekLatency.seconds, anchor);
    this.runAutoplayGate(anchor);
  }

  private applyLocalSeek(target: number, allowSeekAhead = true): void {
    const anchor = this.deps.getAnchor();
    this.seekLatency.cancel();

    // Land where the room will BE once this seek completes, not where the user
    // released the handle.
    //
    // The server compensates for the request's flight time (§8.4), so the room's
    // timeline lands exactly on the user's target. Our own player then buffers
    // for its seek latency and resumes ~150-450ms behind that. Nothing ever
    // corrects it, because that gap sits inside DEAD_ZONE_SEC — so the person who
    // scrubs is left permanently trailing the room they just steered. The
    // simulator measured this as the single largest contributor to steady-state
    // spread: the last client to seek carried driftP95 0.298 against 0.075-0.137
    // for everyone who did not.
    //
    // Only while playing: on a paused room nothing is advancing to catch up with,
    // and a lead would just put the frame in the wrong place.
    const lead = anchor.status === 'playing' ? this.seekLatency.seconds : 0;
    const landing = this.clampToVideo(target + lead, anchor);

    void this.player.seek(landing, allowSeekAhead).catch(() => undefined);
    this.forgetPlayhead();
    if (anchor.status === 'playing' && this.player.getState() !== 'playing') void this.attemptPlay();
    this.suppressFor(POST_SEEK_BLIND_MS);
  }

  // ── the autoplay gate (§8.7 step 5) ──────────────────────────────────────

  /**
   * Muted autoplay is permitted by every browser; unmuted autoplay is not. So a
   * late joiner gets moving pixels immediately plus a one-tap unmute, rather than
   * a frozen frame that reads as "this app is broken". Once this session has seen
   * a real gesture we go straight to unmuted playback (§8.8).
   */
  private runAutoplayGate(anchor: VideoAnchor): void {
    if (anchor.status !== 'playing') {
      this.clearGesturePrompt();
      return;
    }
    if (this.gateRunning) return;
    this.gateRunning = true;

    if (this.gestureGranted) {
      void this.attemptPlay().then((started) => {
        this.gateRunning = false;
        if (!started) this.setGesturePrompt(false);
      });
      return;
    }

    this.player.mute();
    // Set before attempting, so a successful play does not read this as "started
    // unmuted" and clear the very prompt we are about to raise.
    this.mutedForAutoplay = true;
    void this.attemptPlay().then((started) => {
      this.gateRunning = false;
      if (started) {
        // Playing, silently. The UI offers "Tap to join with sound".
        this.setGesturePrompt(true);
        return;
      }
      // Even muted autoplay was refused (iOS Low Power Mode, mostly). Nothing is
      // playing, so unmute now: when they do tap, they should get sound.
      this.mutedForAutoplay = false;
      this.player.unMute();
      this.setGesturePrompt(false);
    });
  }

  private async attemptPlay(): Promise<boolean> {
    try {
      await this.player.play();
      this.playbackBlocked = false;
      // Playback started unmuted and without being refused: there is nothing
      // left for a tap to resolve.
      if (!this.mutedForAutoplay) this.clearGesturePrompt();
      return true;
    } catch {
      this.playbackBlocked = true;
      this.setGesturePrompt(this.mutedForAutoplay);
      return false;
    }
  }

  private setGesturePrompt(mutedForAutoplay: boolean): void {
    this.needsGesture = true;
    this.mutedForAutoplay = mutedForAutoplay;
    this.publish();
  }

  private clearGesturePrompt(): void {
    this.playbackBlocked = false;
    if (!this.needsGesture && !this.mutedForAutoplay) return;
    // We muted the player ourselves to get past the autoplay policy. Dropping the
    // prompt without undoing that leaves the room permanently silent with nothing
    // on screen offering to fix it — the user is watching a muted lecture and the
    // "tap for sound" affordance they would have used is gone. Safe at every
    // caller: the prompt is only cleared when nothing is playing or a gesture has
    // already been given.
    if (this.mutedForAutoplay) this.player.unMute();
    this.needsGesture = false;
    this.mutedForAutoplay = false;
    this.publish();
  }

  // ── buffering (§8.10) ────────────────────────────────────────────────────

  /** Returns true when the caller should stop: we are stalled, so do not correct. */
  private trackBuffering(
    state: PlayerState,
    positionSec: number,
    anchor: VideoAnchor,
    mono: number,
  ): boolean {
    // `unstarted` counts: an ad roll on a non-Premium account shows up as
    // unstarted/buffering for 5–30 s and is the single biggest source of drift
    // spikes in a real session (§5.3 quirk 6).
    const stalled = state === 'buffering' || (state === 'unstarted' && anchor.status === 'playing');

    if (stalled) {
      this.bufferingSinceMono ??= mono;
      if (
        !this.bufferingReported &&
        anchor.status === 'playing' &&
        mono - this.bufferingSinceMono >= BUFFERING_REPORT_AFTER_MS
      ) {
        this.bufferingReported = true;
        this.bufferingFlag = true;
        this.deps.reportBuffering(true, this.clampToVideo(positionSec, anchor));
        this.setDriftState('stalled');
      }
      return true;
    }

    if (this.bufferingSinceMono !== null) {
      this.bufferingSinceMono = null;
      if (this.bufferingReported) {
        this.bufferingReported = false;
        this.bufferingFlag = false;
        this.deps.reportBuffering(false, this.clampToVideo(positionSec, anchor));
        // We were suppressed while stalled and are now certainly behind. One hard
        // seek, cooldown ignored, is the cheapest way back.
        this.recoveringFromStall = true;
        this.suppressUntilMono = 0;
        this.publish();
      }
    }
    return false;
  }

  // ── clock (§8.9) ─────────────────────────────────────────────────────────

  private beginColdResume(): void {
    // No optimistic assumption survives a sleep: the seek we were timing, the
    // failure counters, the blind window and the convergence budget all reset.
    this.seekLatency.cancel();
    this.resetConvergence();
    this.suppressUntilMono = 0;
    this.clockSanityTripped = false;
    this.forgetPlayhead();
    this.requestClockResync(CLOCK_SAMPLES_RESYNC, { coldResume: true });
  }

  /**
   * Re-sync, then re-evaluate — in that order, and never two at once.
   *
   * `ServerClock.sync` de-duplicates concurrent calls internally, so this
   * co-operates with the clock's own 30 s schedule instead of racing it.
   */
  private requestClockResync(
    samples: number,
    opts: { coldResume?: boolean; bypassPause?: boolean } = {},
  ): void {
    if (this.clockSyncPending) return;
    this.clockSyncPending = true;
    void this.deps.clock.sync(samples, CLOCK_SAMPLE_SPACING_MS).then(
      () => {
        this.clockSyncPending = false;
        if (this.stopped) return;
        if (opts.coldResume === true) {
          // A cold resume makes no optimistic assumptions: go straight to the
          // anchor rather than reasoning from a position measured before a sleep.
          const anchor = this.deps.getAnchor();
          if (anchor.status !== 'idle' && anchor.videoRef !== null) this.forceToAnchor(anchor);
          return;
        }
        this.tick({
          bypassCooldown: true,
          ...(opts.bypassPause === true ? { bypassPause: true } : {}),
        });
      },
      () => {
        this.clockSyncPending = false;
      },
    );
  }

  // ── scheduling ───────────────────────────────────────────────────────────

  /**
   * Evaluate as soon as it is safe to believe the player's position — now if the
   * blind window has passed, otherwise the moment it does.
   */
  private scheduleEvaluation(): void {
    if (this.stopped || this.pendingEvaluation !== null) return;
    const wait = Math.max(0, this.suppressUntilMono - this.mono());
    if (wait === 0) {
      this.tick({ bypassCooldown: true });
      return;
    }
    this.pendingEvaluation = setTimeout(() => {
      this.pendingEvaluation = null;
      this.tick({ bypassCooldown: true });
    }, wait);
  }

  private suppressFor(ms: number): void {
    this.suppressUntilMono = Math.max(this.suppressUntilMono, this.mono() + ms);
  }

  private resetConvergence(): void {
    this.joinConvergenceTicks = JOIN_CONVERGENCE_TICKS;
    this.consecutiveFailures = 0;
    this.backoff = 1;
    this.calmTicks = 0;
  }

  private observePlayerState(state: PlayerState): void {
    if (this.stopped) return;
    const anchor = this.deps.getAnchor();
    // A state change is usually the earliest evidence that a seek landed, which
    // makes it the most accurate latency sample available.
    this.seekLatency.observe(state, this.safePosition(), anchor.playbackRate);
    if (state === 'buffering' || state === 'playing') {
      this.trackBuffering(state, this.safePosition(), anchor, this.mono());
    }
  }

  // ── transport ────────────────────────────────────────────────────────────

  private async send(intent: ControlIntent): Promise<void> {
    let ack: ControlAck;
    try {
      ack = await this.deps.sendControl(intent);
    } catch {
      return;
    }
    if (this.stopped) return;
    if (ack.ok) {
      this.lastRevision = Math.max(this.lastRevision, ack.anchor.revision);
      return;
    }
    // Rejected. Revert to the authoritative anchor the rejection carried, and do
    // NOT retry: replaying a stale seek lands the room somewhere nobody asked
    // for, which is worse than the intent simply not happening (§8.5b).
    // A negative revision is the server's "I could not read the real anchor"
    // sentinel and must never be applied as truth.
    if (ack.anchor.revision < 0) return;
    this.lastRevision = ack.anchor.revision;
    this.suppressUntilMono = 0;
    this.forceToAnchor(ack.anchor);
  }

  // ── telemetry (§16.5) ────────────────────────────────────────────────────

  private recordDriftSample(drift: number, mono: number): void {
    this.driftSamples.push(Math.abs(drift));
    if (this.driftSamples.length > DRIFT_SAMPLE_LIMIT) this.driftSamples.shift();
    const cutoff = mono - HARD_SEEK_WINDOW_MS;
    while (this.hardSeekTimes.length > 0 && (this.hardSeekTimes[0] ?? 0) < cutoff) {
      this.hardSeekTimes.shift();
    }
  }

  /**
   * The last 60 seconds of sync telemetry, for the "Something wrong?" report
   * (§14 Phase 10.9).
   *
   * Read live rather than buffered separately: the drift loop already keeps a
   * rolling window of samples for `flushTelemetry`, and a second buffer that
   * could disagree with the first is exactly what a support report must not
   * have. Safe to call at any time, including before a single sample exists.
   */
  getTelemetrySnapshot(): {
    driftState: DriftState;
    driftSec: number;
    driftP50: number | null;
    driftP95: number | null;
    samples: number;
    hardSeeksLastMinute: number;
    clockOffsetMs: number;
    quality: 'good' | 'poor';
    buffering: boolean;
    autoSyncPaused: boolean;
    playerError: number | null;
    seekLatencyMs: number;
  } {
    const sorted = [...this.driftSamples].sort((a, b) => a - b);
    const status = this.getStatus();
    return {
      driftState: status.drift,
      driftSec: status.driftSec,
      driftP50: sorted.length === 0 ? null : Number(percentile(sorted, 0.5).toFixed(3)),
      driftP95: sorted.length === 0 ? null : Number(percentile(sorted, 0.95).toFixed(3)),
      samples: sorted.length,
      hardSeeksLastMinute: status.hardSeeksLastMinute,
      clockOffsetMs: Math.round(this.deps.clock.now() - Date.now()),
      quality: status.quality,
      buffering: status.buffering,
      autoSyncPaused: status.autoSyncPaused,
      playerError: status.error?.code ?? null,
      seekLatencyMs: Math.round(this.seekLatency.seconds * 1000),
    };
  }

  private flushTelemetry(): void {
    if (this.stopped || !this.transportConnected) return;
    if (this.driftSamples.length === 0 && this.hardSeeksSinceReport === 0) return;
    // Magnitudes, not signed values: the server histograms `Math.abs()` anyway,
    // and a p95 over a series whose sign flips does not mean anything.
    const sorted = [...this.driftSamples].sort((a, b) => a - b);
    this.deps.reportDrift({
      driftP50: Number(percentile(sorted, 0.5).toFixed(3)),
      driftP95: Number(percentile(sorted, 0.95).toFixed(3)),
      hardSeeks: this.hardSeeksSinceReport,
      clockOffsetMs: Math.round(this.deps.clock.now() - Date.now()),
    });
    this.hardSeeksSinceReport = 0;
    this.driftSamples = [];
  }

  // ── status ───────────────────────────────────────────────────────────────

  private noteCalm(drift: number): void {
    this.consecutiveFailures = 0;
    this.calmTicks += 1;
    this.recoveringFromStall = false;
    // Take 'poor' back off only after sustained calm. Clearing it on the first
    // good tick would make the label flicker on exactly the connections it is
    // meant to describe.
    if (this.calmTicks >= QUALITY_RECOVERY_TICKS && this.backoff !== 1) this.backoff = 1;
    this.setDriftState('in_sync', drift);
  }

  private classify(anchor: VideoAnchor, drift: number): DriftState {
    if (anchor.status === 'idle') return 'idle';
    const mag = Math.abs(drift);
    if (anchor.status !== 'playing') return mag > SOFT_MAX_SEC ? 'correcting' : 'in_sync';
    if (mag < DEAD_ZONE_SEC) return 'in_sync';
    if (mag < HARD_SEEK_AT_SEC) return 'correcting';
    return 'resyncing';
  }

  private setDriftState(drift: DriftState, driftSec?: number): void {
    this.driftState = drift;
    if (driftSec === undefined) {
      this.publishedDriftSec = 0;
    } else if (Math.abs(driftSec - this.publishedDriftSec) >= DRIFT_PUBLISH_EPSILON_SEC) {
      // Hysteresis: move the published number only when it moved meaningfully.
      this.publishedDriftSec = Number(driftSec.toFixed(2));
    }
    this.publish();
  }

  private publish(): void {
    const next: SyncStatus = {
      drift: this.driftState,
      driftSec: this.publishedDriftSec,
      quality:
        this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES || this.backoff > 1 ? 'poor' : 'good',
      hardSeeksLastMinute: this.hardSeekTimes.length,
      autoSyncPaused: this.autoSyncPaused,
      buffering: this.bufferingFlag,
      error: this.playerError,
      needsGesture: this.needsGesture,
      mutedForAutoplay: this.mutedForAutoplay,
    };
    if (this.published && syncStatusEquals(next, this.status)) return;
    this.published = true;
    this.status = next;
    this.deps.onStatus(next);
  }

  // ── small helpers ────────────────────────────────────────────────────────

  private forgetPlayhead(): void {
    this.playheadSample = null;
    this.lastPlayhead = null;
  }

  private safePosition(): number {
    const value = this.player.getPosition();
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  }

  private clampToVideo(positionSec: number, anchor?: VideoAnchor): number {
    if (!Number.isFinite(positionSec)) return 0;
    return clampToDuration(Math.max(0, positionSec), anchor ?? this.deps.getAnchor());
  }
}
