'use client';

/**
 * Sync status — a dot, two words, and a way out (PLAN.md §12.4, §8.6 step 5, risk R4).
 *
 * Three rules shape this component, and all three are about restraint:
 *
 * 1. **It is text and a dot. Never a modal, never a toast.** Drift correction is
 *    a loop that runs at 2 Hz for three hours; anything that interrupts once per
 *    correction would interrupt hundreds of times a session. When things are
 *    fine this reads "In sync" in tertiary grey and is meant to be ignored.
 * 2. **State is never carried by the colour of the dot alone** (§12.6) — the
 *    label says the same thing in words, and the button's `aria-label` says it
 *    again with the actual drift in it.
 * 3. **The escape hatches are here, in a small menu.** PLAN's risk R4 is a
 *    correction loop the user can see but cannot stop. "Resync now" and "Pause
 *    auto-sync" cost eight lines and turn "this app is fighting me" into "I told
 *    it to stop". Giving someone a way out beats an invisible loop every time.
 *
 * What it deliberately does NOT show: a live drift readout that ticks at 2 Hz.
 * A number that changes twice a second beside a video is a distraction with a
 * decimal point on it, so the number lives inside the menu, where you go when
 * you already suspect something is wrong.
 */
import { Pause, Play, RefreshCw } from 'lucide-react';
import { DEAD_ZONE_SEC } from '@syncstudy/shared';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useWaitingForNames } from '@/lib/stores/room-store';
import type { SyncController } from '@/lib/sync/controller';
import type { SyncStatus as SyncStatusValue } from '@/lib/sync/types';
import { cn } from '@/lib/utils';

/**
 * How long "Pause auto-sync" stands down for (PLAN.md risk R4).
 *
 * Five minutes is long enough to read a paragraph in peace and short enough that
 * nobody is left silently desynced for the rest of the session — the whole point
 * of the room is that everyone is at the same second. This belongs in
 * `packages/shared/src/constants.ts` next to the other sync tunables; it is here
 * because Phase 4 does not own that file.
 */
export const AUTO_SYNC_PAUSE_MS = 5 * 60 * 1000;

interface Descriptor {
  label: string;
  /** Written out for a screen reader, so the dot's colour is never the message. */
  spoken: string;
  dot: string;
  text: string;
}

/**
 * "Sam", "Sam and Priya", "3 people". Past two names a list stops being
 * information and starts being a wall, and the pill is one line wide.
 */
function nameList(names: string[]): string {
  const [first, second] = names;
  if (first === undefined) return 'someone';
  if (second === undefined) return first;
  if (names.length === 2) return `${first} and ${second}`;
  return `${names.length} people`;
}

/**
 * One state wins, and the order matters: a room-wide stop beats anything local,
 * then what the user asked for beats what we measured, a failing connection
 * beats a transient correction, and "correcting" beats "in sync" even though
 * most ticks land in the dead zone.
 */
function describe(status: SyncStatusValue, waitingFor: string[]): Descriptor | null {
  if (status.drift === 'idle' && !status.autoSyncPaused && waitingFor.length === 0) return null;

  // §8.10. The room is paused for everyone and the video stopped on its own —
  // that needs a reason attached to it far more than a drift reading does, and
  // it outranks even "auto-sync off" because it is not about this client at all.
  if (waitingFor.length > 0) {
    const who = nameList(waitingFor);
    return {
      label: `Waiting for ${who}`,
      spoken: `Paused — waiting for ${who} to catch up.`,
      dot: 'bg-warning',
      text: 'text-warning',
    };
  }

  if (status.autoSyncPaused) {
    return {
      label: 'Auto-sync off',
      spoken: 'Auto-sync is paused. You may drift out of step with the room.',
      dot: 'bg-tertiary',
      text: 'text-tertiary',
    };
  }
  if (status.quality === 'poor') {
    return {
      label: 'Connection issues',
      spoken: 'Connection issues. Playback keeps falling out of step with the room.',
      dot: 'bg-danger',
      text: 'text-danger',
    };
  }
  if (status.buffering || status.drift === 'stalled') {
    return {
      label: 'Buffering',
      spoken: 'Buffering. The room is playing without you until this loads.',
      dot: 'bg-warning',
      text: 'text-warning',
    };
  }
  if (status.drift === 'correcting' || status.drift === 'resyncing') {
    return {
      label: 'Syncing…',
      spoken: 'Syncing. Catching up with the room.',
      dot: 'bg-warning',
      text: 'text-warning',
    };
  }
  return {
    label: 'In sync',
    spoken: 'In sync with the room.',
    dot: 'bg-tertiary',
    text: 'text-tertiary',
  };
}

/** "0.8s ahead of the room" — positive drift means this client is ahead (§8.6). */
function driftSentence(driftSec: number): string {
  const magnitude = Math.abs(driftSec);
  if (!Number.isFinite(driftSec) || magnitude < DEAD_ZONE_SEC) {
    return 'Within a few frames of the room.';
  }
  const rounded = magnitude < 10 ? magnitude.toFixed(1) : Math.round(magnitude).toString();
  return `${rounded}s ${driftSec > 0 ? 'ahead of' : 'behind'} the room.`;
}

export function SyncStatus({
  status,
  controller,
  className,
}: {
  status: SyncStatusValue;
  controller: SyncController | null;
  className?: string | undefined;
}) {
  const waitingFor = useWaitingForNames();
  const descriptor = describe(status, waitingFor);
  if (descriptor === null) return null;

  const pill = (
    <span className={cn('flex items-center gap-1.5 text-13', descriptor.text)}>
      <span aria-hidden="true" className={cn('h-1.5 w-1.5 shrink-0 rounded-full', descriptor.dot)} />
      {/* The label is the state. It hides below `sm` for room, and the button's
          aria-label carries the whole sentence either way. */}
      <span aria-hidden="true" className="hidden truncate sm:inline">
        {descriptor.label}
      </span>
    </span>
  );

  // Before the controller exists there is nothing to resync, so the pill is not
  // a button — a menu whose every item is disabled is worse than no menu.
  if (controller === null) {
    return (
      <span className={cn('flex shrink-0 items-center', className)}>
        {pill}
        <span className="sr-only">{descriptor.spoken}</span>
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Sync: ${descriptor.spoken} ${driftSentence(status.driftSec)} Open sync options.`}
          className={cn(
            'inline-flex h-8 shrink-0 items-center rounded-md px-1.5',
            'transition-colors duration-120 ease-standard hover:bg-surface-2',
            className,
          )}
        >
          {pill}
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="min-w-56">
        <div className="px-2 pb-1.5 pt-1.5">
          <p className="text-13 text-primary">{descriptor.label}</p>
          <p className="text-13 text-secondary">{driftSentence(status.driftSec)}</p>
          {status.hardSeeksLastMinute > 0 ? (
            <p className="text-13 text-tertiary">
              {status.hardSeeksLastMinute === 1
                ? '1 correction in the last minute.'
                : `${status.hardSeeksLastMinute} corrections in the last minute.`}
            </p>
          ) : null}
        </div>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          onSelect={() => {
            controller.resyncNow();
          }}
        >
          <RefreshCw size={16} strokeWidth={1.5} aria-hidden="true" />
          Resync now
        </DropdownMenuItem>

        {status.autoSyncPaused ? (
          <DropdownMenuItem
            onSelect={() => {
              controller.resumeAutoSync();
            }}
          >
            <Play size={16} strokeWidth={1.5} aria-hidden="true" />
            Resume auto-sync
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            onSelect={() => {
              controller.pauseAutoSync(AUTO_SYNC_PAUSE_MS);
            }}
          >
            <Pause size={16} strokeWidth={1.5} aria-hidden="true" />
            Pause auto-sync for 5 minutes
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
