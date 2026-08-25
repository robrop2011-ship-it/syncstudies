/**
 * Socket.IO handshake authentication (PLAN.md §11.4).
 *
 * Order matters and is not negotiable:
 *
 *   1. Origin allowlist. Socket.IO does NOT enforce same-origin by itself, so
 *      without this any page on the internet can open an authenticated socket
 *      with the user's cookie riding along.
 *   2. Session from the SAME httpOnly cookie the web app sets. No tokens in
 *      query strings — query strings land in access logs and Referer headers.
 *   3. Per-IP connection cap, to blunt socket-exhaustion DoS.
 *
 * Room membership is deliberately NOT checked here. It is checked in
 * `room:join`, against Postgres, every time (§11.3 "ghost joins").
 */
import { getSessionFromCookieHeader, hashIp } from '@syncstudy/auth';
import type { Logger } from '../logger.js';
import type { TypedSocket } from '../handlers/context.js';
import { keys, type ScriptedRedis } from '../redis.js';
import type { TokenBucket } from '../ratelimit/tokenBucket.js';

/**
 * §11.4: "if (await connCount(ip(socket)) > 12) return next(new Error(...))".
 *
 * The default; `MAX_CONNECTIONS_PER_IP` in the environment overrides it, which
 * exists so a load test driving 500 sockets from one loopback address measures
 * the server instead of measuring this check.
 */
export const DEFAULT_MAX_CONNECTIONS_PER_IP = 12;

/**
 * Entries older than this are treated as leaked (a node died holding sockets)
 * and pruned before counting. A real socket dies within `pingTimeout`, so this
 * only ever prunes ghosts.
 */
const CONNECTION_ENTRY_TTL_MS = 6 * 60 * 60 * 1000;

export type HandshakeError =
  | 'bad_origin'
  | 'unauthenticated'
  | 'account_suspended'
  | 'too_many_connections'
  | 'rate_limited'
  | 'server_error';

export interface HandshakeDeps {
  redis: ScriptedRedis;
  log: Logger;
  limiter: TokenBucket;
  allowedOrigins: string[];
  ipHashSalt: string;
  nodeId: string;
  maxConnectionsPerIp?: number | undefined;
}

/**
 * Behind Fly/Cloudflare the client address arrives in a header. `fly-client-ip`
 * is set by the proxy and cannot be spoofed by the client; `x-forwarded-for` is
 * appended to, so only the FIRST entry is meaningful and only when we trust the
 * proxy. This feeds the connection cap and the salted hash — never auth — so a
 * spoof costs an attacker a lower cap, not access.
 */
export function clientIp(socket: TypedSocket): string {
  const headers = socket.handshake.headers;
  const flyIp = headers['fly-client-ip'];
  if (typeof flyIp === 'string' && flyIp.length > 0) return flyIp;

  const forwarded = headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const first = raw?.split(',')[0]?.trim();
  if (first) return first;

  return socket.handshake.address;
}

/**
 * Origins are compared exactly. No wildcard, no suffix matching: `notevil.com`
 * ends with `evil.com` and a suffix check is how that becomes a vulnerability.
 */
export function isOriginAllowed(origin: string | undefined, allowed: string[]): boolean {
  return origin !== undefined && allowed.includes(origin);
}

async function countAndRegisterConnection(
  redis: ScriptedRedis,
  ipHash: string,
  socketId: string,
): Promise<number> {
  const key = keys.ipConnections(ipHash);
  const now = Date.now();
  const results = await redis
    .multi()
    .zremrangebyscore(key, 0, now - CONNECTION_ENTRY_TTL_MS)
    .zadd(key, now, socketId)
    .zcard(key)
    .pexpire(key, CONNECTION_ENTRY_TTL_MS)
    .exec();

  // exec() returns [[err, reply], …]; the ZCARD is the third command.
  const zcard = results?.[2];
  if (!zcard || zcard[0] !== null) throw new Error('connection count failed');
  return typeof zcard[1] === 'number' ? zcard[1] : 0;
}

export async function releaseConnection(
  redis: ScriptedRedis,
  ipHash: string,
  socketId: string,
): Promise<void> {
  await redis.zrem(keys.ipConnections(ipHash), socketId).catch(() => undefined);
}

export type HandshakeMiddleware = (socket: TypedSocket, next: (err?: Error) => void) => void;

export function createHandshakeMiddleware(deps: HandshakeDeps): HandshakeMiddleware {
  return (socket, next) => {
    void authenticate(socket, deps)
      .then((error) => next(error === null ? undefined : new Error(error)))
      .catch((err: unknown) => {
        // A throw here must not leave the socket hanging until connectTimeout.
        deps.log.error({ socketId: socket.id, err }, 'handshake threw');
        next(new Error('server_error'));
      });
  };
}

/** @returns null on success, or the error code to fail the handshake with. */
async function authenticate(socket: TypedSocket, deps: HandshakeDeps): Promise<HandshakeError | null> {
  // 1. Origin allowlist, FIRST — before we touch the database on behalf of a
  //    request that has no business being here.
  const origin = socket.handshake.headers.origin;
  if (!isOriginAllowed(origin, deps.allowedOrigins)) {
    deps.log.warn({ socketId: socket.id }, 'handshake rejected: bad origin');
    return 'bad_origin';
  }

  // 2. Session from the httpOnly cookie.
  const session = await getSessionFromCookieHeader(socket.handshake.headers.cookie);
  if (!session) {
    deps.log.debug({ socketId: socket.id }, 'handshake rejected: unauthenticated');
    return 'unauthenticated';
  }

  // Suspended accounts may read over REST but cannot join rooms, chat or call
  // (§11.6). The socket is the only way to do any of those, so it is refused
  // here rather than at each handler.
  if (session.user.status === 'suspended') {
    deps.log.info({ socketId: socket.id, userId: session.user.id }, 'handshake rejected: suspended');
    return 'account_suspended';
  }

  const ipHash = hashIp(clientIp(socket), deps.ipHashSalt);

  // Post-abuse cooldown (§11.7). Fails CLOSED: if Redis is unreachable we
  // cannot prove this socket is not the one we just disconnected.
  try {
    if (await deps.limiter.inCooldown(session.user.id)) {
      deps.log.info({ socketId: socket.id, userId: session.user.id }, 'handshake rejected: cooldown');
      return 'rate_limited';
    }
  } catch (err) {
    deps.log.error({ socketId: socket.id, err }, 'cooldown check failed; failing closed');
    return 'server_error';
  }

  // 3. Per-IP connection cap. Also fails closed — an unbounded socket count is
  //    exactly the DoS this exists to prevent.
  let connections: number;
  try {
    connections = await countAndRegisterConnection(deps.redis, ipHash, socket.id);
  } catch (err) {
    deps.log.error({ socketId: socket.id, err }, 'connection cap check failed; failing closed');
    return 'server_error';
  }

  if (connections > (deps.maxConnectionsPerIp ?? DEFAULT_MAX_CONNECTIONS_PER_IP)) {
    await releaseConnection(deps.redis, ipHash, socket.id);
    deps.log.warn({ socketId: socket.id, connections }, 'handshake rejected: too many connections');
    return 'too_many_connections';
  }

  // Identity for the whole connection lifetime. Every handler reads from here
  // and never from a payload.
  socket.data.userId = session.user.id;
  socket.data.handle = session.user.handle;
  socket.data.displayName = session.user.displayName;
  // The web app stores an opaque avatar key and resolves it against the asset
  // domain. The realtime service has no asset-domain config by design, so it
  // passes the stored value through unchanged.
  socket.data.avatarUrl = session.user.avatarKey;
  socket.data.ipHash = ipHash;

  await deps.redis
    .multi()
    .hset(keys.socket(socket.id), { userId: session.user.id, node: deps.nodeId })
    .pexpire(keys.socket(socket.id), CONNECTION_ENTRY_TTL_MS)
    .exec()
    .catch(() => undefined);

  deps.log.debug({ socketId: socket.id, userId: session.user.id }, 'handshake accepted');
  return null;
}
