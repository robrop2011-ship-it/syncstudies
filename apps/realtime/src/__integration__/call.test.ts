/**
 * WebRTC signaling authorization and the mesh caps
 * (PLAN.md §14 Phase 6 testing, §9.1, §11.5).
 *
 * §14 Phase 6 asks for "signaling authorization: a socket in room A cannot
 * signal a peer in room B; caps enforced". Those are the two assertions that
 * cannot be made anywhere but here — the media itself needs a browser, and the
 * relay's correctness does not.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MESH_AUDIO_MAX, MESH_VIDEO_MAX } from '@syncstudy/shared';
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

beforeAll(async () => {
  h = await startHarness();
  host = await h.createUser('Priya');
  member = await h.createUser('Sam');
}, 30_000);

afterAll(async () => {
  await h.cleanup();
}, 30_000);

describe('rtc:join', () => {
  it('issues ICE servers and the current mesh', async () => {
    const { a, b } = await room();
    const ack = await emit(a, 'rtc:join', { audio: true, video: false });
    expect(ack.ok).toBe(true);
    expect(ack.iceServers.length).toBeGreaterThan(0);
    expect(ack.ttlSec).toBeGreaterThan(0);
    expect(ack.peers).toEqual([]);

    const joined = once(a, 'rtc:peer_joined');
    const second = await emit(b, 'rtc:join', { audio: true, video: false });
    expect(second.peers).toHaveLength(1);
    expect((await joined)?.userId).toBe(member.id);
    a.disconnect();
    b.disconnect();
  });

  it('computes politeness per recipient, and antisymmetrically (§9.2)', async () => {
    const { a, b } = await room();
    await emit(a, 'rtc:join', { audio: true, video: false });
    const joined = once(a, 'rtc:peer_joined');
    const ackB = await emit(b, 'rtc:join', { audio: true, video: false });
    const seenByA = await joined;

    // Exactly one of the pair is polite, and both sides agree which.
    expect(ackB.peers[0].polite).toBe(!seenByA?.polite);
    expect(ackB.peers[0].polite).toBe(member.id < host.id);
    a.disconnect();
    b.disconnect();
  });

  it('never ships a static TURN credential when no secret is configured (§9.3)', async () => {
    const { a, b } = await room();
    const ack = await emit(a, 'rtc:join', { audio: true, video: false });
    // With TURN_SECRET unset the correct answer is STUN only. Shipping a shared
    // username/password to a browser hands anyone with devtools a free relay.
    const withCredentials = ack.iceServers.filter(
      (s: { credential?: string }) => s.credential !== undefined,
    );
    if (process.env['TURN_SECRET'] === undefined) {
      expect(withCredentials).toHaveLength(0);
    } else {
      // When one IS configured, the credential must be per-user and expiring.
      expect(withCredentials[0].username).toMatch(new RegExp(`^\\d+:${host.id}$`));
    }
    a.disconnect();
    b.disconnect();
  });

  it('refuses when the room has calling turned off', async () => {
    const { a, b } = await room({ callEnabled: false });
    const ack = await emit(a, 'rtc:join', { audio: true, video: false });
    expect(ack.ok).toBe(false);
    expect(ack.reason).toBe('call_disabled');
    a.disconnect();
    b.disconnect();
  });

  it('enforces the audio cap, and a rejoin does not consume a second seat', async () => {
    const created = await h.createRoom(host, { maxParticipants: MESH_AUDIO_MAX + 2 });
    const sockets: TestSocket[] = [];
    for (let i = 0; i < MESH_AUDIO_MAX + 1; i += 1) {
      const user = await h.createUser(`Caller${i}`);
      const socket = await h.connect(user);
      await emit(socket, 'room:join', { roomCode: created.code });
      sockets.push(socket);
    }

    const acks = [];
    for (const socket of sockets) acks.push(await emit(socket, 'rtc:join', { audio: true, video: false }));
    expect(acks.filter((x) => x.ok === true)).toHaveLength(MESH_AUDIO_MAX);
    expect(acks.filter((x) => x.reason === 'call_full')).toHaveLength(1);

    // Someone already in the call rejoining must not be refused for a seat they
    // are already sitting in.
    const first = sockets[0] as TestSocket;
    expect((await emit(first, 'rtc:join', { audio: true, video: false })).ok).toBe(true);
    for (const socket of sockets) socket.disconnect();
  });

  it('downgrades to audio rather than refusing when the camera cap is hit', async () => {
    const created = await h.createRoom(host, { maxParticipants: MESH_VIDEO_MAX + 3 });
    const sockets: TestSocket[] = [];
    for (let i = 0; i < MESH_VIDEO_MAX + 1; i += 1) {
      const user = await h.createUser(`Cam${i}`);
      const socket = await h.connect(user);
      await emit(socket, 'room:join', { roomCode: created.code });
      sockets.push(socket);
    }

    const acks = [];
    for (const socket of sockets) acks.push(await emit(socket, 'rtc:join', { audio: true, video: true }));
    // The point of the room is the voice; a full camera grid is not a reason to
    // keep somebody out of the conversation.
    expect(acks.every((x) => x.ok === true)).toBe(true);

    const last = sockets[sockets.length - 1] as TestSocket;
    const snapshot = (await emit(last, 'room:resync', {})).snapshot;
    const camerasOn = snapshot.participants.filter((p: { camOn: boolean }) => p.camOn).length;
    expect(camerasOn).toBe(MESH_VIDEO_MAX);
    for (const socket of sockets) socket.disconnect();
  });
});

describe('rtc:signal — the authorization check (§11.5)', () => {
  it('relays verbatim to a peer in the same call, stamping the sender', async () => {
    const { a, b } = await room();
    await emit(a, 'rtc:join', { audio: true, video: false });
    await emit(b, 'rtc:join', { audio: true, video: false });

    const sdp = 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n';
    const relayed = once(a, 'rtc:signal');
    expect((await emit(b, 'rtc:signal', { to: host.id, kind: 'offer', sdp })).ok).toBe(true);

    const arrived = await relayed;
    // Never parsed, never rewritten — SDP carries local IP addresses.
    expect(arrived?.sdp).toBe(sdp);
    expect(arrived?.from).toBe(member.id);
    a.disconnect();
    b.disconnect();
  });

  it('ignores a forged `from` in the payload', async () => {
    const { a, b } = await room();
    await emit(a, 'rtc:join', { audio: true, video: false });
    await emit(b, 'rtc:join', { audio: true, video: false });

    const relayed = once(a, 'rtc:signal');
    await emit(b, 'rtc:signal', { to: host.id, kind: 'answer', sdp: 'v=1', from: host.id });
    expect((await relayed)?.from).toBe(member.id);
    a.disconnect();
    b.disconnect();
  });

  it('a socket in room A cannot signal a peer in room B', async () => {
    const first = await room();
    await emit(first.a, 'rtc:join', { audio: true, video: false });
    await emit(first.b, 'rtc:join', { audio: true, video: false });

    const other = await h.createRoom(host);
    const outsider = await h.createUser('Outsider');
    const c = await h.connect(outsider);
    await emit(c, 'room:join', { roomCode: other.code });
    await emit(c, 'rtc:join', { audio: true, video: false });

    const ack = await emit(c, 'rtc:signal', { to: host.id, kind: 'offer', sdp: 'v=0' });
    expect(ack.ok).toBe(false);
    expect(ack.code).toBe('peer_gone');
    first.a.disconnect();
    first.b.disconnect();
    c.disconnect();
  });

  it('refuses a signal from somebody who has not joined the call', async () => {
    const { a, b } = await room();
    await emit(a, 'rtc:join', { audio: true, video: false });
    const ack = await emit(b, 'rtc:signal', { to: host.id, kind: 'offer', sdp: 'v=0' });
    expect(ack.ok).toBe(false);
    expect(ack.code).toBe('not_in_call');
    a.disconnect();
    b.disconnect();
  });

  it('refuses a signal to somebody who left the call', async () => {
    const { a, b } = await room();
    await emit(a, 'rtc:join', { audio: true, video: false });
    await emit(b, 'rtc:join', { audio: true, video: false });
    await emit(b, 'rtc:leave', {});

    const ack = await emit(a, 'rtc:signal', { to: member.id, kind: 'offer', sdp: 'v=0' });
    expect(ack.ok).toBe(false);
    expect(ack.code).toBe('peer_gone');
    a.disconnect();
    b.disconnect();
  });
});

describe('teardown and the screenshare lock', () => {
  it('a disconnect tears the call down at once, but keeps the room seat (§9.5)', async () => {
    const { a, b } = await room();
    await emit(a, 'rtc:join', { audio: true, video: false });
    await emit(b, 'rtc:join', { audio: true, video: false });

    const left = once(a, 'rtc:peer_left', 6_000);
    b.disconnect();
    expect((await left)?.userId).toBe(member.id);

    const snapshot = (await emit(a, 'room:resync', {})).snapshot;
    const them = snapshot.participants.find((p: { id: string }) => p.id === member.id);
    // Out of the call in ~5s; still in the room for the 45s grace period.
    expect(them).toBeDefined();
    expect(them.inCall).toBe(false);
    a.disconnect();
  });

  it('is a single-holder lock, and it comes back on release', async () => {
    const { a, b } = await room();
    await emit(a, 'rtc:join', { audio: true, video: false });
    await emit(b, 'rtc:join', { audio: true, video: false });

    const announced = once(b, 'rtc:screenshare_changed');
    expect((await emit(a, 'rtc:screenshare_claim', {})).ok).toBe(true);
    expect((await announced)?.holder).toBe(host.id);

    const contested = await emit(b, 'rtc:screenshare_claim', {});
    expect(contested.ok).toBe(false);
    expect(contested.code).toBe('screenshare_taken');

    expect((await emit(a, 'rtc:screenshare_release', {})).ok).toBe(true);
    expect((await emit(b, 'rtc:screenshare_claim', {})).ok).toBe(true);
    await emit(b, 'rtc:screenshare_release', {});
    a.disconnect();
    b.disconnect();
  });

  it('refuses a claim when the room has screen sharing turned off', async () => {
    const { a, b } = await room({ screenshareEnabled: false });
    await emit(a, 'rtc:join', { audio: true, video: false });
    const ack = await emit(a, 'rtc:screenshare_claim', {});
    expect(ack.ok).toBe(false);
    expect(ack.code).toBe('screenshare_disabled');
    a.disconnect();
    b.disconnect();
  });

  it('releases the lock when the holder drops off the socket', async () => {
    const { a, b } = await room();
    await emit(a, 'rtc:join', { audio: true, video: false });
    await emit(b, 'rtc:join', { audio: true, video: false });
    await emit(b, 'rtc:screenshare_claim', {});

    const released = once(a, 'rtc:screenshare_changed', 6_000);
    b.disconnect();
    expect((await released)?.holder).toBeNull();

    // And it is genuinely claimable again, not merely announced as free.
    expect((await emit(a, 'rtc:screenshare_claim', {})).ok).toBe(true);
    a.disconnect();
  });
});

describe('rtc:ice_refresh', () => {
  it('refuses somebody who is not in the call — it mints credentials (§9.3)', async () => {
    const { a, b } = await room();
    const ack = await emit(a, 'rtc:ice_refresh', {});
    expect(ack.ok).toBe(false);
    expect(ack.code).toBe('not_in_call');
    a.disconnect();
    b.disconnect();
  });

  it('issues a fresh grant to somebody who is', async () => {
    const { a, b } = await room();
    await emit(a, 'rtc:join', { audio: true, video: false });
    const ack = await emit(a, 'rtc:ice_refresh', {});
    expect(ack.ok).toBe(true);
    expect(ack.data.iceServers.length).toBeGreaterThan(0);
    a.disconnect();
    b.disconnect();
  });
});
