/**
 * Shared notes and the checklist — Phase 7 (PLAN.md §8.12, §14).
 *
 * Registered, guarded and rate-limited now; bodies land in Phase 7. The v1
 * design is deliberately not a CRDT: blocks with soft locks and an optimistic
 * per-block version, where a conflict appends the loser's text as a new block
 * rather than dropping it. Worst case is a duplicated paragraph, never lost work.
 */
import { Schemas } from '@syncstudy/shared';
import { z } from 'zod';
import { guardRoomEvent, runHandler, type AppContext, type TypedSocket } from './context.js';

const NOT_IMPLEMENTED = {
  ok: false as const,
  code: 'not_implemented',
  message: 'Shared notes are not available yet.',
};

type FailAck = (result: { ok: false; code: string; message: string }) => void;

export function registerNotesHandlers(ctx: AppContext, socket: TypedSocket): void {
  socket.on('notes:block_focus', (payload) => {
    runHandler(ctx, socket, 'notes:block_focus', async () => {
      const guard = await guardRoomEvent(ctx, socket, 'notes:block_focus', payload, {
        schema: Schemas.NoteBlockFocus,
        permission: 'notes.edit',
      });
      if (!guard.ok) return;
      // Phase 7: broadcast `notes:block_locked` with an 8s TTL, refreshed while typing.
    });
  });

  socket.on('notes:block_update', (payload, ack) => {
    guarded(ctx, socket, 'notes:block_update', payload, Schemas.NoteBlockUpdate, ack);
  });

  socket.on('notes:item_create', (payload, ack) => {
    guarded(ctx, socket, 'notes:item_create', payload, Schemas.NoteItemCreate, ack);
  });

  socket.on('notes:item_update', (payload, ack) => {
    guarded(ctx, socket, 'notes:item_update', payload, Schemas.NoteItemUpdate, ack);
  });

  socket.on('notes:item_delete', (payload, ack) => {
    guarded(ctx, socket, 'notes:item_delete', payload, z.object({ id: Schemas.Uuid }), ack);
  });

  socket.on('checklist:create', (payload, ack) => {
    guarded(ctx, socket, 'checklist:create', payload, Schemas.ChecklistCreate, ack, 'checklist.edit');
  });

  socket.on('checklist:toggle', (payload, ack) => {
    guarded(ctx, socket, 'checklist:toggle', payload, Schemas.ChecklistToggle, ack, 'checklist.edit');
  });

  socket.on('checklist:reorder', (payload, ack) => {
    guarded(ctx, socket, 'checklist:reorder', payload, Schemas.ChecklistReorder, ack, 'checklist.edit');
  });

  socket.on('checklist:delete', (payload, ack) => {
    guarded(
      ctx,
      socket,
      'checklist:delete',
      payload,
      z.object({ id: Schemas.Uuid }),
      ack,
      'checklist.edit',
    );
  });
}

/**
 * The shared shape of every stubbed ack handler here: guard, then answer
 * `not_implemented`. Written once so that filling these in during Phase 7 is a
 * body change rather than a re-derivation of the guard wiring.
 */
function guarded<P>(
  ctx: AppContext,
  socket: TypedSocket,
  event:
    | 'notes:block_update'
    | 'notes:item_create'
    | 'notes:item_update'
    | 'notes:item_delete'
    | 'checklist:create'
    | 'checklist:toggle'
    | 'checklist:reorder'
    | 'checklist:delete',
  payload: unknown,
  schema: z.ZodType<P, z.ZodTypeDef, unknown>,
  ack: FailAck,
  permission: 'notes.edit' | 'checklist.edit' = 'notes.edit',
): void {
  runHandler(
    ctx,
    socket,
    event,
    async () => {
      const guard = await guardRoomEvent(ctx, socket, event, payload, { schema, permission });
      if (!guard.ok) {
        ack({ ok: false, code: guard.failure.code, message: guard.failure.message });
        return;
      }
      ack(NOT_IMPLEMENTED);
    },
    (failure) => ack({ ok: false, code: failure.code, message: failure.message }),
  );
}
