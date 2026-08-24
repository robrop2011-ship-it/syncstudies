/**
 * WebRTC signaling — Phase 6 (PLAN.md §9.2, §11.5).
 *
 * Registered, guarded and rate-limited now; the relay lands in Phase 6. Two
 * properties must survive that implementation:
 *
 *  - the server is a relay with an authorization check, never a parser. It must
 *    not read, rewrite or log SDP — SDP carries local IP addresses (§11.5).
 *  - a signal is only ever delivered to a `to` that is proven to be in the same
 *    room and in the call. `to` comes from the payload; the *sender* never does.
 *
 * TURN credentials (§9.3) are minted per user with a 10-minute TTL from
 * TURN_SECRET. Until Phase 6 the config is accepted and unused, so a deployment
 * can be prepared ahead of the feature.
 */
import { Schemas } from '@syncstudy/shared';
import { z } from 'zod';
import { guardRoomEvent, runHandler, type AppContext, type TypedSocket } from './context.js';

const NOT_IMPLEMENTED = {
  ok: false as const,
  code: 'not_implemented',
  message: 'Voice calling is not available yet.',
};

function notice(socket: TypedSocket, message: string): void {
  socket.emit('sys:notice', { level: 'info', code: 'not_implemented', message });
}

export function registerRtcHandlers(ctx: AppContext, socket: TypedSocket): void {
  socket.on('rtc:join', (payload, ack) => {
    runHandler(
      ctx,
      socket,
      'rtc:join',
      async () => {
        const guard = await guardRoomEvent(ctx, socket, 'rtc:join', payload, {
          schema: Schemas.RtcJoin,
          permission: 'call.join',
        });
        if (!guard.ok) {
          ack({ ok: false, reason: 'not_permitted' });
          return;
        }
        // RtcJoinAck has no 'not_implemented' reason, and inventing one would
        // change the shared contract. 'call_disabled' is the truthful answer
        // for now, and the notice says why.
        notice(socket, 'Voice calling is not available yet.');
        ack({ ok: false, reason: 'call_disabled' });
      },
      () => ack({ ok: false, reason: 'call_disabled' }),
    );
  });

  socket.on('rtc:leave', (payload, ack) => {
    runHandler(
      ctx,
      socket,
      'rtc:leave',
      async () => {
        const guard = await guardRoomEvent(ctx, socket, 'rtc:leave', payload, {
          schema: z.object({}),
        });
        if (!guard.ok) {
          ack({ ok: false, code: guard.failure.code, message: guard.failure.message });
          return;
        }
        // Leaving a call you are not in is a no-op, not an error.
        await ctx.store.updateParticipant(guard.session.roomId, socket.data.userId, {
          inCall: false,
          speaking: false,
          sharing: false,
        });
        ack({ ok: true });
      },
      (failure) => ack({ ok: false, code: failure.code, message: failure.message }),
    );
  });

  socket.on('rtc:signal', (payload, ack) => {
    runHandler(
      ctx,
      socket,
      'rtc:signal',
      async () => {
        const guard = await guardRoomEvent(ctx, socket, 'rtc:signal', payload, {
          schema: Schemas.RtcSignal,
          permission: 'call.join',
        });
        if (!guard.ok) {
          ack({ ok: false, code: guard.failure.code, message: guard.failure.message });
          return;
        }
        // Phase 6: verify `to` is a participant of this room AND in the call,
        // then `io.to(theirSocketId).emit('rtc:signal', { ...payload, from })`.
        ack(NOT_IMPLEMENTED);
      },
      (failure) => ack({ ok: false, code: failure.code, message: failure.message }),
    );
  });

  socket.on('rtc:ice_refresh', (payload, ack) => {
    runHandler(
      ctx,
      socket,
      'rtc:ice_refresh',
      async () => {
        const guard = await guardRoomEvent(ctx, socket, 'rtc:ice_refresh', payload, {
          schema: z.object({}),
          permission: 'call.join',
        });
        if (!guard.ok) {
          ack({ ok: false, code: guard.failure.code, message: guard.failure.message });
          return;
        }
        ack(NOT_IMPLEMENTED);
      },
      (failure) => ack({ ok: false, code: failure.code, message: failure.message }),
    );
  });

  socket.on('rtc:screenshare_claim', (payload, ack) => {
    runHandler(
      ctx,
      socket,
      'rtc:screenshare_claim',
      async () => {
        const guard = await guardRoomEvent(ctx, socket, 'rtc:screenshare_claim', payload, {
          schema: z.object({}),
          permission: 'screenshare',
        });
        if (!guard.ok) {
          ack({ ok: false, code: guard.failure.code, message: guard.failure.message });
          return;
        }
        // Phase 6: `SET room:{id}:screenshare NX` is the single-holder lock.
        ack(NOT_IMPLEMENTED);
      },
      (failure) => ack({ ok: false, code: failure.code, message: failure.message }),
    );
  });

  socket.on('rtc:screenshare_release', (payload, ack) => {
    runHandler(
      ctx,
      socket,
      'rtc:screenshare_release',
      async () => {
        const guard = await guardRoomEvent(ctx, socket, 'rtc:screenshare_release', payload, {
          schema: z.object({}),
        });
        if (!guard.ok) {
          ack({ ok: false, code: guard.failure.code, message: guard.failure.message });
          return;
        }
        ack(NOT_IMPLEMENTED);
      },
      (failure) => ack({ ok: false, code: failure.code, message: failure.message }),
    );
  });
}
