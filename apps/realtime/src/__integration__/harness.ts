/**
 * The integration harness (PLAN.md §15.1).
 *
 * Boots the real server against real Postgres and real Redis on an ephemeral
 * port, and hands out authenticated socket clients. Nothing here is a mock: the
 * whole point of this layer is that every bug the project has actually shipped
 * — the room-code oracle, the stale room cache, the ghost memberships, the two
 * chat read-after-write races — typechecked perfectly and was only ever visible
 * against a running stack.
 *
 * Sessions are minted with `@syncstudy/auth` directly rather than by logging in
 * over HTTP, so these suites do not need the web app running. That also dodges
 * the in-process login rate limiter, which locks you out after five scripted
 * logins.
 */
import { randomUUID } from 'node:crypto';
import { createSession, hashPassword, SESSION_COOKIE } from '@syncstudy/auth';
import { prisma } from '@syncstudy/db';
import { uuidv7, type ClientToServerEvents, type ServerToClientEvents } from '@syncstudy/shared';
import { io as connectIo, type Socket } from 'socket.io-client';
import { loadConfig } from '../config.js';
import { createServer, type RealtimeServer } from '../server.js';

export type TestSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export interface TestUser {
  id: string;
  handle: string;
  displayName: string;
  cookie: string;
}

const ORIGIN = 'http://localhost:3000';

export interface Harness {
  server: RealtimeServer;
  port: number;
  /** Every socket handed out, so a suite cannot leak one into the next. */
  sockets: TestSocket[];
  createUser(prefix: string): Promise<TestUser>;
  createRoom(host: TestUser, overrides?: Record<string, unknown>): Promise<{ id: string; code: string }>;
  connect(user: TestUser): Promise<TestSocket>;
  cleanup(): Promise<void>;
}

/**
 * Crockford base32 minus I, L, O and U — the same alphabet the room-code
 * generator uses, so a code minted here is one the parser will accept.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

function roomCode(): string {
  let out = '';
  for (let i = 0; i < 8; i += 1) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

export async function startHarness(): Promise<Harness> {
  const config = loadConfig({
    ...process.env,
    ALLOWED_ORIGINS: ORIGIN,
    NODE_ID: `test-${randomUUID().slice(0, 8)}`,
    LOG_LEVEL: process.env['TEST_LOG_LEVEL'] ?? 'silent',
    IP_HASH_SALT: process.env['IP_HASH_SALT'] ?? 'integration-test-ip-hash-salt',
  });

  const server = createServer(config);
  // Port 0 asks the OS for a free one, so a suite can run beside a dev server.
  const port = await server.listen(0);

  const createdUsers: string[] = [];
  const createdRooms: string[] = [];
  const sockets: TestSocket[] = [];

  const harness: Harness = {
    server,
    port,
    sockets,

    async createUser(prefix) {
      const id = uuidv7();
      const handle = `${prefix}_${id.slice(-8)}`.toLowerCase().slice(0, 20);
      await prisma.user.create({
        data: {
          id,
          handle,
          displayName: prefix,
          passwordHash: await hashPassword('integration-test-password'),
        },
      });
      createdUsers.push(id);
      const { token } = await createSession(id, {});
      return { id, handle, displayName: prefix, cookie: `${SESSION_COOKIE}=${token}` };
    },

    async createRoom(host, overrides = {}) {
      const id = uuidv7();
      const code = roomCode();
      await prisma.room.create({
        data: { id, code, name: 'Integration room', hostId: host.id, ...overrides },
      });
      createdRooms.push(id);
      return { id, code };
    },

    connect(user) {
      // `withCredentials: false` is required: socket.io-client in Node drops a
      // Cookie set through `extraHeaders` when it is true.
      const socket: TestSocket = connectIo(`http://127.0.0.1:${port}`, {
        transports: ['websocket'],
        withCredentials: false,
        extraHeaders: { cookie: user.cookie, origin: ORIGIN },
        reconnection: false,
      });
      sockets.push(socket);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('socket connect timed out')), 8_000);
        socket.once('connect', () => {
          clearTimeout(timer);
          resolve(socket);
        });
        socket.once('connect_error', (err) => {
          clearTimeout(timer);
          reject(new Error(`handshake refused: ${err.message}`));
        });
      });
    },

    async cleanup() {
      for (const socket of sockets) socket.disconnect();
      sockets.length = 0;
      await server.shutdown('test').catch(() => undefined);
      // Rooms cascade to participants, messages, notes and bans; users cascade
      // to sessions. Ordered so a room's host still exists when it is deleted.
      await prisma.room.deleteMany({ where: { id: { in: createdRooms } } }).catch(() => undefined);
      await prisma.user.deleteMany({ where: { id: { in: createdUsers } } }).catch(() => undefined);
    },
  };

  return harness;
}

/** Emit and await the ack, with a deadline so a missing ack fails rather than hangs. */
export function emit<E extends keyof ClientToServerEvents>(
  socket: TestSocket,
  event: E,
  payload: unknown,
): Promise<any> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, code: 'timeout' }), 8_000);
    (socket as unknown as { emit: (e: string, p: unknown, cb: (r: unknown) => void) => void }).emit(
      event as string,
      payload,
      (result: unknown) => {
        clearTimeout(timer);
        resolve(result);
      },
    );
  });
}

/**
 * The listener half of a socket, untyped.
 *
 * `socket.on` is generic over the declared event map, which is exactly what you
 * want in application code and exactly what you do not want in a harness whose
 * whole job is to take an event name as a string. Narrowed here, once, rather
 * than with a cast at every call site.
 */
type Listenable = {
  on: (event: string, cb: (payload: unknown) => void) => void;
  off: (event: string, cb: (payload: unknown) => void) => void;
};

/** Wait for one event, or null after `ms`. Never sleeps *before* an assertion. */
export function once<T = any>(socket: TestSocket, event: string, ms = 3_000): Promise<T | null> {
  const bus = socket as unknown as Listenable;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      bus.off(event, handler);
      resolve(null);
    }, ms);
    const handler = (payload: unknown): void => {
      clearTimeout(timer);
      bus.off(event, handler);
      resolve(payload as T);
    };
    bus.on(event, handler);
  });
}

/** Collect every event of a kind for `ms` — for convergence assertions. */
export function collect<T = any>(socket: TestSocket, event: string, ms: number): Promise<T[]> {
  const bus = socket as unknown as Listenable;
  const seen: T[] = [];
  const handler = (payload: unknown): void => {
    seen.push(payload as T);
  };
  bus.on(event, handler);
  return new Promise((resolve) =>
    setTimeout(() => {
      bus.off(event, handler);
      resolve(seen);
    }, ms),
  );
}
