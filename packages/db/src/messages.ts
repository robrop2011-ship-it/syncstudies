/**
 * The `messages` row → `MessageView` mapping, in one place.
 *
 * Both services read this table: the realtime service builds the room snapshot
 * and the web app serves scroll-up pagination. Two mappings would be two chances
 * for a deleted message's body to leak from one of them, so there is one, and it
 * lives here because this package is the only one that owns Prisma types.
 *
 * `resolveAvatarUrl` is a parameter rather than a constant because the two
 * callers genuinely differ: the web app resolves `avatar_key` against the asset
 * domain it is configured with, and the realtime service — which has no asset
 * domain by design — passes the key through, exactly as it does for presence.
 */
import type { MessageView } from '@syncstudy/shared';
import { Prisma } from '@prisma/client';

export const MESSAGE_SELECT = {
  id: true,
  roomId: true,
  userId: true,
  clientMsgId: true,
  body: true,
  kind: true,
  replyToId: true,
  videoTs: true,
  deletedAt: true,
  createdAt: true,
  author: {
    select: { id: true, handle: true, displayName: true, avatarKey: true },
  },
} satisfies Prisma.MessageSelect;

export type MessageRow = Prisma.MessageGetPayload<{ select: typeof MESSAGE_SELECT }>;

export type ResolveAvatarUrl = (avatarKey: string | null) => string | null;

const passThrough: ResolveAvatarUrl = (key) => key;

/**
 * A deleted message keeps its place in the transcript and loses its body.
 *
 * §3.5 H10 is a tombstone, not a hard delete: removing the row would silently
 * gap a conversation, and the moderation trail in `reports.snapshot` would point
 * at a row that no longer exists. The body is dropped *here*, on the way out, so
 * a deleted message's text cannot reach a client through a caller that forgot to
 * filter.
 */
export function toMessageView(
  row: MessageRow,
  resolveAvatarUrl: ResolveAvatarUrl = passThrough,
): MessageView {
  const deleted = row.deletedAt !== null;
  return {
    id: row.id,
    roomId: row.roomId,
    author:
      row.author === null
        ? null
        : {
            id: row.author.id,
            handle: row.author.handle,
            displayName: row.author.displayName,
            avatarUrl: resolveAvatarUrl(row.author.avatarKey),
          },
    clientMsgId: row.clientMsgId,
    body: deleted ? '' : row.body,
    kind: row.kind === 'system' ? 'system' : 'user',
    replyToId: row.replyToId,
    videoTs: row.videoTs,
    createdAt: row.createdAt.getTime(),
    deletedAt: row.deletedAt === null ? null : row.deletedAt.getTime(),
  };
}
