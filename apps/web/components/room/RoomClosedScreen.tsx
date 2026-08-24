/**
 * The four ways a room stops being a place you can be (PLAN.md §2.2, §3.2 R9).
 *
 * Two of them are decided on the server before the shell ever mounts (ended,
 * archived, banned) and two arrive over the socket while you are sitting in it
 * (ended by the host, kicked). Both paths land here so the wording, and the way
 * out, are the same either way.
 *
 * No hooks, so this renders from the server page and from inside the client
 * shell without a second copy.
 */
import Link from 'next/link';
import { Archive, Ban, PowerOff, UserMinus } from 'lucide-react';
import { formatRoomCode } from '@syncstudy/shared';
import { buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Logo } from '@/components/ui/logo';
import type { RoomClosedKind } from '@/components/room/types';

const COPY: Record<
  RoomClosedKind,
  { icon: typeof Ban; title: string; body: string }
> = {
  ended: {
    icon: PowerOff,
    title: 'This room has ended',
    body: 'The host closed it. Everything written in it is kept, but the code no longer works — a new session needs a new room.',
  },
  archived: {
    icon: Archive,
    title: 'This room is archived',
    body: 'Rooms are archived after 14 days without activity. The chat and the notes are still readable, but nobody can join.',
  },
  banned: {
    icon: Ban,
    title: "You can't join this room",
    body: 'The host removed you and blocked this account from rejoining. Only they can undo that.',
  },
  kicked: {
    icon: UserMinus,
    title: 'You were removed from this room',
    body: 'The host removed you. You can go back in if they share the code again.',
  },
};

export function RoomClosedScreen({
  kind,
  roomName,
  code,
}: {
  kind: RoomClosedKind;
  roomName?: string | null | undefined;
  code?: string | undefined;
}) {
  const copy = COPY[kind];
  const Icon = copy.icon;

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-12 shrink-0 items-center border-b border-border px-4 sm:px-6">
        <Link
          href="/dashboard"
          className="flex items-center gap-2 rounded-sm text-sm font-medium text-primary"
        >
          <Logo size={16} />
          <span>SyncStudy</span>
        </Link>
      </header>

      <main className="flex flex-1 items-center justify-center px-4 py-16">
        <div className="w-full max-w-[420px]">
          <Card className="flex flex-col items-center gap-4 p-6 text-center">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border-strong text-tertiary">
              <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
            </span>

            <div className="flex flex-col gap-1">
              <h1 className="text-base font-medium text-primary">{copy.title}</h1>
              <p className="text-13 text-secondary">{copy.body}</p>
            </div>

            {roomName !== null && roomName !== undefined && roomName.length > 0 ? (
              <p className="text-13 text-tertiary">
                {roomName}
                {code !== undefined ? (
                  <>
                    {' · '}
                    <span className="font-mono tracking-[0.04em]">{formatRoomCode(code)}</span>
                  </>
                ) : null}
              </p>
            ) : null}

            <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
              <Link href="/dashboard" className={buttonVariants({ variant: 'primary' })}>
                Back to your rooms
              </Link>
              <Link href="/join" className={buttonVariants({ variant: 'secondary' })}>
                Join another room
              </Link>
            </div>
          </Card>
        </div>
      </main>
    </div>
  );
}
