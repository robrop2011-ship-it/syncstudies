'use client';

/**
 * The three hooks the room UI uses to reach the drift loop (PLAN.md §5.4).
 *
 * They are deliberately three, at three different frequencies, because the whole
 * performance budget for the room page lives in this distinction:
 *
 *   useSyncController  — changes at most twice a session (a player appeared, or went away)
 *   useSyncStatus      — changes a handful of times a minute (a coarse, publishable state)
 *   usePlayheadRef     — changes 60 times a second, and therefore is NOT state
 *
 * Putting the playhead in state would re-render the room sixty times a second to
 * move a two-pixel thumb, which on a Chromebook is the difference between a video
 * that plays and a video that stutters. The scrubber reads `ref.current` inside
 * its own rAF loop and writes `style.transform` directly (§5.4).
 */
import { useContext, useEffect, useRef } from 'react';
import type * as React from 'react';
import { useRoomStore } from '@/lib/stores/room-store';
import type { SyncController } from '@/lib/sync/controller';
import { AttachPlayerContext, SyncControllerContext, type AttachPlayer } from '@/lib/sync/provider';
import type { SyncStatus } from '@/lib/sync/types';

/**
 * Null until a `PlayerAdapter` has been attached — there is no drift loop
 * without something to keep in sync. Every caller must handle it: the room is
 * fully usable (chat, notes, people) with no video in it.
 */
export function useSyncController(): SyncController | null {
  return useContext(SyncControllerContext);
}

/**
 * Coarse sync state, published by the controller only when a field changed.
 *
 * Read through the room store rather than a dedicated context so a component
 * that only cares about, say, `quality` can select it and not re-render when
 * `driftSec` moves.
 */
export function useSyncStatus(): SyncStatus {
  return useRoomStore((state) => state.sync);
}

/**
 * The live playhead in seconds. Read it from a rAF loop; never render it.
 *
 * The loop polls rather than being pushed to, because the player is the source of
 * truth for its own position and a push would need the controller to tick at
 * frame rate — the thing this hook exists to avoid. Polling stops the moment the
 * document is hidden: a background tab is not painting anything for the value to
 * move.
 */
export function usePlayheadRef(): React.RefObject<number> {
  const controller = useSyncController();
  const ref = useRef<number>(0);

  useEffect(() => {
    if (controller === null) {
      ref.current = 0;
      return;
    }
    let frame = 0;
    const sample = (): void => {
      ref.current = controller.getPlayheadSec();
      frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [controller]);

  return ref;
}

/**
 * Register the room's player. Call with `null` on unmount, and destroy the
 * adapter yourself — the controller borrows it, it does not own it.
 *
 * ```tsx
 * const attach = useAttachPlayer();
 * useEffect(() => {
 *   let disposed = false;
 *   let created: PlayerAdapter | null = null;
 *   void createYouTubePlayer({ container, videoId, startAtSec }).then((player) => {
 *     if (disposed) { player.destroy(); return; }
 *     created = player;
 *     attach(player, videoId);
 *   });
 *   return () => { disposed = true; attach(null); created?.destroy(); };
 * }, [videoId, attach]);
 * ```
 */
export function useAttachPlayer(): AttachPlayer {
  const attach = useContext(AttachPlayerContext);
  if (attach === null) {
    throw new Error('useAttachPlayer() is only available inside <RoomSocketProvider>.');
  }
  return attach;
}
