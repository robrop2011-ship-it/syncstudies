/**
 * The shape of shared ink (PLAN.md §3, §12).
 *
 * Two invariants are encoded here rather than enforced anywhere else, so read
 * them before adding a field:
 *
 *  1. **A point is 0..1, never a pixel.** `x` and `y` are fractions of the video
 *     stage's own box. Every participant's window is a different size, so a
 *     coordinate in pixels means "somewhere else on the lecture" to everyone but
 *     the sender — which is worse than having no feature at all. The stage is the
 *     only surface that is the same shape for everybody (16:9 at every
 *     breakpoint); `components/room/InkOverlay.tsx` is where that is converted.
 *  2. **`bornServerMs` is SERVER time.** A stroke dies `INK_LIFETIME_MS` after
 *     it, so the whole room must be reading the same number. Local wall clocks
 *     disagree by seconds, and a stroke that lingers on one screen after it left
 *     everyone else's turns "look at THIS" into a question about what "this" was.
 *
 * Nothing in here is ever persisted. There is no Postgres row, no Redis key and
 * no snapshot field for ink: it lives in memory on the clients that were
 * watching, and then it is gone.
 */

export interface InkPoint {
  x: number;
  y: number;
}

export interface InkStroke {
  /** Unique per author, minted by the client that drew it. */
  id: string;
  userId: string;
  /** Resolved once, at creation — see lib/ink/colors.ts. */
  color: string;
  points: InkPoint[];
  /**
   * When this stroke last had life, in server time.
   *
   * Set from the server's stamp on first sight and then kept moving for as long
   * as the stroke is still growing, so the countdown measures "a few seconds
   * since it was drawn" rather than "a few seconds since it was started". A
   * stroke that took six seconds to draw would otherwise die under the pointer
   * that was still drawing it.
   */
  /**
   * When this stroke's fade countdown currently starts. Refreshed while the
   * stroke is still growing, so a long drag does not fade under the pointer.
   */
  bornServerMs: number;
  /**
   * When the stroke was first seen. Never moves, so it can bound how long
   * `bornServerMs` is allowed to keep being pushed forward.
   */
  firstSeenServerMs: number;
  done: boolean;
}

/**
 * The only part of `ServerClock` the ink engine needs (§8.3).
 *
 * `ServerClock` satisfies this structurally — a widening, not a second
 * implementation — so a test can inject a clock with a deliberately wrong offset
 * without standing up a socket.
 */
export interface InkClock {
  now(): number;
  readonly isReady: boolean;
}
