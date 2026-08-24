/**
 * Password hashing and policy (PLAN.md §11.1).
 *
 * Slow on purpose: argon2id at 19 MiB / t=2 is the point of the exercise. If this
 * file starts timing out, raise the timeout in vitest.config.ts — do not lower the
 * cost parameters.
 */
import { describe, expect, it } from 'vitest';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '@syncstudy/shared';
import { checkPasswordStrength, hashPassword, verifyPassword } from '../password';

const GOOD = 'lecture-notes-tuesday';

describe('hashPassword / verifyPassword', () => {
  it('round-trips a password', async () => {
    const stored = await hashPassword(GOOD);
    expect(stored.startsWith('$argon2id$')).toBe(true);
    await expect(verifyPassword(stored, GOOD)).resolves.toBe(true);
  });

  it('rejects the wrong password, including near misses', async () => {
    const stored = await hashPassword(GOOD);
    await expect(verifyPassword(stored, GOOD + ' ')).resolves.toBe(false);
    await expect(verifyPassword(stored, 'Lecture-notes-tuesday')).resolves.toBe(false);
    await expect(verifyPassword(stored, '')).resolves.toBe(false);
  });

  it('salts every hash, so identical passwords do not collide in the database', async () => {
    const a = await hashPassword(GOOD);
    const b = await hashPassword(GOOD);
    expect(a).not.toBe(b);
    await expect(verifyPassword(a, GOOD)).resolves.toBe(true);
    await expect(verifyPassword(b, GOOD)).resolves.toBe(true);
  });

  it('encodes the OWASP baseline parameters in the hash', async () => {
    // The parameters live in the stored string, so this is also what tells you
    // whether an old row needs rehashing after a parameter change.
    const stored = await hashPassword(GOOD);
    expect(stored).toContain('m=19456');
    expect(stored).toContain('t=2');
    expect(stored).toContain('p=1');
  });

  it('returns false rather than throwing on a malformed stored hash', async () => {
    // A corrupted or truncated row must read as "wrong password". Throwing would
    // turn it into a 500, which tells an attacker the account exists and takes the
    // login route down for that one user.
    for (const broken of [
      '',
      ' ',
      'not-a-hash',
      'plaintext-password',
      '$argon2id$',
      '$argon2id$v=19$m=19456,t=2,p=1$truncated',
      '$2b$12$abcdefghijklmnopqrstuv',
    ]) {
      await expect(verifyPassword(broken, GOOD)).resolves.toBe(false);
    }
  });
});

describe('checkPasswordStrength', () => {
  it('accepts a reasonable password', () => {
    expect(checkPasswordStrength(GOOD)).toEqual({ ok: true });
    expect(checkPasswordStrength('four purple staplers')).toEqual({ ok: true });
  });

  it('rejects anything shorter than the minimum', () => {
    const short = checkPasswordStrength('short');
    expect(short.ok).toBe(false);
    expect(short.reason).toBe('too_short');
    expect(short.message).toContain(String(MIN_PASSWORD_LENGTH));

    expect(checkPasswordStrength('a'.repeat(MIN_PASSWORD_LENGTH - 1)).reason).toBe('too_short');
    expect(checkPasswordStrength('').reason).toBe('too_short');
    // Exactly the minimum is fine.
    expect(checkPasswordStrength('lecture4pm')).toEqual({ ok: true });
  });

  it('rejects anything longer than the maximum', () => {
    // The cap is a denial-of-service guard: argon2 cost scales with input length,
    // and an unbounded field is a free CPU burner on the login route.
    expect(checkPasswordStrength('a'.repeat(MAX_PASSWORD_LENGTH + 1)).reason).toBe('too_long');
    expect(checkPasswordStrength('a'.repeat(MAX_PASSWORD_LENGTH))).toEqual({ ok: true });
  });

  it('rejects passwords from the blocklist', () => {
    for (const common of [
      'password123',
      '1234567890',
      'letmein123',
      'qwertyuiop',
      '1qaz2wsx3edc',
      'studytogether1',
      'syncstudy1',
      'studybuddy',
    ]) {
      expect(checkPasswordStrength(common).reason, common).toBe('too_common');
    }
  });

  it('sees through capitalisation and punctuation decoration', () => {
    // "Password-123" is the same guess as "password123" to anyone with a wordlist.
    expect(checkPasswordStrength('PASSWORD123').reason).toBe('too_common');
    expect(checkPasswordStrength('Password-123').reason).toBe('too_common');
    expect(checkPasswordStrength('study.together.1').reason).toBe('too_common');
  });

  it('rejects a password containing the handle', () => {
    const result = checkPasswordStrength('priya-loves-cats', 'priya');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('contains_handle');

    // Case-insensitive on both sides.
    expect(checkPasswordStrength('PRIYA-loves-cats', 'Priya').reason).toBe('contains_handle');
    expect(checkPasswordStrength('xxpriyaxxyyyy', 'priya').reason).toBe('contains_handle');
  });

  it('does not apply the handle rule to very short handles', () => {
    // A three-character handle turns up inside ordinary words constantly; the rule
    // would reject good passwords for no security gain.
    expect(checkPasswordStrength('sam-and-the-lecture', 'sam')).toEqual({ ok: true });
    expect(checkPasswordStrength('the cats are asleep', 'cat')).toEqual({ ok: true });
  });

  it('only complains when the handle is actually a substring', () => {
    expect(checkPasswordStrength('priyanka is not me', 'priyanka').reason).toBe('contains_handle');
    expect(checkPasswordStrength('lecture-notes-tuesday', 'priya')).toEqual({ ok: true });
  });

  it('reports the length problem first when a password has several', () => {
    // Ordering matters for the UI: one message at a time, and the most actionable
    // one. "Contains your username" on a five-character password is confusing
    // advice when the real problem is the length.
    expect(checkPasswordStrength('priya', 'priya').reason).toBe('too_short');
  });
});
