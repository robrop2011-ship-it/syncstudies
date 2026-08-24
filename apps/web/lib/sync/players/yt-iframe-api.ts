'use client';

/**
 * The YouTube IFrame Player API: minimal types, and the one-per-page loader.
 *
 * We hand-write the types rather than depending on `@types/youtube` because the
 * surface we touch is about twenty members wide, and a hand-written surface is
 * one that cannot silently grow. Everything the adapter calls appears below; if
 * a method is not here, the adapter is not allowed to call it.
 *
 * ── THE LOADER IS A MODULE-LEVEL SINGLETON, AND THAT IS NOT AN OPTIMISATION ──
 * The API signals readiness by calling ONE global function,
 * `window.onYouTubeIframeAPIReady`. Injecting a second `<script>` tag means the
 * second injection overwrites (or races) that global, and whichever component
 * lost the race waits forever for a callback that will never come. React 18/19
 * strict mode mounts effects twice in development, so "it only happens once in
 * practice" is not true even on a page with a single player. Hence: one promise,
 * memoised at module scope, shared by every caller.
 */

export interface YouTubePlayerVars {
  /** 0 hides YouTube's own control bar. Permitted; §12.4 draws our own scrubber. */
  controls: 0 | 1;
  /** 0 asks for related videos from the same channel only. */
  rel: 0 | 1;
  modestbranding: 0 | 1;
  /** Required or iOS Safari takes the video fullscreen the moment it plays. */
  playsinline: 0 | 1;
  /** Our own shortcuts own the keyboard (§12.5), not the iframe's. */
  disablekb: 0 | 1;
  /** Without this the player refuses every API call. */
  enablejsapi: 0 | 1;
  /** Must equal the embedding page's origin or postMessage is rejected. */
  origin: string;
  start?: number;
}

export interface YouTubeLoadArgs {
  videoId: string;
  startSeconds?: number;
}

export interface YouTubePlayerEvent {
  target: YouTubePlayer;
}

export interface YouTubePlayerDataEvent extends YouTubePlayerEvent {
  data: number;
}

export interface YouTubePlayerOptions {
  /**
   * `https://www.youtube-nocookie.com`. The privacy-enhanced host serves the
   * same player and sets no tracking cookie until playback starts (§11.9).
   */
  host: string;
  videoId: string;
  width: string | number;
  height: string | number;
  playerVars: YouTubePlayerVars;
  events: {
    onReady?: (event: YouTubePlayerEvent) => void;
    onStateChange?: (event: YouTubePlayerDataEvent) => void;
    onError?: (event: YouTubePlayerDataEvent) => void;
    onPlaybackRateChange?: (event: YouTubePlayerDataEvent) => void;
  };
}

export interface YouTubePlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  loadVideoById(args: YouTubeLoadArgs): void;
  cueVideoById(args: YouTubeLoadArgs): void;

  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  getVideoLoadedFraction(): number;

  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  setVolume(volume: number): void;
  getVolume(): number;

  getAvailablePlaybackRates(): number[];
  setPlaybackRate(rate: number): void;
  getPlaybackRate(): number;

  getIframe(): HTMLIFrameElement;
  destroy(): void;
}

export interface YouTubeApi {
  Player: new (element: HTMLElement | string, options: YouTubePlayerOptions) => YouTubePlayer;
}

declare global {
  interface Window {
    YT?: YouTubeApi;
    onYouTubeIframeAPIReady?: (() => void) | undefined;
  }
}

/**
 * The loader script itself is only served from `www.youtube.com` — there is no
 * `youtube-nocookie` variant of it. The privacy-enhanced host is applied to the
 * PLAYER via `options.host`, which is where the cookies would otherwise be set.
 * Both origins are already in `script-src`/`frame-src` in next.config.ts.
 */
const IFRAME_API_SRC = 'https://www.youtube.com/iframe_api';

/** Marks our own tag so a re-entrant call finds it without re-injecting. */
const SCRIPT_MARKER = 'data-syncstudy-yt-api';

/**
 * Generous, because this covers a cold cache on a phone. It exists only so a
 * blocked or hung script surfaces as a rejected promise the room UI can render,
 * rather than a player region that spins until the user gives up.
 */
const API_LOAD_TIMEOUT_MS = 15_000;

let apiPromise: Promise<YouTubeApi> | null = null;

function existingApi(): YouTubeApi | null {
  if (typeof window === 'undefined') return null;
  const api = window.YT;
  return api !== undefined && typeof api.Player === 'function' ? api : null;
}

export function loadYouTubeIframeApi(): Promise<YouTubeApi> {
  const cached = apiPromise;
  if (cached !== null) return cached;

  const pending = new Promise<YouTubeApi>((resolve, reject) => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      reject(new Error('The YouTube IFrame API can only be loaded in a browser.'));
      return;
    }

    const already = existingApi();
    if (already !== null) {
      resolve(already);
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("YouTube's player script did not load. An extension or the network may be blocking it."));
    }, API_LOAD_TIMEOUT_MS);

    const finish = (): void => {
      if (settled) return;
      const api = existingApi();
      if (api === null) return;
      settled = true;
      clearTimeout(timer);
      resolve(api);
    };

    // Chain rather than replace. Another script on the page (an analytics embed,
    // a marketing widget) may have registered its own callback, and silently
    // dropping it would break code we do not own.
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = (): void => {
      if (previous !== undefined) {
        try {
          previous();
        } catch (error) {
          console.error('[player] a pre-existing onYouTubeIframeAPIReady threw', error);
        }
      }
      finish();
    };

    if (document.querySelector(`script[${SCRIPT_MARKER}]`) !== null) return;

    const script = document.createElement('script');
    script.src = IFRAME_API_SRC;
    script.async = true;
    script.setAttribute(SCRIPT_MARKER, '');
    script.addEventListener('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("YouTube's player script could not be fetched."));
    });
    document.head.appendChild(script);
  });

  apiPromise = pending;
  // A failed load must not be cached forever: the user may be on a flaky
  // connection and reload the room, and the second attempt deserves a real try.
  pending.catch(() => {
    if (apiPromise === pending) apiPromise = null;
  });

  return pending;
}

/** Test/teardown seam. Not used by the app. */
export function resetYouTubeIframeApiForTests(): void {
  apiPromise = null;
}
