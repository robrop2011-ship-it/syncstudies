/**
 * The PlayerAdapter seam (PLAN.md §5.3).
 *
 * The sync engine must never import anything YouTube-specific. Ship
 * YouTubePlayerAdapter now; an HTML5 <video> adapter is then a new file rather
 * than a refactor, which is also the escape hatch for risk R1.
 */

export type PlayerState = 'unstarted' | 'ended' | 'playing' | 'paused' | 'buffering' | 'cued';

export type PlayerEvent = 'statechange' | 'ready' | 'error' | 'ratechange';

/**
 * Synthetic error codes an adapter may emit on the `error` channel to report that
 * playback was REFUSED rather than that the video is broken.
 *
 * Negative so they can never collide with YouTube's own (2, 5, 100, 101, 150).
 * They live here, in the contract, rather than in the YouTube adapter, because
 * the sync controller has to distinguish them from real video failures and must
 * not import a browser-only module to do it.
 */
export const PLAYER_ERROR_AUTOPLAY_BLOCKED = -1;
export const PLAYER_ERROR_AUTOPLAY_MUTED = -2;

/** True for the codes above: a gate signal, not a broken video. */
export function isAutoplayGateCode(code: number): boolean {
  return code === PLAYER_ERROR_AUTOPLAY_BLOCKED || code === PLAYER_ERROR_AUTOPLAY_MUTED;
}

export interface PlayerErrorInfo {
  code: number;
  /** True for YouTube 101/150 — the video forbids embedded playback. */
  embedDenied: boolean;
  message: string;
}

export interface PositionSample {
  position: number;
  /** performance.now()-based, for measuring how stale the sample is. */
  measuredAtMs: number;
}

export interface PlayerAdapter {
  load(videoRef: string, startAtSec: number, autoplay: boolean): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(sec: number, allowSeekAhead?: boolean): Promise<void>;

  getPosition(): number;
  getPositionPrecise(): PositionSample;
  getDuration(): number;
  getState(): PlayerState;
  getBufferedFraction(): number;

  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  setVolume(zeroToOne: number): void;
  getVolume(): number;

  getAvailableRates(): number[];
  setRate(rate: number): void;
  getRate(): number;
  /**
   * True only when the player exposes continuous playback rates, which is what
   * makes the gentle "nudge the rate" drift correction possible.
   * YouTube returns a coarse list (…0.75, 1, 1.25…) and so returns false here —
   * the sync controller micro-seeks instead (PLAN.md §8.6).
   */
  supportsFineRates(): boolean;

  /** False while the iframe is still initialising, or right after a seek. */
  isReadyForMeasurement(): boolean;

  on(event: 'statechange', cb: (state: PlayerState) => void): () => void;
  on(event: 'ready', cb: () => void): () => void;
  on(event: 'error', cb: (err: PlayerErrorInfo) => void): () => void;
  on(event: 'ratechange', cb: (rate: number) => void): () => void;

  destroy(): void;
}
