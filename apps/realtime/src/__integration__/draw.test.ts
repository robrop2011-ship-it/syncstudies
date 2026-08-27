/**
 * The shared annotation layer — "ink".
 *
 * Ink has no ack and no storage, which removes both of the things the other
 * suites in this directory lean on: there is no return value to inspect and no
 * row to read back. What is left is the only thing that actually matters — who
 * receives a stroke, who does not, and the fact that a stroke leaves no trace
 * anywhere after the room has seen it.
 *
 * The refusal cases are asserted as "nothing arrived in a bounded window", which
 * is the one shape a fire-and-forget event allows. Every one of them is followed
 * by a positive control over the same sockets, so a silent window can never be
 * mistaken for a broken listener or a room nobody is in.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@syncstudy/db';
import { INK_MAX_POINTS_PER_MESSAGE, Schemas } from '@syncstudy/shared';
import { collect, emit, once, startHarness, type Harness, type TestSocket, type TestUser } from './harness.js';

let h: Harness;
let host: TestUser;
let member: TestUser;
let guest: TestUser;

interface Room {
  id: string;
  code: string;
  a: TestSocket;
  b: TestSocket;
}

async function room(overrides: Record<string, unknown> = {}): Promise<Room> {
  const created = await h.createRoom(host, overrides);
  const a = await h.connect(host);
  const b = await h.connect(member);
  await emit(a, 'room:join', { roomCode: created.code });
  await emit(b, 'room:join', { roomCode: created.code });
  return { ...created, a, b };
}

/**
 * A guest is a participant row with `role: 'guest'` written before the join —
 * `recordJoin` upserts and leaves an existing role alone, so the socket picks
 * this up as its live role exactly as a real guest's would be.
 */
async function connectGuest(roomId: string, code: string): Promise<TestSocket> {
  await prisma.roomParticipant.create({ data: { roomId, userId: guest.id, role: 'guest' } });
  const socket = await h.connect(guest);
  await emit(socket, 'room:join', { roomCode: code });
  return socket;
}

function stroke(points: { x: number; y: number }[], done = false): Schemas.DrawStroke {
  return { strokeId: randomUUID(), points, done };
}

beforeAll(async () => {
  h = await startHarness();
  host = await h.createUser('Priya');
  member = await h.createUser('Sam');
  guest = await h.createUser('Dev');
}, 30_000);

afterAll(async () => {
  await h.cleanup();
}, 30_000);

describe('draw:stroke', () => {
  it('reaches the room and never comes back to the person who drew it', async () => {
    const { a, b } = await room();
    const points = [
      { x: 0.25, y: 0.5 },
      { x: 0.2503, y: 0.51 },
    ];
    const sent = stroke(points);

    const seenByHost = once(a, 'draw:stroke');
    // Started before the emit, so an echo would be caught by the time the
    // legitimate delivery below has already landed on the other socket.
    const echoToSender = collect(b, 'draw:stroke', 400);
    b.emit('draw:stroke', sent);

    const relayed = await seenByHost;
    expect(relayed?.from).toBe(member.id);
    expect(relayed?.strokeId).toBe(sent.strokeId);
    expect(relayed?.points).toEqual(points);
    expect(relayed?.done).toBe(false);

    // The sender already drew this locally as their pointer moved. An echo
    // would render the same line twice and fight the one still growing.
    expect(await echoToSender).toEqual([]);
    a.disconnect();
    b.disconnect();
  });

  it('stamps server time, not whatever the client believed', async () => {
    const { a, b } = await room();
    const before = Date.now();
    const seen = once(a, 'draw:stroke');
    b.emit('draw:stroke', stroke([{ x: 0, y: 0 }], true));

    const relayed = await seen;
    expect(relayed?.serverMs).toBeGreaterThanOrEqual(before);
    expect(relayed?.serverMs).toBeLessThanOrEqual(Date.now());
    // Every client ages the stroke off this one number, so it must be the
    // server's clock and it must be present on every batch.
    expect(Number.isFinite(relayed?.serverMs)).toBe(true);
    a.disconnect();
    b.disconnect();
  });

  it('refuses a guest, who may watch the lecture but not write on it', async () => {
    const created = await room();
    const g = await connectGuest(created.id, created.code);

    const nothing = once(created.a, 'draw:stroke', 600);
    g.emit('draw:stroke', stroke([{ x: 0.5, y: 0.5 }]));
    expect(await nothing).toBeNull();

    // Positive control over the same sockets: the room and the listener are
    // live, so the silence above was the permission check and nothing else.
    const seen = once(created.a, 'draw:stroke');
    created.b.emit('draw:stroke', stroke([{ x: 0.5, y: 0.5 }]));
    expect((await seen)?.from).toBe(member.id);

    g.disconnect();
    created.a.disconnect();
    created.b.disconnect();
  });

  it('refuses everyone while the room has annotations switched off', async () => {
    const { a, b } = await room({ annotationsEnabled: false });

    const nothing = once(a, 'draw:stroke', 600);
    b.emit('draw:stroke', stroke([{ x: 0.5, y: 0.5 }]));
    expect(await nothing).toBeNull();

    // The host flips the switch; the same socket that was just refused draws
    // again and lands. Without this half, the assertion above would also pass
    // against a handler that had simply stopped working.
    expect((await emit(a, 'host:update_policy', { annotationsEnabled: true })).ok).toBe(true);
    const seen = once(a, 'draw:stroke');
    b.emit('draw:stroke', stroke([{ x: 0.5, y: 0.5 }]));
    expect((await seen)?.from).toBe(member.id);

    a.disconnect();
    b.disconnect();
  });

  it('rejects coordinates that are not on the stage', async () => {
    // Exact, at the schema: 0..1 on both axes is the whole contract, because a
    // coordinate outside the stage box cannot mean anything to a receiver.
    expect(Schemas.DrawStroke.safeParse(stroke([{ x: 1.4, y: 0.5 }])).success).toBe(false);
    expect(Schemas.DrawStroke.safeParse(stroke([{ x: 0.5, y: -0.01 }])).success).toBe(false);
    expect(Schemas.DrawStroke.safeParse(stroke([])).success).toBe(false);
    expect(
      Schemas.DrawStroke.safeParse(
        stroke(Array.from({ length: INK_MAX_POINTS_PER_MESSAGE + 1 }, () => ({ x: 0.5, y: 0.5 }))),
      ).success,
    ).toBe(false);
    expect(Schemas.DrawStroke.safeParse(stroke([{ x: 0, y: 1 }])).success).toBe(true);

    // And on the wire, so the guard is provably the thing doing the parsing.
    const { a, b } = await room();
    const nothing = once(a, 'draw:stroke', 600);
    b.emit('draw:stroke', stroke([{ x: 0.5, y: 0.5 }, { x: 2, y: 0.5 }]));
    expect(await nothing).toBeNull();

    const seen = once(a, 'draw:stroke');
    b.emit('draw:stroke', stroke([{ x: 0.5, y: 0.5 }]));
    expect((await seen)?.from).toBe(member.id);
    a.disconnect();
    b.disconnect();
  });
});

describe('draw:clear', () => {
  it('reaches everyone, the sender included', async () => {
    const { a, b } = await room();
    const seenByHost = once(a, 'draw:cleared');
    const seenBySender = once(b, 'draw:cleared');
    b.emit('draw:clear', {});

    // Unlike a stroke: clearing removes only the caller's own ink, so one path
    // runs on every client and the person who pressed it sees what the room sees.
    expect((await seenByHost)?.userId).toBe(member.id);
    expect((await seenBySender)?.userId).toBe(member.id);
    a.disconnect();
    b.disconnect();
  });

  it('still works after the host turns annotations off', async () => {
    const { a, b } = await room({ annotationsEnabled: false });
    const seen = once(a, 'draw:cleared');
    b.emit('draw:clear', {});
    // Taking your own ink back must not become impossible the moment drawing
    // does, or the last stroke before the toggle is stuck on the video.
    expect((await seen)?.userId).toBe(member.id);
    a.disconnect();
    b.disconnect();
  });
});

describe('ink is ephemeral', () => {
  /**
   * Every room-scoped table, counted. `rooms.last_active_at` is deliberately not
   * part of this: the leader's snapshotter bumps it on its own timer, and a test
   * that failed because a heartbeat ticked would be noise.
   */
  async function fingerprint(roomId: string): Promise<Record<string, unknown>> {
    const where = { where: { roomId } } as const;
    const [
      room,
      participants,
      bans,
      videoState,
      videoHistory,
      messages,
      notes,
      noteItems,
      checklist,
      sessions,
      reports,
      events,
    ] = await Promise.all([
      prisma.room.findUniqueOrThrow({
        where: { id: roomId },
        select: {
          name: true,
          topic: true,
          hostId: true,
          status: true,
          playbackControl: true,
          chatLocked: true,
          slowModeSec: true,
          waitForSlow: true,
          callEnabled: true,
          screenshareEnabled: true,
          annotationsEnabled: true,
          maxParticipants: true,
        },
      }),
      prisma.roomParticipant.count(where),
      prisma.roomBan.count(where),
      prisma.roomVideoState.count(where),
      prisma.roomVideoHistory.count(where),
      prisma.message.count(where),
      prisma.roomNotes.count(where),
      prisma.noteItem.count(where),
      prisma.checklistItem.count(where),
      prisma.studySession.count(where),
      prisma.report.count(where),
      prisma.roomEvent.count(where),
    ]);
    return {
      room,
      participants,
      bans,
      videoState,
      videoHistory,
      messages,
      notes,
      noteItems,
      checklist,
      sessions,
      reports,
      events,
    };
  }

  it('writes nothing to Postgres — not a row, not a column', async () => {
    const { id, a, b } = await room();
    const before = await fingerprint(id);

    // A whole gesture: several batches and the `done` that ends it, plus the
    // clear that follows, which is the shape most likely to tempt a snapshot.
    for (let i = 0; i < 8; i += 1) {
      b.emit('draw:stroke', stroke([{ x: i / 10, y: 0.5 }], i === 7));
    }
    const last = once(a, 'draw:cleared');
    b.emit('draw:clear', {});
    await last;

    // No sleep before this read: everything ink does has already happened by the
    // time the clear has been broadcast, and a write-behind window is exactly
    // the thing ink does not have.
    expect(await fingerprint(id)).toEqual(before);
    a.disconnect();
    b.disconnect();
  });

  it('keeps the handler free of any persistence import at all', () => {
    // The runtime check above proves this run stored nothing. This one keeps it
    // true later: the reflex when reading draw.ts is "where is this stored?",
    // and the answer has to stay "nowhere", including in Redis.
    const source = readFileSync(new URL('../handlers/draw.ts', import.meta.url), 'utf8');
    expect([...source.matchAll(/from '([^']+)'/g)].map((m) => m[1])).toEqual([
      '@syncstudy/shared',
      './context.js',
    ]);
    // `ctx` still carries Redis and the three services that own durable state,
    // so the import list alone is not enough — the body must not reach for them.
    expect(source).not.toMatch(/ctx\.(redis|store|chat|notes)\b/);
  });
});
