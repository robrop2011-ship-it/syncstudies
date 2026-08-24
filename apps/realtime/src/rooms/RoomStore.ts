/**
 * The RoomStore portability seam (PLAN.md §6.4) and its Redis implementation.
 *
 * Redis is the LIVE truth for the video anchor and presence; Postgres is the
 * DURABLE truth (§7.3). Losing Redis costs at most one snapshot interval of
 * playback position and forces reconnects — that is the designed failure mode,
 * and it is why the interface below is small enough to reimplement on something
 * else if Redis ever becomes the wrong answer.
 */
import { prisma } from '@syncstudy/db';
import {
  IDLE_ANCHOR,
  ROOM_STATE_TTL_MS,
  type ControlRejectReason,
  type ConnState,
  type Role,
  type VideoAnchor,
  type VideoProvider,
  type PlaybackStatus,
} from '@syncstudy/shared';
import type { Logger } from '../logger.js';
import { keys, type ScriptedRedis } from '../redis.js';
import { redisTransactMs } from '../metrics.js';

// ── the live state objects ──────────────────────────────────────────────────

export interface RoomLiveState {
  roomId: string;
  anchor: VideoAnchor;
}

/**
 * One participant as Redis holds them. `handle`/`displayName` are cached here so
 * building a snapshot is a single Redis read rather than N Postgres lookups —
 * they are never written to a log line (§11.10).
 */
export interface PresenceEntry {
  userId: string;
  socketId: string;
  /** Which realtime node holds the socket; needed for targeted disconnects. */
  node: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  role: Role;
  connState: ConnState;
  joinedAt: number;
  inCall: boolean;
  muted: boolean;
  camOn: boolean;
  sharing: boolean;
  speaking: boolean;
  forceMuted: boolean;
  buffering: boolean;
  /** Epoch ms the socket dropped, or null while connected. Drives the grace sweep. */
  disconnectedAt: number | null;
}

export interface TransactOutcome {
  ok: boolean;
  reason: ControlRejectReason | null;
  revision: number;
}

/** PLAN.md §6.4, verbatim. Everything else on RedisRoomStore is an addition. */
export interface RoomStore {
  getState(roomId: string): Promise<RoomLiveState | null>;
  /** Atomic read-modify-write. MUST be serialized per room. */
  transact<T>(roomId: string, fn: (s: RoomLiveState) => { next: RoomLiveState; result: T }): Promise<T>;
  addParticipant(roomId: string, p: PresenceEntry): Promise<void>;
  removeParticipant(roomId: string, userId: string): Promise<void>;
  listParticipants(roomId: string): Promise<PresenceEntry[]>;
  touch(roomId: string): Promise<void>;
}

// ── serialisation ───────────────────────────────────────────────────────────
//
// Empty string means null on the wire. Redis hashes have no null, and using a
// literal 'null' string invites a videoRef that is the four characters "null".

const EMPTY = '';

function str(v: string | null): string {
  return v ?? EMPTY;
}

function orNull(v: string | undefined): string | null {
  return v === undefined || v === EMPTY ? null : v;
}

function numOrNull(v: string | undefined): number | null {
  const s = orNull(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function num(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const PROVIDERS: readonly VideoProvider[] = ['youtube', 'file', 'none'];
const STATUSES: readonly PlaybackStatus[] = ['idle', 'playing', 'paused', 'ended'];

function asProvider(v: string | undefined): VideoProvider {
  return PROVIDERS.find((p) => p === v) ?? 'none';
}

function asStatus(v: string | undefined): PlaybackStatus {
  return STATUSES.find((s) => s === v) ?? 'idle';
}

/** Hash → anchor. Tolerant by design: a half-written hash must not crash a join. */
export function anchorFromHash(hash: Record<string, string>): VideoAnchor {
  return {
    provider: asProvider(hash['provider']),
    videoRef: orNull(hash['videoRef']),
    title: orNull(hash['title']),
    durationSec: numOrNull(hash['duration']),
    status: asStatus(hash['status']),
    anchorPositionSec: num(hash['anchorPos'], 0),
    anchorServerMs: num(hash['anchorServerMs'], 0),
    playbackRate: num(hash['rate'], 1),
    revision: num(hash['revision'], 0),
    lastActorId: orNull(hash['lastActorId']),
    lastChangeMs: num(hash['lastChangeMs'], 0),
  };
}

export function anchorToHash(a: VideoAnchor): Record<string, string> {
  return {
    provider: a.provider,
    videoRef: str(a.videoRef),
    title: str(a.title),
    duration: a.durationSec === null ? EMPTY : String(a.durationSec),
    status: a.status,
    anchorPos: String(a.anchorPositionSec),
    anchorServerMs: String(a.anchorServerMs),
    rate: String(a.playbackRate),
    revision: String(a.revision),
    lastActorId: str(a.lastActorId),
    lastChangeMs: String(a.lastChangeMs),
  };
}

function presenceFromJson(raw: string, log: Logger): PresenceEntry | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const e = parsed as Partial<PresenceEntry>;
    if (typeof e.userId !== 'string' || typeof e.socketId !== 'string') return null;
    return {
      userId: e.userId,
      socketId: e.socketId,
      node: typeof e.node === 'string' ? e.node : 'unknown',
      handle: typeof e.handle === 'string' ? e.handle : '',
      displayName: typeof e.displayName === 'string' ? e.displayName : '',
      avatarUrl: typeof e.avatarUrl === 'string' ? e.avatarUrl : null,
      role: (e.role ?? 'member') as Role,
      connState: (e.connState ?? 'connected') as ConnState,
      joinedAt: typeof e.joinedAt === 'number' ? e.joinedAt : Date.now(),
      inCall: e.inCall === true,
      muted: e.muted !== false,
      camOn: e.camOn === true,
      sharing: e.sharing === true,
      speaking: e.speaking === true,
      forceMuted: e.forceMuted === true,
      buffering: e.buffering === true,
      disconnectedAt: typeof e.disconnectedAt === 'number' ? e.disconnectedAt : null,
    };
  } catch (err) {
    // A corrupt entry must cost one participant row, not the whole snapshot.
    log.warn({ err }, 'presence entry failed to parse');
    return null;
  }
}

// ── the Redis implementation ────────────────────────────────────────────────

const HYDRATE_LOCK_MS = 5_000;
const HYDRATE_POLL_MS = 25;
const HYDRATE_POLL_TRIES = 20;
const TRANSACT_MAX_ATTEMPTS = 5;

/**
 * KEYS[1] presence hash. ARGV: userId, entryJson, maxParticipants, ttlMs.
 * Returns 1 when the participant is in the room, 0 when the room is full.
 */
const ADD_PARTICIPANT_LUA = `
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0
   and redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[3]) then
  return 0
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return 1
`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface ApplyControlArgs {
  roomId: string;
  /** The anchor produced by `applyControl`/`applySetVideo` from @syncstudy/shared. */
  next: VideoAnchor;
  /** The revision the caller checked against. -1 skips the check (resync only). */
  expectedRevision: number;
  /** Null for a system action (auto-pause); system actions are never lock-checked. */
  actorId: string | null;
  nowMs: number;
  /** CONTROL_LOCK_MS for a user control, 0 for a system write. */
  lockMs: number;
  /** Extra hash fields written in the same atomic step (video metadata). */
  extra?: Record<string, string>;
}

export class RedisRoomStore implements RoomStore {
  constructor(
    private readonly redis: ScriptedRedis,
    private readonly log: Logger,
  ) {}

  // ── video state ───────────────────────────────────────────────────────────

  async getState(roomId: string): Promise<RoomLiveState | null> {
    const hash = await this.redis.hgetall(keys.roomState(roomId));
    // A hash with no `revision` is either absent or mid-hydration; both are cold.
    if (hash['revision'] === undefined) return null;
    return { roomId, anchor: anchorFromHash(hash) };
  }

  /**
   * §6.4's generic transact. The compare-and-set lives in the Lua script, so two
   * nodes running `fn` against the same base state cannot both commit: the loser
   * gets `stale_revision`, re-reads, and runs `fn` again against the winner's state.
   *
   * `fn` must therefore be a pure function of the state it is handed.
   */
  async transact<T>(
    roomId: string,
    fn: (s: RoomLiveState) => { next: RoomLiveState; result: T },
  ): Promise<T> {
    for (let attempt = 0; attempt < TRANSACT_MAX_ATTEMPTS; attempt++) {
      const current = (await this.getState(roomId)) ?? (await this.hydrateFromDb(roomId));
      const { next, result } = fn(current);

      const outcome = await this.applyAtomic({
        roomId,
        next: next.anchor,
        expectedRevision: current.anchor.revision,
        actorId: next.anchor.lastActorId,
        nowMs: Date.now(),
        // Pure CAS: the caller has already made the policy decision.
        lockMs: 0,
      });

      if (outcome.ok) return result;
      if (outcome.reason !== 'stale_revision') {
        throw new Error(`transact rejected unexpectedly: ${outcome.reason ?? 'unknown'}`);
      }
      this.log.debug({ roomId, attempt }, 'transact CAS retry');
    }
    throw new Error(`transact failed after ${TRANSACT_MAX_ATTEMPTS} attempts (roomId=${roomId})`);
  }

  /**
   * The direct §6.4 path used by `video:control` and `video:set`: one Lua call
   * that re-checks `expectedRevision` and the control lock against the state as
   * it is right now, then writes. Returns the reason on rejection so the handler
   * can answer the client honestly.
   */
  async applyAtomic(args: ApplyControlArgs): Promise<TransactOutcome> {
    const hash = anchorToHash(args.next);
    const extra: string[] = [];
    for (const [field, value] of Object.entries(args.extra ?? {})) {
      extra.push(field, value);
    }

    const startedAt = Date.now();
    let reply;
    try {
      reply = await this.redis.transactVideo(
        keys.roomState(args.roomId),
        String(args.expectedRevision),
        hash['status'] ?? 'idle',
        hash['anchorPos'] ?? '0',
        hash['anchorServerMs'] ?? '0',
        hash['rate'] ?? '1',
        str(args.actorId),
        String(args.nowMs),
        String(args.lockMs),
        String(ROOM_STATE_TTL_MS),
        ...extra,
      );
    } finally {
      redisTransactMs.observe(Date.now() - startedAt);
    }

    const [ok, reason, revision] = reply;
    return {
      ok: ok === 1,
      reason: ok === 1 ? null : (reason as ControlRejectReason),
      revision,
    };
  }

  /**
   * Cold-room hydration (PLAN.md §8.11).
   *
   * The critical rule: status is ALWAYS forced to 'paused'. A room that was
   * playing when the last person left must not have "advanced" while nobody was
   * in it — otherwise reopening it three days later lands at the end of the video.
   * `anchorServerMs` is re-stamped to now for the same reason: the stored anchor
   * time is meaningless once it is no longer live.
   */
  async hydrateFromDb(roomId: string): Promise<RoomLiveState> {
    const lockKey = `room:${roomId}:hydrate`;
    const gotLock = await this.redis.set(lockKey, '1', 'PX', HYDRATE_LOCK_MS, 'NX');

    if (gotLock === null) {
      // Another node is hydrating. Wait for its write rather than racing it —
      // two hydrations would be identical except for the revision, and the loser
      // would clobber any control that landed in between.
      for (let i = 0; i < HYDRATE_POLL_TRIES; i++) {
        await sleep(HYDRATE_POLL_MS);
        const state = await this.getState(roomId);
        if (state) return state;
      }
      this.log.warn({ roomId }, 'hydrate lock wait timed out; hydrating anyway');
    }

    try {
      const existing = await this.getState(roomId);
      if (existing) return existing;

      const row = await prisma.roomVideoState.findUnique({ where: { roomId } });
      const now = Date.now();

      const anchor: VideoAnchor = row
        ? {
            provider: asProvider(row.provider),
            videoRef: row.videoRef,
            title: row.title,
            durationSec: row.durationSec,
            // Never auto-resume a room nobody has been in.
            status: row.status === 'idle' ? 'idle' : 'paused',
            anchorPositionSec: row.anchorPosition,
            anchorServerMs: now,
            playbackRate: row.playbackRate,
            revision: Number(row.revision),
            lastActorId: row.lastActorId,
            // Do not carry a stale control lock across a cold start.
            lastChangeMs: 0,
          }
        : { ...IDLE_ANCHOR, anchorServerMs: now };

      const hash = anchorToHash(anchor);
      // One HSET writes every field atomically, so no reader can observe a
      // half-hydrated room. `revision` is part of the same call, and getState
      // treats its absence as "still cold".
      await this.redis.hset(keys.roomState(roomId), hash);
      await this.redis.pexpire(keys.roomState(roomId), ROOM_STATE_TTL_MS);

      this.log.info({ roomId, revision: anchor.revision }, 'room state hydrated from postgres');
      return { roomId, anchor };
    } finally {
      if (gotLock !== null) await this.redis.del(lockKey).catch(() => undefined);
    }
  }

  /** Warm read that hydrates on a miss. The path every handler should use. */
  async getOrHydrate(roomId: string): Promise<RoomLiveState> {
    return (await this.getState(roomId)) ?? (await this.hydrateFromDb(roomId));
  }

  // ── presence ──────────────────────────────────────────────────────────────

  /**
   * Capacity-checked join (§11.3 "max_participants enforced atomically in Redis").
   *
   * Check-then-add in two commands lets 200 concurrent joins all observe
   * "7 of 8" and all succeed. The check and the write have to be one step, so
   * they are one script. An existing participant re-joining (a reconnect) never
   * consumes a slot — they already hold one.
   */
  async addParticipantIfRoom(
    roomId: string,
    p: PresenceEntry,
    maxParticipants: number,
  ): Promise<boolean> {
    // `eval` is typed as returning `unknown`; narrow rather than assert.
    const added: unknown = await this.redis.eval(
      ADD_PARTICIPANT_LUA,
      1,
      keys.roomPresence(roomId),
      p.userId,
      JSON.stringify(p),
      String(maxParticipants),
      String(ROOM_STATE_TTL_MS),
    );
    return typeof added === 'number' && added === 1;
  }

  async addParticipant(roomId: string, p: PresenceEntry): Promise<void> {
    await this.redis
      .multi()
      .hset(keys.roomPresence(roomId), p.userId, JSON.stringify(p))
      .pexpire(keys.roomPresence(roomId), ROOM_STATE_TTL_MS)
      .exec();
  }

  async removeParticipant(roomId: string, userId: string): Promise<void> {
    await this.redis.hdel(keys.roomPresence(roomId), userId);
  }

  /**
   * Remove and report whether we were the one who removed them.
   *
   * The owning node's grace timer and the leader's sweep can both fire for the
   * same participant. HDEL's reply is the tie-break: exactly one caller gets
   * `true`, so exactly one `presence:leave` is broadcast.
   */
  async deleteParticipant(roomId: string, userId: string): Promise<boolean> {
    const removed = await this.redis.hdel(keys.roomPresence(roomId), userId);
    return removed === 1;
  }

  async listParticipants(roomId: string): Promise<PresenceEntry[]> {
    const hash = await this.redis.hgetall(keys.roomPresence(roomId));
    const out: PresenceEntry[] = [];
    for (const raw of Object.values(hash)) {
      const entry = presenceFromJson(raw, this.log);
      if (entry) out.push(entry);
    }
    // Stable order: earliest joiner first. The client re-sorts for display (R6).
    out.sort((a, b) => a.joinedAt - b.joinedAt || a.userId.localeCompare(b.userId));
    return out;
  }

  async getParticipant(roomId: string, userId: string): Promise<PresenceEntry | null> {
    const raw = await this.redis.hget(keys.roomPresence(roomId), userId);
    return raw === null ? null : presenceFromJson(raw, this.log);
  }

  async countParticipants(roomId: string): Promise<number> {
    return this.redis.hlen(keys.roomPresence(roomId));
  }

  /**
   * Read-modify-write of one participant. Presence is last-writer-wins by
   * design: it is inherently ephemeral (§6.5) and a lost `speaking:true` costs
   * one animation frame, so a lock here would be more expensive than the bug.
   */
  async updateParticipant(
    roomId: string,
    userId: string,
    patch: Partial<PresenceEntry>,
  ): Promise<PresenceEntry | null> {
    const current = await this.getParticipant(roomId, userId);
    if (!current) return null;
    const next: PresenceEntry = { ...current, ...patch };
    await this.addParticipant(roomId, next);
    return next;
  }

  async touch(roomId: string): Promise<void> {
    await this.redis
      .multi()
      .pexpire(keys.roomState(roomId), ROOM_STATE_TTL_MS)
      .pexpire(keys.roomPresence(roomId), ROOM_STATE_TTL_MS)
      .exec();
  }

  // ── buffering set (wait_for_slow, §8.10) ──────────────────────────────────

  async markBuffering(roomId: string, userId: string, buffering: boolean): Promise<string[]> {
    const key = keys.roomBuffering(roomId);
    if (buffering) {
      await this.redis.multi().sadd(key, userId).pexpire(key, 30_000).exec();
    } else {
      await this.redis.srem(key, userId);
    }
    return this.redis.smembers(key);
  }

  async listBuffering(roomId: string): Promise<string[]> {
    return this.redis.smembers(keys.roomBuffering(roomId));
  }

  async clearBuffering(roomId: string): Promise<void> {
    await this.redis.del(keys.roomBuffering(roomId));
  }

  // ── room code cache ───────────────────────────────────────────────────────

  async cacheRoomCode(code: string, roomId: string): Promise<void> {
    await this.redis.set(keys.roomCode(code), roomId, 'PX', 3_600_000);
  }

  async roomIdForCode(code: string): Promise<string | null> {
    return this.redis.get(keys.roomCode(code));
  }

  async forgetRoomCode(code: string): Promise<void> {
    await this.redis.del(keys.roomCode(code));
  }

  // ── socket directory (targeted disconnects, §11.3) ────────────────────────

  async registerSocket(socketId: string, userId: string, node: string, roomId?: string): Promise<void> {
    const fields: Record<string, string> = { userId, node };
    if (roomId !== undefined) fields['roomId'] = roomId;
    await this.redis
      .multi()
      .hset(keys.socket(socketId), fields)
      .pexpire(keys.socket(socketId), ROOM_STATE_TTL_MS)
      .exec();
  }

  async forgetSocket(socketId: string): Promise<void> {
    await this.redis.del(keys.socket(socketId));
  }

  /** Drop every Redis key belonging to a finished room. */
  async purgeRoom(roomId: string): Promise<void> {
    await this.redis.del(
      keys.roomState(roomId),
      keys.roomPresence(roomId),
      keys.roomBuffering(roomId),
      keys.roomScreenshare(roomId),
      keys.roomMeta(roomId),
    );
  }
}
