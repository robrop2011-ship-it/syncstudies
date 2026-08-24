/**
 * The authoritative video timeline (PLAN.md §8.2, §8.4, §8.5, §8.10).
 *
 * Three invariants this file exists to protect:
 *
 *  1. The server owns the timeline. A client says what it *wants*; the server
 *     says what is *true*. Nothing here trusts a client-reported position except
 *     for `seek`, which is an intent about the video rather than a measurement
 *     of now (§8.4).
 *  2. Every accepted change goes through the Lua transact, so two nodes cannot
 *     both win a race. The decision is re-checked inside Redis against the state
 *     as it is at that instant, not as it was when we read it.
 *  3. A rejection is not an error. The sender gets the authoritative anchor back
 *     immediately so it can revert its optimistic change without a round trip.
 */
import {
  CONTROL_LOCK_MS,
  Schemas,
  WAIT_FOR_SLOW_MAX_MS,
  applyControl,
  applySetVideo,
  canControlVideo,
  decideControl,
  isValidYouTubeId,
  type ControlAck,
  type ControlCommand,
  type ControlRejectReason,
  type VideoAnchor,
  type VideoStateReason,
} from '@syncstudy/shared';
import { logRoomEvent } from '../rooms/roomData.js';
import {
  guardRoomEvent,
  roomChannel,
  runHandler,
  type AppContext,
  type TypedSocket,
} from './context.js';
import {
  clockOffsetMs,
  hardSeeksTotal,
  recordControlRejection,
  videoDriftSeconds,
} from '../metrics.js';

// ── broadcasting ────────────────────────────────────────────────────────────

export function broadcastVideoState(
  ctx: AppContext,
  roomId: string,
  anchor: VideoAnchor,
  actorId: string | null,
  reason: VideoStateReason,
): void {
  ctx.io.to(roomChannel(roomId)).emit('video:state', {
    anchor,
    actorId,
    reason,
    // Sampled at emit time so a client can convert the anchor into a position
    // without needing its own clock to be right first.
    serverMs: Date.now(),
  });
}

function rejectionAck(reason: ControlRejectReason, anchor: VideoAnchor): ControlAck {
  return { ok: false, reason, anchor };
}

/** A ControlAck always carries an anchor, even when we could not read one. */
async function anchorOrEmpty(ctx: AppContext, roomId: string | undefined): Promise<VideoAnchor> {
  if (roomId === undefined) return EMPTY_ANCHOR;
  const state = await ctx.store.getState(roomId);
  return state?.anchor ?? EMPTY_ANCHOR;
}

/**
 * Tell the sender — and only the sender — that their control lost.
 *
 * The authoritative anchor rides along so the client reverts to truth rather
 * than to whatever it had before its optimistic change (§8.5d).
 */
async function rejectControl(
  ctx: AppContext,
  socket: TypedSocket,
  roomId: string,
  reason: ControlRejectReason,
  fallback: VideoAnchor,
): Promise<ControlAck> {
  recordControlRejection(reason);
  const fresh = await ctx.store.getState(roomId);
  const anchor = fresh?.anchor ?? fallback;
  socket.emit('video:control_rejected', { reason, anchor });
  return rejectionAck(reason, anchor);
}

// ── wait_for_slow (§8.10) ───────────────────────────────────────────────────

/**
 * Rooms this node has auto-paused while waiting for a slow client. Node-local
 * because only the room's leader ever arms one, and leadership is node-local.
 */
const autoPaused = new Map<string, NodeJS.Timeout>();

/**
 * Disarm the cap timer only. Callers that are ENDING a wait must use
 * `stopWaitingAndResume` instead — see the warning there.
 */
function disarmWaitTimer(roomId: string): boolean {
  const timer = autoPaused.get(roomId);
  if (timer) clearTimeout(timer);
  return autoPaused.delete(roomId);
}

/**
 * Stop waiting for slow clients and put playback back where it was.
 *
 * Disarming the timer is NOT sufficient on its own, and getting this wrong is
 * how a room ends up paused forever: the cap timer is the only thing scheduled
 * to call `resumeAfterWait`, so clearing it while the room is auto-paused
 * strands the room paused — the exact opposite of "stop waiting". Every exit
 * from a wait (policy switched off, leadership handover, shutdown) goes through
 * here.
 */
export async function stopWaitingAndResume(
  ctx: AppContext,
  roomId: string,
  why: 'cap' | 'recovered' | 'handover',
  opts: { force?: boolean } = {},
): Promise<void> {
  const wasWaiting = disarmWaitTimer(roomId);
  if (wasWaiting) await resumeAfterWait(ctx, roomId, why, opts);
}

/**
 * Drop a wait without resuming. Only valid when the room itself is going away
 * (end_room), where a resume broadcast would be noise sent to nobody.
 */
export function abandonWaitForSlow(roomId: string): void {
  disarmWaitTimer(roomId);
}

/** True when this node currently has the room auto-paused. */
export function isAwaitingSlowClients(roomId: string): boolean {
  return autoPaused.has(roomId);
}

/** Room ids this node has auto-paused, for orderly shutdown/handover. */
export function awaitingSlowClientRooms(): string[] {
  return [...autoPaused.keys()];
}

/**
 * Hard clear with NO resume. Only for the final teardown step, after
 * `resumeAllWaitingRooms()` has already put the rooms back.
 */
export function clearAllWaitForSlow(): void {
  for (const timer of autoPaused.values()) clearTimeout(timer);
  autoPaused.clear();
}

/**
 * Resume every room this node is holding paused, regardless of lease state.
 * Used on shutdown and on leadership handover so no room is left stranded.
 */
export async function resumeAllWaitingRooms(ctx: AppContext): Promise<void> {
  await Promise.all(
    awaitingSlowClientRooms().map((roomId) =>
      stopWaitingAndResume(ctx, roomId, 'handover', { force: true }),
    ),
  );
}

/** A system-initiated control: no actor, and therefore never lock-checked. */
async function systemControl(
  ctx: AppContext,
  roomId: string,
  action: 'play' | 'pause',
  reason: VideoStateReason,
): Promise<VideoAnchor | null> {
  const state = await ctx.store.getOrHydrate(roomId);
  const now = Date.now();
  const next = applyControl(
    state.anchor,
    { action, clientSentAtMs: now, expectedRevision: state.anchor.revision },
    now,
  );
  // A system action must not inherit the previous actor's control lock, and must
  // not arm one against the next human either.
  next.lastActorId = null;

  const outcome = await ctx.store.applyAtomic({
    roomId,
    next,
    expectedRevision: state.anchor.revision,
    actorId: null,
    nowMs: now,
    lockMs: 0,
  });
  if (!outcome.ok) return null;

  next.revision = outcome.revision;
  broadcastVideoState(ctx, roomId, next, null, reason);
  return next;
}

/**
 * Decide what a buffering change means for the room (§8.10).
 *
 * Only the leader runs this, so a six-person room with participants spread over
 * three nodes cannot auto-pause three times. The WAIT_FOR_SLOW_MAX_MS cap is
 * non-negotiable: one broken connection must not hold a session hostage.
 */
export async function evaluateWaitForSlow(ctx: AppContext, roomId: string): Promise<void> {
  if (!ctx.leader.isLeader(roomId)) return;

  const meta = await ctx.meta.byId(roomId);
  if (!meta || !meta.policy.waitForSlow) {
    // Resume, don't just disarm — the room may be auto-paused right now.
    await stopWaitingAndResume(ctx, roomId, 'recovered');
    return;
  }

  const [waiting, state] = await Promise.all([
    ctx.store.listBuffering(roomId),
    ctx.store.getOrHydrate(roomId),
  ]);

  if (waiting.length > 0) {
    if (autoPaused.has(roomId)) return; // already waiting; don't re-arm the cap
    if (state.anchor.status !== 'playing') return;

    const paused = await systemControl(ctx, roomId, 'pause', 'auto_buffer');
    if (!paused) return;

    const untilServerMs = Date.now() + WAIT_FOR_SLOW_MAX_MS;
    ctx.io.to(roomChannel(roomId)).emit('video:waiting', { waitingFor: waiting, untilServerMs });

    const timer = setTimeout(() => {
      autoPaused.delete(roomId);
      void resumeAfterWait(ctx, roomId, 'cap');
    }, WAIT_FOR_SLOW_MAX_MS);
    // NOTE: the entry is deleted before resuming so a resume that races with a
    // fresh buffering report can re-arm cleanly.
    timer.unref();
    autoPaused.set(roomId, timer);

    ctx.log.info({ roomId, waiting: waiting.length }, 'room auto-paused for slow clients');
    return;
  }

  // Set emptied: everyone caught up before the cap.
  await stopWaitingAndResume(ctx, roomId, 'recovered');
}

async function resumeAfterWait(
  ctx: AppContext,
  roomId: string,
  why: 'cap' | 'recovered' | 'handover',
  opts: { force?: boolean } = {},
): Promise<void> {
  try {
    // `force` is for the leadership-handover and shutdown paths, where the lease
    // is already gone by the time we run but we are still the only node that
    // knows this room is being held paused. A duplicate resume is harmless:
    // `applyAtomic` is revision-checked, so the second one simply no-ops.
    if (!opts.force && !ctx.leader.isLeader(roomId)) return;
    ctx.io.to(roomChannel(roomId)).emit('video:waiting', { waitingFor: [], untilServerMs: Date.now() });
    await systemControl(ctx, roomId, 'play', 'auto_buffer');
    ctx.log.info({ roomId, why }, 'room auto-resumed after wait_for_slow');
  } catch (err) {
    ctx.log.error({ roomId, err }, 'auto-resume failed');
  }
}

// ── handlers ────────────────────────────────────────────────────────────────

export function registerVideoHandlers(ctx: AppContext, socket: TypedSocket): void {
  // ── video:set ─────────────────────────────────────────────────────────────
  socket.on('video:set', (payload, ack) => {
    const fallback = (anchor: VideoAnchor): ControlAck => rejectionAck('not_permitted', anchor);

    runHandler(
      ctx,
      socket,
      'video:set',
      async () => {
        const guard = await guardRoomEvent(ctx, socket, 'video:set', payload, {
          schema: Schemas.VideoSet,
          permission: 'video.set',
        });
        if (!guard.ok) {
          const reason: ControlRejectReason =
            guard.failure.code === 'rate_limited' ? 'rate_limited' : 'not_permitted';
          recordControlRejection(reason);
          ack(rejectionAck(reason, await anchorOrEmpty(ctx, socket.data.roomId)));
          return;
        }

        const { session, payload: cmd } = guard;
        const state = await ctx.store.getOrHydrate(session.roomId);

        // Only YouTube in v1 (V11/V12 are explicitly deferred), and the id is
        // validated here so nothing downstream ever interpolates an unchecked
        // string into an iframe src (§11.6).
        if (cmd.provider !== 'youtube' || !isValidYouTubeId(cmd.videoRef)) {
          ack(await rejectControl(ctx, socket, session.roomId, 'no_video', state.anchor));
          return;
        }

        const now = Date.now();
        const next = applySetVideo(state.anchor, cmd, now);
        next.lastActorId = socket.data.userId;

        const outcome = await ctx.store.applyAtomic({
          roomId: session.roomId,
          next,
          expectedRevision: state.anchor.revision,
          actorId: socket.data.userId,
          nowMs: now,
          lockMs: CONTROL_LOCK_MS,
          extra: {
            provider: next.provider,
            videoRef: next.videoRef ?? '',
            title: next.title ?? '',
            duration: next.durationSec === null ? '' : String(next.durationSec),
          },
        });

        if (!outcome.ok) {
          ack(
            await rejectControl(
              ctx,
              socket,
              session.roomId,
              outcome.reason ?? 'recently_changed',
              state.anchor,
            ),
          );
          return;
        }

        next.revision = outcome.revision;
        broadcastVideoState(ctx, session.roomId, next, socket.data.userId, 'set_video');
        void logRoomEvent(
          session.roomId,
          socket.data.userId,
          'video_set',
          { provider: next.provider, videoRef: next.videoRef },
          ctx.log,
        );
        ack({ ok: true, anchor: next });
      },
      () => ack(fallback(EMPTY_ANCHOR)),
    );
  });

  // ── video:control ─────────────────────────────────────────────────────────
  socket.on('video:control', (payload, ack) => {
    runHandler(
      ctx,
      socket,
      'video:control',
      async () => {
        const guard = await guardRoomEvent(ctx, socket, 'video:control', payload, {
          schema: Schemas.VideoControl,
        });
        if (!guard.ok) {
          const reason: ControlRejectReason =
            guard.failure.code === 'rate_limited' ? 'rate_limited' : 'not_permitted';
          recordControlRejection(reason);
          ack(rejectionAck(reason, await anchorOrEmpty(ctx, socket.data.roomId)));
          return;
        }

        const { session, payload: cmd } = guard;
        const roomId = session.roomId;
        const actorId = socket.data.userId;

        // Policy gate (§8.5a). This is not a `Permission` because it depends on
        // the room's playback_control setting, not on the role alone.
        if (!canControlVideo(session.role, session.meta.policy.playbackControl)) {
          const state = await ctx.store.getOrHydrate(roomId);
          ack(await rejectControl(ctx, socket, roomId, 'not_permitted', state.anchor));
          return;
        }

        const state = await ctx.store.getOrHydrate(roomId);
        if (state.anchor.provider === 'none' || state.anchor.videoRef === null) {
          ack(await rejectControl(ctx, socket, roomId, 'no_video', state.anchor));
          return;
        }

        const now = Date.now();
        const command: ControlCommand = {
          action: cmd.action,
          clientSentAtMs: cmd.clientSentAtMs,
          expectedRevision: cmd.expectedRevision,
          ...(cmd.positionSec === undefined ? {} : { positionSec: cmd.positionSec }),
          ...(cmd.rate === undefined ? {} : { rate: cmd.rate }),
        };

        // Decide locally first so the rejection reason is the one §8.5 defines,
        // then let the Lua re-decide atomically. The local pass is an
        // optimisation and a source of truth for the reason; the Lua pass is the
        // guarantee.
        const decision = decideControl(state.anchor, command, actorId, now, CONTROL_LOCK_MS);
        if (!decision.accepted) {
          ack(
            await rejectControl(ctx, socket, roomId, decision.reason ?? 'recently_changed', state.anchor),
          );
          return;
        }

        const next = applyControl(state.anchor, command, now);
        next.lastActorId = actorId;

        // `expectedRevision: -1` means "the client does not know the revision"
        // (a resync), not "skip the concurrency check". We substitute the
        // revision we just read, so the CAS still protects the write.
        const expectedRevision =
          command.expectedRevision >= 0 ? command.expectedRevision : state.anchor.revision;

        const outcome = await ctx.store.applyAtomic({
          roomId,
          next,
          expectedRevision,
          actorId,
          nowMs: now,
          lockMs: CONTROL_LOCK_MS,
        });

        if (!outcome.ok) {
          ack(await rejectControl(ctx, socket, roomId, outcome.reason ?? 'stale_revision', state.anchor));
          return;
        }

        next.revision = outcome.revision;
        broadcastVideoState(ctx, roomId, next, actorId, 'control');
        ack({ ok: true, anchor: next });
      },
      () => ack(rejectionAck('not_permitted', EMPTY_ANCHOR)),
    );
  });

  // ── video:buffering ───────────────────────────────────────────────────────
  socket.on('video:buffering', (payload) => {
    runHandler(ctx, socket, 'video:buffering', async () => {
      const guard = await guardRoomEvent(ctx, socket, 'video:buffering', payload, {
        schema: Schemas.VideoBuffering,
      });
      if (!guard.ok) return;

      const { session, payload: report } = guard;
      const roomId = session.roomId;

      await ctx.store.markBuffering(roomId, socket.data.userId, report.buffering);
      await ctx.store.updateParticipant(roomId, socket.data.userId, { buffering: report.buffering });

      // Everyone sees a small spinner on that avatar whether or not the room
      // waits — knowing *who* is stalling is most of the value (§8.10).
      ctx.io
        .to(roomChannel(roomId))
        .emit('presence:update', { userId: socket.data.userId, patch: { buffering: report.buffering } });

      if (!session.meta.policy.waitForSlow) return;

      if (ctx.leader.isLeader(roomId)) {
        await evaluateWaitForSlow(ctx, roomId);
      } else {
        // The leader owns the pause/resume decision; tell it something changed.
        await ctx.bus.publishRoomMessage({ type: 'buffering_changed', roomId });
      }
    });
  });

  // ── video:report_drift (telemetry, §16.5) ─────────────────────────────────
  socket.on('video:report_drift', (payload) => {
    runHandler(ctx, socket, 'video:report_drift', async () => {
      const guard = await guardRoomEvent(ctx, socket, 'video:report_drift', payload, {
        schema: Schemas.VideoReportDrift,
      });
      if (!guard.ok) return;

      const report = guard.payload;
      videoDriftSeconds.observe(Math.abs(report.driftP50));
      videoDriftSeconds.observe(Math.abs(report.driftP95));
      clockOffsetMs.observe(Math.abs(report.clockOffsetMs));
      if (report.hardSeeks > 0) hardSeeksTotal.inc(report.hardSeeks);
    });
  });
}

/**
 * Used only when we must answer a client but cannot read the real anchor (the
 * room is gone, or Redis just failed). Its revision of -1 is deliberately
 * impossible, so a client can tell it apart from real state.
 */
const EMPTY_ANCHOR: VideoAnchor = {
  provider: 'none',
  videoRef: null,
  title: null,
  durationSec: null,
  status: 'idle',
  anchorPositionSec: 0,
  anchorServerMs: 0,
  playbackRate: 1,
  revision: -1,
  lastActorId: null,
  lastChangeMs: 0,
};
