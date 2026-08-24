/**
 * `time:ping` — the clock-offset primitive (PLAN.md §8.3).
 *
 * This is deliberately the cheapest handler in the process, and it must stay
 * that way. The client's offset estimate is
 *
 *     offset = serverMs - (t0 + t2) / 2
 *
 * which assumes the server's reply time sits at the midpoint of the round trip.
 * Every microsecond spent between receiving the ping and reading the clock is
 * asymmetry, and asymmetry is error that no amount of median-filtering removes.
 *
 * So: no `await`, no database, no Redis, no logging. The rate limit uses the
 * in-process counter for the same reason. `Date.now()` is read as late as
 * possible — immediately before the ack.
 */
import { Schemas } from '@syncstudy/shared';
import { LIMITS } from '../ratelimit/tokenBucket.js';
import type { AppContext, TypedSocket } from './context.js';

export function registerTimeHandlers(ctx: AppContext, socket: TypedSocket): void {
  socket.on('time:ping', (payload, ack) => {
    if (typeof ack !== 'function') return;

    const verdict = ctx.limiter.consumeLocal(socket.id, 'time:ping', LIMITS['time:ping']);
    if (!verdict.allowed) {
      socket.emit('sys:rate_limited', { event: 'time:ping', retryAfterMs: verdict.retryAfterMs });
      if (verdict.disconnect) socket.disconnect(true);
      return;
    }

    // Validate without the Zod `safeParse` allocation on the hot path: the only
    // field is a number, and echoing a non-number would corrupt the client's
    // sample rather than compromise anything.
    const t0 = typeof payload?.t0 === 'number' && Number.isFinite(payload.t0) ? payload.t0 : 0;

    ack({ t0, serverMs: Date.now() });
  });
}

/**
 * Exported so the contract test can assert this handler answers the schema it
 * claims to. The runtime path above intentionally does not call it.
 */
export function parseTimePing(payload: unknown): Schemas.TimePing | null {
  const parsed = Schemas.TimePing.safeParse(payload);
  return parsed.success ? parsed.data : null;
}
