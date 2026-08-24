/**
 * The sync simulator's public surface (PLAN.md §15.3).
 *
 * The harness runs the REAL `SyncController`, the REAL `ServerClock` and the
 * REAL server decision functions from `@syncstudy/shared` (`decideControl`,
 * `applyControl`, `positionAt`) against `FakePlayer` and a virtual network. It
 * deliberately reimplements NONE of the sync logic: a simulator with its own
 * copy of the rules would go green while production was broken, which is the
 * one failure this asset exists to prevent.
 *
 * ── THE TIMEBASE ────────────────────────────────────────────────────────────
 * Every `atSec` in a config is measured from the moment the room goes live,
 * which is AFTER the warm-up in which the initial clients complete their join
 * handshake (`WARMUP_MS` in sim.ts). `t = 0` is therefore the first instant at
 * which a scripted action is meaningful, not the instant the process started.
 *
 * The one exception is `SimStallSpec.atVideoSec`, and it is named differently
 * for exactly that reason — see the comment there.
 */
import type { ControlRejectReason, PlaybackStatus } from '@syncstudy/shared';

/**
 * A buffering stall — an ad roll, or a connection that briefly gives up
 * (§5.3 quirk 6, §8.10).
 *
 * `atVideoSec` is a POSITION IN THE VIDEO, not a wall-clock instant, because
 * that is what `FakePlayer` models and what actually happens: an ad break sits
 * at a point in the lecture, so seeking past it skips it and seeking back over
 * it plays it again. §15.3's example writes `atSec` for this field; the name is
 * changed here because a test asset whose units are ambiguous is worse than no
 * test asset.
 */
export interface SimStallSpec {
  atVideoSec: number;
  forSec: number;
}

/** A transport outage. Wall-clock seconds on the room timebase. */
export interface SimOutageSpec {
  atSec: number;
  forSec: number;
}

export interface SimClientSpec {
  id: string;
  /** One-way delay, applied independently in each direction. Default 40 ms. */
  latencyMs?: number | undefined;
  /** Uniform ± spread added to each one-way delay. Default 0. */
  jitterMs?: number | undefined;
  /** Per-message drop probability, each direction. Default 0. */
  lossPct?: number | undefined;
  /**
   * How wrong this client's `Date.now()` is. Positive means its clock reads
   * ahead of the server's. This is the input that proves the offset arithmetic
   * INCLUDING ITS SIGN (§15.2), because a sign error is invisible at zero skew.
   */
  clockSkewMs?: number | undefined;
  /** Wall-clock ms this player takes to land a seek. Default: seeded per client. */
  seekLatencyMs?: number | undefined;
  /** Decoder speed error; 1 is perfect. Default: seeded per client. */
  rateError?: number | undefined;
  stalls?: readonly SimStallSpec[] | undefined;
  disconnects?: readonly SimOutageSpec[] | undefined;
  /** A late joiner (§8.7). Omitted means "in the room from the start". */
  joinsAtSec?: number | undefined;
  /** `canControlVideo` for this client (§8.5a). Default true. */
  canControl?: boolean | undefined;
}

/** One scripted user action. `to` is required for `seek` and ignored otherwise. */
export interface SimScriptStep {
  atSec: number;
  client: string;
  action: 'play' | 'pause' | 'seek';
  to?: number | undefined;
}

/**
 * One sampled instant. Passed to `onSample` so a test can assert on the time
 * series — "the late joiner was within a second of the room five seconds after
 * joining" is a statement about a window, not about a summary statistic.
 */
export interface SimSample {
  /** Seconds since the room went live. */
  atSec: number;
  /** Where the room is, from the authoritative anchor at true server time. */
  roomSec: number;
  roomStatus: PlaybackStatus;
  /**
   * The number a user perceives: the largest pairwise gap between any two
   * clients' playback positions at this instant (§15.3).
   */
  spreadSec: number;
  /** Player position, per client that has joined and loaded. */
  positions: ReadonlyMap<string, number>;
  /** `position - roomSec`; positive means that client is AHEAD of the room. */
  drifts: ReadonlyMap<string, number>;
}

export interface SyncSimOptions {
  clients: readonly SimClientSpec[];
  script?: readonly SimScriptStep[] | undefined;
  /** Length of the sampled window, in virtual seconds. */
  durationSec: number;
  /** Sampling cadence. Default 50 ms. */
  tickMs?: number | undefined;
  seed?: number | undefined;
  videoRef?: string | undefined;
  videoDurationSec?: number | undefined;
  /** §8.10. Off by default, exactly as the room policy is. */
  waitForSlow?: boolean | undefined;
  onSample?: ((sample: SimSample) => void) | undefined;
}

/**
 * What happened when two people fought the scrubber (§8.5).
 *
 * `none` is not a pass — it means the run contained no cluster of controls from
 * different actors inside `CONTROL_LOCK_MS`, so the property was never tested.
 */
export type ConflictOutcome = 'single_winner' | 'split' | 'none';

export interface SimClientResult {
  id: string;
  /** Seconds on the room timebase at which this client's loop started. */
  joinedAtSec: number;
  /** Samples in which this client was joined and loaded. */
  samples: number;
  /** |position - room|, over the samples where this client was joined. */
  driftP50: number;
  driftP95: number;
  driftMax: number;
  /** Signed drift at the last sample. */
  finalDriftSec: number;
  /**
   * Hard seeks, from the controller's OWN §16.5 telemetry (`reportDrift`) —
   * the same counter production ships to `/metrics`, not a number the harness
   * inferred by watching the player.
   */
  hardSeeks: number;
  hardSeeksPerHour: number;
  /**
   * Seconds of wall clock the telemetry above actually covers: from the loop
   * starting to its last flush. The tail after the last 30 s flush is excluded
   * from BOTH the count and the window, so the rate stays exact rather than
   * being diluted by a period nobody reported on.
   */
  telemetryCoveredSec: number;
  /** The last drift p95 this client reported to the server, in seconds. */
  reportedDriftP95: number;
  /** `clock.now() - Date.now()` as the client last reported it. ≈ -clockSkewMs. */
  reportedClockOffsetMs: number;
  controlsSent: number;
  controlsAccepted: number;
  controlsRejected: number;
  /** Buffering transitions this client reported to the server (§8.10). */
  bufferingReports: number;
  /** Longest unbroken stretch with |drift| > HARD_SEEK_AT_SEC, in seconds. */
  longestDivergenceSec: number;
  /** Every `player.seek()` the loop issued, of any size. Diagnostics only. */
  seeksIssued: number;
}

export interface SimResult {
  /** Median and 95th percentile of the per-sample spread, in seconds. */
  spreadP50: number;
  spreadP95: number;
  spreadMax: number;
  /** Total telemetry hard seeks divided by total telemetry-covered client-hours. */
  hardSeeksPerClientPerHour: number;
  /** True when any client stayed past the hard band for a full minute (§8.6). */
  divergedForever: boolean;
  conflictOutcome: ConflictOutcome;
  perClient: SimClientResult[];
  /** Sampled instants. */
  samples: number;
  /** Controls the server accepted, and why it refused the rest (§8.5). */
  controlsAccepted: number;
  controlsRejected: Partial<Record<ControlRejectReason, number>>;
  /** The authoritative anchor's revision at the end of the run. */
  finalRevision: number;
  /** Scripted steps that could not run because the client had not joined. */
  scriptStepsSkipped: number;
}
