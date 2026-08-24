/**
 * "My rooms" (PLAN.md §3.2 R10).
 *
 * Occupancy here is the count of `room_participants` rows with no `left_at` —
 * the durable record, not the live Redis presence the room page will use. It can
 * lag by the length of a disconnect grace period, which is why the label reads
 * "in room" rather than claiming to be live to the second.
 */
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { formatRoomCode } from '@syncstudy/shared';
import { Button } from '@/components/ui/button';
import { relativeTime } from '@/lib/server/format';

export interface RoomSummary {
  id: string;
  code: string;
  name: string;
  topic: string | null;
  hostId: string;
  hostName: string;
  maxParticipants: number;
  occupancy: number;
  lastActiveAt: Date;
}

export function RoomList({ rooms, currentUserId }: { rooms: RoomSummary[]; currentUserId: string }) {
  if (rooms.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface-1 px-6 py-12 text-center">
        <p className="text-sm text-secondary">No rooms yet. Create one to get started.</p>
        <div className="mt-4 flex justify-center">
          <Button asChild variant="primary" size="sm">
            <Link href="/rooms/new">
              <Plus size={16} strokeWidth={1.5} aria-hidden="true" />
              Create room
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
      {rooms.map((room) => {
        const isHost = room.hostId === currentUserId;
        const occupied = room.occupancy > 0;

        return (
          <li key={room.id}>
            <Link
              href={`/r/${room.code}`}
              className="flex items-center gap-4 bg-bg px-4 py-3 transition-colors duration-120 ease-standard hover:bg-surface-2"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-primary">{room.name}</span>
                  {isHost ? (
                    <span className="shrink-0 rounded-sm border border-border-strong px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-[0.04em] text-secondary">
                      Host
                    </span>
                  ) : null}
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
                {occupied ? `${room.occupancy} of ${room.maxParticipants} in room` : 'Empty'}
              </span>

              <span className="w-[72px] shrink-0 text-right text-13 text-tertiary">
                {relativeTime(room.lastActiveAt)}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
