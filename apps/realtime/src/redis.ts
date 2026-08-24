/**
 * Redis clients and the Lua scripts registered onto them (PLAN.md §6.4, §7.3, §11.7).
 *
 * Four connections, and each one exists for a reason:
 *
 *  - `pub` / `sub` — the Socket.IO Redis adapter requires two dedicated
 *    connections, because a connection in subscriber mode cannot issue ordinary
 *    commands. The adapter owns these; do not run commands on them.
 *  - `cmd` — everything else: the room state hash, presence, rate limits,
 *    leader leases. This is the only client the application code touches.
 *  - `busSub` — our own pub/sub subscriber for `admin:disconnect` and the room
 *    bus. Kept separate from the adapter's `sub` so that a change in the
 *    adapter's subscription strategy cannot silently eat our messages.
 *
 * Scripts are registered with `defineCommand`, so they are called as normal
 * methods and ioredis handles EVALSHA-with-EVAL-fallback (including after a
 * Redis restart flushes the script cache).
 */
import { readFileSync } from 'node:fs';
import { Redis, type RedisOptions } from 'ioredis';

const TRANSACT_VIDEO_LUA = readFileSync(new URL('./scripts/transactVideo.lua', import.meta.url), 'utf8');
const RATE_LIMIT_LUA = readFileSync(new URL('./scripts/rateLimit.lua', import.meta.url), 'utf8');

/** `[ok, reason, revision]` — ok is 1/0, reason is 'ok' or a ControlRejectReason. */
export type TransactVideoReply = [number, string, number];
/** `[allowed, retryAfterMs]`. */
export type RateLimitReply = [number, number];

/**
 * ioredis' `defineCommand` attaches methods dynamically, so they have to be
 * declared for the type system. Declaring them here (rather than augmenting the
 * ioredis module globally) keeps the typed surface to the client we actually
 * registered the scripts on.
 */
export interface ScriptedRedis extends Redis {
  transactVideo(
    key: string,
    expectedRevision: string,
    status: string,
    anchorPos: string,
    anchorServerMs: string,
    rate: string,
    actorId: string,
    nowMs: string,
    lockMs: string,
    ttlMs: string,
    ...extraFieldValuePairs: string[]
  ): Promise<TransactVideoReply>;

  rateLimit(key: string, limit: string, windowMs: string): Promise<RateLimitReply>;
}

export interface RedisClients {
  pub: Redis;
  sub: Redis;
  cmd: ScriptedRedis;
  busSub: Redis;
  quitAll(): Promise<void>;
}

function baseOptions(url: string, role: string): RedisOptions {
  return {
    // A pub/sub or adapter connection must keep retrying forever; a command
    // connection must fail the request instead of hanging a socket handler.
    maxRetriesPerRequest: role === 'cmd' ? 3 : null,
    enableReadyCheck: true,
    connectionName: `syncstudy-rt-${role}`,
    retryStrategy: (times: number) => Math.min(times * 200, 5_000),
    // rediss:// URLs carry their own TLS config; ioredis picks that up from the url.
    ...(url.startsWith('rediss://') ? { tls: {} } : {}),
  };
}

export function createRedisClients(url: string): RedisClients {
  const cmd = new Redis(url, baseOptions(url, 'cmd')) as ScriptedRedis;

  cmd.defineCommand('transactVideo', { numberOfKeys: 1, lua: TRANSACT_VIDEO_LUA });
  cmd.defineCommand('rateLimit', { numberOfKeys: 1, lua: RATE_LIMIT_LUA });

  const pub = new Redis(url, baseOptions(url, 'pub'));
  const sub = pub.duplicate({ connectionName: 'syncstudy-rt-sub' });
  const busSub = pub.duplicate({ connectionName: 'syncstudy-rt-bus' });

  return {
    pub,
    sub,
    cmd,
    busSub,
    async quitAll(): Promise<void> {
      // `quit` waits for in-flight replies; `disconnect` is the fallback for a
      // connection that is already gone, so shutdown can never hang on Redis.
      await Promise.all(
        [cmd, pub, sub, busSub].map(async (client) => {
          try {
            await client.quit();
          } catch {
            client.disconnect();
          }
        }),
      );
    },
  };
}

/** Health probe for `GET /health`. Cheap, and it really does touch the server. */
export async function pingRedis(client: Redis): Promise<boolean> {
  try {
    return (await client.ping()) === 'PONG';
  } catch {
    return false;
  }
}

// ── key layout (PLAN.md §7.3) ───────────────────────────────────────────────
// One module owns every key string. A typo'd key in a handler is a silent bug
// that looks like data loss, and grepping for `room:${` finds nothing useful.

export const keys = {
  /** HASH, 6h — the live video anchor. */
  roomState: (roomId: string) => `room:${roomId}:state`,
  /** HASH, 6h — userId → PresenceEntry JSON. */
  roomPresence: (roomId: string) => `room:${roomId}:presence`,
  /** STRING, 15s renewed — node id holding heartbeat/snapshot duty. */
  roomLeader: (roomId: string) => `room:${roomId}:leader`,
  /** SET, 30s — user ids currently stalled, for wait_for_slow. */
  roomBuffering: (roomId: string) => `room:${roomId}:buffering`,
  /** STRING, 6h — user id holding the single screen-share lock. */
  roomScreenshare: (roomId: string) => `room:${roomId}:screenshare`,
  /**
   * HASH, 6h — room row + policy, so a permission check on the hot path is a
   * Redis read rather than a Postgres round-trip. Refreshed on join and on
   * every policy update; Postgres remains the durable truth.
   */
  roomMeta: (roomId: string) => `room:${roomId}:meta`,
  /** STRING counter, window — token bucket. */
  rateLimit: (scope: string, id: string) => `rl:${scope}:${id}`,
  /** STRING, 60s — post-abuse reconnect cooldown (§11.7). */
  rateLimitCooldown: (userId: string) => `rl:cooldown:${userId}`,
  /** SET, 60s — live socket ids per ip hash, for the connection cap (§11.4). */
  ipConnections: (ipHash: string) => `conn:ip:${ipHash}`,
  /** HASH, connection lifetime — userId/roomId/node, for targeted disconnects. */
  socket: (socketId: string) => `sock:${socketId}`,
  /** STRING, 1h — roomId cache for hot join lookups. */
  roomCode: (code: string) => `code:${code}`,
} as const;

/** Pub/sub channels. */
export const channels = {
  /** Force-disconnect a user from every node (ban/kick/end room) — §11.3. */
  adminDisconnect: 'admin:disconnect',
  /** Room-scoped side effects that only the leader may act on. */
  roomBus: 'room:bus',
} as const;
