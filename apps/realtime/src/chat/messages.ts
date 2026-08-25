/**
 * The `messages` table (PLAN.md §3.5, §6.5, §7.2).
 *
 * Reads are on paths that are allowed to be slow — a join, or a scroll-up that
 * shows a spinner. Writes are never on the broadcast path: they go through the
 * queue in `writeBehind.ts`.
 *
 * Ordering everywhere is by `id`, never by `created_at`. Ids are uuidv7, so the
 * id order *is* time order, and it is a total order — two messages that land in
 * the same millisecond still have exactly one correct sequence, on every client,
 * forever. `created_at` has neither property.
 */
import { prisma, Prisma, MESSAGE_SELECT, toMessageView } from '@syncstudy/db';
import type { MessageView } from '@syncstudy/shared';

export interface MessagePage {
  /** Oldest first — the order the transcript renders in. */
  messages: MessageView[];
  /** True when another page exists in the direction that was asked for. */
  hasMore: boolean;
}

export interface ListMessagesOptions {
  /** Older than this id, exclusive. Scroll-up pagination. */
  before?: string;
  /** Newer than this id, exclusive. Reconnect backfill. */
  after?: string;
  limit: number;
}

/**
 * One page of a room's transcript.
 *
 * Always fetched newest-first and reversed, including for `after`. A stale
 * cursor from a client that was away for an hour must yield the *newest* page it
 * has not seen, not the oldest — otherwise a long outage in a busy room reopens
 * the chat an hour in the past.
 */
export async function listMessages(
  roomId: string,
  opts: ListMessagesOptions,
): Promise<MessagePage> {
  const idFilter: Prisma.StringFilter = {};
  if (opts.before !== undefined) idFilter.lt = opts.before;
  if (opts.after !== undefined) idFilter.gt = opts.after;

  const rows = await prisma.message.findMany({
    where: {
      roomId,
      ...(opts.before === undefined && opts.after === undefined ? {} : { id: idFilter }),
    },
    select: MESSAGE_SELECT,
    orderBy: { id: 'desc' },
    // One extra row is the cheapest possible "is there more?" — cheaper than a
    // second COUNT query, and it cannot disagree with the page it describes.
    take: opts.limit + 1,
  });

  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  // An explicit arrow, not a bare reference: `Array#map` would hand the index in
  // as the optional second argument, which here is the avatar resolver.
  return { messages: page.reverse().map((row) => toMessageView(row)), hasMore };
}

export interface PendingMessage {
  id: string;
  roomId: string;
  userId: string | null;
  clientMsgId: string | null;
  body: string;
  kind: 'user' | 'system';
  replyToId: string | null;
  videoTs: number | null;
  createdAt: Date;
}

/**
 * The write-behind sink.
 *
 * `skipDuplicates` is what makes an optimistic-send retry idempotent: the
 * `(room_id, user_id, client_msg_id)` unique index turns a duplicate INSERT into
 * a no-op instead of an error that would fail the whole batch and take nine
 * innocent messages down with it.
 */
export async function insertMessages(batch: PendingMessage[]): Promise<void> {
  if (batch.length === 0) return;
  await prisma.message.createMany({ data: batch, skipDuplicates: true });
}

/**
 * The row a `chat:delete` is about — enough to authorize the delete and to
 * freeze a copy into a report.
 */
export async function findMessageForModeration(
  messageId: string,
): Promise<{ id: string; roomId: string; userId: string | null; body: string; deletedAt: Date | null } | null> {
  const read = async (): Promise<{
    id: string;
    roomId: string;
    userId: string | null;
    body: string;
    deletedAt: Date | null;
  } | null> =>
    prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, roomId: true, userId: true, body: true, deletedAt: true },
    });

  const found = await read();
  if (found !== null) return found;

  // A miss can mean "no such message" or "written by another node and still in
  // that node's queue". The caller has already drained its OWN queue, so one
  // short retry is what covers the second case. A moderation action may spend
  // 150 ms; silently refusing to delete something that exists may not.
  await new Promise((resolve) => setTimeout(resolve, 150));
  return read();
}

/**
 * Tombstone a message. Returns false when it was already deleted, so a double
 * click does not broadcast twice.
 */
export async function softDeleteMessage(messageId: string, by: string): Promise<boolean> {
  const result = await prisma.message.updateMany({
    where: { id: messageId, deletedAt: null },
    data: { deletedAt: new Date(), deletedBy: by },
  });
  return result.count > 0;
}
