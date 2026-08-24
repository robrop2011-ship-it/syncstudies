'use client';

/**
 * Client ↔ server clock offset (PLAN.md §8.3).
 *
 * Every client must know `serverNow()` to within roughly 30 ms, because the
 * authoritative video state is an ANCHOR, not a position: `positionAt(anchor,
 * serverNow())` is the only thing that says where the room actually is. An
 * offset that is wrong by a second makes every participant seek to the wrong
 * place with complete confidence.
 *
 * The estimator is NTP-style, over Socket.IO acks:
 *
 *     offset = serverMs - (t0 + t2) / 2
 *
 * and then — this is the part that matters — MEDIAN OF THE BEST HALF BY RTT,
 * never the mean. The error in a single sample is dominated by *path asymmetry*
 * (the request leg and the reply leg not taking the same time). Asymmetry is
 * caused by queuing, and queuing shows up as RTT. So the high-RTT samples are
 * precisely the biased ones, and throwing them away throws away the bias. A mean
 * would let one 900 ms sample drag the whole estimate; a median of the fast half
 * simply ignores it.
 *
 * On re-sync the fresh estimate is folded into the previous one with an EWMA
 * (`CLOCK_EWMA_PREV`) rather than replacing it, so one bad network moment cannot
 * lurch the room's idea of "now" — which would look to every drift loop like a
 * real seek and cause a round of corrections that were never needed.
 *
 * Accuracy on typical residential Wi-Fi is ±10–25 ms, an order of magnitude
 * inside the 350 ms dead zone. Clock error is not the limiting factor here;
 * YouTube's ~4 Hz position granularity is.
 */
import { createContext, useContext } from 'react';
import {
  CLOCK_EWMA_PREV,
  CLOCK_MAX_RTT_MS,
  CLOCK_RESYNC_INTERVAL_MS,
  CLOCK_SAMPLES_JOIN,
  CLOCK_SAMPLES_PERIODIC,
  CLOCK_SAMPLES_VISIBLE,
  CLOCK_SAMPLE_SPACING_MS,
} from '@syncstudy/shared';
import type { TypedClientSocket } from '@/lib/socket/client';

interface Sample {
  offset: number;
  rtt: number;
}

/** Seed for the one-way estimate before the first sample lands (§8.3). */
const INITIAL_ONE_WAY_MS = 40;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * One ping, resolving to null rather than hanging.
 *
 * `emitWithAck` is not used: pairing it with socket.io's `timeout()` flag types
 * the resolved value as the timeout `Error` instead of the pong, and without the
 * flag a lost ack leaves a promise pending forever — which, inside a `for` loop
 * of 8 samples, wedges the whole sync. The callback form with our own timer is
 * both correctly typed and bounded.
 *
 * `t0` is read as late as possible and `t2` as early as possible: everything
 * between them that is not network time is asymmetry we invented ourselves.
 */
function ping(socket: TypedClientSocket, timeoutMs: number): Promise<Sample | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, timeoutMs);

    const t0 = Date.now();
    socket.emit('time:ping', { t0 }, (pong) => {
      const t2 = Date.now();
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!Number.isFinite(pong.serverMs)) {
        resolve(null);
        return;
      }
      resolve({ offset: pong.serverMs - (t0 + t2) / 2, rtt: t2 - t0 });
    });
  });
}

export class ServerClock {
  private readonly socket: TypedClientSocket;
  /** serverNow = Date.now() + offset. */
  private offset = 0;
  private oneWayMs = INITIAL_ONE_WAY_MS;
  private ready = false;
  /** Overlapping syncs would interleave their samples and fight over the EWMA. */
  private running: Promise<void> | null = null;
  private periodic: ReturnType<typeof setInterval> | null = null;
  private onVisible: (() => void) | null = null;

  constructor(socket: TypedClientSocket) {
    this.socket = socket;
  }

  async sync(count = CLOCK_SAMPLES_JOIN, spacingMs = CLOCK_SAMPLE_SPACING_MS): Promise<void> {
    const inFlight = this.running;
    if (inFlight !== null) return inFlight;

    const run = this.collect(count, spacingMs);
    this.running = run;
    try {
      await run;
    } finally {
      this.running = null;
    }
  }

  now(): number {
    return Date.now() + this.offset;
  }

  get oneWayDelayMs(): number {
    return this.oneWayMs;
  }

  get isReady(): boolean {
    return this.ready;
  }

  /**
   * The two scheduled re-syncs from §8.3 that are not tied to a socket event.
   *
   * `onSynced` fires after each one so the caller can publish the new offset;
   * the clock deliberately knows nothing about the store.
   */
  startSchedule(onSynced: () => void): void {
    this.stopSchedule();

    // Cheap keep-alive against crystal drift and NTP steps. Two samples is
    // enough because it is folded into an already-good estimate, not replacing it.
    this.periodic = setInterval(() => {
      void this.sync(CLOCK_SAMPLES_PERIODIC, CLOCK_SAMPLE_SPACING_MS).then(onSynced, () => undefined);
    }, CLOCK_RESYNC_INTERVAL_MS);

    if (typeof document === 'undefined') return;

    // §8.9: a background tab has its timers throttled to 1 Hz and then to once a
    // minute, and a laptop that slept has had `Date.now()` step by minutes. The
    // periodic sync above is exactly what got throttled, so coming back to the
    // foreground must re-sync immediately rather than waiting for it.
    const handler = (): void => {
      if (document.visibilityState !== 'visible') return;
      void this.sync(CLOCK_SAMPLES_VISIBLE, CLOCK_SAMPLE_SPACING_MS).then(onSynced, () => undefined);
    };
    this.onVisible = handler;
    document.addEventListener('visibilitychange', handler);
  }

  stopSchedule(): void {
    if (this.periodic !== null) {
      clearInterval(this.periodic);
      this.periodic = null;
    }
    if (this.onVisible !== null) {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', this.onVisible);
      }
      this.onVisible = null;
    }
  }

  private async collect(count: number, spacingMs: number): Promise<void> {
    const fresh: Sample[] = [];

    for (let i = 0; i < count; i += 1) {
      // A disconnected socket queues emits and never acks them; the timeout would
      // burn `count * CLOCK_MAX_RTT_MS` for nothing. The reconnect triggers its
      // own sync anyway.
      if (!this.socket.connected) break;

      const sample = await ping(this.socket, CLOCK_MAX_RTT_MS);
      if (sample !== null && sample.rtt <= CLOCK_MAX_RTT_MS) fresh.push(sample);
      if (i < count - 1) await sleep(spacingMs);
    }

    // Keep the previous offset rather than adopting nothing. A sync that fails
    // entirely means the network is bad, and a stale offset from ten seconds ago
    // is far better than zero.
    if (fresh.length === 0) return;

    fresh.sort((a, b) => a.rtt - b.rtt);
    const best = fresh.slice(0, Math.max(1, Math.ceil(fresh.length / 2)));
    const nextOffset = median(best.map((s) => s.offset));
    const nextOneWay = median(best.map((s) => s.rtt)) / 2;

    // First sync: adopt outright — there is nothing to blend with, and blending
    // with the zero seed would leave us 30% wrong for the first half-minute.
    this.offset = this.ready
      ? this.offset * CLOCK_EWMA_PREV + nextOffset * (1 - CLOCK_EWMA_PREV)
      : nextOffset;
    this.oneWayMs = this.ready
      ? this.oneWayMs * CLOCK_EWMA_PREV + nextOneWay * (1 - CLOCK_EWMA_PREV)
      : nextOneWay;
    this.ready = true;
  }
}

/**
 * Null until the room's socket exists — the clock is created with the socket
 * inside the provider's effect, so the first render has neither.
 */
export const ServerClockContext = createContext<ServerClock | null>(null);

export function useServerClock(): ServerClock | null {
  return useContext(ServerClockContext);
}
