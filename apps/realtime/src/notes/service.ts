/**
 * Durable persistence for the shared notes document (PLAN.md §6.5, §14 Phase 7.7).
 *
 * The same write-behind queue chat uses, with a different `write` — which is
 * what `WriteBehind` was written generically for. The difference from chat is
 * that notes **coalesce**: fifty keystrokes in a room produce fifty queued
 * markers and exactly one UPDATE, because the row is the whole document rather
 * than an append. So the queue carries a room id, not a row.
 *
 * Unlike a chat message, an unwritten note edit is not the only copy: Redis
 * holds the live document and a cold read re-hydrates from whatever did land.
 * The queue is still drained on SIGTERM, because "at most one debounce window"
 * is a promise worth keeping.
 */
import { prisma } from '@syncstudy/db';
import type { Logger } from '../logger.js';
import type { ScriptedRedis } from '../redis.js';
import { NotesStore, serialise } from './store.js';

/** Long enough to coalesce a burst of typing, short enough to be invisible. */
const FLUSH_MS = 2_000;

interface PendingDoc {
  roomId: string;
  userId: string;
}

export class NotesService {
  readonly store: NotesStore;
  private readonly log: Logger;
  private pending = new Map<string, PendingDoc>();
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;

  constructor(deps: { redis: ScriptedRedis; log: Logger }) {
    this.store = new NotesStore(deps.redis, deps.log);
    this.log = deps.log;
  }

  get pendingWrites(): number {
    return this.pending.size;
  }

  /**
   * Note that the room is dirty. Never awaited by a handler: a keystroke path
   * that waits for Postgres is the thing this whole design exists to avoid.
   */
  persistSoon(roomId: string, userId: string): void {
    if (this.stopped) return;
    this.pending.set(roomId, { roomId, userId });
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, FLUSH_MS);
    this.timer.unref();
  }

  private flush(): Promise<void> {
    const existing = this.inFlight;
    if (existing !== null) return existing;
    if (this.pending.size === 0) return Promise.resolve();

    const batch = [...this.pending.values()];
    this.pending.clear();

    const run = (async () => {
      for (const item of batch) {
        try {
          // Read the document at flush time, not at queue time: the version
          // that lands should be the newest one, and re-reading is one Redis
          // call against a document the room is still typing into.
          const doc = await this.store.get(item.roomId);
          const content = serialise(doc.blocks);
          await prisma.roomNotes.upsert({
            where: { roomId: item.roomId },
            create: {
              roomId: item.roomId,
              content,
              version: BigInt(doc.version),
              updatedBy: item.userId,
            },
            update: { content, version: BigInt(doc.version), updatedBy: item.userId },
          });
        } catch (err) {
          // Requeue: the live copy is still correct, so the only cost of a
          // failed write is that the durable copy lags one more window.
          this.pending.set(item.roomId, item);
          this.log.error({ roomId: item.roomId, err }, 'notes persist failed; will retry');
        }
      }
    })().finally(() => {
      this.inFlight = null;
      if (this.pending.size > 0 && !this.stopped && this.timer === null) {
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.flush();
        }, FLUSH_MS);
        this.timer.unref();
      }
    });

    this.inFlight = run;
    return run;
  }

  /** Land everything now. Used by the join path and by shutdown. */
  async settle(): Promise<void> {
    await this.flush();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush().catch(() => undefined);
  }
}
