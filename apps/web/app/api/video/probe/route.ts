/**
 * POST /api/video/probe — PLAN.md §5.3 quirk 5, §10.1, §11.6, §11.7.
 *
 * "Can this link actually play in an embed?", answered at paste time rather than
 * at play time. Without it the failure mode is: the host pastes a link, everyone
 * loads it, and four people stare at a black rectangle while YouTube reports
 * error 150 to a console nobody has open.
 *
 * The security-relevant parts all live in `./probe.ts`, next to the reasoning
 * for each. In short: the user's URL is never fetched — it is parsed down to an
 * 11-character id and the outbound request is rebuilt from that id against a
 * hardcoded host, with no redirects, a 5 s deadline and a 64 KB body cap.
 */
import type { NextRequest } from 'next/server';
import { apiHandler, fail, ok, HttpProblem } from '@/lib/server/respond';
import { readJson, requireSameOrigin } from '@/lib/server/request';
import { requireApiSession } from '@/lib/server/session';
import {
  PROBE_RATE_LIMIT_MESSAGE,
  consumeProbeLimit,
  parseProbeInput,
  probeVideo,
  type VideoProbeResult,
} from './probe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export type VideoProbeResponse = VideoProbeResult;

export const POST = apiHandler(async (req: NextRequest) => {
  requireSameOrigin(req);

  // Authenticated only. An open probe endpoint is a free, unattributable proxy
  // for asking YouTube about arbitrary video ids from our IP (§11.7).
  const { session } = await requireApiSession();

  const limit = consumeProbeLimit(session.user.id);
  if (!limit.allowed) {
    const retryAfterSec = Math.max(1, Math.ceil(limit.retryAfterMs / 1000));
    return fail('rate_limited', PROBE_RATE_LIMIT_MESSAGE, {
      headers: { 'retry-after': String(retryAfterSec) },
    });
  }

  // Validation FIRST, before anything reaches the network. Anything
  // `parseYouTubeUrl` does not accept — another host, a bare IP, a `file://`, a
  // link that merely mentions youtube.com — is refused here.
  const input = parseProbeInput(await readJson(req));
  if (input === null) {
    throw new HttpProblem('validation_error', "That doesn't look like a YouTube link.", {
      fields: [{ path: 'url', message: 'Paste a YouTube link, like https://www.youtube.com/watch?v=…' }],
    });
  }

  // A "no" from YouTube is a successful probe with a negative answer, so this is
  // a 200 carrying `ok: false` rather than an error status. The caller renders
  // `reason`; only a malformed request gets a 4xx.
  const result = await probeVideo(input.videoId);
  return ok<VideoProbeResponse>(result);
});
