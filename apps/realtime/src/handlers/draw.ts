/**
 * The shared annotation layer — "ink".
 *
 * Someone turns on draw mode and traces over the video; everyone in the room
 * sees the line appear, hold, and fade. It is a shared laser pointer for "look
 * at THIS term here", not a whiteboard.
 *
 * NOTHING HERE IS STORED. No Postgres row, no Redis key, no field in the room
 * snapshot, and that is the design rather than an omission — it is the first
 * thing anyone reading this file will go looking for. A stroke is dead
 * INK_LIFETIME_MS after it was drawn, so the only place it can usefully live is
 * the memory of the clients that were watching when it happened. A late joiner
 * who misses a stroke that expired two seconds ago has missed nothing: replaying
 * it would draw a circle around a moment of the lecture that has already gone.
 * Both handlers below are pure relays, and this file imports neither `prisma`
 * nor the Redis key helpers, which is what keeps that true under refactoring.
 *
 * Two more things that look like gaps and are not:
 *
 *  - Neither handler acks. A drawing user emits ~20 batches a second; an ack per
 *    batch doubles the traffic to confirm something the sender already drew on
 *    their own canvas, and a dropped batch is invisible by design.
 *  - The server never interprets a coordinate. Points arrive normalised to
 *    0..1 against the VIDEO STAGE — the one box that is 16:9 and identical in
 *    every participant's window — and are relayed verbatim. The schema's 0..1
 *    bound is the entire check, because there is nothing else here to check.
 *
 * INK_MAX_POINTS_PER_STROKE and INK_MAX_ACTIVE_STROKES are enforced by the
 * clients, not here, and that is the same decision again: counting a stroke's
 * points across batches means holding the stroke, which is precisely the state
 * this file refuses to have. The server's ceiling is the rate limit.
 */
import { Schemas } from '@syncstudy/shared';
import {
  guardRoomEvent,
  roomChannel,
  runHandler,
  type AppContext,
  type TypedSocket,
} from './context.js';

export function registerDrawHandlers(ctx: AppContext, socket: TypedSocket): void {
  socket.on('draw:stroke', (payload) => {
    runHandler(ctx, socket, 'draw:stroke', async () => {
      const guard = await guardRoomEvent(ctx, socket, 'draw:stroke', payload, {
        schema: Schemas.DrawStroke,
        permission: 'annotate',
      });
      if (!guard.ok) return;

      const { session, payload: input } = guard;
      // The room switch as well as the role. A host who turned ink off turned it
      // off for the members whose role would otherwise let them draw — checking
      // only `can(role, 'annotate')` would make the toggle decorative.
      if (!session.meta.policy.annotationsEnabled) return;

      // `socket.to`, not `io.to`: the sender drew this stroke locally as their
      // pointer moved. Echoing it back would render the same line twice and let
      // the round trip fight the live one still growing under their finger.
      socket.to(roomChannel(session.roomId)).emit('draw:stroke', {
        from: socket.data.userId,
        strokeId: input.strokeId,
        points: input.points,
        done: input.done,
        // Stamped here, once, so every client ages the stroke off the same clock
        // and it disappears for the whole room in the same instant. A client
        // using its own `Date.now()` would kill it seconds early or late.
        serverMs: Date.now(),
      });
    });
  });

  socket.on('draw:clear', (payload) => {
    runHandler(ctx, socket, 'draw:clear', async () => {
      // Role only — deliberately not gated on `annotationsEnabled` the way a
      // stroke is. Taking your own ink back has to keep working in the seconds
      // after a host switches drawing off, or the last stroke someone drew
      // before the toggle is stuck on the video until it fades.
      const guard = await guardRoomEvent(ctx, socket, 'draw:clear', payload, {
        schema: Schemas.DrawClear,
        permission: 'annotate',
      });
      if (!guard.ok) return;

      // Everyone, sender included, unlike a stroke. Clearing removes only the
      // caller's own ink, so one path — "that user's strokes, gone" — runs on
      // every client and the person who pressed it sees what the room sees.
      ctx.io.to(roomChannel(guard.session.roomId)).emit('draw:cleared', {
        userId: socket.data.userId,
      });
    });
  });
}
