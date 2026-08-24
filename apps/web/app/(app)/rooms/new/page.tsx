import type { Metadata } from 'next';
import { Card } from '@/components/ui/card';
import { CreateRoomForm } from '@/components/room/CreateRoomForm';
import { requireSession } from '@/lib/server/session';

export const metadata: Metadata = {
  title: 'New room',
  description: 'Create a private study room and get a code to share.',
};

export const dynamic = 'force-dynamic';

/**
 * `middleware.ts` only matches `/dashboard` and `/settings`, so this route's
 * redirect comes from `requireSession` — which is the authoritative check
 * anyway. The `?next=` round-trip means signing up from the marketing page's
 * "Create a room" button lands back here rather than on the dashboard (§2.1).
 */
export default async function NewRoomPage() {
  await requireSession('/rooms/new');

  return (
    <div className="mx-auto flex w-full max-w-[520px] flex-col px-4 py-10 sm:px-6">
      <Card className="p-6">
        <CreateRoomForm />
      </Card>
    </div>
  );
}
