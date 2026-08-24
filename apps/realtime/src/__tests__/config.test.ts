/**
 * Boot-time config validation.
 *
 * The point is not that invalid config is rejected — Zod does that. The point is
 * that the rejection MESSAGE names the variable and says what is wrong, because
 * the person reading it is looking at a failed deploy and has no other clue.
 */
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';

const VALID = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/syncstudy',
  REDIS_URL: 'redis://localhost:6379',
  ALLOWED_ORIGINS: 'http://localhost:3000',
  IP_HASH_SALT: '0123456789abcdef0123456789abcdef',
} satisfies NodeJS.ProcessEnv;

describe('parseConfig()', () => {
  it('accepts a minimal valid environment and fills in the defaults', () => {
    const result = parseConfig({ ...VALID });
    expect(result.ok).toBe(true);
    expect(result.config?.PORT).toBe(4000);
    expect(result.config?.NODE_ENV).toBe('development');
    expect(result.config?.LOG_LEVEL).toBe('info');
    expect(result.config?.NODE_ID).toBeTruthy();
    expect(result.config?.isProduction).toBe(false);
  });

  it('rejects a missing required variable with a message that names it', () => {
    const { DATABASE_URL: _omitted, ...withoutDatabase } = VALID;
    const result = parseConfig(withoutDatabase);

    expect(result.ok).toBe(false);
    expect(result.config).toBeUndefined();
    expect(result.error).toContain('DATABASE_URL');
    expect(result.error).toContain('Invalid environment for @syncstudy/realtime');
    // A reader must be told where to find the full list.
    expect(result.error).toContain('.env.example');
  });

  it('names every missing variable at once, not just the first', () => {
    const result = parseConfig({});
    for (const name of ['DATABASE_URL', 'REDIS_URL', 'ALLOWED_ORIGINS', 'IP_HASH_SALT']) {
      expect(result.error, name).toContain(name);
    }
  });

  it('refuses a salt short enough to be brute-forced', () => {
    const result = parseConfig({ ...VALID, IP_HASH_SALT: 'short' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('IP_HASH_SALT');
    expect(result.error).toContain('at least 16');
  });

  it('refuses an empty origin allowlist', () => {
    // An empty list would make the §11.4 origin check pass vacuously in some
    // implementations; here it must simply refuse to boot.
    const result = parseConfig({ ...VALID, ALLOWED_ORIGINS: '' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ALLOWED_ORIGINS');
  });

  it('splits csv variables and trims the entries', () => {
    const result = parseConfig({
      ...VALID,
      ALLOWED_ORIGINS: 'https://syncstudy.app, https://www.syncstudy.app ',
    });
    expect(result.config?.ALLOWED_ORIGINS).toEqual([
      'https://syncstudy.app',
      'https://www.syncstudy.app',
    ]);
  });

  it('coerces PORT and rejects a nonsense one', () => {
    expect(parseConfig({ ...VALID, PORT: '8080' }).config?.PORT).toBe(8080);
    const bad = parseConfig({ ...VALID, PORT: 'not-a-port' });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('PORT');
  });

  it('treats TURN config as optional', () => {
    const withoutTurn = parseConfig({ ...VALID });
    expect(withoutTurn.ok).toBe(true);
    expect(withoutTurn.config?.TURN_SECRET).toBeUndefined();

    const withTurn = parseConfig({
      ...VALID,
      TURN_SECRET: 'secret',
      TURN_URLS: 'turn:a:3478,turns:b:5349',
    });
    expect(withTurn.config?.TURN_URLS).toEqual(['turn:a:3478', 'turns:b:5349']);
  });

  it('marks production so callers do not re-derive it', () => {
    expect(parseConfig({ ...VALID, NODE_ENV: 'production' }).config?.isProduction).toBe(true);
  });
});
