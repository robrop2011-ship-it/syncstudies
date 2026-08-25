/**
 * Load test against the §15.5 targets.
 *
 *   cd apps/realtime
 *   npx tsx --env-file=.env scripts/load-test.mjs [--sockets 500] [--rooms 60] [--seconds 60]
 *
 * Runs against a realtime service that is already up (the dev one is fine), with
 * real Postgres and real Redis behind it. It measures four of the five §15.5
 * scenarios; the fifth — a rolling deploy under load — needs two machines and
 * belongs to Phase 10.
 *
 * What it reports, and why each number is the one that matters:
 *
 *  - **Event-loop lag p99** on the server, read from `/metrics`. This is the
 *    canary: a Node process that is behind on its event loop is one where every
 *    latency number is about to get worse at once.
 *  - **Broadcast p95** — send-to-receive across two different sockets. Not ack
 *    latency, which only proves the server heard you.
 *  - **Lua transact p99**, from the server's own histogram. Video control is the
 *    one hot path that takes a lock.
 *  - **Capacity under a thundering herd.** 200 simultaneous joins to a room with
 *    a cap must admit exactly the cap. Check-then-add in two commands admits far
 *    more, and it is invisible until it is a support ticket.
 *
 * Users and rooms are created directly through Prisma and deleted at the end, so
 * a run leaves nothing behind but metrics.
 */
import { createSession, hashPassword, SESSION_COOKIE } from '@syncstudy/auth';
import { prisma } from '@syncstudy/db';
import { uuidv7 } from '@syncstudy/shared';
import { io } from 'socket.io-client';

const RT = process.env.RT_URL ?? 'http://localhost:4000';
const ORIGIN = process.env.ORIGIN ?? 'http://localhost:3000';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : Number(process.argv[index + 1]);
}

const SOCKETS = arg('sockets', 500);
const ROOMS = arg('rooms', 60);
const SECONDS = arg('seconds', 60);
/** §15.5: 50 messages/sec sustained across all rooms. */
const MESSAGES_PER_SEC = arg('mps', 50);
const HERD = arg('herd', 200);
const HERD_CAP = 12;

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const roomCode = () =>
  Array.from({ length: 8 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function percentile(values, p) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

/**
 * Read one histogram out of the Prometheus text exposition.
 *
 * Returns the mean and a bucket-resolution p50/p95/p99. Bucket resolution is
 * coarse by construction — a p99 reported as "10" means "somewhere between 5 and
 * 10" — so all three are printed rather than one, because one number from a
 * nine-bucket histogram is easy to misread as precision.
 */
async function serverHistogram(name) {
  const text = await fetch(`${RT}/metrics`).then((r) => r.text());
  const buckets = [];
  let sum = 0;
  let count = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith(`${name}_bucket`)) {
      const le = /le="([^"]+)"/.exec(line)?.[1];
      const value = Number(line.split(' ').pop());
      if (le !== undefined) buckets.push([le === '+Inf' ? Infinity : Number(le), value]);
    } else if (line.startsWith(`${name}_sum`)) sum = Number(line.split(' ').pop());
    else if (line.startsWith(`${name}_count`)) count = Number(line.split(' ').pop());
  }
  if (count === 0) return { count: 0, mean: NaN, p50: NaN, p95: NaN, p99: NaN };
  const at = (q) => buckets.find(([, cumulative]) => cumulative >= q * count)?.[0] ?? Infinity;
  return { count, mean: sum / count, p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

async function serverGauge(name) {
  const text = await fetch(`${RT}/metrics`).then((r) => r.text());
  for (const line of text.split('\n')) {
    if (line.startsWith(`${name} `)) return Number(line.split(' ').pop());
  }
  return NaN;
}

const createdUsers = [];
const createdRooms = [];
const sockets = [];

async function makeUser(i) {
  const id = uuidv7();
  await prisma.user.create({
    data: {
      id,
      handle: `load_${id.slice(-10)}`.toLowerCase().slice(0, 20),
      displayName: `Load ${i}`,
      passwordHash: await hashPassword('load-test-password'),
    },
  });
  createdUsers.push(id);
  const { token } = await createSession(id, {});
  return { id, cookie: `${SESSION_COOKIE}=${token}` };
}

async function makeRoom(hostId, maxParticipants) {
  const id = uuidv7();
  const code = roomCode();
  await prisma.room.create({
    data: { id, code, name: 'Load room', hostId, maxParticipants },
  });
  createdRooms.push(id);
  return { id, code };
}

function connect(cookie) {
  const socket = io(RT, {
    transports: ['websocket'],
    withCredentials: false,
    extraHeaders: { cookie, origin: ORIGIN },
    reconnection: false,
  });
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connect timeout')), 20_000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function emit(socket, event, payload) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, code: 'timeout' }), 15_000);
    socket.emit(event, payload, (ack) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });
}

const results = [];
function report(scenario, target, measured, pass) {
  results.push({ scenario, target, measured, pass });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${scenario}\n         target ${target}\n         actual ${measured}`);
}

async function main() {
  console.log(`load test → ${RT}`);
  console.log(`${SOCKETS} sockets across ${ROOMS} rooms, ${SECONDS}s, ${MESSAGES_PER_SEC} msg/s\n`);

  // ── scenario 4 first: the thundering herd, on its own room ───────────────
  console.log('capacity under a thundering herd');
  const herdHost = await makeUser('herd-host');
  const herdRoom = await makeRoom(herdHost.id, HERD_CAP);
  const herdUsers = [];
  for (let i = 0; i < HERD; i += 1) herdUsers.push(await makeUser(`herd-${i}`));
  const herdSockets = await Promise.all(herdUsers.map((u) => connect(u.cookie)));
  const herdAcks = await Promise.all(
    herdSockets.map((s) => emit(s, 'room:join', { roomCode: herdRoom.code })),
  );
  const admitted = herdAcks.filter((a) => a.ok === true).length;
  report(
    `${HERD} simultaneous joins to a room capped at ${HERD_CAP}`,
    `exactly ${HERD_CAP} admitted`,
    `${admitted} admitted`,
    admitted === HERD_CAP,
  );
  for (const s of herdSockets) s.disconnect();
  await sleep(500);

  // ── the sustained run ────────────────────────────────────────────────────
  console.log('\nramping up');
  const hosts = [];
  const rooms = [];
  for (let r = 0; r < ROOMS; r += 1) {
    const host = await makeUser(`host-${r}`);
    hosts.push(host);
    rooms.push(await makeRoom(host.id, Math.ceil(SOCKETS / ROOMS) + 4));
  }

  // The room's OWN host has to be connected, not just members: `video:set` and
  // `video:control` need `video.set` permission, and without a host socket every
  // video operation is refused — which is how an earlier version of this script
  // reported "0 Lua transact calls" while looking like it was exercising them.
  const hostSockets = [];
  for (let r = 0; r < ROOMS; r += 1) {
    const socket = await connect(hosts[r].cookie);
    await emit(socket, 'room:join', { roomCode: rooms[r].code });
    hostSockets.push(socket);
  }

  const members = [];
  for (let i = 0; i < SOCKETS; i += 1) members.push(await makeUser(i));

  const joined = [];
  // Connect in waves: 500 TLS handshakes at once measures the OS, not the app.
  for (let i = 0; i < members.length; i += 50) {
    const wave = members.slice(i, i + 50);
    const opened = await Promise.all(wave.map((u) => connect(u.cookie).catch(() => null)));
    await Promise.all(
      opened.map(async (socket, k) => {
        if (socket === null) return;
        const room = rooms[(i + k) % ROOMS];
        const ack = await emit(socket, 'room:join', { roomCode: room.code });
        if (ack.ok) joined.push({ socket, roomIndex: (i + k) % ROOMS });
      }),
    );
    process.stdout.write(`\r  ${joined.length}/${SOCKETS} joined`);
  }
  console.log('');
  report(
    `${SOCKETS} concurrent sockets across ${ROOMS} rooms`,
    'all admitted',
    `${joined.length} joined`,
    joined.length >= SOCKETS * 0.99,
  );

  // Broadcast latency: one listener per room, timestamped at send and receive.
  const listeners = new Map();
  for (const entry of joined) {
    if (!listeners.has(entry.roomIndex)) listeners.set(entry.roomIndex, entry.socket);
  }
  const latencies = [];
  const inFlight = new Map();
  for (const [, socket] of listeners) {
    socket.on('chat:message', ({ message }) => {
      const sentAt = inFlight.get(message.clientMsgId);
      if (sentAt !== undefined) {
        latencies.push(Date.now() - sentAt);
        inFlight.delete(message.clientMsgId);
      }
    });
  }

  console.log(`\nsustaining ${MESSAGES_PER_SEC} msg/s and 1 control per room per 10s for ${SECONDS}s`);
  const senders = joined.filter((e) => !listeners.has(e.roomIndex) || listeners.get(e.roomIndex) !== e.socket);
  let sent = 0;
  let refused = 0;
  let controls = 0;
  let controlsRefused = 0;

  // Video is set once per room so `video:control` has something to act on.
  let videoSetRefused = 0;
  for (let r = 0; r < ROOMS; r += 1) {
    const ack = await emit(hostSockets[r], 'video:set', {
      provider: 'youtube',
      videoRef: 'fNk_zzaMoSs',
      durationSec: 592,
    });
    if (!ack.ok) videoSetRefused += 1;
  }
  if (videoSetRefused > 0) {
    console.log(`  warning: ${videoSetRefused}/${ROOMS} video:set calls were refused`);
  }

  const started = Date.now();
  let tick = 0;
  while (Date.now() - started < SECONDS * 1000) {
    tick += 1;
    const batch = [];
    for (let i = 0; i < MESSAGES_PER_SEC; i += 1) {
      const entry = senders[(tick * MESSAGES_PER_SEC + i) % senders.length];
      if (entry === undefined) continue;
      const clientMsgId = `load-${tick}-${i}`;
      inFlight.set(clientMsgId, Date.now());
      batch.push(
        emit(entry.socket, 'chat:send', { clientMsgId, body: `load ${tick}.${i}` }).then((ack) => {
          if (ack.ok) sent += 1;
          else refused += 1;
        }),
      );
    }
    // One control per room every 10 seconds, from that room's host.
    if (tick % 10 === 0) {
      for (let r = 0; r < ROOMS; r += 1) {
        batch.push(
          emit(hostSockets[r], 'video:control', {
            action: 'seek',
            positionSec: (tick % 500) + 1,
            clientSentAtMs: Date.now(),
            // -1 skips the revision check: this is a load generator, not a
            // conflict test, and the conflict path has its own coverage.
            expectedRevision: -1,
          }).then((ack) => {
            if (!ack.ok) controlsRefused += 1;
            else controls += 1;
          }),
        );
      }
    }
    await Promise.all(batch);
    const elapsed = Date.now() - started;
    process.stdout.write(`\r  ${Math.round(elapsed / 1000)}s · sent ${sent} · refused ${refused}`);
    await sleep(Math.max(0, tick * 1000 - elapsed));
  }
  console.log('');

  await sleep(1_000);

  // ── the numbers ──────────────────────────────────────────────────────────
  console.log('\nmeasurements');
  const lagMs = (await serverGauge('nodejs_eventloop_lag_p99_seconds')) * 1000;
  report(
    'event-loop lag p99',
    '< 50 ms',
    `${lagMs.toFixed(1)} ms`,
    !Number.isNaN(lagMs) && lagMs < 50,
  );

  const rss = (await serverGauge('process_resident_memory_bytes')) / (1024 * 1024);
  report('resident memory', '< 700 MB', `${rss.toFixed(0)} MB`, rss < 700);

  const p95 = percentile(latencies, 95);
  report(
    'broadcast p95 (send → another socket receives)',
    '< 80 ms',
    `${p95} ms over ${latencies.length} samples`,
    latencies.length > 0 && p95 < 80,
  );
  report('messages refused', 'zero dropped', `${refused} refused of ${sent + refused}`, refused === 0);

  report(
    'video controls accepted',
    'all accepted',
    `${controls} accepted, ${controlsRefused} refused`,
    controls > 0 && controlsRefused === 0,
  );

  const transact = await serverHistogram('ss_redis_transact_ms');
  report(
    'Lua transact p99',
    '< 3 ms',
    `p99 ≤${transact.p99} ms · p95 ≤${transact.p95} ms · mean ${transact.mean.toFixed(2)} ms · ${transact.count} calls`,
    transact.count > 0 && transact.p99 <= 3,
  );
  if (transact.count > 0 && transact.p99 > 3 && transact.p95 <= 5) {
    // Worth saying rather than leaving as a bare FAIL: on a laptop that is also
    // running Postgres, Redis, a dev server AND the load generator, the tail of
    // this histogram is scheduling contention on the box. The number to act on
    // is one measured with the generator on a different machine.
    console.log(
      '         note   p50/p95 are healthy; a p99 tail on a box that is also' +
        ' generating the load measures the box. Re-run from a separate machine' +
        ' before treating this as a regression.',
    );
  }

  const failures = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failures.length}/${results.length} targets met`);
  return failures.length;
}

main()
  .then(async (failures) => {
    for (const socket of sockets) socket.disconnect();
    await prisma.room.deleteMany({ where: { id: { in: createdRooms } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: createdUsers } } }).catch(() => undefined);
    await prisma.$disconnect();
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (err) => {
    console.error('\nload test failed:', err);
    for (const socket of sockets) socket.disconnect();
    await prisma.room.deleteMany({ where: { id: { in: createdRooms } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: createdUsers } } }).catch(() => undefined);
    await prisma.$disconnect();
    process.exit(1);
  });
