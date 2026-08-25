/**
 * POST /api/reports — report a message, user, room or note.
 * PLAN.md §3.5 H10, §10.1, §11.6.
 *
 * Two things make this more than an INSERT.
 *
 * **The snapshot.** §11.6 is explicit that a report freezes a copy of the
 * content it is about, because the obvious next thing a bad actor does is delete
 * it. The row is written with the body already captured, so a message deleted
 * one second later still has evidence attached to the report.
 *
 * **The response says nothing.** Whether the target exists, whether it is
 * visible to the reporter, whether an identical report already exists — none of
 * that comes back. A report endpoint that answered honestly would be a way to
 * test whether a given uuid is a real message, and to watch moderation happen.
 * So: 201, always, for any well-formed request from a signed-in user.
 *
 * v1 has no `/admin/reports` UI (§11.6 — "do not build a moderation platform").
 * The queue is read with SQL. That is the deliberate v1 answer, not an omission.
 */
import type { NextRequest } from 'next/server';
import { prisma } from '@syncstudy/db';
import { Schemas, uuidv7 } from '@syncstudy/shared';
import { apiHandler, ok } from '@/lib/server/respond';
import { readJson, requireSameOrigin } from '@/lib/server/request';
import { requireApiSession } from '@/lib/server/session';
import { limitOr429 } from '@/lib/server/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface CreateReportResponse {
  /** Always true. See the header: the outcome is deliberately not observable. */
  received: true;
}

interface Snapshot {
  roomId: string;
  content: { body: string; authorId: string | null; createdAt: string };
}

/**
 * The frozen copy (§11.6).
 *
 * Only messages are snapshotted today, because a message is the only target
 * whose content can vanish before a human looks at the report. A user, room or
 * note is identified by its id and read live from the queue.
 */
async function snapshotFor(targetType: string, targetId: string): Promise<Snapshot | null> {
  if (targetType !== 'message') return null;

  const read = async () =>
    prisma.message.findUnique({
      where: { id: targetId },
      select: { roomId: true, body: true, userId: true, createdAt: true },
    });

  // Retried, briefly. The realtime service persists messages write-behind
  // (§6.5), so a message reported the second it appears may not be in Postgres
  // yet — and this web process has no queue of its own to drain. Giving up on
  // the first miss would file exactly the reports that matter most, about the
  // freshest and most abusive messages, with no evidence attached.
  let message = await read();
  for (let attempt = 0; message === null && attempt < 3; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    message = await read();
  }
  if (message === null) return null;

  return {
    roomId: message.roomId,
    content: {
      body: message.body,
      authorId: message.userId,
      createdAt: message.createdAt.toISOString(),
    },
  };
}

/** Null unless the room really exists — see the FK note at the call site. */
async function resolveRoomId(roomId: string | undefined): Promise<string | null> {
  if (roomId === undefined) return null;
  const room = await prisma.room.findUnique({ where: { id: roomId }, select: { id: true } });
  return room?.id ?? null;
}

export const POST = apiHandler(async (req: NextRequest) => {
  requireSameOrigin(req);

  const { session } = await requireApiSession();
  const reporterId = session.user.id;

  const limited = limitOr429('reports:create:user', reporterId);
  if (limited !== null) return limited;

  const input = Schemas.CreateReportInput.parse(await readJson(req));

  // Resolved before the insert, so a message deleted between the report being
  // filed and the row being written is still captured.
  const snapshot = await snapshotFor(input.targetType, input.targetId);

  // `room_id` and `message_id` are real foreign keys, so an id that does not
  // exist would raise a constraint error — which is both a 500 and, far worse,
  // an existence oracle: a 500 for real ids and a 201 for invented ones is
  // exactly the answer this endpoint refuses to give. Both are therefore
  // verified, and fall back to null rather than failing. `target_id` is a bare
  // uuid column with no FK, so the report still records what was reported.
  const roomId = snapshot?.roomId ?? (await resolveRoomId(input.roomId));

  await prisma.report.create({
    data: {
      id: uuidv7(),
      reporterId,
      targetType: input.targetType,
      targetId: input.targetId,
      roomId,
      messageId: snapshot === null ? null : input.targetId,
      reason: input.reason,
      ...(input.details === undefined ? {} : { details: input.details }),
      ...(snapshot === null ? {} : { snapshot: snapshot.content }),
    },
  });

  return ok<CreateReportResponse>({ received: true }, 201);
});
