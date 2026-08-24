/**
 * Socket-tier rate limiting (PLAN.md §11.7, limits from the §10.2 table).
 *
 * Keyed by `socketId + eventName`. Three rules that are easy to get wrong and
 * expensive to get wrong:
 *
 *  1. A breach is NOT a disconnect. Emit `sys:rate_limited` to that socket only.
 *     Three breaches inside 60 s is a disconnect, plus a 60 s cooldown before a
 *     reconnect is accepted.
 *  2. Fail CLOSED for anything security-relevant (joins, host powers, TURN
 *     credential minting): Redis down must not become "all limits removed".
 *  3. Fail OPEN for chat and presence: a chat flood is survivable, a chat outage
 *     during a study session is not.
 */
import { keys, type ScriptedRedis } from '../redis.js';
import type { ClientToServerEvents } from '@syncstudy/shared';
import type { Logger } from '../logger.js';
import { rateLimitHitsTotal } from '../metrics.js';

export interface RateRule {
  /** Sustained allowance per `windowMs`. */
  limit: number;
  windowMs: number;
  /**
   * Instantaneous allowance. When set, the limiter checks two windows: `burst`
   * events per `windowMs`, and `limit * 2` per `windowMs * 2`. That reproduces
   * "5 / 5 s, burst 10" exactly — ten messages may land at once, but the
   * sustained rate still settles at five per five seconds.
   */
  burst?: number;
  /** Redis unreachable → allow (true) or reject (false). */
  failOpen: boolean;
  /**
   * `local` never touches Redis. Reserved for `time:ping`, which must stay the
   * cheapest handler in the process (§8.3 runs eight of them on every join).
   */
  scope: 'redis' | 'local';
}

/**
 * Every client→server event has an entry. The §10.2 table leaves a few blank;
 * those get a generous sanity cap rather than nothing, because "unlimited" is
 * how a single malicious socket pins a CPU.
 */
export const LIMITS: Record<keyof ClientToServerEvents, RateRule> = {
  'time:ping': { limit: 30, windowMs: 10_000, failOpen: true, scope: 'local' },

  'room:join': { limit: 10, windowMs: 60_000, failOpen: false, scope: 'redis' },
  // §10.2 lists no limit; a leave is cheap but must not be a spin loop.
  'room:leave': { limit: 30, windowMs: 60_000, failOpen: true, scope: 'redis' },
  'room:resync': { limit: 6, windowMs: 60_000, failOpen: false, scope: 'redis' },

  'video:set': { limit: 10, windowMs: 60_000, failOpen: false, scope: 'redis' },
  'video:control': { limit: 8, windowMs: 10_000, failOpen: false, scope: 'redis' },
  'video:buffering': { limit: 6, windowMs: 10_000, failOpen: true, scope: 'redis' },
  'video:report_drift': { limit: 1, windowMs: 30_000, failOpen: true, scope: 'redis' },

  'chat:send': { limit: 5, windowMs: 5_000, burst: 10, failOpen: true, scope: 'redis' },
  // Destructive, and a moderation power for co-hosts: fail closed.
  'chat:delete': { limit: 20, windowMs: 60_000, failOpen: false, scope: 'redis' },
  'chat:typing': { limit: 1, windowMs: 3_000, failOpen: true, scope: 'redis' },

  'notes:block_focus': { limit: 10, windowMs: 10_000, failOpen: true, scope: 'redis' },
  'notes:block_update': { limit: 10, windowMs: 5_000, failOpen: true, scope: 'redis' },
  'notes:item_create': { limit: 20, windowMs: 60_000, failOpen: true, scope: 'redis' },
  'notes:item_update': { limit: 30, windowMs: 60_000, failOpen: true, scope: 'redis' },
  'notes:item_delete': { limit: 20, windowMs: 60_000, failOpen: false, scope: 'redis' },

  'checklist:create': { limit: 30, windowMs: 60_000, failOpen: true, scope: 'redis' },
  'checklist:toggle': { limit: 40, windowMs: 60_000, failOpen: true, scope: 'redis' },
  'checklist:reorder': { limit: 40, windowMs: 60_000, failOpen: true, scope: 'redis' },
  // §10.2 lists no limit; destructive, so fail closed.
  'checklist:delete': { limit: 20, windowMs: 60_000, failOpen: false, scope: 'redis' },

  'presence:update': { limit: 10, windowMs: 10_000, failOpen: true, scope: 'redis' },

  'rtc:join': { limit: 6, windowMs: 60_000, failOpen: false, scope: 'redis' },
  'rtc:leave': { limit: 10, windowMs: 60_000, failOpen: true, scope: 'redis' },
  // Trickle ICE is chatty; this is a relay-abuse ceiling, not a UX limit.
  'rtc:signal': { limit: 120, windowMs: 10_000, failOpen: false, scope: 'redis' },
  // Mints TURN credentials — the one place a leak costs real money (§9.3).
  'rtc:ice_refresh': { limit: 4, windowMs: 600_000, failOpen: false, scope: 'redis' },
  'rtc:screenshare_claim': { limit: 6, windowMs: 60_000, failOpen: false, scope: 'redis' },
  'rtc:screenshare_release': { limit: 10, windowMs: 60_000, failOpen: true, scope: 'redis' },

  'host:kick': { limit: 20, windowMs: 60_000, failOpen: false, scope: 'redis' },
  'host:ban': { limit: 10, windowMs: 60_000, failOpen: false, scope: 'redis' },
  'host:set_role': { limit: 20, windowMs: 60_000, failOpen: false, scope: 'redis' },
  'host:transfer': { limit: 5, windowMs: 60_000, failOpen: false, scope: 'redis' },
  'host:force_mute': { limit: 20, windowMs: 60_000, failOpen: false, scope: 'redis' },
  'host:update_policy': { limit: 20, windowMs: 60_000, failOpen: false, scope: 'redis' },
  'host:end_room': { limit: 2, windowMs: 60_000, failOpen: false, scope: 'redis' },
};

/**
 * `presence:update` carrying only a `speaking` flag runs at voice-activity rate,
 * which is an order of magnitude above the other presence patches (§10.2).
 */
export const SPEAKING_LIMIT: RateRule = {
  limit: 4,
  windowMs: 1_000,
  failOpen: true,
  scope: 'redis',
};

/** §11.7: three breaches inside 60 s → disconnect, then a 60 s cooldown. */
export const STRIKE_LIMIT = 3;
export const STRIKE_WINDOW_MS = 60_000;
export const COOLDOWN_MS = 60_000;

export interface RateVerdict {
  allowed: boolean;
  retryAfterMs: number;
  /** True once this socket has struck out; the caller disconnects it. */
  disconnect: boolean;
}

const ALLOWED: RateVerdict = { allowed: true, retryAfterMs: 0, disconnect: false };

export class TokenBucket {
  /** Breach timestamps per socket. In-process because a socket lives on one node. */
  private readonly strikes = new Map<string, number[]>();
  /** Local counters for `scope: 'local'` rules. */
  private readonly localWindows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly redis: ScriptedRedis,
    private readonly log: Logger,
  ) {}

  /**
   * @param socketId keying half of `socketId + event` (§11.7)
   * @param event    the event name — the metric label and what the client is told
   * @param rule     defaults to LIMITS[event]; pass SPEAKING_LIMIT for the speaking patch
   * @param keyEvent the other key half, when a variant rule needs its own counter.
   *        `presence:update` carries two rules with different windows, and sharing
   *        one counter between them would let whichever arrived first decide the
   *        window for both.
   */
  async consume(
    socketId: string,
    event: string,
    rule: RateRule,
    keyEvent: string = event,
  ): Promise<RateVerdict> {
    if (rule.scope === 'local') return this.consumeLocal(socketId, event, rule, keyEvent);

    const verdict = await this.evaluate(socketId, keyEvent, rule);
    if (verdict.allowed) return verdict;

    rateLimitHitsTotal.inc({ event });
    const disconnect = this.recordStrike(socketId);
    return { ...verdict, disconnect };
  }

  /**
   * Synchronous, allocation-light path for `time:ping`. The clock estimator
   * fires eight of these back-to-back on every join and the accuracy of the
   * offset depends on the reply being immediate, so this handler must never
   * await anything (§8.3).
   */
  consumeLocal(
    socketId: string,
    event: string,
    rule: RateRule,
    keyEvent: string = event,
  ): RateVerdict {
    const verdict = this.evaluateLocal(socketId, keyEvent, rule);
    if (verdict.allowed) return verdict;

    rateLimitHitsTotal.inc({ event });
    return { ...verdict, disconnect: this.recordStrike(socketId) };
  }

  private async evaluate(socketId: string, keyEvent: string, rule: RateRule): Promise<RateVerdict> {
    const primaryCap = rule.burst ?? rule.limit;
    const primary = await this.hit(`${socketId}:${keyEvent}`, primaryCap, rule.windowMs, rule);
    if (!primary.allowed) return primary;

    if (rule.burst === undefined) return ALLOWED;

    // Sustained window: twice the period, twice the sustained allowance.
    return this.hit(`${socketId}:${keyEvent}:sustained`, rule.limit * 2, rule.windowMs * 2, rule);
  }

  private async hit(
    scopeKey: string,
    limit: number,
    windowMs: number,
    rule: RateRule,
  ): Promise<RateVerdict> {
    try {
      const [allowed, retryAfterMs] = await this.redis.rateLimit(
        keys.rateLimit('sock', scopeKey),
        String(limit),
        String(windowMs),
      );
      return allowed === 1
        ? ALLOWED
        : { allowed: false, retryAfterMs: Math.max(0, retryAfterMs), disconnect: false };
    } catch (err) {
      // §11.7: fail closed for auth-shaped events, open for chat-shaped ones.
      this.log.error({ err, failOpen: rule.failOpen }, 'rate limit backend unavailable');
      return rule.failOpen
        ? ALLOWED
        : { allowed: false, retryAfterMs: rule.windowMs, disconnect: false };
    }
  }

  /** No Redis, no await path — used by `time:ping`. */
  private evaluateLocal(socketId: string, keyEvent: string, rule: RateRule): RateVerdict {
    const key = `${socketId}:${keyEvent}`;
    const now = Date.now();
    const window = this.localWindows.get(key);

    if (!window || now >= window.resetAt) {
      this.localWindows.set(key, { count: 1, resetAt: now + rule.windowMs });
      return ALLOWED;
    }
    window.count += 1;
    if (window.count > rule.limit) {
      return { allowed: false, retryAfterMs: window.resetAt - now, disconnect: false };
    }
    return ALLOWED;
  }

  /** @returns true when this socket has struck out and must be disconnected. */
  private recordStrike(socketId: string): boolean {
    const now = Date.now();
    const recent = (this.strikes.get(socketId) ?? []).filter((t) => now - t < STRIKE_WINDOW_MS);
    recent.push(now);
    this.strikes.set(socketId, recent);
    return recent.length >= STRIKE_LIMIT;
  }

  /**
   * Block reconnects for COOLDOWN_MS. Stored in Redis, not in memory, so the
   * offender cannot simply land on another node.
   */
  async applyCooldown(userId: string): Promise<void> {
    try {
      await this.redis.set(keys.rateLimitCooldown(userId), '1', 'PX', COOLDOWN_MS);
    } catch (err) {
      this.log.error({ userId, err }, 'failed to write reconnect cooldown');
    }
  }

  async inCooldown(userId: string): Promise<boolean> {
    return (await this.redis.exists(keys.rateLimitCooldown(userId))) === 1;
  }

  /** Free per-socket bookkeeping on disconnect so the maps cannot grow forever. */
  forget(socketId: string): void {
    this.strikes.delete(socketId);
    for (const key of this.localWindows.keys()) {
      if (key.startsWith(`${socketId}:`)) this.localWindows.delete(key);
    }
  }
}
