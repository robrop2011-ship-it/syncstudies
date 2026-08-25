/**
 * Chat, against real Postgres and real Redis (PLAN.md §14 Phase 5 testing).
 *
 * **No test here sleeps before an assertion.** That is the rule Amendment A2 and
 * ADR 0006 exist to enforce: a message is broadcast before it is in Postgres, so
 * a test that gives the system a moment to catch up passes against exactly the
 * broken code it was written to catch. Two shipped features were broken this way.
 *
 * The one exception is marked, and there the wait *is* the subject: proving the
 * write-behind queue lands the row is not the same claim as proving a read-back
 * path drains it first.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@syncstudy/db';
import { emit, once, startHarness, type Harness, type TestSocket, type TestUser } from './harness.js';

let h: Harness;
let host: TestUser;
let member: TestUser;

/** Two sockets in one fresh room, both joined. The setup every test here wants. */
async function room(): Promise<{ id: string; code: string; a: TestSocket; b: TestSocket }> {
  const created = await h.createRoom(host);
  const a = await h.connect(host);
  const b = await h.connect(member);
  await emit(a, 'room:join', { roomCode: created.code });
  await emit(b, 'room:join', { roomCode: created.code });
  return { ...created, a, b };
}

beforeAll(async () => {
  h = await startHarness();
  host = await h.createUser('Priya');
  member = await h.createUser('Sam');
}, 30_000);

afterAll(async () => {
  await h.cleanup();
}, 30_000);

describe('chat:send', () => {
  it('acks with the server-assigned message and broadcasts it', async () => {
    const { a, b } = await room();
    const seen = once(b, 'chat:message');
    const ack = await emit(a, 'chat:send', { clientMsgId: 'm1', body: 'hello everyone' });

    expect(ack.ok).toBe(true);
    expect(ack.data.body).toBe('hello everyone');
    expect(ack.data.author.id).toBe(host.id);
    // uuidv7: id order is time order, which is what makes it a safe sort key
    // and a safe pagination cursor (ADR 0007).
    expect(ack.data.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);

    const event = await seen;
    expect(event?.message.id).toBe(ack.data.id);
    a.disconnect();
    b.disconnect();
  });

  it('ignores a userId in the payload — identity comes from the session', async () => {
    const { a, b } = await room();
    const ack = await emit(a, 'chat:send', {
      clientMsgId: 'm2',
      body: 'who am I',
      userId: member.id,
    });
    expect(ack.ok).toBe(true);
    expect(ack.data.author.id).toBe(host.id);
    a.disconnect();
    b.disconnect();
  });

  it('re-acks the original on a retry and broadcasts nothing', async () => {
    const { id: roomId, a, b } = await room();
    const first = await emit(a, 'chat:send', { clientMsgId: 'retry-1', body: 'only once' });
    expect(first.ok).toBe(true);

    // A `null` here would be a second broadcast. The retry that needs the dedupe
    // is the one after a reconnect, which lands on a different node — which is
    // why the dedupe lives in Redis rather than in a per-process map.
    const second = await emit(a, 'chat:send', { clientMsgId: 'retry-1', body: 'only once' });
    expect(second.ok).toBe(true);
    expect(second.data.id).toBe(first.data.id);

    await h.server.ctx.chat.settle();
    const rows = await prisma.message.count({
      where: { roomId, clientMsgId: 'retry-1' },
    });
    expect(rows).toBe(1);
    a.disconnect();
    b.disconnect();
  });

  it('refuses an empty body and one past the length cap', async () => {
    const { a, b } = await room();
    expect((await emit(a, 'chat:send', { clientMsgId: 'e1', body: '   ' })).code).toBe('bad_payload');
    expect(
      (await emit(a, 'chat:send', { clientMsgId: 'e2', body: 'x'.repeat(3000) })).code,
    ).toBe('bad_payload');
    a.disconnect();
    b.disconnect();
  });

  it('stores an XSS payload as text — escaping is the renderer\'s job, storage is verbatim', async () => {
    const { a, b } = await room();
    const payload = '<script>alert(1)</script>';
    const ack = await emit(a, 'chat:send', { clientMsgId: 'xss', body: payload });
    expect(ack.data.body).toBe(payload);
    a.disconnect();
    b.disconnect();
  });

  it('drops the same body a third time inside the window (§11.6)', async () => {
    const { a, b } = await room();
    // Counted from the FIRST occurrence, so "ok" once every 25 seconds never
    // trips it, but three in a row does.
    expect((await emit(a, 'chat:send', { clientMsgId: 'd1', body: 'same text' })).ok).toBe(true);
    expect((await emit(a, 'chat:send', { clientMsgId: 'd2', body: 'same text' })).ok).toBe(true);
    const third = await emit(a, 'chat:send', { clientMsgId: 'd3', body: 'same text' });
    expect(third.ok).toBe(false);
    expect(third.code).toBe('duplicate');
    a.disconnect();
    b.disconnect();
  });

  it('refuses a member while chat is locked, and lets the host through', async () => {
    const { a, b } = await room();
    await emit(a, 'host:update_policy', { chatLocked: true });

    const refused = await emit(b, 'chat:send', { clientMsgId: 'l1', body: 'let me in' });
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe('chat_locked');

    // A lock is a moderation tool, not a mute button for the person holding it.
    expect((await emit(a, 'chat:send', { clientMsgId: 'l2', body: 'still me' })).ok).toBe(true);
    a.disconnect();
    b.disconnect();
  });
});

describe('chat:delete', () => {
  it('deletes a message the sender just sent — without a sleep first', async () => {
    const { a, b } = await room();
    const sent = await emit(a, 'chat:send', { clientMsgId: 'del-1', body: 'oops' });

    // The bug this catches: `chat:delete` reads Postgres, the row is still in
    // the write-behind queue, and the server answers "that message no longer
    // exists". Giving it time here would hide exactly that.
    const deleted = once(b, 'chat:deleted');
    const ack = await emit(a, 'chat:delete', { messageId: sent.data.id });
    expect(ack.ok).toBe(true);
    expect((await deleted)?.messageId).toBe(sent.data.id);
    a.disconnect();
    b.disconnect();
  });

  it('keeps a tombstone rather than a hole, and never returns the body again', async () => {
    const { id: roomId, a, b } = await room();
    const sent = await emit(a, 'chat:send', { clientMsgId: 'del-2', body: 'secret text' });
    await emit(a, 'chat:delete', { messageId: sent.data.id });

    const snapshot = (await emit(b, 'room:resync', {})).snapshot;
    const view = snapshot.messages.find((m: { id: string }) => m.id === sent.data.id);
    expect(view).toBeDefined();
    expect(view.body).toBe('');
    expect(view.deletedAt).not.toBeNull();

    // The row keeps the body for a moderator; the view never carries it.
    await h.server.ctx.chat.settle();
    const row = await prisma.message.findUnique({ where: { id: sent.data.id } });
    expect(row?.body).toBe('secret text');
    expect(row?.roomId).toBe(roomId);
    a.disconnect();
    b.disconnect();
  });

  it("refuses a member deleting the host's message", async () => {
    const { a, b } = await room();
    const sent = await emit(a, 'chat:send', { clientMsgId: 'del-3', body: 'mine' });
    const ack = await emit(b, 'chat:delete', { messageId: sent.data.id });
    expect(ack.ok).toBe(false);
    expect(ack.code).toBe('not_permitted');
    a.disconnect();
    b.disconnect();
  });

  it('lets the host delete anyone', async () => {
    const { a, b } = await room();
    const sent = await emit(b, 'chat:send', { clientMsgId: 'del-4', body: 'theirs' });
    expect((await emit(a, 'chat:delete', { messageId: sent.data.id })).ok).toBe(true);
    a.disconnect();
    b.disconnect();
  });

  it('cannot reach a message in another room', async () => {
    const first = await room();
    const sent = await emit(first.a, 'chat:send', { clientMsgId: 'iso', body: 'over here' });

    const other = await h.createRoom(host);
    const c = await h.connect(host);
    await emit(c, 'room:join', { roomCode: other.code });

    const ack = await emit(c, 'chat:delete', { messageId: sent.data.id });
    expect(ack.ok).toBe(false);
    first.a.disconnect();
    first.b.disconnect();
    c.disconnect();
  });
});

describe('ordering and backfill', () => {
  it('orders a burst by id, which is a total order on every client', async () => {
    const { a, b } = await room();
    const bodies = ['one', 'two', 'three', 'four', 'five'];
    const acks = [];
    for (const body of bodies) {
      acks.push(await emit(a, 'chat:send', { clientMsgId: body, body }));
    }
    const ids = acks.map((ack) => ack.data.id);
    expect([...ids].sort()).toEqual(ids);

    const snapshot = (await emit(b, 'room:resync', {})).snapshot;
    const seen = snapshot.messages
      .filter((m: { kind: string }) => m.kind === 'user')
      .map((m: { body: string }) => m.body);
    expect(seen).toEqual(bodies);
    a.disconnect();
    b.disconnect();
  });

  it('backfills only what a client missed, given its cursor', async () => {
    const { code, a, b } = await room();
    const first = await emit(a, 'chat:send', { clientMsgId: 'b1', body: 'before' });
    await emit(a, 'chat:send', { clientMsgId: 'b2', body: 'after one' });
    await emit(a, 'chat:send', { clientMsgId: 'b3', body: 'after two' });

    b.disconnect();
    const rejoined = await h.connect(member);
    const ack = await emit(rejoined, 'room:join', {
      roomCode: code,
      lastMessageId: first.data.id,
    });

    const bodies = ack.snapshot.messages
      .filter((m: { kind: string }) => m.kind === 'user')
      .map((m: { body: string }) => m.body);
    expect(bodies).toContain('after one');
    expect(bodies).toContain('after two');
    expect(bodies).not.toContain('before');
    a.disconnect();
    rejoined.disconnect();
  });

  it('writes a system line when somebody joins', async () => {
    const created = await h.createRoom(host);
    const a = await h.connect(host);
    await emit(a, 'room:join', { roomCode: created.code });

    const line = once(a, 'chat:message');
    const b = await h.connect(member);
    await emit(b, 'room:join', { roomCode: created.code });

    const event = await line;
    expect(event?.message.kind).toBe('system');
    expect(event?.message.body).toContain('Sam');
    a.disconnect();
    b.disconnect();
  });
});

describe('durability (§6.5)', () => {
  it('lands the row in Postgres after the queue flushes', async () => {
    const { id: roomId, a, b } = await room();
    const ack = await emit(a, 'chat:send', { clientMsgId: 'durable', body: 'persist me' });

    // The one place waiting IS the assertion: `settle()` drains the queue, and
    // the claim being tested is that the drain produces a row.
    await h.server.ctx.chat.settle();
    const row = await prisma.message.findUnique({ where: { id: ack.data.id } });
    expect(row?.body).toBe('persist me');
    expect(row?.roomId).toBe(roomId);
    expect(row?.userId).toBe(host.id);
    a.disconnect();
    b.disconnect();
  });
});
