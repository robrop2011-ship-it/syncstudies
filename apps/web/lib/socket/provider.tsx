'use client';

/**
 * The room's socket lifecycle (PLAN.md §5.2, §8.7, §8.8, §2.3).
 *
 * This component owns three things that must live and die together — the socket,
 * the `ServerClock` that rides on it, and the room store the events feed — and it
 * publishes all three through context so nothing below has to thread them.
 *
 * StrictMode: the socket is created INSIDE the effect, never during render or in
 * a `useRef` initialiser. React 18/19 StrictMode mounts, unmounts and remounts
 * every effect in development. A socket created during render survives that
 * unmount with all its listeners attached — connected, joined, receiving the
 * room's broadcasts, and invisible. Created in the effect, the cleanup owns
 * exactly the socket its setup made: listeners off, socket disconnected, gone.
 * (`createSocket` also passes `forceNew`, so the remount cannot be handed the
 * same multiplexed instance back.)
 */
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  CLOCK_SAMPLES_JOIN,
  CLOCK_SAMPLES_RESYNC,
  CLOCK_SAMPLE_SPACING_MS,
  ROOM_HEARTBEAT_MS,
  WAIT_FOR_SLOW_MAX_MS,
} from '@syncstudy/shared';
import { createSocket, realtimeUrl, type TypedClientSocket } from '@/lib/socket/client';
import { ticketAuth } from '@/lib/socket/ticket';
import { ServerClock, ServerClockContext } from '@/lib/sync/clock';
import { createSyncBridge, type AnchorReason, type SyncBridge } from '@/lib/sync/controller';
import { SyncProvider } from '@/lib/sync/provider';
import {
  createRoomStore,
  RoomStoreContext,
  type JoinError,
  type RoomStoreApi,
  type RoomStoreState,
} from '@/lib/stores/room-store';

/**
 * Join failures worth another try. Everything else — no such room, banned, full,
 * ended — is an answer, not a hiccup, and retrying it just means the same refusal
 * five more times.
 */
const RETRYABLE_JOIN_CODES = new Set(['server_error', 'rate_limited']);
const MAX_JOIN_ATTEMPTS = 3;
const JOIN_RETRY_DELAY_MS = 1_500;

/**
 * Handshake refusals from `apps/realtime/src/auth/handshake.ts` that will refuse
 * identically forever. socket.io retries a `connect_error` on its backoff by
 * default, which for these means hammering the server with a request it has
 * already answered — so we stop and say why.
 *
 * `unauthenticated` is handled separately: it is not an error state, it is a
 * login redirect (§8.8).
 */
/**
 * The realtime service refuses a reconnect for 60s after three rate-limit
 * strikes (§11.7). Matches COOLDOWN_MS in apps/realtime/src/auth/handshake.ts.
 */
const HANDSHAKE_COOLDOWN_MS = 60_000;

const FATAL_HANDSHAKE: Record<string, string> = {
  bad_origin: 'This page is not allowed to reach the realtime server.',
  account_suspended: 'This account is suspended.',
  too_many_connections: 'Too many SyncStudy connections from your network. Close a tab and retry.',
};

const SocketContext = createContext<TypedClientSocket | null>(null);

export function useSocket(): TypedClientSocket | null {
  return useContext(SocketContext);
}

/**
 * `video:state` carries the server's reason for the change; the drift loop's
 * vocabulary is slightly narrower (§8.6 also has 'snapshot', which only ever
 * comes from a join). `auto_buffer` is a real, authoritative status change that
 * the wait-for-slow logic made on everyone's behalf, so it is applied with the
 * same urgency as a human pressing pause.
 */
const ANCHOR_REASON: Record<string, AnchorReason> = {
  control: 'control',
  heartbeat: 'heartbeat',
  auto_buffer: 'control',
  resync: 'resync',
  set_video: 'set_video',
};

export interface RoomSocketProviderProps {
  roomCode: string;
  children: React.ReactNode;
}

export function RoomSocketProvider({
  roomCode,
  children,
}: RoomSocketProviderProps): React.ReactElement {
  const router = useRouter();

  // One store per mounted provider. Created lazily in a ref so it exists on the
  // first render (children may select from it before the effect has run) and is
  // never a module-level singleton (see room-store.ts).
  const storeRef = useRef<RoomStoreApi | null>(null);
  storeRef.current ??= createRoomStore();
  const store = storeRef.current;

  // The slot the socket handlers below push authoritative anchors into. It has to
  // exist before the effect runs and outlive every reconnect, because the
  // controller on the other end of it is created by a DESCENDANT — the moment a
  // player is attached — which is long after the first `video:state` can arrive.
  const bridgeRef = useRef<SyncBridge | null>(null);
  bridgeRef.current ??= createSyncBridge();
  const bridge = bridgeRef.current;

  // Both are null until the effect runs; the contract types say so, and the
  // consumers below all handle it — a socket that exists before the effect is
  // exactly the zombie this design avoids.
  const [socket, setSocket] = useState<TypedClientSocket | null>(null);
  const [clock, setClock] = useState<ServerClock | null>(null);

  useEffect(() => {
    // Read through `getState()` at call time rather than closing over a snapshot:
    // the reducers are stable, but the DATA next to them is not.
    const state = (): RoomStoreState => store.getState();

    // Navigating from one room to another reuses this component, so the previous
    // room's participants and anchor have to go before the new socket opens.
    state().reset();
    state().setConnection('connecting', 0);

    const url = realtimeUrl();
    if (url === null) {
      state().setJoinError({
        code: 'not_configured',
        message: 'The realtime server address is not configured.',
      });
      state().setConnection('failed', 0);
      return;
    }

    const activeSocket = createSocket(url, ticketAuth());
    const activeClock = new ServerClock(activeSocket);
    const manager = activeSocket.io;

    /** Set by the cleanup: no store write may outlive the mount that caused it. */
    let disposed = false;
    /** Local backstop for the §8.10 wait label; see the `video:waiting` handler. */
    let waitTimer = 0;
    /** Set by anything that means "we are not coming back": kicked, banned, ended. */
    let terminal = false;
    /** Have we completed a join on this socket? Decides `room:join` vs `room:resync`. */
    let joinedOnce = false;
    let joinAttempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const clearRetry = (): void => {
      if (retryTimer === null) return;
      clearTimeout(retryTimer);
      retryTimer = null;
    };

    const endSession = (error: JoinError): void => {
      terminal = true;
      clearRetry();
      activeClock.stopSchedule();
      state().setJoinError(error);
      // Stop reconnecting. Without this the client keeps re-opening a socket to a
      // room it has been removed from, and every attempt is a fresh handshake, a
      // fresh Postgres membership check, and a fresh refusal.
      activeSocket.disconnect();
      state().setConnection('failed', 0);
    };

    const publishOffset = (): void => {
      if (disposed) return;
      state().setServerTimeOffset(activeClock.now() - Date.now());
    };

    /**
     * One place that applies a snapshot, because there are two sources of them
     * (the join ack and a server push) and the ORDER matters: the store first,
     * then the controller — the controller reads the anchor back out of the
     * store on every tick, so telling it about an anchor the store has not
     * accepted yet would have it converge on the previous one.
     */
    const applySnapshot = (
      snapshot: Parameters<RoomStoreState['applySnapshot']>[0],
      backfilled = false,
    ): void => {
      state().applySnapshot(snapshot, { backfilled });
      // §8.7 / §8.8: a snapshot is a join, a late join, or a reconnect. All three
      // want the player put where the anchor says without measuring first.
      bridge.controller?.applyAnchor(snapshot.video, 'snapshot');
    };

    /**
     * The newest message the server has confirmed to us.
     *
     * Sent with a rejoin so the snapshot backfills what was missed instead of
     * handing back the newest page and leaving a hole. Pending sends are skipped
     * on purpose — their ids are local, and the server would have nothing to
     * compare them against.
     */
    const lastServerMessageId = (): string | undefined => {
      const messages = state().messages;
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (message !== undefined && message.delivery === 'sent') return message.id;
      }
      return undefined;
    };

    const join = (): void => {
      joinAttempts += 1;
      const cursor = lastServerMessageId();
      activeSocket.emit(
        'room:join',
        { roomCode, ...(cursor === undefined ? {} : { lastMessageId: cursor }) },
        (ack) => {
          if (disposed || terminal) return;

          if (ack.ok && ack.snapshot !== undefined) {
            joinedOnce = true;
            joinAttempts = 0;
            // §8.7 step 2: the snapshot rides on the ack, so there is one payload
            // and one place that applies it.
            applySnapshot(ack.snapshot, cursor !== undefined);
            return;
          }

          const code = ack.code ?? 'join_failed';
          const message = ack.message ?? 'Could not join this room.';
          if (RETRYABLE_JOIN_CODES.has(code) && joinAttempts < MAX_JOIN_ATTEMPTS) {
            state().setJoinError({ code, message });
            retryTimer = setTimeout(() => {
              retryTimer = null;
              if (disposed || terminal || !activeSocket.connected) return;
              join();
            }, JOIN_RETRY_DELAY_MS * joinAttempts);
            return;
          }
          endSession({ code, message });
        },
      );
    };

    /**
     * §8.9, the backgrounded-tab case. `room:resync` refreshes a socket that is
     * STILL in the room, which is the one situation where we may have missed a
     * broadcast without ever seeing a disconnect: a suspended mobile tab can
     * have its buffered frames dropped underneath a connection that never
     * reported closing.
     *
     * Gated on how long we were away — a tab you flicked away from for two
     * seconds missed nothing, and the server rate-limits this event. Elapsed
     * time is measured with `performance.now()` because the whole point of the
     * check is that the machine may have slept and `Date.now()` may have
     * stepped. After a transport DROP this is useless: socket.io reconnects with
     * a brand new server-side socket, so `socket.data.roomId` is unset and the
     * server correctly answers `not_in_room`. That path joins instead.
     */
    let hiddenSinceMono: number | null = null;
    const onVisibility = (): void => {
      if (disposed || terminal) return;
      if (document.visibilityState !== 'visible') {
        hiddenSinceMono = performance.now();
        return;
      }
      const away = hiddenSinceMono === null ? 0 : performance.now() - hiddenSinceMono;
      hiddenSinceMono = null;
      if (!joinedOnce || !activeSocket.connected || away < ROOM_HEARTBEAT_MS) return;
      const cursor = lastServerMessageId();
      activeSocket.emit(
        'room:resync',
        {
          lastRevision: state().video.revision,
          ...(cursor === undefined ? {} : { lastMessageId: cursor }),
        },
        (ack) => {
          if (disposed || terminal) return;
          if (ack.ok && ack.snapshot !== undefined) {
            applySnapshot(ack.snapshot, cursor !== undefined);
          }
        },
      );
    };

    const onConnect = (): void => {
      if (disposed || terminal) return;
      state().setConnection('connected', 0);
      bridge.controller?.setTransportConnected(true);

      // `resuming` only selects the CLOCK sample count. It deliberately does not
      // select resync-vs-join any more: socket.io reconnection creates a brand
      // new server-side socket, `socket.data.roomId` is per-connection, and the
      // server does not enable `connectionStateRecovery` — so `room:resync`
      // after a transport drop always answers `not_in_room` (verified against a
      // live server). Joining directly saves a guaranteed-wasted round trip on
      // every reconnect, and the join handler already treats a returning
      // participant as a reconnect.
      const resuming = joinedOnce;
      // The clock is synced BEFORE the snapshot is requested, on both paths.
      // §8.7 draws the join and the sync as parallel, and §8.8 requires the sync
      // first on reconnect; doing it first on both paths is the stronger
      // guarantee, because it means no VideoAnchor is ever applied while
      // `clock.isReady` is false — and an anchor read against an unsynced clock
      // resolves to the wrong position with total confidence. The parallelism
      // §8.7 actually cares about (the YouTube iframe loading meanwhile) is
      // untouched: that happens in the player, not here.
      void activeClock
        .sync(resuming ? CLOCK_SAMPLES_RESYNC : CLOCK_SAMPLES_JOIN, CLOCK_SAMPLE_SPACING_MS)
        .then(
          () => {
            if (disposed || terminal || !activeSocket.connected) return;
            publishOffset();
            activeClock.startSchedule(publishOffset);
            join();
          },
          () => undefined,
        );
    };

    const onDisconnect = (reason: string): void => {
      if (disposed) return;
      // §8.8: pause the drift loop. There is nothing authoritative to compare
      // against, so corrections would be guesses — but playback keeps running.
      bridge.controller?.setTransportConnected(false);
      if (terminal) {
        state().setConnection('failed', 0);
        return;
      }
      // §2.3: a drop is a thin amber bar and nothing else. The player keeps
      // playing locally — a 20-second Wi-Fi blip should cost a dimmed avatar, not
      // a pause in the middle of a sentence.
      if (reason === 'io server disconnect') {
        // The server closed us deliberately (a ban drops the connection). socket.io
        // does not reconnect on its own for this reason, and it should not.
        endSession({ code: 'disconnected', message: 'The server closed this connection.' });
        return;
      }
      state().setConnection('reconnecting', 0);
    };

    /**
     * socket.io emits `reconnect_attempt(n)` and then `connect_error` when that
     * attempt fails, so passing a literal 0 from the error path would clobber the
     * counter the attempt handler just set — leaving it oscillating 1→0→2→0 and
     * reading 0 whenever a failure was the most recent event.
     */
    const currentAttempts = (): number => state().connection.attempts;

    const onConnectError = (error: Error): void => {
      if (disposed || terminal) return;
      const reason = error.message;

      // §8.8: a session can expire mid-outage. Preserve the room in `next` so the
      // login form lands them back here instead of on the dashboard.
      if (reason === 'unauthenticated') {
        terminal = true;
        clearRetry();
        activeClock.stopSchedule();
        activeSocket.disconnect();
        router.replace(`/login?next=${encodeURIComponent(`/r/${roomCode}`)}`);
        return;
      }

      const fatal = FATAL_HANDSHAKE[reason];
      if (fatal !== undefined) {
        endSession({ code: reason, message: fatal });
        return;
      }

      // `rate_limited` is the server's 60s post-abuse cooldown. socket.io's own
      // backoff tops out around 10s, so left alone it would spend the whole
      // cooldown being refused. Wait it out once, then let the normal flow resume.
      if (reason === 'rate_limited') {
        state().setConnection('reconnecting', currentAttempts());
        clearRetry();
        retryTimer = setTimeout(() => {
          if (!disposed && !terminal) activeSocket.connect();
        }, HANDSHAKE_COOLDOWN_MS);
        return;
      }

      // `server_error` means the handshake failed closed — Redis unreachable,
      // most likely. Transient, so keep retrying, but do not pretend it is a
      // plain transport blip.
      state().setConnection(joinedOnce ? 'reconnecting' : 'connecting', currentAttempts());
    };

    const onReconnectAttempt = (attempt: number): void => {
      if (disposed || terminal) return;
      state().setConnection('reconnecting', attempt);
    };

    const onReconnectFailed = (): void => {
      if (disposed || terminal) return;
      state().setConnection('failed', 0);
    };

    activeSocket.on('connect', onConnect);
    activeSocket.on('disconnect', onDisconnect);
    activeSocket.on('connect_error', onConnectError);
    manager.on('reconnect_attempt', onReconnectAttempt);
    manager.on('reconnect_failed', onReconnectFailed);
    document.addEventListener('visibilitychange', onVisibility);

    // ── room ────────────────────────────────────────────────────────────────
    // Server-initiated refresh. The server pushes one of these when a role change
    // means the client's affordances changed, rather than letting the client
    // re-derive permissions from a role string (§11.2 — one resolver, server-side).
    activeSocket.on('room:snapshot', (snapshot) => {
      if (disposed || terminal) return;
      applySnapshot(snapshot);
    });
    activeSocket.on('room:updated', ({ patch }) => {
      if (disposed) return;
      state().applyRoomPatch(patch);
    });
    activeSocket.on('room:host_changed', ({ hostId }) => {
      if (disposed) return;
      state().setHost(hostId);
    });
    activeSocket.on('room:ended', ({ reason }) => {
      if (disposed) return;
      endSession({
        code: 'room_ended',
        message: reason === 'host_ended' ? 'The host ended this room.' : 'This room has ended.',
      });
    });
    activeSocket.on('room:you_were_kicked', ({ banned }) => {
      if (disposed) return;
      endSession(
        banned
          ? { code: 'banned', message: 'You were removed from this room and cannot rejoin.' }
          : { code: 'kicked', message: 'You were removed from this room.' },
      );
    });

    // ── presence ────────────────────────────────────────────────────────────
    activeSocket.on('presence:join', ({ participant }) => {
      if (disposed) return;
      state().participantJoined(participant);
    });
    activeSocket.on('presence:leave', ({ userId }) => {
      if (disposed) return;
      state().participantLeft(userId);
    });
    activeSocket.on('presence:update', ({ userId, patch }) => {
      if (disposed) return;
      state().participantPatched(userId, patch);
    });

    // ── video (§8.6) ─────────────────────────────────────────────────────────
    // Store first, controller second, in one handler. Two independent listeners
    // would leave that order up to registration order, and the controller reads
    // the anchor back out of the store.
    activeSocket.on('video:state', ({ anchor, reason }) => {
      if (disposed) return;
      state().setVideo(anchor);
      bridge.controller?.applyAnchor(anchor, ANCHOR_REASON[reason] ?? 'control');
    });
    activeSocket.on('video:control_rejected', ({ reason, anchor }) => {
      if (disposed) return;
      // The rejection always carries the authoritative anchor precisely so a
      // rejected client can reconcile immediately instead of asking (§8.5).
      state().setVideo(anchor);
      state().noteControlRejected(reason);
      bridge.controller?.applyAnchor(anchor, 'control');
    });
    // §8.10. The server sends the clearing broadcast itself, so the timer is a
    // backstop for the one case that broadcast cannot cover: the leader node
    // dying mid-wait. Without it the label outlives the pause forever; with it
    // the worst case is the label lasting exactly as long as the server's own
    // cap. `untilServerMs` is server time, so it goes through the clock offset —
    // a client whose wall clock is two seconds fast must not clear it early.
    activeSocket.on('video:waiting', ({ waitingFor, untilServerMs }) => {
      if (disposed) return;
      window.clearTimeout(waitTimer);
      if (waitingFor.length === 0) {
        state().setWaiting(null);
        return;
      }
      state().setWaiting({ userIds: waitingFor, untilServerMs });
      const remainingMs = untilServerMs - activeClock.now();
      waitTimer = window.setTimeout(
        () => {
          if (!disposed) state().setWaiting(null);
        },
        Math.max(0, Math.min(remainingMs, WAIT_FOR_SLOW_MAX_MS)),
      );
    });

    // ── chat (§3.5) ─────────────────────────────────────────────────────────
    // No filter for "this is my own message": the sender's optimistic copy is
    // reconciled against this one by `clientMsgId`, so everyone in the room —
    // including the author — ends up rendering the server's object.
    activeSocket.on('chat:message', ({ message }) => {
      if (disposed) return;
      state().receiveMessages([message]);
    });
    activeSocket.on('chat:deleted', ({ messageId }) => {
      if (disposed) return;
      state().markMessageDeleted(messageId);
    });

    // ── study tools (§3.6, §8.12) ───────────────────────────────────────────
    // Applied unconditionally, sender included: the server's copy carries the
    // version and position this client cannot know, and its own optimistic copy
    // is reconciled by block id.
    activeSocket.on('notes:block_updated', ({ blockId, text, version, position }) => {
      if (disposed) return;
      state().applyBlockUpdate({ id: blockId, text, version, position });
    });
    activeSocket.on('notes:block_locked', ({ blockId, userId, untilServerMs }) => {
      if (disposed) return;
      state().setBlockLock(blockId, userId, untilServerMs);
    });
    activeSocket.on('notes:item_created', ({ item }) => {
      if (disposed) return;
      state().upsertNoteItem(item);
    });
    activeSocket.on('notes:item_updated', ({ item }) => {
      if (disposed) return;
      state().upsertNoteItem(item);
    });
    activeSocket.on('notes:item_deleted', ({ id }) => {
      if (disposed) return;
      state().removeNoteItem(id);
    });
    activeSocket.on('checklist:created', ({ item }) => {
      if (disposed) return;
      state().upsertChecklistItem(item);
    });
    activeSocket.on('checklist:updated', ({ item }) => {
      if (disposed) return;
      state().upsertChecklistItem(item);
    });
    activeSocket.on('checklist:deleted', ({ id }) => {
      if (disposed) return;
      state().removeChecklistItem(id);
    });

    // ── system ──────────────────────────────────────────────────────────────
    activeSocket.on('sys:notice', (notice) => {
      if (disposed) return;
      state().pushNotice(notice);
    });
    activeSocket.on('sys:rate_limited', ({ event, retryAfterMs }) => {
      if (disposed) return;
      state().noteRateLimited(event, retryAfterMs);
    });

    setSocket(activeSocket);
    setClock(activeClock);
    activeSocket.connect();

    return () => {
      disposed = true;
      clearRetry();
      window.clearTimeout(waitTimer);
      activeClock.stopSchedule();
      document.removeEventListener('visibilitychange', onVisibility);
      manager.off('reconnect_attempt', onReconnectAttempt);
      manager.off('reconnect_failed', onReconnectFailed);
      // Listeners first, then disconnect: the teardown must not fire our own
      // 'disconnect' handler and write 'reconnecting' into a store nobody reads.
      activeSocket.removeAllListeners();
      activeSocket.disconnect();
      setSocket(null);
      setClock(null);
    };
  }, [roomCode, router, store, bridge]);

  return (
    <RoomStoreContext.Provider value={store}>
      <ServerClockContext.Provider value={clock}>
        <SocketContext.Provider value={socket}>
          {/* Inside the socket, clock and store, and mounted for exactly as long
              as the room is: the drift loop starts when a player is attached and
              is torn down with this provider. Passed as props rather than read
              from the contexts above, because this module imports SyncProvider —
              reading `useSocket()` from there would be an import cycle. */}
          <SyncProvider socket={socket} clock={clock} store={store} bridge={bridge}>
            {children}
          </SyncProvider>
        </SocketContext.Provider>
      </ServerClockContext.Provider>
    </RoomStoreContext.Provider>
  );
}
