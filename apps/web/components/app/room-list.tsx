/**
 * "My rooms" (PLAN.md §3.2 R10).
 *
 * Rows come from `RoomSummary` in lib/server/rooms.ts — the same shape the
 * `GET /api/rooms` handler returns — so the dashboard's server render and any
 * later client refresh cannot drift apart into two ideas of what a room is.
 *
 * Occupancy is the count of `room_participants` rows with no `left_at`: the
 * durable record, not the live Redis presence the room page uses. It can lag by
 * the length of a disconnect grace period, which is why the label reads "in
 * room" rather than claiming to be accurate to the second.
 */
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { formatRoomCode } from '@syncstudy/shared';
import { Button, buttonVariants } from '@/components/ui/button';
import type { RoomSummary } from '@/lib/server/rooms';
import { relativeTime } from '@/lib/server/format';

/** Re-exported so existing callers keep one import for the component and its row type. */
export type { RoomSummary };

export function RoomList({
  rooms,
  currentUserId,
}: {
  rooms: RoomSummary[];
  /**
   * Optional: `RoomSummary` already resolves `isHost`, and this is only a
   * fallback for a caller that has the viewer's id but not a resolved summary.
   */
  currentUserId?: string | undefined;
}) {
  if (rooms.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface-1 px-6 py-12 text-center">
        <p className="text-sm text-secondary">
          No rooms yet. Create one, or join with a code somebody sent you.
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <Button asChild variant="primary" size="sm">
            <Link href="/rooms/new">
              <Plus size={16} strokeWidth={1.5} aria-hidden="true" />
              Create room
            </Link>
          </Button>
          <Link href="/join" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
            Join with a code
          </Link>
        </div>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
      {rooms.map((room) => {
        const isHost = room.isHost || room.hostId === currentUserId;
        const occupied = room.participantCount > 0;

        return (
          <li key={room.id}>
            <Link
              href={`/r/${room.code}`}
              className="flex items-center gap-4 bg-bg px-4 py-3 transition-colors duration-120 ease-standard hover:bg-surface-2"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-primary">{room.name}</span>
                  {isHost ? <RoleChip label="Host" /> : null}
                  {!isHost && room.role === 'co_host' ? <RoleChip label="Co-host" /> : null}
                </div>
                <p className="truncate text-13 text-secondary">
                  {room.topic ?? `Hosted by ${room.hostName}`}
                </p>
              </div>

              <span className="hidden shrink-0 font-mono text-13 tracking-[0.04em] text-tertiary sm:inline">
                {formatRoomCode(room.code)}
              </span>

              <span className="flex min-w-[104px] shrink-0 items-center justify-end gap-1.5 whitespace-nowrap text-13 text-secondary">
                {occupied ? (
                  <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-success" />
                ) : null}
                {occupied
                  ? `${room.participantCount} of ${room.maxParticipants} in room`
                  : 'Empty'}
              </span>

              <span className="w-[72px] shrink-0 text-right text-13 text-tertiary">
                {relativeTime(new Date(room.lastActiveAt))}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function RoleChip({ label }: { label: string }) {
  return (
    <span className="shrink-0 rounded-sm border border-border-strong px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-[0.04em] text-secondary">
      {label}
    </span>
  );
}
