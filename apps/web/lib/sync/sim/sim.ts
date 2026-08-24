/**
 * The sync simulator (PLAN.md §15.3) — "the highest-leverage test asset in the
 * project", and the only honest way to tune `DEAD_ZONE_SEC`, `HARD_SEEK_AT_SEC`
 * and `CONTROL_LOCK_MS`.
 *
 *     const sim = new SyncSim({ clients, script, durationSec, tickMs, seed });
 *     const result = await sim.run();
 *
 * Thirty minutes of six-person session runs in a few seconds of wall clock, with
 * no browser, no YouTube, no network and no `Math.random()`. Same seed and same
 * script, same numbers — which is the property that makes a regression gate
 * possible at all.
 *
 * ── WHAT `spread` MEANS ─────────────────────────────────────────────────────
 * At every sampled instant, the largest pairwise gap between any two clients'
 * playback positions. Not the gap to the server's anchor: the anchor is not
 * something anybody watches. Two friends on a call notice that one of them
 * heard the punchline first, and that is exactly `max(position) - min(position)`.
 *
 * ── WHAT IS AND IS NOT MEASURED HONESTLY ────────────────────────────────────
 * `hardSeeksPerClientPerHour` comes from the controller's OWN §16.5 telemetry
 * (`reportDrift`), because that is the counter production ships to `/metrics`
 * and alerts on. The harness never infers a hard seek by watching `player.seek`
 * go past: from outside, a hard seek, a micro-seek, a soft seek and a user's own
 * seek are the same call, and a harness that guessed would be reporting its own
 * guess back to you as a measurement.
 *
 * The rate is divided by the window the telemetry actually covers — from the
 * loop starting to its last 30 s flush — so the unreported tail is excluded from
 * the numerator AND the denominator instead of quietly diluting the answer.
 *
 * ── THE WARM-UP ─────────────────────────────────────────────────────────────
 * A join is not instant: eight clock samples 50 ms apart over a 220 ms link is
 * four virtual seconds before the loop even starts. So the run opens with
 * `WARMUP_MS` of virtual time in which the initial clients join a paused room,
 * and `t = 0` on every `atSec` in the config is the instant AFTER that. Without
 * it, `{ atSec: 0, client: 'a', action: 'play' }` would fire at a client that
 * has no controller yet, and the scenario would silently be a different one.
 */
import {
  CONTROL_LOCK_MS,
  HARD_SEEK_AT_SEC,
  SEEK_LATENCY_INIT_MS,
  positionAt,
  type ControlRejectReason,
} from '@syncstudy/shared';
import { SimClient } from './client';
import { DEFAULT_LATENCY_MS, Link } from './link';
import { stream } from './rng';
import { SimServer, type ControlRecord } from './server';
import { VirtualScheduler } from './scheduler';
import type {
  ConflictOutcome,
  SimClientResult,
  SimResult,
  SimSample,
  SyncSimOptions,
} from './types';

/**
 * Virtual time reserved for the initial join handshake before `t = 0`.
 * Ten seconds is roughly twice the worst join in a realistic scenario
 * (8 samples × (2 × 220 ms + 50 ms) ≈ 4 s), and virtual seconds are free.
 */
export const WARMUP_MS = 10_000;

const DEFAULT_TICK_MS = 50;
const DEFAULT_SEED = 1;
/** An 11-character id, so it survives `isValidYouTubeId` if anything checks. */
const DEFAULT_VIDEO_REF = 'simlecture1';
/** Two hours: long enough that no scenario runs off the end of the video. */
const DEFAULT_VIDEO_DURATION_SEC = 7_200;

/**
 * Two players decoding the same stream do not advance at exactly the same
 * speed, and the difference is what makes the drift loop necessary rather than a
 * one-time alignment at join.
 *
 * The default is ±100 ppm, drawn per client from the seed. That is the
 * tolerance of the crystal oscillators in consumer phones and laptops (±20 to
 * ±100 ppm), so a worst-case PAIR of clients is 200 ppm apart — 0.72 s of
 * divergence per hour, enough that the loop must intervene at least once in a
 * long session and not enough to dominate the measurement.
 *
 * This number moves `spreadP95` more than anything else in the harness, so it
 * is chosen on physical grounds and stated here rather than tuned until the
 * assertions go green. Measured on the §15.3 scenario at seed 7:
 *
 *     ±0 ppm   → p50 0.09 / p95 0.29     ±100 ppm → p50 0.16 / p95 0.30
 *     ±200 ppm → p50 0.30 / p95 0.50     ±500 ppm → p50 0.53 / p95 0.95
 *     ±1500 ppm (fake.ts's "0.15 %") → p50 0.67 / p95 1.12
 *
 * A genuinely bad decoder is a per-client `rateError`, not a global default.
 */
const RATE_ERROR_SPREAD = 0.0001;
/**
 * How long a seek costs this player, as a multiple of `SEEK_LATENCY_INIT_MS`:
 * 150–450 ms. The spread matters because `SeekLatencyEstimator` is SEEDED at
 * 250 ms — a fleet where every player happens to take exactly 250 ms would
 * never exercise the EWMA that keeps corrective seeks from landing short.
 */
const SEEK_LATENCY_MIN_FACTOR = 0.6;
const SEEK_LATENCY_FACTOR_SPREAD = 1.2;

/**
 * "Stuck out of sync" (§15.3's `divergedForever`) needs a duration, or a single
 * ad break counts as permanent divergence. A full minute past the hard band,
 * unbroken, is a client the drift loop has genuinely failed to recover.
 */
const DIVERGED_FOR_MS = 60_000;

interface ClientStats {
  drifts: number[];
  samples: number;
  lastDrift: number;
  divergentRunMs: number;
  longestDivergentRunMs: number;
}

/** Nearest-rank percentile. `sorted` must already be ascending. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function round(value: number, places = 3): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export class SyncSim {
  private readonly options: SyncSimOptions;
  private readonly scheduler: VirtualScheduler;
  private readonly server: SimServer;
  private readonly clients: SimClient[] = [];
  private readonly stats = new Map<string, ClientStats>();
  private readonly spreads: number[] = [];
  private readonly tickMs: number;
  private readonly durationMs: number;
  private scriptStepsSkipped = 0;
  private started = false;

  constructor(options: SyncSimOptions) {
    this.options = options;
    this.tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    this.durationMs = Math.max(0, options.durationSec) * 1000;

    const seed = options.seed ?? DEFAULT_SEED;
    const videoRef = options.videoRef ?? DEFAULT_VIDEO_REF;
    const videoDurationSec = options.videoDurationSec ?? DEFAULT_VIDEO_DURATION_SEC;

    // A fixed epoch, not `Date.now()`: the anchors in a failing run should be
    // the same numbers on every machine and every day.
    this.scheduler = new VirtualScheduler(Date.UTC(2025, 0, 1));
    this.server = new SimServer({
      scheduler: this.scheduler,
      videoRef,
      videoDurationSec,
      waitForSlow: options.waitForSlow ?? false,
    });

    for (const spec of options.clients) {
      // Both draws happen unconditionally, BEFORE the overrides are applied.
      // Reading them lazily would mean that pinning one client's `rateError`
      // shifted that client's seek latency too — the same trap the per-link RNG
      // streams exist to avoid (see rng.ts).
      const profile = stream(seed, `${spec.id}:profile`);
      const drawnRateError = 1 + (profile() * 2 - 1) * RATE_ERROR_SPREAD;
      const drawnSeekLatencyMs = Math.round(
        SEEK_LATENCY_INIT_MS * (SEEK_LATENCY_MIN_FACTOR + profile() * SEEK_LATENCY_FACTOR_SPREAD),
      );
      const rateError = spec.rateError ?? drawnRateError;
      const seekLatencyMs = spec.seekLatencyMs ?? drawnSeekLatencyMs;

      const link = new Link(this.scheduler, spec.id, seed, {
        latencyMs: spec.latencyMs ?? DEFAULT_LATENCY_MS,
        jitterMs: spec.jitterMs ?? 0,
        lossPct: spec.lossPct ?? 0,
      });

      this.clients.push(
        new SimClient({
          spec,
          scheduler: this.scheduler,
          server: this.server,
          link,
          videoRef,
          videoDurationSec,
          seekLatencyMs,
          rateError,
        }),
      );
      this.stats.set(spec.id, {
        drifts: [],
        samples: 0,
        lastDrift: 0,
        divergentRunMs: 0,
        longestDivergentRunMs: 0,
      });
    }
  }

  async run(): Promise<SimResult> {
    if (this.started) throw new Error('SyncSim.run() may only be called once');
    this.started = true;

    this.scheduler.install();
    try {
      // Players are advanced to the exact instant a timer is about to observe
      // them; without this every measurement would carry up to one step of bias.
      this.scheduler.setOnAdvance((fromMs, toMs) => {
        const delta = toMs - fromMs;
        for (const client of this.clients) client.tickPlayer(delta);
      });
      for (const client of this.clients) {
        this.scheduler.setClockSkew(client.id, client.spec.clockSkewMs ?? 0);
      }
      this.server.startHeartbeat();

      for (const client of this.clients) {
        if ((client.spec.joinsAtSec ?? 0) > 0) continue;
        this.scheduler.withOwner(client.id, () => {
          client.connect();
        });
      }
      await this.scheduler.advanceTo(WARMUP_MS);

      this.scheduleScenario();
      await this.scheduler.advanceTo(WARMUP_MS + this.durationMs);
    } finally {
      for (const client of this.clients) client.dispose();
      this.server.stop();
      this.scheduler.uninstall();
    }

    return this.summarise();
  }

  // ── scenario ──────────────────────────────────────────────────────────────

  private scheduleScenario(): void {
    const at = (sec: number): number => WARMUP_MS + sec * 1000;

    for (const client of this.clients) {
      const joinsAtSec = client.spec.joinsAtSec ?? 0;
      if (joinsAtSec > 0) {
        this.scheduler.scheduleAt(at(joinsAtSec), client.id, () => {
          client.connect();
        });
      }
      for (const outage of client.spec.disconnects ?? []) {
        this.scheduler.scheduleAt(at(outage.atSec), client.id, () => {
          client.disconnect();
        });
        this.scheduler.scheduleAt(at(outage.atSec + outage.forSec), client.id, () => {
          client.connect();
        });
      }
    }

    for (const step of this.options.script ?? []) {
      const client = this.clients.find((c) => c.id === step.client);
      // A step naming a client that does not exist is a typo in the scenario, and
      // silently dropping it is how a test ends up asserting against a script that
      // never ran. `scriptStepsSkipped === 0` is the assertion that catches an
      // altered scenario, so this path has to be loud — throwing at construction
      // beats counting, because there is no run in which this is recoverable.
      if (client === undefined) {
        const known = this.clients.map((c) => c.id).join(', ');
        throw new Error(
          `SyncSim script step at ${step.atSec}s names unknown client "${step.client}" (have: ${known})`,
        );
      }
      this.scheduler.scheduleAt(at(step.atSec), client.id, () => {
        if (!client.act(step.action, step.to)) this.scriptStepsSkipped += 1;
      });
    }

    const endMs = WARMUP_MS + this.durationMs;
    const sample = (): void => {
      const nowMs = this.scheduler.now();
      this.takeSample(nowMs);
      const next = nowMs + this.tickMs;
      if (next <= endMs) this.scheduler.scheduleAt(next, null, sample);
    };
    if (this.tickMs > 0 && this.durationMs > 0) {
      this.scheduler.scheduleAt(WARMUP_MS + this.tickMs, null, sample);
    }
  }

  private takeSample(nowMs: number): void {
    const roomSec = positionAt(this.server.getAnchor(), this.scheduler.serverNow());
    const wantsDetail = this.options.onSample !== undefined;
    const positions = wantsDetail ? new Map<string, number>() : null;
    const drifts = wantsDetail ? new Map<string, number>() : null;

    let lowest = Number.POSITIVE_INFINITY;
    let highest = Number.NEGATIVE_INFINITY;
    let joined = 0;

    for (const client of this.clients) {
      if (!client.isJoined) continue;
      const position = client.positionSec;
      const drift = position - roomSec;
      joined += 1;
      if (position < lowest) lowest = position;
      if (position > highest) highest = position;
      positions?.set(client.id, position);
      drifts?.set(client.id, drift);

      const stat = this.stats.get(client.id);
      if (stat === undefined) continue;
      const magnitude = Math.abs(drift);
      stat.drifts.push(magnitude);
      stat.samples += 1;
      stat.lastDrift = drift;
      if (magnitude > HARD_SEEK_AT_SEC) {
        stat.divergentRunMs += this.tickMs;
        stat.longestDivergentRunMs = Math.max(stat.longestDivergentRunMs, stat.divergentRunMs);
      } else {
        stat.divergentRunMs = 0;
      }
    }

    const spreadSec = joined >= 2 ? highest - lowest : 0;
    this.spreads.push(spreadSec);

    if (positions === null || drifts === null) return;
    const detail: SimSample = {
      atSec: (nowMs - WARMUP_MS) / 1000,
      roomSec,
      roomStatus: this.server.getAnchor().status,
      spreadSec,
      positions,
      drifts,
    };
    this.options.onSample?.(detail);
  }

  // ── results ───────────────────────────────────────────────────────────────

  private summarise(): SimResult {
    const spreads = [...this.spreads].sort((a, b) => a - b);

    let hardSeeks = 0;
    let coveredMs = 0;
    let divergedForever = false;
    const perClient: SimClientResult[] = [];

    for (const client of this.clients) {
      const stat = this.stats.get(client.id) ?? {
        drifts: [],
        samples: 0,
        lastDrift: 0,
        divergentRunMs: 0,
        longestDivergentRunMs: 0,
      };
      const sortedDrifts = [...stat.drifts].sort((a, b) => a - b);
      const clientCoveredMs =
        client.startedAtMono !== null && client.lastTelemetryMono !== null
          ? Math.max(0, client.lastTelemetryMono - client.startedAtMono)
          : 0;

      hardSeeks += client.hardSeeks;
      coveredMs += clientCoveredMs;
      if (stat.longestDivergentRunMs >= DIVERGED_FOR_MS) divergedForever = true;

      perClient.push({
        id: client.id,
        joinedAtSec:
          client.startedAtMono === null
            ? Number.NaN
            : round((client.startedAtMono - WARMUP_MS) / 1000),
        samples: stat.samples,
        driftP50: round(percentile(sortedDrifts, 0.5)),
        driftP95: round(percentile(sortedDrifts, 0.95)),
        driftMax: round(sortedDrifts.at(-1) ?? 0),
        finalDriftSec: round(stat.lastDrift),
        hardSeeks: client.hardSeeks,
        hardSeeksPerHour:
          clientCoveredMs > 0 ? round(client.hardSeeks / (clientCoveredMs / 3_600_000), 2) : 0,
        telemetryCoveredSec: round(clientCoveredMs / 1000, 1),
        reportedDriftP95: client.reportedDriftP95,
        reportedClockOffsetMs: client.reportedClockOffsetMs,
        controlsSent: client.controlsSent,
        controlsAccepted: client.controlsAccepted,
        controlsRejected: client.controlsRejected,
        bufferingReports: client.bufferingReports,
        longestDivergenceSec: round(stat.longestDivergentRunMs / 1000, 1),
        seeksIssued: client.seeksIssued,
      });
    }

    const rejected: Partial<Record<ControlRejectReason, number>> = {};
    let accepted = 0;
    for (const control of this.server.controls) {
      if (control.accepted) {
        accepted += 1;
        continue;
      }
      const reason = control.reason ?? 'recently_changed';
      rejected[reason] = (rejected[reason] ?? 0) + 1;
    }

    return {
      spreadP50: round(percentile(spreads, 0.5)),
      spreadP95: round(percentile(spreads, 0.95)),
      spreadMax: round(spreads.at(-1) ?? 0),
      hardSeeksPerClientPerHour: coveredMs > 0 ? round(hardSeeks / (coveredMs / 3_600_000), 2) : 0,
      divergedForever,
      conflictOutcome: classifyConflicts(this.server.controls),
      perClient,
      samples: this.spreads.length,
      controlsAccepted: accepted,
      controlsRejected: rejected,
      finalRevision: this.server.getAnchor().revision,
      scriptStepsSkipped: this.scriptStepsSkipped,
    };
  }
}

/**
 * Who won when two people fought the scrubber (§8.5).
 *
 * A conflict is defined the way the server defines one: controls from DIFFERENT
 * actors arriving inside `CONTROL_LOCK_MS` of each other. Two controls from the
 * same actor are a scrub, not a fight, and §8.5c is explicit that an actor is
 * never locked out of their own follow-ups.
 *
 * `none` is not a pass. It means the run never produced such a cluster, so the
 * property was not tested — which is exactly what happens with §15.3's own
 * example script, whose two "conflicting" seeks are a full second apart and
 * therefore both legitimately accepted.
 */
export function classifyConflicts(controls: readonly ControlRecord[]): ConflictOutcome {
  const ordered = [...controls].sort((a, b) => a.atServerMs - b.atServerMs);
  let clusters = 0;
  let split = false;

  for (let i = 0; i < ordered.length; i += 1) {
    const first = ordered[i];
    if (first === undefined) continue;
    const actors = new Set<string>([first.actorId]);
    const winners = new Set<string>(first.accepted ? [first.actorId] : []);
    let end = i;

    for (let j = i + 1; j < ordered.length; j += 1) {
      const next = ordered[j];
      if (next === undefined) break;
      if (next.atServerMs - first.atServerMs >= CONTROL_LOCK_MS) break;
      actors.add(next.actorId);
      if (next.accepted) winners.add(next.actorId);
      end = j;
    }

    if (actors.size >= 2) {
      clusters += 1;
      // Count distinct winning ACTORS, not accepted controls. §8.5c exempts an
      // actor from the lock for their OWN follow-ups — that exemption is what
      // makes scrubbing work — so one person dragging the handle legitimately
      // lands several accepted controls inside one window. Counting controls
      // reported that as a 'split', i.e. the failure outcome, for the single
      // most ordinary interaction in the product. What §8.5 actually promises is
      // that exactly one actor's intent reaches the timeline.
      if (winners.size !== 1) split = true;
      i = end;
    }
  }

  if (clusters === 0) return 'none';
  return split ? 'split' : 'single_winner';
}
