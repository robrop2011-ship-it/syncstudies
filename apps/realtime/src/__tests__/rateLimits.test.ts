/**
 * The rate-limit table is a security control, and the failure mode of an
 * incomplete one is silent: a new event ships with no limit at all and nobody
 * notices until it is being used to flood a room.
 *
 * Two layers guard against that. `EVENT_NAMES` below is checked against
 * `keyof ClientToServerEvents` at COMPILE time (see `assertExhaustive`), so
 * adding an event to the shared contract without listing it here fails
 * `pnpm typecheck`. The runtime assertions then check every listed event has a
 * sane rule.
 */
import { describe, expect, it } from 'vitest';
import type { ClientToServerEvents } from '@syncstudy/shared';
import { LIMITS, SPEAKING_LIMIT, STRIKE_LIMIT, STRIKE_WINDOW_MS, COOLDOWN_MS } from '../ratelimit/tokenBucket.js';

const EVENT_NAMES = [
  'time:ping',
  'room:join',
  'room:leave',
  'room:resync',
  'video:set',
  'video:control',
  'video:buffering',
  'video:report_drift',
  'chat:send',
  'chat:delete',
  'chat:typing',
  'notes:block_focus',
  'notes:block_update',
  'notes:item_create',
  'notes:item_update',
  'notes:item_delete',
  'checklist:create',
  'checklist:toggle',
  'checklist:reorder',
  'checklist:delete',
  'presence:update',
  'rtc:join',
  'rtc:leave',
  'rtc:signal',
  'rtc:ice_refresh',
  'rtc:screenshare_claim',
  'rtc:screenshare_release',
  'host:kick',
  'host:ban',
  'host:set_role',
  'host:transfer',
  'host:force_mute',
  'host:update_policy',
  'host:end_room',
] as const;

type Listed = (typeof EVENT_NAMES)[number];
type MissingFromList = Exclude<keyof ClientToServerEvents, Listed>;
type NotAnEvent = Exclude<Listed, keyof ClientToServerEvents>;

/**
 * Compile-time exhaustiveness. If @syncstudy/shared gains an event, `never`
 * stops being `never` and this assignment stops compiling.
 */
const assertExhaustive: [MissingFromList, NotAnEvent] extends [never, never] ? true : false = true;

/**
 * Events where "Redis is down" must mean "reject", not "no limits":
 * joins, moderation, TURN credential minting, and anything destructive (§11.7).
 */
const MUST_FAIL_CLOSED: readonly Listed[] = [
  'room:join',
  'room:resync',
  'video:set',
  'video:control',
  'chat:delete',
  'notes:item_delete',
  'checklist:delete',
  'rtc:join',
  'rtc:signal',
  'rtc:ice_refresh',
  'rtc:screenshare_claim',
  'host:kick',
  'host:ban',
  'host:set_role',
  'host:transfer',
  'host:force_mute',
  'host:update_policy',
  'host:end_room',
];

/** Chat and presence stay available when Redis does not (§11.7). */
const MUST_FAIL_OPEN: readonly Listed[] = ['chat:send', 'chat:typing', 'presence:update'];

describe('LIMITS', () => {
  it('is exhaustive over ClientToServerEvents', () => {
    expect(assertExhaustive).toBe(true);
    expect(Object.keys(LIMITS).sort()).toEqual([...EVENT_NAMES].sort());
  });

  it('gives every event a positive allowance over a positive window', () => {
    for (const event of EVENT_NAMES) {
      const rule = LIMITS[event];
      expect(rule, event).toBeDefined();
      expect(rule.limit, event).toBeGreaterThan(0);
      expect(rule.windowMs, event).toBeGreaterThan(0);
    }
  });

  it('only lets a burst exceed the sustained allowance', () => {
    for (const event of EVENT_NAMES) {
      const rule = LIMITS[event];
      if (rule.burst === undefined) continue;
      expect(rule.burst, event).toBeGreaterThan(rule.limit);
    }
  });

  it('fails closed for auth-shaped events and open for chat-shaped ones', () => {
    for (const event of MUST_FAIL_CLOSED) {
      expect(LIMITS[event].failOpen, `${event} must fail closed`).toBe(false);
    }
    for (const event of MUST_FAIL_OPEN) {
      expect(LIMITS[event].failOpen, `${event} must fail open`).toBe(true);
    }
  });

  it('keeps time:ping off the Redis path', () => {
    // §8.3: the clock estimator fires eight of these on join and its accuracy
    // depends on the reply being immediate. A Redis round-trip here would show
    // up directly as clock-offset error.
    expect(LIMITS['time:ping'].scope).toBe('local');
    for (const event of EVENT_NAMES) {
      if (event === 'time:ping') continue;
      expect(LIMITS[event].scope, event).toBe('redis');
    }
  });

  it('matches the §10.2 table on the limits that were tuned deliberately', () => {
    expect(LIMITS['video:control']).toMatchObject({ limit: 8, windowMs: 10_000 });
    expect(LIMITS['chat:send']).toMatchObject({ limit: 5, windowMs: 5_000, burst: 10 });
    expect(LIMITS['rtc:signal']).toMatchObject({ limit: 120, windowMs: 10_000 });
    expect(LIMITS['host:end_room']).toMatchObject({ limit: 2, windowMs: 60_000 });
    expect(LIMITS['time:ping']).toMatchObject({ limit: 30, windowMs: 10_000 });
    expect(SPEAKING_LIMIT).toMatchObject({ limit: 4, windowMs: 1_000 });
  });

  it('disconnects on the third breach in a minute, then cools down', () => {
    expect(STRIKE_LIMIT).toBe(3);
    expect(STRIKE_WINDOW_MS).toBe(60_000);
    expect(COOLDOWN_MS).toBe(60_000);
  });
});
