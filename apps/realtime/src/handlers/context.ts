/**
 * The shared spine every socket handler stands on.
 *
 * Three rules are enforced here rather than repeated (and eventually forgotten)
 * in each handler:
 *
 *   - identity comes from `socket.data`, never from a payload;
 *   - the payload is validated with the Zod schema from @syncstudy/shared before
 *     anything touches it;
 *   - permission is asserted against the role Redis holds right now, not the
 *     role that was true when the socket connected — a demoted co-host must lose
 *     their powers on the other node immediately.
 */
import type { Server, Socket } from 'socket.io';
import type { ZodType, ZodTypeDef } from 'zod';
import {
  can,
  type ClientToServerEvents,
  type Participant,
  type Permission,
  type ResolvedPermissions,
  type Role,
  type RoomPolicy,
  type ServerToClientEvents,
  type SocketData,
} from '@syncstudy/shared';
import { canControlVideo } from '@syncstudy/shared';
import type { Logger } from '../logger.js';
import type { Config } from '../config.js';
import type { ScriptedRedis } from '../redis.js';
import type { PresenceEntry, RedisRoomStore } from '../rooms/RoomStore.js';
import type { RoomMeta, RoomMetaCache } from '../rooms/roomData.js';
import type { LeaderElection } from '../rooms/leader.js';
import type { RoomTicker } from '../rooms/snapshotter.js';
import type { RoomBus } from '../rooms/bus.js';
import { LIMITS, type RateRule, type TokenBucket } from '../ratelimit/tokenBucket.js';
import type { ChatService } from '../chat/service.js';
import type { NotesService } from '../notes/service.js';
import { handlerErrorsTotal, observeEventLatency } from '../metrics.js';

/** Socket.IO's third generic is for inter-server events, which we do not use. */
type ServerSideEvents = Record<string, (...args: never[]) => void>;

export type TypedServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  ServerSideEvents,
  SocketData
>;
export type TypedSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  ServerSideEvents,
  SocketData
>;

export interface GraceScheduler {
  /**
   * Arm the disconnect grace timer for a socket that dropped.
   * Hosts get the longer HOST_DISCONNECT_GRACE_MS window (see constants).
   */
  arm(roomId: string, userId: string, isHost: boolean): void;
  /** A socket for this user came back before the grace expired. */
  cancel(roomId: string, userId: string): void;
  clearAll(): void;
}

export interface AppContext {
  io: TypedServer;
  redis: ScriptedRedis;
  store: RedisRoomStore;
  meta: RoomMetaCache;
  leader: LeaderElection;
  ticker: RoomTicker;
  limiter: TokenBucket;
  bus: RoomBus;
  /** Owns the transcript: user sends, system lines, and the write-behind queue. */
  chat: ChatService;
  /** Owns the shared document: the live block store and its debounced persistence. */
  notes: NotesService;
  log: Logger;
  config: Config;
  /** Set during wiring; presence.ts owns the timers, room.ts and host.ts use them. */
  grace: GraceScheduler;
}

/** Socket.IO room name for a study room. */
export function roomChannel(roomId: string): string {
  return `room:${roomId}`;
}

/**
 * Study rooms with at least one socket on THIS node.
 *
 * Not `adapter.rooms.size`: Socket.IO auto-joins every socket to a private room
 * named after its own id, so that figure is (study rooms + open sockets) and
 * reads roughly double the socket count under load.
 */
export function countActiveRooms(io: TypedServer): number {
  let n = 0;
  for (const name of io.sockets.adapter.rooms.keys()) {
    if (name.startsWith('room:')) n += 1;
  }
  return n;
}

// ── view models ─────────────────────────────────────────────────────────────

export function toParticipant(entry: PresenceEntry): Participant {
  return {
    id: entry.userId,
    handle: entry.handle,
    displayName: entry.displayName,
    avatarUrl: entry.avatarUrl,
    role: entry.role,
    connState: entry.connState,
    joinedAt: entry.joinedAt,
    inCall: entry.inCall,
    muted: entry.muted,
    camOn: entry.camOn,
    sharing: entry.sharing,
    speaking: entry.speaking,
    forceMuted: entry.forceMuted,
    buffering: entry.buffering,
  };
}

/** Computed once server-side so the client never has to re-derive affordances. */
export function resolvePermissions(role: Role, policy: RoomPolicy): ResolvedPermissions {
  return {
    role,
    canControlVideo: canControlVideo(role, policy.playbackControl),
    canSetVideo: can(role, 'video.set'),
    canSendChat: can(role, 'chat.send') && (!policy.chatLocked || can(role, 'chat.delete.any')),
    canDeleteAnyMessage: can(role, 'chat.delete.any'),
    canEditNotes: can(role, 'notes.edit'),
    canEditChecklist: can(role, 'checklist.edit'),
    canJoinCall: can(role, 'call.join') && policy.callEnabled,
    canScreenShare: can(role, 'screenshare') && policy.screenshareEnabled,
    canModerate: can(role, 'host.kick'),
    canManageRoom: can(role, 'host.policy'),
  };
}

// ── the guard ───────────────────────────────────────────────────────────────

export interface RoomSession {
  roomId: string;
  roomCode: string;
  meta: RoomMeta;
  participant: PresenceEntry;
  role: Role;
}

export interface GuardFailure {
  code: string;
  message: string;
  retryAfterMs?: number;
}

export type GuardOutcome<P> =
  | { ok: true; payload: P; session: RoomSession }
  | { ok: false; failure: GuardFailure };

export interface GuardOptions<P> {
  /**
   * The third type argument is the schema's INPUT type. Leaving it `unknown`
   * lets a schema that transforms on the way in (a trimmed string, a lowercased
   * handle) be passed here without widening `P`.
   */
  schema: ZodType<P, ZodTypeDef, unknown>;
  /** Defaults to LIMITS[event]; pass SPEAKING_LIMIT for the speaking patch. */
  rule?: RateRule;
  /** Counter key for a variant rule, so two rules never share one window. */
  rateKey?: string;
  /** Asserted against the live role before the handler body runs. */
  permission?: Permission;
}

/**
 * Rate limit → validate → resolve room → assert permission.
 *
 * The order is deliberate: rate limiting comes first so a flood cannot make us
 * do Zod work or Redis reads, and permission comes last so an unauthorised user
 * cannot use error-shape differences to probe room state.
 */
export async function guardRoomEvent<P>(
  ctx: AppContext,
  socket: TypedSocket,
  event: keyof ClientToServerEvents,
  payload: unknown,
  opts: GuardOptions<P>,
): Promise<GuardOutcome<P>> {
  const rule = opts.rule ?? LIMITS[event];
  const verdict = await ctx.limiter.consume(socket.id, event, rule, opts.rateKey ?? event);
  if (!verdict.allowed) {
    socket.emit('sys:rate_limited', { event, retryAfterMs: verdict.retryAfterMs });
    if (verdict.disconnect) {
      await ctx.limiter.applyCooldown(socket.data.userId);
      ctx.log.warn({ socketId: socket.id, userId: socket.data.userId, event }, 'disconnecting: rate limit strikes');
      socket.disconnect(true);
    }
    return {
      ok: false,
      failure: { code: 'rate_limited', message: 'Too fast — try again in a moment.', retryAfterMs: verdict.retryAfterMs },
    };
  }

  const parsed = opts.schema.safeParse(payload);
  if (!parsed.success) {
    ctx.log.info({ socketId: socket.id, userId: socket.data.userId, event }, 'payload rejected');
    return { ok: false, failure: { code: 'bad_payload', message: 'That request was malformed.' } };
  }

  const roomId = socket.data.roomId;
  const roomCode = socket.data.roomCode;
  if (roomId === undefined || roomCode === undefined) {
    return { ok: false, failure: { code: 'not_in_room', message: 'Join a room first.' } };
  }

  const meta = await ctx.meta.byId(roomId);
  if (!meta) return { ok: false, failure: { code: 'room_not_found', message: 'That room no longer exists.' } };
  if (meta.status !== 'active') {
    return { ok: false, failure: { code: 'room_ended', message: 'This room has ended.' } };
  }

  // The live presence entry is the authority on role: a host:set_role that
  // landed on another node one millisecond ago must already count.
  const participant = await ctx.store.getParticipant(roomId, socket.data.userId);
  if (!participant) {
    return { ok: false, failure: { code: 'not_in_room', message: 'Join a room first.' } };
  }

  const role = participant.role;
  socket.data.role = role;

  if (opts.permission && !can(role, opts.permission)) {
    ctx.log.info(
      { socketId: socket.id, userId: socket.data.userId, roomId, event },
      'permission denied',
    );
    return { ok: false, failure: { code: 'not_permitted', message: 'You do not have permission to do that.' } };
  }

  return { ok: true, payload: parsed.data, session: { roomId, roomCode, meta, participant, role } };
}

/**
 * Every handler body runs inside this. A throw in one handler must never take
 * the process down and must never leave a client waiting on an ack that will
 * not arrive, so the failure path is logged, counted, and acked.
 */
export function runHandler(
  ctx: AppContext,
  socket: TypedSocket,
  event: keyof ClientToServerEvents,
  body: () => Promise<void>,
  onError?: (failure: GuardFailure) => void,
): void {
  const startedAt = Date.now();
  body()
    .catch((err: unknown) => {
      handlerErrorsTotal.inc({ event });
      ctx.log.error(
        { socketId: socket.id, userId: socket.data.userId, roomId: socket.data.roomId, event, err },
        'handler failed',
      );
      try {
        onError?.({ code: 'server_error', message: 'Something went wrong. Try again.' });
      } catch (ackErr) {
        ctx.log.error({ socketId: socket.id, event, err: ackErr }, 'error ack failed');
      }
    })
    .finally(() => observeEventLatency(event, startedAt));
}
