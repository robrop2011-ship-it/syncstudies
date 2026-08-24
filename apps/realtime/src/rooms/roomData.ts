/**
 * Postgres reads and write-behind writes for rooms (PLAN.md §6.5, §7.2).
 *
 * The realtime service treats Postgres as the durable truth for membership,
 * bans, policy and the video snapshot — and as something it must never block a
 * broadcast on. Everything here is either (a) on the join path, which is
 * allowed to be slow, or (b) fire-and-forget behind a broadcast that already
 * happened.
 */
import { prisma, Prisma } from '@syncstudy/db';
import {
  uuidv7,
  Schemas,
  type Role,
  type RoomPolicy,
  type RoomView,
  type VideoAnchor,
} from '@syncstudy/shared';
import { keys, type ScriptedRedis } from '../redis.js';
import type { Logger } from '../logger.js';

export type RoomStatus = 'active' | 'ended' | 'archived';

export interface RoomMeta {
  room: RoomView;
  policy: RoomPolicy;
  status: RoomStatus;
}

const PLAYBACK_CONTROLS: readonly Schemas.PlaybackControl[] = [
  'everyone',
  'host_and_cohosts',
  'host_only',
];

const ROLES: readonly Role[] = ['host', 'co_host', 'member', 'guest'];

function asPlaybackControl(v: string): Schemas.PlaybackControl {
  return PLAYBACK_CONTROLS.find((p) => p === v) ?? 'everyone';
}

export function asRole(v: string): Role {
  return ROLES.find((r) => r === v) ?? 'member';
}

function asStatus(v: string): RoomStatus {
  return v === 'ended' || v === 'archived' ? v : 'active';
}

interface RoomRow {
  id: string;
  code: string;
  name: string;
  topic: string | null;
  hostId: string;
  createdAt: Date;
  status: string;
  playbackControl: string;
  chatLocked: boolean;
  slowModeSec: number;
  waitForSlow: boolean;
  callEnabled: boolean;
  screenshareEnabled: boolean;
  maxParticipants: number;
}

const ROOM_SELECT = {
  id: true,
  code: true,
  name: true,
  topic: true,
  hostId: true,
  createdAt: true,
  status: true,
  playbackControl: true,
  chatLocked: true,
  slowModeSec: true,
  waitForSlow: true,
  callEnabled: true,
  screenshareEnabled: true,
  maxParticipants: true,
} as const;

function toMeta(row: RoomRow): RoomMeta {
  return {
    room: {
      id: row.id,
      code: row.code,
      name: row.name,
      topic: row.topic,
      hostId: row.hostId,
      createdAt: row.createdAt.getTime(),
    },
    policy: {
      playbackControl: asPlaybackControl(row.playbackControl),
      chatLocked: row.chatLocked,
      slowModeSec: row.slowModeSec,
      waitForSlow: row.waitForSlow,
      callEnabled: row.callEnabled,
      screenshareEnabled: row.screenshareEnabled,
      maxParticipants: row.maxParticipants,
    },
    status: asStatus(row.status),
  };
}

/**
 * Room metadata with a Redis cache.
 *
 * Every permission check needs the playback policy, and `video:control` runs up
 * to 8 times per 10 s per user — that must not be a Postgres round-trip. The
 * cache is written on join and invalidated on every policy change, so the window
 * where a demoted policy is still honoured is one Redis write wide.
 */
export class RoomMetaCache {
  constructor(
    private readonly redis: ScriptedRedis,
    private readonly log: Logger,
  ) {}

  async byId(roomId: string): Promise<RoomMeta | null> {
    const cached = await this.readCache(roomId);
    if (cached) return cached;

    const row = await prisma.room.findUnique({ where: { id: roomId }, select: ROOM_SELECT });
    if (!row) return null;
    const meta = toMeta(row);
    await this.writeCache(meta);
    return meta;
  }

  async byCode(code: string): Promise<RoomMeta | null> {
    const cachedId = await this.redis.get(keys.roomCode(code));
    if (cachedId) {
      const meta = await this.byId(cachedId);
      if (meta) return meta;
    }
    const row = await prisma.room.findUnique({ where: { code }, select: ROOM_SELECT });
    if (!row) return null;
    const meta = toMeta(row);
    await Promise.all([
      this.writeCache(meta),
      this.redis.set(keys.roomCode(code), row.id, 'PX', 3_600_000),
    ]);
    return meta;
  }

  /** Called after any policy/host/status change so no node serves stale policy. */
  async invalidate(roomId: string): Promise<void> {
    await this.redis.del(keys.roomMeta(roomId));
  }

  async refresh(roomId: string): Promise<RoomMeta | null> {
    await this.invalidate(roomId);
    return this.byId(roomId);
  }

  private async readCache(roomId: string): Promise<RoomMeta | null> {
    const raw = await this.redis.get(keys.roomMeta(roomId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as RoomMeta;
    } catch (err) {
      this.log.warn({ roomId, err }, 'room meta cache entry corrupt; refetching');
      return null;
    }
  }

  private async writeCache(meta: RoomMeta): Promise<void> {
    await this.redis.set(keys.roomMeta(meta.room.id), JSON.stringify(meta), 'PX', 3_600_000);
  }
}

// ── membership ──────────────────────────────────────────────────────────────

export interface Membership {
  /** A row exists in room_participants (they have joined this room before). */
  isParticipant: boolean;
  role: Role;
  forceMuted: boolean;
  banned: boolean;
}

/**
 * The socket handshake independently re-verifies membership (§11.3 "ghost
 * joins"): holding a stale token or a remembered room code is not sufficient.
 */
export async function resolveMembership(
  roomId: string,
  userId: string,
  hostId: string,
): Promise<Membership> {
  const [participant, ban] = await Promise.all([
    prisma.roomParticipant.findUnique({
      where: { roomId_userId: { roomId, userId } },
      select: { role: true, forceMuted: true },
    }),
    prisma.roomBan.findUnique({
      where: { roomId_userId: { roomId, userId } },
      select: { userId: true },
    }),
  ]);

  // The host row is authoritative even if the participant row drifted.
  const role: Role = userId === hostId ? 'host' : asRole(participant?.role ?? 'member');
  return {
    isParticipant: participant !== null,
    role,
    forceMuted: participant?.forceMuted ?? false,
    banned: ban !== null,
  };
}

/** Join keeps the participant row and flips `left_at` back to null (R8). */
export async function recordJoin(roomId: string, userId: string, role: Role): Promise<void> {
  const now = new Date();
  await prisma.roomParticipant.upsert({
    where: { roomId_userId: { roomId, userId } },
    create: { roomId, userId, role, firstJoinedAt: now, lastJoinedAt: now },
    update: { lastJoinedAt: now, leftAt: null },
  });
}

export async function recordLeave(roomId: string, userId: string): Promise<void> {
  await prisma.roomParticipant
    .update({ where: { roomId_userId: { roomId, userId } }, data: { leftAt: new Date() } })
    .catch(() => undefined);
}

export async function setParticipantRole(roomId: string, userId: string, role: Role): Promise<void> {
  await prisma.roomParticipant.update({
    where: { roomId_userId: { roomId, userId } },
    data: { role },
  });
}

export async function setForceMuted(roomId: string, userId: string, forceMuted: boolean): Promise<void> {
  await prisma.roomParticipant.update({
    where: { roomId_userId: { roomId, userId } },
    data: { forceMuted },
  });
}

/** Ban is two writes and must be one transaction: a half-ban lets them straight back in. */
export async function banUser(
  roomId: string,
  userId: string,
  bannedBy: string,
  reason: string | undefined,
): Promise<void> {
  await prisma.$transaction([
    prisma.roomBan.upsert({
      where: { roomId_userId: { roomId, userId } },
      create: { roomId, userId, bannedBy, ...(reason === undefined ? {} : { reason }) },
      update: { bannedBy, ...(reason === undefined ? {} : { reason }) },
    }),
    prisma.roomParticipant.deleteMany({ where: { roomId, userId } }),
  ]);
}

export async function transferHost(roomId: string, newHostId: string, oldHostId: string): Promise<void> {
  await prisma.$transaction([
    prisma.room.update({ where: { id: roomId }, data: { hostId: newHostId } }),
    prisma.roomParticipant.updateMany({
      where: { roomId, userId: newHostId },
      data: { role: 'host' },
    }),
    prisma.roomParticipant.updateMany({
      where: { roomId, userId: oldHostId },
      data: { role: 'co_host' },
    }),
  ]);
}

export async function updateRoomPolicy(
  roomId: string,
  patch: Schemas.UpdateRoomPolicyInput,
): Promise<void> {
  // Only forward keys the caller actually sent — `exactOptionalPropertyTypes`
  // means an explicit `undefined` is not the same as an absent key, and Prisma
  // would treat `{ name: undefined }` as "leave alone" only by luck.
  const data: Record<string, string | number | boolean | null> = {};
  if (patch.name !== undefined) data['name'] = patch.name;
  if (patch.topic !== undefined) data['topic'] = patch.topic;
  if (patch.playbackControl !== undefined) data['playbackControl'] = patch.playbackControl;
  if (patch.chatLocked !== undefined) data['chatLocked'] = patch.chatLocked;
  if (patch.slowModeSec !== undefined) data['slowModeSec'] = patch.slowModeSec;
  if (patch.waitForSlow !== undefined) data['waitForSlow'] = patch.waitForSlow;
  if (patch.callEnabled !== undefined) data['callEnabled'] = patch.callEnabled;
  if (patch.screenshareEnabled !== undefined) data['screenshareEnabled'] = patch.screenshareEnabled;
  if (patch.maxParticipants !== undefined) data['maxParticipants'] = patch.maxParticipants;
  if (Object.keys(data).length === 0) return;
  await prisma.room.update({ where: { id: roomId }, data });
}

export async function endRoom(roomId: string): Promise<void> {
  await prisma.room.update({
    where: { id: roomId },
    data: { status: 'ended', endedAt: new Date() },
  });
}

// ── write-behind persistence (§6.5) ─────────────────────────────────────────

/**
 * UPSERT the anchor and bump `rooms.last_active_at`. Called by the leader every
 * ROOM_SNAPSHOT_MS and once more, with a frozen anchor, on last-participant-leave.
 */
export async function snapshotVideoState(roomId: string, anchor: VideoAnchor): Promise<void> {
  const data = {
    provider: anchor.provider,
    videoRef: anchor.videoRef,
    title: anchor.title,
    durationSec: anchor.durationSec === null ? null : Math.round(anchor.durationSec),
    status: anchor.status,
    anchorPosition: anchor.anchorPositionSec,
    anchorServerMs: BigInt(Math.trunc(anchor.anchorServerMs)),
    playbackRate: anchor.playbackRate,
    revision: BigInt(Math.trunc(anchor.revision)),
    lastActorId: anchor.lastActorId,
  };

  await prisma.$transaction([
    prisma.roomVideoState.upsert({ where: { roomId }, create: { roomId, ...data }, update: data }),
    prisma.room.update({ where: { id: roomId }, data: { lastActiveAt: new Date() } }),
  ]);
}

/** Audit trail for disputed moderation decisions (§7.2 room_events, 90-day retention). */
export async function logRoomEvent(
  roomId: string,
  actorId: string | null,
  type: string,
  payload: Record<string, unknown> | null,
  log: Logger,
): Promise<void> {
  try {
    await prisma.roomEvent.create({
      data: {
        id: uuidv7(),
        roomId,
        actorId,
        type: type.slice(0, 32),
        // The payload is our own audit metadata, never user content, so the
        // cast to Prisma's JSON input type is safe by construction.
        //
        // Spread conditionally rather than assigning `undefined`: under
        // `exactOptionalPropertyTypes` an optional Prisma input field accepts the
        // key being absent, but not the key being present and undefined.
        ...(payload === null ? {} : { payload: payload as Prisma.InputJsonObject }),
      },
    });
  } catch (err) {
    // An audit write must never fail the action it is auditing.
    log.error({ roomId, type, err }, 'failed to write room event');
  }
}

export async function pingDb(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
