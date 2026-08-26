import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  REALTIME_TICKET_TTL_MS,
  generateRealtimeTicket,
  realtimeTicketKey,
} from '../realtime-ticket';

describe('generateRealtimeTicket', () => {
  it('is url-safe, so it survives a JSON payload and a Redis key intact', () => {
    expect(generateRealtimeTicket()).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('carries 32 bytes of entropy, the same as a session token', () => {
    // 32 bytes base64url-encodes to 43 characters with no padding.
    expect(generateRealtimeTicket()).toHaveLength(43);
  });

  it('never repeats', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateRealtimeTicket()));
    expect(seen.size).toBe(500);
  });
});

describe('realtimeTicketKey', () => {
  it('stores the HASH, never the ticket itself', () => {
    // The property that matters: a dump of Redis must not yield usable tickets.
    const ticket = generateRealtimeTicket();
    const key = realtimeTicketKey(ticket);

    expect(key).not.toContain(ticket);
    expect(key).toBe(`rt:ticket:${createHash('sha256').update(ticket).digest('hex')}`);
  });

  it('is stable, or the web app would write a key the socket never reads', () => {
    const ticket = generateRealtimeTicket();

    expect(realtimeTicketKey(ticket)).toBe(realtimeTicketKey(ticket));
  });

  it('separates distinct tickets', () => {
    expect(realtimeTicketKey('a')).not.toBe(realtimeTicketKey('b'));
  });
});

describe('REALTIME_TICKET_TTL_MS', () => {
  it('outlives a slow page load but not an idle tab', () => {
    expect(REALTIME_TICKET_TTL_MS).toBeGreaterThanOrEqual(30_000);
    expect(REALTIME_TICKET_TTL_MS).toBeLessThanOrEqual(5 * 60_000);
  });
});
