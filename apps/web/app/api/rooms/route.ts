/**
 * /api/rooms — POST (create) and GET (list) (PLAN.md §3.2, §10.1).
 */
import type { NextRequest } from 'next/server';
import { prisma } from '@syncstudy/db';
import { generateRoomCode, Schemas, uuidv7 } from '@syncstudy/shared';
import { apiHandler, HttpProblem, isUniqueViolation, ok } from '@/lib/server/respond';
import { readJson, requireSameOrigin } from '@/lib/server/request';
import { requireApiSession } from '@/lib/server/session';
import {
  normalizeTopic,
  readScope,
  resolveMaxParticipants,
  roomLimitOr429,
  ROOM_CODE_ATTEMPTS,
  ROOM_LIST_LIMIT,
  ROOM_SUMMARY_SELECT,
  toRoomSummary,
  type RoomSummary,
} from '@/lib/server/rooms';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface CreateRoomResponse {
  room: RoomSummary;
}

export interface RoomListResponse {
  rooms: RoomSummary[];
}

/** The room row as `create` returns it; `_count` is known without asking. */
const CREATED_ROOM_SELECT = {
  id: true,
  code: true,
  name: true,
  topic: true,
  hostId: true,
  status: true,
  maxParticipants: true,
  lastActiveAt: true,
  createdAt: true,
} as const;

/**
 * POST /api/rooms — §3.2 R1, R2.
 *
 * Four rows go in together or none do. A room without its `RoomVideoState` has
 * no anchor to rehydrate from when Redis is cold (§8.11); a room without its
 * `RoomNotes` row has nowhere for Phase 7 to write; a room without its host's
 * `RoomParticipant` row is a room whose creator is not a member of it. Each of
 * those is a bug that only shows up later, in another service, so the
 * transaction is the cheapest place to make them impossible.
 */
export const POST = apiHandler(async (req: NextRequest) => {
  requireSameOrigin(req);

  const { session } = await requireApiSession();
  const limited = roomLimitOr429('rooms:create:user', session.user.id);
  if (limited !== null) return limited;

  const input = Schemas.CreateRoomInput.parse(await readJson(req));
  const topic = normalizeTopic(input.topic);
  const maxParticipants = resolveMaxParticipants(input.maxParticipants);
  const hostId = session.user.id;

  // Generate, insert, and let the unique index decide — never SELECT-then-INSERT.
  // A pre-check answers a question about a moment that has already passed, and
  // two creators racing on the same code would both see "free" and one would
  // still fail. The constraint is the only honest arbiter, so this loop asks it.
  for (let attempt = 0; attempt < ROOM_CODE_ATTEMPTS; attempt += 1) {
    const roomId = uuidv7();
    const code = generateRoomCode();

    try {
      const room = await prisma.$transaction(async (tx) => {
        const created = await tx.room.create({
          data: {
            id: roomId,
            code,
            name: input.name,
            hostId,
            maxParticipants,
            // `exactOptionalPropertyTypes`: an absent key and a present
            // `undefined` are different types, and Prisma reads them the same
            // way only by luck. Spread the ones that were actually sent.
            ...(topic === undefined ? {} : { topic }),
            ...(input.playbackControl === undefined
              ? {}
              : { playbackControl: input.playbackControl }),
          },
          select: CREATED_ROOM_SELECT,
        });

        await tx.roomParticipant.create({
          data: { roomId, userId: hostId, role: 'host' },
        });
        // Defaults only: provider 'none', paused at 0, revision 0.
        await tx.roomVideoState.create({ data: { roomId } });
        await tx.roomNotes.create({ data: { roomId } });

        return created;
      });

      const body: CreateRoomResponse = {
        room: toRoomSummary(
          {
            ...room,
            host: { displayName: session.user.displayName },
            // Exactly one open participant row exists: the host's, written above.
            _count: { participants: 1 },
          },
          hostId,
          'host',
        ),
      };
      return ok(body, 201);
    } catch (error: unknown) {
      // `rooms.code` is the only unique constraint reachable from this
      // transaction — the participant PK, the video-state PK and the notes PK
      // are all keyed on a uuidv7 minted one line above — so a P2002 here is a
      // code collision and nothing else.
      if (isUniqueViolation(error)) continue;
      throw error;
    }
  }

  throw new HttpProblem(
    'internal',
    "Couldn't allocate a room code. Try that again.",
  );
});

/**
 * GET /api/rooms?scope=mine|recent — §3.2 R10.
 *
 * `recent` is driven off `room_participants.last_joined_at`, which is the row
 * §3.2 R8 keeps when you leave. That is what makes "rooms you were in" survive
 * leaving them, and it is why this query starts at the participant table rather
 * than at rooms: the ordering column lives there.
 */
export const GET = apiHandler(async (req: NextRequest) => {
  const { session } = await requireApiSession();
  const viewerId = session.user.id;
  const scope = readScope(req.nextUrl.searchParams.get('scope'));

  if (scope === 'mine') {
    const rows = await prisma.room.findMany({
      where: { hostId: viewerId },
      orderBy: { lastActiveAt: 'desc' },
      take: ROOM_LIST_LIMIT,
      select: ROOM_SUMMARY_SELECT,
    });
    // A room you host you host: `rooms.host_id` outranks any participant row.
    const body: RoomListResponse = {
      rooms: rows.map((row) => toRoomSummary(row, viewerId, 'host')),
    };
    return ok(body);
  }

  const rows = await prisma.roomParticipant.findMany({
    // Ended rooms are gone, not recent. Archived ones stay: their notes and
    // chat are still readable (§3.2 R9), so they belong in the list.
    where: { userId: viewerId, room: { status: { not: 'ended' } } },
    orderBy: { lastJoinedAt: 'desc' },
    take: ROOM_LIST_LIMIT,
    select: { role: true, room: { select: ROOM_SUMMARY_SELECT } },
  });

  const body: RoomListResponse = {
    rooms: rows.map((row) => toRoomSummary(row.room, viewerId, row.role)),
  };
  return ok(body);
});
