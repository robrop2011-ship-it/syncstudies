/**
 * POST /api/feedback — "Something wrong?" from inside a room (§14 Phase 10.9).
 *
 * §14 Phase 10.9 asks for "a small in-app 'Something wrong?' button that files a
 * report with the client's last 60 s of sync telemetry attached". The telemetry
 * is the point: "the video kept jumping" is unactionable, and the same sentence
 * with a drift p95, a hard-seek count and a clock offset beside it is a bug
 * report you can do something with on a Monday morning.
 *
 * **It deliberately does not write to `reports`.** That table is the moderation
 * queue (§11.6), read by a human looking for harassment. Mixing "my audio was
 * choppy" into it means the queue that matters gets skimmed. This writes a
 * `room_events` row instead — the audit trail, already 90-day retained (§7.4),
 * already scoped to a room, and already the place a human goes to ask "what
 * happened in here".
 */
import type { NextRequest } from 'next/server';
import { prisma } from '@syncstudy/db';
import { uuidv7 } from '@syncstudy/shared';
import { z } from 'zod';
import { apiHandler, ok } from '@/lib/server/respond';
import { readJson, requireSameOrigin } from '@/lib/server/request';
import { requireApiSession } from '@/lib/server/session';
import { limitOr429 } from '@/lib/server/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface FeedbackResponse {
  received: true;
}

/**
 * The telemetry shape, mirrored from `SyncController.getTelemetrySnapshot()`.
 *
 * Every field is optional and the whole object is capped, because this arrives
 * from a browser: a client on an old build, or one whose player never
 * initialised, must be able to file a report rather than fail validation on a
 * field it has no value for.
 */
const Telemetry = z
  .object({
    driftState: z.string().max(32).optional(),
    driftSec: z.number().finite().optional(),
    driftP50: z.number().finite().nullable().optional(),
    driftP95: z.number().finite().nullable().optional(),
    samples: z.number().int().min(0).max(100_000).optional(),
    hardSeeksLastMinute: z.number().int().min(0).max(10_000).optional(),
    clockOffsetMs: z.number().finite().optional(),
    quality: z.string().max(16).optional(),
    buffering: z.boolean().optional(),
    autoSyncPaused: z.boolean().optional(),
    playerError: z.number().int().nullable().optional(),
    seekLatencyMs: z.number().int().min(0).max(600_000).optional(),
    connection: z.string().max(32).optional(),
    videoStatus: z.string().max(16).optional(),
    videoRevision: z.number().int().min(0).optional(),
    participants: z.number().int().min(0).max(1_000).optional(),
    inCall: z.boolean().optional(),
    callPeers: z.number().int().min(0).max(100).optional(),
  })
  .strict();

const FeedbackInput = z.object({
  roomId: z.string().uuid(),
  /** What the person actually said. The telemetry is context, not the report. */
  message: z.string().trim().min(1).max(1_000),
  telemetry: Telemetry.optional(),
  /** Trimmed hard: a user agent is a fingerprint, and we want the browser only. */
  userAgent: z.string().max(200).optional(),
});

export const POST = apiHandler(async (req: NextRequest) => {
  requireSameOrigin(req);
  const { session } = await requireApiSession();

  // Generous, because a person having a bad session may legitimately send two or
  // three. Not unlimited, because this writes a row.
  const limited = limitOr429('feedback:user', session.user.id);
  if (limited !== null) return limited;

  const input = FeedbackInput.parse(await readJson(req));

  // Scoped to a room the reporter is actually a participant of. Without this the
  // endpoint would write an arbitrary payload against any room id, which is a
  // storage-filling primitive with a signed-in account behind it.
  const membership = await prisma.roomParticipant.findUnique({
    where: { roomId_userId: { roomId: input.roomId, userId: session.user.id } },
    select: { roomId: true },
  });

  // Says nothing either way, for the same reason `/api/reports` does not: the
  // answer would be a way to test whether a uuid is a real room.
  if (membership !== null) {
    await prisma.roomEvent.create({
      data: {
        id: uuidv7(),
        roomId: input.roomId,
        actorId: session.user.id,
        type: 'feedback',
        payload: {
          message: input.message,
          telemetry: input.telemetry ?? null,
          userAgent: input.userAgent ?? null,
        },
      },
    });
  }

  return ok<FeedbackResponse>({ received: true }, 201);
});
