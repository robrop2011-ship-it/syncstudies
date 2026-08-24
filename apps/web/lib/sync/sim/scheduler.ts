/**
 * The virtual clock the whole simulator runs on (PLAN.md §15.3).
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The simulator's requirement is to run the REAL `SyncController` and the REAL
 * `ServerClock`, unmodified, with no browser and no wall clock — so that thirty
 * minutes of session take milliseconds and two runs of the same seed are
 * bit-for-bit identical. Both of those classes reach for time in three ways, and
 * only one of them is injectable:
 *
 *   1. `deps.now()` — the controller's monotonic clock. Injectable. Done.
 *   2. `setTimeout` / `setInterval` — the 2 Hz drift loop, the 30 s telemetry
 *      flush, the clock's 30 s re-sync, the rate-restore timer, the auto-sync
 *      timeout. NOT injectable, and rewriting them to be would mean changing
 *      production code to suit its test harness.
 *   3. `Date.now()` — `ServerClock` is *built* on it: `now() = Date.now() +
 *      offset`. This is the one we most need control of, because a client with a
 *      2.4 s clock skew is precisely a client whose `Date.now()` is 2.4 s off,
 *      and that scenario is what proves the offset arithmetic and its sign.
 *
 * So this scheduler owns global time for the duration of a run: it replaces the
 * four timer globals and `Date.now`, and restores them afterwards. Nothing under
 * `sim/` ever calls a real clock.
 *
 * ── THE OWNER TRICK ─────────────────────────────────────────────────────────
 * `Date.now()` is global but clock skew is per client, so the scheduler tracks
 * whose code is currently running. Every timer remembers the client that created
 * it; before invoking one, that client becomes the current owner and `Date.now`
 * starts answering with their skew. Timers created inside a callback inherit the
 * owner, which is how `ServerClock.collect()` keeps a consistent view of "now"
 * across its `await sleep(50)`s.
 *
 * The owner deliberately stays installed across the microtask drain that follows
 * each callback. That is what makes `const t0 = Date.now()` inside a promise
 * continuation read the right client's clock — and getting it wrong would show
 * up as a plausible-looking few-millisecond error rather than as a crash.
 *
 * ── ORDERING ────────────────────────────────────────────────────────────────
 * Ties are broken by insertion sequence, never by iteration order of a Map, so
 * two timers due in the same millisecond always fire in the order they were
 * created. Determinism has no other source.
 */

/** Node clamps `setTimeout(fn, 0)` to 1 ms; matching it avoids busy schedules. */
const MIN_DELAY_MS = 1;
/** A self-rescheduling zero-delay timer would otherwise spin forever. */
const MAX_CALLBACKS_PER_ADVANCE = 2_000_000;

interface VirtualTimer {
  id: number;
  dueMs: number;
  seq: number;
  fn: () => void;
  /** null for a one-shot timeout; the period for an interval. */
  periodMs: number | null;
  owner: string | null;
}

/** The four globals we swap out, in a shape TypeScript will let us assign to. */
interface TimerGlobals {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
}

/**
 * Drain the microtask queue completely.
 *
 * `await Promise.resolve()` is not enough: it queues our continuation at the
 * back of the queue as it stands *now*, so a promise chain three links deep is
 * still mid-flight when we resume. `setImmediate` is a macrotask, and the
 * microtask queue is fully drained before any macrotask runs — which is exactly
 * the guarantee we need, and it costs no virtual time.
 */
function drainMicrotasks(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

export class VirtualScheduler {
  /** Virtual milliseconds since the run began. Never goes backwards. */
  private nowMs = 0;
  private readonly epochMs: number;
  private readonly timers = new Map<number, VirtualTimer>();
  private nextId = 1;
  private seqCounter = 0;

  private owner: string | null = null;
  private readonly skewMs = new Map<string, number>();

  private saved: TimerGlobals | null = null;
  private savedDateNow: (() => number) | null = null;

  /**
   * Called before time moves, so simulated players can be advanced to the exact
   * instant a timer is about to observe them. Without it a drift tick would read
   * a position that is up to one step stale, and every measurement in the
   * simulator would carry that as a bias.
   */
  private onAdvance: ((fromMs: number, toMs: number) => void) | null = null;

  constructor(epochMs: number) {
    this.epochMs = epochMs;
  }

  // ── time ──────────────────────────────────────────────────────────────────

  /** Virtual ms since the run began. The monotonic clock (`performance.now`). */
  now(): number {
    return this.nowMs;
  }

  /** True server epoch ms. What the simulated server stamps into anchors. */
  serverNow(): number {
    return this.epochMs + this.nowMs;
  }

  setClockSkew(ownerId: string, skewMs: number): void {
    this.skewMs.set(ownerId, skewMs);
  }

  setOnAdvance(fn: (fromMs: number, toMs: number) => void): void {
    this.onAdvance = fn;
  }

  /**
   * Run `fn` as if it were `ownerId`'s code — their `Date.now()`, and any timer
   * it creates belongs to them. Used for the sim's own pokes at a client (a
   * scripted play, a join) so those are indistinguishable from the client acting
   * on its own.
   */
  withOwner<T>(ownerId: string | null, fn: () => T): T {
    const previous = this.owner;
    this.owner = ownerId;
    try {
      return fn();
    } finally {
      this.owner = previous;
    }
  }

  // ── scheduling ────────────────────────────────────────────────────────────

  /** Schedule an event at an absolute virtual time. The sim's own script uses this. */
  scheduleAt(atMs: number, ownerId: string | null, fn: () => void): number {
    return this.insert({
      id: this.nextId++,
      dueMs: Math.max(this.nowMs, atMs),
      seq: this.seqCounter++,
      fn,
      periodMs: null,
      owner: ownerId,
    });
  }

  /** Schedule `delayMs` from now, as the patched `setTimeout` does. */
  scheduleIn(delayMs: number, ownerId: string | null, fn: () => void): number {
    return this.scheduleAt(this.nowMs + Math.max(MIN_DELAY_MS, delayMs), ownerId, fn);
  }

  cancel(id: number): void {
    this.timers.delete(id);
  }

  private insert(timer: VirtualTimer): number {
    this.timers.set(timer.id, timer);
    return timer.id;
  }

  private peek(): VirtualTimer | null {
    let best: VirtualTimer | null = null;
    for (const timer of this.timers.values()) {
      if (best === null || timer.dueMs < best.dueMs || (timer.dueMs === best.dueMs && timer.seq < best.seq)) {
        best = timer;
      }
    }
    return best;
  }

  // ── running ───────────────────────────────────────────────────────────────

  /**
   * Move virtual time to `targetMs`, firing everything due on the way.
   *
   * Async because each callback is followed by a full microtask drain: the
   * controller chains off `player.play()` and `clock.sync()`, and a synchronous
   * advance would leave those continuations queued behind the *next* timer,
   * quietly reordering cause and effect.
   */
  async advanceTo(targetMs: number): Promise<void> {
    let budget = MAX_CALLBACKS_PER_ADVANCE;

    for (;;) {
      const next = this.peek();
      if (next === null || next.dueMs > targetMs) break;

      this.step(next.dueMs);
      this.timers.delete(next.id);
      if (next.periodMs !== null) {
        // Re-armed with the SAME id before the callback runs, so a callback that
        // calls clearInterval on itself still cancels the next firing.
        this.insert({ ...next, dueMs: next.dueMs + next.periodMs, seq: this.seqCounter++ });
      }

      this.owner = next.owner;
      next.fn();
      await drainMicrotasks();

      budget -= 1;
      if (budget <= 0) throw new Error('VirtualScheduler: runaway timer schedule');
    }

    this.step(targetMs);
  }

  private step(toMs: number): void {
    if (toMs <= this.nowMs) return;
    this.onAdvance?.(this.nowMs, toMs);
    this.nowMs = toMs;
  }

  // ── global installation ───────────────────────────────────────────────────

  install(): void {
    if (this.saved !== null) throw new Error('VirtualScheduler is already installed');
    const globals = globalThis as unknown as TimerGlobals;
    this.saved = {
      setTimeout: globals.setTimeout,
      clearTimeout: globals.clearTimeout,
      setInterval: globals.setInterval,
      clearInterval: globals.clearInterval,
    };
    this.savedDateNow = Date.now;

    // The shims return a plain number where Node returns a `Timeout` object.
    // Nothing in the sync engine or the clock calls a method on the handle — it
    // only ever passes it straight back to clear{Timeout,Interval} — so the
    // narrower handle is safe, and the cast is the price of not asking
    // production code to accept an injected scheduler.
    const setTimeoutShim = (fn: () => void, ms?: number): number =>
      this.scheduleIn(ms ?? 0, this.owner, fn);
    const setIntervalShim = (fn: () => void, ms?: number): number => {
      const period = Math.max(MIN_DELAY_MS, ms ?? 0);
      return this.insert({
        id: this.nextId++,
        dueMs: this.nowMs + period,
        seq: this.seqCounter++,
        fn,
        periodMs: period,
        owner: this.owner,
      });
    };
    const clearShim = (handle?: unknown): void => {
      if (typeof handle === 'number') this.cancel(handle);
    };

    globals.setTimeout = setTimeoutShim as unknown as typeof setTimeout;
    globals.setInterval = setIntervalShim as unknown as typeof setInterval;
    globals.clearTimeout = clearShim as unknown as typeof clearTimeout;
    globals.clearInterval = clearShim as unknown as typeof clearInterval;

    Date.now = (): number => this.epochMs + this.nowMs + (this.skewMs.get(this.owner ?? '') ?? 0);
  }

  uninstall(): void {
    if (this.saved === null) return;
    const globals = globalThis as unknown as TimerGlobals;
    globals.setTimeout = this.saved.setTimeout;
    globals.clearTimeout = this.saved.clearTimeout;
    globals.setInterval = this.saved.setInterval;
    globals.clearInterval = this.saved.clearInterval;
    this.saved = null;
    if (this.savedDateNow !== null) {
      Date.now = this.savedDateNow;
      this.savedDateNow = null;
    }
    this.timers.clear();
    this.owner = null;
  }
}
