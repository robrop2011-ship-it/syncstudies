'use client';

/**
 * Connection state (PLAN.md §2.3, §12.4).
 *
 * A dropped socket gets a thin bar and nothing else. Not a modal, not a spinner
 * overlay, not a disabled page: the video keeps playing, the notes keep taking
 * keystrokes, and the bar goes away when the socket comes back. A 20-second
 * Wi-Fi blip should cost a strip of amber, not the session.
 *
 * `aria-live="assertive"` is used here and nowhere else in the room — §12.6
 * reserves it for connection loss precisely because everything else can wait.
 */
import { RotateCw, TriangleAlert } from 'lucide-react';
import type { ConnectionStatus } from '@/lib/stores/room-store';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

const DOT: Record<ConnectionStatus, string> = {
  connecting: 'bg-warning',
  connected: 'bg-tertiary',
  reconnecting: 'bg-warning',
  failed: 'bg-danger',
};

const TEXT: Record<ConnectionStatus, string> = {
  connecting: 'text-secondary',
  connected: 'text-tertiary',
  reconnecting: 'text-warning',
  failed: 'text-danger',
};

const LABEL: Record<ConnectionStatus, string> = {
  connecting: 'Connecting',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  failed: 'Offline',
};

/**
 * The top-bar indicator. Small, quiet, and ignorable when things are fine —
 * §12.4 is specific that sync status is text and a dot, never a dialog.
 */
export function ConnectionStatusPill({ status }: { status: ConnectionStatus }) {
  return (
    <span className={cn('flex shrink-0 items-center gap-1.5 text-13', TEXT[status])}>
      <span aria-hidden="true" className={cn('h-1.5 w-1.5 rounded-full', DOT[status])} />
      {/* Visible from sm up; always present for a screen reader, so the state is
          never carried by the colour of the dot alone (§12.6). */}
      <span className="hidden sm:inline">{LABEL[status]}</span>
      <span className="sr-only sm:hidden">{LABEL[status]}</span>
    </span>
  );
}

/**
 * The bar itself. Invisible and empty while the socket is healthy — but always
 * mounted: a live region that is inserted into the DOM at the same moment it
 * gains content is announced unreliably, and this is the one announcement in the
 * room that has to land. While healthy it is `sr-only`, so it is absolutely
 * positioned and costs the flex column no height.
 */
export function ConnectionBar({
  status,
  everConnected,
  onRetry,
}: {
  status: ConnectionStatus;
  /**
   * Has a snapshot ever landed on this mount?
   *
   * It changes what "offline" means. Having been in the room and lost it is a
   * network blip and the room really does carry on without you. Never having
   * reached it at all is a different sentence — usually a realtime service that
   * is not running — and telling that person "everyone else is still in it" is
   * a guess dressed as a fact.
   */
  everConnected: boolean;
  onRetry: () => void;
}) {
  const failed = status === 'failed';
  const degraded = failed || status === 'reconnecting';

  return (
    <div
      aria-live="assertive"
      className={cn(
        degraded
          ? 'flex h-7 shrink-0 items-center gap-2 border-b px-3 text-13'
          : 'sr-only',
        degraded && failed ? 'border-danger/35 bg-danger-subtle text-danger' : null,
        degraded && !failed ? 'border-warning/35 bg-warning-subtle text-warning' : null,
      )}
    >
      {degraded ? (
        <>
          {failed ? (
            <TriangleAlert size={16} strokeWidth={1.5} aria-hidden="true" />
          ) : (
            <Spinner size={14} />
          )}

          <span className="min-w-0 truncate">
            {failed
              ? everConnected
                ? "Can't reach the room. Everyone else is still in it."
                : "Can't reach the realtime server, so this room cannot open. Chat, video sync and voice all need it."
              : 'Reconnecting… the room carries on without you for up to 45 seconds.'}
          </span>

          {failed ? (
            <button
              type="button"
              onClick={onRetry}
              className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-sm font-medium underline-offset-2 hover:underline"
            >
              <RotateCw size={16} strokeWidth={1.5} aria-hidden="true" />
              Try again
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
