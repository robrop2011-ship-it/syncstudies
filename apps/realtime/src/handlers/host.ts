/**
 * Host and co-host controls (PLAN.md §3.2 R7, §11.2, §11.3).
 *
 * Two rules do all the work here:
 *
 *   `can(role, permission)`     — may this role do this at all?
 *   `canActOn(actor, target)`   — may this role do it to THAT person?
 *
 * Without the second, a co-host can kick the host. Both come from
 * @syncstudy/shared, and there is no `if (role === 'host')` anywhere in this file.
 *
 * Moderation has to be fast — someone is being abusive right now — so a kick is
 * one click with no confirmation, and the target is removed before any durable
 * write is awaited.
 */
import { z } from 'zod';
import {
  Schemas,
  canActOn,
  freezeAnchor,
  type Ack,
  type Role,
  type RoomPolicy,
} from '@syncstudy/shared';
import {
  banUser,
  endRoom,
  logRoomEvent,
  setForceMuted,
  setParticipantRole,
  snapshotVideoState,
  updateRoomPolicy,
} from '../rooms/roomData.js';
import type { PresenceEntry } from '../rooms/RoomStore.js';
import {
  guardRoomEvent,
  roomChannel,
  runHandler,
  type AppContext,
  type GuardFailure,
  type TypedSocket,
} from './context.js';
import {
  broadcastPresencePatch,
  promoteNewHost,
  removeParticipantAndBroadcast,
} from './presence.js';
import { abandonWaitForSlow, stopWaitingAndResume } from './video.js';

type AckFn = (result: Ack) => void;

function fail(ack: AckFn, failure: GuardFailure): void {
  ack({ ok: false, code: failure.code, message: failure.message });
}

const NOT_PERMITTED: GuardFailure = {
  code: 'not_permitted',
  message: 'You do not have permission to do that.',
};
const NO_TARGET: GuardFailure = { code: 'no_target', message: 'That person is not in this room.' };

/**
 * Resolve a moderation target and check the actor outranks them.
 *
 * `canActOn` is strict: equal ranks cannot act on each other, and nobody can act
 * on themselves. A host who wants to leave uses `host:transfer`, not `host:kick`.
 */
async function resolveTarget(
  ctx: AppContext,
  roomId: string,
  actorId: string,
  actorRole: Role,
  targetUserId: string,
): Promise<{ ok: true; target: PresenceEntry } | { ok: false; failure: GuardFailure }> {
  if (targetUserId === actorId) return { ok: false, failure: NOT_PERMITTED };
  const target = await ctx.store.getParticipant(roomId, targetUserId);
  if (!target) return { ok: false, failure: NO_TARGET };
  if (!canActOn(actorRole, target.role)) return { ok: false, failure: NOT_PERMITTED };
  return { ok: true, target };
}

export function registerHostHandlers(ctx: AppContext, socket: TypedSocket): void {
  // ── kick ──────────────────────────────────────────────────────────────────
  socket.on('host:kick', (payload, ack) => {
    runHandler(
      ctx,
      socket,
      'host:kick',
      async () => {
        const guard = await guardRoomEvent(ctx, socket, 'host:kick', payload, {
          schema: Schemas.HostTargetUser,
          permission: 'host.kick',
        });
        if (!guard.ok) return fail(ack, guard.failure);

        const { session } = guard;
        const resolved = await resolveTarget(
          ctx,
          session.roomId,
          socket.data.userId,
          session.role,
          guard.payload.userId,
        );
        if (!resolved.ok) return fail(ack, resolved.failure);

        await kickFromRoom(ctx, session.roomId, resolved.target, socket.data.userId, false);
        void logRoomEvent(session.roomId, socket.data.userId, 'kick', { target: resolved.target.userId }, ctx.log);
        ack({ ok: true });
      },
      (failure) => fail(ack, failure),
    );
  });

  // ── ban ───────────────────────────────────────────────────────────────────
  socket.on('host:ban', (payload, ack) => {
    runHandler(
      ctx,
      socket,
      'host:ban',
      async () => {
        const guard = await guardRoomEvent(ctx, socket, 'host:ban', payload, {
          schema: Schemas.HostBan,
          permission: 'host.ban',
        });
        if (!guard.ok) return fail(ack, guard.failure);

        const { session, payload: input } = guard;
        const resolved = await resolveTarget(
          ctx,
          session.roomId,
          socket.data.userId,
          session.role,
          input.userId,
        );
        if (!resolved.ok) return fail(ack, resolved.failure);

        // The durable ban lands first: a banned user who reconnects in the
        // millisecond after the disconnect must be refused at `room:join`.
        await banUser(session.roomId, input.userId, socket.data.userId, input.reason);
        await kickFromRoom(ctx, session.roomId, resolved.target, socket.data.userId, true);
        void logRoomEvent(session.roomId, socket.data.userId, 'ban', { target: input.userId }, ctx.log);
        ack({ ok: true });
      },
      (failure) => fail(ack, failure),
    );
  });

  // ── set_role ──────────────────────────────────────────────────────────────
  socket.on('host:set_role', (payload, ack) => {
    runHandler(
      ctx,
      socket,
      'host:set_role',
      async () => {
        const guard = await guardRoomEvent(ctx, socket, 'host:set_role', payload, {
          schema: Schemas.HostSetRole,
          permission: 'host.set_role',
        });
        if (!guard.ok) return fail(ack, guard.failure);

        const { session, payload: input } = guard;
        // The schema already forbids granting 'host' or 'guest' here; host
        // handover is `host:transfer`, which is a different, deliberate action.
        const resolved = await resolveTarget(
          ctx,
          session.roomId,
          socket.data.userId,
          session.role,
          input.userId,
        );
        if (!resolved.ok) return fail(ack, resolved.failure);

        await setParticipantRole(session.roomId, input.userId, input.role);
        await ctx.store.updateParticipant(session.roomId, input.userId, { role: input.role });
        await ctx.bus.publishRoomMessage({
          type: 'role_changed',
          roomId: session.roomId,
          userId: input.userId,
          role: input.role,
        });

        broadcastPresencePatch(ctx, session.roomId, input.userId, { role: input.role });
        void logRoomEvent(
          session.roomId,
          socket.data.userId,
          'set_role',
          { target: input.userId, role: input.role },
          ctx.log,
        );
        ack({ ok: true });
      },
      (failure) => fail(ack, failure),
    );
  });

  // ── transfer ──────────────────────────────────────────────────────────────
  socket.on('host:transfer', (payload, ack) => {
    runHandler(
      ctx,
      socket,
      'host:transfer',
      async () => {
        const guard = await guardRoomEvent(ctx, socket, 'host:transfer', payload, {
          schema: Schemas.HostTargetUser,
          permission: 'host.transfer',
        });
        if (!guard.ok) return fail(ack, guard.failure);

        const { session, payload: input } = guard;
        if (input.userId === socket.data.userId) return fail(ack, NOT_PERMITTED);

        const target = await ctx.store.getParticipant(session.roomId, input.userId);
        if (!target) return fail(ack, NO_TARGET);
        if (target.role === 'guest') {
          return fail(ack, { code: 'not_permitted', message: 'Guests cannot host a room.' });
        }

        const newHost = await promoteNewHost(
          ctx,
          session.roomId,
          socket.data.userId,
          'transfer',
          input.userId,
        );
        if (newHost === null) {
          return fail(ack, { code: 'no_target', message: 'Nobody here can take over.' });
        }
        ack({ ok: true });
      },
      (failure) => fail(ack, failure),
    );
  });

  // ── force_mute ────────────────────────────────────────────────────────────
  socket.on('host:force_mute', (payload, ack) => {
    runHandler(
      ctx,
      socket,
      'host:force_mute',
      async () => {
        const guard = await guardRoomEvent(ctx, socket, 'host:force_mute', payload, {
          schema: Schemas.HostForceMute,
          permission: 'host.force_mute',
        });
        if (!guard.ok) return fail(ack, guard.failure);

        const { session, payload: input } = guard;
        const resolved = await resolveTarget(
          ctx,
          session.roomId,
          socket.data.userId,
          session.role,
          input.userId,
        );
        if (!resolved.ok) return fail(ack, resolved.failure);

        await setForceMuted(session.roomId, input.userId, input.muted);
        // Force-muting also mutes; un-force-muting does NOT auto-unmute, because
        // deciding to speak again is the participant's call (R7).
        await ctx.store.updateParticipant(session.roomId, input.userId, {
          forceMuted: input.muted,
          ...(input.muted ? { muted: true, speaking: false } : {}),
        });

        broadcastPresencePatch(ctx, session.roomId, input.userId, {
          forceMuted: input.muted,
          ...(input.muted ? { muted: true, speaking: false } : {}),
        });

        if (input.muted) {
          // Targeted at the muted participant's own socket. The Redis adapter
          // routes this to whichever node holds them.
          ctx.io.to(resolved.target.socketId).emit('rtc:force_muted', { by: socket.data.userId });
        }
        void logRoomEvent(
          session.roomId,
          socket.data.userId,
          'force_mute',
          { target: input.userId, muted: input.muted },
          ctx.log,
        );
        ack({ ok: true });
      },
      (failure) => fail(ack, failure),
    );
  });

  // ── update_policy ─────────────────────────────────────────────────────────
  socket.on('host:update_policy', (payload, ack) => {
    runHandler(
      ctx,
      socket,
      'host:update_policy',
      async () => {
        const guard = await guardRoomEvent(ctx, socket, 'host:update_policy', payload, {
          schema: Schemas.UpdateRoomPolicyInput,
          permission: 'host.policy',
        });
        if (!guard.ok) return fail(ack, guard.failure);

        const { session, payload: input } = guard;

        // Shrinking capacity below the current occupancy would silently create
        // an over-full room that nobody can rejoin. Refuse rather than kick.
        if (input.maxParticipants !== undefined) {
          const occupancy = await ctx.store.countParticipants(session.roomId);
          if (input.maxParticipants < occupancy) {
            return fail(ack, {
              code: 'too_small',
              message: `There are already ${occupancy} people here.`,
            });
          }
        }

        await updateRoomPolicy(session.roomId, input);
        const refreshed = await ctx.meta.refresh(session.roomId);

        // Switching wait_for_slow off mid-wait must RESUME the room, not merely
        // disarm the cap timer — that timer is the only thing scheduled to press
        // play, so disarming alone would strand the room paused indefinitely.
        if (refreshed && !refreshed.policy.waitForSlow) {
          await stopWaitingAndResume(ctx, session.roomId, 'recovered');
        }

        ctx.io.to(roomChannel(session.roomId)).emit('room:updated', { patch: policyPatch(input) });
        void logRoomEvent(session.roomId, socket.data.userId, 'policy_update', { ...input }, ctx.log);
        ack({ ok: true });
      },
      (failure) => fail(ack, failure),
    );
  });

  // ── end_room ──────────────────────────────────────────────────────────────
  socket.on('host:end_room', (payload, ack) => {
    runHandler(
      ctx,
      socket,
      'host:end_room',
      async () => {
        const guard = await guardRoomEvent(ctx, socket, 'host:end_room', payload, {
          schema: z.object({}),
          permission: 'host.end',
        });
        if (!guard.ok) return fail(ack, guard.failure);

        const { session } = guard;
        const roomId = session.roomId;

        await endRoom(roomId);
        await ctx.meta.invalidate(roomId);

        // Persist before tearing down: the room becomes read-only history and
        // the last position is part of that history.
        const state = await ctx.store.getState(roomId);
        if (state) await snapshotVideoState(roomId, freezeAnchor(state.anchor, Date.now()));

        ctx.io.to(roomChannel(roomId)).emit('room:ended', { by: socket.data.userId, reason: 'host_ended' });

        const participants = await ctx.store.listParticipants(roomId);
        await Promise.all(
          participants.map((p) =>
            ctx.bus.publishAdminDisconnect({
              type: 'disconnect_user',
              roomId,
              userId: p.userId,
              reason: 'room_ended',
              by: socket.data.userId,
              banned: false,
            }),
          ),
        );

        // The room is ending; a resume broadcast would go to nobody.
        abandonWaitForSlow(roomId);
        // The room's chat is over too. Any message still queued has already been
        // broadcast and still belongs in Postgres, so the queue is left alone —
        // this drops only the system-line throttle bookkeeping.
        ctx.chat.forgetRoom(roomId);
        // Land the document before dropping the live copy, or the last minute
        // of shared notes dies with the room that produced them.
        await ctx.notes.settle();
        await ctx.notes.store.purge(roomId);
        await ctx.store.purgeRoom(roomId);
        await ctx.leader.untrack(roomId);
        await ctx.store.forgetRoomCode(session.roomCode);

        void logRoomEvent(roomId, socket.data.userId, 'room_ended', null, ctx.log);
        ctx.log.info({ roomId, userId: socket.data.userId }, 'room ended by host');
        ack({ ok: true });
      },
      (failure) => fail(ack, failure),
    );
  });
}

/** Only the fields the client's RoomPolicy carries; `name`/`topic` ride along. */
function policyPatch(
  input: Schemas.UpdateRoomPolicyInput,
): Partial<RoomPolicy & { name: string; topic: string | null }> {
  const patch: Partial<RoomPolicy & { name: string; topic: string | null }> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.topic !== undefined) patch.topic = input.topic;
  if (input.playbackControl !== undefined) patch.playbackControl = input.playbackControl;
  if (input.chatLocked !== undefined) patch.chatLocked = input.chatLocked;
  if (input.slowModeSec !== undefined) patch.slowModeSec = input.slowModeSec;
  if (input.waitForSlow !== undefined) patch.waitForSlow = input.waitForSlow;
  if (input.callEnabled !== undefined) patch.callEnabled = input.callEnabled;
  if (input.screenshareEnabled !== undefined) patch.screenshareEnabled = input.screenshareEnabled;
  if (input.maxParticipants !== undefined) patch.maxParticipants = input.maxParticipants;
  return patch;
}

/**
 * Remove someone from a room across every node.
 *
 * The order is deliberate: tell them first (so the UI can explain what
 * happened), remove them from presence, then force the socket away. A ban also
 * drops the connection entirely (§11.3); a kick leaves the socket alive so the
 * client can navigate somewhere useful.
 */
async function kickFromRoom(
  ctx: AppContext,
  roomId: string,
  target: PresenceEntry,
  by: string,
  banned: boolean,
): Promise<void> {
  ctx.io.to(target.socketId).emit('room:you_were_kicked', { by, banned });
  await removeParticipantAndBroadcast(ctx, roomId, target.userId, 'kicked');
  await ctx.bus.publishAdminDisconnect({
    type: 'disconnect_user',
    roomId,
    userId: target.userId,
    reason: banned ? 'banned' : 'kicked',
    by,
    banned,
  });
  ctx.log.info({ roomId, userId: target.userId, banned }, 'participant removed by moderator');
}
