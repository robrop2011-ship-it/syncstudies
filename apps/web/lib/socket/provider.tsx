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
} from '@syncstudy/shared';
import { createSocket, realtimeUrl, type TypedClientSocket } from '@/lib/socket/client';
import { ServerClock, ServerClockContext } from '@/lib/sync/clock';
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

    const activeSocket = createSocket(url);
    const activeClock = new ServerClock(activeSocket);
    const manager = activeSocket.io;

    /** Set by the cleanup: no store write may outlive the mount that caused it. */
    let disposed = false;
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

    const join = (): void => {
      joinAttempts += 1;
      activeSocket.emit('room:join', { roomCode }, (ack) => {
        if (disposed || terminal) return;

        if (ack.ok && ack.snapshot !== undefined) {
          joinedOnce = true;
          joinAttempts = 0;
          // §8.7 step 2: the snapshot rides on the ack, so there is one payload
          // and one place that applies it.
          state().applySnapshot(ack.snapshot);
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
      });
    };

    // NOTE: there is no client for `room:resync` right now, and that is
    // deliberate. It refreshes a socket that is STILL in the room — the
    // backgrounded-tab case in §8.9 — which only becomes actionable once there
    // is a player whose drift can be re-evaluated. Phase 4 wires it up. After a
    // transport drop it is useless: the server socket is new, so it always
    // answers `not_in_room` (see the note in onConnect).


    const onConnect = (): void => {
      if (disposed || terminal) return;
      state().setConnection('connected', 0);

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

    // ── room ────────────────────────────────────────────────────────────────
    // Server-initiated refresh. The server pushes one of these when a role change
    // means the client's affordances changed, rather than letting the client
    // re-derive permissions from a role string (§11.2 — one resolver, server-side).
    activeSocket.on('room:snapshot', (snapshot) => {
      if (disposed || terminal) return;
      state().applySnapshot(snapshot);
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
        message:
          reason === 'host_ended' ? 'The host ended this room.' : 'This room has ended.',
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

    // ── video (Phase 4 builds the player on top; Phase 3 only keeps the anchor) ──
    activeSocket.on('video:state', ({ anchor }) => {
      if (disposed) return;
      state().setVideo(anchor);
    });
    activeSocket.on('video:control_rejected', ({ reason, anchor }) => {
      if (disposed) return;
      // The rejection always carries the authoritative anchor precisely so a
      // rejected client can reconcile immediately instead of asking (§8.5).
      state().setVideo(anchor);
      state().noteControlRejected(reason);
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
      activeClock.stopSchedule();
      manager.off('reconnect_attempt', onReconnectAttempt);
      manager.off('reconnect_failed', onReconnectFailed);
      // Listeners first, then disconnect: the teardown must not fire our own
      // 'disconnect' handler and write 'reconnecting' into a store nobody reads.
      activeSocket.removeAllListeners();
      activeSocket.disconnect();
      setSocket(null);
      setClock(null);
    };
  }, [roomCode, router, store]);

  return (
    <RoomStoreContext.Provider value={store}>
      <ServerClockContext.Provider value={clock}>
        <SocketContext.Provider value={socket}>{children}</SocketContext.Provider>
      </ServerClockContext.Provider>
    </RoomStoreContext.Provider>
  );
}
