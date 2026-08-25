/**
 * The realtime service, as a factory (PLAN.md §6.1, §11.4, §16.3, §16.5).
 *
 * Everything that used to be top-level in `index.ts` lives here, behind
 * `createServer(config)`. The reason is testing: §15.1 wants socket handlers
 * exercised end to end against real Postgres and Redis, and a module that starts
 * listening as a side effect of being imported cannot be started twice, cannot
 * be given an ephemeral port, and cannot be shut down between suites.
 *
 * `index.ts` is now the boot script — parse the environment, start this, wire
 * the signal handlers — and nothing else.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { prisma } from '@syncstudy/db';
import type { VideoAnchor } from '@syncstudy/shared';

import type { Config } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { createRedisClients, pingRedis, type RedisClients } from './redis.js';
import { renderMetrics, socketConnections, roomsActive } from './metrics.js';
import { RedisRoomStore } from './rooms/RoomStore.js';
import { RoomMetaCache, pingDb } from './rooms/roomData.js';
import { LeaderElection } from './rooms/leader.js';
import { RoomTicker } from './rooms/snapshotter.js';
import { RoomBus } from './rooms/bus.js';
import { TokenBucket } from './ratelimit/tokenBucket.js';
import { createHandshakeMiddleware } from './auth/handshake.js';
import { registerAllHandlers, createBusHandlers } from './handlers/index.js';
import { ChatService } from './chat/service.js';
import { NotesService } from './notes/service.js';
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

export const VERSION = '0.1.0';

export interface RealtimeServer {
  app: FastifyInstance;
  io: TypedServer;
  ctx: AppContext;
  redis: RedisClients;
  log: Logger;
  /**
   * Resolves with the port actually bound.
   *
   * `port` overrides the configured one; tests pass 0 to have the OS pick a
   * free one. It is a parameter rather than a config value on purpose — PORT=0
   * in a production environment is a machine that binds somewhere nobody can
   * find, so the schema keeps rejecting it.
   */
  listen(port?: number): Promise<number>;
  /** The §16.3 drain, in order. Safe to call twice. */
  shutdown(signal: string): Promise<void>;
}

export function createServer(config: Config): RealtimeServer {
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
    // Fastify's own request logging is off: `pino` is configured in logger.ts
    // and two loggers would double every line. `logger: false` already implies
    // it, so the deprecated top-level `disableRequestLogging` is not needed.
    logger: false,
    // Behind Fly's proxy; the client address comes from the forwarded headers.
    trustProxy: true,
  });

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

  const chat = new ChatService({ io, redis: redis.cmd, log });
  const notes = new NotesService({ redis: redis.cmd, log });

  const ctx: AppContext = {
    io,
    redis: redis.cmd,
    store,
    meta,
    leader,
    ticker,
    limiter,
    bus,
    chat,
    notes,
    log,
    config,
    grace,
  };

  grace.attach(ctx);

  app.get('/health', async (_request, reply) => {
    const [db, cache] = await Promise.all([pingDb(), pingRedis(redis.cmd)]);
    const ok = db && cache;
    // `pendingWrites` is deliberately not part of `ok`: a backed-up queue is a
    // reason to look, not a reason to take a node holding live sockets out of
    // rotation. `ss_write_behind_depth` is what alerts on it (§16.5).
    return reply.code(ok ? 200 : 503).send({
      ok,
      version: VERSION,
      db,
      redis: cache,
      pendingWrites: chat.pendingWrites + notes.pendingWrites,
    });
  });

  app.get('/metrics', async (_request, reply) => {
    const { contentType, body } = await renderMetrics();
    return reply.header('content-type', contentType).send(body);
  });

  io.use(
    createHandshakeMiddleware({
      redis: redis.cmd,
      log,
      limiter,
      allowedOrigins: config.ALLOWED_ORIGINS,
      ipHashSalt: config.IP_HASH_SALT,
      nodeId: config.NODE_ID,
      maxConnectionsPerIp: config.MAX_CONNECTIONS_PER_IP,
    }),
  );

  io.on('connection', (socket: TypedSocket) => {
    socketConnections.inc();
    log.debug({ socketId: socket.id, userId: socket.data.userId }, 'socket connected');
    registerAllHandlers(ctx, socket);
  });

  // Keep the room gauge honest even when nothing else touches it.
  const roomsGaugeTimer = setInterval(() => {
    roomsActive.set(countActiveRooms(io));
  }, 15_000);
  roomsGaugeTimer.unref();

  let shuttingDown = false;

  return {
    app,
    io,
    ctx,
    redis,
    log,

    async listen(portOverride?: number): Promise<number> {
      await app.ready();
      leader.start();
      await bus.start(createBusHandlers(ctx));
      const requested = portOverride ?? config.PORT;
      await app.listen({ port: requested, host: '0.0.0.0' });
      const address = app.server.address();
      const port = typeof address === 'object' && address !== null ? address.port : requested;
      log.info({ port, env: config.NODE_ENV }, 'realtime service listening');
      return port;
    },

    /**
     * Graceful shutdown (§16.3).
     *
     * A deploy must not drop 200 study sessions. Clients reconnect with a full
     * `room:resync` (§8.8), so a rolling deploy costs each user about a second
     * and no state — provided we flush before exiting, in this order.
     */
    async shutdown(signal: string): Promise<void> {
      if (shuttingDown) return;
      shuttingDown = true;
      log.info({ signal }, 'shutting down');
      clearInterval(roomsGaugeTimer);

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

      // 6. Land every chat message that has been broadcast but not yet written.
      //    This is the one step with no fallback: unlike video state, an
      //    unwritten message is not reconstructible from anywhere. It runs
      //    before Prisma disconnects.
      await chat.stop();
      // The notes document is reconstructible from Redis, so this is a
      // best-effort courtesy rather than the load-bearing flush above — but
      // "at most one debounce window" is a promise worth keeping across a deploy.
      await notes.stop();

      // 7. Close the HTTP server and the backing services.
      await bus.stop();
      await app.close();
      await Promise.all([prisma.$disconnect(), redis.quitAll()]);
      log.info('shutdown complete');
    },
  };
}
