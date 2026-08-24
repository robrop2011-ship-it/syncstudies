'use client';

/**
 * The bottom control bar (PLAN.md §12.4, §2.4).
 *
 * §12.4 fixes the order — left to right by frequency of use, with the
 * destructive action isolated on the right and 24px of space before it, styled
 * as a bordered ghost rather than a red fill, because a red button beside a
 * video invites exactly the misclick it looks like it is warning about.
 *
 * Mic, camera and screen share are inert: WebRTC is Phase 6. They are rendered
 * disabled with the reason stated in text as well as in a tooltip, so the
 * explanation does not depend on owning a mouse.
 *
 * Leave works, and for a host it opens the §2.4 hand-over dialog first.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LogOut, Mic, MonitorUp, Video, type LucideIcon } from 'lucide-react';
import type { Participant } from '@syncstudy/shared';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useMyPermissions, useParticipants } from '@/lib/stores/room-store';
import { useSocket } from '@/lib/socket/provider';
import { ackWithTimeout } from '@/components/room/socket-ack';
import { cn } from '@/lib/utils';

const PHASE_6 = 'arrives in Phase 6';

export function ControlBar({
  youId,
  fallbackIsHost,
  className,
}: {
  youId: string;
  /**
   * From the room row, used only until the snapshot lands. Without it a host who
   * hits Leave in the first 200ms skips the hand-over dialog they should get.
   */
  fallbackIsHost: boolean;
  className?: string | undefined;
}) {
  const router = useRouter();
  const socket = useSocket();
  const participants = useParticipants();
  const me = useMyPermissions();

  const [handOverOpen, setHandOverOpen] = useState(false);
  const [successor, setSuccessor] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A guest cannot be handed a room (§11.2), so they are not offered as one.
  const candidates = participants
    .filter((participant) => participant.id !== youId && participant.role !== 'guest')
    .sort((a, b) => rankSuccessor(a) - rankSuccessor(b) || a.joinedAt - b.joinedAt);

  const isHost = me === null ? fallbackIsHost : me.role === 'host';

  async function leave(successorId: string | null): Promise<void> {
    setLeaving(true);
    setError(null);

    if (socket !== null) {
      if (successorId !== null) {
        const handed = await ackWithTimeout((ack) =>
          socket.emit('host:transfer', { userId: successorId }, ack),
        );
        if (!handed.ok) {
          setLeaving(false);
          setError(handed.message);
          return;
        }
      }
      // Fire and forget, and note the missing `await`: the comment used to say
      // the result was ignored, but awaiting an ack IS waiting for the result.
      // On a dead socket the emit is buffered, the ack never arrives, and Leave
      // hung for the full 8s ACK_TIMEOUT_MS — precisely when someone is most
      // likely to be reaching for it. The server's disconnect path removes them
      // either way (§8.8), so the ack was never load-bearing.
      void ackWithTimeout((ack) => socket.emit('room:leave', {}, ack));
    }

    router.push('/dashboard');
  }

  return (
    <>
      <div
        className={cn(
          'flex h-14 shrink-0 items-center gap-1 border-t border-border bg-bg px-2 sm:px-3',
          className,
        )}
      >
        <InertControl icon={Mic} label="Microphone" note={`Voice ${PHASE_6}`} />
        <InertControl icon={Video} label="Camera" note={`Video ${PHASE_6}`} />
        <InertControl icon={MonitorUp} label="Share screen" note={`Screen sharing ${PHASE_6}`} />

        <p className="ml-2 hidden text-13 text-tertiary xl:block">
          Voice, camera and screen sharing arrive in Phase 6.
        </p>

        <div className="flex-1" />

        <Button
          type="button"
          variant="secondary"
          className="ml-6 h-11 lg:h-9"
          loading={leaving && !handOverOpen}
          disabled={leaving}
          onClick={() => {
            if (isHost && candidates.length > 0) {
              setSuccessor(candidates[0]?.id ?? null);
              setError(null);
              setHandOverOpen(true);
              return;
            }
            void leave(null);
          }}
        >
          <LogOut size={16} strokeWidth={1.5} aria-hidden="true" />
          Leave room
        </Button>
      </div>

      <Dialog
        open={handOverOpen}
        onOpenChange={(open) => {
          if (!open && !leaving) setHandOverOpen(false);
        }}
      >
        <DialogContent>
          <DialogTitle>You&rsquo;re the host</DialogTitle>
          <DialogDescription>
            The room carries on after you leave. Pick who takes over, or just leave and it goes
            to whoever has been here longest.
          </DialogDescription>

          <ul className="ss-scroll max-h-56 overflow-y-auto border-y border-border">
            {candidates.map((participant) => (
              <li key={participant.id}>
                <label className="flex h-10 cursor-pointer items-center gap-2.5 px-4 transition-colors duration-120 ease-standard hover:bg-surface-2">
                  <input
                    type="radio"
                    name="successor"
                    className="h-4 w-4 accent-accent"
                    checked={successor === participant.id}
                    onChange={() => setSuccessor(participant.id)}
                  />
                  <Avatar
                    size={24}
                    name={participant.displayName}
                    handle={participant.handle}
                    src={participant.avatarUrl}
                  />
                  <span className="min-w-0 flex-1 truncate text-13 text-primary">
                    {participant.displayName}
                  </span>
                  {participant.role === 'co_host' ? (
                    <span className="shrink-0 rounded-sm border border-border-strong px-1 text-[11px] font-medium uppercase tracking-[0.04em] text-secondary">
                      Co-host
                    </span>
                  ) : null}
                  {participant.connState === 'reconnecting' ? (
                    <span className="shrink-0 text-[11px] text-warning">Reconnecting</span>
                  ) : null}
                </label>
              </li>
            ))}
          </ul>

          {error !== null ? (
            <div className="px-4 pt-3">
              <Callout tone="danger">{error}</Callout>
            </div>
          ) : null}

          <DialogFooter className="flex-wrap">
            <Button
              type="button"
              variant="ghost"
              disabled={leaving}
              onClick={() => setHandOverOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={leaving}
              onClick={() => {
                void leave(null);
              }}
            >
              Just leave
            </Button>
            <Button
              type="button"
              variant="primary"
              loading={leaving}
              disabled={leaving || successor === null}
              onClick={() => {
                void leave(successor);
              }}
            >
              Hand over and leave
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * A control that exists in the layout but not yet in the product.
 *
 * The tooltip hangs on the wrapper rather than the button: a `disabled` button
 * receives no pointer events, so a tooltip attached to it never opens. The
 * reason is also written in the bar itself, because a tooltip is not an
 * explanation anyone on a phone will ever see.
 */
function InertControl({
  icon: Icon,
  label,
  note,
}: {
  icon: LucideIcon;
  label: string;
  note: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <button
            type="button"
            disabled
            aria-label={`${label} — ${note}`}
            className={cn(
              // 44px touch target on small screens (§12.6), tighter on desktop.
              'inline-flex h-11 w-11 items-center justify-center rounded-md border border-border-strong lg:h-9 lg:w-9',
              'text-tertiary opacity-50',
            )}
          >
            <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {label} — {note}
      </TooltipContent>
    </Tooltip>
  );
}

/** Co-hosts first: they already have most of the controls. */
function rankSuccessor(participant: Participant): number {
  if (participant.role === 'co_host') return 0;
  return participant.connState === 'connected' ? 1 : 2;
}
