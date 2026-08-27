'use client';

/**
 * Where the ink engine is plugged into the room (PLAN.md §5.2).
 *
 * The controller needs three things that live in three places — the socket and
 * the `ServerClock` (owned by `RoomSocketProvider`) and the participant list (in
 * the room store) — and this is the only place they meet. That is what lets
 * `controller.ts` stay free of React and of socket.io, and be driven by a test
 * with a fake clock and a manual frame pump.
 *
 * **The controller is created inside the effect, never in a ref or during
 * render.** StrictMode mounts, unmounts and remounts every effect in
 * development. A controller built during render survives that unmount with its
 * rAF loop still scheduled and its listeners still attached — a second engine,
 * painting the same canvas, invisible except as doubled work. Built in the
 * effect, the cleanup owns exactly the controller its setup made.
 */
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type * as React from 'react';
import { clientId } from '@syncstudy/shared';
import { InkController, type RemoteStroke } from '@/lib/ink/controller';
import { inkColorFor } from '@/lib/ink/colors';
import { useSocket } from '@/lib/socket/provider';
import { useRoomStoreApi } from '@/lib/stores/room-store';
import { useServerClock } from '@/lib/sync/clock';

const InkContext = createContext<InkController | null>(null);

/**
 * Null until the socket and the clock exist — both are created inside the room
 * provider's effect, so the first render has neither, and so does every render
 * on a page that is not a room.
 */
export function useInk(): InkController | null {
  return useContext(InkContext);
}

export interface InkProviderProps {
  children: React.ReactNode;
  /**
   * This client's user id, so a server echo of our own stroke is recognised as
   * ours and not drawn twice.
   *
   * Optional because nothing below `RoomShell` publishes the viewer through
   * context — the id comes off the server-rendered bootstrap. Without it the
   * engine falls back to a per-mount local id and leans on the stroke ids it
   * minted itself to spot its own echoes, which is the same guarantee by a
   * slower route; what it loses is `draw:cleared` for our own user recognising
   * our own strokes, and `clearMine()` handles that locally anyway.
   */
  selfUserId?: string | undefined;
}

export function InkProvider({ selfUserId, children }: InkProviderProps): React.ReactElement {
  const socket = useSocket();
  const clock = useServerClock();
  const store = useRoomStoreApi();

  const fallbackId = useRef<string | null>(null);
  fallbackId.current ??= `local:${clientId()}`;
  const selfId = selfUserId ?? fallbackId.current;

  const [controller, setController] = useState<InkController | null>(null);

  useEffect(() => {
    if (socket === null || clock === null) return;

    const instance = new InkController({
      clock,
      selfId,
      // Read through `getState()` at call time rather than subscribing: this is
      // asked once per stroke, and a component that re-rendered on every
      // presence patch would be re-rendering the room several times a second to
      // learn a colour that never changes (§5.4).
      //
      // Keyed on the HANDLE, because that is what the avatar fallback hashes —
      // so a person's ink is the same slot as their avatar tint. The user id is
      // the fallback for the couple of hundred milliseconds before presence
      // lands, and is stable, so the colour is at worst consistently arbitrary.
      colorFor: (userId) => {
        const participant = store
          .getState()
          .participants.find((candidate) => candidate.id === userId);
        return inkColorFor(participant?.handle ?? userId);
      },
      // Fire and forget, with no ack. A dropped stroke is a stroke that never
      // appeared, which for something that erases itself in four seconds is a
      // non-event — and retrying would deliver it after it should have died.
      sendStroke: (payload) => {
        if (!socket.connected) return;
        socket.emit('draw:stroke', payload);
      },
      sendClear: () => {
        if (!socket.connected) return;
        socket.emit('draw:clear', {});
      },
    });

    const onStroke = (message: RemoteStroke): void => {
      instance.applyRemote(message);
    };
    const onCleared = ({ userId }: { userId: string }): void => {
      instance.clearFrom(userId);
    };

    socket.on('draw:stroke', onStroke);
    socket.on('draw:cleared', onCleared);
    instance.start();
    setController(instance);

    return () => {
      socket.off('draw:stroke', onStroke);
      socket.off('draw:cleared', onCleared);
      // Cancels the frame, clears the flush timer, drops every stroke and
      // releases the canvas. Nothing about ink outlives the room it was drawn in.
      instance.stop();
      setController(null);
    };
  }, [socket, clock, store, selfId]);

  return <InkContext.Provider value={controller}>{children}</InkContext.Provider>;
}
