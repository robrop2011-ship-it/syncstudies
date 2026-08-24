/**
 * The dashboard: recent rooms, and the two things anyone comes here to do.
 *
 * Reads Postgres directly rather than calling its own REST API: this is a server
 * component, so a query on the render path beats an API round-trip the browser
 * has to wait for. It goes through the SAME select and mapper the API uses
 * (`ROOM_SUMMARY_SELECT` / `toRoomSummary`), so the two can never disagree about
 * the shape of a room.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { prisma } from '@syncstudy/db';
import { Button } from '@/components/ui/button';
import { JoinRoomForm } from '@/components/app/join-room-form';
import { RoomList } from '@/components/app/room-list';
import { requireSession } from '@/lib/server/session';
import { ROOM_SUMMARY_SELECT, toRoomSummary, type RoomSummary } from '@/lib/server/rooms';

export const metadata: Metadata = {
  title: 'Rooms',
  description: 'Your recent study rooms.',
};

export const dynamic = 'force-dynamic';

const RECENT_LIMIT = 20;

export default async function DashboardPage() {
  const session = await requireSession('/dashboard');
  const userId = session.user.id;

  const rows = await prisma.room.findMany({
    where: {
      status: { not: 'ended' },
      OR: [{ hostId: userId }, { participants: { some: { userId } } }],
    },
    orderBy: { lastActiveAt: 'desc' },
    take: RECENT_LIMIT,
    select: {
      ...ROOM_SUMMARY_SELECT,
      // The viewer's own membership row, so the mapper can resolve their role
      // without a second query per room.
      participants: { where: { userId }, select: { role: true }, take: 1 },
    },
  });

  const rooms: RoomSummary[] = rows.map((row) =>
    toRoomSummary(row, userId, row.participants[0]?.role ?? null),
  );

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-[-0.01em] text-primary">Rooms</h1>
          <p className="text-sm text-secondary">
            Rooms you host or have joined, most recently active first.
          </p>
        </div>

        <div className="flex flex-wrap items-start gap-3">
          <JoinRoomForm />
          <Button asChild variant="primary">
            <Link href="/rooms/new">
              <Plus size={16} strokeWidth={1.5} aria-hidden="true" />
              Create room
            </Link>
          </Button>
        </div>
      </div>

      <div className="mt-6">
        <RoomList rooms={rooms} currentUserId={userId} />
      </div>
    </div>
  );
}
