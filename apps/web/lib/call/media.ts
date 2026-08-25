'use client';

/**
 * Device acquisition (PLAN.md §14 Phase 6.4).
 *
 * "Permission denied" and "no microphone" are not edge cases in a browser
 * product used on school hardware — they are a routine Tuesday. Every failure
 * mode below therefore gets a specific, actionable sentence rather than a
 * `NotAllowedError` bubbling into a toast, and the caller gets a machine-
 * readable reason so the UI can offer the right next step.
 */
import { AUDIO_MAX_BITRATE } from '@syncstudy/shared';
import type { JoinFailure } from './types';

export interface MediaFailure {
  reason: JoinFailure;
  message: string;
}

export class MediaError extends Error {
  readonly reason: JoinFailure;
  constructor(failure: MediaFailure) {
    super(failure.message);
    this.name = 'MediaError';
    this.reason = failure.reason;
  }
}

/**
 * `getUserMedia` is only exposed on a secure origin. `localhost` counts, which
 * is why dev works and the first `http://192.168.x.x` test does not — and that
 * is a confusing enough failure to deserve its own sentence.
 */
export function mediaSupport(): MediaFailure | null {
  if (typeof navigator === 'undefined') {
    return { reason: 'unsupported', message: 'Voice calling needs a browser.' };
  }
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    return {
      reason: 'insecure_context',
      message: 'Your browser only allows microphone access over HTTPS. Open SyncStudy on its https:// address.',
    };
  }
  if (navigator.mediaDevices?.getUserMedia === undefined || typeof RTCPeerConnection === 'undefined') {
    return {
      reason: 'unsupported',
      message: 'This browser does not support voice calls. Chrome, Firefox, Edge and Safari all do.',
    };
  }
  return null;
}

function classify(err: unknown): MediaFailure {
  const name = err instanceof Error ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return {
        reason: 'permission_denied',
        message:
          'Your browser blocked microphone access. Click the padlock in the address bar, allow the microphone, then try again.',
      };
    case 'NotFoundError':
    case 'OverconstrainedError':
      return {
        reason: 'no_device',
        message: 'No microphone found. Plug one in — or headphones with a mic — and try again.',
      };
    case 'NotReadableError':
    case 'AbortError':
      return {
        reason: 'device_busy',
        message: 'Another app is using your microphone. Close it (Zoom and Teams are the usual ones) and try again.',
      };
    default:
      return {
        reason: 'transport_error',
        message: 'Could not start your microphone. Try again in a moment.',
      };
  }
}

/**
 * Mic constraints. The three processing flags are on because a study room is
 * usually a bedroom with a laptop fan in it, and `channelCount: 1` halves the
 * payload before the encoder ever runs (§9.4).
 */
const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
};

/** 640×360@24 is the §9.1 mesh ceiling, not a preference. */
const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 640, max: 1280 },
  height: { ideal: 360, max: 720 },
  frameRate: { ideal: 24, max: 30 },
};

export async function getMicrophone(deviceId?: string): Promise<MediaStream> {
  const unsupported = mediaSupport();
  if (unsupported) throw new MediaError(unsupported);
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: deviceId === undefined ? AUDIO_CONSTRAINTS : { ...AUDIO_CONSTRAINTS, deviceId },
      video: false,
    });
  } catch (err) {
    throw new MediaError(classify(err));
  }
}

export async function getCamera(deviceId?: string): Promise<MediaStream> {
  const unsupported = mediaSupport();
  if (unsupported) throw new MediaError(unsupported);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: deviceId === undefined ? VIDEO_CONSTRAINTS : { ...VIDEO_CONSTRAINTS, deviceId },
    });
    for (const track of stream.getVideoTracks()) track.contentHint = 'motion';
    return stream;
  } catch (err) {
    const failure = classify(err);
    // The copy above is written for the microphone; a camera failure needs its
    // own noun or the instruction is wrong.
    throw new MediaError({
      reason: failure.reason,
      message: failure.message.replace(/microphone/g, 'camera').replace(/a mic\b/g, 'a camera'),
    });
  }
}

/**
 * Screen share (§9.6). 5 fps is deliberate: slides and code do not move, and it
 * cuts bandwidth roughly fivefold against 24 fps. `contentHint: 'detail'` tells
 * the encoder to spend its budget on resolution instead of frame rate, which is
 * the correct trade for text.
 */
export async function getScreen(): Promise<MediaStream> {
  const unsupported = mediaSupport();
  if (unsupported) throw new MediaError(unsupported);
  if (navigator.mediaDevices.getDisplayMedia === undefined) {
    throw new MediaError({
      reason: 'unsupported',
      message: 'This browser cannot share a screen. Chrome, Edge and Firefox on a computer can.',
    });
  }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 5, width: { max: 1920 } },
      audio: true,
    });
    for (const track of stream.getVideoTracks()) track.contentHint = 'detail';
    return stream;
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'NotAllowedError') {
      // Cancelling the picker is not an error worth a red box.
      throw new MediaError({ reason: 'permission_denied', message: 'Screen sharing was cancelled.' });
    }
    throw new MediaError({ reason: 'transport_error', message: 'Could not start screen sharing.' });
  }
}

/** Enumerate inputs. Labels are empty until permission has been granted once. */
export async function listAudioInputs(): Promise<MediaDeviceInfo[]> {
  if (navigator.mediaDevices?.enumerateDevices === undefined) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'audioinput');
}

export const OPUS_TARGET_BITRATE = AUDIO_MAX_BITRATE;
