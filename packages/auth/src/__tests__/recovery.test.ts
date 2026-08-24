/**
 * One-time recovery codes (PLAN.md Amendment A1, docs/ADR/0001).
 *
 * With no email there is no reset link, so this is the only way back into an
 * account. Two properties carry the whole feature: the code must verify however
 * the user retypes it, and a database leak must not hand out accounts.
 */
import { describe, expect, it } from 'vitest';
import { normalizeRecoveryCode } from '@syncstudy/shared';
import { issueRecoveryCode, verifyRecoveryCode } from '../recovery';

describe('issueRecoveryCode', () => {
  it('produces a code that verifies against its own hash', async () => {
    const issued = await issueRecoveryCode();
    await expect(verifyRecoveryCode(issued.hash, issued.plain)).resolves.toBe(true);
  });

  it('returns the code in readable groups and stamps the issue time', async () => {
    const issued = await issueRecoveryCode();
    expect(issued.plain.split('-')).toHaveLength(6);
    for (const group of issued.plain.split('-')) {
      expect(group).toHaveLength(4);
    }
    expect(issued.issuedAt).toBeInstanceOf(Date);
    expect(Date.now() - issued.issuedAt.getTime()).toBeLessThan(20_000);
  });

  it('stores an argon2id hash, never the code itself', async () => {
    // The whole point of hashing it: a leaked `recovery_hash` column must not be a
    // list of working account resets.
    const issued = await issueRecoveryCode();
    expect(issued.hash.startsWith('$argon2id$')).toBe(true);
    expect(issued.hash).not.toContain(issued.plain);
    expect(issued.hash).not.toContain(normalizeRecoveryCode(issued.plain));
  });

  it('does not repeat itself', async () => {
    const [a, b] = await Promise.all([issueRecoveryCode(), issueRecoveryCode()]);
    expect(a.plain).not.toBe(b.plain);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe('verifyRecoveryCode — accepts however it is retyped', () => {
  it('ignores case', async () => {
    const issued = await issueRecoveryCode();
    await expect(verifyRecoveryCode(issued.hash, issued.plain.toLowerCase())).resolves.toBe(true);
  });

  it('ignores the dashes, whether kept, dropped, or swapped for spaces', async () => {
    const issued = await issueRecoveryCode();
    const bare = issued.plain.replace(/-/g, '');

    await expect(verifyRecoveryCode(issued.hash, bare)).resolves.toBe(true);
    await expect(verifyRecoveryCode(issued.hash, issued.plain.replace(/-/g, ' '))).resolves.toBe(
      true,
    );
    await expect(verifyRecoveryCode(issued.hash, issued.plain.replace(/-/g, '_'))).resolves.toBe(
      true,
    );
  });

  it('ignores surrounding whitespace from a sloppy paste', async () => {
    const issued = await issueRecoveryCode();
    await expect(verifyRecoveryCode(issued.hash, '   ' + issued.plain + '  \n')).resolves.toBe(
      true,
    );
  });

  it('accepts the fully mangled combination of all three', async () => {
    const issued = await issueRecoveryCode();
    const mangled = '  ' + issued.plain.toLowerCase().replace(/-/g, ' ') + '  ';
    await expect(verifyRecoveryCode(issued.hash, mangled)).resolves.toBe(true);
  });
});

describe('verifyRecoveryCode — rejects', () => {
  it('a wrong code', async () => {
    const issued = await issueRecoveryCode();
    const other = await issueRecoveryCode();

    await expect(verifyRecoveryCode(issued.hash, other.plain)).resolves.toBe(false);
    await expect(verifyRecoveryCode(issued.hash, '')).resolves.toBe(false);
    await expect(verifyRecoveryCode(issued.hash, 'not-a-code')).resolves.toBe(false);
  });

  it('a code that is one character off', async () => {
    const issued = await issueRecoveryCode();
    const bare = normalizeRecoveryCode(issued.plain);
    const firstChar = bare.slice(0, 1);
    const tampered = (firstChar === '2' ? '3' : '2') + bare.slice(1);

    await expect(verifyRecoveryCode(issued.hash, tampered)).resolves.toBe(false);
  });

  it('a null stored hash, without throwing', async () => {
    // This is the state of an account whose code has already been redeemed and not
    // yet reissued. It must read as "wrong code", not as a 500 that reveals the
    // account exists and is mid-recovery.
    await expect(verifyRecoveryCode(null, 'ANY-CODE-HERE')).resolves.toBe(false);
    await expect(verifyRecoveryCode('', 'ANY-CODE-HERE')).resolves.toBe(false);
  });

  it('a malformed stored hash, without throwing', async () => {
    for (const broken of ['not-a-hash', '$argon2id$', 'ANY-CODE-HERE']) {
      await expect(verifyRecoveryCode(broken, 'ANY-CODE-HERE')).resolves.toBe(false);
    }
  });
});
