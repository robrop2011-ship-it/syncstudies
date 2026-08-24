/**
 * The simulated realtime server (PLAN.md §8.2, §8.4, §8.5, §8.10).
 *
 * ── THE ONE RULE THIS FILE OBEYS ────────────────────────────────────────────
 * It reimplements NO decision logic. `decideControl` decides, `applyControl`
 * computes the next anchor and `positionAt` derives a position — all imported
 * from `@syncstudy/shared`, which is the same module `apps/realtime` imports.
 * A simulator carrying its own copy of the rules would go green while
 * production was broken, and that is the single failure the whole §15.3 asset
 * exists to prevent. What IS modelled here is the surrounding *plumbing* that
 * `apps/realtime/src/handlers/video.ts` wraps around those functions, in the
 * same order:
 *
 *     policy gate → no-video gate → decideControl → applyControl
 *                 → broadcast video:state → ack the sender
 *
 * The broadcast goes out BEFORE the ack, exactly as the handler does it, which
 * is why the initiator normally learns the outcome from the ack while everyone
 * else learns it from the broadcast one one-way delay earlier or later.
 *
 * What is deliberately left out: Redis, the Lua transact, the leader lease and
 * the write-behind snapshotter. The Lua script is described in §6.4 as a
 * faithful transliteration of `decideControl`, and a single-process simulator
 * has nothing for a CAS to protect against — modelling it would be modelling
 * our own mock.
 */
import {
  CONTROL_LOCK_MS,
  IDLE_ANCHOR,
  ROOM_HEARTBEAT_MS,
  WAIT_FOR_SLOW_MAX_MS,
  applyControl,
  applySetVideo,
  decideControl,
  type ControlAck,
  type ControlCommand,
  type ControlRejectReason,
  type VideoAnchor,
  type VideoStateReason,
} from '@syncstudy/shared';
import type { Schemas } from '@syncstudy/shared';
import type { VirtualScheduler } from './scheduler';

export interface VideoStatePayload {
  anchor: VideoAnchor;
  actorId: string | null;
  reason: VideoStateReason;
  serverMs: number;
}

export interface ControlRecord {
  actorId: string;
  /** True server epoch ms at which the control ARRIVED. Conflicts are decided here. */
  atServerMs: number;
  action: ControlCommand['action'];
  accepted: boolean;
  reason: ControlRejectReason | null;
}

export interface SimServerOptions {
  scheduler: VirtualScheduler;
  videoRef: string;
  videoDurationSec: number;
  /** §8.10 room policy. Off by default, as the real room is. */
  waitForSlow: boolean;
}

export class SimServer {
  private readonly scheduler: VirtualScheduler;
  private readonly waitForSlow: boolean;
  private readonly subscribers = new Map<string, (payload: VideoStatePayload) => void>();
  /** Users currently reporting `video:buffering` (§8.10). */
  private readonly buffering = new Set<string>();
  private anchor: VideoAnchor;
  private heartbeatId: number | null = null;
  private waitTimerId: number | null = null;

  readonly controls: ControlRecord[] = [];

  constructor(opts: SimServerOptions) {
    this.scheduler = opts.scheduler;
    this.waitForSlow = opts.waitForSlow;
    // A room whose host has already pasted a link: paused at zero with a video
    // set, which is what every client's first snapshot shows.
    this.anchor = applySetVideo(
      IDLE_ANCHOR,
      {
        provider: 'youtube',
        videoRef: opts.videoRef,
        title: 'Simulated lecture',
        durationSec: opts.videoDurationSec,
      },
      this.now(),
    );
  }

  /** True server epoch ms. Never skewed — the server IS the reference. */
  now(): number {
    return this.scheduler.serverNow();
  }

  getAnchor(): VideoAnchor {
    return this.anchor;
  }

  /** The §8.11 heartbeat: the same anchor, every 10 s, as a drift safety net. */
  startHeartbeat(): void {
    if (this.heartbeatId !== null) return;
    const beat = (): void => {
      this.heartbeatId = this.scheduler.scheduleAt(
        this.scheduler.now() + ROOM_HEARTBEAT_MS,
        null,
        beat,
      );
      this.broadcast(this.anchor, null, 'heartbeat');
    };
    this.heartbeatId = this.scheduler.scheduleAt(
      this.scheduler.now() + ROOM_HEARTBEAT_MS,
      null,
      beat,
    );
  }

  stop(): void {
    if (this.heartbeatId !== null) {
      this.scheduler.cancel(this.heartbeatId);
      this.heartbeatId = null;
    }
    if (this.waitTimerId !== null) {
      this.scheduler.cancel(this.waitTimerId);
      this.waitTimerId = null;
    }
  }

  subscribe(clientId: string, onState: (payload: VideoStatePayload) => void): void {
    this.subscribers.set(clientId, onState);
  }

  /** `room:join` / `room:resync` both answer with the full anchor (§8.7, §8.8). */
  snapshot(): { video: VideoAnchor; serverMs: number } {
    return { video: this.anchor, serverMs: this.now() };
  }

  /** `time:ping`. The server replies with its own `Date.now()` and nothing else. */
  ping(t0: number): Schemas.TimePong {
    return { t0, serverMs: this.now() };
  }

  /**
   * `video:control`, in the order `handlers/video.ts` runs it.
   *
   * `canControl` is passed in rather than computed, because it is the resolved
   * answer to `canControlVideo(role, policy)` — a role/policy pair the harness
   * has no other use for.
   */
  handleControl(actorId: string, cmd: Schemas.VideoControl, canControl: boolean): ControlAck {
    const nowMs = this.now();

    const record = (accepted: boolean, reason: ControlRejectReason | null): void => {
      this.controls.push({ actorId, atServerMs: nowMs, action: cmd.action, accepted, reason });
    };

    // §8.5a: the policy gate is checked before anything touches the timeline.
    if (!canControl) {
      record(false, 'not_permitted');
      return { ok: false, reason: 'not_permitted', anchor: this.anchor };
    }
    if (this.anchor.provider === 'none' || this.anchor.videoRef === null) {
      record(false, 'no_video');
      return { ok: false, reason: 'no_video', anchor: this.anchor };
    }

    const command: ControlCommand = {
      action: cmd.action,
      clientSentAtMs: cmd.clientSentAtMs,
      expectedRevision: cmd.expectedRevision,
      ...(cmd.positionSec === undefined ? {} : { positionSec: cmd.positionSec }),
      ...(cmd.rate === undefined ? {} : { rate: cmd.rate }),
    };

    const decision = decideControl(this.anchor, command, actorId, nowMs, CONTROL_LOCK_MS);
    if (!decision.accepted) {
      const reason = decision.reason ?? 'recently_changed';
      record(false, reason);
      return { ok: false, reason, anchor: this.anchor };
    }

    const next = applyControl(this.anchor, command, nowMs);
    next.lastActorId = actorId;
    this.anchor = next;
    record(true, null);

    this.broadcast(next, actorId, 'control');
    return { ok: true, anchor: next };
  }

  /** `video:buffering` (§8.10). Only the leader acts on it; here there is one node. */
  handleBuffering(userId: string, buffering: boolean): void {
    if (buffering) this.buffering.add(userId);
    else this.buffering.delete(userId);
    this.evaluateWaitForSlow();
  }

  /** A participant vanished: their stall must not hold the room after they leave. */
  forgetClient(userId: string): void {
    if (!this.buffering.delete(userId)) return;
    this.evaluateWaitForSlow();
  }

  private broadcast(anchor: VideoAnchor, actorId: string | null, reason: VideoStateReason): void {
    const payload: VideoStatePayload = { anchor, actorId, reason, serverMs: this.now() };
    for (const send of this.subscribers.values()) send(payload);
  }

  /**
   * §8.10, and its non-negotiable cap.
   *
   * Default OFF. The simulator implements the ON path anyway so that "a slow
   * client does not drag the room" is a claim with a demonstrable opposite:
   * a test that only ever runs with the feature off cannot tell the difference
   * between "the policy is respected" and "the buffering report was dropped on
   * the floor".
   */
  private evaluateWaitForSlow(): void {
    if (!this.waitForSlow) return;

    if (this.buffering.size > 0) {
      if (this.waitTimerId !== null) return; // already waiting; don't re-arm the cap
      if (this.anchor.status !== 'playing') return;
      this.systemControl('pause');
      this.waitTimerId = this.scheduler.scheduleAt(
        this.scheduler.now() + WAIT_FOR_SLOW_MAX_MS,
        null,
        () => {
          this.waitTimerId = null;
          this.systemControl('play');
        },
      );
      return;
    }

    if (this.waitTimerId === null) return;
    this.scheduler.cancel(this.waitTimerId);
    this.waitTimerId = null;
    this.systemControl('play');
  }

  /**
   * A system-initiated control: no actor, so it neither inherits the previous
   * actor's control lock nor arms one against the next human.
   */
  private systemControl(action: 'play' | 'pause'): void {
    const nowMs = this.now();
    const next = applyControl(
      this.anchor,
      { action, clientSentAtMs: nowMs, expectedRevision: this.anchor.revision },
      nowMs,
    );
    next.lastActorId = null;
    this.anchor = next;
    this.broadcast(next, null, 'auto_buffer');
  }
}
