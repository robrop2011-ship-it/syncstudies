'use client';

/**
 * Draw mode: the switch itself, the toolbar it puts on the stage, and the
 * one-time line that explains what ink is (PLAN.md §12.1, §12.4).
 *
 * **Why the switch is a module-level store rather than React state.** Three
 * things have to agree about it and no two of them share a parent below
 * `RoomShell`: the pencil in `PlayerControls`, the canvas in `VideoStage`, and
 * the `D` key. Lifting the boolean into the shell would re-render the entire
 * video column — player wrapper, control bar, scrubber — every time somebody
 * picks the pencil up or puts it down, for a value neither of those components
 * derives anything else from. `ShortcutSheet` reaches across the same gap with a
 * window event for the same reason.
 *
 * A module outlives the room, so `VideoStage` hands the switch back on unmount;
 * without that, walking from /r/AAAA to /r/BBBB arrives with the pencil down.
 *
 * **No colour picker and no brush sizes.** Ink is a laser pointer: colour is
 * assigned per person so the room can tell two hands apart, and a stroke is gone
 * in four seconds. Anything else on this toolbar is a setting nobody will ever
 * open twice.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Eraser, X, type LucideIcon } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useInk } from '@/lib/ink/provider';
import { cn } from '@/lib/utils';

// ── the switch ──────────────────────────────────────────────────────────────

let drawMode = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setDrawMode(next: boolean): void {
  if (drawMode === next) return;
  drawMode = next;
  for (const listener of listeners) listener();
}

export function useDrawMode(): boolean {
  // The server snapshot is `false` and cannot be anything else: draw mode is a
  // gesture this browser made, and rendering it during the server pass would be
  // a hydration mismatch on the most-looked-at page in the product.
  return useSyncExternalStore(
    subscribe,
    () => drawMode,
    () => false,
  );
}

// ── the first-run line ──────────────────────────────────────────────────────

/**
 * Same mechanism as `Onboarding`: a per-browser flag, every access guarded,
 * and "show nothing" as the failure mode. A second coach-mark system with its
 * own storage conventions is how one of them quietly stops working.
 */
const HINT_KEY = 'syncstudy:ink-explained';

function hintAlreadySeen(): boolean {
  try {
    return window.localStorage.getItem(HINT_KEY) === '1';
  } catch {
    // Storage blocked. Never showing the line is much better than showing it
    // on every single stroke somebody starts.
    return true;
  }
}

function markHintSeen(): void {
  try {
    window.localStorage.setItem(HINT_KEY, '1');
  } catch {
    // It will be offered again next time, which is acceptable.
  }
}

// ── the toolbar ─────────────────────────────────────────────────────────────

export function InkToolbar({ drawing }: { drawing: boolean }) {
  const ink = useInk();
  const [hintVisible, setHintVisible] = useState(false);
  /** Whether the line is currently on screen, for the effect that retires it. */
  const showingRef = useRef(false);

  useEffect(() => {
    if (drawing) {
      if (showingRef.current || hintAlreadySeen()) return;
      showingRef.current = true;
      setHintVisible(true);
      return;
    }
    // Draw mode just ended. They have now watched their own ink appear and fade,
    // which is the entire content of the sentence, so it has done its job.
    if (!showingRef.current) return;
    showingRef.current = false;
    setHintVisible(false);
    markHintSeen();
  }, [drawing]);

  // Escape leaves draw mode, the way it leaves everything else in the room. The
  // guard is `ShortcutSheet`'s: an open dialog or menu owns Escape until it
  // closes, and closing one should not also put the pencil down.
  useEffect(() => {
    if (!drawing) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest('[role="menu"],[role="dialog"]') !== null
      ) {
        return;
      }
      setDrawMode(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [drawing]);

  if (!drawing) return null;

  const dismissHint = (): void => {
    showingRef.current = false;
    setHintVisible(false);
    markHintSeen();
  };

  return (
    // Top right, clear of the rejected-control pill at top left, and transparent
    // to the pointer except where there is actually a control — the rest of this
    // corner is stage, and the stage is what people are drawing on.
    <div className="pointer-events-none absolute right-3 top-3 z-10 flex flex-col items-end gap-1.5">
      <div className="pointer-events-auto flex items-center gap-1 rounded-md border border-border bg-bg/95 p-1">
        <ToolButton
          icon={Eraser}
          label="Clear my ink"
          hint={ink === null ? 'Clear my ink — drawing is still starting up' : 'Clear my ink'}
          disabled={ink === null}
          onClick={() => {
            ink?.clearMine();
          }}
        />
        <ToolButton
          icon={X}
          label="Stop drawing"
          hint="Stop drawing · D"
          disabled={false}
          onClick={() => setDrawMode(false)}
        />
      </div>

      {hintVisible ? (
        // `role="status"` for the same reason the rejected-control pill has one:
        // it appears without focus moving, so without it the one sentence that
        // explains the mode is visible only to people who can see it.
        <p
          role="status"
          className="pointer-events-auto flex max-w-[17rem] animate-fade-in items-start gap-1.5 rounded-md border border-border bg-bg/95 px-2 py-1 text-13 leading-5 text-secondary"
        >
          Everyone sees what you draw, and every stroke fades away after a few seconds.
          <button
            type="button"
            aria-label="Dismiss"
            onClick={dismissHint}
            className={cn(
              '-mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-tertiary',
              'transition-colors duration-120 ease-standard hover:bg-surface-2 hover:text-secondary',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            )}
          >
            <X size={14} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </p>
      ) : null}
    </div>
  );
}

/**
 * An icon-only button over the video, with both halves of the §12.6 contract.
 * 44px on touch, 32px from `lg` up where a pointer makes that plenty — the same
 * split the control bar uses.
 */
function ToolButton({
  icon: Icon,
  label,
  hint,
  disabled,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  hint: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <button
            type="button"
            aria-label={disabled ? hint : label}
            disabled={disabled}
            onClick={onClick}
            className={cn(
              'inline-flex h-11 w-11 items-center justify-center rounded-sm lg:h-8 lg:w-8',
              'transition-colors duration-120 ease-standard',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              disabled
                ? 'text-tertiary opacity-50'
                : 'text-secondary hover:bg-surface-2 hover:text-primary',
            )}
          >
            <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}
