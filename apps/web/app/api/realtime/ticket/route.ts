/**
 * POST /api/realtime/ticket — a one-shot credential for the socket handshake
 * (PLAN.md §11.4; see packages/auth/src/realtime-ticket.ts for why it exists).
 *
 * This route is same-origin, so the session cookie reaches it in every browser
 * regardless of the realtime service's domain. It converts that first-party
 * session into something the client can hand to a cross-site socket.
 */
import type { NextRequest } from 'next/server';
import { generateRealtimeTicket, realtimeTicketKey, REALTIME_TICKET_TTL_MS } from '@syncstudy/auth';
import { apiHandler, ok } from '@/lib/server/respond';
import { requireSameOrigin } from '@/lib/server/request';
import { requireApiSession } from '@/lib/server/session';
import { limitOr429 } from '@/lib/server/rate-limit';
import { storeRealtimeTicket } from '@/lib/server/realtime-cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface RealtimeTicket {
  ticket: string;
  expiresInMs: number;
}

export const POST = apiHandler(async (req: NextRequest) => {
  requireSameOrigin(req);

  const { session } = await requireApiSession();

  const limited = limitOr429('realtime:ticket:user', session.user.id);
  if (limited !== null) return limited;

  const ticket = generateRealtimeTicket();
  await storeRealtimeTicket(realtimeTicketKey(ticket), session.user.id, REALTIME_TICKET_TTL_MS);

  const body: RealtimeTicket = { ticket, expiresInMs: REALTIME_TICKET_TTL_MS };
  return ok(body);
});
