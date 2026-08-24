/**
 * Password hashing (PLAN.md §11.1).
 *
 * argon2id at the OWASP 2024 baseline. @node-rs/argon2 is used over the pure-JS
 * implementations because hashing happens on the login hot path and the Rust
 * binding is ~10x faster, which matters when a login storm hits.
 */
import { hash, verify, type Algorithm } from '@node-rs/argon2';
import { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from '@syncstudy/shared';
import { COMMON_PASSWORDS } from './common-passwords';

/**
 * `Algorithm.Argon2id`, inlined as its numeric value.
 *
 * @node-rs/argon2 exports `Algorithm` as an ambient `declare const enum`, and
 * `isolatedModules` (which we need for the bundlers) forbids reading a member of
 * one at a value position. Importing the type and asserting the literal keeps the
 * parameter explicit without tripping TS2748.
 */
const ARGON2ID = 2 as Algorithm;

/**
 * OWASP 2024 baseline. These happen to match the library defaults, but they are
 * stated explicitly — a security parameter should never be implicit, and a
 * library default can change under us in a minor release.
 */
const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19456, // KiB
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_OPTIONS);
}

/**
 * Never throws on a malformed stored hash — a corrupted row must read as
 * "wrong password", not as a 500 that tells an attacker the account exists.
 */
export async function verifyPassword(storedHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(storedHash, plain);
  } catch {
    return false;
  }
}

export interface PasswordCheck {
  ok: boolean;
  reason?: 'too_short' | 'too_long' | 'too_common' | 'contains_handle';
  message?: string;
}

/**
 * Length plus a common-password check, and nothing else.
 *
 * Deliberately no composition rules ("must contain a symbol"): they push people
 * toward `Password1!`, which is both predictable and annoying. Length and a
 * blocklist do the actual work.
 */
export function checkPasswordStrength(plain: string, handle?: string): PasswordCheck {
  if (plain.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      reason: 'too_short',
      message: `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }
  if (plain.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, reason: 'too_long', message: 'That password is too long.' };
  }
  const normalized = plain.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (COMMON_PASSWORDS.has(plain.toLowerCase()) || COMMON_PASSWORDS.has(normalized)) {
    return {
      ok: false,
      reason: 'too_common',
      message: 'That password is too common — pick something less guessable.',
    };
  }
  if (handle && normalized.includes(handle.toLowerCase()) && handle.length >= 4) {
    return {
      ok: false,
      reason: 'contains_handle',
      message: "Don't put your username in your password.",
    };
  }
  return { ok: true };
}
