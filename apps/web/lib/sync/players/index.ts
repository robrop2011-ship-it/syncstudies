/**
 * The PlayerAdapter factory (PLAN.md §5.3).
 *
 * The sync engine must never import anything YouTube-specific. It asks this
 * module for a player and gets back a `PlayerAdapter`; adding the HTML5
 * `<video>` adapter later is a new file plus a new `case` here, not a refactor
 * of `SyncController`. That seam is also the escape hatch for risk R1 (YouTube
 * changing the embed terms).
 *
 * NOTE FOR THE SIMULATOR (§15.3): import `./fake` directly rather than going
 * through this barrel. `FakePlayer` is environment-free and runs in plain Node,
 * but this file pulls in `./youtube`, which is a `'use client'` module.
 */
import type { PlayerAdapter, VideoProvider } from '@syncstudy/shared';
import { createYouTubePlayer } from './youtube';

export { createYouTubePlayer, describeYouTubeError } from './youtube';
export {
  AutoplayBlockedError,
  PlayerLoadError,
  PLAYER_ERROR_AUTOPLAY_BLOCKED,
  PLAYER_ERROR_AUTOPLAY_MUTED,
} from './youtube';
export type { CreateYouTubePlayerOptions } from './youtube';
export { FakePlayer } from './fake';
export type { FakePlayerOptions } from './fake';
export { PlayerEmitter } from './emitter';
export type { PlayerEventPayloads } from './emitter';

export interface CreatePlayerOptions {
  provider: VideoProvider;
  container: HTMLElement;
  /** The 11-character YouTube id, or a URL for `file`. Already validated. */
  videoRef: string;
  startAtSec: number;
  onReady?: (() => void) | undefined;
}

/**
 * Thrown when the room's anchor names a provider this build cannot play. The
 * room UI renders the message; it is deliberately specific about what happened
 * rather than "something went wrong".
 */
export class UnsupportedProviderError extends Error {
  readonly provider: VideoProvider;

  constructor(provider: VideoProvider, message: string) {
    super(message);
    this.name = 'UnsupportedProviderError';
    this.provider = provider;
  }
}

export function createPlayer(opts: CreatePlayerOptions): Promise<PlayerAdapter> {
  switch (opts.provider) {
    case 'youtube':
      return createYouTubePlayer({
        container: opts.container,
        videoId: opts.videoRef,
        startAtSec: opts.startAtSec,
        onReady: opts.onReady,
      });
    case 'file':
      // §5.3 ships one adapter now and adds the HTML5 one later. Until that file
      // exists, say so plainly instead of returning a player that cannot play.
      return Promise.reject(
        new UnsupportedProviderError('file', 'Uploaded video files are not supported yet — use a YouTube link.'),
      );
    case 'none':
      return Promise.reject(new UnsupportedProviderError('none', 'This room has no video set.'));
  }
}
