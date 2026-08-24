/**
 * Turning whatever a student actually pastes into a room code.
 *
 * `normalizeRoomCode` from @syncstudy/shared handles the typed form — spacing,
 * dashes, case. It deliberately does not handle a URL, because on the server a
 * "code" that arrives with a slash in it is a bug, not a convenience.
 *
 * On the client it is the common case: people paste the whole invite link. So
 * this is the one place that pulls a code out of a link, and everything
 * downstream still goes through `normalizeRoomCode`, which rejects any character
 * outside the 30-symbol alphabet (§3.2 R2 — a misread `0` or `I` is not a code
 * and must never be "repaired" into somebody else's room).
 */
import { normalizeRoomCode } from '@syncstudy/shared';

export function extractRoomCode(input: string): string | null {
  const raw = input.trim();
  if (raw.length === 0) return null;

  const direct = normalizeRoomCode(raw);
  if (direct !== null) return direct;

  // `https://syncstudy.app/r/K3M7-QP2X?utm=…` and every scrappy variant of it.
  const fromPath = /\/r\/([^/?#\s]+)/i.exec(raw);
  const segment = fromPath?.[1];
  if (segment !== undefined) return normalizeRoomCode(safeDecode(segment));

  // Last resort: the final path-ish token, which covers a bare `syncstudy.app/K3M7QP2X`.
  const tail = raw.split(/[/?#\s]+/).filter((part) => part.length > 0).pop();
  return tail === undefined ? null : normalizeRoomCode(safeDecode(tail));
}

/** A stray `%` in pasted text throws in `decodeURIComponent`; that is not fatal here. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
