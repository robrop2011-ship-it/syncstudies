/**
 * A person's ink colour.
 *
 * The room already answers "which of you is this?" with the avatar fallback
 * tint, so ink answers it the same way: the SAME FNV-1a hash over the SAME key
 * (the handle) into the SAME five buckets as `hashHandle` in
 * `components/ui/avatar.tsx`. Somebody whose avatar is the green tint draws in
 * green. Two hashes would put a person in two different buckets and the room
 * would stop reading as one system.
 *
 * (It is a deliberate copy rather than a shared import. `avatar.tsx` is a
 * render-anywhere component with no client directive, and pulling a helper out
 * of it is a refactor of a file this feature has no other reason to touch.)
 *
 * **The values are fixed hex, not `var(--accent)`.** Two reasons. A canvas takes
 * a colour string and cannot resolve a custom property, and — the real one — the
 * surface underneath is a lecture video, which is dark whatever theme the app is
 * in. So each bucket takes the DARK-theme value of the corresponding avatar
 * tint's FOREGROUND colour: the five values already tuned to be read against
 * #131211. No new hues, and nothing that vanishes when someone switches to the
 * light theme around a dark video.
 */

/**
 * Bucket order matches `SIZE_CLASS`/`ss-avatar-N` in globals.css:
 * text-secondary, text-primary, accent, success, warning. Red stays absent, as
 * it is for avatars — a stroke on a lecture should never read as an error.
 */
const INK_PALETTE = ['#a8a29e', '#f5f5f4', '#8b83e6', '#47cd89', '#f79009'] as const;

export const INK_PALETTE_SIZE = INK_PALETTE.length;

/**
 * FNV-1a, identical to the avatar's. Spreads short handles like `sam` and
 * `sammy` into different buckets instead of adjacent ones.
 */
function hashKey(key: string): number {
  let h = 0x811c9dc5;
  const lower = key.toLowerCase();
  for (let i = 0; i < lower.length; i += 1) {
    h ^= lower.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return Math.abs(h);
}

/**
 * `key` is the participant's handle wherever one is known, and their user id
 * otherwise (the couple of hundred milliseconds before presence lands). Both are
 * stable for the length of a session, which is all the determinism ink needs.
 */
export function inkColorFor(key: string): string {
  return INK_PALETTE[hashKey(key) % INK_PALETTE_SIZE] ?? INK_PALETTE[0];
}
