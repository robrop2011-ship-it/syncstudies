/**
 * Leader-only periodic room work (PLAN.md §6.3, §8.11).
 *
 * Two timers per led room:
 *
 *  - heartbeat (10 s) — re-broadcast the anchor. This is a liveness signal and a
 *    drift safety net, NOT a position update: the payload is the same anchor
 *    every time, so a client that missed a control event converges without the
 *    server ever having to know it missed one (§8.1 rule 2).
 *  - snapshot (15 s) — write-behind the Redis anchor to `room_video_state` and
 *    bump `rooms.last_active_at`.
 *
 * Both run on exactly one node, held by the leader lease, or you get duplicate
 * broadcasts and racing UPSERTs.
 */
import {
  DISCONNECT_GRACE_MS,
  ROOM_HEARTBEAT_MS,
  ROOM_SNAPSHOT_MS,
  freezeAnchor,
  type VideoAnchor,
} from '@syncstudy/shared';
import type { Logger } from '../logger.js';
import type { RedisRoomStore } from './RoomStore.js';
import type { LeaderElection } from './leader.js';
import { snapshotVideoState } from './roomData.js';

export interface RoomTickerDeps {
  store: RedisRoomStore;
  leader: LeaderElection;
  log: Logger;
  /** Fan out the anchor to the room. Implemented over the Socket.IO adapter. */
  broadcastHeartbeat(roomId: string, anchor: VideoAnchor, serverMs: number): void;
  /**
   * A participant's disconnect grace has expired and no node revived them.
   * The owning node normally handles this with its own timer; this is the
   * backstop for when that node died mid-outage.
   */
  onGraceExpired(roomId: string, userId: string): Promise<void>;
}

interface RoomTimers {
  heartbeat: NodeJS.Timeout;
  snapshot: NodeJS.Timeout;
}

export class RoomTicker {
  private readonly timers = new Map<string, RoomTimers>();

  constructor(private readonly deps: RoomTickerDeps) {}

  /** Wire straight into LeaderElection's onAcquire. */
  start(roomId: string): void {
    if (this.timers.has(roomId)) return;

    const heartbeat = setInterval(() => {
      void this.heartbeat(roomId);
    }, ROOM_HEARTBEAT_MS);
    const snapshot = setInterval(() => {
      void this.snapshot(roomId);
    }, ROOM_SNAPSHOT_MS);
    heartbeat.unref();
    snapshot.unref();

    this.timers.set(roomId, { heartbeat, snapshot });
    this.deps.log.debug({ roomId }, 'room ticker started');
  }

  /** Wire straight into LeaderElection's onRelease. */
  stop(roomId: string): void {
    const t = this.timers.get(roomId);
    if (!t) return;
    clearInterval(t.heartbeat);
    clearInterval(t.snapshot);
    this.timers.delete(roomId);
    this.deps.log.debug({ roomId }, 'room ticker stopped');
  }

  stopAll(): void {
    for (const roomId of [...this.timers.keys()]) this.stop(roomId);
  }

  private async heartbeat(roomId: string): Promise<void> {
    if (!this.deps.leader.isLeader(roomId)) return;
    try {
      const state = await this.deps.store.getState(roomId);
      if (!state) return;

      this.deps.broadcastHeartbeat(roomId, state.anchor, Date.now());
      await this.deps.store.touch(roomId);
      await this.sweepStalePresence(roomId);
    } catch (err) {
      this.deps.log.error({ roomId, err }, 'room heartbeat failed');
    }
  }

  /**
   * Backstop for a node that died holding sockets: its participants would sit in
   * `reconnecting` forever, because the timer that would have removed them died
   * with the process.
   */
  private async sweepStalePresence(roomId: string): Promise<void> {
    const participants = await this.deps.store.listParticipants(roomId);
    const now = Date.now();
    for (const p of participants) {
      if (p.connState !== 'reconnecting' || p.disconnectedAt === null) continue;
      if (now - p.disconnectedAt < DISCONNECT_GRACE_MS) continue;
      await this.deps.onGraceExpired(roomId, p.userId);
    }
  }

  async snapshot(roomId: string): Promise<void> {
    if (!this.deps.leader.isLeader(roomId)) return;
    try {
      const state = await this.deps.store.getState(roomId);
      if (!state) return;
      await snapshotVideoState(roomId, state.anchor);
    } catch (err) {
      // Never throw out of a timer. A failed snapshot costs ≤15 s of position.
      this.deps.log.error({ roomId, err }, 'room snapshot failed');
    }
  }

  /** SIGTERM path (§16.3): flush every room this node leads. */
  async snapshotAllLedRooms(): Promise<void> {
    const rooms = this.deps.leader.ledRooms();
    await Promise.all(
      rooms.map(async (roomId) => {
        try {
          const state = await this.deps.store.getState(roomId);
          if (state) await snapshotVideoState(roomId, state.anchor);
        } catch (err) {
          this.deps.log.error({ roomId, err }, 'shutdown snapshot failed');
        }
      }),
    );
    this.deps.log.info({ rooms: rooms.length }, 'snapshotted leader rooms');
  }

  /**
   * Last participant left (§8.11).
   *
   * Freeze first — `freezeAnchor` forces `paused` and re-derives the position at
   * this instant. Without it, a room that was playing when everyone left keeps
   * "advancing" against wall-clock time and reopens three days later at the end
   * of the video. Then write immediately rather than waiting for the next tick,
   * because there will not be a next tick.
   */
  async freezeAndPersist(roomId: string): Promise<void> {
    try {
      const state = await this.deps.store.getState(roomId);
      if (!state) return;

      const now = Date.now();
      const frozen = freezeAnchor(state.anchor, now);

      if (frozen.status !== state.anchor.status || frozen.anchorPositionSec !== state.anchor.anchorPositionSec) {
        const outcome = await this.deps.store.applyAtomic({
          roomId,
          next: frozen,
          expectedRevision: state.anchor.revision,
          actorId: state.anchor.lastActorId,
          nowMs: now,
          lockMs: 0,
        });
        // A losing CAS means someone joined and acted in the same millisecond;
        // the room is alive again and its own snapshot tick will cover it.
        if (!outcome.ok) {
          this.deps.log.debug({ roomId, reason: outcome.reason }, 'freeze skipped: room changed');
          return;
        }
        frozen.revision = outcome.revision;
      }

      await snapshotVideoState(roomId, frozen);
      await this.deps.store.clearBuffering(roomId);
      this.deps.log.info({ roomId }, 'room frozen and snapshotted on last leave');
    } catch (err) {
      this.deps.log.error({ roomId, err }, 'freeze-and-persist failed');
    }
  }
}
