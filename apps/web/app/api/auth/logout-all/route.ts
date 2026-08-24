/**
 * POST /api/auth/logout-all — PLAN.md §10.1, §11.1 ("sign out everywhere").
 *
 * Deletes every session row for the account, this one included. Without an email
 * channel we cannot warn anyone about a suspicious sign-in, so this button is
 * the user's whole response to "I think someone else is in my account" — it has
 * to be immediate and total.
 */
import type { NextRequest } from 'next/server';
import { revokeAllSessions } from '@syncstudy/auth';
import { apiHandler, ok } from '@/lib/server/respond';
import { requireSameOrigin } from '@/lib/server/request';
import { clearSessionCookie, requireApiSession } from '@/lib/server/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = apiHandler(async (req: NextRequest) => {
  requireSameOrigin(req);

  const { session } = await requireApiSession();
  const revoked = await revokeAllSessions(session.user.id);
  await clearSessionCookie();

  return ok({ revoked });
});
