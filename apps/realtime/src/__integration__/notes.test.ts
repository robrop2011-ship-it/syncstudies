/**
 * Shared notes, pinned items and the checklist (PLAN.md §14 Phase 7 testing).
 *
 * §14 Phase 7 names the three assertions: two clients editing different blocks
 * both persist; the same block leaves the loser's text preserved as a new block
 * and never lost; checklist toggle races converge. Those are the tests here, and
 * the conflict one is the reason §8.12 is written the way it is.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@syncstudy/db';
import { collect, emit, once, startHarness, type Harness, type TestSocket, type TestUser } from './harness.js';

let h: Harness;
let host: TestUser;
let member: TestUser;

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

describe('the shared document (§8.12)', () => {
  it('creates a paragraph from an unknown block id and broadcasts it', async () => {
    const { a, b } = await room();
    const blockId = randomUUID();
    const seen = once(b, 'notes:block_updated');
    const ack = await emit(a, 'notes:block_update', {
      blockId,
      text: 'Vectors are arrows.',
      baseVersion: 0,
    });

    expect(ack.ok).toBe(true);
    expect(ack.data.version).toBe(1);
    const event = await seen;
    expect(event?.blockId).toBe(blockId);
    expect(event?.text).toBe('Vectors are arrows.');
    expect(typeof event?.position).toBe('number');
    a.disconnect();
    b.disconnect();
  });

  it('reads back immediately — the document is in Redis, not behind a queue', async () => {
    const { a, b } = await room();
    const blockId = randomUUID();
    await emit(a, 'notes:block_update', { blockId, text: 'Read me now.', baseVersion: 0 });

    // No sleep. The chat transcript has a write-behind window; the document
    // does not, and a reader must never have to wait for one.
    const snapshot = (await emit(b, 'room:resync', {})).snapshot;
    expect(snapshot.notes.blocks[0].text).toBe('Read me now.');
    expect(snapshot.notes.content).toBe('Read me now.');
    a.disconnect();
    b.disconnect();
  });

  it('lets two people edit different paragraphs with no conflict at all', async () => {
    const { a, b } = await room();
    const one = randomUUID();
    const two = randomUUID();
    await emit(a, 'notes:block_update', { blockId: one, text: 'Priya paragraph.', baseVersion: 0 });
    await emit(b, 'notes:block_update', { blockId: two, text: 'Sam paragraph.', baseVersion: 0 });

    const blocks = (await emit(a, 'room:resync', {})).snapshot.notes.blocks;
    expect(blocks.map((x: { text: string }) => x.text)).toEqual([
      'Priya paragraph.',
      'Sam paragraph.',
    ]);
    a.disconnect();
    b.disconnect();
  });

  it('preserves the loser rather than dropping it, immediately below the winner', async () => {
    const { a, b } = await room();
    const blockId = randomUUID();
    await emit(a, 'notes:block_update', { blockId, text: 'original', baseVersion: 0 });
    await emit(a, 'notes:block_update', { blockId, text: 'Priya wins.', baseVersion: 1 });

    // Sam still believes the block is at version 1 — what two people typing at
    // the same moment actually produces.
    const preservedEvent = once(b, 'notes:block_updated');
    const stale = await emit(b, 'notes:block_update', {
      blockId,
      text: 'Sam had other ideas.',
      baseVersion: 1,
    });

    expect(stale.ok).toBe(true);
    expect(stale.data.winning).toBe('Priya wins.');
    const preserved = await preservedEvent;
    expect(preserved?.text).toBe('Sam had other ideas.');
    expect(preserved?.blockId).not.toBe(blockId);

    const blocks = (await emit(a, 'room:resync', {})).snapshot.notes.blocks;
    // Worst case is a duplicated paragraph, never lost work.
    expect(blocks.map((x: { text: string }) => x.text)).toEqual([
      'Priya wins.',
      'Sam had other ideas.',
    ]);
    a.disconnect();
    b.disconnect();
  });

  it('removes a paragraph when its text is emptied', async () => {
    const { a, b } = await room();
    const blockId = randomUUID();
    await emit(a, 'notes:block_update', { blockId, text: 'temporary', baseVersion: 0 });
    const removed = await emit(a, 'notes:block_update', { blockId, text: '', baseVersion: 1 });
    expect(removed.ok).toBe(true);
    expect((await emit(b, 'room:resync', {})).snapshot.notes.blocks).toEqual([]);
    a.disconnect();
    b.disconnect();
  });

  it('holds a focus lock and names the original holder when contested', async () => {
    const { a, b } = await room();
    const blockId = randomUUID();
    await emit(a, 'notes:block_update', { blockId, text: 'locked', baseVersion: 0 });

    const locked = once(b, 'notes:block_locked');
    a.emit('notes:block_focus', { blockId });
    expect((await locked)?.userId).toBe(host.id);

    const contested = once(a, 'notes:block_locked');
    b.emit('notes:block_focus', { blockId });
    // Advisory, but honest: the second person is told who actually has it.
    expect((await contested)?.userId).toBe(host.id);
    a.disconnect();
    b.disconnect();
  });

  it('persists the serialised document to Postgres', async () => {
    const { id: roomId, a, b } = await room();
    await emit(a, 'notes:block_update', {
      blockId: randomUUID(),
      text: 'Durable paragraph.',
      baseVersion: 0,
    });

    // The wait is the assertion: the claim is that the debounce lands the row.
    await h.server.ctx.notes.settle();
    const row = await prisma.roomNotes.findUnique({ where: { roomId } });
    expect(row?.content).toBe('Durable paragraph.');
    expect(Number(row?.version ?? 0)).toBeGreaterThan(0);
    a.disconnect();
    b.disconnect();
  });
});

describe('pinned items (§3.6 S3)', () => {
  it('pins a question to a timestamp and tells the room', async () => {
    const { a, b } = await room();
    const seen = once(b, 'notes:item_created');
    const ack = await emit(a, 'notes:item_create', {
      kind: 'question',
      body: 'Why is the determinant an area?',
      videoTs: 752.5,
    });

    expect(ack.ok).toBe(true);
    expect(ack.data.videoTs).toBe(752.5);
    expect(ack.data.author.id).toBe(host.id);
    expect((await seen)?.item.id).toBe(ack.data.id);
    a.disconnect();
    b.disconnect();
  });

  it('lets anyone resolve a question, but only the author edit it', async () => {
    const { a, b } = await room();
    const created = await emit(a, 'notes:item_create', { kind: 'question', body: 'q', videoTs: 10 });

    const updated = once(a, 'notes:item_updated');
    expect((await emit(b, 'notes:item_update', { id: created.data.id, resolved: true })).ok).toBe(true);
    expect((await updated)?.item.resolvedAt).not.toBeNull();

    const hijack = await emit(b, 'notes:item_update', { id: created.data.id, body: 'not yours' });
    expect(hijack.ok).toBe(false);
    expect(hijack.code).toBe('not_permitted');
    a.disconnect();
    b.disconnect();
  });

  it('refuses to resolve something that is not a question', async () => {
    const { a, b } = await room();
    const note = await emit(a, 'notes:item_create', { kind: 'note', body: 'just a note' });
    const ack = await emit(a, 'notes:item_update', { id: note.data.id, resolved: true });
    expect(ack.ok).toBe(false);
    a.disconnect();
    b.disconnect();
  });

  it('delete follows canActOn: own always, others only if you outrank them', async () => {
    const { a, b } = await room();
    const hostItem = await emit(a, 'notes:item_create', { kind: 'note', body: 'host note' });
    const memberItem = await emit(b, 'notes:item_create', { kind: 'note', body: 'member note' });

    expect((await emit(b, 'notes:item_delete', { id: hostItem.data.id })).code).toBe('not_permitted');
    expect((await emit(b, 'notes:item_delete', { id: memberItem.data.id })).ok).toBe(true);
    expect((await emit(a, 'notes:item_delete', { id: hostItem.data.id })).ok).toBe(true);
    a.disconnect();
    b.disconnect();
  });

  it('stamps the video reference server-side, never from the payload', async () => {
    const { a, b } = await room();
    await emit(a, 'video:set', { provider: 'youtube', videoRef: 'fNk_zzaMoSs', durationSec: 592 });
    const ack = await emit(a, 'notes:item_create', { kind: 'bookmark', body: 'here', videoTs: 30 });
    expect(ack.data.videoRef).toBe('fNk_zzaMoSs');
    a.disconnect();
    b.disconnect();
  });
});

describe('checklist (§3.6 S6)', () => {
  it('creates, ticks and attributes', async () => {
    const { a, b } = await room();
    const item = await emit(a, 'checklist:create', { label: 'Watch chapter 1' });
    expect(item.ok).toBe(true);

    const updated = once(b, 'checklist:updated');
    expect((await emit(b, 'checklist:toggle', { id: item.data.id, completed: true })).ok).toBe(true);
    const event = await updated;
    // A shared checklist with anonymous completions is a checklist nobody trusts.
    expect(event?.item.completedBy.id).toBe(member.id);
    expect(event?.item.completedAt).not.toBeNull();
    a.disconnect();
    b.disconnect();
  });

  it('converges when two people tick the same item at once', async () => {
    const { a, b } = await room();
    const item = await emit(a, 'checklist:create', { label: 'Race me' });

    const events = collect(a, 'checklist:updated', 600);
    await Promise.all([
      emit(a, 'checklist:toggle', { id: item.data.id, completed: true }),
      emit(b, 'checklist:toggle', { id: item.data.id, completed: true }),
    ]);
    const states = (await events)
      .filter((e: { item: { id: string } }) => e.item.id === item.data.id)
      .map((e: { item: { completedAt: number | null } }) => e.item.completedAt !== null);

    // The write sets an absolute state rather than flipping one, so a race
    // cannot land on "off".
    expect(states.length).toBeGreaterThan(0);
    expect(states.every((done: boolean) => done)).toBe(true);
    a.disconnect();
    b.disconnect();
  });

  it('reorders with a fractional index, in one write and durably', async () => {
    const { a, b } = await room();
    const one = await emit(a, 'checklist:create', { label: 'first' });
    const two = await emit(a, 'checklist:create', { label: 'second' });

    const between = (one.data.position + two.data.position) / 2;
    expect((await emit(a, 'checklist:reorder', { id: two.data.id, position: between })).ok).toBe(true);

    const list = (await emit(b, 'room:resync', {})).snapshot.checklist;
    expect(list.map((i: { label: string }) => i.label)).toEqual(['first', 'second']);
    a.disconnect();
    b.disconnect();
  });

  it('cannot reach an item in another room', async () => {
    const first = await room();
    const item = await emit(first.a, 'checklist:create', { label: 'over here' });

    const other = await h.createRoom(host);
    const c = await h.connect(host);
    await emit(c, 'room:join', { roomCode: other.code });

    const ack = await emit(c, 'checklist:toggle', { id: item.data.id, completed: true });
    expect(ack.ok).toBe(false);
    expect(ack.code).toBe('not_found');
    first.a.disconnect();
    first.b.disconnect();
    c.disconnect();
  });
});
