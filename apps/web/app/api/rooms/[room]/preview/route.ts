/**
 * GET /api/rooms/:code/preview — PLAN.md §2.2, §10.1, §11.3.
 *
 * The one room route with no auth requirement, and the reason is a real user:
 * a student is handed a link, has no account yet, and is being asked to sign up
 * for something they cannot see. This answers "what am I joining" — a name, a
 * topic, who is hosting, how many people are in there — and nothing else.
 *
 * It is also the room-code enumeration surface, so it is the most carefully
 * limited route in the app:
 *
 *  - two IP windows, 20/min AND 200/day (§11.3), both fail-closed;
 *  - one identical 404 for an unknown code, a malformed code, and a code the
 *    caller may not resolve, so the response never confirms a hit;
 *  - the room id NEVER leaves this handler. `roomId` is what the socket
 *    namespace is keyed on, and handing it to an unauthenticated caller would
 *    turn a "does this code exist" oracle into a room-channel address.
 */
import { prisma } from '@syncstudy/db';
import { ok } from '@/lib/server/respond';
import { clientIpHash } from '@/lib/server/request';
import { getCurrentSession } from '@/lib/server/session';
import {
  parseRoomRef,
  roomLimitOr429,
  roomNotFound,
  roomRoute,
  ROOM_PREVIEW_SELECT,
  toRoomPreview,
  type RoomPreview,
} from '@/lib/server/rooms';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export type RoomPreviewResponse = RoomPreview;

export const GET = roomRoute(async (req, segment) => {
  const ipHash = clientIpHash(req.headers);

  // Minute first, then day: a caller already over the burst limit should not
  // also spend from the daily allowance while being told to slow down.
  const burstLimited = roomLimitOr429('rooms:preview:ip:minute', ipHash);
  if (burstLimited !== null) return burstLimited;
  const dailyLimited = roomLimitOr429('rooms:preview:ip:day', ipHash);
  if (dailyLimited !== null) return dailyLimited;

  const ref = parseRoomRef(segment);
  // A uuid in the code position is someone probing, not someone with a link.
  if (ref === null || !('code' in ref)) return roomNotFound();

  const room = await prisma.room.findUnique({
    where: { code: ref.code },
    select: ROOM_PREVIEW_SELECT,
  });
  if (room === null) return roomNotFound();

  // Signed in is optional here. `isBanned` and `isMember` are answers about the
  // caller, so with no session there is nobody to answer about and both are false.
  const session = await getCurrentSession();

  let isBanned = false;
  let isMember = false;
  if (session !== null) {
    const viewerId = session.user.id;
    const [ban, participant] = await Promise.all([
      prisma.roomBan.findUnique({
        where: { roomId_userId: { roomId: room.id, userId: viewerId } },
        select: { userId: true },
      }),
      prisma.roomParticipant.findUnique({
        where: { roomId_userId: { roomId: room.id, userId: viewerId } },
        select: { userId: true },
      }),
    ]);
    isBanned = ban !== null;
    // The host is a member of their own room even if the row ever drifted.
    isMember = participant !== null || room.hostId === viewerId;
  }

  // `toRoomPreview` is where the id and the passcode hash are dropped. It is a
  // pure function with a test, so that guarantee is checked rather than assumed.
  const body: RoomPreviewResponse = toRoomPreview(room, { isBanned, isMember });
  return ok(body);
});
