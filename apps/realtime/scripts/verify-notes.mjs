/**
 * Live-stack verification for Phase 7 (shared notes, pinned items, checklist).
 *
 * Runs against real Postgres and real Redis with two socket clients. The
 * assertions that matter are the concurrency ones — a conflict must preserve
 * both texts, and two clients ticking the same checklist item must converge —
 * and none of them sleeps before asserting (ADR 0006's rule generalises: a test
 * that gives the system time to catch up will pass against broken code).
 *
 * Run it with tsx, not plain node: it imports @syncstudy/db to read the durable
 * copy back, and that package uses extensionless relative imports (ADR 0002),
 * which Node's own ESM resolver does not accept.
 *
 *   pnpm --filter @syncstudy/realtime exec tsx scripts/verify-notes.mjs
 */
import { randomUUID } from 'node:crypto';
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
  return { cookie: raw.map((c) => c.split(';')[0]).join('; '), userId: (await res.json()).data.user.id };
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

/** Collect every event of a kind for `ms`, rather than just the first. */
function collect(socket, event, ms) {
  const seen = [];
  const handler = (payload) => seen.push(payload);
  socket.on(event, handler);
  return new Promise((resolve) =>
    setTimeout(() => {
      socket.off(event, handler);
      resolve(seen);
    }, ms),
  );
}

async function main() {
  const priya = await login('priya');
  const sam = await login('sam');
  const room = await createRoom(priya.cookie, `Notes check ${Date.now()}`);
  console.log(`room ${room.code} (${room.id})\n`);

  const a = await connect(priya.cookie);
  const b = await connect(sam.cookie);
  const joinA = await emit(a, 'room:join', { roomCode: room.code });
  const joinB = await emit(b, 'room:join', { roomCode: room.code });
  check('both sockets joined', joinA.ok && joinB.ok);

  // ── an empty room has an empty, well-formed document ─────────────────────
  console.log('\nsnapshot shape');
  const snap = joinA.snapshot;
  check('notes arrive with the snapshot', snap.notes !== undefined && Array.isArray(snap.notes.blocks));
  check('a fresh room has no blocks, items or checklist',
    snap.notes.blocks.length === 0 && snap.noteItems.length === 0 && snap.checklist.length === 0,
    JSON.stringify({ b: snap.notes.blocks.length, i: snap.noteItems.length, c: snap.checklist.length }));

  // ── writing a block ──────────────────────────────────────────────────────
  console.log('\nnotes:block_update');
  const block1 = randomUUID();
  const seenByB = once(b, 'notes:block_updated');
  const wrote = await emit(a, 'notes:block_update', {
    blockId: block1,
    text: 'Vectors are arrows with a tail at the origin.',
    baseVersion: 0,
  });
  check('an unknown block id creates the paragraph', wrote.ok === true, JSON.stringify(wrote));
  check('the document version advances', wrote.data?.version === 1, JSON.stringify(wrote.data));

  const arrived = await seenByB;
  check('the other client is told', arrived?.blockId === block1, JSON.stringify(arrived));
  check('the broadcast carries text, version and position',
    arrived?.text?.startsWith('Vectors') && arrived?.version === 1 && typeof arrived?.position === 'number',
    JSON.stringify(arrived));

  // No sleep before this read, deliberately: the document lives in Redis, so a
  // read-back must be correct immediately rather than after the write-behind.
  const afterWrite = await emit(b, 'room:resync', {});
  check('a joiner reads the paragraph back with no delay',
    afterWrite.snapshot?.notes.blocks?.[0]?.text?.startsWith('Vectors') === true,
    JSON.stringify(afterWrite.snapshot?.notes));
  check('serialised content matches the blocks',
    afterWrite.snapshot?.notes.content === 'Vectors are arrows with a tail at the origin.');

  // ── the conflict rule (§8.12) ────────────────────────────────────────────
  console.log('\nconflict resolution');
  const updated = await emit(a, 'notes:block_update', {
    blockId: block1,
    text: 'Vectors are arrows. Priya edit.',
    baseVersion: 1,
  });
  check('a matching baseVersion is accepted', updated.ok === true);

  const preservedEvent = once(b, 'notes:block_updated');
  // Sam still believes the block is at version 1 — a stale base, exactly what a
  // second person typing at the same time produces.
  const stale = await emit(b, 'notes:block_update', {
    blockId: block1,
    text: 'Sam wrote something else entirely.',
    baseVersion: 1,
  });
  check('a stale baseVersion still succeeds', stale.ok === true, JSON.stringify(stale));
  check('the loser is told which text won',
    stale.data?.winning === 'Vectors are arrows. Priya edit.',
    JSON.stringify(stale.data));

  const preserved = await preservedEvent;
  check('the loser’s text is preserved as a new paragraph',
    preserved?.text === 'Sam wrote something else entirely.' && preserved?.blockId !== block1,
    JSON.stringify(preserved));

  const afterConflict = await emit(a, 'room:resync', {});
  const blocks = afterConflict.snapshot?.notes.blocks ?? [];
  check('both texts survive — nothing was dropped', blocks.length === 2, JSON.stringify(blocks.map((x) => x.text)));
  check('the preserved copy sits immediately below the winner',
    blocks[0]?.text === 'Vectors are arrows. Priya edit.' &&
      blocks[1]?.text === 'Sam wrote something else entirely.',
    JSON.stringify(blocks.map((x) => [x.position, x.text])));

  // ── deletion is an empty update ──────────────────────────────────────────
  console.log('\ndeleting a paragraph');
  const removed = await emit(a, 'notes:block_update', {
    blockId: block1,
    text: '',
    baseVersion: blocks[0].version,
  });
  check('emptying a block removes it', removed.ok === true, JSON.stringify(removed));
  const afterDelete = await emit(a, 'room:resync', {});
  check('the document is one paragraph shorter',
    (afterDelete.snapshot?.notes.blocks ?? []).length === 1,
    JSON.stringify(afterDelete.snapshot?.notes.blocks));

  // ── soft locks ───────────────────────────────────────────────────────────
  console.log('\nblock locks');
  const survivor = afterDelete.snapshot.notes.blocks[0].id;
  const lockSeen = once(b, 'notes:block_locked');
  a.emit('notes:block_focus', { blockId: survivor });
  const lock = await lockSeen;
  check('focusing a block broadcasts a lock', lock?.blockId === survivor && lock?.userId === priya.userId,
    JSON.stringify(lock));
  check('the lock has a deadline in server time', typeof lock?.untilServerMs === 'number' && lock.untilServerMs > Date.now());

  const contested = once(a, 'notes:block_locked');
  b.emit('notes:block_focus', { blockId: survivor });
  const held = await contested;
  check('a contested lock still names the original holder', held?.userId === priya.userId, JSON.stringify(held));

  // ── timestamped items (§3.6 S3) ──────────────────────────────────────────
  console.log('\nnote items');
  const itemSeen = once(b, 'notes:item_created');
  const created = await emit(a, 'notes:item_create', {
    kind: 'question',
    body: 'Why is the determinant the area scale factor?',
    videoTs: 752.5,
  });
  check('a question is created', created.ok === true, JSON.stringify(created));
  check('the timestamp round-trips exactly', created.data?.videoTs === 752.5, JSON.stringify(created.data));
  check('the author is stamped from the session', created.data?.author?.id === priya.userId);
  const itemEvent = await itemSeen;
  check('the room is told', itemEvent?.item?.id === created.data.id);

  const resolvedSeen = once(a, 'notes:item_updated');
  const resolved = await emit(b, 'notes:item_update', { id: created.data.id, resolved: true });
  check('anyone can mark a question answered', resolved.ok === true, JSON.stringify(resolved));
  const resolvedEvent = await resolvedSeen;
  check('resolution is broadcast with a timestamp', resolvedEvent?.item?.resolvedAt !== null,
    JSON.stringify(resolvedEvent?.item));

  const editOther = await emit(b, 'notes:item_update', { id: created.data.id, body: 'hijacked' });
  check('only the author can edit the text',
    editOther.ok === false && editOther.code === 'not_permitted',
    JSON.stringify(editOther));

  const bookmark = await emit(b, 'notes:item_create', { kind: 'bookmark', body: 'start here' });
  check('an item with no timestamp is allowed', bookmark.ok === true && bookmark.data.videoTs === null,
    JSON.stringify(bookmark.data));

  const deleteOthers = await emit(b, 'notes:item_delete', { id: created.data.id });
  check("a member cannot delete the host's question",
    deleteOthers.ok === false && deleteOthers.code === 'not_permitted',
    JSON.stringify(deleteOthers));

  const deleteOwn = await emit(b, 'notes:item_delete', { id: bookmark.data.id });
  check('an author can delete their own', deleteOwn.ok === true, JSON.stringify(deleteOwn));

  const deleteAsHost = await emit(a, 'notes:item_delete', { id: created.data.id });
  check('the host can delete anything', deleteAsHost.ok === true);

  // ── checklist (§3.6 S6) ──────────────────────────────────────────────────
  console.log('\nchecklist');
  const one = await emit(a, 'checklist:create', { label: 'Watch chapter 1' });
  const two = await emit(a, 'checklist:create', { label: 'Do the exercises' });
  check('items are created', one.ok === true && two.ok === true);
  check('positions are increasing', two.data.position > one.data.position,
    `${one.data?.position} → ${two.data?.position}`);

  const toggleSeen = once(b, 'checklist:updated');
  const ticked = await emit(b, 'checklist:toggle', { id: one.data.id, completed: true });
  check('anyone can tick an item', ticked.ok === true, JSON.stringify(ticked));
  const toggleEvent = await toggleSeen;
  check('completion is attributed', toggleEvent?.item?.completedBy?.id === sam.userId,
    JSON.stringify(toggleEvent?.item));

  // §3.6 S6: two clients ticking the same item must converge, not diverge.
  const converge = collect(a, 'checklist:updated', 700);
  await Promise.all([
    emit(a, 'checklist:toggle', { id: two.data.id, completed: true }),
    emit(b, 'checklist:toggle', { id: two.data.id, completed: true }),
  ]);
  const events = await converge;
  const finalStates = events.filter((e) => e.item.id === two.data.id).map((e) => e.item.completedAt !== null);
  check('concurrent ticks converge on the same state',
    finalStates.length > 0 && finalStates.every((v) => v === true),
    JSON.stringify(finalStates));

  // A fractional index puts an item between two others in ONE write.
  const between = (one.data.position + two.data.position) / 2;
  const moved = await emit(a, 'checklist:reorder', { id: two.data.id, position: between });
  check('reorder is accepted', moved.ok === true, JSON.stringify(moved));
  const afterMove = await emit(b, 'room:resync', {});
  check('the reorder is durable and ordered',
    (afterMove.snapshot?.checklist ?? []).map((i) => i.label).join(' | ') ===
      'Watch chapter 1 | Do the exercises',
    JSON.stringify((afterMove.snapshot?.checklist ?? []).map((i) => [i.position, i.label])));

  const deleteOthersItem = await emit(b, 'checklist:delete', { id: one.data.id });
  check("a member cannot delete the host's checklist item",
    deleteOthersItem.ok === false && deleteOthersItem.code === 'not_permitted',
    JSON.stringify(deleteOthersItem));

  // ── cross-room isolation (§11.2 IDOR) ────────────────────────────────────
  console.log('\nisolation');
  const other = await createRoom(priya.cookie, `Other room ${Date.now()}`);
  const c = await connect(priya.cookie);
  await emit(c, 'room:join', { roomCode: other.code });
  const reach = await emit(c, 'checklist:toggle', { id: one.data.id, completed: false });
  check("an id from another room cannot be reached",
    reach.ok === false && reach.code === 'not_found',
    JSON.stringify(reach));

  // ── durability ───────────────────────────────────────────────────────────
  console.log('\ndurable write-behind');
  await emit(a, 'notes:block_update', {
    blockId: survivor,
    text: 'Final text for the durability check.',
    baseVersion: afterDelete.snapshot.notes.blocks[0].version,
  });
  // The notes queue is a 2s debounce; this is the one place a wait is the
  // subject of the assertion rather than a way of hiding a race.
  await new Promise((r) => setTimeout(r, 2600));
  const { prisma } = await import('@syncstudy/db');
  const row = await prisma.roomNotes.findUnique({ where: { roomId: room.id } });
  check('the document reached Postgres', row !== null, 'no room_notes row');
  check('the durable copy is the serialised blocks',
    row?.content === 'Final text for the durability check.',
    JSON.stringify(row?.content));
  check('the durable version tracks the live one', Number(row?.version ?? 0) > 0, String(row?.version));
  await prisma.$disconnect();
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
