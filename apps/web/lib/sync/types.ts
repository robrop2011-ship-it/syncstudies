/**
 * What the room's UI is allowed to know about synchronisation (PLAN.md §5.2).
 *
 * The `SyncController` is headless: it runs on a 2 Hz timer, talks to a player
 * and a socket, and never renders. The only thing it hands React is this
 * object — and it hands it over ONLY when a field actually changed. That
 * constraint is the whole point of the file. Drift is measured every 500 ms; if
 * every measurement became React state the room would commit 120 times a minute
 * to redraw a dot that says "In sync", against a budget of 60 (§5.4).
 *
 * So `driftSec` is published with hysteresis (see DRIFT_PUBLISH_EPSILON_SEC in
 * controller.ts) and the live playhead — which changes at frame rate — is not in
 * here at all. It goes through `usePlayheadRef()`, a ref the scrubber reads
 * inside its own rAF loop.
 */
import type { PlayerErrorInfo } from '@syncstudy/shared';

/**
 * The only part of the clock the drift loop needs (§8.3).
 *
 * `ServerClock` satisfies this structurally — this is a widening, not a second
 * implementation. It exists so the loop can be run headless by the sync
 * simulator (§15.3), which has no browser and no socket for a real `ServerClock`
 * to ride on, and so a test can inject a skewed clock without faking a network.
 */
export interface SyncClock {
  now(): number;
  readonly isReady: boolean;
  sync(count?: number, spacingMs?: number): Promise<void>;
}

/**
 * Coarse enough to render as one word, and ordered by how much the user should
 * care: `in_sync` is the boring steady state and must be ignorable (§12.4).
 */
export type DriftState = 'idle' | 'in_sync' | 'correcting' | 'resyncing' | 'stalled';

export interface SyncStatus {
  drift: DriftState;
  /** Signed seconds; + means this client is AHEAD of the room. */
  driftSec: number;
  /** Flips to 'poor' after repeated failed corrections (§8.6 step 5). */
  quality: 'good' | 'poor';
  hardSeeksLastMinute: number;
  /** True while the user has asked auto-sync to stand down. */
  autoSyncPaused: boolean;
  /** True while THIS client is buffering and the room is playing. */
  buffering: boolean;
  /** Set when the player refuses the video (YouTube 101/150 etc). */
  error: PlayerErrorInfo | null;
  /** True when playback needs a user gesture before it can start (§8.7). */
  needsGesture: boolean;
  /** True when we are muted only because autoplay required it. */
  mutedForAutoplay: boolean;
}

/** Before a player exists there is nothing to be in sync with. */
export const IDLE_SYNC_STATUS: SyncStatus = {
  drift: 'idle',
  driftSec: 0,
  quality: 'good',
  hardSeeksLastMinute: 0,
  autoSyncPaused: false,
  buffering: false,
  error: null,
  needsGesture: false,
  mutedForAutoplay: false,
};

/**
 * Field-by-field, because the controller rebuilds the object every tick and a
 * reference check would therefore always say "changed". The error is compared by
 * code rather than identity for the same reason: a player that re-reports the
 * same failure must not re-render the room.
 */
export function syncStatusEquals(a: SyncStatus, b: SyncStatus): boolean {
  return (
    a.drift === b.drift &&
    a.driftSec === b.driftSec &&
    a.quality === b.quality &&
    a.hardSeeksLastMinute === b.hardSeeksLastMinute &&
    a.autoSyncPaused === b.autoSyncPaused &&
    a.buffering === b.buffering &&
    a.needsGesture === b.needsGesture &&
    a.mutedForAutoplay === b.mutedForAutoplay &&
    (a.error === b.error || (a.error?.code === b.error?.code && a.error?.embedDenied === b.error?.embedDenied))
  );
}
