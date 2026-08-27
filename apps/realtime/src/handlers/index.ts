/**
 * Handler registration and the cross-node message handlers.
 *
 * Every client→server event in `ClientToServerEvents` is registered here or in
 * one of the files below — including the Phase 5/6/7 stubs, so an unimplemented
 * feature answers `not_implemented` instead of leaving a client waiting for an
 * ack that never comes.
 */
import type { AppContext, TypedSocket } from './context.js';
import { registerTimeHandlers } from './time.js';
import { registerRoomHandlers, registerDisconnectHandler, buildSnapshot } from './room.js';
import { registerPresenceHandlers } from './presence.js';
import { registerVideoHandlers, evaluateWaitForSlow } from './video.js';
import { registerHostHandlers } from './host.js';
import { registerChatHandlers } from './chat.js';
import { registerNotesHandlers } from './notes.js';
import { registerDrawHandlers } from './draw.js';
import { registerRtcHandlers } from './rtc.js';
import type { AdminDisconnectMessage, BusHandlers, RoomBusMessage } from '../rooms/bus.js';
import { roomChannel } from './context.js';

export function registerAllHandlers(ctx: AppContext, socket: TypedSocket): void {
  registerTimeHandlers(ctx, socket);
  registerRoomHandlers(ctx, socket);
  registerPresenceHandlers(ctx, socket);
  registerVideoHandlers(ctx, socket);
  registerHostHandlers(ctx, socket);

  // Phases 5–7: wired, guarded, and honest about not being finished.
  registerChatHandlers(ctx, socket);
  registerNotesHandlers(ctx, socket);
  registerRtcHandlers(ctx, socket);

  // Ink relays and stores nothing, so it has no service on `ctx` to wire up.
  registerDrawHandlers(ctx, socket);

  // Registered last so it observes the final state of socket.data.
  registerDisconnectHandler(ctx, socket);
}

/** Sockets this node holds for a given user in a given room. */
function localSocketsFor(ctx: AppContext, roomId: string, userId: string): TypedSocket[] {
  const out: TypedSocket[] = [];
  for (const socket of ctx.io.sockets.sockets.values()) {
    if (socket.data.userId === userId && socket.data.roomId === roomId) out.push(socket);
  }
  return out;
}

export function createBusHandlers(ctx: AppContext): BusHandlers {
  return {
    /**
     * §11.3: a ban must reach the offender wherever they are connected. Each
     * node acts only on the sockets it actually holds.
     */
    async onAdminDisconnect(msg: AdminDisconnectMessage): Promise<void> {
      const sockets = localSocketsFor(ctx, msg.roomId, msg.userId);
      if (sockets.length === 0) return;

      for (const socket of sockets) {
        if (msg.reason === 'room_ended') {
          socket.emit('room:ended', { by: msg.by, reason: 'host_ended' });
        } else {
          socket.emit('room:you_were_kicked', { by: msg.by ?? '', banned: msg.banned });
        }

        await socket.leave(roomChannel(msg.roomId));
        delete socket.data.roomId;
        delete socket.data.roomCode;
        delete socket.data.role;

        // A ban drops the connection entirely; a kick leaves it alive so the
        // client can navigate somewhere useful without a reconnect storm.
        if (msg.banned) socket.disconnect(true);
      }

      ctx.log.info(
        { roomId: msg.roomId, userId: msg.userId, sockets: sockets.length, reason: msg.reason },
        'admin disconnect applied',
      );
    },

    async onRoomMessage(msg: RoomBusMessage): Promise<void> {
      switch (msg.type) {
        case 'buffering_changed':
          // Only the leader acts. Every other node ignores this.
          await evaluateWaitForSlow(ctx, msg.roomId);
          return;

        case 'role_changed': {
          for (const socket of localSocketsFor(ctx, msg.roomId, msg.userId)) {
            socket.data.role = msg.role;
            // Their affordances changed, so push a fresh snapshot rather than
            // letting the client infer new permissions from a role string.
            const snapshot = await buildSnapshot(ctx, msg.roomId, msg.userId);
            if (snapshot) socket.emit('room:snapshot', snapshot);
          }
          return;
        }

        case 'force_muted': {
          for (const socket of localSocketsFor(ctx, msg.roomId, msg.userId)) {
            if (msg.muted) socket.emit('rtc:force_muted', { by: msg.by });
          }
          return;
        }
      }
    },
  };
}
