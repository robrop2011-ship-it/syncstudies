/**
 * Invalidating the realtime service's room cache from the web tier.
 *
 * The realtime service keeps `room:{id}:meta` and `code:{code}` in Redis with a
 * 1-hour TTL so a permission check on the hot path is a Redis read rather than a
 * Postgres round-trip. That cache is Postgres-derived, and the socket layer
 * refreshes it itself after any change it makes (see `ctx.meta.refresh` in
 * apps/realtime/src/handlers/host.ts).
 *
 * The REST tier writes the same columns — `PATCH /api/rooms/:id` changes policy,
 * `DELETE` ends the room — so without this the two tiers disagree for up to an
 * hour. Concretely: a host ends a room and everyone stays in it, because
 * `room:join` reads `meta.status` from a cache that still says 'active'. A
 * durable write that another service caches is only half a write.
 *
 * Keys are duplicated here rather than imported from apps/realtime because the
 * web app must not depend on the realtime app. They are asserted against the
 * real definitions in `__tests__/realtime-cache.test.ts` — if
 * apps/realtime/src/redis.ts renames one, that test fails.
 */
import Redis from 'ioredis';

/** Mirrors `keys.roomMeta` in apps/realtime/src/redis.ts. */
export const roomMetaKey = (roomId: string): string => `room:${roomId}:meta`;
/** Mirrors `keys.roomCode` in apps/realtime/src/redis.ts. */
export const roomCodeKey = (code: string): string => `code:${code}`;

let client: Redis | null = null;
let warnedMissingUrl = false;

/**
 * Lazily-created shared client. Returns null when REDIS_URL is unset, which is
 * the normal state for a web-only local run — the caller degrades rather than
 * failing the request (see `invalidateRoomCache`).
 */
function redis(): Redis | null {
  const url = process.env.REDIS_URL;
  if (!url) {
    if (!warnedMissingUrl) {
      warnedMissingUrl = true;
      console.warn(
        '[realtime-cache] REDIS_URL is unset — room policy and status changes made over ' +
          'REST will take up to an hour to reach connected clients. Set REDIS_URL to the ' +
          'same instance the realtime service uses.',
      );
    }
    return null;
  }
  if (client === null) {
    client = new Redis(url, {
      // A cache invalidation must never become the slowest part of a request,
      // and must never hold one open when Redis is unreachable.
      connectTimeout: 2_000,
      commandTimeout: 2_000,
      maxRetriesPerRequest: 1,
      // The offline queue must stay ON. The client is created lazily on the
      // first invalidation, and with the queue off that very first command is
      // rejected with "Stream isn't writeable" because the socket has not
      // finished connecting yet — so the first policy change after a deploy
      // silently failed to invalidate while every later one worked. Bounded by
      // `maxRetriesPerRequest` and `commandTimeout` above, so a genuinely dead
      // Redis still fails fast rather than queueing without limit.
      enableOfflineQueue: true,
      lazyConnect: false,
    });
    // ioredis emits 'error' on every reconnect attempt; without a listener that
    // becomes an unhandled 'error' event and takes the process down.
    client.on('error', (err: Error) => {
      console.warn(`[realtime-cache] redis error: ${err.message}`);
    });
  }
  return client;
}

/**
 * Drop the cached room row so the next socket read comes from Postgres.
 *
 * Deliberately never throws. The durable write in Postgres has already
 * succeeded by the time this runs, so a Redis outage must not turn a successful
 * policy change into a 500 — it degrades to "the change lands within the TTL".
 * Returns whether the invalidation actually happened, for tests and logging.
 */
export async function invalidateRoomCache(roomId: string, code?: string): Promise<boolean> {
  const conn = redis();
  if (conn === null) return false;
  try {
    const keys = code ? [roomMetaKey(roomId), roomCodeKey(code)] : [roomMetaKey(roomId)];
    await conn.del(...keys);
    return true;
  } catch (err) {
    console.warn(
      `[realtime-cache] failed to invalidate room ${roomId}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Write a socket handshake ticket (§11.4).
 *
 * Unlike `invalidateRoomCache` this one THROWS on failure, and the difference is
 * deliberate. A missed cache invalidation degrades — the change lands when the
 * TTL expires. A missed ticket does not degrade: the client would take a token
 * that was never stored, the handshake would refuse it, and the room would sit
 * there retrying. Better to fail the mint loudly so the caller sees a 500 and
 * the reason reaches a log.
 */
export async function storeRealtimeTicket(key: string, userId: string, ttlMs: number): Promise<void> {
  const conn = redis();
  if (conn === null) {
    throw new Error('REDIS_URL is not configured; the realtime handshake cannot be authenticated');
  }
  await conn.set(key, userId, 'PX', ttlMs);
}

/** Test seam: drop the shared client so a suite can swap REDIS_URL. */
export async function __resetRealtimeCacheClient(): Promise<void> {
  const conn = client;
  client = null;
  warnedMissingUrl = false;
  if (conn) await conn.quit().catch(() => undefined);
}
