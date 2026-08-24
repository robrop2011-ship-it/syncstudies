'use client';

/**
 * Live participant list (PLAN.md §3.2 R6, §12.4, §12.6).
 *
 * Three rules from the spec drive everything here:
 *
 *  1. **Reconnecting is not gone.** A dropped participant stays in the list at
 *     40% opacity for the whole grace period (§2.3). Removing and re-adding the
 *     row would make a 20-second Wi-Fi blip look like someone storming out.
 *  2. **State is never colour alone** (§12.6). Every state carries an icon and a
 *     word; the colours are there for the people who can use them.
 *  3. **Sorted: you, host, co-hosts, then join order** (R6). Stable, so the list
 *     doesn't reshuffle under a cursor that is on its way to a menu.
 */
import type { ReactNode } from 'react';
import { MicOff, Mic, MonitorUp, Users } from 'lucide-react';
import type { Participant, Role } from '@syncstudy/shared';
import { Avatar } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useMyPermissions, useParticipants } from '@/lib/stores/room-store';
import { ParticipantActions } from '@/components/room/HostControls';
import { cn } from '@/lib/utils';

const ROLE_LABEL: Partial<Record<Role, string>> = {
  host: 'Host',
  co_host: 'Co-host',
  guest: 'Guest',
};

export function ParticipantList({
  youId,
  hostId,
  loading,
}: {
  youId: string;
  hostId: string;
  loading: boolean;
}) {
  const participants = useParticipants();
  const me = useMyPermissions();
  const myRole: Role = me?.role ?? 'member';

  if (loading && participants.length === 0) return <ParticipantSkeleton />;

  const ordered = [...participants].sort(
    (a, b) =>
      rank(a, youId, hostId) - rank(b, youId, hostId) ||
      a.joinedAt - b.joinedAt ||
      a.id.localeCompare(b.id),
  );

  return (
    <div className="flex flex-col gap-2 p-2">
      <ul className="flex flex-col">
        {ordered.map((participant) => (
          <ParticipantRow
            key={participant.id}
            participant={participant}
            isYou={participant.id === youId}
            actions={
              <ParticipantActions target={participant} youId={youId} myRole={myRole} />
            }
          />
        ))}
      </ul>

      {!loading && ordered.length === 1 ? (
        <p className="px-2 pb-1 text-13 text-tertiary">
          Nobody else is here yet. Copy the room link from the top bar to bring people in.
        </p>
      ) : null}
    </div>
  );
}

function ParticipantRow({
  participant,
  isYou,
  actions,
}: {
  participant: Participant;
  isYou: boolean;
  actions: ReactNode;
}) {
  const reconnecting = participant.connState === 'reconnecting';
  const badge = ROLE_LABEL[participant.role];

  return (
    <li
      className={cn(
        // 32px rows — the density §12.1 rule 8 asks for in a tool people sit in.
        'group flex h-8 items-center gap-2 rounded-sm pl-2 pr-1',
        'transition-colors duration-120 ease-standard hover:bg-surface-2',
        // Speaking gets a rule and an icon, never a colour wash (§12.4).
        participant.speaking ? 'border-l-2 border-live pl-1.5' : null,
      )}
    >
      {/* Only the identity dims — the reason it is dimmed has to stay readable. */}
      <span
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2',
          reconnecting ? 'opacity-40' : null,
        )}
      >
        <Avatar
          size={24}
          name={participant.displayName}
          handle={participant.handle}
          src={participant.avatarUrl}
        />
        <span className="min-w-0 truncate text-13 text-primary">
          {participant.displayName}
          {isYou ? <span className="text-tertiary"> (you)</span> : null}
        </span>
        {badge !== undefined ? (
          <span className="shrink-0 rounded-sm border border-border-strong px-1 text-[11px] font-medium uppercase tracking-[0.04em] text-secondary">
            {badge}
          </span>
        ) : null}
      </span>

      <StateChip participant={participant} />
      {actions}
    </li>
  );
}

/**
 * The single most important thing about this person right now.
 *
 * One chip, not five: a row that can show "reconnecting, muted, sharing" at once
 * is a row nobody reads. Reconnecting outranks everything, because it is the one
 * state that explains why the rest of the row is stale.
 */
function StateChip({ participant }: { participant: Participant }) {
  const state = resolveState(participant);
  if (state === null) return null;

  return (
    <span
      className={cn('flex shrink-0 items-center gap-1 text-[11px]', state.tone)}
      title={state.detail}
    >
      {state.icon}
      <span aria-hidden="true">{state.label}</span>
      <span className="sr-only">{state.detail}</span>
    </span>
  );
}

interface ChipSpec {
  icon: ReactNode;
  label: string;
  detail: string;
  tone: string;
}

function resolveState(participant: Participant): ChipSpec | null {
  if (participant.connState === 'reconnecting') {
    return {
      icon: <Spinner size={14} />,
      label: 'Reconnecting',
      detail: 'Reconnecting — still in the room',
      tone: 'text-warning',
    };
  }
  if (participant.sharing) {
    return {
      icon: <MonitorUp size={16} strokeWidth={1.5} aria-hidden="true" />,
      label: 'Sharing',
      detail: 'Sharing their screen',
      tone: 'text-secondary',
    };
  }
  if (participant.forceMuted) {
    return {
      icon: <MicOff size={16} strokeWidth={1.5} aria-hidden="true" />,
      label: 'Muted',
      detail: 'Muted by the host',
      tone: 'text-secondary',
    };
  }
  if (participant.inCall && participant.muted) {
    return {
      icon: <MicOff size={16} strokeWidth={1.5} aria-hidden="true" />,
      label: 'Muted',
      detail: 'In the call, microphone off',
      tone: 'text-tertiary',
    };
  }
  if (participant.inCall) {
    return {
      icon: <Mic size={16} strokeWidth={1.5} aria-hidden="true" />,
      label: participant.speaking ? 'Speaking' : 'In call',
      detail: participant.speaking ? 'Speaking' : 'In the call',
      tone: participant.speaking ? 'text-live' : 'text-tertiary',
    };
  }
  return null;
}

/** You first, then the host, then co-hosts, then everyone in join order. */
function rank(participant: Participant, youId: string, hostId: string): number {
  if (participant.id === youId) return 0;
  if (participant.role === 'host' || participant.id === hostId) return 1;
  if (participant.role === 'co_host') return 2;
  return 3;
}

/**
 * Four rows at the real geometry — 32px tall, 24px avatar, a name-width bar.
 * Never a centred spinner (§12.1 rule 11).
 */
const SKELETON_WIDTHS = ['w-24', 'w-20', 'w-28', 'w-16'] as const;

function ParticipantSkeleton() {
  return (
    <div className="flex flex-col p-2" aria-hidden="true">
      {SKELETON_WIDTHS.map((width) => (
        <div key={width} className="flex h-8 items-center gap-2 px-2">
          <Skeleton className="h-6 w-6 rounded-md" />
          <Skeleton className={cn('h-3.5', width)} />
        </div>
      ))}
    </div>
  );
}

/**
 * The count on the People tab. Renders nothing until the snapshot lands — a "0"
 * beside a list of skeletons is a number we do not have yet, and it is wrong for
 * the one second it is on screen.
 */
export function ParticipantCount({ className }: { className?: string | undefined }) {
  const participants = useParticipants();
  if (participants.length === 0) return null;

  return (
    <span className={cn('flex items-center gap-1.5', className)}>
      <Users size={16} strokeWidth={1.5} aria-hidden="true" />
      {participants.length}
    </span>
  );
}
