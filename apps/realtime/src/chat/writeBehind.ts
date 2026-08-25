/**
 * Write-behind persistence (PLAN.md §6.5).
 *
 * The rule this exists to enforce: **a broadcast is never allowed to wait for
 * Postgres.** A chat message is fanned out to the room with a server-assigned id
 * and timestamp, and only then does the INSERT get queued. The socket path stays
 * at Redis latency; the database catches up within the flush interval.
 *
 * Three properties, each of which is load-bearing:
 *
 * 1. **One flush in flight at a time.** Concurrent batches would reach Postgres
 *    in an order nobody controls, and would turn a slow database into a
 *    connection-pool stampede at exactly the moment it can least afford one.
 * 2. **A failed batch goes back to the FRONT of the queue.** Appending it would
 *    reorder messages against the ones queued while it was in flight — a
 *    transcript that reads out of order after a transient database blip.
 * 3. **Bounded, with an explicit answer for overflow.** §6.5 says drop
 *    presence-like data first and never chat. When the queue is chat-only that
 *    instruction runs out, so the trade-off is made here and named: past
 *    `maxQueue` items the oldest are dropped, loudly and with a metric. That
 *    only happens when Postgres has been unreachable for minutes, and the
 *    alternative — growing until the node is OOM-killed — drops the same
 *    messages *and* ends everyone's live session at the same time.
 *
 * Generic on purpose: Phase 7's note and checklist upserts want the same queue
 * with a different `write`.
 */
import type { Logger } from '../logger.js';
import { writeBehindDepth, writeBehindDroppedTotal, writeBehindFailuresTotal } from '../metrics.js';

export interface WriteBehindOptions<T> {
  /** Metric label and log field. One queue per kind of write. */
  name: string;
  /** How long a lone item may sit before it is written. */
  flushMs: number;
  /** Rows per INSERT. Reached early, the timer does not wait. */
  maxBatch: number;
  /** Hard ceiling on unwritten items. See property 3 above. */
  maxQueue: number;
  /**
   * Retries for one batch before it is dropped. A batch that fails five times
   * is not a blip — it is a row Postgres will never accept (a room deleted
   * underneath it, say) — and retrying it forever blocks every message behind
   * it.
   */
  maxAttempts: number;
  write: (batch: T[]) => Promise<void>;
  log: Logger;
}

export class WriteBehind<T> {
  private readonly opts: WriteBehindOptions<T>;
  private queue: T[] = [];
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private attempts = 0;
  private stopped = false;

  constructor(opts: WriteBehindOptions<T>) {
    this.opts = opts;
  }

  get depth(): number {
    return this.queue.length;
  }

  /**
   * Queue one item. Never throws, never blocks, never returns a promise you are
   * expected to await — a caller that awaited this would reintroduce exactly the
   * coupling the queue exists to remove.
   */
  push(item: T): void {
    if (this.stopped) {
      this.opts.log.warn({ queue: this.opts.name }, 'write-behind push after stop');
      return;
    }
    this.queue.push(item);

    if (this.queue.length > this.opts.maxQueue) {
      const overflow = this.queue.length - this.opts.maxQueue;
      this.queue.splice(0, overflow);
      writeBehindDroppedTotal.inc({ queue: this.opts.name }, overflow);
      this.opts.log.error(
        { queue: this.opts.name, dropped: overflow, depth: this.queue.length },
        'write-behind queue overflow — durable writes are being dropped',
      );
    }
    writeBehindDepth.set({ queue: this.opts.name }, this.queue.length);

    if (this.queue.length >= this.opts.maxBatch) {
      void this.flush();
      return;
    }
    this.arm();
  }

  /**
   * Flush everything currently queued and wait for it.
   *
   * The join path calls this before reading history, so a message this node
   * broadcast a moment ago is in Postgres by the time the joiner's snapshot
   * query runs. It cannot close the same window for a message broadcast by a
   * *different* node — that one is in the other node's queue — which is why the
   * client dedupes by message id and the socket joins the room channel before
   * the snapshot is built. Late is possible; lost and out-of-order are not.
   *
   * `timeoutMs` bounds how long a caller is willing to wait. The join path
   * passes one: a database that has stopped answering must cost a joiner a
   * missing recent message, not a hung join. Without it, drain runs to
   * completion — that is the shutdown path, where finishing is the point.
   */
  async drain(timeoutMs?: number): Promise<void> {
    const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
    while (this.queue.length > 0 || this.inFlight !== null) {
      if (Date.now() >= deadline) return;
      await this.flush();
    }
  }

  /** Final drain, then no further work. Safe to call twice. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // `stopped` blocks new pushes, so this terminates.
    await this.drain().catch(() => undefined);
  }

  private arm(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.opts.flushMs);
    // A pending flush must not hold the process open past SIGTERM; `stop()` is
    // what guarantees the data lands, not the timer.
    this.timer.unref();
  }

  private flush(): Promise<void> {
    const existing = this.inFlight;
    if (existing !== null) return existing;
    if (this.queue.length === 0) return Promise.resolve();

    const batch = this.queue.splice(0, this.opts.maxBatch);
    writeBehindDepth.set({ queue: this.opts.name }, this.queue.length);

    const run = this.opts
      .write(batch)
      .then(() => {
        this.attempts = 0;
      })
      .catch((err: unknown) => {
        this.attempts += 1;
        writeBehindFailuresTotal.inc({ queue: this.opts.name });
        if (this.attempts >= this.opts.maxAttempts) {
          writeBehindDroppedTotal.inc({ queue: this.opts.name }, batch.length);
          this.opts.log.error(
            { queue: this.opts.name, size: batch.length, attempts: this.attempts, err },
            'write-behind batch dropped after repeated failures',
          );
          this.attempts = 0;
          return;
        }
        // Front, not back — see property 2.
        this.queue.unshift(...batch);
        writeBehindDepth.set({ queue: this.opts.name }, this.queue.length);
        this.opts.log.warn(
          { queue: this.opts.name, size: batch.length, attempts: this.attempts, err },
          'write-behind batch failed; will retry',
        );
      })
      .finally(() => {
        this.inFlight = null;
        if (this.queue.length > 0 && !this.stopped) this.arm();
      });

    this.inFlight = run;
    return run;
  }
}
