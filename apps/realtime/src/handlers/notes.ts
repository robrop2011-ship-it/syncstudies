/**
 * Shared notes, timestamped items and the checklist (PLAN.md §3.6, §8.12).
 *
 * Three rules run through every handler here:
 *
 *  - **A conflict never loses text.** `notes:block_update` carries a
 *    `baseVersion`; when it is stale the server keeps its own copy and preserves
 *    the caller's as a new block below, then tells both sides. That is the whole
 *    concurrency story — no CRDT, no merge algorithm to be subtly wrong (§8.12).
 *  - **Delete is `canActOn`, not `role === 'host'`.** Authors delete their own;
 *    moderators delete anyone's. The resolver in `@syncstudy/shared` decides,
 *    here as everywhere.
 *  - **The room is told, not just the caller.** Every accepted write broadcasts,
 *    so a second client never has to poll to find out the checklist moved.
 */
import { Schemas, can, canActOn, type NoteItemView } from '@syncstudy/shared';
import { z } from 'zod';
import { BLOCK_LOCK_TTL_MS } from '../notes/store.js';
import {
  createChecklistItem,
  createNoteItem,
  deleteChecklistItem,
  deleteNoteItem,
  findChecklistItem,
  findNoteItem,
  reorderChecklistItem,
  toggleChecklistItem,
  updateNoteItem,
} from '../notes/items.js';
import { guardRoomEvent, roomChannel, runHandler, type AppContext, type TypedSocket } from './context.js';

/**
 * May this person remove that item?
 *
 * Authors always may. Everyone else needs to outrank the author — which is what
 * stops a member deleting the host's question, and what stops a co-host
 * deleting the host's. An item whose author has deleted their account has a
 * null author and is treated as the room's, so only a moderator may remove it.
 */
async function mayRemove(
  ctx: AppContext,
  roomId: string,
  actorId: string,
  actorRole: Parameters<typeof canActOn>[0],
  authorId: string | null,
): Promise<boolean> {
  if (authorId === actorId) return true;
  if (!can(actorRole, 'chat.delete.any')) return false;
  if (authorId === null) return true;
  const author = await ctx.store.getParticipant(roomId, authorId);
  // Someone who has left the room can no longer outrank anybody in it.
  return author === null ? true : canActOn(actorRole, author.role);
}

export function registerNotesHandlers(ctx: AppContext, socket: TypedSocket): void {
  // ── the shared document (§8.12) ──────────────────────────────────────────

  socket.on('notes:block_focus', (payload) => {
    runHandler(ctx, socket, 'notes:block_focus', async () => {
      const guard = await guardRoomEvent(ctx, socket, 'notes:block_focus', payload, {
        schema: Schemas.NoteBlockFocus,
        permission: 'notes.edit',
      });
      if (!guard.ok) return;

      const { session, payload: input } = guard;
      const holder = await ctx.notes.store.lockBlock(session.roomId, input.blockId, socket.data.userId);
      // Broadcast to everyone including the holder: the label is "who has this
      // block", and the person who asked needs to know if the answer was "not
      // you". Refreshed while typing, so the TTL is a floor, not a countdown.
      ctx.io.to(roomChannel(session.roomId)).emit('notes:block_locked', {
        blockId: input.blockId,
        userId: holder,
        untilServerMs: Date.now() + BLOCK_LOCK_TTL_MS,
      });
    });
  });

  socket.on('notes:block_update', (payload, ack) => {
    runHandler(
      ctx,
      socket,
      'notes:block_update',
      async () => {
        const guard = await guardRoomEvent(ctx, socket, 'notes:block_update', payload, {
          schema: Schemas.NoteBlockUpdate,
          permission: 'notes.edit',
        });
        if (!guard.ok) {
          ack({ ok: false, code: guard.failure.code, message: guard.failure.message });
          return;
        }

        const { session, payload: input } = guard;
        const outcome = await ctx.notes.store.applyBlockUpdate(
          session.roomId,
          input.blockId,
          input.text,
          input.baseVersion,
        );

        if (!outcome.ok) {
          ack({
            ok: false,
            code: outcome.code,
            message: 'These notes are full. Delete a paragraph before adding another.',
          });
          return;
        }

        const room = roomChannel(session.roomId);
        if (outcome.kind === 'conflict') {
          // Both blocks go out: the winner (so the loser's editor snaps to the
          // text that actually survived) and the preserved copy below it.
          const preserved = {
            blockId: outcome.preserved.id,
            text: outcome.preserved.text,
            version: outcome.preserved.version,
            position: outcome.preserved.position,
            by: socket.data.userId,
          };
          // Everyone, sender included: the loser needs to see where their text
          // went, and the winner's block is unchanged so it needs no broadcast.
          ctx.io.to(room).emit('notes:block_updated', preserved);
          ack({ ok: true, data: { version: outcome.version, winning: outcome.block.text } });
        } else {
          socket.to(room).emit('notes:block_updated', {
            blockId: outcome.block.id,
            text: outcome.block.text,
            version: outcome.block.version,
            position: outcome.block.position,
            by: socket.data.userId,
          });
          ack({ ok: true, data: { version: outcome.version } });
        }

        // Debounced, never awaited (§6.5): a keystroke path that waits for
        // Postgres is the thing the whole two-tier design exists to avoid.
        ctx.notes.persistSoon(session.roomId, socket.data.userId);
        await ctx.notes.store.lockBlock(session.roomId, input.blockId, socket.data.userId);
      },
      (failure) => ack({ ok: false, code: failure.code, message: failure.message }),
    );
  });

  // ── timestamped items (§3.6 S3) ──────────────────────────────────────────

  socket.on('notes:item_create', (payload, ack) => {
    runHandler(
      ctx,
      socket,
      'notes:item_create',
      async () => {
        const guard = await guardRoomEvent(ctx, socket, 'notes:item_create', payload, {
          schema: Schemas.NoteItemCreate,
          permission: 'notes.edit',
        });
        if (!guard.ok) {
          ack({ ok: false, code: guard.failure.code, message: guard.failure.message });
          return;
        }

        const { session, payload: input } = guard;
        // The video reference is stamped server-side from the live anchor, not
        // taken from the payload: a tick that claims to be on a video the room
        // is no longer watching is worse than one with no reference at all.
        const state = await ctx.store.getOrHydrate(session.roomId);
        const item = await createNoteItem({
          roomId: session.roomId,
          userId: socket.data.userId,
          kind: input.kind,
          body: input.body,
          videoRef: input.videoTs === undefined || input.videoTs === null ? null : state.anchor.videoRef,
          videoTs: input.videoTs ?? null,
        });

        socket.to(roomChannel(session.roomId)).emit('notes:item_created', { item });
        ack({ ok: true, data: item });
      },
      (failure) => ack({ ok: false, code: failure.code, message: failure.message }),
    );
  });

  socket.on('notes:item_update', (payload, ack) => {
    runHandler(
      ctx,
      socket,
      'notes:item_update',
      async () => {
        const guard = await guardRoomEvent(ctx, socket, 'notes:item_update', payload, {
          schema: Schemas.NoteItemUpdate,
          permission: 'notes.edit',
        });
        if (!guard.ok) {
          ack({ ok: false, code: guard.failure.code, message: guard.failure.message });
          return;
        }

        const { session, payload: input } = guard;
        const found = await findNoteItem(session.roomId, input.id);
        if (found === null) {
          ack({ ok: false, code: 'not_found', message: 'That note no longer exists.' });
          return;
        }
        // Editing the TEXT is the author's alone; resolving a question is
        // anybody's, because the point of resolving is that the room agrees it
        // has been answered.
        if (input.body !== undefined && found.authorId !== socket.data.userId) {
          ack({ ok: false, code: 'not_permitted', message: 'Only the author can edit this note.' });
          return;
        }
        if (input.resolved !== undefined && found.view.kind !== 'question') {
          ack({ ok: false, code: 'bad_payload', message: 'Only questions can be resolved.' });
          return;
        }

        const item: NoteItemView | null = await updateNoteItem({
          roomId: session.roomId,
          id: input.id,
          userId: socket.data.userId,
          body: input.body,
          resolved: input.resolved,
        });
        if (item === null) {
          ack({ ok: false, code: 'not_found', message: 'That note no longer exists.' });
          return;
        }

        ctx.io.to(roomChannel(session.roomId)).emit('notes:item_updated', { item });
        ack({ ok: true });
      },
      (failure) => ack({ ok: false, code: failure.code, message: failure.message }),
    );
  });

  socket.on('notes:item_delete', (payload, ack) => {
    runHandler(
      ctx,
      socket,
      'notes:item_delete',
      async () => {
        const guard = await guardRoomEvent(ctx, socket, 'notes:item_delete', payload, {
          schema: z.object({ id: Schemas.Uuid }),
          permission: 'notes.edit',
        });
        if (!guard.ok) {
          ack({ ok: false, code: guard.failure.code, message: guard.failure.message });
          return;
        }

        const { session, payload: input } = guard;
        const found = await findNoteItem(session.roomId, input.id);
        if (found === null) {
          // Already gone is the outcome the caller wanted.
          ack({ ok: true });
          return;
        }
        if (!(await mayRemove(ctx, session.roomId, socket.data.userId, session.role, found.authorId))) {
          ack({ ok: false, code: 'not_permitted', message: 'You cannot delete that note.' });
          return;
        }

        await deleteNoteItem(session.roomId, input.id);
        ctx.io.to(roomChannel(session.roomId)).emit('notes:item_deleted', { id: input.id });
        ack({ ok: true });
      },
      (failure) => ack({ ok: false, code: failure.code, message: failure.message }),
    );
  });

  // ── checklist (§3.6 S6) ──────────────────────────────────────────────────

  socket.on('checklist:create', (payload, ack) => {
    runHandler(
      ctx,
      socket,
      'checklist:create',
      async () => {
        const guard = await guardRoomEvent(ctx, socket, 'checklist:create', payload, {
          schema: Schemas.ChecklistCreate,
          permission: 'checklist.edit',
        });
        if (!guard.ok) {
          ack({ ok: false, code: guard.failure.code, message: guard.failure.message });
          return;
        }

        const { session, payload: input } = guard;
        const item = await createChecklistItem({
          roomId: session.roomId,
          userId: socket.data.userId,
          label: input.label,
          videoTs: input.videoTs ?? null,
        });
        socket.to(roomChannel(session.roomId)).emit('checklist:created', { item });
        ack({ ok: true, data: item });
      },
      (failure) => ack({ ok: false, code: failure.code, message: failure.message }),
    );
  });

  socket.on('checklist:toggle', (payload, ack) => {
    runHandler(
      ctx,
      socket,
      'checklist:toggle',
      async () => {
        const guard = await guardRoomEvent(ctx, socket, 'checklist:toggle', payload, {
          schema: Schemas.ChecklistToggle,
          permission: 'checklist.edit',
        });
        if (!guard.ok) {
          ack({ ok: false, code: guard.failure.code, message: guard.failure.message });
          return;
        }

        const { session, payload: input } = guard;
        const item = await toggleChecklistItem({
          roomId: session.roomId,
          id: input.id,
          userId: socket.data.userId,
          completed: input.completed,
        });
        if (item === null) {
          ack({ ok: false, code: 'not_found', message: 'That item no longer exists.' });
          return;
        }
        // Everyone, sender included: the completer's name comes from the server
        // and an optimistic tick cannot know whose write landed last.
        ctx.io.to(roomChannel(session.roomId)).emit('checklist:updated', { item });
        ack({ ok: true });
      },
      (failure) => ack({ ok: false, code: failure.code, message: failure.message }),
    );
  });

  socket.on('checklist:reorder', (payload, ack) => {
    runHandler(
      ctx,
      socket,
      'checklist:reorder',
      async () => {
        const guard = await guardRoomEvent(ctx, socket, 'checklist:reorder', payload, {
          schema: Schemas.ChecklistReorder,
          permission: 'checklist.edit',
        });
        if (!guard.ok) {
          ack({ ok: false, code: guard.failure.code, message: guard.failure.message });
          return;
        }

        const { session, payload: input } = guard;
        if (!Number.isFinite(input.position)) {
          ack({ ok: false, code: 'bad_payload', message: 'That request was malformed.' });
          return;
        }
        const item = await reorderChecklistItem(session.roomId, input.id, input.position);
        if (item === null) {
          ack({ ok: false, code: 'not_found', message: 'That item no longer exists.' });
          return;
        }
        socket.to(roomChannel(session.roomId)).emit('checklist:updated', { item });
        ack({ ok: true });
      },
      (failure) => ack({ ok: false, code: failure.code, message: failure.message }),
    );
  });

  socket.on('checklist:delete', (payload, ack) => {
    runHandler(
      ctx,
      socket,
      'checklist:delete',
      async () => {
        const guard = await guardRoomEvent(ctx, socket, 'checklist:delete', payload, {
          schema: z.object({ id: Schemas.Uuid }),
          permission: 'checklist.edit',
        });
        if (!guard.ok) {
          ack({ ok: false, code: guard.failure.code, message: guard.failure.message });
          return;
        }

        const { session, payload: input } = guard;
        const found = await findChecklistItem(session.roomId, input.id);
        if (found === null) {
          ack({ ok: true });
          return;
        }
        if (!(await mayRemove(ctx, session.roomId, socket.data.userId, session.role, found.createdBy))) {
          ack({ ok: false, code: 'not_permitted', message: 'You cannot delete that item.' });
          return;
        }

        await deleteChecklistItem(session.roomId, input.id);
        ctx.io.to(roomChannel(session.roomId)).emit('checklist:deleted', { id: input.id });
        ack({ ok: true });
      },
      (failure) => ack({ ok: false, code: failure.code, message: failure.message }),
    );
  });
}
