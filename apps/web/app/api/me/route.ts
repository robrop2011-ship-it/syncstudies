/**
 * /api/me — GET, PATCH, DELETE (PLAN.md §10.1, §11.9, feature A8).
 */
import type { NextRequest } from 'next/server';
import { prisma } from '@syncstudy/db';
import { MAX_PASSWORD_LENGTH, Schemas } from '@syncstudy/shared';
import { verifyPassword, checkDisplayName } from '@syncstudy/auth';
import { apiHandler, fail, fieldFail, noContent, ok } from '@/lib/server/respond';
import { readJson, requireSameOrigin } from '@/lib/server/request';
import { limitOr429 } from '@/lib/server/rate-limit';
import { clearSessionCookie, requireApiSession } from '@/lib/server/session';
import { toSelfView, toSettingsView, type MeView } from '@/lib/server/views';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ME_SELECT = {
  id: true,
  handle: true,
  displayName: true,
  avatarKey: true,
  bio: true,
  school: true,
  isMinor: true,
  isGuest: true,
  status: true,
  createdAt: true,
  settings: true,
} as const;


export const GET = apiHandler(async () => {
  const { session } = await requireApiSession();

  const record = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: ME_SELECT,
  });
  if (record === null) return fail('unauthorized', 'Sign in to continue.');

  const body: MeView = { user: toSelfView(record), settings: toSettingsView(record.settings) };
  return ok(body);
});

export const PATCH = apiHandler(async (req: NextRequest) => {
  requireSameOrigin(req);

  const { session } = await requireApiSession();
  const limited = limitOr429('me:update:user', session.user.id);
  if (limited !== null) return limited;

  const input = Schemas.UpdateProfileInput.parse(await readJson(req));

  const data: { displayName?: string; bio?: string | null; school?: string | null } = {};

  if (input.displayName !== undefined) {
    const nameCheck = checkDisplayName(input.displayName);
    if (!nameCheck.ok) {
      return fieldFail('displayName', nameCheck.message ?? 'That display name is not allowed.');
    }
    data.displayName = input.displayName.trim();
  }
  if (input.bio !== undefined) {
    const bio = input.bio === null ? null : input.bio.trim();
    data.bio = bio === null || bio.length === 0 ? null : bio;
  }
  if (input.school !== undefined) {
    const school = input.school === null ? null : input.school.trim();
    data.school = school === null || school.length === 0 ? null : school;
  }

  const record =
    Object.keys(data).length === 0
      ? await prisma.user.findUnique({ where: { id: session.user.id }, select: ME_SELECT })
      : await prisma.user.update({ where: { id: session.user.id }, data, select: ME_SELECT });

  if (record === null) return fail('unauthorized', 'Sign in to continue.');

  const body: MeView = { user: toSelfView(record), settings: toSettingsView(record.settings) };
  return ok(body);
});

function readPassword(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const password = (body as { password?: unknown }).password;
  if (typeof password !== 'string') return null;
  if (password.length === 0 || password.length > MAX_PASSWORD_LENGTH) return null;
  return password;
}

/**
 * DELETE /api/me — feature A8, §11.9.
 *
 * A soft delete with a 7-day window, not a cascade. Cascading would tear the
 * user's messages out of every room they studied in, which punishes the people
 * they studied with for a decision that was theirs alone.
 *
 * What happens now (synchronously):
 *  - profile PII is scrubbed: bio, school, avatar;
 *  - the display name becomes "Deleted user", so existing chat history reads
 *    correctly the moment they leave;
 *  - the recovery code is destroyed, so the account cannot be recovered into;
 *  - every session is deleted;
 *  - open room memberships are closed, so occupancy counts stay honest.
 *
 * What the purge job owes after 7 days (Phase 9 — it does not exist yet, and
 * this comment is its specification): null `messages.user_id` and the other
 * authorship FKs (all `onDelete: SetNull`, so content survives anonymised),
 * replace the handle with a random placeholder, hand off or end any room where
 * this user is still the host (`rooms.host_id` is `onDelete: Restrict`), then
 * delete the row.
 *
 * The handle stays reserved until then. Releasing it immediately would let
 * someone claim it and inherit the departed user's history in every participant
 * list they still appear in.
 */
export const DELETE = apiHandler(async (req: NextRequest) => {
  requireSameOrigin(req);

  const { session } = await requireApiSession();
  const limited = limitOr429('me:delete:user', session.user.id);
  if (limited !== null) return limited;

  const password = readPassword(await readJson(req));
  if (password === null) return fieldFail('password', 'Enter your password to confirm.');

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, passwordHash: true, deletedAt: true },
  });
  if (user === null) return fail('unauthorized', 'Sign in to continue.');
  if (user.deletedAt !== null) {
    await clearSessionCookie();
    return noContent();
  }

  if (!(await verifyPassword(user.passwordHash, password))) {
    return fieldFail('password', 'That password is not right.');
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: {
        deletedAt: now,
        status: 'deleted',
        displayName: 'Deleted user',
        bio: null,
        school: null,
        avatarKey: null,
        recoveryHash: null,
        recoveryIssuedAt: null,
      },
    });
    await tx.authSession.deleteMany({ where: { userId: user.id } });
    await tx.roomParticipant.updateMany({
      where: { userId: user.id, leftAt: null },
      data: { leftAt: now },
    });
  });

  await clearSessionCookie();
  return noContent();
});
