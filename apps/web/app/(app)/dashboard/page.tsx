/**
 * The dashboard: recent rooms, and the two things anyone comes here to do.
 *
 * Rooms have no REST surface until Phase 3, so this reads Postgres directly. It
 * is a server component, so that is a query on the render path rather than an
 * API call the browser has to wait for.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { prisma } from '@syncstudy/db';
import { Button } from '@/components/ui/button';
import { JoinRoomForm } from '@/components/app/join-room-form';
import { RoomList, type RoomSummary } from '@/components/app/room-list';
import { requireSession } from '@/lib/server/session';

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
      id: true,
      code: true,
      name: true,
      topic: true,
      hostId: true,
      maxParticipants: true,
      lastActiveAt: true,
      host: { select: { displayName: true } },
      // Counted in JS rather than with a filtered `_count`: the row cap above
      // keeps this to a few dozen ids, and it keeps the query boring.
      participants: { where: { leftAt: null }, select: { userId: true } },
    },
  });

  const rooms: RoomSummary[] = rows.map((room) => ({
    id: room.id,
    code: room.code,
    name: room.name,
    topic: room.topic,
    hostId: room.hostId,
    hostName: room.host.displayName,
    maxParticipants: room.maxParticipants,
    occupancy: room.participants.length,
    lastActiveAt: room.lastActiveAt,
  }));

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
