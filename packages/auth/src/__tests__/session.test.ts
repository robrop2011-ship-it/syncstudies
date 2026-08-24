/**
 * Session helpers (PLAN.md §11.1, §11.4).
 *
 * `parseCookieHeader` is the load-bearing one: the Socket.IO handshake hands it a
 * raw `Cookie:` header with no framework helpers available, and everything about
 * whether a socket is authenticated starts with what this function returns.
 *
 * session.ts imports the Prisma client at module scope, so `@syncstudy/db` is
 * stubbed here. That keeps this a true unit test — it runs with no database, no
 * DATABASE_URL, and no generated client. The database-backed functions in that
 * module (createSession, validateSessionToken, revokeSession) are covered by the
 * integration suite, which is where a fake Prisma would prove nothing anyway.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  SESSION_COOKIE,
  generateSessionToken,
  hashIp,
  parseCookieHeader,
  safeEqual,
  sessionCookieOptions,
} from '../session';

// Hoisted above the import above by vitest's transform, which is what keeps the
// real PrismaClient from being constructed when this module loads.
vi.mock('@syncstudy/db', () => ({ prisma: {} }));

describe('parseCookieHeader', () => {
  it('returns an empty object when there is no header at all', () => {
    // An anonymous visitor's socket handshake carries no Cookie header. This must
    // be an empty object, not a throw and not null, because the caller indexes it.
    expect(parseCookieHeader(null)).toEqual({});
    expect(parseCookieHeader(undefined)).toEqual({});
    expect(parseCookieHeader('')).toEqual({});
    expect(parseCookieHeader('   ')).toEqual({});
  });

  it('parses a single cookie', () => {
    expect(parseCookieHeader('ss_session=abc123')).toEqual({ ss_session: 'abc123' });
  });

  it('parses several cookies and finds the session among them', () => {
    // What a real browser sends: the session token buried between analytics and
    // preference cookies.
    const header = 'theme=dark; _ga=GA1.1.123.456; ss_session=Zm9vYmFy_-123; sidebar=open';
    const parsed = parseCookieHeader(header);

    expect(parsed[SESSION_COOKIE]).toBe('Zm9vYmFy_-123');
    expect(parsed['theme']).toBe('dark');
    expect(parsed['sidebar']).toBe('open');
    expect(Object.keys(parsed)).toHaveLength(4);
  });

  it('decodes url-encoded values', () => {
    expect(parseCookieHeader('redirect=%2Fdashboard%3Ftab%3Drooms')['redirect']).toBe(
      '/dashboard?tab=rooms',
    );
    expect(parseCookieHeader('name=Priya%20S')['name']).toBe('Priya S');
    expect(parseCookieHeader('emoji=%E2%9C%93')['emoji']).toBe('✓');
  });

  it('skips a malformed segment without losing the rest', () => {
    // One junk cookie from an unrelated script must not cost the user their
    // session. A thrown parse error here logs everyone out.
    expect(parseCookieHeader('garbage; ss_session=abc')).toEqual({ ss_session: 'abc' });
    expect(parseCookieHeader('ss_session=abc; garbage')).toEqual({ ss_session: 'abc' });
    expect(parseCookieHeader(';;;')).toEqual({});
    expect(parseCookieHeader('=orphanvalue; a=1')).toEqual({ a: '1' });
    expect(parseCookieHeader('a=1;')).toEqual({ a: '1' });
  });

  it('trims the whitespace browsers put around segments', () => {
    expect(parseCookieHeader('  a = 1 ;   b =2  ')).toEqual({ a: '1', b: '2' });
  });

  it('keeps everything after the first equals sign', () => {
    // base64 tokens end in padding. Splitting on every '=' would truncate them.
    expect(parseCookieHeader('token=abc=def==')['token']).toBe('abc=def==');
    expect(parseCookieHeader('a=')['a']).toBe('');
  });

  it('lets a later duplicate win, the way a browser resolves it', () => {
    expect(parseCookieHeader('a=1; a=2')['a']).toBe('2');
  });

  it('cannot be used to pollute the object prototype', () => {
    const parsed = parseCookieHeader('__proto__=polluted; ss_session=abc');

    expect(parsed[SESSION_COOKIE]).toBe('abc');
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call({}, 'polluted')).toBe(false);
  });

});

describe('SESSION_COOKIE', () => {
  it('is the name both the web app and the socket handshake look for', () => {
    expect(SESSION_COOKIE).toBe('ss_session');
    expect(parseCookieHeader(SESSION_COOKIE + '=token')[SESSION_COOKIE]).toBe('token');
  });
});

describe('safeEqual', () => {
  it('is true for identical strings', () => {
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual('a', 'a')).toBe(true);
    expect(safeEqual('csrf-token-value', 'csrf-token-value')).toBe(true);
  });

  it('is false for same-length strings that differ', () => {
    // Differing in the last byte and in the first byte both matter: a comparison
    // that short-circuits would leak the position of the first difference.
    expect(safeEqual('abcdef', 'abcdeg')).toBe(false);
    expect(safeEqual('abcdef', 'zbcdef')).toBe(false);
  });

  it('is false, and does not throw, for different lengths', () => {
    // timingSafeEqual throws on a length mismatch. The length guard is what makes
    // this callable on unvalidated input at all.
    expect(() => safeEqual('short', 'much longer value')).not.toThrow();
    expect(safeEqual('short', 'much longer value')).toBe(false);
    expect(safeEqual('', 'a')).toBe(false);
    expect(safeEqual('a', '')).toBe(false);
  });

  it('compares bytes, not code points', () => {
    // 'é' is two bytes in UTF-8 and 'e' is one, so these differ in length.
    expect(() => safeEqual('é', 'e')).not.toThrow();
    expect(safeEqual('é', 'e')).toBe(false);
    expect(safeEqual('é', 'é')).toBe(true);
  });
});

describe('generateSessionToken', () => {
  it('is a 32-byte base64url token', () => {
    const token = generateSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('does not repeat itself', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => generateSessionToken()));
    expect(tokens.size).toBe(500);
  });
});

describe('hashIp', () => {
  const IP = '203.0.113.7';

  it('is deterministic for a given salt', () => {
    expect(hashIp(IP, 'salt-a')).toBe(hashIp(IP, 'salt-a'));
  });

  it('is a 32-character hex digest that does not contain the address', () => {
    const hashed = hashIp(IP, 'salt-a');
    expect(hashed).toMatch(/^[0-9a-f]{32}$/);
    expect(hashed).not.toContain(IP);
  });

  it('changes with the address', () => {
    expect(hashIp(IP, 'salt-a')).not.toBe(hashIp('203.0.113.8', 'salt-a'));
  });

  it('changes with the salt, which is what makes a leak unreversible', () => {
    // Without a per-environment salt, an attacker with the table can rebuild every
    // address by hashing the whole IPv4 space in an afternoon.
    expect(hashIp(IP, 'salt-a')).not.toBe(hashIp(IP, 'salt-b'));
  });

  it('handles IPv6 and the loopback forms', () => {
    expect(hashIp('::1', 'salt-a')).toMatch(/^[0-9a-f]{32}$/);
    expect(hashIp('2001:db8::1', 'salt-a')).toMatch(/^[0-9a-f]{32}$/);
    expect(hashIp('', 'salt-a')).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('sessionCookieOptions', () => {
  const expires = new Date('2026-09-22T10:00:00.000Z');

  it('is httpOnly, lax and site-wide', () => {
    const opts = sessionCookieOptions(expires, false);

    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('lax');
    expect(opts.path).toBe('/');
    expect(opts.expires).toBe(expires);
    expect(opts.secure).toBe(false);
  });

  it('honours an explicit secure flag', () => {
    expect(sessionCookieOptions(expires, true).secure).toBe(true);
  });

  it('defaults to secure in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      expect(sessionCookieOptions(expires).secure).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
