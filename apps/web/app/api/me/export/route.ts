/**
 * GET /api/me/export — PLAN.md §10.1, §11.9 ("Export & delete").
 *
 * Everything tied to the account, as one JSON document, downloadable without a
 * support ticket. Two deliberate choices:
 *
 *  - It is NOT wrapped in the `{ok,data}` envelope. This is a file the user
 *    saves, not a call the client parses, and an envelope would put a layer of
 *    our plumbing between them and their own data.
 *  - `ipHash` and the session ids are omitted. The hashes exist for abuse
 *    prevention (§11.9) and handing them back would be handing back a stable
 *    identifier for the user's network, which serves nobody.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@syncstudy/db';
import { apiHandler, fail } from '@/lib/server/respond';
import { limitOr429 } from '@/lib/server/rate-limit';
import { requireApiSession } from '@/lib/server/session';
import { toSelfView, toSettingsView } from '@/lib/server/views';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A ceiling so one very chatty account cannot ask us to buffer 400 MB of JSON. */
const MAX_ROWS = 5_000;

// The request object is unused: the export is entirely driven by the session.
// eslint's no-unused-vars does not honour the leading underscore here, and a
// silent warning in CI is a warning nobody reads, so the parameter is dropped.
export const GET = apiHandler(async () => {
  const { session } = await requireApiSession();
  const limited = limitOr429('me:export:user', session.user.id);
  if (limited !== null) return limited;

  const userId = session.user.id;

  const user = await prisma.user.findUnique({
    where: { id: userId },
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
      updatedAt: true,
      recoveryIssuedAt: true,
      settings: true,
    },
  });
  if (user === null) return fail('unauthorized', 'Sign in to continue.');

  const [sessions, hostedRooms, memberships, messages, noteItems, noteReplies, checklistItems, studySessions, reports] =
    await Promise.all([
      prisma.authSession.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, lastSeenAt: true, expiresAt: true, userAgent: true },
      }),
      prisma.room.findMany({
        where: { hostId: userId },
        orderBy: { createdAt: 'desc' },
        take: MAX_ROWS,
        select: {
          code: true,
          name: true,
          topic: true,
          status: true,
          createdAt: true,
          lastActiveAt: true,
          endedAt: true,
        },
      }),
      prisma.roomParticipant.findMany({
        where: { userId },
        orderBy: { lastJoinedAt: 'desc' },
        take: MAX_ROWS,
        select: {
          role: true,
          firstJoinedAt: true,
          lastJoinedAt: true,
          leftAt: true,
          totalSeconds: true,
          room: { select: { code: true, name: true } },
        },
      }),
      prisma.message.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: MAX_ROWS,
        select: {
          body: true,
          videoTs: true,
          createdAt: true,
          deletedAt: true,
          room: { select: { code: true, name: true } },
        },
      }),
      prisma.noteItem.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: MAX_ROWS,
        select: {
          kind: true,
          body: true,
          videoTs: true,
          resolvedAt: true,
          createdAt: true,
          room: { select: { code: true, name: true } },
        },
      }),
      prisma.noteReply.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: MAX_ROWS,
        select: { body: true, createdAt: true },
      }),
      prisma.checklistItem.findMany({
        where: { createdBy: userId },
        orderBy: { createdAt: 'desc' },
        take: MAX_ROWS,
        select: {
          label: true,
          videoTs: true,
          completedAt: true,
          createdAt: true,
          room: { select: { code: true, name: true } },
        },
      }),
      prisma.studySession.findMany({
        where: { userId },
        orderBy: { joinedAt: 'desc' },
        take: MAX_ROWS,
        select: {
          joinedAt: true,
          leftAt: true,
          seconds: true,
          inCallSeconds: true,
          room: { select: { code: true, name: true } },
        },
      }),
      prisma.report.findMany({
        where: { reporterId: userId },
        orderBy: { createdAt: 'desc' },
        take: MAX_ROWS,
        select: { targetType: true, reason: true, details: true, status: true, createdAt: true },
      }),
    ]);

  const document = {
    exportedAt: new Date().toISOString(),
    format: 'syncstudy.account-export.v1',
    note:
      'This is everything SyncStudy holds that is tied to your account. We do not store an email address, a real name, a phone number, or a location. Passwords and recovery codes are stored only as hashes and cannot be exported.',
    account: toSelfView(user),
    accountMeta: {
      updatedAt: user.updatedAt.toISOString(),
      recoveryCodeIssuedAt: user.recoveryIssuedAt?.toISOString() ?? null,
    },
    settings: toSettingsView(user.settings),
    sessions,
    hostedRooms,
    roomMemberships: memberships,
    messages,
    noteItems,
    noteReplies,
    checklistItems,
    studySessions,
    reportsFiled: reports,
    truncated: {
      /** True where a list hit MAX_ROWS and older rows were left out. */
      messages: messages.length === MAX_ROWS,
      noteItems: noteItems.length === MAX_ROWS,
      studySessions: studySessions.length === MAX_ROWS,
    },
  };

  const filename = `syncstudy-${user.handle}-${new Date().toISOString().slice(0, 10)}.json`;
  return NextResponse.json(document, {
    headers: {
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  });
});
