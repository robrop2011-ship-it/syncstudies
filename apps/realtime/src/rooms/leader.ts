/**
 * Per-room leader lease (PLAN.md §6.3).
 *
 * With two or more realtime nodes, room R can have participants on both. Only
 * one node may run R's heartbeat and snapshotter, or you get duplicate
 * broadcasts and write races against `room_video_state`.
 *
 * A Redis `SET NX PX` lease with renewal is sufficient here and Raft is not:
 * the worst case of a split lease is one duplicated 10 s heartbeat, which
 * clients treat as idempotent because a heartbeat carries an anchor rather than
 * a command.
 */
import { LEADER_LOCK_TTL_MS, LEADER_RENEW_MS } from '@syncstudy/shared';
import { keys, type ScriptedRedis } from '../redis.js';
import type { Logger } from '../logger.js';

/**
 * Extend only if we still hold the lease. A plain `PEXPIRE` would let a node
 * that lost the lease during a GC pause keep renewing someone else's lock.
 */
const RENEW_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

/** Same reasoning for release: never delete a lease another node now owns. */
const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export interface LeaderCallbacks {
  onAcquire(roomId: string): void;
  onRelease(roomId: string): void;
}

export class LeaderElection {
  /** Rooms this node has participants in — candidates for leadership. */
  private readonly tracked = new Set<string>();
  /** Rooms this node currently leads. */
  private readonly held = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(
    private readonly redis: ScriptedRedis,
    private readonly nodeId: string,
    private readonly log: Logger,
    private readonly callbacks: LeaderCallbacks,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, LEADER_RENEW_MS);
    // Don't hold the event loop open on shutdown.
    this.timer.unref();
  }

  isLeader(roomId: string): boolean {
    return this.held.has(roomId);
  }

  ledRooms(): string[] {
    return [...this.held];
  }

  trackedRooms(): string[] {
    return [...this.tracked];
  }

  /** This node now has at least one socket in the room; try to lead it. */
  async track(roomId: string): Promise<void> {
    if (this.stopping) return;
    this.tracked.add(roomId);
    if (!this.held.has(roomId)) await this.tryAcquire(roomId);
  }

  /** This node's last socket left the room. */
  async untrack(roomId: string): Promise<void> {
    this.tracked.delete(roomId);
    await this.release(roomId);
  }

  private async tryAcquire(roomId: string): Promise<boolean> {
    try {
      const got = await this.redis.set(
        keys.roomLeader(roomId),
        this.nodeId,
        'PX',
        LEADER_LOCK_TTL_MS,
        'NX',
      );
      if (got === null) return false;
      this.held.add(roomId);
      this.log.info({ roomId }, 'acquired room leader lease');
      this.callbacks.onAcquire(roomId);
      return true;
    } catch (err) {
      this.log.error({ roomId, err }, 'leader acquire failed');
      return false;
    }
  }

  private async tick(): Promise<void> {
    if (this.stopping) return;

    for (const roomId of this.held) {
      try {
        const renewed: unknown = await this.redis.eval(
          RENEW_LUA,
          1,
          keys.roomLeader(roomId),
          this.nodeId,
          String(LEADER_LOCK_TTL_MS),
        );
        if (typeof renewed !== 'number' || renewed !== 1) {
          // We lost it — most likely this process stalled past the TTL. Step
          // down cleanly rather than continuing to snapshot as a zombie leader.
          this.held.delete(roomId);
          this.log.warn({ roomId }, 'lost room leader lease');
          this.callbacks.onRelease(roomId);
        }
      } catch (err) {
        this.log.error({ roomId, err }, 'leader renew failed');
      }
    }

    // Rooms we are in but do not lead: the previous leader may have died.
    for (const roomId of this.tracked) {
      if (!this.held.has(roomId)) await this.tryAcquire(roomId);
    }
  }

  async release(roomId: string): Promise<void> {
    if (!this.held.delete(roomId)) return;
    this.callbacks.onRelease(roomId);
    try {
      await this.redis.eval(RELEASE_LUA, 1, keys.roomLeader(roomId), this.nodeId);
      this.log.info({ roomId }, 'released room leader lease');
    } catch (err) {
      // Not fatal: the lease expires on its own within LEADER_LOCK_TTL_MS.
      this.log.error({ roomId, err }, 'leader release failed');
    }
  }

  /** SIGTERM path (§16.3): hand every room over immediately, don't wait for TTLs. */
  async releaseAll(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await Promise.all([...this.held].map((roomId) => this.release(roomId)));
    this.tracked.clear();
  }
}
