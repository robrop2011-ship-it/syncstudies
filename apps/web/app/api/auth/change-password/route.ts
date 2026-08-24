/**
 * POST /api/auth/change-password — PLAN.md §10.1, §11.1, feature A9.
 *
 * Requires the current password (a stolen session must not be enough to take the
 * account over), rotates the recovery code, and ends every other session.
 *
 * The current browser is rotated too rather than merely spared: §11.1 asks for a
 * new session id on password change, so the old token is deleted and a fresh one
 * is issued in the same request. The user stays signed in here and is signed out
 * everywhere else, which is what "change my password because I think someone has
 * it" is supposed to mean.
 */
import type { NextRequest } from 'next/server';
import { prisma } from '@syncstudy/db';
import { Schemas } from '@syncstudy/shared';
import {
  checkPasswordStrength,
  createSession,
  hashPassword,
  issueRecoveryCode,
  revokeAllSessions,
  verifyPassword,
} from '@syncstudy/auth';
import { apiHandler, fail, fieldFail, ok } from '@/lib/server/respond';
import { clientIpHash, readJson, requireSameOrigin, userAgentOf } from '@/lib/server/request';
import { limitOr429 } from '@/lib/server/rate-limit';
import { requireApiSession, setSessionCookie } from '@/lib/server/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = apiHandler(async (req: NextRequest) => {
  requireSameOrigin(req);

  const { session } = await requireApiSession();
  const limited = limitOr429('auth:password-change:user', session.user.id);
  if (limited !== null) return limited;

  const input = Schemas.ChangePasswordInput.parse(await readJson(req));

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, handle: true, passwordHash: true },
  });
  if (user === null) return fail('unauthorized', 'Sign in to continue.');

  if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
    return fieldFail('currentPassword', 'That is not your current password.');
  }

  const strength = checkPasswordStrength(input.newPassword, user.handle);
  if (!strength.ok) {
    return fieldFail('newPassword', strength.message ?? 'Pick a stronger password.');
  }
  if (input.newPassword === input.currentPassword) {
    return fieldFail('newPassword', 'That is already your password.');
  }

  const [passwordHash, recovery] = await Promise.all([
    hashPassword(input.newPassword),
    issueRecoveryCode(),
  ]);

  // The password and the recovery code move together, always. A password change
  // that left the old recovery code live would leave the previous owner of that
  // code holding a key to the account.
  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash,
      recoveryHash: recovery.hash,
      recoveryIssuedAt: recovery.issuedAt,
    },
  });

  const revoked = await revokeAllSessions(user.id);
  const { token, expiresAt } = await createSession(user.id, {
    ipHash: clientIpHash(req.headers) ?? null,
    userAgent: userAgentOf(req.headers),
  });
  await setSessionCookie(token, expiresAt);

  return ok({
    recoveryCode: recovery.plain,
    /** Other sessions ended (the one that made this request was rotated). */
    sessionsEnded: Math.max(0, revoked - 1),
  });
});
