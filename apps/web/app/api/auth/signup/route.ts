/**
 * POST /api/auth/signup — PLAN.md §10.1, §11.1, §11.9, Amendment A1.
 *
 * Username + display name + password + birth year. There is no email anywhere in
 * this flow, which is why the recovery code returned here is the only way back
 * into the account if the password is forgotten. It is shown exactly once: it is
 * never stored in plaintext, never written to a log, and never re-derivable.
 */
import type { NextRequest } from 'next/server';
import { prisma } from '@syncstudy/db';
import {
  Schemas,
  uuidv7,
  MIN_SIGNUP_AGE,
  MINOR_AGE_CEILING,
} from '@syncstudy/shared';
import {
  checkDisplayName,
  checkHandle,
  checkPasswordStrength,
  createSession,
  hashPassword,
  issueRecoveryCode,
  normalizeHandle,
} from '@syncstudy/auth';
import { apiHandler, fieldFail, isUniqueViolation, ok } from '@/lib/server/respond';
import { clientIpHash, readJson, requireSameOrigin, userAgentOf } from '@/lib/server/request';
import { limitOr429 } from '@/lib/server/rate-limit';
import { setSessionCookie } from '@/lib/server/session';
import { MINOR_LOCKED_SETTINGS, toSelfView } from '@/lib/server/views';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Oldest plausible birth year, so a typo lands on a message instead of a row. */
const MAX_AGE = 120;

const TAKEN = 'That username is taken.';

export const POST = apiHandler(async (req: NextRequest) => {
  requireSameOrigin(req);

  const ipHash = clientIpHash(req.headers);
  const limited = limitOr429('auth:signup:ip', ipHash);
  if (limited !== null) return limited;

  const input = Schemas.SignupInput.parse(await readJson(req));
  const handle = normalizeHandle(input.handle);

  const handleCheck = checkHandle(handle);
  if (!handleCheck.ok) {
    return fieldFail('handle', handleCheck.message ?? 'That username is not available.');
  }

  // The SAME screening the profile-update route applies (§11.6). Screening only
  // on update would let a bidi-override or zero-width display name be
  // established here and then persist, since nothing would ever re-check it.
  const nameCheck = checkDisplayName(input.displayName);
  if (!nameCheck.ok) {
    return fieldFail('displayName', nameCheck.message ?? 'That display name is not allowed.');
  }

  const passwordCheck = checkPasswordStrength(input.password, handle);
  if (!passwordCheck.ok) {
    return fieldFail('password', passwordCheck.message ?? 'Pick a stronger password.');
  }

  // Age floor (§11.9). The birth year is used here and then discarded — we store
  // the derived `isMinor` flag and nothing else, because a year of birth is
  // personal data we have no further use for.
  const age = new Date().getUTCFullYear() - input.birthYear;
  if (age < MIN_SIGNUP_AGE) {
    return fieldFail(
      'birthYear',
      `You need to be at least ${MIN_SIGNUP_AGE} to use SyncStudy. Nothing has been saved.`,
    );
  }
  if (age > MAX_AGE) {
    return fieldFail('birthYear', 'Check that birth year.');
  }
  const isMinor = age < MINOR_AGE_CEILING;

  // Ask first so the common case gets a field-level message rather than a
  // unique-constraint 500. The catch below still covers the race.
  const existing = await prisma.user.findUnique({ where: { handle }, select: { id: true } });
  if (existing !== null) return fieldFail('handle', TAKEN);

  const [passwordHash, recovery] = await Promise.all([
    hashPassword(input.password),
    issueRecoveryCode(),
  ]);

  const settingsCreate: {
    profileVisibility?: string;
    defaultRoomPrivacy?: string;
    showOnlineStatus?: boolean;
    hideIpFromPeers?: boolean;
  } = {};
  if (isMinor) {
    // Not toggleable, not hidden — the settings page explains each one (§11.9).
    settingsCreate.profileVisibility = MINOR_LOCKED_SETTINGS.profileVisibility;
    settingsCreate.defaultRoomPrivacy = MINOR_LOCKED_SETTINGS.defaultRoomPrivacy;
    settingsCreate.showOnlineStatus = MINOR_LOCKED_SETTINGS.showOnlineStatus;
    settingsCreate.hideIpFromPeers = MINOR_LOCKED_SETTINGS.hideIpFromPeers;
  }

  const userId = uuidv7();

  // One transaction: an account without its settings row would be an account
  // whose privacy defaults are undefined, which for a minor is unacceptable.
  const created = await prisma
    .$transaction(async (tx) =>
      tx.user.create({
        data: {
          id: userId,
          handle,
          displayName: input.displayName.trim(),
          passwordHash,
          recoveryHash: recovery.hash,
          recoveryIssuedAt: recovery.issuedAt,
          isMinor,
          settings: { create: settingsCreate },
        },
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
          createdAt: true,
        },
      }),
    )
    .catch((error: unknown) => {
      // Two requests can pass the check above at the same time; the unique index
      // is what actually decides, and losing that race is a field error, not a 500.
      if (isUniqueViolation(error, 'handle')) return null;
      throw error;
    });

  if (created === null) return fieldFail('handle', TAKEN);

  const { token, expiresAt } = await createSession(userId, {
    ipHash: ipHash ?? null,
    userAgent: userAgentOf(req.headers),
  });
  await setSessionCookie(token, expiresAt);

  // `recovery.plain` crosses the wire here and nowhere else, ever.
  return ok({ user: toSelfView(created), recoveryCode: recovery.plain }, 201);
});
