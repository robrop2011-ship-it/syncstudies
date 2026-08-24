/**
 * The PlayerAdapter seam (PLAN.md §5.3).
 *
 * The sync engine must never import anything YouTube-specific. Ship
 * YouTubePlayerAdapter now; an HTML5 <video> adapter is then a new file rather
 * than a refactor, which is also the escape hatch for risk R1.
 */

export type PlayerState = 'unstarted' | 'ended' | 'playing' | 'paused' | 'buffering' | 'cued';

export type PlayerEvent = 'statechange' | 'ready' | 'error' | 'ratechange';

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
