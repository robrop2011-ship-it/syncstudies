/**
 * HTTP-tier rate limiting for the web app (PLAN.md §11.7).
 *
 * ── Why this is in-process, and what has to change before real traffic ──
 * §11.7 specifies Redis token buckets (`INCR` + `PEXPIRE` in one Lua script)
 * shared by every node. The realtime service owns that Redis connection; the web
 * tier does not have one yet, and adding a second Redis client to Next.js before
 * Phase 3 buys a dependency and no safety. So the buckets live in this process.
 *
 * The consequence, stated plainly so nobody is surprised in production: with N
 * web instances an attacker gets N × the limit, and a deploy resets every bucket.
 * That is acceptable for launch (Cloudflare is the outer backstop for `/api/auth/*`
 * per §11.7) and unacceptable at scale.
 *
 * TO MOVE THIS TO REDIS: keep `consume()`'s signature, replace its body with the
 * Lua script from §11.7 against the same Redis the realtime service uses, and
 * keep the fail-closed branch below — it is the part that matters.
 *
 * Fail-closed for auth: if we cannot identify the caller (no forwarded IP in
 * production, or a limiter error), auth routes REFUSE. A login outage is
 * survivable; an unmetered credential-stuffing surface is not.
 */
import type { NextResponse } from 'next/server';
import { fail } from '@/lib/server/respond';

export interface RateLimitPolicy {
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
  /**
   * What to do when the caller cannot be identified or the limiter itself fails.
   * true → refuse (auth routes). false → allow (chat-shaped routes, §11.7).
   */
  failClosed: boolean;
  /** Shown to the user when the bucket is empty. */
  message: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const RATE_LIMITS = {
  'auth:signup:ip': {
    limit: 5,
    windowMs: HOUR,
    failClosed: true,
    message: 'Too many accounts created from this connection. Try again in an hour.',
  },
  'auth:login:ip': {
    limit: 10,
    windowMs: 15 * MINUTE,
    failClosed: true,
    message: 'Too many sign-in attempts. Try again in a few minutes.',
  },
  'auth:login:handle': {
    limit: 5,
    windowMs: 15 * MINUTE,
    failClosed: true,
    message: 'Too many sign-in attempts for that username. Try again in a few minutes.',
  },
  'auth:recover:ip': {
    limit: 5,
    windowMs: HOUR,
    failClosed: true,
    message: 'Too many recovery attempts. Try again in an hour.',
  },
  'auth:recover:handle': {
    limit: 3,
    windowMs: HOUR,
    failClosed: true,
    message: 'Too many recovery attempts for that username. Try again in an hour.',
  },
  'auth:handle-available:ip': {
    limit: 30,
    windowMs: MINUTE,
    failClosed: true,
    message: 'Slow down a moment.',
  },
  'auth:password-change:user': {
    limit: 5,
    windowMs: HOUR,
    failClosed: true,
    message: 'Too many password changes. Try again in an hour.',
  },
  'auth:recovery-code:user': {
    limit: 5,
    windowMs: HOUR,
    failClosed: true,
    message: 'Too many recovery codes issued. Try again in an hour.',
  },
  'me:update:user': {
    limit: 30,
    windowMs: 5 * MINUTE,
    failClosed: false,
    message: 'Too many changes at once. Try again shortly.',
  },
  'me:export:user': {
    limit: 3,
    windowMs: HOUR,
    failClosed: false,
    message: 'You can export your data three times an hour.',
  },
  // §10.1: 10 reports/day/user. Fails closed — an unidentifiable reporter is
  // not a reporter, and this table is a moderation queue a human has to read.
  'reports:create:user': {
    limit: 10,
    windowMs: DAY,
    failClosed: true,
    message: 'You have filed a lot of reports today. Try again tomorrow.',
  },
  /**
   * "Something wrong?" (§14 Phase 10.9). Generous, because a person having a
   * genuinely bad session may legitimately send two or three in a row and being
   * told to come back tomorrow would be insulting. Bounded, because it writes a
   * row with a client-supplied payload in it.
   */
  'feedback:user': {
    limit: 20,
    windowMs: HOUR,
    failClosed: true,
    message: 'Thanks — that is plenty of feedback for now. Try again in a little while.',
  },
  'me:delete:user': {
    limit: 5,
    windowMs: HOUR,
    failClosed: true,
    message: 'Too many attempts. Try again in an hour.',
  },
} as const satisfies Record<string, RateLimitPolicy>;

export type RateScope = keyof typeof RATE_LIMITS;

interface Bucket {
  /** Fractional tokens remaining. */
  tokens: number;
  updatedMs: number;
}

interface LimiterState {
  buckets: Map<string, Bucket>;
  failures: Map<string, { count: number; updatedMs: number }>;
  lastSweepMs: number;
}

/**
 * Next.js replaces the module graph on every dev edit; without this the buckets
 * reset on each keystroke and the limits look broken while you are testing them.
 */
const globalForLimiter = globalThis as unknown as { __ssRateLimiter?: LimiterState };

const state: LimiterState = (globalForLimiter.__ssRateLimiter ??= {
  buckets: new Map(),
  failures: new Map(),
  lastSweepMs: Date.now(),
});

const SWEEP_INTERVAL_MS = 5 * MINUTE;
const FAILURE_TTL_MS = 15 * MINUTE;

function sweep(now: number): void {
  if (now - state.lastSweepMs < SWEEP_INTERVAL_MS) return;
  state.lastSweepMs = now;
  for (const [key, bucket] of state.buckets) {
    // A bucket untouched for an hour has refilled to full by definition.
    if (now - bucket.updatedMs > HOUR) state.buckets.delete(key);
  }
  for (const [key, failure] of state.failures) {
    if (now - failure.updatedMs > FAILURE_TTL_MS) state.failures.delete(key);
  }
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
  policy: RateLimitPolicy;
}

/**
 * Take one token from `(scope, identifier)`.
 *
 * `identifier` is null when the caller could not be identified — a missing
 * forwarded IP, say. That is where `failClosed` decides the outcome.
 */
export function consume(scope: RateScope, identifier: string | null): RateLimitResult {
  const policy: RateLimitPolicy = RATE_LIMITS[scope];

  if (identifier === null || identifier.length === 0) {
    return {
      allowed: !policy.failClosed,
      remaining: 0,
      retryAfterMs: policy.failClosed ? policy.windowMs : 0,
      policy,
    };
  }

  const now = Date.now();
  sweep(now);

  const key = `${scope}|${identifier}`;
  const refillPerMs = policy.limit / policy.windowMs;
  const bucket = state.buckets.get(key);

  if (bucket === undefined) {
    state.buckets.set(key, { tokens: policy.limit - 1, updatedMs: now });
    return { allowed: true, remaining: policy.limit - 1, retryAfterMs: 0, policy };
  }

  const refilled = Math.min(policy.limit, bucket.tokens + (now - bucket.updatedMs) * refillPerMs);
  bucket.updatedMs = now;

  if (refilled < 1) {
    bucket.tokens = refilled;
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: Math.ceil((1 - refilled) / refillPerMs),
      policy,
    };
  }

  bucket.tokens = refilled - 1;
  return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0, policy };
}

/**
 * The one-liner every route uses:
 *
 * ```ts
 * const limited = limitOr429('auth:login:ip', ipHash);
 * if (limited) return limited;
 * ```
 *
 * Returns null when the request may proceed, or a ready-made 429 (with
 * `Retry-After`) when it may not.
 */
export function limitOr429(scope: RateScope, identifier: string | null): NextResponse | null {
  const result = consume(scope, identifier);
  if (result.allowed) return null;

  const retryAfterSec = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
  return fail('rate_limited', result.policy.message, {
    headers: { 'retry-after': String(retryAfterSec) },
  });
}

// ── consecutive-failure tracking (§11.1: 3 s delay after 5 account failures) ──

export function recordAuthFailure(key: string): number {
  const now = Date.now();
  const existing = state.failures.get(key);
  const count = existing !== undefined && now - existing.updatedMs < FAILURE_TTL_MS ? existing.count + 1 : 1;
  state.failures.set(key, { count, updatedMs: now });
  return count;
}

export function authFailureCount(key: string): number {
  const existing = state.failures.get(key);
  if (existing === undefined) return 0;
  if (Date.now() - existing.updatedMs > FAILURE_TTL_MS) {
    state.failures.delete(key);
    return 0;
  }
  return existing.count;
}

export function clearAuthFailures(key: string): void {
  state.failures.delete(key);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
