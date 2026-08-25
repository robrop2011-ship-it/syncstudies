/**
 * The authoritative timeline, against real Redis (PLAN.md §14 Phase 4 testing).
 *
 * §8 is the product, and the server half of it is the atomic Lua transact. What
 * is asserted here is what the unit tests cannot see: that two sockets racing
 * the same scrubber produce exactly one winner, that a stale revision is
 * refused rather than applied, and that the anchor survives a cold room without
 * the video having "advanced" while nobody was watching.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emit, once, startHarness, type Harness, type TestSocket, type TestUser } from './harness.js';

let h: Harness;
let host: TestUser;
let member: TestUser;

async function room(overrides: Record<string, unknown> = {}): Promise<{
  id: string;
  code: string;
  a: TestSocket;
  b: TestSocket;
}> {
  const created = await h.createRoom(host, overrides);
  const a = await h.connect(host);
  const b = await h.connect(member);
  await emit(a, 'room:join', { roomCode: created.code });
  await emit(b, 'room:join', { roomCode: created.code });
  return { ...created, a, b };
}

/** A control payload. `clientSentAtMs` is in server time (§8.4). */
function control(action: string, extra: Record<string, unknown>, revision: number) {
  return { action, clientSentAtMs: Date.now(), expectedRevision: revision, ...extra };
}

beforeAll(async () => {
  h = await startHarness();
  host = await h.createUser('Priya');
  member = await h.createUser('Sam');
}, 30_000);

afterAll(async () => {
  await h.cleanup();
}, 30_000);

describe('video:set', () => {
  it('sets the video and tells the room', async () => {
    const { a, b } = await room();
    const seen = once(b, 'video:state');
    const ack = await emit(a, 'video:set', {
      provider: 'youtube',
      videoRef: 'fNk_zzaMoSs',
      title: 'Vectors',
      durationSec: 592,
    });

    expect(ack.ok).toBe(true);
    expect(ack.anchor.videoRef).toBe('fNk_zzaMoSs');
    // A new video always lands paused at zero: nobody has pressed play yet, and
    // starting a video for five people because one of them pasted a link is not
    // a thing to do.
    expect(ack.anchor.status).toBe('paused');
    expect(ack.anchor.anchorPositionSec).toBe(0);

    const event = await seen;
    expect(event?.reason).toBe('set_video');
    a.disconnect();
    b.disconnect();
  });

  it('refuses a member when the policy says host only', async () => {
    const { a, b } = await room({ playbackControl: 'host_only' });
    const ack = await emit(b, 'video:set', { provider: 'youtube', videoRef: 'abc12345678' });
    expect(ack.ok).toBe(false);
    a.disconnect();
    b.disconnect();
  });
});

describe('video:control (§8.5)', () => {
  it('play, pause and seek each advance the revision', async () => {
    const { a, b } = await room();
    await emit(a, 'video:set', { provider: 'youtube', videoRef: 'fNk_zzaMoSs', durationSec: 592 });

    const played = await emit(a, 'video:control', control('play', {}, 1));
    expect(played.ok).toBe(true);
    expect(played.anchor.status).toBe('playing');
    expect(played.anchor.revision).toBe(2);

    const sought = await emit(a, 'video:control', control('seek', { positionSec: 120 }, 2));
    expect(sought.ok).toBe(true);
    expect(sought.anchor.revision).toBe(3);
    // In-flight compensation: the anchor lands at or a hair past the target, so
    // the ROOM arrives on the requested second rather than the requester's.
    expect(sought.anchor.anchorPositionSec).toBeGreaterThanOrEqual(120);
    expect(sought.anchor.anchorPositionSec).toBeLessThan(121);

    const paused = await emit(a, 'video:control', control('pause', {}, 3));
    expect(paused.ok).toBe(true);
    expect(paused.anchor.status).toBe('paused');
    b.disconnect();
    a.disconnect();
  });

  it('refuses a stale revision and hands back the truth so the client can reconcile', async () => {
    const { a, b } = await room();
    await emit(a, 'video:set', { provider: 'youtube', videoRef: 'fNk_zzaMoSs', durationSec: 592 });
    await emit(a, 'video:control', control('seek', { positionSec: 60 }, 1));

    // `b` still believes the room is at revision 1.
    const stale = await emit(b, 'video:control', control('seek', { positionSec: 300 }, 1));
    expect(stale.ok).toBe(false);
    expect(['stale_revision', 'recently_changed']).toContain(stale.reason);
    // §8.5d: a rejection always carries the authoritative anchor, precisely so a
    // rejected client reconciles immediately instead of having to ask.
    expect(stale.anchor.revision).toBeGreaterThan(1);
    a.disconnect();
    b.disconnect();
  });

  it('two sockets seeking at once produce exactly one winner', async () => {
    const { a, b } = await room();
    await emit(a, 'video:set', { provider: 'youtube', videoRef: 'fNk_zzaMoSs', durationSec: 592 });

    const [first, second] = await Promise.all([
      emit(a, 'video:control', control('seek', { positionSec: 100 }, 1)),
      emit(b, 'video:control', control('seek', { positionSec: 400 }, 1)),
    ]);

    const winners = [first, second].filter((r) => r.ok === true);
    expect(winners).toHaveLength(1);
    const loser = [first, second].find((r) => r.ok === false);
    expect(['stale_revision', 'recently_changed']).toContain(loser?.reason);
    a.disconnect();
    b.disconnect();
  });

  it('refuses a control with no video loaded', async () => {
    const { a, b } = await room();
    const ack = await emit(a, 'video:control', control('play', {}, 0));
    expect(ack.ok).toBe(false);
    expect(ack.reason).toBe('no_video');
    a.disconnect();
    b.disconnect();
  });

  it('refuses a seek without a position', async () => {
    const { a, b } = await room();
    await emit(a, 'video:set', { provider: 'youtube', videoRef: 'fNk_zzaMoSs', durationSec: 592 });
    const ack = await emit(a, 'video:control', control('seek', {}, 1));
    expect(ack.ok).toBe(false);
    a.disconnect();
    b.disconnect();
  });

  it('locks a member out while the policy is host_only, whatever the revision', async () => {
    const { a, b } = await room({ playbackControl: 'host_only' });
    await emit(a, 'video:set', { provider: 'youtube', videoRef: 'fNk_zzaMoSs', durationSec: 592 });
    const ack = await emit(b, 'video:control', control('play', {}, 1));
    expect(ack.ok).toBe(false);
    expect(ack.reason).toBe('not_permitted');
    a.disconnect();
    b.disconnect();
  });
});

describe('snapshots and cold rooms (§8.11)', () => {
  it('hands a late joiner the live anchor, not a replayed history', async () => {
    const created = await h.createRoom(host);
    const a = await h.connect(host);
    await emit(a, 'room:join', { roomCode: created.code });
    await emit(a, 'video:set', { provider: 'youtube', videoRef: 'fNk_zzaMoSs', durationSec: 592 });
    await emit(a, 'video:control', control('seek', { positionSec: 240 }, 1));
    await emit(a, 'video:control', control('play', {}, 2));

    const b = await h.connect(member);
    const ack = await emit(b, 'room:join', { roomCode: created.code });
    expect(ack.snapshot.video.status).toBe('playing');
    expect(ack.snapshot.video.anchorPositionSec).toBeGreaterThanOrEqual(240);
    // The client derives its position from `anchorServerMs` against its own
    // clock offset, so the snapshot has to carry both.
    expect(ack.snapshot.video.anchorServerMs).toBeGreaterThan(0);
    expect(ack.snapshot.serverMs).toBeGreaterThan(0);
    a.disconnect();
    b.disconnect();
  });

  it('a resync from a socket that is not in the room is refused, not answered', async () => {
    const socket = await h.connect(member);
    const ack = await emit(socket, 'room:resync', {});
    expect(ack.ok).toBe(false);
    expect(ack.code).toBe('not_in_room');
    socket.disconnect();
  });

  it('rehydrates a cold room PAUSED, so it cannot advance while empty', async () => {
    const created = await h.createRoom(host);
    const a = await h.connect(host);
    await emit(a, 'room:join', { roomCode: created.code });
    await emit(a, 'video:set', { provider: 'youtube', videoRef: 'fNk_zzaMoSs', durationSec: 592 });
    await emit(a, 'video:control', control('seek', { positionSec: 300 }, 1));
    await emit(a, 'video:control', control('play', {}, 2));

    // Everybody leaves. The room is frozen and persisted, then the live copy is
    // dropped — the exact state a room is in three days later.
    await emit(a, 'room:leave', {});
    a.disconnect();
    await h.server.ctx.store.purgeRoom(created.id);

    const b = await h.connect(host);
    const ack = await emit(b, 'room:join', { roomCode: created.code });
    // Reopening must not land at the end of the video because time passed.
    expect(ack.snapshot.video.status).toBe('paused');
    expect(ack.snapshot.video.anchorPositionSec).toBeGreaterThanOrEqual(300);
    expect(ack.snapshot.video.anchorPositionSec).toBeLessThan(360);
    b.disconnect();
  });
});
