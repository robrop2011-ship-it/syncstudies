/**
 * Display-name screening.
 *
 * Lives here rather than in a route handler because BOTH signup and profile
 * update must apply it — screening only on update lets a name be established at
 * signup that the update route would refuse, and it then persists.
 *
 * It sits beside `checkHandle()` for the same reason: when the §11.6 slur list
 * arrives it needs to be reachable from both checkers, and a list defined inside
 * an API route is not.
 */
import { MAX_DISPLAY_NAME } from '@syncstudy/shared';

/**
 * Control characters, bidi overrides and zero-width joiners have exactly one use
 * in a display name: making it render as somebody else's. Plain text only.
 */
export function hasInvisibleOrControl(value: string): boolean {
  for (const char of value) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp < 0x20 || cp === 0x7f) return true; // C0 controls and DEL
    if (cp >= 0x200b && cp <= 0x200f) return true; // zero-width, LTR/RTL marks
    if (cp >= 0x2028 && cp <= 0x202e) return true; // separators, bidi overrides
    if (cp >= 0x2066 && cp <= 0x2069) return true; // directional isolates
    if (cp === 0xfeff) return true; // zero-width no-break space
  }
  return false;
}

export interface DisplayNameCheck {
  ok: boolean;
  reason?: 'empty' | 'too_long' | 'invisible_chars';
  message?: string;
}

/** The one screening both signup and profile update run. */
export function checkDisplayName(raw: string): DisplayNameCheck {
  const value = raw.trim();
  if (value.length === 0) {
    return { ok: false, reason: 'empty', message: 'Pick a display name.' };
  }
  if (value.length > MAX_DISPLAY_NAME) {
    return {
      ok: false,
      reason: 'too_long',
      message: `At most ${MAX_DISPLAY_NAME} characters.`,
    };
  }
  if (hasInvisibleOrControl(value)) {
    return {
      ok: false,
      reason: 'invisible_chars',
      message: 'Use plain characters in your display name.',
    };
  }
  return { ok: true };
}
