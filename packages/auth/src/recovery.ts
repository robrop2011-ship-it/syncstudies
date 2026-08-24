/**
 * One-time account recovery codes (PLAN.md Amendment A1).
 *
 * With no email there is no reset link, so this is the only way back into an
 * account. Properties that matter:
 *  - ~117 bits of entropy, so it cannot be guessed;
 *  - stored as an argon2id hash, so a database leak doesn't hand out accounts;
 *  - shown exactly once at issuance;
 *  - single-use, and rotated on every password change or successful recovery.
 */
import { generateRecoveryCode, normalizeRecoveryCode } from '@syncstudy/shared';
import { hashPassword, verifyPassword } from './password';

export interface IssuedRecoveryCode {
  /** Show this to the user exactly once. Never log it, never store it. */
  plain: string;
  hash: string;
  issuedAt: Date;
}

export async function issueRecoveryCode(): Promise<IssuedRecoveryCode> {
  const plain = generateRecoveryCode();
  const hash = await hashPassword(normalizeRecoveryCode(plain));
  return { plain, hash, issuedAt: new Date() };
}

/**
 * Codes are compared normalised, so whether the user typed the dashes,
 * pasted with a trailing space, or used lowercase makes no difference.
 */
export async function verifyRecoveryCode(
  storedHash: string | null,
  submitted: string,
): Promise<boolean> {
  if (!storedHash) return false;
  return verifyPassword(storedHash, normalizeRecoveryCode(submitted));
}

export { generateRecoveryCode, normalizeRecoveryCode };
