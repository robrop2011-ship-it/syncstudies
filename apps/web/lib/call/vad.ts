'use client';

/**
 * Local voice-activity detection (PLAN.md §14 Phase 6.7).
 *
 * RMS over an `AnalyserNode`, with **hysteresis**: on above −45 dB sustained for
 * 100 ms, off after 400 ms below it. The hysteresis is the whole feature — a
 * bare threshold makes the speaking ring strobe on every syllable gap, which
 * both looks broken and, because `presence:update` rides on it, would spend the
 * event budget on flicker.
 *
 * Detection is entirely local. The alternative — deriving "who is speaking" from
 * the received audio — needs an analyser per peer and gets the answer later.
 */
const ON_THRESHOLD_DB = -45;
const ON_SUSTAIN_MS = 100;
const OFF_HANG_MS = 400;
/** 4 Hz matches the server's SPEAKING_LIMIT; sampling faster only burns CPU. */
const SAMPLE_INTERVAL_MS = 100;

export interface VadHandle {
  stop(): void;
}

function rmsDb(buffer: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const sample = buffer[i] ?? 0;
    sum += sample * sample;
  }
  const rms = Math.sqrt(sum / Math.max(1, buffer.length));
  // -100 dB is silence for our purposes and avoids log(0).
  return rms < 1e-5 ? -100 : 20 * Math.log10(rms);
}

/**
 * Start watching `stream` and call `onChange` when the speaking verdict flips.
 * Never called with the same value twice in a row.
 */
export function startVad(stream: MediaStream, onChange: (speaking: boolean) => void): VadHandle {
  const AudioCtor =
    typeof window === 'undefined'
      ? undefined
      : (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);

  if (AudioCtor === undefined || stream.getAudioTracks().length === 0) {
    return { stop: () => undefined };
  }

  const context = new AudioCtor();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.2;
  source.connect(analyser);

  const buffer = new Float32Array(analyser.fftSize);
  let speaking = false;
  let aboveSince: number | null = null;
  let belowSince: number | null = null;
  let stopped = false;

  const timer = setInterval(() => {
    if (stopped) return;
    // A muted track produces silence, which the threshold below already
    // handles — but reading it explicitly means an intentionally muted mic can
    // never light the speaking ring on a loud room.
    const track = stream.getAudioTracks()[0];
    const live = track !== undefined && track.enabled && track.readyState === 'live';

    analyser.getFloatTimeDomainData(buffer);
    const loud = live && rmsDb(buffer) > ON_THRESHOLD_DB;
    const now = performance.now();

    if (loud) {
      belowSince = null;
      aboveSince ??= now;
      if (!speaking && now - aboveSince >= ON_SUSTAIN_MS) {
        speaking = true;
        onChange(true);
      }
      return;
    }

    aboveSince = null;
    belowSince ??= now;
    if (speaking && now - belowSince >= OFF_HANG_MS) {
      speaking = false;
      onChange(false);
    }
  }, SAMPLE_INTERVAL_MS);

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      try {
        source.disconnect();
      } catch {
        // The graph may already be torn down; nothing to do.
      }
      void context.close().catch(() => undefined);
      if (speaking) onChange(false);
    },
  };
}
