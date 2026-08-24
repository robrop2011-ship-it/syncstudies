/**
 * The authoritative video timeline (PLAN.md §8.2, §8.4).
 *
 * The single most important rule in this codebase: the server stores an ANCHOR,
 * not a position. A playing video's position is a pure function of wall-clock
 * time, so `positionAt()` derives it on demand. There is exactly one
 * implementation of that function and both the client and the server import it
 * from here. Two implementations would drift apart, and finding out why costs a week.
 */

export type VideoProvider = 'youtube' | 'file' | 'none';
export type PlaybackStatus = 'idle' | 'playing' | 'paused' | 'ended';
export type PlaybackControlPolicy = 'everyone' | 'host_and_cohosts' | 'host_only';

export interface VideoAnchor {
  provider: VideoProvider;
  /** YouTube 11-char id, or a URL for `file`. */
  videoRef: string | null;
  title: string | null;
  durationSec: number | null;

  status: PlaybackStatus;
  /** Position within the video, in seconds, that was true AT `anchorServerMs`. */
  anchorPositionSec: number;
  /** Server epoch ms at which `anchorPositionSec` was true. */
  anchorServerMs: number;
  playbackRate: number;

  /** Monotonically increasing per room. Drives optimistic concurrency (§8.5b). */
  revision: number;
  lastActorId: string | null;
  /** Server epoch ms of the last accepted control. Drives the control lock (§8.5c). */
  lastChangeMs: number;
}

export const IDLE_ANCHOR: VideoAnchor = {
  provider: 'none',
  videoRef: null,
  title: null,
  durationSec: null,
  status: 'idle',
  anchorPositionSec: 0,
  anchorServerMs: 0,
  playbackRate: 1,
  revision: 0,
  lastActorId: null,
  lastChangeMs: 0,
};

/**
 * THE function. Turn an anchor into a position at a given server time.
 * Imported by both the client drift loop and the server's control handler.
 */
export function positionAt(a: VideoAnchor, serverNowMs: number): number {
  if (a.status !== 'playing') return clampToDuration(a.anchorPositionSec, a);
  const elapsedSec = (serverNowMs - a.anchorServerMs) / 1000;
  return clampToDuration(a.anchorPositionSec + elapsedSec * a.playbackRate, a);
}

export function clampToDuration(pos: number, a: Pick<VideoAnchor, 'durationSec'>): number {
  const lower = Math.max(0, pos);
  return a.durationSec != null ? Math.min(lower, a.durationSec) : lower;
}

// ── Control commands ────────────────────────────────────────────────────────

export type ControlAction = 'play' | 'pause' | 'seek' | 'rate';

export interface ControlCommand {
  action: ControlAction;
  /** Required for `seek`; ignored (and untrusted) for `play`/`pause`. */
  positionSec?: number | undefined;
  /** Required for `rate`. */
  rate?: number | undefined;
  /** Client's send time, already converted to SERVER time via ServerClock. */
  clientSentAtMs: number;
  /** The revision the client believed was current. -1 skips the check (resync only). */
  expectedRevision: number;
}

export interface SetVideoCommand {
  provider: VideoProvider;
  videoRef: string;
  title?: string | null | undefined;
  durationSec?: number | null | undefined;
}

/** How long a seek request is allowed to have spent in flight before we stop compensating. */
const MAX_IN_FLIGHT_COMPENSATION_SEC = 1.0;

/**
 * Compute the next anchor for a control command (PLAN.md §8.4).
 *
 * Note the deliberate asymmetry between actions — it is not an oversight:
 *
 *  - `pause` freezes at the SERVER-derived position. Using the client's reported
 *    position would rewind the room by roughly one one-way delay on every pause,
 *    and those rewinds accumulate over a 3-hour session.
 *  - `seek` trusts the client's target, because a seek is an intent about the
 *    *video*, not a measurement of *now* — but it adds the in-flight time when
 *    the room is playing, so the seek lands where the user meant it to.
 *  - `play` resumes from the ROOM's position, so a lagging participant pressing
 *    play cannot drag everybody backwards to wherever their player happened to be.
 */
export function applyControl(cur: VideoAnchor, cmd: ControlCommand, nowMs: number): VideoAnchor {
  const base = { ...cur, lastChangeMs: nowMs, revision: cur.revision + 1 };

  switch (cmd.action) {
    case 'play': {
      const from = cur.status === 'playing' ? positionAt(cur, nowMs) : cur.anchorPositionSec;
      return { ...base, status: 'playing', anchorPositionSec: from, anchorServerMs: nowMs };
    }
    case 'pause': {
      const at = positionAt(cur, nowMs);
      return { ...base, status: 'paused', anchorPositionSec: at, anchorServerMs: nowMs };
    }
    case 'seek': {
      const requested = cmd.positionSec ?? positionAt(cur, nowMs);
      const inFlightSec =
        cur.status === 'playing'
          ? Math.max(0, Math.min(MAX_IN_FLIGHT_COMPENSATION_SEC, (nowMs - cmd.clientSentAtMs) / 1000))
          : 0;
      const target = requested + inFlightSec * cur.playbackRate;
      return {
        ...base,
        anchorPositionSec: clampToDuration(target, cur),
        anchorServerMs: nowMs,
        // Seeking past the end ends the video rather than pinning at duration forever.
        status:
          cur.durationSec != null && target >= cur.durationSec && cur.status === 'playing'
            ? 'ended'
            : cur.status,
      };
    }
    case 'rate': {
      const rate = cmd.rate ?? 1;
      return {
        ...base,
        playbackRate: rate,
        anchorPositionSec: positionAt(cur, nowMs),
        anchorServerMs: nowMs,
      };
    }
  }
}

/** Setting a new video always resets to paused at zero. */
export function applySetVideo(cur: VideoAnchor, cmd: SetVideoCommand, nowMs: number): VideoAnchor {
  return {
    ...cur,
    provider: cmd.provider,
    videoRef: cmd.videoRef,
    title: cmd.title ?? null,
    durationSec: cmd.durationSec ?? null,
    status: 'paused',
    anchorPositionSec: 0,
    anchorServerMs: nowMs,
    playbackRate: 1,
    revision: cur.revision + 1,
    lastChangeMs: nowMs,
  };
}

/**
 * Freeze a live anchor for durable storage (PLAN.md §8.11).
 *
 * Always forces `paused`. A room that was playing when the last person left must
 * not "advance" while nobody is in it — otherwise reopening it three days later
 * lands at the end of the video.
 */
export function freezeAnchor(a: VideoAnchor, nowMs: number): VideoAnchor {
  return {
    ...a,
    status: a.status === 'playing' ? 'paused' : a.status,
    anchorPositionSec: positionAt(a, nowMs),
    anchorServerMs: nowMs,
  };
}

// ── Conflict resolution (PLAN.md §8.5) ──────────────────────────────────────

export type ControlRejectReason =
  | 'stale_revision'
  | 'recently_changed'
  | 'not_permitted'
  | 'rate_limited'
  | 'no_video';

export interface ControlDecision {
  accepted: boolean;
  reason?: ControlRejectReason;
}

/**
 * The pure decision function behind the Lua transact script (PLAN.md §6.4).
 *
 * Kept here, framework-free, so the exact same logic is unit-testable and is what
 * the simulator exercises. The Lua script is a faithful transliteration of this;
 * if you change one, change both.
 */
export function decideControl(
  cur: VideoAnchor,
  cmd: Pick<ControlCommand, 'expectedRevision'>,
  actorId: string,
  nowMs: number,
  controlLockMs: number,
): ControlDecision {
  if (cmd.expectedRevision >= 0 && cmd.expectedRevision !== cur.revision) {
    return { accepted: false, reason: 'stale_revision' };
  }
  // Anti-seek-war: a different user just changed things; make them wait a beat.
  // The same actor is never locked out of their own follow-ups, so scrubbing works.
  if (
    cur.lastActorId !== null &&
    cur.lastActorId !== actorId &&
    nowMs - cur.lastChangeMs < controlLockMs
  ) {
    return { accepted: false, reason: 'recently_changed' };
  }
  return { accepted: true };
}

export function canControlVideo(
  role: 'host' | 'co_host' | 'member' | 'guest',
  policy: PlaybackControlPolicy,
): boolean {
  if (role === 'guest') return false;
  if (policy === 'everyone') return true;
  if (policy === 'host_and_cohosts') return role === 'host' || role === 'co_host';
  return role === 'host';
}

// ── YouTube helpers ─────────────────────────────────────────────────────────

export const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function isValidYouTubeId(id: string): boolean {
  return YOUTUBE_ID_RE.test(id);
}

/**
 * Parse any of the shapes a student will actually paste.
 * Returns the video id plus any `t=` start offset, or null.
 *
 * Never build an iframe `src` from raw user input — take the id from here and
 * interpolate only that (PLAN.md §11.6).
 */
export function parseYouTubeUrl(input: string): { videoId: string; startSec: number } | null {
  const raw = input.trim();
  if (!raw) return null;

  // A bare id pasted on its own.
  if (isValidYouTubeId(raw)) return { videoId: raw, startSec: 0 };

  let url: URL;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  const allowed = ['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'youtu.be'];
  if (!allowed.includes(host)) return null;

  let videoId: string | null = null;
  if (host === 'youtu.be') {
    videoId = url.pathname.slice(1).split('/')[0] ?? null;
  } else if (url.pathname === '/watch') {
    videoId = url.searchParams.get('v');
  } else {
    const m = url.pathname.match(/^\/(?:embed|v|shorts|live)\/([^/?#]+)/);
    videoId = m?.[1] ?? null;
  }

  if (!videoId || !isValidYouTubeId(videoId)) return null;
  return { videoId, startSec: parseTimeParam(url.searchParams.get('t') ?? url.searchParams.get('start')) };
}

/** YouTube's `t` accepts `90`, `90s`, `1m30s`, `1h2m3s`. */
export function parseTimeParam(t: string | null): number {
  if (!t) return 0;
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
  if (!m) return 0;
  const [, h, min, s] = m;
  return (parseInt(h ?? '0', 10) * 3600) + (parseInt(min ?? '0', 10) * 60) + parseInt(s ?? '0', 10);
}

/** `41:12` / `1:02:03`. Used by the scrubber and by chat timestamp linkification. */
export function formatTimestamp(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** Inverse of formatTimestamp. Returns null for anything that isn't a timestamp. */
export function parseTimestamp(text: string): number | null {
  const m = text.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [, h, mm, ss] = m;
  const minutes = parseInt(mm ?? '0', 10);
  const seconds = parseInt(ss ?? '0', 10);
  if (seconds > 59) return null;
  // With an hours part present, minutes must also be a real minutes value.
  if (h !== undefined && minutes > 59) return null;
  return parseInt(h ?? '0', 10) * 3600 + minutes * 60 + seconds;
}
