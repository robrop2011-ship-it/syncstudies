/**
 * The one definition of "where the picture is".
 *
 * Ink coordinates are 0..1 so a stroke lands on the same part of the lecture on
 * every participant's screen, whatever size their window is. That only holds if
 * both ends agree on WHICH rectangle the 0..1 is measured against — and the
 * obvious candidate, the stage box, is the wrong one.
 *
 * The stage box is sized by CSS and is not reliably 16:9: `aspect-ratio` on a
 * non-replaced element only computes the axis that is not already determined, so
 * a `width:100%` box with `max-height:100%` gets its height clamped without its
 * width shrinking to match. In the tablet band and on short windows the box is
 * routinely wider than 16:9. The YouTube iframe fills that box and letterboxes
 * the picture inside it, so normalising against the box means one person's 0.5
 * is the middle of the box and another's is the middle of the picture — the
 * exact failure the normalisation exists to prevent, and an invisible one,
 * because it only shows up when two people have differently shaped windows.
 *
 * So both the pointer path and the paint path measure against the centred 16:9
 * rect *inside* the box — the picture itself. Same function, both ends. If you
 * change one, you have already broken it.
 */
import type { InkPoint } from './types';

/** The player's aspect. Ink is only ever drawn over 16:9 video. */
export const INK_ASPECT = 16 / 9;

export interface ContentRect {
  /** Offset of the picture inside the box, in the box's own units. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The largest 16:9 rectangle that fits inside `boxWidth` x `boxHeight`, centred.
 *
 * Matches how the player letterboxes: pillarboxed when the box is wider than
 * 16:9, letterboxed when it is taller. Returns a zero rect for a zero box so
 * callers can bail without dividing by zero.
 */
export function inkContentRect(boxWidth: number, boxHeight: number): ContentRect {
  if (!(boxWidth > 0) || !(boxHeight > 0)) return { x: 0, y: 0, width: 0, height: 0 };
  const width = Math.min(boxWidth, boxHeight * INK_ASPECT);
  const height = Math.min(boxHeight, boxWidth / INK_ASPECT);
  return { x: (boxWidth - width) / 2, y: (boxHeight - height) / 2, width, height };
}

/**
 * A client-space pointer position → 0..1 on the picture.
 *
 * Deliberately NOT clamped here: a captured drag legitimately reports positions
 * outside the picture (that is what pointer capture is for), and the caller
 * decides whether to clamp them onto the shared surface or drop them.
 */
export function toPictureSpace(clientX: number, clientY: number, box: DOMRect): InkPoint | null {
  const rect = inkContentRect(box.width, box.height);
  if (rect.width === 0 || rect.height === 0) return null;
  return {
    x: (clientX - box.left - rect.x) / rect.width,
    y: (clientY - box.top - rect.y) / rect.height,
  };
}

/** 0..1 on the picture → pixel position within a box of the given size. */
export function toBoxPixels(
  point: InkPoint,
  boxWidth: number,
  boxHeight: number,
): { x: number; y: number } {
  const rect = inkContentRect(boxWidth, boxHeight);
  return { x: rect.x + point.x * rect.width, y: rect.y + point.y * rect.height };
}
