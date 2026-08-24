/**
 * Chat — Phase 5 (PLAN.md §14).
 *
 * The handlers are registered for real: authentication, the room guard, payload
 * validation and rate limiting all run exactly as they will in the finished
 * feature. Only the body is missing, and it answers with a clear
 * `not_implemented` rather than silently dropping the event — a client that
 * hangs waiting for an ack is far harder to debug than one that gets told no.
 *
 * When this is implemented (§6.5): broadcast first with a server-assigned id and
 * timestamp, enqueue the INSERT behind it, and never block the fan-out on the
 * write.
 */
import { Schemas } from '@syncstudy/shared';
import type { Ack, MessageView } from '@syncstudy/shared';
import { z } from 'zod';
import { guardRoomEvent, runHandler, type AppContext, type TypedSocket } from './context.js';

export const NOT_IMPLEMENTED = {
  ok: false as const,
  code: 'not_implemented',
  message: 'Chat is not available yet.',
};

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
        // Phase 5: persist + broadcast. `chatLocked` and `slowModeSec` from
        // `guard.session.meta.policy` are enforced here.
        ack(NOT_IMPLEMENTED satisfies Ack<MessageView>);
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
        // Phase 5: authors delete their own; `chat.delete.any` deletes others'.
        ack(NOT_IMPLEMENTED);
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
      // Phase 5: `socket.to(room).emit('chat:typing', { userId })`.
    });
  });
}
