/**
 * Cross-node control messages (PLAN.md §11.3).
 *
 * The Socket.IO Redis adapter fans out *room* events. It does not help with
 * things that must happen to a specific socket on a specific node — banning a
 * user connected to node B while the host is on node A, or telling whichever
 * node leads a room to act on a buffering change. That is what this bus is for.
 *
 * Messages are commands from a trusted peer (another one of our own nodes), so
 * they are still validated: a malformed message from a Redis instance shared
 * with something else must not crash a node.
 */
import { z } from 'zod';
import type { Redis } from 'ioredis';
import { channels, type ScriptedRedis } from '../redis.js';
import type { Logger } from '../logger.js';

export const AdminDisconnectMessage = z.object({
  type: z.literal('disconnect_user'),
  roomId: z.string(),
  userId: z.string(),
  reason: z.enum(['kicked', 'banned', 'room_ended']),
  by: z.string().nullable(),
  banned: z.boolean(),
});
export type AdminDisconnectMessage = z.infer<typeof AdminDisconnectMessage>;

export const RoomBusMessage = z.discriminatedUnion('type', [
  /** Someone's buffering state changed; the room's leader decides what to do. */
  z.object({ type: z.literal('buffering_changed'), roomId: z.string() }),
  /** A role changed; every node holding that user's socket updates its copy. */
  z.object({
    type: z.literal('role_changed'),
    roomId: z.string(),
    userId: z.string(),
    role: z.enum(['host', 'co_host', 'member', 'guest']),
  }),
  /** Force-mute crossed a node boundary. */
  z.object({
    type: z.literal('force_muted'),
    roomId: z.string(),
    userId: z.string(),
    by: z.string(),
    muted: z.boolean(),
  }),
]);
export type RoomBusMessage = z.infer<typeof RoomBusMessage>;

export interface BusHandlers {
  onAdminDisconnect(msg: AdminDisconnectMessage): Promise<void>;
  onRoomMessage(msg: RoomBusMessage): Promise<void>;
}

export class RoomBus {
  private started = false;

  constructor(
    private readonly pub: ScriptedRedis,
    private readonly sub: Redis,
    private readonly log: Logger,
  ) {}

  async start(handlers: BusHandlers): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.sub.on('message', (channel: string, raw: string) => {
      void this.dispatch(channel, raw, handlers);
    });
    await this.sub.subscribe(channels.adminDisconnect, channels.roomBus);
    this.log.info('room bus subscribed');
  }

  private async dispatch(channel: string, raw: string, handlers: BusHandlers): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (channel === channels.adminDisconnect) {
        const msg = AdminDisconnectMessage.safeParse(parsed);
        if (!msg.success) {
          this.log.warn({ channel }, 'discarding malformed admin message');
          return;
        }
        await handlers.onAdminDisconnect(msg.data);
        return;
      }
      if (channel === channels.roomBus) {
        const msg = RoomBusMessage.safeParse(parsed);
        if (!msg.success) {
          this.log.warn({ channel }, 'discarding malformed room bus message');
          return;
        }
        await handlers.onRoomMessage(msg.data);
      }
    } catch (err) {
      // A bad message must never take a node down.
      this.log.error({ channel, err }, 'room bus dispatch failed');
    }
  }

  async publishAdminDisconnect(msg: AdminDisconnectMessage): Promise<void> {
    await this.publish(channels.adminDisconnect, msg);
  }

  async publishRoomMessage(msg: RoomBusMessage): Promise<void> {
    await this.publish(channels.roomBus, msg);
  }

  private async publish(channel: string, msg: unknown): Promise<void> {
    try {
      await this.pub.publish(channel, JSON.stringify(msg));
    } catch (err) {
      this.log.error({ channel, err }, 'room bus publish failed');
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.sub.unsubscribe(channels.adminDisconnect, channels.roomBus).catch(() => undefined);
  }
}
