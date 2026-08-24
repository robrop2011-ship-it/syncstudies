/**
 * The realtime service entry point (PLAN.md §6.1, §11.4, §16.3, §16.5).
 *
 * Fastify serves exactly two HTTP routes — `/health` and `/metrics` — and its
 * underlying server carries the Socket.IO transport. Everything a user does
 * lives on the socket.
 */
import Fastify from 'fastify';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { prisma } from '@syncstudy/db';
import type { VideoAnchor } from '@syncstudy/shared';

import { loadConfig, type Config } from './config.js';
import { createLogger } from './logger.js';
import { createRedisClients, pingRedis } from './redis.js';
import { renderMetrics, socketConnections, roomsActive } from './metrics.js';
import { RedisRoomStore } from './rooms/RoomStore.js';
import { RoomMetaCache, pingDb } from './rooms/roomData.js';
import { LeaderElection } from './rooms/leader.js';
import { RoomTicker } from './rooms/snapshotter.js';
import { RoomBus } from './rooms/bus.js';
import { TokenBucket } from './ratelimit/tokenBucket.js';
import { createHandshakeMiddleware } from './auth/handshake.js';
import { registerAllHandlers, createBusHandlers } from './handlers/index.js';
import { GraceTimers, removeParticipantAndBroadcast } from './handlers/presence.js';
import {
  clearAllWaitForSlow,
  resumeAllWaitingRooms,
  stopWaitingAndResume,
} from './handlers/video.js';
import {
  countActiveRooms,
  roomChannel,
  type AppContext,
  type TypedServer,
  type TypedSocket,
} from './handlers/context.js';

const VERSION = '0.1.0';

// Fail fast, with a message a human can act on, before anything else starts.
// A node that boots without REDIS_URL and only finds out on the first join has
// already taken the outage; refusing to start fails the deploy instead.
function bootConfig(): Config {
  try {
    return loadConfig();
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

const config = bootConfig();

const log = createLogger({
  level: config.LOG_LEVEL,
  nodeId: config.NODE_ID,
  pretty: !config.isProduction,
});

const redis = createRedisClients(config.REDIS_URL);
const store = new RedisRoomStore(redis.cmd, log);
const meta = new RoomMetaCache(redis.cmd, log);
const limiter = new TokenBucket(redis.cmd, log);
const bus = new RoomBus(redis.cmd, redis.busSub, log);
const grace = new GraceTimers();

const app = Fastify({
  logger: false,
  // Behind Fly's proxy; the client address comes from the forwarded headers.
  trustProxy: true,
  disableRequestLogging: true,
});

app.get('/health', async (_request, reply) => {
  const [db, cache] = await Promise.all([pingDb(), pingRedis(redis.cmd)]);
  const ok = db && cache;
  return reply.code(ok ? 200 : 503).send({ ok, version: VERSION, db, redis: cache });
});

app.get('/metrics', async (_request, reply) => {
  const { contentType, body } = await renderMetrics();
  return reply.header('content-type', contentType).send(body);
});

await app.ready();

const io: TypedServer = new Server(app.server, {
  // WebSocket only: no long-polling means no session affinity requirement, so
  // `fly scale count N` needs no sticky sessions (§6.1).
  transports: ['websocket'],
  // The 1 MB default is a memory-DoS invitation for payloads this small (§11.4).
  maxHttpBufferSize: 128_000,
  // CPU cost outweighs the benefit at our payload sizes, and it has had CVEs.
  perMessageDeflate: false,
  pingInterval: 20_000,
  pingTimeout: 25_000,
  connectTimeout: 20_000,
  cors: { origin: config.ALLOWED_ORIGINS, credentials: true },
});

io.adapter(createAdapter(redis.pub, redis.sub));

const leader = new LeaderElection(redis.cmd, config.NODE_ID, log, {
  onAcquire: (roomId) => ticker.start(roomId),
  onRelease: (roomId) => {
    ticker.stop(roomId);
    // Only the leader may hold a wait_for_slow timer, so stepping down releases
    // it — but it must RESUME, not merely disarm. The cap timer is the sole
    // thing scheduled to press play, and the incoming leader has no idea this
    // room is being held paused. `force` because our lease is already gone.
    void stopWaitingAndResume(ctx, roomId, 'handover', { force: true });
  },
});

const ticker = new RoomTicker({
  store,
  leader,
  log,
  broadcastHeartbeat: (roomId: string, anchor: VideoAnchor, serverMs: number) => {
    // A heartbeat carries the anchor, never a position (§8.1 rule 2), so a
    // client that missed a control event converges without us tracking that.
    io.to(roomChannel(roomId)).emit('video:state', {
      anchor,
      actorId: null,
      reason: 'heartbeat',
      serverMs,
    });
  },
  onGraceExpired: async (roomId: string, userId: string) => {
    await removeParticipantAndBroadcast(ctx, roomId, userId, 'timeout');
  },
});

const ctx: AppContext = {
  io,
  redis: redis.cmd,
  store,
  meta,
  leader,
  ticker,
  limiter,
  bus,
  log,
  config,
  grace,
};

grace.attach(ctx);
leader.start();
await bus.start(createBusHandlers(ctx));

io.use(
  createHandshakeMiddleware({
    redis: redis.cmd,
    log,
    limiter,
    allowedOrigins: config.ALLOWED_ORIGINS,
    ipHashSalt: config.IP_HASH_SALT,
    nodeId: config.NODE_ID,
  }),
);

io.on('connection', (socket: TypedSocket) => {
  socketConnections.inc();
  log.debug({ socketId: socket.id, userId: socket.data.userId }, 'socket connected');
  registerAllHandlers(ctx, socket);
});

await app.listen({ port: config.PORT, host: '0.0.0.0' });
log.info({ port: config.PORT, env: config.NODE_ENV }, 'realtime service listening');

// ── graceful shutdown (PLAN.md §16.3) ───────────────────────────────────────
//
// A deploy must not drop 200 study sessions. Clients reconnect with a full
// `room:resync` (§8.8), so a rolling deploy costs each user about a second and
// no state — provided we flush before exiting, in this order.

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down');

  const hardExit = setTimeout(() => {
    log.error('graceful shutdown timed out; exiting');
    process.exit(1);
  }, 20_000);
  hardExit.unref();

  try {
    // 1. Stop accepting new connections.
    io.engine.close();

    // 2. Tell the clients that are here, so their UI shows "reconnecting"
    //    rather than an error.
    io.emit('sys:notice', {
      level: 'info',
      code: 'server_restarting',
      message: 'Reconnecting…',
    });

    // 3. Disconnect them; socket.io's client backoff lands them on a new machine.
    io.disconnectSockets(true);

    // 4. Flush video state for every room this node leads.
    grace.clearAll();
    // Put any room we are holding paused back into playback before we go, so a
    // deploy can't leave a session frozen with nobody left to resume it.
    await resumeAllWaitingRooms(ctx);
    clearAllWaitForSlow();
    ticker.stopAll();
    await ticker.snapshotAllLedRooms();

    // 5. Hand leadership over immediately instead of waiting out the TTLs.
    await leader.releaseAll();

    // 6. Close the HTTP server and the backing services.
    await bus.stop();
    await app.close();
    await Promise.all([prisma.$disconnect(), redis.quitAll()]);

    log.info('shutdown complete');
    clearTimeout(hardExit);
    process.exit(0);
  } catch (err) {
    log.error({ err }, 'shutdown failed');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  // Logged, not fatal: one dropped promise must not end 200 sessions.
  log.error({ err: reason }, 'unhandled promise rejection');
});

process.on('uncaughtException', (err) => {
  // The process state is no longer trustworthy. Log it, then let the platform
  // restart us — clients reconnect and resync.
  log.fatal({ err }, 'uncaught exception');
  void shutdown('uncaughtException');
});

// Keep the room gauge honest even when nothing else touches it.
const roomsGaugeTimer = setInterval(() => {
  roomsActive.set(countActiveRooms(io));
}, 15_000);
roomsGaugeTimer.unref();
