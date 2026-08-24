/**
 * POST /api/rooms/:code/join — PLAN.md §2.2, §3.2 R8, §10.1, §11.3.
 *
 * A PRE-FLIGHT CHECK, not an admission. It writes no membership row: the socket
 * path does that at the moment the user is actually present, and it re-verifies
 * membership, bans and capacity from scratch anyway (§11.3 "ghost joins"), with
 * the atomic capacity check living in Redis.
 *
 * What this route buys is a straight answer before a WebSocket is opened —
 * banned, full, ended, wrong passcode — on a page that can render it inline
 * rather than as a socket error after the room has already painted.
 *
 * Refusals, in the order they are decided:
 *   404 not_found          unknown or malformed code
 *   410 room_ended         / room_archived
 *   403 banned             the ban list is checked here AND at the handshake
 *   403 passcode_required  / passcode_incorrect
 *   409 room_full          capacity, from which the host and members are exempt
 */
import type { NextRequest } from 'next/server';
import { prisma } from '@syncstudy/db';
import { verifyPassword } from '@syncstudy/auth';
import { HttpProblem, ok } from '@/lib/server/respond';
import { clientIpHash, requireSameOrigin } from '@/lib/server/request';
import { requireApiSession } from '@/lib/server/session';
import {
  canAdmit,
  parseRoomRef,
  readPasscode,
  roomFail,
  roomGone,
  roomLimitOr429,
  roomNotFound,
  roomRoleFor,
  roomRoute,
  asRoomStatus,
  type Role,
} from '@/lib/server/rooms';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface JoinRoomResponse {
  roomId: string;
  code: string;
  role: Role;
}

const JOIN_ROOM_SELECT = {
  id: true,
  code: true,
  hostId: true,
  status: true,
  maxParticipants: true,
  passcodeHash: true,
  _count: { select: { participants: { where: { leftAt: null } } } },
} as const;

/**
 * The passcode is optional, so a bodyless POST is the ordinary case and
 * `readJson`'s `content-type` requirement would reject it. `requireSameOrigin`
 * above is the CSRF control on this route; the header check is not load-bearing.
 */
async function readJoinBody(req: NextRequest): Promise<unknown> {
  const raw = await req.text();
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new HttpProblem('bad_request', 'That request body was not valid JSON.');
  }
}

export const POST = roomRoute(async (req, segment) => {
  requireSameOrigin(req);

  const { session } = await requireApiSession();
  const userId = session.user.id;

  const limited = roomLimitOr429('rooms:join:user', userId);
  if (limited !== null) return limited;

  // Join is a second room-code oracle: its refusals are fully distinguishable
  // (404 unknown, 410 ended, 403 banned, 409 full, 200 hit). Metering it only
  // per-user would let anyone with one account probe faster here than /preview
  // allows, so code probes spend from the SAME IP budget regardless of which
  // route they arrive on (§11.3).
  const ipHash = clientIpHash(req.headers);
  for (const scope of ['rooms:preview:ip:minute', 'rooms:preview:ip:day'] as const) {
    const byIp = roomLimitOr429(scope, ipHash ?? 'unknown');
    if (byIp !== null) return byIp;
  }

  const ref = parseRoomRef(segment);
  if (ref === null || !('code' in ref)) return roomNotFound();

  const room = await prisma.room.findUnique({
    where: { code: ref.code },
    select: JOIN_ROOM_SELECT,
  });
  if (room === null) return roomNotFound();

  const gone = roomGone(asRoomStatus(room.status));
  if (gone !== null) return gone;

  const [ban, participant] = await Promise.all([
    prisma.roomBan.findUnique({
      where: { roomId_userId: { roomId: room.id, userId } },
      select: { userId: true },
    }),
    prisma.roomParticipant.findUnique({
      where: { roomId_userId: { roomId: room.id, userId } },
      select: { role: true },
    }),
  ]);

  if (ban !== null) {
    // No detail, and the same wording the socket uses. A ban is not a
    // negotiation and the reason belongs between the host and the person.
    return roomFail('banned', 'You cannot join this room.', 403);
  }

  const isHost = room.hostId === userId;

  // §3.2 R3. Everyone but the host presents it — including a member who joined
  // before the passcode was set, which is the whole point of setting one.
  if (room.passcodeHash !== null && !isHost) {
    const attemptLimited = roomLimitOr429(
      'rooms:passcode:ip-code',
      `${clientIpHash(req.headers) ?? 'unknown'}:${room.code}`,
    );
    if (attemptLimited !== null) return attemptLimited;

    const passcode = readPasscode(await readJoinBody(req));
    if (passcode === null) {
      return roomFail('passcode_required', 'This room needs its passcode.', 403);
    }
    if (!(await verifyPassword(room.passcodeHash, passcode))) {
      return roomFail('passcode_incorrect', 'That passcode is not right.', 403);
    }
  }

  // Advisory only — the authoritative atomic check is in Redis on the socket
  // path. See `countsAreApproximate` in lib/server/rooms.ts for what drifts.
  const admitted = canAdmit({
    occupancy: room._count.participants,
    maxParticipants: room.maxParticipants,
    isHost,
    isExistingMember: participant !== null,
  });
  if (!admitted) {
    return roomFail(
      'room_full',
      `This room is full (${room.maxParticipants}/${room.maxParticipants}).`,
      409,
    );
  }

  // This route is a PRE-FLIGHT CHECK. It deliberately does not open a
  // membership row.
  //
  // `left_at` has exactly one writer — `recordLeave` in the realtime service,
  // reached from the socket disconnect path. A row opened here is a row only a
  // socket can ever close, so every join that stops at this step (the user
  // closes the tab on the passcode screen, the socket never connects, the
  // handshake is refused) leaves a member who is permanently "present". Since
  // this same route counts those open rows as a hard 409 capacity gate, enough
  // of them lock the room shut for everyone with nobody in it.
  //
  // `recordJoin` on the socket path already upserts the row at the moment the
  // user is genuinely present, and `resolveMembership` treats a missing row as
  // 'member' — so nothing downstream needs a row to exist before then.
  await prisma.room.update({ where: { id: room.id }, data: { lastActiveAt: new Date() } });

  const role: Role = roomRoleFor(room, userId, participant?.role ?? null);

  const body: JoinRoomResponse = {
    roomId: room.id,
    code: room.code,
    // A brand-new row is a member; an existing one keeps whatever it held, and
    // the host FK outranks both.
    role: participant === null && !isHost ? 'member' : role,
  };
  return ok(body);
});
