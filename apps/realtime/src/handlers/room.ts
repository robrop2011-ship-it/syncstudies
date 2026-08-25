/**
 * Room join / leave / resync (PLAN.md §6.3, §8.7, §8.8, §11.3).
 *
 * `room:join` is the one handler allowed to be slow, and the only one that
 * re-verifies everything from Postgres: membership, bans and capacity. Holding
 * a remembered room code or a stale token is explicitly not sufficient (§11.3
 * "ghost joins") — every join is re-authorised from scratch.
 */
import {
  INITIAL_MESSAGE_COUNT,
  MESSAGE_BACKFILL_MAX,
  Schemas,
  normalizeRoomCode,
  type JoinAck,
  type RoomSnapshot,
} from '@syncstudy/shared';
import { listMessages } from '../chat/messages.js';
import { listChecklist, listNoteItems } from '../notes/items.js';
import { LIMITS } from '../ratelimit/tokenBucket.js';
import { keys } from '../redis.js';
import { releaseConnection } from '../auth/handshake.js';
import { recordJoin, resolveMembership } from '../rooms/roomData.js';
import type { PresenceEntry } from '../rooms/RoomStore.js';
import {
  countActiveRooms,
  resolvePermissions,
  roomChannel,
  runHandler,
  toParticipant,
  type AppContext,
  type TypedSocket,
} from './context.js';
import { localRoomSize, removeParticipantAndBroadcast } from './presence.js';
import { leaveCall } from './rtc.js';
import { participantsPerRoom, socketConnections, roomsActive } from '../metrics.js';



function ackError(code: string, message: string): JoinAck {
  return { ok: false, code, message };
}

export async function buildSnapshot(
  ctx: AppContext,
  roomId: string,
  userId: string,
  opts: { sinceMessageId?: string } = {},
): Promise<RoomSnapshot | null> {
  const meta = await ctx.meta.byId(roomId);
  if (!meta) return null;

  // Land this node's queued messages before reading the transcript, so a message
  // broadcast a moment ago is in the page the joiner receives. Bounded (§6.5) —
  // a database that has stopped answering must not hold a join open.
  await ctx.chat.settle();

  const [state, participants, chat, notes, noteItems, checklist] = await Promise.all([
    ctx.store.getOrHydrate(roomId),
    ctx.store.listParticipants(roomId),
    listMessages(
      roomId,
      opts.sinceMessageId === undefined
        ? { limit: INITIAL_MESSAGE_COUNT }
        : { after: opts.sinceMessageId, limit: MESSAGE_BACKFILL_MAX },
    ),
    // The document comes from Redis (hydrating from Postgres on a cold room),
    // so it is not subject to the write-behind window the transcript is.
    ctx.notes.store.view(roomId),
    listNoteItems(roomId),
    listChecklist(roomId),
  ]);

  const me = participants.find((p) => p.userId === userId);
  const role = me?.role ?? 'guest';

  return {
    room: meta.room,
    policy: meta.policy,
    participants: participants.map(toParticipant),
    video: state.anchor,
    // Read as late as possible: the client's drift maths is relative to this.
    serverMs: Date.now(),
    messages: chat.messages,
    notes,
    noteItems,
    checklist,
    you: resolvePermissions(role, meta.policy),
  };
}

export function registerRoomHandlers(ctx: AppContext, socket: TypedSocket): void {
  socket.on('room:join', (payload, ack) => {
    runHandler(
      ctx,
      socket,
      'room:join',
      async () => {
        const verdict = await ctx.limiter.consume(socket.id, 'room:join', LIMITS['room:join']);
        if (!verdict.allowed) {
          socket.emit('sys:rate_limited', { event: 'room:join', retryAfterMs: verdict.retryAfterMs });
          if (verdict.disconnect) {
            await ctx.limiter.applyCooldown(socket.data.userId);
            socket.disconnect(true);
          }
          ack(ackError('rate_limited', 'Too many join attempts. Wait a moment.'));
          return;
        }

        const parsed = Schemas.RoomJoin.safeParse(payload);
        if (!parsed.success) {
          ack(ackError('bad_payload', 'That room code is not valid.'));
          return;
        }
        const code = normalizeRoomCode(parsed.data.roomCode);
        if (code === null) {
          ack(ackError('bad_payload', 'That room code is not valid.'));
          return;
        }

        const meta = await ctx.meta.byCode(code);
        // Same answer for "no such room" and "you may not see it": the room-code
        // space is the enumeration surface (§11.3), so it must not leak hits.
        if (!meta) {
          ack(ackError('room_not_found', 'No room with that code.'));
          return;
        }
        if (meta.status === 'ended') {
          ack(ackError('room_ended', 'This room has ended.'));
          return;
        }
        if (meta.status === 'archived') {
          ack(ackError('room_archived', 'This room is archived and can no longer be joined.'));
          return;
        }

        const roomId = meta.room.id;
        const userId = socket.data.userId;

        const membership = await resolveMembership(roomId, userId, meta.room.hostId);
        if (membership.banned) {
          ctx.log.info({ socketId: socket.id, userId, roomId }, 'join refused: banned');
          ack(ackError('banned', 'You cannot join this room.'));
          return;
        }

        // A socket already in another room leaves it first — one room per socket
        // keeps presence and the video anchor unambiguous.
        const previousRoomId = socket.data.roomId;
        if (previousRoomId !== undefined && previousRoomId !== roomId) {
          await leaveRoom(ctx, socket, 'left');
        }

        const existing = await ctx.store.getParticipant(roomId, userId);
        const now = Date.now();
        const entry: PresenceEntry = {
          userId,
          socketId: socket.id,
          node: ctx.config.NODE_ID,
          handle: socket.data.handle,
          displayName: socket.data.displayName,
          avatarUrl: socket.data.avatarUrl,
          role: membership.role,
          connState: 'connected',
          // A reconnect keeps the original join time so "longest connected"
          // host promotion stays fair across a Wi-Fi blip.
          joinedAt: existing?.joinedAt ?? now,
          inCall: existing?.inCall ?? false,
          // Safe defaults: you arrive muted, camera off (§11.9). Never flip these.
          muted: existing?.muted ?? true,
          camOn: existing?.camOn ?? false,
          sharing: existing?.sharing ?? false,
          speaking: false,
          forceMuted: membership.forceMuted,
          buffering: false,
          disconnectedAt: null,
        };

        const admitted = await ctx.store.addParticipantIfRoom(roomId, entry, meta.policy.maxParticipants);
        if (!admitted) {
          ack(ackError('room_full', 'This room is full.'));
          return;
        }

        // They are back inside the grace window — cancel the removal that was
        // already scheduled, on this node and everywhere else.
        ctx.grace.cancel(roomId, userId);

        socket.data.roomId = roomId;
        socket.data.roomCode = meta.room.code;
        socket.data.role = membership.role;
        await socket.join(roomChannel(roomId));

        await Promise.all([
          ctx.store.registerSocket(socket.id, userId, ctx.config.NODE_ID, roomId),
          recordJoin(roomId, userId, membership.role),
          ctx.leader.track(roomId),
          ctx.store.touch(roomId),
        ]);

        // A reconnect carries the cursor; a fresh join does not, and gets the
        // newest page instead.
        const snapshot = await buildSnapshot(ctx, roomId, userId, {
          ...(parsed.data.lastMessageId === undefined
            ? {}
            : { sinceMessageId: parsed.data.lastMessageId }),
        });
        if (!snapshot) {
          ack(ackError('room_not_found', 'No room with that code.'));
          return;
        }

        const isReconnect = existing !== null;
        if (existing === null) {
          socket.to(roomChannel(roomId)).emit('presence:join', { participant: toParticipant(entry) });
          // After the snapshot is built, so the joiner does not read their own
          // arrival in the history they are handed — they receive it as a live
          // broadcast like everyone else, in the same order everyone else sees.
          ctx.chat.system(roomId, `join:${userId}`, `${entry.displayName} joined`);
        } else if (existing.connState !== 'connected') {
          socket
            .to(roomChannel(roomId))
            .emit('presence:update', { userId, patch: { connState: 'connected' } });
        }

        participantsPerRoom.observe(snapshot.participants.length);
        roomsActive.set(countActiveRooms(ctx.io));
        ctx.log.info(
          { socketId: socket.id, userId, roomId, event: 'room:join', reconnect: isReconnect },
          'joined room',
        );

        // The ack carries the snapshot — one payload, and the client already has
        // an await on it (§8.7 step 2). `room:snapshot` stays reserved for
        // server-initiated refreshes, such as a role change from another node.
        ack({ ok: true, snapshot });
      },
      () => ack(ackError('server_error', 'Could not join the room. Try again.')),
    );
  });

  socket.on('room:leave', (_payload, ack) => {
    runHandler(
      ctx,
      socket,
      'room:leave',
      async () => {
        const verdict = await ctx.limiter.consume(socket.id, 'room:leave', LIMITS['room:leave']);
        if (!verdict.allowed) {
          ack({ ok: false, code: 'rate_limited', message: 'Slow down.' });
          return;
        }
        await leaveRoom(ctx, socket, 'left');
        ack({ ok: true });
      },
      (failure) => ack({ ok: false, code: failure.code, message: failure.message }),
    );
  });

  socket.on('room:resync', (payload, ack) => {
    runHandler(
      ctx,
      socket,
      'room:resync',
      async () => {
        const verdict = await ctx.limiter.consume(socket.id, 'room:resync', LIMITS['room:resync']);
        if (!verdict.allowed) {
          socket.emit('sys:rate_limited', { event: 'room:resync', retryAfterMs: verdict.retryAfterMs });
          ack(ackError('rate_limited', 'Too many resyncs. Wait a moment.'));
          return;
        }

        const parsed = Schemas.RoomResync.safeParse(payload);
        if (!parsed.success) {
          ack(ackError('bad_payload', 'That request was malformed.'));
          return;
        }

        const roomId = socket.data.roomId;
        if (roomId === undefined) {
          ack(ackError('not_in_room', 'Join a room first.'));
          return;
        }

        // §8.8: an outage longer than the grace period means the server already
        // removed them. That is a fresh join, not a resync — say so rather than
        // handing back a snapshot they are not in.
        const existing = await ctx.store.getParticipant(roomId, socket.data.userId);
        if (!existing) {
          ack(ackError('not_in_room', 'Rejoin the room.'));
          return;
        }

        // A resync means the client believes it may have missed something —
        // make sure presence agrees they are here and connected before the
        // snapshot is built, so their own entry is not stale in it.
        ctx.grace.cancel(roomId, socket.data.userId);
        await ctx.store.updateParticipant(roomId, socket.data.userId, {
          connState: 'connected',
          socketId: socket.id,
          node: ctx.config.NODE_ID,
          disconnectedAt: null,
        });
        if (existing.connState !== 'connected') {
          socket
            .to(roomChannel(roomId))
            .emit('presence:update', {
              userId: socket.data.userId,
              patch: { connState: 'connected' },
            });
        }

        // Always a full snapshot of room state. §8.8: a delta resync is not
        // worth the complexity at 4–20 KB, and it is one more thing that can
        // disagree with the client.
        //
        // Chat is the exception, and the reason is size rather than principle: a
        // transcript is unbounded where a participant list is not. `lastMessageId`
        // turns the snapshot's chat page into "everything you missed" instead of
        // "the newest fifty", so a 90-second outage in a busy room comes back
        // with no gap. The client merges by id either way.
        const snapshot = await buildSnapshot(ctx, roomId, socket.data.userId, {
          ...(parsed.data.lastMessageId === undefined
            ? {}
            : { sinceMessageId: parsed.data.lastMessageId }),
        });
        if (!snapshot) {
          ack(ackError('room_not_found', 'That room no longer exists.'));
          return;
        }

        ack({ ok: true, snapshot });
      },
      () => ack(ackError('server_error', 'Could not resync. Try again.')),
    );
  });
}

/** Deliberate leave: no grace period, they meant it. */
export async function leaveRoom(
  ctx: AppContext,
  socket: TypedSocket,
  reason: 'left' | 'kicked',
): Promise<void> {
  const roomId = socket.data.roomId;
  if (roomId === undefined) return;

  await socket.leave(roomChannel(roomId));
  delete socket.data.roomId;
  delete socket.data.roomCode;
  delete socket.data.role;

  await ctx.redis.hdel(keys.socket(socket.id), 'roomId').catch(() => undefined);
  await removeParticipantAndBroadcast(ctx, roomId, socket.data.userId, reason);
  roomsActive.set(countActiveRooms(ctx.io));
}

/**
 * Disconnect (PLAN.md §8.8).
 *
 * The participant is NOT removed — they go to `reconnecting` and the grace
 * timer decides. A 20-second Wi-Fi drop should cost a dimmed avatar, not a
 * re-join.
 */
export function registerDisconnectHandler(ctx: AppContext, socket: TypedSocket): void {
  socket.on('disconnect', (reason) => {
    runHandler(ctx, socket, 'room:leave', async () => {
      socketConnections.dec();
      ctx.limiter.forget(socket.id);

      await Promise.all([
        releaseConnection(ctx.redis, socket.data.ipHash, socket.id),
        ctx.store.forgetSocket(socket.id),
      ]);

      const roomId = socket.data.roomId;
      if (roomId === undefined) return;

      const userId = socket.data.userId;
      const entry = await ctx.store.getParticipant(roomId, userId);

      // Is another socket for this user still in the room (a second tab, or a
      // reconnect that beat this event)?
      //
      // This CANNOT be answered by comparing `entry.socketId` to `socket.id`:
      // `room:join` overwrites the presence entry with whatever socket joined
      // most recently, so the stored id is always the newest tab. Closing the
      // newer of two tabs would match, flip the user to 'reconnecting', and
      // 45s later evict them from presence while their other tab was still
      // joined to the channel — a ghost socket receiving broadcasts but failing
      // every guarded event with `not_in_room`.
      //
      // `fetchSockets()` goes through the Redis adapter, so it also sees the
      // user's other tabs on other nodes. By the time 'disconnect' fires this
      // socket has already been removed from the namespace, but the id check is
      // kept as a cheap guard against ordering surprises.
      const roomSockets = await ctx.io.in(roomChannel(roomId)).fetchSockets();
      const stillConnectedElsewhere = roomSockets.some(
        (other) => other.id !== socket.id && other.data.userId === userId,
      );
      if (stillConnectedElsewhere) return;

      if (entry) {
        // §9.5: an ungraceful leave is detected by the socket disconnect (~5 s),
        // not by ICE timeout (~30 s). The room membership survives the grace
        // period; the call does not — peers close their RTCPeerConnections now
        // and the client re-joins the call when it reconnects.
        await leaveCall(ctx, roomId, userId);
        await ctx.store.updateParticipant(roomId, userId, {
          connState: 'reconnecting',
          speaking: false,
          disconnectedAt: Date.now(),
        });
        ctx.io
          .to(roomChannel(roomId))
          .emit('presence:update', { userId, patch: { connState: 'reconnecting', speaking: false } });
        ctx.grace.arm(roomId, userId, entry.role === 'host');
      }

      if (localRoomSize(ctx, roomId) === 0) {
        // Keep the lease only while this node still has a stake in the room.
        // The grace timer above lives here, so we stay leader-eligible until it
        // resolves; untracking happens when the participant really leaves.
        ctx.log.debug({ socketId: socket.id, roomId, reason }, 'last local socket for room disconnected');
      }
      roomsActive.set(countActiveRooms(ctx.io));
    });
  });
}
