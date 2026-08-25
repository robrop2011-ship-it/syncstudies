/**
 * TURN credential minting (PLAN.md §9.3).
 *
 * The property that matters most is the negative one: with no `TURN_SECRET`,
 * nothing that looks like a credential may leave the process. A deployment that
 * ships a static username/password to the browser has given away its relay.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TURN_CREDENTIAL_TTL_SEC } from '@syncstudy/shared';
import { hasTurn, mintIceServers } from '../rtc/turn.js';
import { isPolite } from '../handlers/rtc.js';

const NOW = 1_700_000_000_000;
const STUN = ['stun:stun.example.org:3478'];

describe('mintIceServers', () => {
  it('ships STUN only when no TURN secret is configured', () => {
    const grant = mintIceServers({ STUN_URLS: STUN }, 'user-1', NOW);
    expect(grant.iceServers).toEqual([{ urls: STUN }]);
    expect(grant.iceServers.some((s) => s.credential !== undefined)).toBe(false);
  });

  it('ships STUN only when a secret exists but no TURN url does', () => {
    const grant = mintIceServers({ STUN_URLS: STUN, TURN_SECRET: 's3cret' }, 'user-1', NOW);
    expect(grant.iceServers).toHaveLength(1);
    expect(grant.iceServers[0]?.credential).toBeUndefined();
  });

  it('mints `<expiry>:<userId>` with an HMAC-SHA1 credential', () => {
    const secret = 'static-auth-secret';
    const urls = ['turn:turn.example.org:3478?transport=udp'];
    const grant = mintIceServers({ STUN_URLS: STUN, TURN_SECRET: secret, TURN_URLS: urls }, 'user-1', NOW);

    const turn = grant.iceServers[1];
    const expiry = Math.floor(NOW / 1000) + TURN_CREDENTIAL_TTL_SEC;
    expect(turn?.username).toBe(`${expiry}:user-1`);
    expect(turn?.credential).toBe(
      createHmac('sha1', secret).update(`${expiry}:user-1`).digest('base64'),
    );
    expect(turn?.urls).toEqual(urls);
  });

  it('gives two users different credentials at the same instant', () => {
    const config = { STUN_URLS: STUN, TURN_SECRET: 'k', TURN_URLS: ['turn:t:3478'] };
    const a = mintIceServers(config, 'user-a', NOW).iceServers[1];
    const b = mintIceServers(config, 'user-b', NOW).iceServers[1];
    expect(a?.credential).not.toBe(b?.credential);
  });

  it('expires: the username carries the deadline coturn checks', () => {
    const config = { STUN_URLS: STUN, TURN_SECRET: 'k', TURN_URLS: ['turn:t:3478'] };
    const early = mintIceServers(config, 'u', NOW).iceServers[1]?.username ?? '';
    const later = mintIceServers(config, 'u', NOW + 60_000).iceServers[1]?.username ?? '';
    expect(Number(later.split(':')[0])).toBe(Number(early.split(':')[0]) + 60);
  });

  it('reports whether this deployment can actually relay', () => {
    expect(hasTurn({ STUN_URLS: STUN })).toBe(false);
    expect(hasTurn({ STUN_URLS: STUN, TURN_SECRET: 'k' })).toBe(false);
    expect(hasTurn({ STUN_URLS: STUN, TURN_SECRET: 'k', TURN_URLS: ['turn:t'] })).toBe(true);
  });
});

describe('isPolite (§9.2)', () => {
  it('makes the lexicographically smaller id polite', () => {
    expect(isPolite('aaa', 'bbb')).toBe(true);
    expect(isPolite('bbb', 'aaa')).toBe(false);
  });

  it('is antisymmetric, so exactly one side of every pair offers', () => {
    const ids = ['01a0', '01b0', 'ff00', '0000'];
    for (const a of ids) {
      for (const b of ids) {
        if (a === b) continue;
        expect(isPolite(a, b)).toBe(!isPolite(b, a));
      }
    }
  });
});
