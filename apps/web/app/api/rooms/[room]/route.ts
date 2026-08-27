/**
 * /api/rooms/:id — PATCH (policy) and DELETE (end the room).
 * PLAN.md §3.2 R7, §10.1, §11.2.
 *
 * Both are host-only, and "host" means `rooms.host_id === session.user.id`.
 * Nothing in the request body participates in that decision — §11.2 is explicit
 * that a `{userId}` or `{role}` field in a payload is a red flag, and the same
 * reasoning applies to a room id: the id selects the row, the session decides
 * whether the caller may write it.
 *
 * Co-hosts change policy over the socket (`host:update_policy`), not here. The
 * split is deliberate: a policy change has to reach everyone in the room in the
 * same instant, and only the socket layer can do that. This route exists for the
 * host editing a room they are not currently sitting in.
 */
import { prisma } from '@syncstudy/db';
import { Schemas } from '@syncstudy/shared';
import { noContent, ok } from '@/lib/server/respond';
import { readJson, requireSameOrigin } from '@/lib/server/request';
import { requireApiSession } from '@/lib/server/session';
import { invalidateRoomCache } from '@/lib/server/realtime-cache';
import {
  asRoomStatus,
  normalizeTopic,
  parseRoomRef,
  roomGone,
  roomNotFound,
  roomRoute,
  ROOM_SUMMARY_SELECT,
  toRoomSummary,
  type RoomSummary,
} from '@/lib/server/rooms';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface UpdateRoomResponse {
  room: RoomSummary;
}

// `code` is here so a status/policy change can invalidate `code:{code}` as well
// as `room:{id}:meta` in the realtime service's cache.
const OWNER_SELECT = { id: true, code: true, hostId: true, status: true } as const;

/**
 * PATCH /api/rooms/:id — partial policy update.
 *
 * The body is `Schemas.UpdateRoomPolicyInput`, so the set of writable columns is
 * fixed by the shared schema rather than by this file. `host_id`, `code`,
 * `status` and `privacy` are not in it, which is what stops a policy PATCH from
 * becoming a host transfer, a code rotation or an un-end.
 */
export const PATCH = roomRoute(async (req, segment) => {
  requireSameOrigin(req);

  const { session } = await requireApiSession();
  const viewerId = session.user.id;

  const ref = parseRoomRef(segment);
  if (ref === null) return roomNotFound();

  const room = await prisma.room.findUnique({ where: ref, select: OWNER_SELECT });
  // One 404 for "no such room" AND "exists but isn't yours".
  //
  // `parseRoomRef` accepts a room CODE here as well as a uuid, so a 403 on this
  // route would be a free, unmetered room-code oracle: bodyless PATCHes would
  // answer 403 for codes that exist and 404 for codes that do not, which is
  // exactly what the rate limits on /preview exist to prevent (§11.3).
  if (room === null || room.hostId !== viewerId) return roomNotFound();

  const gone = roomGone(asRoomStatus(room.status));
  if (gone !== null) return gone;

  const input = Schemas.UpdateRoomPolicyInput.parse(await readJson(req));
  const topic = normalizeTopic(input.topic);

  // Forward only the keys that were actually sent. Under
  // `exactOptionalPropertyTypes` a present-but-undefined key is not the same
  // type as an absent one, and Prisma would treat `{ name: undefined }` as
  // "leave alone" only by accident. Same shape as `updateRoomPolicy` in the
  // realtime service, so the two paths cannot drift.
  const data: Record<string, string | number | boolean | null> = {};
  if (input.name !== undefined) data['name'] = input.name;
  if (topic !== undefined) data['topic'] = topic;
  if (input.playbackControl !== undefined) data['playbackControl'] = input.playbackControl;
  if (input.chatLocked !== undefined) data['chatLocked'] = input.chatLocked;
  if (input.slowModeSec !== undefined) data['slowModeSec'] = input.slowModeSec;
  if (input.waitForSlow !== undefined) data['waitForSlow'] = input.waitForSlow;
  if (input.callEnabled !== undefined) data['callEnabled'] = input.callEnabled;
  if (input.screenshareEnabled !== undefined) data['screenshareEnabled'] = input.screenshareEnabled;
  if (input.annotationsEnabled !== undefined) data['annotationsEnabled'] = input.annotationsEnabled;
  // Lowering this below the current occupancy is allowed and does not evict
  // anyone: it stops the NEXT join. Kicking someone is a moderation action with
  // its own audit trail, not a side effect of editing a number.
  if (input.maxParticipants !== undefined) data['maxParticipants'] = input.maxParticipants;

  if (Object.keys(data).length > 0) {
    await prisma.room.update({ where: { id: room.id }, data });
    // The realtime service caches this row for an hour and decides every
    // permission from it. Without this the room keeps enforcing the OLD policy
    // for connected clients — the socket equivalent does the same thing via
    // `ctx.meta.refresh` (apps/realtime/src/handlers/host.ts).
    await invalidateRoomCache(room.id, room.code);
  }

  // Re-read rather than returning the update's own row: the summary carries a
  // participant count, and one query that is obviously correct beats a clever one.
  const updated = await prisma.room.findUnique({
    where: { id: room.id },
    select: ROOM_SUMMARY_SELECT,
  });
  if (updated === null) return roomNotFound();

  const body: UpdateRoomResponse = { room: toRoomSummary(updated, viewerId, 'host') };
  return ok(body);
});

/**
 * DELETE /api/rooms/:id — end the room for everyone (§3.2 R7).
 *
 * A status change, never a delete. The chat, the shared notes, the checklist and
 * every `room_participants` row stay exactly where they are: people came here to
 * study, and ending a session is not a request to destroy what they wrote in it
 * (§3.2 R9 keeps an ended room readable). Nothing here cascades.
 *
 * Idempotent — ending an already-ended room is a 204, not a 410. The host
 * clicking twice, or a retried request, should not produce an error page for an
 * outcome that already holds.
 */
export const DELETE = roomRoute(async (req, segment) => {
  requireSameOrigin(req);

  const { session } = await requireApiSession();

  const ref = parseRoomRef(segment);
  if (ref === null) return roomNotFound();

  const room = await prisma.room.findUnique({ where: ref, select: OWNER_SELECT });
  // One 404 for both cases, for the same oracle reason as PATCH above.
  if (room === null || room.hostId !== session.user.id) return roomNotFound();
  if (asRoomStatus(room.status) !== 'active') return noContent();

  const now = new Date();
  await prisma.$transaction([
    prisma.room.update({
      where: { id: room.id },
      data: { status: 'ended', endedAt: now },
    }),
    // Close the open memberships in the same breath. Leaving them open would
    // make `participantCount` claim an ended room is occupied for ever, since
    // the socket layer — which normally writes `left_at` — may never see this
    // room again.
    prisma.roomParticipant.updateMany({
      where: { roomId: room.id, leftAt: null },
      data: { leftAt: now },
    }),
  ]);

  // Ending a room in Postgres does not end it for anyone still connected: the
  // socket layer reads `status` from the cached row and would keep admitting
  // joins for up to the cache TTL. This is the line that makes the button work.
  await invalidateRoomCache(room.id, room.code);

  return noContent();
});
