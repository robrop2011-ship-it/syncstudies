/**
 * Live-stack verification for Phase 6 signaling.
 *
 * Runs against a real realtime service, real Postgres and real Redis. Every
 * socket is disconnected and the process exits explicitly on both paths — a
 * socket.io client keeps the Node event loop alive forever otherwise, and a
 * failing script that hangs hides its own failure (HANDOFF §7).
 */
import { io } from 'socket.io-client';

const WEB = 'http://localhost:3000';
const RT = 'http://localhost:4000';
const PASSWORD = 'studytogether1';

let passed = 0;
let failed = 0;
const sockets = [];

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function login(handle) {
  const res = await fetch(`${WEB}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: WEB },
    body: JSON.stringify({ handle, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login ${handle}: ${res.status} ${await res.text()}`);
  const raw = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')];
  const cookie = raw.map((c) => c.split(';')[0]).join('; ');
  const body = await res.json();
  return { cookie, userId: body.data.user.id };
}

async function createRoom(cookie, name) {
  const res = await fetch(`${WEB}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin: WEB },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`create room: ${res.status} ${await res.text()}`);
  return (await res.json()).data.room;
}

function connect(cookie) {
  // withCredentials:false — socket.io-client in Node drops a Cookie set via
  // extraHeaders when it is true (HANDOFF §7).
  const socket = io(RT, {
    transports: ['websocket'],
    withCredentials: false,
    extraHeaders: { cookie, origin: WEB },
    reconnection: false,
  });
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (err) => reject(new Error(`handshake: ${err.message}`)));
  });
}

function emit(socket, event, payload) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, code: 'timeout' }), 8000);
    socket.emit(event, payload, (ack) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });
}

/** Wait for one event, or resolve null after `ms`. */
function once(socket, event, ms = 3000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      resolve(null);
    }, ms);
    const handler = (payload) => {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

async function main() {
  const priya = await login('priya');
  const sam = await login('sam');
  const room = await createRoom(priya.cookie, `RTC check ${Date.now()}`);
  console.log(`room ${room.code} (${room.id})\n`);

  const a = await connect(priya.cookie);
  const b = await connect(sam.cookie);

  const joinA = await emit(a, 'room:join', { roomCode: room.code });
  const joinB = await emit(b, 'room:join', { roomCode: room.code });
  check('both sockets joined the room', joinA.ok && joinB.ok, JSON.stringify(joinB));

  // ── join, caps, politeness ──────────────────────────────────────────────
  console.log('\nrtc:join');
  const callA = await emit(a, 'rtc:join', { audio: true, video: false });
  check('first join succeeds', callA.ok === true, JSON.stringify(callA));
  check('mesh is empty for the first joiner', (callA.peers ?? []).length === 0);
  check('ICE servers are issued', Array.isArray(callA.iceServers) && callA.iceServers.length > 0);
  check(
    'no static TURN password is shipped when TURN_SECRET is unset',
    (callA.iceServers ?? []).every((s) => s.credential === undefined),
    JSON.stringify(callA.iceServers),
  );
  check('a TTL accompanies the credentials', typeof callA.ttlSec === 'number' && callA.ttlSec > 0);

  const peerJoined = once(a, 'rtc:peer_joined');
  const callB = await emit(b, 'rtc:join', { audio: true, video: false });
  check('second join succeeds', callB.ok === true, JSON.stringify(callB));
  check('second joiner sees the first as a peer', (callB.peers ?? []).length === 1);

  const seen = await peerJoined;
  check('the first peer is told someone joined', seen?.userId === sam.userId, JSON.stringify(seen));

  // Politeness is the lexicographic rule, computed independently on both sides.
  const expectedForB = sam.userId < priya.userId;
  check(
    'politeness is the lexicographic tie-break, per recipient',
    callB.peers?.[0]?.polite === expectedForB && seen?.polite === !expectedForB,
    `B.polite=${callB.peers?.[0]?.polite} A.polite=${seen?.polite} expectedForB=${expectedForB}`,
  );

  // ── presence reflects the call ──────────────────────────────────────────
  console.log('\npresence');
  const snapshot = await emit(a, 'room:resync', {});
  const both = (snapshot.snapshot?.participants ?? []).filter((p) => p.inCall);
  check('both participants read as in the call', both.length === 2, JSON.stringify(both.map((p) => p.id)));

  // ── the relay, and its authorization check ──────────────────────────────
  console.log('\nrtc:signal');
  const relayed = once(a, 'rtc:signal');
  const sent = await emit(b, 'rtc:signal', { to: priya.userId, kind: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n' });
  check('a signal to a peer in the call is accepted', sent.ok === true, JSON.stringify(sent));
  const arrived = await relayed;
  check('the signal arrives at the named peer', arrived?.kind === 'offer', JSON.stringify(arrived));
  check('the sender is stamped by the server, not the payload', arrived?.from === sam.userId);
  check('the SDP is relayed verbatim', arrived?.sdp === 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n');

  const stranger = await emit(b, 'rtc:signal', {
    to: '00000000-0000-4000-8000-000000000000',
    kind: 'candidate',
    candidate: { candidate: 'x' },
  });
  check('a signal to somebody not in the room is refused', stranger.ok === false && stranger.code === 'peer_gone', JSON.stringify(stranger));

  const selfSignal = await emit(b, 'rtc:signal', { to: sam.userId, kind: 'offer', sdp: 'v=0' });
  check('a signal addressed to yourself is refused', selfSignal.ok === false, JSON.stringify(selfSignal));

  // Identity comes from the session: a forged `from` in the payload is ignored.
  const forgedRelay = once(a, 'rtc:signal');
  await emit(b, 'rtc:signal', { to: priya.userId, kind: 'answer', sdp: 'v=1', from: priya.userId });
  const forged = await forgedRelay;
  check('a `from` in the payload cannot forge identity', forged?.from === sam.userId, JSON.stringify(forged));

  // ── screen share lock ───────────────────────────────────────────────────
  console.log('\nscreenshare');
  const shareBroadcast = once(b, 'rtc:screenshare_changed');
  const claimA = await emit(a, 'rtc:screenshare_claim', {});
  check('the first claim wins the lock', claimA.ok === true, JSON.stringify(claimA));
  const shareSeen = await shareBroadcast;
  check('the room is told who is sharing', shareSeen?.holder === priya.userId, JSON.stringify(shareSeen));

  const claimB = await emit(b, 'rtc:screenshare_claim', {});
  check(
    'a second claim is refused while the lock is held',
    claimB.ok === false && claimB.code === 'screenshare_taken',
    JSON.stringify(claimB),
  );

  const released = await emit(a, 'rtc:screenshare_release', {});
  check('the holder can release', released.ok === true);
  const claimB2 = await emit(b, 'rtc:screenshare_claim', {});
  check('the lock is claimable again once released', claimB2.ok === true, JSON.stringify(claimB2));
  await emit(b, 'rtc:screenshare_release', {});

  // ── ICE refresh ─────────────────────────────────────────────────────────
  console.log('\nrtc:ice_refresh');
  const refreshed = await emit(a, 'rtc:ice_refresh', {});
  check('a participant in the call can refresh credentials', refreshed.ok === true, JSON.stringify(refreshed));
  check('the refresh carries ICE servers', (refreshed.data?.iceServers ?? []).length > 0);

  // ── leave, and the disconnect path ──────────────────────────────────────
  console.log('\nteardown');
  const leftEvent = once(a, 'rtc:peer_left');
  const leftAck = await emit(b, 'rtc:leave', {});
  check('leaving the call is acked', leftAck.ok === true);
  const left = await leftEvent;
  check('peers are told to close their connections', left?.userId === sam.userId, JSON.stringify(left));

  const signalAfterLeave = await emit(a, 'rtc:signal', { to: sam.userId, kind: 'offer', sdp: 'v=0' });
  check(
    'signalling somebody who left the call is refused',
    signalAfterLeave.ok === false && signalAfterLeave.code === 'peer_gone',
    JSON.stringify(signalAfterLeave),
  );

  // §9.5: an ungraceful drop must tear the call down at once, not after the
  // 45s room grace period.
  await emit(b, 'rtc:join', { audio: true, video: false });
  const droppedEvent = once(a, 'rtc:peer_left', 6000);
  b.disconnect();
  const dropped = await droppedEvent;
  check(
    'a socket disconnect tears the call down immediately (§9.5)',
    dropped?.userId === sam.userId,
    JSON.stringify(dropped),
  );

  const afterDrop = await emit(a, 'room:resync', {});
  const stillInCall = (afterDrop.snapshot?.participants ?? []).filter((p) => p.inCall).map((p) => p.id);
  check(
    'the dropped participant is out of the call but still in the room',
    !stillInCall.includes(sam.userId) &&
      (afterDrop.snapshot?.participants ?? []).some((p) => p.id === sam.userId),
    JSON.stringify(afterDrop.snapshot?.participants?.map((p) => [p.id, p.inCall, p.connState])),
  );
}

main()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    for (const socket of sockets) socket.disconnect();
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error('\nscript failed:', err);
    for (const socket of sockets) socket.disconnect();
    process.exit(1);
  });
