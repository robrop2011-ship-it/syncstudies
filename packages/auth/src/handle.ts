/**
 * Username rules (PLAN.md Amendment A1).
 *
 * The handle is the only identifier a user has, so it is both their login and
 * their public name in participant lists. That makes reserved words and
 * impersonation-adjacent names worth blocking up front.
 */
import { HANDLE_MIN, HANDLE_MAX } from '@syncstudy/shared';

const RESERVED = new Set([
  'admin', 'administrator', 'root', 'system', 'support', 'help', 'staff', 'mod',
  'moderator', 'syncstudy', 'sync', 'study', 'official', 'security', 'abuse',
  'api', 'www', 'app', 'me', 'you', 'settings', 'login', 'logout', 'signup',
  'signin', 'register', 'dashboard', 'room', 'rooms', 'join', 'new', 'null',
  'undefined', 'anonymous', 'guest', 'deleted', 'host', 'everyone', 'here', 'all',
]);

export interface HandleCheck {
  ok: boolean;
  reason?: 'too_short' | 'too_long' | 'invalid_chars' | 'reserved' | 'edge_underscore';
  message?: string;
}

export function checkHandle(raw: string): HandleCheck {
  const handle = raw.trim().toLowerCase();
  if (handle.length < HANDLE_MIN) {
    return { ok: false, reason: 'too_short', message: `At least ${HANDLE_MIN} characters.` };
  }
  if (handle.length > HANDLE_MAX) {
    return { ok: false, reason: 'too_long', message: `At most ${HANDLE_MAX} characters.` };
  }
  if (!/^[a-z0-9_]+$/.test(handle)) {
    return {
      ok: false,
      reason: 'invalid_chars',
      message: 'Letters, numbers and underscores only.',
    };
  }
  if (handle.startsWith('_') || handle.endsWith('_')) {
    return {
      ok: false,
      reason: 'edge_underscore',
      message: "Can't start or end with an underscore.",
    };
  }
  // Compare with separators removed so `a_d_m_i_n` doesn't slip through.
  if (RESERVED.has(handle) || RESERVED.has(handle.replace(/_/g, ''))) {
    return { ok: false, reason: 'reserved', message: 'That username is not available.' };
  }
  return { ok: true };
}

export function normalizeHandle(raw: string): string {
  return raw.trim().toLowerCase();
}
