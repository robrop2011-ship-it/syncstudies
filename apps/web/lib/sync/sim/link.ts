/**
 * One client's network link (PLAN.md §15.3).
 *
 * Everything a client says to the server and everything the server says back
 * travels through here, so the sync engine experiences exactly what a real
 * participant does: a delay, a delay that is not the same twice, occasionally
 * nothing at all, and — during an outage — a wire that swallows whatever was
 * already in flight.
 *
 * Three properties are load-bearing:
 *
 *  1. **Delivery is ORDERED within a direction.** A Socket.IO connection rides
 *     on one TCP stream and cannot reorder, so jitter here can delay a message
 *     but never overtake an earlier one. Letting jitter reorder would be a
 *     kinder network in one respect and a much crueller one in another: an
 *     out-of-order `video:state` is dropped by the revision guard in §8.5b, so
 *     a reordering link would silently exercise the guard instead of the drift
 *     loop, and the harness would be measuring the wrong thing.
 *  2. **Liveness is checked at BOTH ends.** A message sent while the link is up
 *     and delivered after it went down never arrives — that is what a dropped
 *     connection is. Checking only at send time would let a 25 s outage still
 *     deliver its first 200 ms of traffic.
 *  3. **Each direction draws from its own RNG stream**, keyed by client id, so
 *     adding a seventh client to a scenario does not re-roll the other six
 *     (see the note at the top of rng.ts).
 */
import { chance, stream, symmetric, type Rng } from './rng';
import type { VirtualScheduler } from './scheduler';

/** The scheduler clamps to 1 ms anyway; delivering "instantly" is not a network. */
const MIN_DELAY_MS = 1;
/** Two messages never land in the same virtual millisecond, so order is total. */
const MIN_DELIVERY_GAP_MS = 1;
/** §15.3's `{ id: 'f', joinsAtSec: 900 }` names no latency; give it a plausible one. */
export const DEFAULT_LATENCY_MS = 40;

export interface LinkSpec {
  latencyMs: number;
  jitterMs: number;
  lossPct: number;
}

interface Direction {
  jitter: Rng;
  loss: Rng;
  /** Virtual time the last message in this direction was scheduled to land. */
  lastDeliveryMs: number;
}

export class Link {
  private readonly scheduler: VirtualScheduler;
  private readonly clientId: string;
  private readonly spec: LinkSpec;
  private readonly uplink: Direction;
  private readonly downlink: Direction;
  private connected = false;

  constructor(scheduler: VirtualScheduler, clientId: string, seed: number, spec: LinkSpec) {
    this.scheduler = scheduler;
    this.clientId = clientId;
    this.spec = spec;
    this.uplink = {
      jitter: stream(seed, `${clientId}:up:jitter`),
      loss: stream(seed, `${clientId}:up:loss`),
      lastDeliveryMs: Number.NEGATIVE_INFINITY,
    };
    this.downlink = {
      jitter: stream(seed, `${clientId}:down:jitter`),
      loss: stream(seed, `${clientId}:down:loss`),
      lastDeliveryMs: Number.NEGATIVE_INFINITY,
    };
  }

  get up(): boolean {
    return this.connected;
  }

  setUp(up: boolean): void {
    this.connected = up;
  }

  /**
   * Client → server. The callback runs with NO owner, so `Date.now()` inside it
   * is the server's unskewed clock (see the owner trick in scheduler.ts).
   */
  toServer(fn: () => void): void {
    this.deliver(this.uplink, null, fn);
  }

  /** Server → client. The callback runs as this client, skew and all. */
  toClient(fn: () => void): void {
    this.deliver(this.downlink, this.clientId, fn);
  }

  private deliver(direction: Direction, owner: string | null, fn: () => void): void {
    if (!this.connected) return;
    if (chance(direction.loss, this.spec.lossPct)) return;

    const delay = Math.max(
      MIN_DELAY_MS,
      this.spec.latencyMs + symmetric(direction.jitter, this.spec.jitterMs),
    );
    const at = Math.max(
      direction.lastDeliveryMs + MIN_DELIVERY_GAP_MS,
      this.scheduler.now() + delay,
    );
    direction.lastDeliveryMs = at;

    this.scheduler.scheduleAt(at, owner, () => {
      // In flight when the wire went down: the message is simply gone.
      if (!this.connected) return;
      fn();
    });
  }
}
