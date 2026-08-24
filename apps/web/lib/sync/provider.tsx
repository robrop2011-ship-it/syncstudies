'use client';

/**
 * Where the headless drift loop is plugged into the room (PLAN.md §5.2, §8.4).
 *
 * The controller needs four things that live in four different places — a
 * `PlayerAdapter` (created by whichever component owns the iframe), the
 * `ServerClock` and the socket (owned by `RoomSocketProvider`), and the
 * authoritative anchor (in the room store). This component is the only place
 * they meet, and it exists so that the controller itself never imports React,
 * never imports socket.io, and can therefore be run headless by the simulator
 * (§15.3) with a fake player and a fake transport.
 *
 * Two boundary decisions worth knowing about:
 *
 *  - **The socket, clock and store arrive as PROPS, not context.** This module is
 *    imported *by* `lib/socket/provider.tsx`; reading `useSocket()` back out of
 *    it would be an import cycle, and cycles across a `'use client'` boundary
 *    fail as a blank page rather than as a compile error.
 *  - **The player is attached from below, not created here.** The component that
 *    renders the iframe owns its DOM node and its lifetime; it hands the adapter
 *    up through `useAttachPlayer()`. The controller borrows it and never destroys
 *    it. That is also what makes `useSyncController()` legitimately nullable:
 *    before a video exists there is no player, and therefore no loop.
 */
import { createContext, useCallback, useEffect, useRef, useState } from 'react';
import type * as React from 'react';
import type { ControlAck, PlayerAdapter, VideoAnchor } from '@syncstudy/shared';
import type { TypedClientSocket } from '@/lib/socket/client';
import type { ServerClock } from '@/lib/sync/clock';
import {
  SyncController,
  type ControlIntent,
  type SyncBridge,
} from '@/lib/sync/controller';
import type { RoomStoreApi, RoomStoreState } from '@/lib/stores/room-store';

/**
 * Hand the room its player, or `null` to take it away.
 *
 * `loadedVideoRef` tells the controller what the player already has loaded so it
 * does not immediately reload the video the caller just created it for. Omit it
 * and the current anchor's `videoRef` is assumed, which is what a component that
 * built the player from that same anchor wants.
 */
export type AttachPlayer = (player: PlayerAdapter | null, loadedVideoRef?: string | null) => void;

export const SyncControllerContext = createContext<SyncController | null>(null);
export const AttachPlayerContext = createContext<AttachPlayer | null>(null);

/**
 * Matches `ACK_TIMEOUT_MS` in components/room/socket-ack.ts. A control whose ack
 * never arrives must resolve as a failure rather than leaving an intent pending
 * forever — but as a failure the controller will NOT act on (revision -1), since
 * "we did not hear back" is not the same as "the server said no".
 */
const CONTROL_ACK_TIMEOUT_MS = 8_000;
/** `Schemas.VideoControl` / `VideoBuffering` both cap positions at 24 hours. */
const MAX_POSITION_SEC = 86_400;

function boundedPosition(positionSec: number): number {
  if (!Number.isFinite(positionSec)) return 0;
  return Number(Math.min(MAX_POSITION_SEC, Math.max(0, positionSec)).toFixed(3));
}

/** An ack the controller will read but not act on. See CONTROL_ACK_TIMEOUT_MS. */
function unanswered(anchor: VideoAnchor): ControlAck {
  return { ok: false, anchor: { ...anchor, revision: -1 } };
}

export interface SyncProviderProps {
  socket: TypedClientSocket | null;
  clock: ServerClock | null;
  store: RoomStoreApi;
  bridge: SyncBridge;
  children: React.ReactNode;
}

export function SyncProvider({
  socket,
  clock,
  store,
  bridge,
  children,
}: SyncProviderProps): React.ReactElement {
  const [player, setPlayer] = useState<PlayerAdapter | null>(null);
  const [controller, setController] = useState<SyncController | null>(null);
  /** `undefined` means "the caller did not say"; `null` means "nothing loaded". */
  const loadedVideoRef = useRef<string | null | undefined>(undefined);

  const attach = useCallback<AttachPlayer>((next, videoRef) => {
    loadedVideoRef.current = videoRef;
    setPlayer(next);
  }, []);

  useEffect(() => {
    if (player === null || clock === null || socket === null) return;

    // Read through `getState()` at call time, never closed over: the reducers are
    // stable but the DATA next to them changes on every socket event, and the
    // controller asks for a FRESH anchor on every one of its ticks.
    const state = (): RoomStoreState => store.getState();

    const sendControl = (cmd: ControlIntent): Promise<ControlAck> => {
      // Both fields are stamped here rather than in the loop, and both are read
      // at the instant of the emit (§8.4): `clientSentAtMs` in SERVER time so the
      // server can compensate for the time the request spends in flight, and
      // `expectedRevision` so two people scrubbing at once cannot both apply
      // against the same base state (§8.5b).
      const anchor = state().video;
      if (!socket.connected) return Promise.resolve(unanswered(anchor));

      return new Promise<ControlAck>((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve(unanswered(anchor));
        }, CONTROL_ACK_TIMEOUT_MS);

        socket.emit(
          'video:control',
          {
            ...cmd,
            ...(cmd.positionSec === undefined
              ? {}
              : { positionSec: boundedPosition(cmd.positionSec) }),
            clientSentAtMs: Math.round(clock.now()),
            expectedRevision: anchor.revision,
          },
          (ack) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            // Reconcile the STORE here, not in the controller: the controller
            // reverts the player, the store carries the reason to the UI. The
            // server also broadcasts `video:control_rejected` for most refusals,
            // but not for the ones caught by the handler's guard, so this is the
            // path that makes every rejection visible (§8.5d).
            state().setVideo(ack.anchor);
            if (!ack.ok) state().noteControlRejected(ack.reason ?? 'recently_changed');
            resolve(ack);
          },
        );
      });
    };

    const instance = new SyncController({
      player,
      clock,
      getAnchor: () => state().video,
      // Before the snapshot lands nobody may drive playback. That window is
      // ~200 ms and the alternative — assuming permission and being refused —
      // means a control that works once and then stops.
      canControl: () => state().you?.canControlVideo ?? false,
      sendControl,
      reportBuffering: (buffering, positionSec) => {
        if (!socket.connected) return;
        socket.emit('video:buffering', { buffering, positionSec: boundedPosition(positionSec) });
      },
      reportDrift: (report) => {
        if (!socket.connected) return;
        socket.emit('video:report_drift', {
          driftP50: report.driftP50,
          driftP95: report.driftP95,
          hardSeeks: Math.max(0, Math.round(report.hardSeeks)),
          clockOffsetMs: report.clockOffsetMs,
        });
      },
      // The ONLY channel from the loop into React, and the store's reducer drops
      // it on the floor when nothing changed (§5.4).
      onStatus: (status) => {
        state().setSyncStatus(status);
      },
    });

    const known = loadedVideoRef.current;
    instance.noteLoadedVideo(known === undefined ? state().video.videoRef : known);
    instance.setTransportConnected(socket.connected);

    bridge.controller = instance;
    instance.start();
    setController(instance);

    return () => {
      if (bridge.controller === instance) bridge.controller = null;
      instance.stop();
      setController(null);
      state().setSyncStatus(null);
    };
  }, [player, clock, socket, store, bridge]);

  return (
    <AttachPlayerContext.Provider value={attach}>
      <SyncControllerContext.Provider value={controller}>{children}</SyncControllerContext.Provider>
    </AttachPlayerContext.Provider>
  );
}
