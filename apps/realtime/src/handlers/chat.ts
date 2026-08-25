/**
 * Chat handlers (PLAN.md §3.5, §6.5, §11.2, §14 Phase 5).
 *
 * The handlers are thin on purpose: `guardRoomEvent` has already rate-limited,
 * validated, resolved the room and asserted `chat.send` against the role Redis
 * holds right now, and `ChatService` owns id assignment, dedupe and the
 * broadcast-then-persist order. What is left here is the policy that is specific
 * to chat — the room lock, reply targets, and who may delete whose message.
 */
import { Schemas, can, canActOn } from '@syncstudy/shared';
import type { Ack, MessageView } from '@syncstudy/shared';
import { z } from 'zod';
import { findMessageForModeration, softDeleteMessage } from '../chat/messages.js';
import { prisma } from '@syncstudy/db';
import {
  guardRoomEvent,
  roomChannel,
  runHandler,
  type AppContext,
  type TypedSocket,
} from './context.js';

export function registerChatHandlers(ctx: AppContext, socket: TypedSocket): void {
  socket.on('chat:send', (payload, ack) => {
    runHandler(
      ctx,
      socket,
      'chat:send',
      async () => {
        const guard = await guardRoomEvent(ctx, socket, 'chat:send', payload, {
          schema: Schemas.ChatSend,
          permission: 'chat.send',
        });
        if (!guard.ok) {
          ack({ ok: false, code: guard.failure.code, message: guard.failure.message });
          return;
        }

        const { policy } = guard.session.meta;
        // A locked room is readable, not writable — except by the people who can
        // unlock it. Asked through `can()` rather than by comparing role strings:
        // `resolvePermissions.canSendChat` derives the same answer from the same
        // permission, and the client greys the composer out from that. Two
        // spellings of one rule stay in step right up until the grants change.
        const moderator = can(guard.session.role, 'chat.delete.any');
        if (policy.chatLocked && !moderator) {
          ack({ ok: false, code: 'chat_locked', message: 'The host has locked chat.' });
          return;
        }

        const { clientMsgId, body, replyToId, videoTs } = guard.payload;

        // Replies are v1.1 (§3.5 H7) and no client sends this yet, but the field
        // is in the contract and the column exists — so a crafted payload must
        // not be able to point a message in this room at a message in another
        // one. Verified rather than ignored.
        if (replyToId !== undefined) {
          const target = await prisma.message.findUnique({
            where: { id: replyToId },
            select: { roomId: true },
          });
          if (!target || target.roomId !== guard.session.roomId) {
            ack({ ok: false, code: 'bad_payload', message: 'That message is not in this room.' });
            return;
          }
        }

        const result = await ctx.chat.send({
          roomId: guard.session.roomId,
          author: {
            id: socket.data.userId,
            handle: socket.data.handle,
            displayName: socket.data.displayName,
            avatarUrl: socket.data.avatarUrl,
          },
          clientMsgId,
          body,
          replyToId: replyToId ?? null,
          videoTs: videoTs ?? null,
          bypassSlowMode: moderator,
          slowModeSec: policy.slowModeSec,
        });

        if ('code' in result) {
          ack({ ok: false, code: result.code, message: result.message });
          return;
        }
        ack({ ok: true, data: result } satisfies Ack<MessageView>);
      },
      (failure) => ack({ ok: false, code: failure.code, message: failure.message }),
    );
  });

  socket.on('chat:delete', (payload, ack) => {
    runHandler(
      ctx,
      socket,
      'chat:delete',
      async () => {
        const guard = await guardRoomEvent(ctx, socket, 'chat:delete', payload, {
          schema: Schemas.ChatDelete,
        });
        if (!guard.ok) {
          ack({ ok: false, code: guard.failure.code, message: guard.failure.message });
          return;
        }

        const userId = socket.data.userId;
        // Land this node's queued writes before reading. Without this, deleting
        // a message you sent a moment ago answers "that message no longer
        // exists" — the row is still in the write-behind queue, and the delete
        // reads Postgres. Found on the live stack; invisible to typecheck, and
        // invisible to any test that sleeps first.
        await ctx.chat.settle();
        const message = await findMessageForModeration(guard.payload.messageId);
        // Same answer for "no such message" and "not in your room": the id space
        // must not confirm that a message exists somewhere you cannot see.
        if (!message || message.roomId !== guard.session.roomId) {
          ack({ ok: false, code: 'not_found', message: 'That message no longer exists.' });
          return;
        }
        if (message.deletedAt !== null) {
          // Already gone. Succeed — the caller's intent is satisfied — but do
          // not broadcast a second tombstone for it.
          ack({ ok: true });
          return;
        }

        const own = message.userId === userId;
        if (!own) {
          if (!can(guard.session.role, 'chat.delete.any')) {
            ack({ ok: false, code: 'not_permitted', message: 'You cannot delete that message.' });
            return;
          }
          // §11.2: a moderator acts only on someone strictly below them, so a
          // co-host cannot delete the host's message. An author who has left the
          // room has no live role to compare against and is treated as a member,
          // which is what they were when they wrote it.
          const author =
            message.userId === null
              ? null
              : await ctx.store.getParticipant(guard.session.roomId, message.userId);
          const authorRole = author?.role ?? 'member';
          if (!canActOn(guard.session.role, authorRole)) {
            ack({ ok: false, code: 'not_permitted', message: 'You cannot delete that message.' });
            return;
          }
        }

        // The one chat write that is NOT write-behind. A delete is a moderation
        // action: if it does not reach Postgres, it did not happen, and telling
        // six people a message is gone while it waits in a queue that might drop
        // it is the wrong way round.
        const deleted = await softDeleteMessage(message.id, userId);
        if (deleted) {
          ctx.io
            .to(roomChannel(guard.session.roomId))
            .emit('chat:deleted', { messageId: message.id, by: userId });
        }
        ack({ ok: true });
      },
      (failure) => ack({ ok: false, code: failure.code, message: failure.message }),
    );
  });

  socket.on('chat:typing', (payload) => {
    runHandler(ctx, socket, 'chat:typing', async () => {
      const guard = await guardRoomEvent(ctx, socket, 'chat:typing', payload, {
        schema: z.object({}),
        permission: 'chat.send',
      });
      if (!guard.ok) return;
      // `socket.to`, not `io.to`: nobody needs to be told they are typing.
      // The indicator itself is v1.1 (§3.5 H9) — this completes the server side
      // of the contract, and no client renders it yet.
      socket.to(roomChannel(guard.session.roomId)).emit('chat:typing', { userId: socket.data.userId });
    });
  });
}
