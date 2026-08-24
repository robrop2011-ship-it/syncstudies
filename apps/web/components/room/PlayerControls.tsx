'use client';

/**
 * The video control bar (PLAN.md §12.4, §12.5, §8.5a, §5.4).
 *
 * One row, ordered left to right by how often it is used: play/pause, ±10 s, the
 * time, volume, then the sync status. Above it, our own scrubber. Everything in
 * here states an *intent* to the `SyncController` and then waits to be told what
 * is true — no button reaches for the player directly, because the server owns
 * the timeline (§8.1 rule 1).
 *
 * Two details worth keeping:
 *
 * **The play icon is optimistic, with a deadline.** The authoritative status
 * arrives on `video:state` a round trip later, so a strictly server-derived icon
 * would sit on the old glyph for 60–150 ms after every click and feel broken.
 * The click paints the intended state immediately and the intent expires after
 * `CONTROL_ECHO_MS`, so a rejected control (§8.5) reverts on its own rather than
 * leaving a lie on screen.
 *
 * **A user without playback permission gets disabled controls and a sentence
 * naming who does have it** (§8.5a). Not hidden controls — hiding them makes the
 * room look broken — and not silently-ignored clicks.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Lock,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Volume1,
  Volume2,
  VolumeX,
  type LucideIcon,
} from 'lucide-react';
import { formatTimestamp, type PlaybackControlPolicy } from '@syncstudy/shared';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Scrubber, type ScrubberTick } from '@/components/room/Scrubber';
import { SyncStatus } from '@/components/room/SyncStatus';
import { useVideoAnchor } from '@/lib/stores/room-store';
import type { SyncController } from '@/lib/sync/controller';
import { usePlayheadRef, useSyncController, useSyncStatus } from '@/lib/sync/useSyncController';
import { cn } from '@/lib/utils';

/** Keyboard steps, fixed by §12.5. */
const ARROW_STEP_SEC = 5;
const SKIP_STEP_SEC = 10;
/** How long an optimistic play/pause icon survives without the server agreeing. */
const CONTROL_ECHO_MS = 1_200;
/** While the anchor carries no duration, ask the player for one at this cadence. */
const DURATION_POLL_MS = 1_000;

// ── permission copy (§8.5a) ─────────────────────────────────────────────────

function whoCanControl(policy: PlaybackControlPolicy, hostName: string): string {
  switch (policy) {
    case 'host_only':
      return `Only ${hostName} can control playback`;
    case 'host_and_cohosts':
      return `Only ${hostName} and the co-hosts can control playback`;
    default:
      // Reached by guests, who never get playback control whatever the policy.
      return 'Guests cannot control playback';
  }
}

// ── keyboard (§12.5) ────────────────────────────────────────────────────────
//
// Space, ←/→ and J/L are bound below. `C` (captions) is NOT, and that is a gap
// rather than an oversight: `PlayerAdapter` exposes no caption control, so there
// is nothing for the key to call. Wiring it needs `toggleCaptions()` on the
// interface in packages/shared/src/player.ts, an implementation in the YouTube
// adapter (`loadModule('captions')` + `setOption`), and one `case` here. A key
// that silently does nothing is better than a key that pretends.

/**
 * Space must type a space when someone is writing, not pause the lecture.
 *
 * The two sliders are deliberately NOT excluded. Each calls `stopPropagation()`
 * on the keys it handles — the arrows — which stops the event at React's root
 * before it reaches this listener. The keys they do not handle, `Space` above
 * all, should still work while a slider has focus: a focused scrubber that
 * cannot pause the video is a trap you have to click your way out of.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  // An open menu or dialog owns the keyboard until it closes.
  return target.closest('[role="menu"],[role="dialog"]') !== null;
}

/** Space already means "activate" on a focused button or link. */
function isActivatable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'BUTTON' || tag === 'A' || target.getAttribute('role') === 'button';
}

export function PlayerControls({
  canControl,
  playbackControl,
  hostName,
  ticks,
  className,
}: {
  canControl: boolean;
  playbackControl: PlaybackControlPolicy;
  hostName: string;
  ticks?: readonly ScrubberTick[] | undefined;
  className?: string | undefined;
}) {
  const video = useVideoAnchor();
  const status = useSyncStatus();
  const controller = useSyncController();
  const playheadRef = usePlayheadRef();

  const timeRef = useRef<HTMLSpanElement | null>(null);
  const [pending, setPending] = useState<'playing' | 'paused' | null>(null);
  const [probedDuration, setProbedDuration] = useState(0);

  const hasVideo = video.provider !== 'none' && video.videoRef !== null;
  const duration = video.durationSec ?? probedDuration;
  const enabled = canControl && hasVideo && controller !== null;

  // The optimistic icon, and its deadline.
  useEffect(() => {
    if (pending === null) return;
    if (video.status === pending) {
      setPending(null);
      return;
    }
    const timer = setTimeout(() => setPending(null), CONTROL_ECHO_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [pending, video.status]);

  // YouTube's oEmbed does not report a duration, so for most videos the anchor
  // arrives without one and the player is the only source. Polled at 1 Hz, and
  // only until it answers — a scrubber with no end is worse than one that takes
  // a second to learn where the end is.
  useEffect(() => {
    if (!hasVideo || controller === null) return;
    if (video.durationSec !== null || probedDuration > 0) return;

    const read = (): void => {
      const value = controller.getDurationSec();
      if (Number.isFinite(value) && value > 0) setProbedDuration(value);
    };
    read();
    const timer = setInterval(read, DURATION_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [hasVideo, controller, video.durationSec, probedDuration]);

  // A new video means the old duration is meaningless.
  useEffect(() => {
    setProbedDuration(0);
  }, [video.videoRef]);

  const showPlaying = pending === null ? video.status === 'playing' : pending === 'playing';

  const toggle = useCallback((): void => {
    if (!enabled || controller === null) return;
    if (video.status === 'playing') {
      setPending('paused');
      void controller.pause();
    } else {
      setPending('playing');
      void controller.play();
    }
  }, [controller, enabled, video.status]);

  const seekBy = useCallback(
    (deltaSec: number): void => {
      if (!enabled || controller === null) return;
      const from = playheadRef.current;
      const base = Number.isFinite(from) ? from : 0;
      const target = base + deltaSec;
      const clamped = duration > 0 ? Math.min(duration, Math.max(0, target)) : Math.max(0, target);
      void controller.seek(clamped);
    },
    [controller, duration, enabled, playheadRef],
  );

  // Room-wide shortcuts. The handlers are read from a ref so the listener is
  // attached once for the life of the room rather than on every render.
  const actions = useRef({ toggle, seekBy });
  actions.current = { toggle, seekBy };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;

      switch (event.key) {
        case ' ':
        case 'Spacebar':
          if (isActivatable(event.target)) return;
          event.preventDefault();
          actions.current.toggle();
          return;
        // No `isActivatable` guard on the arrows: they do nothing on a focused
        // button, and skipping them there would mean the person who just clicked
        // Play cannot seek without clicking somewhere else first.
        case 'ArrowLeft':
          event.preventDefault();
          actions.current.seekBy(-ARROW_STEP_SEC);
          return;
        case 'ArrowRight':
          event.preventDefault();
          actions.current.seekBy(ARROW_STEP_SEC);
          return;
        case 'j':
        case 'J':
          actions.current.seekBy(-SKIP_STEP_SEC);
          return;
        case 'l':
        case 'L':
          actions.current.seekBy(SKIP_STEP_SEC);
          return;
        default:
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const lockNote = canControl ? null : whoCanControl(playbackControl, hostName);
  const disabledReason = lockNote ?? (hasVideo ? 'The player is still loading' : 'No video yet');

  return (
    <div
      className={cn('shrink-0 border-t border-border bg-bg px-2 pb-1 sm:px-3', className)}
    >
      {/* Scrubber row — the time readout sits at its right end (§12.4). */}
      <div className="flex items-center gap-3">
        <Scrubber
          className="min-w-0 flex-1"
          durationSec={duration}
          playheadRef={playheadRef}
          getBuffered={controller === null ? undefined : () => controller.getBufferedFraction()}
          disabled={!enabled}
          ticks={ticks}
          onPreview={(seconds) => controller?.previewSeek(seconds)}
          onCommit={(seconds) => {
            void controller?.commitSeek(seconds);
          }}
          onFrame={(seconds) => {
            const node = timeRef.current;
            if (node !== null) node.textContent = formatTimestamp(seconds);
          }}
        />
        <p className="shrink-0 text-13 tabular-nums text-secondary">
          <span ref={timeRef}>0:00</span>
          <span className="text-tertiary"> / {duration > 0 ? formatTimestamp(duration) : '—:—'}</span>
        </p>
      </div>

      {/* Control row. 44px targets below `lg`, tighter on a desktop (§12.6). */}
      <div className="flex h-11 items-center gap-1">
        <ControlButton
          icon={showPlaying ? Pause : Play}
          label={showPlaying ? 'Pause' : 'Play'}
          hint={enabled ? `${showPlaying ? 'Pause' : 'Play'} for everyone · Space` : disabledReason}
          disabled={!enabled}
          onClick={toggle}
        />
        <ControlButton
          icon={RotateCcw}
          label="Back 10 seconds"
          hint={enabled ? 'Back 10 seconds · J' : disabledReason}
          disabled={!enabled}
          onClick={() => seekBy(-SKIP_STEP_SEC)}
        />
        <ControlButton
          icon={RotateCw}
          label="Forward 10 seconds"
          hint={enabled ? 'Forward 10 seconds · L' : disabledReason}
          disabled={!enabled}
          onClick={() => seekBy(SKIP_STEP_SEC)}
        />

        <VolumeControl
          controller={controller}
          unavailable={hasVideo ? 'the player is still loading' : 'no video yet'}
        />

        <div className="min-w-2 flex-1" />

        {lockNote === null ? null : (
          <>
            {/* The padlock is always there; the sentence appears when there is
                room for it. On a phone the sentence would push the transport
                buttons off the bar, so it stays available to a screen reader and
                to the tooltip on every disabled control instead. */}
            <span className="flex min-w-0 items-center gap-1.5 text-13 text-tertiary">
              <Lock size={16} strokeWidth={1.5} aria-hidden="true" />
              <span className="hidden truncate lg:inline">{lockNote}</span>
              <span className="sr-only lg:hidden">{lockNote}</span>
            </span>
            {/* Not wired to anything, and deliberately not faked: the request is a
                chat message, and chat is Phase 5. A button that pretends to have
                sent something is worse than one that says it cannot yet. */}
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="hidden lg:inline-flex">
                  <button
                    type="button"
                    disabled
                    aria-label="Request control — arrives with chat in Phase 5"
                    className={cn(
                      'inline-flex h-8 items-center rounded-md border border-border-strong px-2.5',
                      'text-13 text-tertiary opacity-50',
                    )}
                  >
                    Request control
                  </button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                Asking for control sends a chat message — chat arrives in Phase 5. For now, ask{' '}
                {hostName} out loud.
              </TooltipContent>
            </Tooltip>
          </>
        )}

        <SyncStatus status={status} controller={controller} className="ml-1" />
      </div>
    </div>
  );
}

// ── pieces ──────────────────────────────────────────────────────────────────

/**
 * An icon-only button with both halves of the §12.6 contract: an `aria-label`
 * for everyone and a tooltip for the mouse.
 *
 * The tooltip trigger is the wrapping span, not the button. A `disabled` button
 * receives no pointer events at all, so a tooltip bound to it never opens —
 * which is precisely when the explanation matters most.
 */
function ControlButton({
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
            onClick={onClick}
            disabled={disabled}
            aria-label={disabled ? `${label} — ${hint}` : label}
            className={cn(
              'inline-flex h-11 w-11 items-center justify-center rounded-md border lg:h-9 lg:w-9',
              'transition-colors duration-120 ease-standard',
              disabled
                ? 'border-border text-tertiary opacity-50'
                : 'border-border-strong text-primary hover:bg-surface-2',
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

/**
 * Volume is the one control here that is *not* synchronised: it is this
 * browser's speaker, and pushing it to the room would be a party trick with no
 * use case. It talks to the `PlayerAdapter` directly.
 *
 * Like the scrubber, the drag writes to `style.transform` and only commits to
 * React state on pointerup — a slider that re-renders the room while you drag it
 * is the same 60 fps mistake in a smaller box (§5.4).
 */
function VolumeControl({
  controller,
  unavailable,
}: {
  controller: SyncController | null;
  unavailable: string;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const fillRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const [level, setLevel] = useState(1);
  const [muted, setMuted] = useState(false);

  // Adopt whatever the player already has rather than imposing a value on it:
  // it may have muted itself to satisfy autoplay (§8.7).
  useEffect(() => {
    if (controller === null) return;
    const volume = controller.getVolume();
    if (Number.isFinite(volume)) setLevel(Math.min(1, Math.max(0, volume)));
    setMuted(controller.isMuted());
  }, [controller]);

  const paint = useCallback((value: number): void => {
    if (fillRef.current !== null) fillRef.current.style.transform = `scaleX(${value})`;
  }, []);

  useEffect(() => {
    paint(muted ? 0 : level);
  }, [level, muted, paint]);

  const valueAt = (clientX: number): number => {
    const track = trackRef.current;
    if (track === null) return 0;
    const box = track.getBoundingClientRect();
    if (box.width === 0) return 0;
    return Math.min(1, Math.max(0, (clientX - box.left) / box.width));
  };

  const apply = (value: number, commit: boolean): void => {
    if (controller === null) return;
    paint(value);
    controller.setVolume(value);
    // Dragging the volume up is an explicit answer to the autoplay gate, and
    // `setMuted(false)` is what clears `mutedForAutoplay` (§8.7).
    if (value > 0 && controller.isMuted()) controller.setMuted(false);
    if (commit) {
      setLevel(value);
      setMuted(controller.isMuted() && value === 0);
    }
  };

  const disabled = controller === null;
  const Icon = muted || level === 0 ? VolumeX : level < 0.5 ? Volume1 : Volume2;
  const label = muted ? 'Unmute' : 'Mute';

  return (
    <div className="flex items-center gap-1">
      <ControlButton
        icon={Icon}
        label={label}
        hint={disabled ? `${label} — ${unavailable}` : `${label} (this browser only)`}
        disabled={disabled}
        onClick={() => {
          if (controller === null) return;
          if (controller.isMuted()) {
            controller.setMuted(false);
            setMuted(false);
            // Unmuting a slider that is sitting at zero has to do something
            // audible, or the button looks broken.
            if (level === 0) {
              setLevel(1);
              controller.setVolume(1);
            }
          } else {
            controller.setMuted(true);
            setMuted(true);
          }
        }}
      />

      <div
        ref={trackRef}
        role="slider"
        aria-label="Volume"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round((muted ? 0 : level) * 100)}
        aria-valuetext={`${Math.round((muted ? 0 : level) * 100)}%`}
        aria-disabled={disabled ? true : undefined}
        tabIndex={disabled ? -1 : 0}
        onPointerDown={(event) => {
          if (disabled) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          draggingRef.current = true;
          apply(valueAt(event.clientX), false);
        }}
        onPointerMove={(event) => {
          if (!draggingRef.current) return;
          apply(valueAt(event.clientX), false);
        }}
        onPointerUp={(event) => {
          if (!draggingRef.current) return;
          draggingRef.current = false;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          apply(valueAt(event.clientX), true);
        }}
        onKeyDown={(event) => {
          if (disabled) return;
          const step = event.key === 'ArrowLeft' ? -0.05 : event.key === 'ArrowRight' ? 0.05 : 0;
          if (step === 0) return;
          event.preventDefault();
          event.stopPropagation();
          apply(Math.min(1, Math.max(0, (muted ? 0 : level) + step)), true);
        }}
        className={cn(
          'hidden h-7 w-16 shrink-0 touch-none items-center rounded-sm sm:flex',
          disabled ? 'cursor-default opacity-50' : 'cursor-pointer',
        )}
      >
        <div className="relative h-1 w-full overflow-hidden rounded-sm bg-surface-3">
          <div
            ref={fillRef}
            aria-hidden="true"
            className="absolute inset-0 origin-left bg-secondary"
            style={{ transform: 'scaleX(1)' }}
          />
        </div>
      </div>
    </div>
  );
}
