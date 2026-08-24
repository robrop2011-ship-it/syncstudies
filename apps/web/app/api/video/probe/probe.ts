/**
 * The video probe, minus the HTTP plumbing (PLAN.md §5.3 quirk 5, §11.6, §11.7).
 *
 * A student pastes a YouTube link. Roughly one lecture upload in twenty forbids
 * embedded playback, and YouTube only tells you that at PLAY time, as `onError`
 * 101/150 — by which point the whole room has loaded a black rectangle and is
 * asking what broke. So the link is checked when it is pasted, server-side,
 * against YouTube's public oEmbed endpoint.
 *
 * ── THE SSRF RULE, AND IT IS NOT NEGOTIABLE ──────────────────────────────────
 * This route takes a URL from a user and then makes an outbound request. That is
 * the exact shape of a server-side request forgery, and the only thing standing
 * between it and our internal network is that WE NEVER FETCH WHAT THE USER SENT.
 *
 * The user's string goes through `parseYouTubeUrl` and comes out as an 11-char
 * id matching `[A-Za-z0-9_-]{11}` — no host, no path, no scheme, nothing that
 * can address anything. The request is then BUILT from that id against a
 * hardcoded `https://www.youtube.com` origin. `buildOembedUrl` re-validates the
 * id and throws rather than interpolate an unvalidated one, so a future caller
 * cannot reintroduce the hole by skipping the parse step.
 *
 * Redirects are not followed (`redirect: 'manual'` at the call site), the
 * request is capped at 5 s, and the response body is capped at 64 KB, because a
 * hardcoded host is still a host that can be made to hang or to stream forever.
 */
import { isValidYouTubeId, parseYouTubeUrl } from '@syncstudy/shared';

/** Hardcoded. Never derived from input. See the SSRF note above. */
export const OEMBED_ORIGIN = 'https://www.youtube.com';
export const OEMBED_PATH = '/oembed';

export const PROBE_TIMEOUT_MS = 5_000;
export const OEMBED_MAX_BYTES = 64 * 1024;

/** Longer than any real YouTube URL; anything past this is not a link. */
export const MAX_PROBE_URL_LENGTH = 2_048;

/** Matches the `title` cap on `Schemas.VideoSet`, so a probe result always fits. */
const MAX_TITLE_LENGTH = 300;

/**
 * Why the video cannot be used, when it cannot. `embeddable` alone cannot
 * distinguish "the owner disabled embedding" (try another link) from "YouTube
 * did not answer" (try again in a moment), and those need different copy.
 */
export type VideoProbeReason = 'ok' | 'embed_denied' | 'not_found' | 'unavailable';

export interface VideoProbeResult {
  /** True when this video can be loaded into the room. */
  ok: boolean;
  videoId: string;
  /** From oEmbed. Null when YouTube did not give us one. */
  title: string | null;
  /**
   * Absent in practice, and that is not an oversight: oEmbed does not carry a
   * duration, and the YouTube Data API needs a key and a quota this product does
   * not have. The real duration arrives from `player.getDuration()` once the
   * video loads, which is why `Schemas.VideoSet.durationSec` is optional. The
   * field stays in the shape so a provider that DOES report one has a home.
   */
  durationSec?: number;
  /** Specifically: does YouTube permit embedded playback of this video. */
  embeddable: boolean;
  reason: VideoProbeReason;
}

export interface ProbeInput {
  videoId: string;
  /**
   * The `t=` offset from the pasted link. Deliberately not returned to the
   * client: `applySetVideo` (§8.4) resets every new video to paused at zero, so
   * a start offset would be silently discarded a moment later. Parsed only
   * because `parseYouTubeUrl` returns it.
   */
  startSec: number;
}

/**
 * Validate the request body. Returns null for anything that is not a YouTube
 * link we recognise — including, importantly, `https://youtube.com.evil.test/…`
 * and `http://169.254.169.254/…`, both of which `parseYouTubeUrl` rejects on the
 * hostname allow-list.
 */
export function parseProbeInput(body: unknown): ProbeInput | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = (body as { url?: unknown }).url;
  if (typeof raw !== 'string') return null;
  if (raw.length === 0 || raw.length > MAX_PROBE_URL_LENGTH) return null;

  const parsed = parseYouTubeUrl(raw);
  if (parsed === null) return null;
  // Belt and braces: `parseYouTubeUrl` already guarantees this, and the next
  // function refuses to run without it.
  if (!isValidYouTubeId(parsed.videoId)) return null;

  return { videoId: parsed.videoId, startSec: parsed.startSec };
}

/**
 * Build the oEmbed request from a validated id and a hardcoded host.
 *
 * Throws rather than returns null: reaching here with an unvalidated id is a
 * programming error on the SSRF boundary, and a silent fallback would be exactly
 * the wrong shape of failure.
 */
export function buildOembedUrl(videoId: string): string {
  if (!isValidYouTubeId(videoId)) {
    throw new Error('refusing to build an oEmbed request from an unvalidated video id');
  }
  const target = new URL(OEMBED_PATH, OEMBED_ORIGIN);
  // The `url` parameter is itself assembled from the validated id — the user's
  // original string is never echoed into an outbound request.
  target.searchParams.set('url', `${OEMBED_ORIGIN}/watch?v=${videoId}`);
  target.searchParams.set('format', 'json');
  return target.toString();
}

/**
 * Read a response body, giving up if it is larger than `maxBytes`.
 *
 * `content-length` is checked first as a cheap early exit, but it is a claim
 * rather than a fact, so the stream is also counted as it arrives.
 */
export async function readCappedText(res: Response, maxBytes = OEMBED_MAX_BYTES): Promise<string | null> {
  const declared = Number.parseInt(res.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    // Release the socket. Every other abandonment path in this file cancels;
    // this one leaked a connection per oversized response until GC.
    void res.body?.cancel();
    return null;
  }

  const body = res.body;
  if (body === null) return null;

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/** Pull the title out of an oEmbed payload, tolerating anything that is not one. */
export function titleFromOembed(text: string): string | null {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;

  const title = (payload as { title?: unknown }).title;
  if (typeof title !== 'string') return null;

  const trimmed = title.trim().slice(0, MAX_TITLE_LENGTH);
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Turn an oEmbed status into a result.
 *
 * A non-200 means "not embeddable", never a 500 — YouTube answering "no" is a
 * normal outcome of asking, and surfacing it as a server error would put a red
 * box in front of a student whose only mistake was pasting a link with embedding
 * turned off.
 *
 * 401 is what YouTube returns for a video whose owner disabled embedding; 404 is
 * private, deleted, or never existed. Everything else is "we could not tell",
 * which reads the same to the user but is a different sentence.
 */
export function probeResultFor(videoId: string, status: number, title: string | null): VideoProbeResult {
  if (status === 200) {
    return { ok: true, videoId, title, embeddable: true, reason: 'ok' };
  }
  if (status === 401 || status === 403) {
    return { ok: false, videoId, title: null, embeddable: false, reason: 'embed_denied' };
  }
  if (status === 404 || status === 400) {
    return { ok: false, videoId, title: null, embeddable: false, reason: 'not_found' };
  }
  return { ok: false, videoId, title: null, embeddable: false, reason: 'unavailable' };
}

/** The message the paste field shows for each outcome (§12.5 — inline, not a toast). */
export function probeMessage(result: VideoProbeResult): string | null {
  switch (result.reason) {
    case 'ok':
      return null;
    case 'embed_denied':
      return "This video's owner doesn't allow it to play outside YouTube. Most lecture uploads are fine — try another link.";
    case 'not_found':
      return "That video is private, deleted, or the link is wrong. Check it's the one you meant.";
    case 'unavailable':
      return "Couldn't reach YouTube to check that link. Try again in a moment.";
  }
}

/**
 * Ask YouTube whether this video can be embedded.
 *
 * Never throws. A timeout, a DNS failure or a malformed body all land on
 * `unavailable`, because the caller's job is to render a sentence, not to
 * decide whether the process should stay up.
 */
export async function probeVideo(videoId: string): Promise<VideoProbeResult> {
  const unavailable: VideoProbeResult = {
    ok: false,
    videoId,
    title: null,
    embeddable: false,
    reason: 'unavailable',
  };

  try {
    const res = await fetch(buildOembedUrl(videoId), {
      method: 'GET',
      headers: { accept: 'application/json' },
      // The host is hardcoded, so the only way this request could reach anywhere
      // else is by being redirected there. It is not followed.
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    if (res.status !== 200) {
      void res.body?.cancel();
      return probeResultFor(videoId, res.status, null);
    }

    const text = await readCappedText(res, OEMBED_MAX_BYTES);
    if (text === null) return unavailable;

    return probeResultFor(videoId, 200, titleFromOembed(text));
  } catch (error) {
    // No URL, no body, no id in the log line — §11.10.
    console.error('[video:probe] oEmbed lookup failed', {
      error: error instanceof Error ? `${error.name}: ${error.message}` : 'non-error throw',
    });
    return unavailable;
  }
}

// ── rate limiting (§11.7) ───────────────────────────────────────────────────
//
// Its own bucket rather than an entry in lib/server/rate-limit.ts, for the same
// reason lib/server/rooms.ts has its own: that file belongs to another slice of
// this phase. Everything its header says about being in-process — N web
// instances give an attacker N x the limit, and a deploy resets every bucket —
// is equally true here, and folding this in later is a move-and-delete.

const PROBE_LIMIT = 20;
const PROBE_WINDOW_MS = 60_000;
const SWEEP_INTERVAL_MS = 5 * PROBE_WINDOW_MS;

export const PROBE_RATE_LIMIT_MESSAGE = 'Too many links checked at once. Wait a moment.';

interface Bucket {
  tokens: number;
  updatedMs: number;
}

interface LimiterState {
  buckets: Map<string, Bucket>;
  lastSweepMs: number;
}

/** Survives the dev-server module reload, so the limit is testable by hand. */
const globalForLimiter = globalThis as unknown as { __ssVideoProbeLimiter?: LimiterState };

const state: LimiterState = (globalForLimiter.__ssVideoProbeLimiter ??= {
  buckets: new Map(),
  lastSweepMs: 0,
});

export interface ProbeRateResult {
  allowed: boolean;
  retryAfterMs: number;
}

/**
 * One token per probe, keyed on the user id.
 *
 * The route is authenticated, so `userId` is always present; a null identifier
 * means something upstream is broken, and that fails closed.
 */
export function consumeProbeLimit(userId: string | null, nowMs: number = Date.now()): ProbeRateResult {
  if (userId === null || userId.length === 0) {
    return { allowed: false, retryAfterMs: PROBE_WINDOW_MS };
  }

  if (nowMs - state.lastSweepMs > SWEEP_INTERVAL_MS) {
    state.lastSweepMs = nowMs;
    for (const [key, bucket] of state.buckets) {
      // Idle for a full window means it has refilled by definition.
      if (nowMs - bucket.updatedMs > PROBE_WINDOW_MS) state.buckets.delete(key);
    }
  }

  const refillPerMs = PROBE_LIMIT / PROBE_WINDOW_MS;
  const bucket = state.buckets.get(userId);

  if (bucket === undefined) {
    state.buckets.set(userId, { tokens: PROBE_LIMIT - 1, updatedMs: nowMs });
    return { allowed: true, retryAfterMs: 0 };
  }

  const refilled = Math.min(PROBE_LIMIT, bucket.tokens + (nowMs - bucket.updatedMs) * refillPerMs);
  bucket.updatedMs = nowMs;

  if (refilled < 1) {
    bucket.tokens = refilled;
    return { allowed: false, retryAfterMs: Math.ceil((1 - refilled) / refillPerMs) };
  }

  bucket.tokens = refilled - 1;
  return { allowed: true, retryAfterMs: 0 };
}

/** Test seam. Not used by the app. */
export function resetProbeLimitsForTests(): void {
  state.buckets.clear();
  state.lastSweepMs = 0;
}
