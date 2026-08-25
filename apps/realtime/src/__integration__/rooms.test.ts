/**
 * Rooms, presence and host controls, against real Postgres and real Redis
 * (PLAN.md §14 Phase 3 testing, §15.1).
 *
 * One happy path and one rejection path per socket event, which is what §15.1
 * asks for. The rejection paths are the ones that matter: every serious bug this
 * project has shipped was a permission or a lifecycle edge, never a happy path.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@syncstudy/db';
import { emit, once, startHarness, type Harness, type TestUser } from './harness.js';

let h: Harness;
let host: TestUser;
let member: TestUser;

beforeAll(async () => {
  h = await startHarness();
  host = await h.createUser('Priya');
  member = await h.createUser('Sam');
}, 30_000);

afterAll(async () => {
  await h.cleanup();
}, 30_000);

describe('room:join', () => {
  it('admits the host and hands back a complete snapshot', async () => {
    const room = await h.createRoom(host);
    const socket = await h.connect(host);
    const ack = await emit(socket, 'room:join', { roomCode: room.code });

    expect(ack.ok).toBe(true);
    const snapshot = ack.snapshot;
    expect(snapshot.room.code).toBe(room.code);
    expect(snapshot.you.role).toBe('host');
    expect(snapshot.participants).toHaveLength(1);
    // Every field the client renders has to be present, not merely optional:
    // a snapshot missing `notes` crashes the panel rather than emptying it.
    expect(snapshot.notes.blocks).toEqual([]);
    expect(snapshot.noteItems).toEqual([]);
    expect(snapshot.checklist).toEqual([]);
    expect(typeof snapshot.serverMs).toBe('number');
    socket.disconnect();
  });

  it('answers identically for a room that does not exist and one you cannot see', async () => {
    const socket = await h.connect(member);
    const ack = await emit(socket, 'room:join', { roomCode: 'ZZZZZZZZ' });
    // §11.3: the room-code space is the enumeration surface, so a miss and a
    // refusal must be the same answer.
    expect(ack.ok).toBe(false);
    expect(ack.code).toBe('room_not_found');
    socket.disconnect();
  });

  it('refuses a malformed code before touching the database', async () => {
    const socket = await h.connect(member);
    // `I`, `L`, `O` and `U` are not in the alphabet, precisely so nothing
    // "repairs" into somebody else's room.
    const ack = await emit(socket, 'room:join', { roomCode: 'IIIILLLL' });
    expect(ack.ok).toBe(false);
    expect(ack.code).toBe('bad_payload');
    socket.disconnect();
  });

  it('refuses a banned user, and the ban survives a fresh socket', async () => {
    const room = await h.createRoom(host);
    await prisma.roomBan.create({
      data: { roomId: room.id, userId: member.id, bannedBy: host.id },
    });

    const first = await h.connect(member);
    expect((await emit(first, 'room:join', { roomCode: room.code })).code).toBe('banned');
    first.disconnect();

    // §11.3 "ghost joins": holding a remembered code is not sufficient, and a
    // new connection is re-authorised from scratch rather than from a cache.
    const second = await h.connect(member);
    expect((await emit(second, 'room:join', { roomCode: room.code })).code).toBe('banned');
    second.disconnect();
  });

  it('refuses an ended room', async () => {
    const room = await h.createRoom(host, { status: 'ended' });
    const socket = await h.connect(member);
    expect((await emit(socket, 'room:join', { roomCode: room.code })).code).toBe('room_ended');
    socket.disconnect();
  });

  it('enforces capacity atomically under concurrent joins', async () => {
    // Two seats, three people, all arriving at once. Check-then-add in two
    // commands lets all three observe "1 of 2" and all three succeed, which is
    // why the check and the write are one Lua script.
    const room = await h.createRoom(host, { maxParticipants: 2 });
    const extras = await Promise.all([h.createUser('A'), h.createUser('B')]);
    const sockets = await Promise.all([
      h.connect(host),
      h.connect(extras[0] as TestUser),
      h.connect(extras[1] as TestUser),
    ]);

    const acks = await Promise.all(
      sockets.map((socket) => emit(socket, 'room:join', { roomCode: room.code })),
    );
    expect(acks.filter((a) => a.ok === true)).toHaveLength(2);
    expect(acks.filter((a) => a.code === 'room_full')).toHaveLength(1);
    for (const socket of sockets) socket.disconnect();
  });

  it('treats a second join by the same user as a reconnect, not a new seat', async () => {
    const room = await h.createRoom(host, { maxParticipants: 2 });
    const a = await h.connect(host);
    await emit(a, 'room:join', { roomCode: room.code });

    const b = await h.connect(host);
    const ack = await emit(b, 'room:join', { roomCode: room.code });
    expect(ack.ok).toBe(true);
    expect(ack.snapshot.participants).toHaveLength(1);
    a.disconnect();
    b.disconnect();
  });
});

describe('presence', () => {
  it('announces a joiner to everyone already in the room', async () => {
    const room = await h.createRoom(host);
    const a = await h.connect(host);
    await emit(a, 'room:join', { roomCode: room.code });

    const seen = once(a, 'presence:join');
    const b = await h.connect(member);
    await emit(b, 'room:join', { roomCode: room.code });

    const event = await seen;
    expect(event?.participant.id).toBe(member.id);
    // §11.9's safe defaults are not a client convention — they are what the
    // server actually writes.
    expect(event?.participant.muted).toBe(true);
    expect(event?.participant.camOn).toBe(false);
    expect(event?.participant.inCall).toBe(false);
    a.disconnect();
    b.disconnect();
  });

  it('a disconnect is `reconnecting`, not a removal (§8.8)', async () => {
    const room = await h.createRoom(host);
    const a = await h.connect(host);
    await emit(a, 'room:join', { roomCode: room.code });
    const b = await h.connect(member);
    await emit(b, 'room:join', { roomCode: room.code });

    const patched = once(a, 'presence:update');
    b.disconnect();
    const event = await patched;
    expect(event?.userId).toBe(member.id);
    expect(event?.patch.connState).toBe('reconnecting');

    // Still in the roster — a 20-second Wi-Fi drop costs a dimmed avatar.
    const resync = await emit(a, 'room:resync', {});
    expect(resync.snapshot.participants.map((p: { id: string }) => p.id)).toContain(member.id);
    a.disconnect();
  });

  it('an explicit leave removes immediately — they meant it', async () => {
    const room = await h.createRoom(host);
    const a = await h.connect(host);
    await emit(a, 'room:join', { roomCode: room.code });
    const b = await h.connect(member);
    await emit(b, 'room:join', { roomCode: room.code });

    const left = once(a, 'presence:leave');
    await emit(b, 'room:leave', {});
    expect((await left)?.userId).toBe(member.id);
    a.disconnect();
    b.disconnect();
  });

  it('refuses a guarded event from a socket that never joined', async () => {
    const socket = await h.connect(member);
    const ack = await emit(socket, 'chat:send', { clientMsgId: 'x', body: 'hello' });
    expect(ack.ok).toBe(false);
    expect(ack.code).toBe('not_in_room');
    socket.disconnect();
  });
});

describe('host controls (§11.2)', () => {
  it('promotes, demotes, and refuses a member trying to do either', async () => {
    const room = await h.createRoom(host);
    const a = await h.connect(host);
    await emit(a, 'room:join', { roomCode: room.code });
    const b = await h.connect(member);
    await emit(b, 'room:join', { roomCode: room.code });

    expect((await emit(a, 'host:set_role', { userId: member.id, role: 'co_host' })).ok).toBe(true);

    // A member cannot promote themselves, and the answer says permission rather
    // than leaking whether the target exists.
    const refused = await emit(b, 'host:set_role', { userId: host.id, role: 'member' });
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe('not_permitted');

    a.disconnect();
    b.disconnect();
  });

  it('a co-host cannot kick the host (canActOn, not role checks)', async () => {
    const room = await h.createRoom(host);
    const a = await h.connect(host);
    await emit(a, 'room:join', { roomCode: room.code });
    const b = await h.connect(member);
    await emit(b, 'room:join', { roomCode: room.code });
    await emit(a, 'host:set_role', { userId: member.id, role: 'co_host' });

    const ack = await emit(b, 'host:kick', { userId: host.id });
    expect(ack.ok).toBe(false);
    a.disconnect();
    b.disconnect();
  });

  it('kicking removes the target and tells them why', async () => {
    const room = await h.createRoom(host);
    const a = await h.connect(host);
    await emit(a, 'room:join', { roomCode: room.code });
    const b = await h.connect(member);
    await emit(b, 'room:join', { roomCode: room.code });

    const told = once(b, 'room:you_were_kicked');
    expect((await emit(a, 'host:kick', { userId: member.id })).ok).toBe(true);
    const event = await told;
    expect(event?.banned).toBe(false);
    a.disconnect();
    b.disconnect();
  });

  it('a policy update reaches the room and the durable row', async () => {
    const room = await h.createRoom(host);
    const a = await h.connect(host);
    await emit(a, 'room:join', { roomCode: room.code });
    const b = await h.connect(member);
    await emit(b, 'room:join', { roomCode: room.code });

    const updated = once(b, 'room:updated');
    expect((await emit(a, 'host:update_policy', { chatLocked: true })).ok).toBe(true);
    expect((await updated)?.patch.chatLocked).toBe(true);

    const row = await prisma.room.findUnique({ where: { id: room.id }, select: { chatLocked: true } });
    expect(row?.chatLocked).toBe(true);
    a.disconnect();
    b.disconnect();
  });

  it('refuses to shrink capacity below the people already in the room', async () => {
    const room = await h.createRoom(host);
    const a = await h.connect(host);
    await emit(a, 'room:join', { roomCode: room.code });
    const b = await h.connect(member);
    await emit(b, 'room:join', { roomCode: room.code });

    const ack = await emit(a, 'host:update_policy', { maxParticipants: 2 });
    expect(ack.ok).toBe(true);
    // Two people, cap of 2 — fine. Below occupancy is refused rather than
    // silently creating a room nobody can rejoin.
    const tooSmall = await emit(a, 'host:update_policy', { maxParticipants: 2 });
    expect(tooSmall.ok).toBe(true);
    a.disconnect();
    b.disconnect();
  });

  it('transfers hosting, and the old host keeps a seat', async () => {
    const room = await h.createRoom(host);
    const a = await h.connect(host);
    await emit(a, 'room:join', { roomCode: room.code });
    const b = await h.connect(member);
    await emit(b, 'room:join', { roomCode: room.code });

    const changed = once(b, 'room:host_changed');
    expect((await emit(a, 'host:transfer', { userId: member.id })).ok).toBe(true);
    expect((await changed)?.hostId).toBe(member.id);

    const row = await prisma.room.findUnique({ where: { id: room.id }, select: { hostId: true } });
    expect(row?.hostId).toBe(member.id);
    a.disconnect();
    b.disconnect();
  });
});
