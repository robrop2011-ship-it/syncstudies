/**
 * An independent observer for a room. Prints every video:state it sees.
 *
 *   npx tsx --env-file=.env scripts/watch-room.mjs <ROOM-CODE> [seconds]
 *
 * The point is to have a second opinion on what the SERVER thinks is happening,
 * separate from whatever a browser is rendering.
 */
import { io } from 'socket.io-client';

const WEB = 'http://localhost:3000';
const RT = 'http://localhost:4000';
const code = process.argv[2];
const seconds = Number(process.argv[3] ?? 20);

const res = await fetch(`${WEB}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: WEB },
  body: JSON.stringify({ handle: 'sam', password: 'studytogether1' }),
});
const cookie = (res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')])
  .map((c) => c.split(';')[0])
  .join('; ');

const socket = io(RT, {
  transports: ['websocket'],
  withCredentials: false,
  extraHeaders: { cookie, origin: WEB },
  reconnection: false,
});

socket.on('connect', () => {
  socket.emit('room:join', { roomCode: code }, (ack) => {
    if (!ack.ok) {
      console.error('join failed', ack);
      process.exit(1);
    }
    const a = ack.snapshot.video;
    console.log(`joined. rev=${a.revision} status=${a.status} pos=${a.anchorPositionSec.toFixed(2)}`);
  });
});

socket.on('video:state', ({ anchor, reason, actorId }) => {
  if (reason === 'heartbeat') return;
  console.log(
    `video:state reason=${reason} rev=${anchor.revision} status=${anchor.status} pos=${anchor.anchorPositionSec.toFixed(2)} actor=${actorId?.slice(0, 8) ?? '—'}`,
  );
});

setTimeout(() => {
  socket.disconnect();
  process.exit(0);
}, seconds * 1000);
