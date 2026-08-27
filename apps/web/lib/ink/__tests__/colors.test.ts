/**
 * Ink colour.
 *
 * The one thing worth pinning here is the tie to the avatar. `inkColorFor` and
 * `hashHandle` in `components/ui/avatar.tsx` are deliberately the same function
 * over the same key, so that somebody's ink lands in the same bucket as their
 * avatar tint. That is exactly the kind of agreement that gets broken by a
 * well-meaning "tidy up" of either copy, so the avatar's hash is reproduced
 * below and the two are asserted to agree.
 */
import { describe, expect, it } from 'vitest';
import { inkColorFor, INK_PALETTE_SIZE } from '@/lib/ink/colors';

/** Verbatim from `hashHandle` in components/ui/avatar.tsx. */
function avatarTint(handle: string): number {
  let h = 0x811c9dc5;
  const key = handle.toLowerCase();
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return Math.abs(h) % 5;
}

const HANDLES = ['priya', 'sam', 'sammy', 'jo', 'alex', 'kwame', 'yuki', 'noor', 'ellis'];

describe('inkColorFor', () => {
  it('gives the same person the same colour every time', () => {
    for (const handle of HANDLES) {
      expect(inkColorFor(handle)).toBe(inkColorFor(handle));
    }
  });

  it('ignores case, the way the avatar does', () => {
    expect(inkColorFor('Priya')).toBe(inkColorFor('priya'));
  });

  it('lands in the same bucket as the avatar tint', () => {
    // Not a colour comparison — the avatar tint is a background token and ink is
    // a foreground one. What has to match is WHICH of the five a person gets.
    const palette = HANDLES.map((handle) => inkColorFor(handle));
    const distinct = [...new Set(palette)];
    for (const handle of HANDLES) {
      const byAvatar = HANDLES.filter((other) => avatarTint(other) === avatarTint(handle));
      const byInk = HANDLES.filter((other) => inkColorFor(other) === inkColorFor(handle));
      expect(byInk).toEqual(byAvatar);
    }
    // Nine handles across five buckets: the assertion above would pass vacuously
    // if everything collapsed into one colour.
    expect(distinct.length).toBeGreaterThan(1);
  });

  it('separates handles that differ only by a suffix', () => {
    // The reason the avatar uses FNV-1a rather than a `charCodeAt` sum: `sam`
    // and `sammy` sitting in adjacent buckets is how two people in the same
    // study group end up indistinguishable.
    expect(inkColorFor('sam')).not.toBe(inkColorFor('sammy'));
  });

  it('always returns a colour from the palette', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) seen.add(inkColorFor(`user-${i}`));
    expect(seen.size).toBe(INK_PALETTE_SIZE);
    for (const color of seen) expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });
});
