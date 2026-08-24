/**
 * GET /api/auth/handle-available?handle= — PLAN.md §10.1, §11.1.
 *
 * Deliberately truthful. Handles appear in every participant list, so treating
 * their existence as a secret would cost the signup form its most useful piece
 * of feedback and hide nothing at all. It is rate limited (30/min/IP) because
 * scraping the full namespace is still rude.
 */
import type { NextRequest } from 'next/server';
import { prisma } from '@syncstudy/db';
import { checkHandle, normalizeHandle } from '@syncstudy/auth';
import { HANDLE_MIN } from '@syncstudy/shared';
import { apiHandler, ok } from '@/lib/server/respond';
import { clientIpHash } from '@/lib/server/request';
import { limitOr429 } from '@/lib/server/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface HandleAvailability {
  handle: string;
  available: boolean;
  message: string;
}

export const GET = apiHandler(async (req: NextRequest) => {
  const limited = limitOr429('auth:handle-available:ip', clientIpHash(req.headers));
  if (limited !== null) return limited;

  const handle = normalizeHandle(req.nextUrl.searchParams.get('handle') ?? '');

  if (handle.length < HANDLE_MIN) {
    const body: HandleAvailability = {
      handle,
      available: false,
      message: `At least ${HANDLE_MIN} characters.`,
    };
    return ok(body);
  }

  const check = checkHandle(handle);
  if (!check.ok) {
    const body: HandleAvailability = {
      handle,
      available: false,
      message: check.message ?? 'That username is not available.',
    };
    return ok(body);
  }

  const existing = await prisma.user.findUnique({ where: { handle }, select: { id: true } });
  const body: HandleAvailability = {
    handle,
    available: existing === null,
    message: existing === null ? `${handle} is available.` : 'That username is taken.',
  };
  return ok(body);
});
