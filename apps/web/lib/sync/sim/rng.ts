/**
 * Deterministic randomness for the sync simulator (PLAN.md §15.3).
 *
 * The simulator's entire value is that "the same seed and script produce
 * identical results", so `Math.random()` is banned everywhere under `sim/`.
 * mulberry32 is used because it is four lines, has no state beyond a uint32, and
 * is bit-identical on every JavaScript engine — which matters when a failing run
 * has to be reproduced from a seed printed in CI output.
 *
 * Streams are keyed by (seed, label) rather than being drawn from one global
 * generator. That is not tidiness: with one generator, adding a seventh client
 * would shift every draw the other six make, so an unrelated change to the
 * scenario would silently re-roll the jitter and packet loss of the clients you
 * were not touching. Per-link streams keep each client's network reproducible in
 * isolation.
 */

export type Rng = () => number;

/** github.com/bryc/code — mulberry32, a 32-bit state PRNG with good equidistribution. */
export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a. Turns a stream label into a seed offset without collisions we care about. */
export function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** An independent stream. Same (seed, label) always yields the same sequence. */
export function stream(seed: number, label: string): Rng {
  return mulberry32((seed ^ hashString(label)) >>> 0);
}

/** Uniform in [-spread, +spread]. */
export function symmetric(rng: Rng, spread: number): number {
  return (rng() * 2 - 1) * spread;
}

/** True with probability `percent`/100. */
export function chance(rng: Rng, percent: number): boolean {
  if (percent <= 0) return false;
  return rng() * 100 < percent;
}
