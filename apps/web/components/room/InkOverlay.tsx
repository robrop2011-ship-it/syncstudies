'use client';

/**
 * The ink canvas (PLAN.md §5.4, §12.1).
 *
 * It fills its parent, which is the video stage, and that is the whole of the
 * shared surface. A stroke leaves here as x,y in 0..1 of THIS canvas's bounding
 * rect and is painted back against the receiver's own copy of the same box, so a
 * circle drawn around a term lands on that term whatever size anyone's window
 * is. Nothing outside the stage can work that way: the sidebar, the chat and the
 * control bar are laid out differently for every participant and below `lg`
 * some of them are not on screen at all, so a coordinate over any of them means
 * nothing to anybody else. "Draw anywhere on the screen" is not this feature,
 * and turning it into that would quietly break the only thing it is for.
 *
 * Three details are load-bearing:
 *
 *  - **`pointer-events: none` unless draw mode is on.** This canvas sits over
 *    the player. A canvas that eats clicks is a play/pause button that stopped
 *    working, and it would be blamed on the player for a week.
 *  - **Pointer Events only.** No mouse/touch pair, so there is one code path for
 *    a trackpad, a finger and a stylus, and no synthetic-click double-fire to
 *    filter out. `setPointerCapture` keeps a drag that wanders off the stage
 *    delivering to us, which is what lets it finish cleanly instead of leaving
 *    the stroke unfinished on everyone else's screen. `touch-action: none` is
 *    what stops a finger drag scrolling the page instead of drawing.
 *  - **Nothing here re-renders while drawing.** Points go straight into the
 *    controller, which buffers them and paints from a `requestAnimationFrame`
 *    loop. A `setState` per pointer event would re-render the room up to 120
 *    times a second and stutter the player (§5.4).
 */
import { useEffect, useRef } from 'react';
import type * as React from 'react';
import { toPictureSpace } from '@/lib/ink/geometry';
import { clampPoint } from '@/lib/ink/controller';
import { useInk } from '@/lib/ink/provider';
import type { InkPoint } from '@/lib/ink/types';
import { cn } from '@/lib/utils';

export function InkOverlay({
  drawing,
  className,
}: {
  drawing: boolean;
  className?: string | undefined;
}): React.ReactElement {
  const ink = useInk();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** The one pointer that owns the stroke in progress; a second finger is ignored. */
  const pointerRef = useRef<number | null>(null);

  // The controller is created in an effect one level up, so it arrives on a
  // later render than this canvas does — hence the dependency rather than a
  // mount-only effect.
  useEffect(() => {
    if (ink === null) return;
    ink.attachCanvas(canvasRef.current);
    return () => {
      ink.attachCanvas(null);
    };
  }, [ink]);

  const pointAt = (event: React.PointerEvent<HTMLCanvasElement>): InkPoint | null => {
    const box = event.currentTarget.getBoundingClientRect();
    // Measured against the PICTURE inside the box, not the box. The canvas fills
    // the stage, the stage is not reliably 16:9, and the player letterboxes the
    // video inside it — so normalising against the box would put the same 0..1
    // on a different part of the lecture for anyone whose window is a different
    // shape. `toPictureSpace` is the same function the renderer uses.
    const point = toPictureSpace(event.clientX, event.clientY, box);
    if (point === null) return null;
    // Clamped, because a captured drag reports coordinates from well outside the
    // stage and a stroke must stay on the picture everyone is sharing.
    return clampPoint(point);
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!drawing || ink === null || pointerRef.current !== null) return;
    const point = pointAt(event);
    if (point === null) return;
    // Also suppresses the text-selection drag that otherwise starts here and
    // ends with half the room chrome highlighted in blue.
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerRef.current = event.pointerId;
    ink.beginStroke(point);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (ink === null || pointerRef.current !== event.pointerId) return;
    const point = pointAt(event);
    if (point === null) return;
    ink.extendStroke(point);
  };

  /** Up, cancel, or a capture taken away from us: all of them end the stroke. */
  const onPointerEnd = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (ink === null || pointerRef.current !== event.pointerId) return;
    pointerRef.current = null;
    ink.endStroke();
  };

  return (
    <div className={cn('pointer-events-none absolute inset-0', className)}>
      <canvas
        ref={canvasRef}
        // There is no accessible reading of a drawing, and the stage already has
        // a label. Draw mode's own state is announced by the button that turns
        // it on, which is where a keyboard user is.
        aria-hidden="true"
        className={cn(
          'absolute inset-0 h-full w-full touch-none select-none',
          drawing && 'pointer-events-auto cursor-crosshair',
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onLostPointerCapture={onPointerEnd}
      />

      {/* Draw mode is on. A 1px accent rule inset on the stage and a crosshair
          cursor — the same accent that marks every other active thing in the
          room, and no glow, no tint over the picture, nothing that competes with
          the lecture for attention (§12.1). */}
      {drawing ? <span aria-hidden="true" className="absolute inset-0 border border-accent" /> : null}
    </div>
  );
}
