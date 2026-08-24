/**
 * POST /api/auth/login — PLAN.md §10.1, §11.1.
 *
 * Two properties this route is built around:
 *
 *  1. ONE generic message for "no such username" and "wrong password". Handles
 *     are public (they show in participant lists), so this is not about hiding
 *     their existence — it is about not handing a credential-stuffing script a
 *     free oracle for which half of a pair was right.
 *  2. Comparable timing for both outcomes. An unknown handle skips argon2 and
 *     would answer in ~1 ms against ~50 ms for a real verify; that difference is
 *     measurable over a few hundred requests, so the unknown-handle path burns
 *     an equivalent hash instead.
 */
import type { NextRequest } from 'next/server';
import { prisma } from '@syncstudy/db';
import { Schemas } from '@syncstudy/shared';
import { createSession, hashPassword, normalizeHandle, verifyPassword } from '@syncstudy/auth';
import { apiHandler, fail, ok } from '@/lib/server/respond';
import { clientIpHash, readJson, requireSameOrigin, userAgentOf } from '@/lib/server/request';
import {
  authFailureCount,
  clearAuthFailures,
  limitOr429,
  recordAuthFailure,
  sleep,
} from '@/lib/server/rate-limit';
import { setSessionCookie } from '@/lib/server/session';
import { toSelfView } from '@/lib/server/views';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GENERIC = 'Incorrect username or password.';

/** §11.1: after 5 failures on an account, add a server-side delay. */
const SLOW_AFTER_FAILURES = 5;
const SLOW_DELAY_MS = 3_000;

export const POST = apiHandler(async (req: NextRequest) => {
  requireSameOrigin(req);

  const ipHash = clientIpHash(req.headers);
  const ipLimited = limitOr429('auth:login:ip', ipHash);
  if (ipLimited !== null) return ipLimited;

  const input = Schemas.LoginInput.parse(await readJson(req));
  const handle = normalizeHandle(input.handle);

  const handleLimited = limitOr429('auth:login:handle', handle);
  if (handleLimited !== null) return handleLimited;

  const failureKey = `login:${handle}`;
  if (authFailureCount(failureKey) >= SLOW_AFTER_FAILURES) {
    // Deliberately applied before verification, so success and failure are
    // delayed identically and the delay itself leaks nothing.
    await sleep(SLOW_DELAY_MS);
  }

  const user = await prisma.user.findUnique({
    where: { handle },
    select: {
      id: true,
      handle: true,
      displayName: true,
      avatarKey: true,
      bio: true,
      school: true,
      isMinor: true,
      isGuest: true,
      status: true,
      suspendedUntil: true,
      deletedAt: true,
      createdAt: true,
      passwordHash: true,
    },
  });

  if (user === null) {
    await hashPassword(input.password); // equalise timing; result discarded
    recordAuthFailure(failureKey);
    return fail('unauthorized', GENERIC);
  }

  const passwordOk = await verifyPassword(user.passwordHash, input.password);
  if (!passwordOk) {
    recordAuthFailure(failureKey);
    return fail('unauthorized', GENERIC);
  }

  // Only now — with the password proven — do we say anything specific about the
  // account. Saying it earlier would turn this route into a status oracle.
  if (user.deletedAt !== null || user.status === 'deleted') {
    return fail(
      'forbidden',
      'This account is scheduled for deletion and can no longer be used. If that was a mistake, get in touch within 7 days of the request.',
    );
  }
  if (user.status === 'suspended') {
    const until = user.suspendedUntil;
    const when =
      until !== null && until.getTime() > Date.now()
        ? ` It lifts on ${until.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.`
        : '';
    return fail('forbidden', `This account is suspended.${when}`);
  }

  clearAuthFailures(failureKey);

  // §11.1: a new session id on every login. Nothing is reused from a previous one.
  const { token, expiresAt } = await createSession(user.id, {
    ipHash: ipHash ?? null,
    userAgent: userAgentOf(req.headers),
  });
  await setSessionCookie(token, expiresAt);

  return ok({ user: toSelfView(user) });
});
