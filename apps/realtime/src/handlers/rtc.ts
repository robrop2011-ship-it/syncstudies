/**
 * WebRTC signaling (PLAN.md §9.2, §9.5, §9.6, §11.5).
 *
 * Two properties hold everywhere in this file, and both are security
 * properties rather than style:
 *
 *  - **The server is a relay with an authorization check, never a parser.** It
 *    does not read, rewrite or log SDP. SDP carries local IP addresses (§11.5),
 *    and a log line containing one is a privacy incident with a long tail.
 *  - **A signal is only ever delivered to a `to` that is proven to be in the
 *    same room and in the call.** `to` comes from the payload; the *sender*
 *    never does — identity is `socket.data.userId`, always.
 *
 * Mesh membership lives in the presence hash (`inCall`, `camOn`, `sharing`),
 * which is already the thing every node reads and the thing the participant
 * list renders. A second registry would be a second source of truth for
 * "who is in the call", and the two would disagree the first time a node died.
 */
import {
  MESH_AUDIO_MAX,
  MESH_VIDEO_MAX,
  MESH_VIDEO_MAX_WITH_SHARE,
  Schemas,
  type Participant,
  type RtcJoinAck,
} from '@syncstudy/shared';
import { z } from 'zod';
import { keys } from '../redis.js';
import { mintIceServers, hasTurn } from '../rtc/turn.js';
import { callParticipants, iceGrantsTotal, rtcSignalsTotal } from '../metrics.js';
import type { PresenceEntry } from '../rooms/RoomStore.js';
import { broadcastPresencePatch, toParticipantPatch } from './presence.js';
import { guardRoomEvent, roomChannel, runHandler, type AppContext, type TypedSocket } from './context.js';

/**
 * Perfect negotiation's tie-break (§9.2).
 *
 * For a pair, the lexicographically smaller user id is polite. Both sides
 * compute it independently from ids they already hold, so glare is resolved
 * with no extra round trip and no server involvement. `polite` on the wire is
 * always **the recipient's** politeness toward the named peer.
 */
export function isPolite(selfUserId: string, peerUserId: string): boolean {
  return selfUserId < peerUserId;
}

type PeerSummary = NonNullable<RtcJoinAck['peers']>[number];

function toPeerSummary(selfUserId: string, entry: PresenceEntry): PeerSummary {
  return {
    userId: entry.userId,
    polite: isPolite(selfUserId, entry.userId),
    audio: true,
    video: entry.camOn,
    sharing: entry.sharing,
  };
}

/** Everyone in the room who is currently in the call, this user excluded. */
function callPeers(participants: PresenceEntry[], selfUserId: string): PresenceEntry[] {
  return participants.filter((p) => p.inCall && p.userId !== selfUserId);
}

/**
 * Tear a user out of the call and tell the room.
 *
 * Called from three places — an explicit `rtc:leave`, a socket disconnect, and
 * the removal pipeline — because all three mean the same thing to the four
 * `RTCPeerConnection`s pointed at this person: close now. §9.5 is explicit that
 * teardown is driven by the signaling layer (~5 s) rather than by ICE timeout
 * (~30 s), so this must not wait for the disconnect grace period.
 */
export async function leaveCall(
  ctx: AppContext,
  roomId: string,
  userId: string,
  opts: { announce?: boolean } = {},
): Promise<void> {
  const entry = await ctx.store.getParticipant(roomId, userId);
  if (!entry) return;

  if (entry.sharing) {
    await releaseScreenshare(ctx, roomId, userId);
  }
  if (!entry.inCall) return;

  const patch: Partial<PresenceEntry> = {
    inCall: false,
    speaking: false,
    camOn: false,
    sharing: false,
  };
  await ctx.store.updateParticipant(roomId, userId, patch);

  if (opts.announce !== false) {
    broadcastPresencePatch(ctx, roomId, userId, toParticipantPatch(patch));
  }
  ctx.io.to(roomChannel(roomId)).emit('rtc:peer_left', { userId });
  ctx.log.debug({ roomId, userId }, 'left call');
}

/** Drop the single-holder screenshare lock, but only if this user holds it. */
async function releaseScreenshare(ctx: AppContext, roomId: string, userId: string): Promise<boolean> {
  const key = keys.roomScreenshare(roomId);
  const holder = await ctx.redis.get(key);
  if (holder !== userId) return false;
  await ctx.redis.del(key);
  ctx.io.to(roomChannel(roomId)).emit('rtc:screenshare_changed', { holder: null });
  return true;
}

export function registerRtcHandlers(ctx: AppContext, socket: TypedSocket): void {
  // ── join ──────────────────────────────────────────────────────────────────
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

        const { session, payload: input } = guard;
        const userId = socket.data.userId;

        if (!session.meta.policy.callEnabled) {
          ack({ ok: false, reason: 'call_disabled' });
          return;
        }

        const participants = await ctx.store.listParticipants(session.roomId);
        const peers = callPeers(participants, userId);
        const alreadyIn = session.participant.inCall;

        // §9.1: the caps are server-enforced, not client suggestions. A rejoin
        // never consumes a slot — they already hold one.
        if (!alreadyIn && peers.length + 1 > MESH_AUDIO_MAX) {
          ack({ ok: false, reason: 'call_full' });
          return;
        }

        let video = input.video;
        if (video) {
          const shareActive = participants.some((p) => p.sharing && p.userId !== userId);
          const videoCap = shareActive ? MESH_VIDEO_MAX_WITH_SHARE : MESH_VIDEO_MAX;
          const camerasOn = peers.filter((p) => p.camOn).length;
          if (camerasOn + 1 > videoCap) {
            // Refusing the whole join over a camera would be the wrong trade:
            // the point of the room is the voice. Join audio-only and say so.
            video = false;
            socket.emit('sys:notice', {
              level: 'info',
              code: 'video_full',
              message: `Cameras are capped at ${videoCap} in this room — you joined with audio only.`,
            });
          }
        }

        // Safe defaults survive here too (§11.9): a force-muted participant
        // joins the call still muted, and nothing in this handler can unmute
        // them.
        const patch: Partial<PresenceEntry> = {
          inCall: true,
          camOn: video,
          muted: session.participant.forceMuted ? true : session.participant.muted,
          speaking: false,
        };
        await ctx.store.updateParticipant(session.roomId, userId, patch);

        const grant = mintIceServers(ctx.config, userId);
        iceGrantsTotal.inc({ relay: hasTurn(ctx.config) ? 'turn' : 'stun' });
        callParticipants.observe(peers.length + 1);

        // The joiner learns the full mesh in the ack; everyone already in it
        // learns about one new peer. `polite` is per-recipient on both paths.
        ack({
          ok: true,
          iceServers: grant.iceServers,
          ttlSec: grant.ttlSec,
          peers: peers.map((peer) => toPeerSummary(userId, peer)),
        });

        for (const peer of peers) {
          ctx.io
            .to(peer.socketId)
            .emit('rtc:peer_joined', { userId, polite: isPolite(peer.userId, userId) });
        }
        broadcastPresencePatch(ctx, session.roomId, userId, toParticipantPatch(patch));

        const holder = await ctx.redis.get(keys.roomScreenshare(session.roomId));
        if (holder !== null) socket.emit('rtc:screenshare_changed', { holder });

        ctx.log.info(
          { socketId: socket.id, userId, roomId: session.roomId, peers: peers.length, video },
          'joined call',
        );
      },
      () => ack({ ok: false, reason: 'not_permitted' }),
    );
  });

  // ── leave ─────────────────────────────────────────────────────────────────
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
        await leaveCall(ctx, guard.session.roomId, socket.data.userId);
        ack({ ok: true });
      },
      (failure) => ack({ ok: false, code: failure.code, message: failure.message }),
    );
  });

  // ── signal ────────────────────────────────────────────────────────────────
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

        const { session, payload: signal } = guard;
        if (!session.participant.inCall) {
          ack({ ok: false, code: 'not_in_call', message: 'Join the call first.' });
          return;
        }
        if (signal.to === socket.data.userId) {
          ack({ ok: false, code: 'bad_payload', message: 'That request was malformed.' });
          return;
        }

        // The authorization check, and the only thing this handler thinks about.
        // A socket in room A must not be able to reach a peer in room B (§11.5),
        // and a peer who is in the room but not in the call has no peer
        // connection to hand SDP to.
        const target = await ctx.store.getParticipant(session.roomId, signal.to);
        if (!target || !target.inCall) {
          ack({ ok: false, code: 'peer_gone', message: 'That person is no longer in the call.' });
          return;
        }

        rtcSignalsTotal.inc({ kind: signal.kind });
        // Relayed verbatim. Never parsed, never rewritten, never logged.
        ctx.io.to(target.socketId).emit('rtc:signal', { ...signal, from: socket.data.userId });
        ack({ ok: true });
      },
      (failure) => ack({ ok: false, code: failure.code, message: failure.message }),
    );
  });

  // ── ICE refresh ───────────────────────────────────────────────────────────
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
        if (!guard.session.participant.inCall) {
          ack({ ok: false, code: 'not_in_call', message: 'Join the call first.' });
          return;
        }
        const grant = mintIceServers(ctx.config, socket.data.userId);
        iceGrantsTotal.inc({ relay: hasTurn(ctx.config) ? 'turn' : 'stun' });
        ack({ ok: true, data: { iceServers: grant.iceServers, ttlSec: grant.ttlSec } });
      },
      (failure) => ack({ ok: false, code: failure.code, message: failure.message }),
    );
  });

  // ── screen share (§9.6) ───────────────────────────────────────────────────
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
        const { session } = guard;
        if (!session.meta.policy.screenshareEnabled) {
          ack({ ok: false, code: 'screenshare_disabled', message: 'Screen sharing is off in this room.' });
          return;
        }
        if (!session.participant.inCall) {
          ack({ ok: false, code: 'not_in_call', message: 'Join the call first.' });
          return;
        }

        const userId = socket.data.userId;
        const key = keys.roomScreenshare(session.roomId);
        // SET NX is the whole lock. Two people hitting Share in the same
        // millisecond is exactly the case a check-then-set would get wrong.
        const won = await ctx.redis.set(key, userId, 'PX', 6 * 60 * 60 * 1000, 'NX');
        if (won === null) {
          const holder = await ctx.redis.get(key);
          if (holder !== userId) {
            ack({ ok: false, code: 'screenshare_taken', message: 'Someone else is already sharing.' });
            return;
          }
        }

        const patch: Partial<PresenceEntry> = { sharing: true, camOn: false };
        await ctx.store.updateParticipant(session.roomId, userId, patch);
        broadcastPresencePatch(ctx, session.roomId, userId, toParticipantPatch(patch));
        ctx.io.to(roomChannel(session.roomId)).emit('rtc:screenshare_changed', { holder: userId });
        ack({ ok: true });
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
        const { session } = guard;
        await releaseScreenshare(ctx, session.roomId, socket.data.userId);
        if (session.participant.sharing) {
          const patch: Partial<Participant> = { sharing: false };
          await ctx.store.updateParticipant(session.roomId, socket.data.userId, { sharing: false });
          broadcastPresencePatch(ctx, session.roomId, socket.data.userId, patch);
        }
        ack({ ok: true });
      },
      (failure) => ack({ ok: false, code: failure.code, message: failure.message }),
    );
  });
}
