/**
 * Presence, the disconnect grace period, and the leave pipeline
 * (PLAN.md §6.3, §8.8, §2.4).
 *
 * The behaviour that matters most here is the one users never see: a 20-second
 * Wi-Fi drop must not remove someone from the room. They go to `reconnecting`,
 * their avatar dims, and if they come back within DISCONNECT_GRACE_MS nothing
 * else happens at all.
 */
import {
  DISCONNECT_GRACE_MS,
  HOST_DISCONNECT_GRACE_MS,
  Schemas,
  can,
  type Participant,
  type Role,
} from '@syncstudy/shared';
import { SPEAKING_LIMIT } from '../ratelimit/tokenBucket.js';
import { recordLeave, transferHost, logRoomEvent } from '../rooms/roomData.js';
import type { PresenceEntry } from '../rooms/RoomStore.js';
import {
  guardRoomEvent,
  roomChannel,
  runHandler,
  type AppContext,
  type GraceScheduler,
  type TypedSocket,
} from './context.js';
import { participantsPerRoom } from '../metrics.js';

export type LeaveReason = 'left' | 'timeout' | 'kicked';

/** Sockets this node holds in a room. The Redis adapter keeps `rooms` node-local. */
export function localRoomSize(ctx: AppContext, roomId: string): number {
  return ctx.io.sockets.adapter.rooms.get(roomChannel(roomId))?.size ?? 0;
}

export function broadcastPresencePatch(
  ctx: AppContext,
  roomId: string,
  userId: string,
  patch: Partial<Participant>,
): void {
  ctx.io.to(roomChannel(roomId)).emit('presence:update', { userId, patch });
}

// ── the leave pipeline ──────────────────────────────────────────────────────

/**
 * Remove a participant for real and run everything that follows from it.
 *
 * `deleteParticipant` returns whether WE removed them, which is the tie-break
 * between the owning node's grace timer and the leader's sweep — both can fire
 * for the same user, and exactly one `presence:leave` must go out.
 */
export async function removeParticipantAndBroadcast(
  ctx: AppContext,
  roomId: string,
  userId: string,
  reason: LeaveReason,
): Promise<void> {
  const entry = await ctx.store.getParticipant(roomId, userId);
  const removed = await ctx.store.deleteParticipant(roomId, userId);
  if (!removed) return;

  ctx.grace.cancel(roomId, userId);
  await ctx.store.markBuffering(roomId, userId, false);
  ctx.io.to(roomChannel(roomId)).emit('presence:leave', { userId, reason });
  void recordLeave(roomId, userId);

  const remaining = await ctx.store.listParticipants(roomId);
  participantsPerRoom.observe(remaining.length);

  const meta = await ctx.meta.byId(roomId);
  const wasHost = entry?.role === 'host' || meta?.room.hostId === userId;

  // Whenever the host actually leaves the participant list — deliberately, by
  // kick, or by grace timeout — the room hands over immediately. Deferring this
  // to a later timer would leave `hostId` pointing at someone no longer present,
  // and nobody could moderate the room in the meantime (PLAN.md §2.3).
  if (wasHost && remaining.length > 0) {
    await promoteNewHost(ctx, roomId, userId, reason === 'timeout' ? 'timeout' : 'left');
  }

  if (remaining.length === 0) {
    // §8.11: freeze before anyone can rejoin, so the room cannot "advance"
    // while it is empty.
    await ctx.ticker.freezeAndPersist(roomId);
  }

  if (localRoomSize(ctx, roomId) === 0) {
    await ctx.leader.untrack(roomId);
  }
}

/**
 * Promote the longest-connected non-guest (§2.4 "just leave" path).
 *
 * Preference order: connected co-hosts, then connected members, then anyone
 * still inside their reconnect grace — a room with a reconnecting host is
 * better than a room with no host at all.
 */
export async function promoteNewHost(
  ctx: AppContext,
  roomId: string,
  previousHostId: string,
  reason: 'transfer' | 'left' | 'timeout',
  preferredUserId?: string,
): Promise<string | null> {
  const participants = await ctx.store.listParticipants(roomId);
  const eligible = participants.filter((p) => p.userId !== previousHostId && p.role !== 'guest');
  if (eligible.length === 0) return null;

  // An explicit `host:transfer` names its successor; automatic promotion falls
  // back to the ranking below.
  const named = preferredUserId === undefined
    ? undefined
    : eligible.find((p) => p.userId === preferredUserId);

  const rank = (p: PresenceEntry): number => {
    const connected = p.connState === 'connected' ? 0 : 1;
    const seniority = p.role === 'co_host' ? 0 : 1;
    return connected * 10 + seniority;
  };
  eligible.sort((a, b) => rank(a) - rank(b) || a.joinedAt - b.joinedAt);

  const next = named ?? eligible[0];
  if (!next) return null;

  await transferHost(roomId, next.userId, previousHostId);
  await ctx.meta.refresh(roomId);
  await ctx.store.updateParticipant(roomId, next.userId, { role: 'host' });
  await ctx.store.updateParticipant(roomId, previousHostId, { role: 'co_host' });
  await ctx.bus.publishRoomMessage({ type: 'role_changed', roomId, userId: next.userId, role: 'host' });

  ctx.io.to(roomChannel(roomId)).emit('room:host_changed', { hostId: next.userId, reason });
  broadcastPresencePatch(ctx, roomId, next.userId, { role: 'host' });
  void logRoomEvent(roomId, previousHostId, 'host_changed', { to: next.userId, reason }, ctx.log);

  ctx.log.info({ roomId, userId: next.userId, reason }, 'host transferred');
  return next.userId;
}

// ── grace timers ────────────────────────────────────────────────────────────

/**
 * Timers live on the node that held the socket. If that node dies, the leader's
 * heartbeat sweep (snapshotter.ts) removes the stranded participant instead —
 * that is the backstop, not the primary path.
 */
export class GraceTimers implements GraceScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout[]>();
  private ctx: AppContext | null = null;

  attach(ctx: AppContext): void {
    this.ctx = ctx;
  }

  private key(roomId: string, userId: string): string {
    return `${roomId}:${userId}`;
  }

  arm(roomId: string, userId: string, isHost: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.cancel(roomId, userId);

    // ONE timer, not two. An earlier version armed a 45s removal timer alongside
    // a 60s host-transfer timer; the removal always fired first and cancelled the
    // transfer, so a host who dropped left the room permanently hostless.
    // Hosts simply get a longer window, and transfer happens at removal.
    const delay = isHost ? HOST_DISCONNECT_GRACE_MS : DISCONNECT_GRACE_MS;

    const grace = setTimeout(() => {
      void this.onGraceExpired(ctx, roomId, userId);
    }, delay);

    grace.unref();
    this.timers.set(this.key(roomId, userId), [grace]);
  }

  cancel(roomId: string, userId: string): void {
    const key = this.key(roomId, userId);
    for (const timer of this.timers.get(key) ?? []) clearTimeout(timer);
    this.timers.delete(key);
  }

  clearAll(): void {
    for (const timers of this.timers.values()) {
      for (const timer of timers) clearTimeout(timer);
    }
    this.timers.clear();
  }

  private async onGraceExpired(ctx: AppContext, roomId: string, userId: string): Promise<void> {
    try {
      const entry = await ctx.store.getParticipant(roomId, userId);
      // They came back (possibly on another node) — nothing to do.
      if (!entry || entry.connState === 'connected') return;
      ctx.log.info({ roomId, userId }, 'disconnect grace expired');
      await removeParticipantAndBroadcast(ctx, roomId, userId, 'timeout');
    } catch (err) {
      ctx.log.error({ roomId, userId, err }, 'grace expiry failed');
    }
  }

}

// ── handlers ────────────────────────────────────────────────────────────────

/** A patch carrying only `speaking` runs at voice-activity rate (§10.2). */
function isSpeakingOnly(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const fieldNames = Object.keys(payload);
  return fieldNames.length === 1 && fieldNames[0] === 'speaking';
}

function sanitisePatch(
  patch: Schemas.PresencePatch,
  entry: PresenceEntry,
  role: Role,
  policy: { callEnabled: boolean; screenshareEnabled: boolean },
): Partial<PresenceEntry> {
  const next: Partial<PresenceEntry> = {};

  if (patch.speaking !== undefined) next.speaking = patch.speaking;
  if (patch.camOn !== undefined) next.camOn = patch.camOn;

  // A force-muted participant may not unmute themselves. The client is told
  // through the participant patch rather than an error, so the UI simply shows
  // them as still muted (R7).
  if (patch.muted !== undefined) next.muted = entry.forceMuted ? true : patch.muted;

  if (patch.inCall !== undefined) {
    next.inCall = patch.inCall && policy.callEnabled && can(role, 'call.join');
  }
  if (patch.sharing !== undefined) {
    next.sharing = patch.sharing && policy.screenshareEnabled && can(role, 'screenshare');
  }
  return next;
}

export function registerPresenceHandlers(ctx: AppContext, socket: TypedSocket): void {
  socket.on('presence:update', (payload) => {
    runHandler(ctx, socket, 'presence:update', async () => {
      const guard = await guardRoomEvent(ctx, socket, 'presence:update', payload, {
        schema: Schemas.PresencePatch,
        ...(isSpeakingOnly(payload)
          ? { rule: SPEAKING_LIMIT, rateKey: 'presence:update:speaking' }
          : {}),
      });
      if (!guard.ok) return;

      const { session } = guard;
      const patch = sanitisePatch(guard.payload, session.participant, session.role, session.meta.policy);
      if (Object.keys(patch).length === 0) return;

      const updated = await ctx.store.updateParticipant(session.roomId, socket.data.userId, patch);
      if (!updated) return;

      // Others only: the sender already applied this optimistically, and
      // `speaking` fires several times a second.
      socket
        .to(roomChannel(session.roomId))
        .emit('presence:update', { userId: socket.data.userId, patch: toParticipantPatch(patch) });
    });
  });
}

/** Narrow a PresenceEntry patch to the fields the client's Participant carries. */
export function toParticipantPatch(patch: Partial<PresenceEntry>): Partial<Participant> {
  const out: Partial<Participant> = {};
  if (patch.role !== undefined) out.role = patch.role;
  if (patch.connState !== undefined) out.connState = patch.connState;
  if (patch.inCall !== undefined) out.inCall = patch.inCall;
  if (patch.muted !== undefined) out.muted = patch.muted;
  if (patch.camOn !== undefined) out.camOn = patch.camOn;
  if (patch.sharing !== undefined) out.sharing = patch.sharing;
  if (patch.speaking !== undefined) out.speaking = patch.speaking;
  if (patch.forceMuted !== undefined) out.forceMuted = patch.forceMuted;
  if (patch.buffering !== undefined) out.buffering = patch.buffering;
  return out;
}
