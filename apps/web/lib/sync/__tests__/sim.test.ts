/**
 * The sync simulator's assertions (PLAN.md §15.3).
 *
 * This is the regression gate for the sync engine. Every test below runs the
 * REAL `SyncController`, the REAL `ServerClock` and the REAL server decision
 * functions from `@syncstudy/shared`; the only fakes are a player and a wire.
 * So a green run here is a statement about production code, not about a model
 * of it — which is the entire reason §15.3 calls this "the highest-leverage
 * test asset in the project".
 *
 * Nothing in here asserts on a magic number that is not either a shared
 * constant or a figure §15.3 names, and nothing is tuned to make a run pass.
 * Where a measurement disagrees with §15.3's target the assertion is left at
 * §15.3's target and the disagreement is a finding — see the long comment above
 * the hard-seek assertion.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { DEAD_ZONE_SEC, HARD_SEEK_AT_SEC, SOFT_MAX_SEC } from '@syncstudy/shared';
import { SyncSim, type SimClientResult, type SimResult, type SyncSimOptions } from '@/lib/sync/sim';

/** Fixed, so a failure here is reproducible from this file alone. */
const SEED = 7;
/** A 30-minute study session, as §15.3 specifies. */
const MAIN_DURATION_SEC = 1_800;
const MAIN_TICK_MS = 50;
/** §15.3's own targets. */
const SPREAD_P95_TARGET_SEC = 0.6;
const HARD_SEEKS_PER_CLIENT_PER_HOUR_TARGET = 4;
/** §15.4: "C joins 5 minutes in → lands within 1s of the room position." */
const LATE_JOIN_TOLERANCE_SEC = 1;

/**
 * §15.3's client list: five participants from the start on links spanning an
 * order of magnitude, plus a late joiner. One clock is 2.4 s wrong, one player
 * stalls, one connection drops.
 */
function mainClients(): SyncSimOptions['clients'] {
  return [
    { id: 'a', latencyMs: 25, jitterMs: 5, clockSkewMs: 0 },
    // The one that proves the offset arithmetic INCLUDING ITS SIGN (§15.2).
    { id: 'b', latencyMs: 90, jitterMs: 30, clockSkewMs: 2_400 },
    { id: 'c', latencyMs: 220, jitterMs: 60, lossPct: 2 },
    // A 4 s ad break. `atVideoSec` is a position in the LECTURE, and 600 s is
    // reached mid-session because the script leaves the room playing from 200.
    { id: 'd', latencyMs: 45, jitterMs: 10, stalls: [{ atVideoSec: 600, forSec: 4 }] },
    { id: 'e', latencyMs: 60, jitterMs: 15, disconnects: [{ atSec: 600, forSec: 25 }] },
    { id: 'f', latencyMs: 55, jitterMs: 12, joinsAtSec: 900 },
  ];
}

/** §15.3's script, verbatim. */
function mainScript(): NonNullable<SyncSimOptions['script']> {
  return [
    { atSec: 0, client: 'a', action: 'play' },
    { atSec: 120, client: 'c', action: 'seek', to: 900 },
    { atSec: 121, client: 'b', action: 'seek', to: 200 },
    { atSec: 400, client: 'a', action: 'pause' },
    { atSec: 405, client: 'a', action: 'play' },
  ];
}

function client(result: SimResult, id: string): SimClientResult {
  const found = result.perClient.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no client ${id} in the result`);
  return found;
}

describe('SyncSim — six clients, thirty minutes, adversarial network (§15.3)', () => {
  let result: SimResult;
  /** The late joiner's signed drift, sampled, so §15.4's claim is checkable. */
  const lateJoinerDrift: number[] = [];

  beforeAll(async () => {
    const sim = new SyncSim({
      clients: mainClients(),
      script: mainScript(),
      durationSec: MAIN_DURATION_SEC,
      tickMs: MAIN_TICK_MS,
      seed: SEED,
      onSample: (sample) => {
        const drift = sample.drifts.get('f');
        if (drift !== undefined) lateJoinerDrift.push(drift);
      },
    });
    result = await sim.run();
  }, 60_000);

  it('keeps every participant inside the same fraction of a second', () => {
    // The number a user perceives: the widest gap between any two people in the
    // room, at every sampled instant. §15.3 targets p50 < 0.25 and p95 < 0.60.
    expect(result.spreadP95).toBeLessThan(SPREAD_P95_TARGET_SEC);
    expect(result.samples).toBe((MAIN_DURATION_SEC * 1_000) / MAIN_TICK_MS);
    // Every scripted action reached a client that was actually in the room. A
    // skipped step would mean the scenario silently was not the one written.
    expect(result.scriptStepsSkipped).toBe(0);
  });

  it('leaves nobody stuck out of sync', () => {
    // Nobody spent a full minute past HARD_SEEK_AT_SEC: the ad break, the
    // 25-second outage and the two chapter jumps were all recovered from.
    expect(result.divergedForever).toBe(false);
    for (const entry of result.perClient) {
      expect(Math.abs(entry.finalDriftSec)).toBeLessThan(SOFT_MAX_SEC);
      expect(entry.longestDivergenceSec).toBeLessThan(30);
    }
  });

  /**
   * ── A FINDING, NOT A TUNING PROBLEM ───────────────────────────────────────
   * This assertion FAILS at the time of writing. The assertion is right; the
   * counter behind it is not, and `controller.ts` is where the fix belongs.
   *
   * `hardSeeksPerClientPerHour` is read from the controller's own §16.5
   * telemetry (`reportDrift.hardSeeks`) — the same counter `apps/realtime`
   * feeds into `hardSeeksTotal` on `/metrics`. This run reports 15 hard seeks
   * over 2.74 client-hours (5.47/hour). Of those 15:
   *
   *    13  are the direct, expected response to somebody pressing play or seek
   *        (the status-mismatch branch, and `forceToAnchor` after a big jump),
   *     1  is an ad break recovering,
   *     1  is a late joiner landing on the room,
   *     0  are a drift correction that failed.
   *
   * `SyncController.hardSeekTo()` increments the counter unconditionally, but
   * §8.6's pseudocode calls `markHardSeek()` in step 4 ONLY — the hard band. So
   * the metric counts room ACTIVITY rather than sync FAILURE, and the tell is
   * that the rate depends on session length: the same 15 seeks are 5.47/hour
   * over 1800 s and 2.61/hour over 3600 s. No genuine failure rate halves when
   * you keep watching. Dropping the 13 control responses leaves 2 seeks over
   * 2.74 client-hours — 0.73/hour, which is what the §15.3 threshold was
   * written for.
   *
   * Leave the assertion at §15.3's target. Do not relax it to match the current
   * counter — fix the counter.
   */
  it('does not jar the room with hard seeks (KNOWN FAILURE — see the comment above)', () => {
    expect(result.hardSeeksPerClientPerHour).toBeLessThan(HARD_SEEKS_PER_CLIENT_PER_HOUR_TARGET);
  });

  it('converges the client whose clock is 2.4 s wrong (§15.2)', () => {
    const skewed = client(result, 'b');

    // The sign check. `clock.now() - Date.now()` must come back as MINUS the
    // skew: a client whose clock reads 2.4 s ahead needs 2.4 s subtracted to
    // reach server time. Flip the sign in `ServerClock` and this reads +2400,
    // the client computes every `expected` 4.8 s from the truth, and it spends
    // the session hard-seeking. The exact proof is in the A/B pair below.
    expect(skewed.reportedClockOffsetMs).toBeGreaterThan(-2_500);
    expect(skewed.reportedClockOffsetMs).toBeLessThan(-2_300);

    // Its own drift is inside the dead zone at the median and at the end of the
    // run — a leaked skew would park it permanently outside.
    expect(skewed.driftP50).toBeLessThan(DEAD_ZONE_SEC);
    expect(Math.abs(skewed.finalDriftSec)).toBeLessThan(DEAD_ZONE_SEC);
  });

  it('lands a late joiner within a second of the room (§15.4)', () => {
    const late = client(result, 'f');
    expect(late.joinedAtSec).toBeGreaterThanOrEqual(900);
    // The join costs a clock sync plus a snapshot round trip; on a 55 ms link
    // that must not run to more than a couple of seconds.
    expect(late.joinedAtSec).toBeLessThan(905);

    // Within a second from its very FIRST measured instant, not "eventually".
    // §8.7 loads the player at `positionAt(anchor) + JOIN_LOAD_LEAD_SEC`
    // precisely so a new arrival never sees a frozen frame and never has to be
    // dragged into place.
    expect(lateJoinerDrift.length).toBeGreaterThan(0);
    const worst = Math.max(...lateJoinerDrift.map((drift) => Math.abs(drift)));
    expect(worst).toBeLessThan(LATE_JOIN_TOLERANCE_SEC);
    expect(late.driftP95).toBeLessThan(DEAD_ZONE_SEC);
  });
});

describe('SyncSim — clock skew is fully absorbed by the offset (§8.3, §15.2)', () => {
  const skewScenario = (skewMs: number): SyncSim =>
    new SyncSim({
      clients: mainClients().map((spec) =>
        spec.id === 'b' ? { ...spec, clockSkewMs: skewMs } : spec,
      ),
      script: mainScript(),
      durationSec: 600,
      tickMs: MAIN_TICK_MS,
      seed: SEED,
    });

  it('produces a bit-identical session with and without a 2.4 s skew', async () => {
    const skewed = await skewScenario(2_400).run();
    const straight = await skewScenario(0).run();

    // The strongest statement available: a client whose `Date.now()` is 2.4 s
    // wrong plays the session EXACTLY as it would with a correct clock — same
    // positions, same drift percentiles, same seeks, same everything, for every
    // client in the room. `ServerClock` cancels the skew entirely rather than
    // merely surviving it.
    //
    // Comparing whole results rather than one client's drift is what makes this
    // airtight. `reportedClockOffsetMs` is the one field that MUST differ — it
    // is the measurement of the skew — so it is compared separately, and its
    // sign is the thing being proved: subtracting a clock that reads late, not
    // adding it.
    const normalise = (result: SimResult): SimResult => ({
      ...result,
      perClient: result.perClient.map((entry) => ({ ...entry, reportedClockOffsetMs: 0 })),
    });
    expect(normalise(skewed)).toEqual(normalise(straight));

    expect(client(skewed, 'b').reportedClockOffsetMs).toBeGreaterThan(-2_500);
    expect(client(skewed, 'b').reportedClockOffsetMs).toBeLessThan(-2_300);
    expect(Math.abs(client(straight, 'b').reportedClockOffsetMs)).toBeLessThan(50);
  }, 60_000);
});

describe('SyncSim — two people fight the scrubber (§8.5)', () => {
  /**
   * §15.3's own script puts its "deliberate conflict" a full second apart,
   * which `CONTROL_LOCK_MS` (600 ms) does not consider a conflict at all — both
   * seeks are legitimately accepted and the run reports `conflictOutcome:
   * 'none'`. To actually exercise §8.5 the two seeks have to land inside the
   * lock window, so this scenario puts them 200 ms apart, as §15.4's
   * `sync.spec.ts` line does.
   */
  async function raceSeeks(): Promise<SimResult> {
    const sim = new SyncSim({
      clients: [
        { id: 'a', latencyMs: 25, jitterMs: 5 },
        { id: 'b', latencyMs: 90, jitterMs: 20 },
        { id: 'c', latencyMs: 120, jitterMs: 30 },
        { id: 'd', latencyMs: 45, jitterMs: 10 },
      ],
      script: [
        { atSec: 0, client: 'a', action: 'play' },
        { atSec: 60, client: 'b', action: 'seek', to: 600 },
        { atSec: 60.2, client: 'c', action: 'seek', to: 1_200 },
      ],
      durationSec: 180,
      tickMs: MAIN_TICK_MS,
      seed: SEED,
    });
    return sim.run();
  }

  it('lets exactly one anchor win, and everybody converges on it', async () => {
    const result = await raceSeeks();

    expect(result.conflictOutcome).toBe('single_winner');
    // set_video + play + exactly ONE of the two seeks. Three revisions means
    // the losing seek never touched the timeline: it was not applied and then
    // undone, it was refused (§8.5b).
    expect(result.finalRevision).toBe(3);
    expect(result.controlsAccepted).toBe(2);
    const refusals = Object.values(result.controlsRejected).reduce((sum, count) => sum + count, 0);
    expect(refusals).toBe(1);

    // …and the loser is not left sitting where it optimistically seeked to.
    // Every client — including the one whose intent was refused — ends on the
    // winning timeline (§8.5d).
    for (const entry of result.perClient) {
      expect(Math.abs(entry.finalDriftSec)).toBeLessThan(DEAD_ZONE_SEC);
    }
    expect(result.spreadP95).toBeLessThan(SPREAD_P95_TARGET_SEC);
    expect(result.divergedForever).toBe(false);
  }, 30_000);
});

describe('SyncSim — a slow client must not degrade the room (§8.1 rule 4, §8.10)', () => {
  function stallScenario(waitForSlow: boolean): SyncSim {
    return new SyncSim({
      clients: [
        { id: 'a', latencyMs: 30, jitterMs: 8 },
        { id: 'b', latencyMs: 50, jitterMs: 12 },
        // Eight seconds of dead air: comfortably past BUFFERING_REPORT_AFTER_MS,
        // so the room definitely hears about it.
        { id: 'slow', latencyMs: 70, jitterMs: 20, stalls: [{ atVideoSec: 60, forSec: 8 }] },
      ],
      script: [{ atSec: 0, client: 'a', action: 'play' }],
      durationSec: 240,
      tickMs: MAIN_TICK_MS,
      seed: SEED,
      waitForSlow,
    });
  }

  it('does not pause the room for a stalling client when wait_for_slow is off', async () => {
    const result = await stallScenario(false).run();

    // set_video + play, and nothing else ever touched the timeline. The stall
    // was reported and the server chose to do nothing with it — the default
    // policy, and the whole of §8.1 rule 4.
    expect(result.finalRevision).toBe(2);
    expect(client(result, 'slow').bufferingReports).toBeGreaterThan(0);

    // The two healthy clients never noticed: their drift stays inside the dead
    // zone for the entire run, including the eight seconds their friend was
    // stuck.
    for (const id of ['a', 'b']) {
      expect(client(result, id).driftP95).toBeLessThan(DEAD_ZONE_SEC);
    }
    // The stalling client itself falls behind — that is the trade §8.10 makes —
    // and then catches up on its own rather than being waited for.
    expect(client(result, 'slow').driftMax).toBeGreaterThan(HARD_SEEK_AT_SEC);
    expect(Math.abs(client(result, 'slow').finalDriftSec)).toBeLessThan(DEAD_ZONE_SEC);
    expect(result.divergedForever).toBe(false);
  }, 30_000);

  it('DOES pause the room when the host turns wait_for_slow on', async () => {
    // The control case. Without it, "the room was not paused" cannot be told
    // apart from "the buffering report never arrived", and the test above would
    // pass against a server that ignores §8.10 entirely.
    const result = await stallScenario(true).run();
    expect(result.finalRevision).toBeGreaterThan(2);
  }, 30_000);
});

describe('SyncSim — determinism', () => {
  const options = (seed: number): SyncSimOptions => ({
    clients: mainClients(),
    script: mainScript(),
    durationSec: 600,
    tickMs: MAIN_TICK_MS,
    seed,
  });

  it('produces identical results for the same seed and script', async () => {
    const first = await new SyncSim(options(SEED)).run();
    const second = await new SyncSim(options(SEED)).run();

    // Deep equality on the whole result, not on a couple of headline numbers: a
    // harness that is only mostly deterministic is one whose failures cannot be
    // reproduced from the seed printed in CI, which makes it useless as a gate.
    expect(second).toEqual(first);
  }, 60_000);

  it('is sensitive to the seed, so the equality above is not a constant', async () => {
    const first = await new SyncSim(options(SEED)).run();
    const second = await new SyncSim(options(SEED + 1)).run();
    expect(second).not.toEqual(first);
  }, 60_000);
});
