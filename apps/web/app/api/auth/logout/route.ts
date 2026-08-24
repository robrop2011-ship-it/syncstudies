/**
 * POST /api/auth/logout — PLAN.md §10.1.
 *
 * Revokes the row this token points at and clears the cookie. Signing out with
 * an already-invalid token is a success, not an error: the caller asked to end
 * up signed out, and they are.
 */
import type { NextRequest } from 'next/server';
import { revokeSession } from '@syncstudy/auth';
import { apiHandler, noContent } from '@/lib/server/respond';
import { requireSameOrigin } from '@/lib/server/request';
import { clearSessionCookie, getSessionToken } from '@/lib/server/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = apiHandler(async (req: NextRequest) => {
  requireSameOrigin(req);

  const token = await getSessionToken();
  if (token !== null) await revokeSession(token);
  await clearSessionCookie();

  return noContent();
});
