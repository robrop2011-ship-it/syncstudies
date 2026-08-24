/**
 * POST /api/auth/recover — PLAN.md §10.1, §11.1, Amendment A1, feature A9.
 *
 * The only way back into an account. There is no email, so there is no reset
 * link and no second factor: whoever holds the code is treated as the owner.
 * That makes three properties load-bearing.
 *
 *  1. SINGLE USE. The redemption is a compare-and-swap against the stored hash
 *     (`updateMany … where recoveryHash = <the hash we verified>`). Two requests
 *     racing with the same code produce exactly one winner, because the loser's
 *     WHERE no longer matches. Postgres does that atomically; a read-then-write
 *     would not.
 *  2. NO ORACLE ON THE NEW PASSWORD. The new password is validated BEFORE the
 *     code is checked. The other order would leak: a deliberately weak password
 *     that comes back "too common" instead of "that code doesn't match" would
 *     tell an attacker the code was right, without spending it.
 *  3. EVERY SESSION DIES. Recovery is what someone does after losing control of
 *     an account; leaving the attacker's session alive would defeat the point.
 */
import type { NextRequest } from 'next/server';
import { prisma } from '@syncstudy/db';
import { Schemas } from '@syncstudy/shared';
import {
  checkPasswordStrength,
  createSession,
  hashPassword,
  issueRecoveryCode,
  normalizeHandle,
  revokeAllSessions,
  verifyRecoveryCode,
} from '@syncstudy/auth';
import { apiHandler, fail, fieldFail, ok } from '@/lib/server/respond';
import { clientIpHash, readJson, requireSameOrigin, userAgentOf } from '@/lib/server/request';
import { limitOr429 } from '@/lib/server/rate-limit';
import { setSessionCookie } from '@/lib/server/session';
import { toSelfView } from '@/lib/server/views';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GENERIC = "That username and recovery code don't match. Codes can only be used once.";

export const POST = apiHandler(async (req: NextRequest) => {
  requireSameOrigin(req);

  const ipHash = clientIpHash(req.headers);
  const ipLimited = limitOr429('auth:recover:ip', ipHash);
  if (ipLimited !== null) return ipLimited;

  const input = Schemas.RecoverInput.parse(await readJson(req));
  const handle = normalizeHandle(input.handle);

  const handleLimited = limitOr429('auth:recover:handle', handle);
  if (handleLimited !== null) return handleLimited;

  // (2) above: password rules first, so their outcome can't confirm a code.
  const strength = checkPasswordStrength(input.newPassword, handle);
  if (!strength.ok) {
    return fieldFail('newPassword', strength.message ?? 'Pick a stronger password.');
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
      recoveryHash: true,
    },
  });

  if (user === null || user.recoveryHash === null) {
    // Same shape and roughly the same cost as a real verification.
    await hashPassword(input.recoveryCode);
    return fail('unauthorized', GENERIC);
  }

  const codeOk = await verifyRecoveryCode(user.recoveryHash, input.recoveryCode);
  if (!codeOk) return fail('unauthorized', GENERIC);

  if (user.deletedAt !== null || user.status === 'deleted') {
    return fail(
      'forbidden',
      'This account is scheduled for deletion, so it cannot be recovered. The code has not been used.',
    );
  }
  if (user.status === 'suspended') {
    return fail('forbidden', 'This account is suspended. The code has not been used.');
  }

  const [passwordHash, replacement] = await Promise.all([
    hashPassword(input.newPassword),
    issueRecoveryCode(),
  ]);

  // (1) above. The old hash in the WHERE is what makes redemption single-use.
  const redeemed = await prisma.user.updateMany({
    where: { id: user.id, recoveryHash: user.recoveryHash },
    data: {
      passwordHash,
      recoveryHash: replacement.hash,
      recoveryIssuedAt: replacement.issuedAt,
    },
  });
  if (redeemed.count === 0) return fail('unauthorized', GENERIC);

  // (3) above.
  await revokeAllSessions(user.id);

  const { token, expiresAt } = await createSession(user.id, {
    ipHash: ipHash ?? null,
    userAgent: userAgentOf(req.headers),
  });
  await setSessionCookie(token, expiresAt);

  return ok({ user: toSelfView(user), recoveryCode: replacement.plain });
});
