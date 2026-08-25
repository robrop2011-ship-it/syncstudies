/**
 * GET /api/rooms/:id/messages — one page of transcript, older first.
 * PLAN.md §3.5 H3, §10.1, §14 Phase 5.3.
 *
 * Scroll-up pagination only. The live tail arrives over the socket, and the last
 * page arrives inside `room:join`'s snapshot; this route exists for the pages
 * *behind* that — the ones a client asks for when someone drags the scrollbar to
 * the top of the list.
 *
 * The cursor is a message id, not an offset or a timestamp. Ids are uuidv7, so
 * `id < cursor` is "strictly older than" with no ties to break, and — unlike an
 * offset — a page cannot shift under the reader when someone posts while they
 * are scrolling.
 *
 * Authorization is membership, not presence: you may read the history of a room
 * you belong to whether or not you are sitting in it right now, and a ban ends
 * that. `guest` — no participant row at all — reads nothing, which is what stops
 * this becoming a way to read any room whose id you can guess.
 */
import type { NextRequest } from 'next/server';
import { prisma } from '@syncstudy/db';
import { MESSAGE_PAGE_SIZE, type MessageView } from '@syncstudy/shared';
import { fail, ok } from '@/lib/server/respond';
import { requireApiSession } from '@/lib/server/session';
import {
  parseRoomRef,
  roomLimitOr429,
  roomNotFound,
  roomRoute,
} from '@/lib/server/rooms';
import { toMessageView, MESSAGE_SELECT } from '@/lib/server/messages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface MessagePageResponse {
  messages: MessageView[];
  /** True when an older page exists behind this one. */
  hasMore: boolean;
  /** Pass back as `?before=`. Null when the transcript starts here. */
  nextCursor: string | null;
}

/** A uuid, and nothing else — this value goes into a WHERE clause. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET = roomRoute(async (req: NextRequest, segment) => {
  const { session } = await requireApiSession();
  const viewerId = session.user.id;

  const ref = parseRoomRef(segment);
  if (ref === null) return roomNotFound();

  const limited = roomLimitOr429('rooms:messages:user', viewerId);
  if (limited !== null) return limited;

  const room = await prisma.room.findUnique({
    where: ref,
    select: {
      id: true,
      status: true,
      hostId: true,
      participants: { where: { userId: viewerId }, select: { role: true } },
      bans: { where: { userId: viewerId }, select: { userId: true } },
    },
  });
  // One 404 for "no such room" and for "not yours to read" — the same rule the
  // rest of the room routes follow, so this cannot become a room-id oracle.
  if (room === null) return roomNotFound();
  if (room.bans.length > 0) return roomNotFound();
  if (room.hostId !== viewerId && room.participants.length === 0) return roomNotFound();

  // Note what is NOT checked: room status. An ended or archived room is still
  // readable by the people who were in it — that is the whole point of archiving
  // rather than deleting (§7.4, §8.11) — so `roomGone`, which every write route
  // calls, is deliberately absent here.

  const url = new URL(req.url);
  const before = url.searchParams.get('before');
  if (before !== null && !UUID.test(before)) {
    return fail('bad_request', 'That cursor is not valid.');
  }

  // Clamped, not trusted. `?limit=` is in the §10.1 contract, but an unbounded
  // one is a free way to ask this process to materialise a whole room's history
  // in memory; anything outside the range collapses to the default rather than
  // erroring, because a client asking for 10 000 wants "as many as you'll give".
  const requested = Number(url.searchParams.get('limit'));
  const limit =
    Number.isInteger(requested) && requested > 0
      ? Math.min(requested, MESSAGE_PAGE_SIZE)
      : MESSAGE_PAGE_SIZE;

  const rows = await prisma.message.findMany({
    where: { roomId: room.id, ...(before === null ? {} : { id: { lt: before } }) },
    select: MESSAGE_SELECT,
    orderBy: { id: 'desc' },
    // One extra row answers "is there more?" without a second query that could
    // disagree with the page it describes.
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const page = (hasMore ? rows.slice(0, limit) : rows).reverse();
  const oldest = page[0];

  return ok<MessagePageResponse>({
    messages: page.map(toMessageView),
    hasMore,
    nextCursor: hasMore && oldest !== undefined ? oldest.id : null,
  });
});
