/**
 * POST /api/auth/recovery-code — issue a replacement recovery code.
 *
 * Not in the §10.1 table, because that table assumed a code is only ever minted
 * at signup, at password change, or at recovery. Feature A2 also puts the code
 * on `/settings/account`, and we only ever stored its hash — so "show me my
 * code" is impossible and "give me a new one" is the honest version of that
 * button. The old code stops working the moment this returns.
 *
 * Requires the password: this hands out a credential that can take the account
 * over, so a borrowed session must not be enough.
 */
import type { NextRequest } from 'next/server';
import { prisma } from '@syncstudy/db';
import { MAX_PASSWORD_LENGTH } from '@syncstudy/shared';
import { issueRecoveryCode, verifyPassword } from '@syncstudy/auth';
import { apiHandler, fail, fieldFail, ok } from '@/lib/server/respond';
import { readJson, requireSameOrigin } from '@/lib/server/request';
import { limitOr429 } from '@/lib/server/rate-limit';
import { requireApiSession } from '@/lib/server/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A one-field body, validated by hand.
 *
 * `apps/web` has no direct zod dependency — the schemas it uses come from
 * `@syncstudy/shared`, and this payload is local to this route rather than part
 * of the shared contract.
 */
function readPassword(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const password = (body as { password?: unknown }).password;
  if (typeof password !== 'string') return null;
  if (password.length === 0 || password.length > MAX_PASSWORD_LENGTH) return null;
  return password;
}

export const POST = apiHandler(async (req: NextRequest) => {
  requireSameOrigin(req);

  const { session } = await requireApiSession();
  const limited = limitOr429('auth:recovery-code:user', session.user.id);
  if (limited !== null) return limited;

  const password = readPassword(await readJson(req));
  if (password === null) return fieldFail('password', 'Enter your password.');

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, passwordHash: true },
  });
  if (user === null) return fail('unauthorized', 'Sign in to continue.');

  if (!(await verifyPassword(user.passwordHash, password))) {
    return fieldFail('password', 'That password is not right.');
  }

  const recovery = await issueRecoveryCode();
  await prisma.user.update({
    where: { id: user.id },
    data: { recoveryHash: recovery.hash, recoveryIssuedAt: recovery.issuedAt },
  });

  return ok({ recoveryCode: recovery.plain });
});
