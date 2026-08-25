'use client';

/**
 * Our scrubber, not YouTube's (PLAN.md §12.4, §5.4, §8.5c).
 *
 * The player runs with `controls: 0` for one reason that matters later: Phase 7
 * hangs note, question and bookmark ticks off this track, and you cannot draw on
 * somebody else's iframe. Everything else about this component follows from
 * that decision plus one hard performance rule.
 *
 * THE PERFORMANCE RULE (§5.4). The playhead moves 60 times a second. It is
 * written **directly to DOM style.transform from a single requestAnimationFrame
 * loop** and never, at any point, through React state. A `setState` here
 * re-renders the room — sidebar, participant rows, control bar — sixty times a
 * second, and on the Chromebook the plan is explicitly designed for, that shows
 * up as the video stuttering. So: one rAF loop, `transform` only (never `width`
 * or `left`, which relayout), and an early-out when nothing changed.
 *
 * SCRUBBING (§8.5c). Dragging calls `onPreview` — local only, at most once per
 * animation frame — and `onCommit` fires on pointerup. The controller decides
 * how much of that reaches the wire; the anti-seek-war rules live there, not in
 * a UI component.
 *
 * Everything the user can see is derived from two numbers read at frame time:
 * `playheadRef.current` and, while dragging, the drag target. React renders this
 * component when the *duration* or the *ticks* change, and at no other time.
 */
import { useCallback, useEffect, useRef } from 'react';
import { formatTimestamp } from '@syncstudy/shared';
import { cn } from '@/lib/utils';

/** A note, question or bookmark pinned to a moment in the video (§3.6 S3). */
export interface ScrubberTick {
  id: string;
  atSec: number;
  label: string;
  kind: 'note' | 'question' | 'bookmark';
}

/** Keyboard seek steps, fixed by §12.5. */
const ARROW_STEP_SEC = 5;
const PAGE_STEP_SEC = 10;

/** Half the handle's width, so a transform in px can centre it without a second translate. */
const HANDLE_HALF_PX = 6;
/** Half the preview bubble's minimum width; keeps it inside the track at both ends. */
const PREVIEW_HALF_PX = 22;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Read out loud by a screen reader, so it has to be a word rather than a colour. */
const TICK_NOUN: Record<ScrubberTick['kind'], string> = {
  note: 'note',
  question: 'question',
  bookmark: 'bookmark',
};

export function Scrubber({
  durationSec,
  playheadRef,
  getBuffered,
  disabled,
  onPreview,
  onCommit,
  onFrame,
  ticks,
  onTickSeek,
  className,
}: {
  /** 0 when the duration is not known yet — the track renders inert rather than lying. */
  durationSec: number;
  /** Live playhead from the sync controller. Polled here; never rendered through React. */
  playheadRef: React.RefObject<number>;
  /**
   * How much of the video is downloaded, 0–1, read once per frame. Omitted until
   * there is a player to ask, and the range is then simply not drawn — an
   * invented buffer bar is worse than no buffer bar.
   */
  getBuffered?: (() => number) | undefined;
  disabled: boolean;
  onPreview: (positionSec: number) => void;
  onCommit: (positionSec: number) => void;
  /**
   * Called from the same rAF loop when the displayed whole second changes, so the
   * time readout in the control bar costs one shared loop and zero renders.
   */
  onFrame?: ((positionSec: number) => void) | undefined;
  ticks?: readonly ScrubberTick[] | undefined;
  /** §3.6 S4: clicking a tick seeks the whole room, permission-checked upstream. */
  onTickSeek?: ((positionSec: number) => void) | undefined;
  className?: string | undefined;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const fillRef = useRef<HTMLDivElement | null>(null);
  const bufferedRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);

  /** Track width in px. Measured, because `translateX(%)` is a % of the handle. */
  const widthRef = useRef(0);
  /** Non-null while a drag is in progress; holds the drag's target position. */
  const dragSecRef = useRef<number | null>(null);
  const lastFractionRef = useRef(-1);
  const lastSecondRef = useRef(-1);
  const lastBufferedRef = useRef(-1);

  // Refs for values the loop reads, so changing them never restarts the loop.
  const durationRef = useRef(durationSec);
  durationRef.current = durationSec;
  const bufferedSourceRef = useRef(getBuffered);
  bufferedSourceRef.current = getBuffered;
  const onPreviewRef = useRef(onPreview);
  onPreviewRef.current = onPreview;
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  /** Position under the pointer, in seconds. */
  const secondsAt = useCallback((clientX: number): number => {
    const root = rootRef.current;
    const duration = durationRef.current;
    if (root === null || duration <= 0) return 0;
    const box = root.getBoundingClientRect();
    if (box.width === 0) return 0;
    return clamp((clientX - box.left) / box.width, 0, 1) * duration;
  }, []);

  // ── the one loop ──────────────────────────────────────────────────────────
  useEffect(() => {
    let frame = 0;

    const paint = (): void => {
      frame = requestAnimationFrame(paint);

      const duration = durationRef.current;
      const width = widthRef.current;
      const dragging = dragSecRef.current;
      const live = playheadRef.current;
      // A player that is still initialising can hand back NaN; painting that
      // produces `transform: scaleX(NaN)`, which silently drops the whole rule.
      const position = dragging ?? (Number.isFinite(live) ? live : 0);
      const fraction = duration > 0 ? clamp(position / duration, 0, 1) : 0;

      // The drag intent is published from here rather than from `pointermove`,
      // for two reasons: it bounds the call to one per painted frame however fast
      // the device reports pointer events (some report 240 Hz), and it keeps
      // going while the pointer is held still, which is what holds the
      // controller's scrub-preview window open. The controller decides what
      // reaches the wire — at most one seek per SCRUB_EMIT_INTERVAL_MS (§8.5c).
      if (dragging !== null) onPreviewRef.current(dragging);

      // Buffered range, when the player layer is reachable. Quantised to 1% so a
      // download that advances continuously does not rewrite the DOM every frame.
      const readBuffered = bufferedSourceRef.current;
      if (readBuffered !== undefined && bufferedRef.current !== null) {
        const buffered = Math.round(clamp(readBuffered(), 0, 1) * 100) / 100;
        if (buffered !== lastBufferedRef.current) {
          lastBufferedRef.current = buffered;
          bufferedRef.current.style.transform = `scaleX(${buffered})`;
        }
      }

      if (fraction === lastFractionRef.current) return;
      lastFractionRef.current = fraction;

      if (fillRef.current !== null) fillRef.current.style.transform = `scaleX(${fraction})`;
      if (handleRef.current !== null) {
        handleRef.current.style.transform = `translate3d(${fraction * width - HANDLE_HALF_PX}px, -50%, 0)`;
      }

      // Screen readers and the time readout care about whole seconds; updating
      // either one per frame would be sixty times more work for the same result.
      const second = Math.floor(position);
      if (second !== lastSecondRef.current) {
        lastSecondRef.current = second;
        const root = rootRef.current;
        if (root !== null && duration > 0) {
          root.setAttribute('aria-valuenow', String(second));
          root.setAttribute(
            'aria-valuetext',
            `${formatTimestamp(second)} of ${formatTimestamp(duration)}`,
          );
        }
        onFrameRef.current?.(position);
      }
    };

    frame = requestAnimationFrame(paint);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [playheadRef]);

  // A render resets the ARIA attributes the loop maintains back to their JSX
  // values, so the next frame has to be allowed to write them again even if the
  // playhead has not moved a whole second in the meantime.
  useEffect(() => {
    lastSecondRef.current = -1;
    lastFractionRef.current = -1;
  }, [durationSec, disabled]);

  // Track width, for the handle's px transform. ResizeObserver rather than a
  // resize listener: the sidebar collapsing changes this without the window moving.
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;

    const measure = (): void => {
      widthRef.current = root.getBoundingClientRect().width;
      lastFractionRef.current = -1; // force the next frame to repaint at the new width
    };
    measure();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => {
      observer.disconnect();
    };
  }, []);

  // ── pointer ───────────────────────────────────────────────────────────────
  const showPreview = useCallback((clientX: number, visible: boolean): void => {
    const bubble = previewRef.current;
    const width = widthRef.current;
    if (bubble === null) return;
    if (!visible) {
      bubble.style.opacity = '0';
      return;
    }
    const seconds = secondsAt(clientX);
    const root = rootRef.current;
    const x = root === null ? 0 : clamp(clientX - root.getBoundingClientRect().left, 0, width);
    bubble.textContent = formatTimestamp(seconds);
    bubble.style.transform = `translate3d(${clamp(x - PREVIEW_HALF_PX, 0, Math.max(0, width - PREVIEW_HALF_PX * 2))}px, 0, 0)`;
    bubble.style.opacity = '1';
  }, [secondsAt]);

  const interactive = !disabled && durationSec > 0;

  const beginDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!interactive) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragSecRef.current = secondsAt(event.clientX);
    showPreview(event.clientX, true);
  };

  const moveDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (dragSecRef.current !== null) {
      dragSecRef.current = secondsAt(event.clientX);
      showPreview(event.clientX, true);
      return;
    }
    if (interactive) showPreview(event.clientX, true);
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const target = dragSecRef.current;
    dragSecRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    // A pointer that left the element ends the hover state with the drag.
    if (event.type !== 'pointerup' || event.pointerType !== 'mouse') {
      showPreview(event.clientX, false);
    }
    if (target !== null) onCommit(target);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!interactive) return;
    const from = dragSecRef.current ?? playheadRef.current ?? 0;
    let next: number | null = null;

    switch (event.key) {
      case 'ArrowLeft':
        next = from - ARROW_STEP_SEC;
        break;
      case 'ArrowRight':
        next = from + ARROW_STEP_SEC;
        break;
      case 'PageDown':
        next = from - PAGE_STEP_SEC;
        break;
      case 'PageUp':
        next = from + PAGE_STEP_SEC;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = durationSec;
        break;
      default:
        return;
    }

    event.preventDefault();
    // The room-wide shortcuts (§12.5) bind the same keys. Stopping here keeps a
    // focused scrubber from seeking twice for one keypress.
    event.stopPropagation();
    onCommit(clamp(next, 0, durationSec));
  };

  return (
    <div className={cn('relative w-full select-none', className)}>
      {/* The bubble sits outside the track's overflow so it can hang above it. */}
      <div
        ref={previewRef}
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute bottom-full left-0 mb-1 w-11 rounded-sm border border-border',
          'bg-bg px-1 text-center text-13 tabular-nums text-primary opacity-0',
          'transition-opacity duration-120 ease-standard',
        )}
      >
        0:00
      </div>

      <div
        ref={rootRef}
        role="slider"
        aria-label="Playback position"
        aria-valuemin={0}
        aria-valuemax={durationSec > 0 ? durationSec : 0}
        aria-valuenow={0}
        aria-valuetext={durationSec > 0 ? `0:00 of ${formatTimestamp(durationSec)}` : 'Unknown'}
        aria-disabled={interactive ? undefined : true}
        tabIndex={interactive ? 0 : -1}
        onPointerDown={beginDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={(event) => {
          if (dragSecRef.current === null) showPreview(event.clientX, false);
        }}
        onKeyDown={onKeyDown}
        className={cn(
          // A 4px bar with a 28px hit area around it: comfortable for a thumb
          // without a fat rule across the bottom of the video.
          'relative flex h-7 w-full touch-none items-center rounded-sm',
          interactive ? 'cursor-pointer' : 'cursor-default opacity-60',
        )}
      >
        <div className="relative h-1 w-full overflow-hidden rounded-sm bg-surface-3">
          <div
            ref={bufferedRef}
            aria-hidden="true"
            className="absolute inset-0 origin-left bg-border-strong"
            style={{ transform: 'scaleX(0)' }}
          />
          <div
            ref={fillRef}
            aria-hidden="true"
            className="absolute inset-0 origin-left bg-primary"
            style={{ transform: 'scaleX(0)' }}
          />
        </div>

        {/* Note, question and bookmark marks (§3.6 S3, S4). Drawn from the same
            coordinate space as the handle so the two cannot disagree, and a
            real <button> so they are reachable by keyboard — a tick you can
            only hit with a mouse is a feature half the room cannot use.

            `stopPropagation` matters: the track's own pointerdown starts a
            scrub, and without it clicking a tick would seek twice, once to the
            tick and once to wherever the pointer happened to be. */}
        {durationSec > 0 && onTickSeek !== undefined
          ? (ticks ?? []).map((tick) => (
              <button
                key={tick.id}
                type="button"
                title={`${TICK_NOUN[tick.kind]} at ${formatTimestamp(tick.atSec)} — ${tick.label}`}
                aria-label={`Jump to ${TICK_NOUN[tick.kind]} at ${formatTimestamp(tick.atSec)}`}
                disabled={disabled}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onTickSeek(tick.atSec);
                }}
                className={cn(
                  'absolute top-1/2 h-2.5 w-1 -translate-y-1/2 -translate-x-1/2 rounded-sm',
                  'transition-colors duration-120 ease-standard',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                  'disabled:pointer-events-none',
                  tick.kind === 'question' ? 'bg-accent' : 'bg-secondary',
                  'hover:h-3.5 hover:bg-primary',
                )}
                style={{ left: `${clamp(tick.atSec / durationSec, 0, 1) * 100}%` }}
              />
            ))
          : null}

        {interactive ? (
          <div
            ref={handleRef}
            aria-hidden="true"
            className="pointer-events-none absolute left-0 top-1/2 h-3 w-3 rounded-full border border-bg bg-primary"
            style={{ transform: `translate3d(${-HANDLE_HALF_PX}px, -50%, 0)` }}
          />
        ) : null}
      </div>
    </div>
  );
}
