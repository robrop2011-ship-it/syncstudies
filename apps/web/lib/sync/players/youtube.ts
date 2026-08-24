'use client';

/**
 * The YouTube PlayerAdapter (PLAN.md §5.3, §8.6, §8.7).
 *
 * This file is where all seven YouTube quirks from §5.3 are absorbed, so that
 * `SyncController` can be written against a player that behaves like a player.
 * Every one of them is a real bug that will otherwise show up as "the video is
 * out of sync and nobody knows why". Each is commented at its handling site with
 * the reason it exists — please do not tidy those comments away.
 *
 * ── WHAT CALLERS NEED TO KNOW ────────────────────────────────────────────────
 *
 * 1. `play()` REJECTS when playback did not actually start. Browsers block
 *    unmuted autoplay without a user gesture, and YouTube's `playVideo()` fails
 *    silently when they do (quirk 3). Awaiting it and catching
 *    `AutoplayBlockedError` is how the join gate (§8.7) learns it needs to show
 *    "Tap to join with sound". A caller that fires and forgets should write
 *    `void player.play().catch(() => {})` and listen for the `error` event
 *    instead — an unhandled rejection here is a console warning, not a crash,
 *    but it is still noise.
 *
 * 2. `supportsFineRates()` is `false`, always. See quirk 4. This is the single
 *    most consequential line in the file: it is what makes the drift loop choose
 *    micro-seeks over rate nudging.
 *
 * 3. `getPositionPrecise()` returns the measurement's age, not just a number.
 *    YouTube's clock ticks at ~4 Hz (quirk 1), so a raw reading is on average
 *    ~125 ms stale and biased low. A caller that wants a de-quantised estimate
 *    while the video is playing should compute:
 *
 *        const s = player.getPositionPrecise();
 *        const estimate = s.position + ((performance.now() - s.measuredAtMs) / 1000) * player.getRate();
 *
 *    and should NOT do that while paused or buffering, where the position is
 *    genuinely not advancing.
 */
import {
  POST_SEEK_BLIND_MS,
  isValidYouTubeId,
  type PlayerAdapter,
  type PlayerErrorInfo,
  type PlayerState,
  type PositionSample,
} from '@syncstudy/shared';
import { PlayerEmitter } from './emitter';
import {
  loadYouTubeIframeApi,
  type YouTubeApi,
  type YouTubePlayer,
  type YouTubePlayerVars,
} from './yt-iframe-api';

// ── local constants ─────────────────────────────────────────────────────────
//
// The shared tuning numbers live in @syncstudy/shared/constants. The ones below
// describe this adapter's own mechanics rather than the sync algorithm, so they
// are named here instead — but they are still named, never inlined.

/**
 * The privacy-enhanced player host (§11.9). Same player, no tracking cookie
 * until playback actually starts.
 */
const NOCOOKIE_HOST = 'https://www.youtube-nocookie.com';

/**
 * QUIRK 1. `getCurrentTime()` advances in ~250 ms steps, not per frame. Polling
 * faster than it changes is what lets us timestamp the EDGE — the instant the
 * value flipped — which is the only way to know how old a reading is. 60 ms pins
 * that edge to within 60 ms instead of 250 ms, and the call is a synchronous
 * read of a locally cached number, so the cost is negligible even on a
 * Chromebook (§5.4).
 */
const POSITION_POLL_MS = 60;

/**
 * How long to wait for the player to acknowledge `playVideo()` before calling it
 * blocked (quirk 3). An accepted play transitions to BUFFERING almost
 * immediately; a blocked one never leaves UNSTARTED/CUED. 1.5 s is far longer
 * than the accept path needs and short enough that the join gate appears while
 * the user is still looking at the player.
 */
const PLAY_CONFIRM_TIMEOUT_MS = 1_500;

/**
 * The iframe has to report ready or the room has no player. Rejecting is much
 * better than a region that spins forever, so this is a real deadline.
 */
const PLAYER_READY_TIMEOUT_MS = 20_000;

/** YouTube's `getVolume()` is 0–100; `PlayerAdapter` is 0–1. */
const VOLUME_SCALE = 100;

/**
 * Synthetic error codes, negative so they can never collide with YouTube's own
 * (2, 5, 100, 101, 150). They ride the `error` event so a controller that does
 * not await `play()` still finds out that playback did not really begin.
 */
import { PLAYER_ERROR_AUTOPLAY_BLOCKED, PLAYER_ERROR_AUTOPLAY_MUTED } from '@syncstudy/shared';

// Re-exported so existing importers of this module keep working; the definitions
// live in the PlayerAdapter contract (packages/shared/src/player.ts).
export { PLAYER_ERROR_AUTOPLAY_BLOCKED, PLAYER_ERROR_AUTOPLAY_MUTED };

/** Thrown by `play()` / `load(..., autoplay: true)` when the browser said no. */
export class AutoplayBlockedError extends Error {
  readonly info: PlayerErrorInfo;

  constructor(info: PlayerErrorInfo) {
    super(info.message);
    this.name = 'AutoplayBlockedError';
    this.info = info;
  }
}

/** Thrown when the player errors out before it was ever usable (e.g. quirk 5). */
export class PlayerLoadError extends Error {
  readonly info: PlayerErrorInfo;

  constructor(info: PlayerErrorInfo) {
    super(info.message);
    this.name = 'PlayerLoadError';
    this.info = info;
  }
}

// ── mapping ─────────────────────────────────────────────────────────────────

/**
 * QUIRK 6, part one. These are reported exactly as YouTube reports them.
 *
 * Ads inject unpredictable BUFFERING and UNSTARTED windows for non-Premium
 * users, and a five-to-thirty-second stall for one participant is the single
 * ugliest thing that happens in a real session. The temptation is to smooth it
 * here — to keep returning `playing` through a short buffer so the UI stays
 * calm. Do not. §8.10 and §5.3(6) both need to SEE the stall: a buffering window
 * longer than three seconds is what marks a client `stalled`, suppresses its
 * drift corrections, and earns it one hard seek when it comes back. Hiding the
 * state here turns that into an unexplained multi-second drift instead.
 */
const STATE_BY_CODE: Readonly<Record<number, PlayerState>> = {
  [-1]: 'unstarted',
  0: 'ended',
  1: 'playing',
  2: 'paused',
  3: 'buffering',
  5: 'cued',
};

/**
 * QUIRK 5. Embed-disabled videos surface as `onError` 101 or 150 — never as a
 * failed load — so this mapping is the only place a student can be told what
 * actually happened. The messages say what to do next, because "error 150" does
 * not.
 */
export function describeYouTubeError(code: number): PlayerErrorInfo {
  switch (code) {
    case 101:
    case 150:
      return {
        code,
        embedDenied: true,
        message:
          "This video's owner doesn't allow it to play outside YouTube. Try a different link — most lecture uploads are fine.",
      };
    case 100:
      return {
        code,
        embedDenied: false,
        message: 'That video is private, removed, or not available in this country. Try a different link.',
      };
    case 2:
      return {
        code,
        embedDenied: false,
        message: "That doesn't look like a valid YouTube video link.",
      };
    case 5:
      return {
        code,
        embedDenied: false,
        message: "YouTube's player couldn't start in this browser. Reloading the page usually fixes it.",
      };
    default:
      return {
        code,
        embedDenied: false,
        message: 'YouTube reported a problem with this video. Try a different link.',
      };
  }
}

// ── the adapter ─────────────────────────────────────────────────────────────

class YouTubePlayerAdapter extends PlayerEmitter implements PlayerAdapter {
  private readonly player: YouTubePlayer;
  private iframe: HTMLIFrameElement | null = null;
  private destroyed = false;

  /**
   * QUIRK 2. `getCurrentTime()` keeps returning the PRE-seek value for 100–400 ms
   * after `seekTo()`. A drift loop that samples in that window measures the
   * position it just left, concludes it is wildly out of sync, and seeks again —
   * the stutter loop that §8.6 spends `MIN_HARD_SEEK_GAP_MS` guarding against. So
   * every local seek blinds measurement for `POST_SEEK_BLIND_MS`, and
   * `isReadyForMeasurement()` is the flag the controller checks.
   */
  private suppressUntilMs = 0;

  /** Last raw reading, and when it first appeared. See `samplePosition`. */
  private lastRawPosition = Number.NaN;
  private lastEdgeMs = 0;

  private poll: ReturnType<typeof setInterval> | null = null;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  /** Settlers for promises that are still waiting, so `destroy()` can end them. */
  private readonly pendingAborts = new Set<() => void>();

  constructor(player: YouTubePlayer) {
    super();
    this.player = player;

    try {
      const frame = player.getIframe();
      frame.style.width = '100%';
      frame.style.height = '100%';
      frame.style.display = 'block';
      frame.style.border = '0';
      this.iframe = frame;
    } catch {
      // Non-fatal: the player works, it just did not hand us the element.
    }

    this.poll = setInterval(() => {
      this.samplePosition();
    }, POSITION_POLL_MS);

    this.emit('ready', undefined);
  }

  // ── raw reads, guarded ────────────────────────────────────────────────────

  /**
   * Every YouTube call throws after `destroy()`, and several can throw while the
   * iframe is being torn down by a navigation. One helper, one `try`.
   */
  private read<T>(fn: (player: YouTubePlayer) => T, fallback: T): T {
    if (this.destroyed) return fallback;
    try {
      const value = fn(this.player);
      return value === undefined || value === null ? fallback : value;
    } catch {
      return fallback;
    }
  }

  private command(fn: (player: YouTubePlayer) => void): void {
    if (this.destroyed) return;
    try {
      fn(this.player);
    } catch (error) {
      console.error('[player] YouTube rejected a command', error);
    }
  }

  /**
   * QUIRK 1, the measurement side.
   *
   * The reading itself is only accurate to YouTube's ~250 ms step. What IS
   * accurate is the moment the value changed, so we record that instead: when
   * the number differs from the last one we saw, the video's clock just ticked
   * and `performance.now()` is the timestamp of that tick. `getPositionPrecise`
   * hands both to the caller so it can decide how much to trust the sample.
   */
  private samplePosition(): void {
    const raw = this.read((p) => p.getCurrentTime(), Number.NaN);
    if (!Number.isFinite(raw)) return;
    if (raw === this.lastRawPosition) return;
    this.lastRawPosition = raw;
    this.lastEdgeMs = performance.now();
  }

  private markLocalSeek(): void {
    this.suppressUntilMs = performance.now() + POST_SEEK_BLIND_MS;
    // The next reading is a fresh edge by definition. NaN never equals itself,
    // so the first post-seek sample always re-stamps `lastEdgeMs`.
    this.lastRawPosition = Number.NaN;
    this.lastEdgeMs = performance.now();
  }

  private track(timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
    this.timers.add(timer);
    return timer;
  }

  private untrack(timer: ReturnType<typeof setTimeout>): void {
    clearTimeout(timer);
    this.timers.delete(timer);
  }

  // ── events, forwarded from the raw player ─────────────────────────────────

  handleStateChange(code: number): void {
    const state = STATE_BY_CODE[code];
    if (state === undefined) return;
    // Sample immediately: a transition is the one moment we know the position is
    // about to be meaningful.
    this.samplePosition();
    this.emit('statechange', state);
  }

  handleError(code: number): void {
    this.emit('error', describeYouTubeError(code));
  }

  handleRateChange(rate: number): void {
    if (!Number.isFinite(rate)) return;
    this.emit('ratechange', rate);
  }

  // ── PlayerAdapter ─────────────────────────────────────────────────────────

  async load(videoRef: string, startAtSec: number, autoplay: boolean): Promise<void> {
    // Never build a player target from unvalidated input (§11.6). The id has
    // already come through `parseYouTubeUrl` upstream; this is the second gate.
    if (!isValidYouTubeId(videoRef)) {
      throw new PlayerLoadError(describeYouTubeError(2));
    }

    const startSeconds = Math.max(0, Number.isFinite(startAtSec) ? startAtSec : 0);
    this.markLocalSeek();

    // `loadVideoById` starts playing; `cueVideoById` does not. Using cue for the
    // non-autoplay path is what makes a late joiner land on a still frame at the
    // room's position rather than silently starting to play out of turn (§8.7).
    this.command((p) => {
      if (autoplay) p.loadVideoById({ videoId: videoRef, startSeconds });
      else p.cueVideoById({ videoId: videoRef, startSeconds });
    });

    if (autoplay) await this.confirmPlaybackStarted(this.isMuted());
  }

  async play(): Promise<void> {
    const wasMuted = this.isMuted();
    this.command((p) => {
      p.playVideo();
    });
    await this.confirmPlaybackStarted(wasMuted);
  }

  pause(): Promise<void> {
    this.command((p) => {
      p.pauseVideo();
    });
    // Pausing is never blocked and never lies, so there is nothing to confirm.
    return Promise.resolve();
  }

  seek(sec: number, allowSeekAhead?: boolean): Promise<void> {
    const target = Math.max(0, Number.isFinite(sec) ? sec : 0);
    // Quirk 2: blind the measurement window BEFORE issuing the seek, so a drift
    // tick that lands in the same millisecond is already suppressed.
    this.markLocalSeek();
    this.command((p) => {
      p.seekTo(target, allowSeekAhead ?? true);
    });
    // Resolves on issue, not on arrival. The controller measures the real
    // settle time itself (`estimatedSeekLatency()`, §8.6) and does not want a
    // promise that only resolves once the player agrees.
    return Promise.resolve();
  }

  getPosition(): number {
    this.samplePosition();
    return Number.isFinite(this.lastRawPosition) ? this.lastRawPosition : 0;
  }

  getPositionPrecise(): PositionSample {
    this.samplePosition();
    return {
      position: Number.isFinite(this.lastRawPosition) ? this.lastRawPosition : 0,
      measuredAtMs: this.lastEdgeMs,
    };
  }

  getDuration(): number {
    // 0 until metadata arrives, and 0 while an ad is playing. Reported as-is —
    // see quirk 6; a caller that needs a real duration should wait for a
    // non-zero one rather than have this method invent something.
    const duration = this.read((p) => p.getDuration(), 0);
    return Number.isFinite(duration) && duration > 0 ? duration : 0;
  }

  getState(): PlayerState {
    const code = this.read((p) => p.getPlayerState(), -1);
    return STATE_BY_CODE[code] ?? 'unstarted';
  }

  getBufferedFraction(): number {
    // During an ad this describes the AD's buffer, not the lecture's. That is
    // YouTube's behaviour and it is reported honestly (quirk 6); the scrubber
    // renders whatever it says.
    const fraction = this.read((p) => p.getVideoLoadedFraction(), 0);
    if (!Number.isFinite(fraction)) return 0;
    return Math.min(1, Math.max(0, fraction));
  }

  mute(): void {
    this.command((p) => {
      p.mute();
    });
  }

  unMute(): void {
    this.command((p) => {
      p.unMute();
    });
  }

  isMuted(): boolean {
    return this.read((p) => p.isMuted(), false);
  }

  setVolume(zeroToOne: number): void {
    const clamped = Math.min(1, Math.max(0, Number.isFinite(zeroToOne) ? zeroToOne : 0));
    this.command((p) => {
      p.setVolume(clamped * VOLUME_SCALE);
    });
  }

  getVolume(): number {
    const volume = this.read((p) => p.getVolume(), 0);
    if (!Number.isFinite(volume)) return 0;
    return Math.min(1, Math.max(0, volume / VOLUME_SCALE));
  }

  getAvailableRates(): number[] {
    const rates = this.read((p) => p.getAvailablePlaybackRates(), [] as number[]);
    return Array.isArray(rates) && rates.length > 0 ? [...rates] : [1];
  }

  setRate(rate: number): void {
    this.command((p) => {
      p.setPlaybackRate(rate);
    });
  }

  getRate(): number {
    const rate = this.read((p) => p.getPlaybackRate(), 1);
    return Number.isFinite(rate) && rate > 0 ? rate : 1;
  }

  /**
   * QUIRK 4 — THE MOST IMPORTANT LINE IN THIS FILE.
   *
   * `getAvailablePlaybackRates()` returns a COARSE list, in practice
   * [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]. There is no 1.05, and — this is
   * the part that actually bites — `setPlaybackRate()` SNAPS to the nearest
   * supported value rather than refusing. So the gentle correction from §8.6,
   * "run at 1.03× for two seconds to close a 60 ms gap", does one of two things
   * on YouTube: it silently snaps back to 1.0 and closes nothing, or it snaps to
   * 1.25 and overshoots by a factor of eight while the audio pitch-shifts
   * audibly. Both are worse than the drift.
   *
   * Returning false here is what routes the drift loop into the micro-seek
   * branch instead, which at sub-1.2 s corrections reads as a tiny hitch and is
   * the correct intervention for this player.
   *
   * This stays `false` even if a future YouTube ships a finer list, because the
   * snapping behaviour — not the list — is the problem. If you are here because
   * you want smooth rate correction, the answer is the HTML5 `<video>` adapter
   * (§5.3), not this line.
   */
  supportsFineRates(): boolean {
    return false;
  }

  isReadyForMeasurement(): boolean {
    if (this.destroyed) return false;
    // Note what is deliberately NOT here: buffering. §8.6 checks the buffering
    // state separately so it can report a slow client (§8.10); folding it in
    // would hide the stall the controller is supposed to notice.
    return performance.now() >= this.suppressUntilMs;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.poll !== null) {
      clearInterval(this.poll);
      this.poll = null;
    }
    // Settle anything still waiting BEFORE the timers go, or the awaiting caller
    // hangs for the lifetime of the page.
    for (const abort of Array.from(this.pendingAborts)) abort();
    this.pendingAborts.clear();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();

    try {
      this.player.destroy();
    } catch {
      // Already gone — a navigation tore the iframe out from under us.
    }
    // Remove only our own element. The caller may be rendering overlay UI in the
    // same container (§12.4's "tap to join with sound" bar lives there).
    this.iframe?.remove();
    this.iframe = null;

    this.clearListeners();
  }

  // ── quirk 3: did playback actually start? ─────────────────────────────────

  /**
   * QUIRK 3. `playVideo()` on a page with no user gesture either fails silently
   * or starts muted, and returns `undefined` either way. There is no callback
   * and no error — the only evidence is whether the player subsequently changes
   * state. So we watch for that, and report the truth.
   *
   * §8.7's join gate is the consumer: it tries muted autoplay first (permitted
   * everywhere), and falls back to a full-player "Join playback" button when
   * even that is refused. That gate is not this file's job; telling it the truth
   * is.
   */
  private confirmPlaybackStarted(wasMuted: boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const settle = (started: boolean): void => {
        if (!started) {
          const info: PlayerErrorInfo = {
            code: PLAYER_ERROR_AUTOPLAY_BLOCKED,
            embedDenied: false,
            message: 'Your browser blocked playback until you interact with the page. Tap the player to join.',
          };
          // Emitted as well as thrown: a controller that does not await play()
          // still needs to know, and the join gate listens on this channel.
          this.emit('error', info);
          reject(new AutoplayBlockedError(info));
          return;
        }

        // The other half of quirk 3: playback was allowed, but only because the
        // browser muted us on the way in. Playback IS happening, so this
        // resolves — but the UI still needs to offer the one-tap unmute, so the
        // fact is surfaced on the error channel rather than swallowed.
        if (!wasMuted && this.isMuted()) {
          this.emit('error', {
            code: PLAYER_ERROR_AUTOPLAY_MUTED,
            embedDenied: false,
            message: 'Playing without sound — your browser needs a tap before it will unmute.',
          });
        }
        resolve();
      };

      const state = this.getState();
      // `buffering` counts as started: the player accepted the command and is
      // fetching. A blocked play never leaves `unstarted`/`cued`/`paused`.
      if (state === 'playing' || state === 'buffering') {
        settle(true);
        return;
      }

      let done = false;
      let off: (() => void) | null = null;
      let abort: (() => void) | null = null;

      const finish = (): void => {
        done = true;
        this.untrack(timer);
        off?.();
        if (abort !== null) this.pendingAborts.delete(abort);
      };

      const timer = this.track(
        setTimeout(() => {
          if (done) return;
          finish();
          settle(false);
        }, PLAY_CONFIRM_TIMEOUT_MS),
      );

      off = this.on('statechange', (next) => {
        if (done) return;
        if (next !== 'playing' && next !== 'buffering') return;
        finish();
        settle(true);
      });

      // A room unmounting mid-join must not leave the join gate awaiting a
      // promise that can never settle — `destroy()` clears the timeout above, so
      // without this the caller would hang rather than clean up.
      abort = (): void => {
        if (done) return;
        finish();
        reject(new Error('The player was torn down before playback started.'));
      };
      this.pendingAborts.add(abort);
    });
  }
}

// ── factory ─────────────────────────────────────────────────────────────────

export interface CreateYouTubePlayerOptions {
  /** The element the iframe is mounted into. Size it yourself (16:9 box). */
  container: HTMLElement;
  /** An 11-character id, already through `parseYouTubeUrl` (§11.6). */
  videoId: string;
  startAtSec: number;
  /** Fires just before the returned promise resolves. */
  onReady?: (() => void) | undefined;
}

/**
 * Build a player and resolve once the IFrame API reports it ready.
 *
 * Rejects with `PlayerLoadError` if the video errors before it was ever usable
 * (an embed-disabled link, quirk 5), or with a plain `Error` if the API script
 * never loads or the player never reports ready.
 */
export async function createYouTubePlayer(opts: CreateYouTubePlayerOptions): Promise<PlayerAdapter> {
  const { container, videoId, startAtSec, onReady } = opts;

  if (!isValidYouTubeId(videoId)) {
    throw new PlayerLoadError(describeYouTubeError(2));
  }

  const api: YouTubeApi = await loadYouTubeIframeApi();

  return await new Promise<PlayerAdapter>((resolve, reject) => {
    // The API REPLACES the element it is given with the iframe, so it gets a
    // throwaway child rather than the caller's container.
    const mount = document.createElement('div');
    mount.style.width = '100%';
    mount.style.height = '100%';
    container.appendChild(mount);

    let adapter: YouTubePlayerAdapter | null = null;
    let settled = false;

    // Armed before construction, so the deadline covers the iframe handshake as
    // well as the load. Declared here rather than after `new api.Player` so the
    // event callbacks below close over a variable that already exists.
    const readyTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        player.destroy();
      } catch {
        // The player may never have finished constructing.
      }
      reject(new Error("YouTube's player didn't finish loading. Check the connection and try again."));
    }, PLAYER_READY_TIMEOUT_MS);

    const playerVars: YouTubePlayerVars = {
      controls: 0,
      rel: 0,
      modestbranding: 1,
      playsinline: 1,
      disablekb: 1,
      enablejsapi: 1,
      origin: window.location.origin,
      start: Math.max(0, Math.floor(Number.isFinite(startAtSec) ? startAtSec : 0)),
    };

    const player = new api.Player(mount, {
      host: NOCOOKIE_HOST,
      videoId,
      width: '100%',
      height: '100%',
      playerVars,
      events: {
        onReady: () => {
          if (settled) return;
          settled = true;
          clearTimeout(readyTimer);
          const built = new YouTubePlayerAdapter(player);
          adapter = built;

          /**
           * QUIRK 7, and it is a licensing matter rather than a taste one.
           *
           * `controls: 0` is explicitly permitted by the IFrame API and is what
           * lets §12.4 draw our own scrubber with note and question ticks. What
           * is NOT permitted, under YouTube's embed terms, is hiding or
           * obscuring the player's own branding: the logo, the title link into
           * youtube.com, and the channel attribution must stay visible and
           * clickable, and ads must not be blocked, skipped, or covered.
           *
           * So: no overlay is placed on the iframe here, nothing is reached into
           * via CSS, and no attempt is made to detect or suppress an ad. The one
           * overlay the product does draw — the "tap to join with sound" bar
           * (§8.7) — sits over the bottom edge only, is dismissed on first tap,
           * and never covers the branding.
           *
           * If you are here to "clean up" the YouTube logo, or to add
           * `pointer-events: none` over the frame, or to auto-skip an ad: that
           * change is what gets the embed key revoked. Leave it alone.
           */
          onReady?.();
          resolve(built);
        },
        onStateChange: (event) => {
          adapter?.handleStateChange(event.data);
        },
        onError: (event) => {
          const info = describeYouTubeError(event.data);
          if (adapter !== null) {
            adapter.handleError(event.data);
            return;
          }
          // Errored before it was ever usable — the caller never got a player,
          // so a rejected promise is the only channel available.
          if (settled) return;
          settled = true;
          clearTimeout(readyTimer);
          try {
            player.destroy();
          } catch {
            // nothing to clean up
          }
          reject(new PlayerLoadError(info));
        },
        onPlaybackRateChange: (event) => {
          adapter?.handleRateChange(event.data);
        },
      },
    });
  });
}
