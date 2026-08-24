'use client';

/**
 * The 48px room top bar (PLAN.md §12.4).
 *
 * The room code and its copy button sit here because copying the link is the
 * single most-used action after Play. It copies the **full URL**, not the bare
 * code: a code pasted into a group chat makes the reader hunt for where to type
 * it, and half of them will type an O for a 0 — a character the alphabet
 * deliberately does not contain (§3.2 R2).
 */
import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft, Users } from 'lucide-react';
import { formatRoomCode } from '@syncstudy/shared';
import { CopyButton } from '@/components/ui/copy-button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ConnectionStatus } from '@/lib/stores/room-store';
import { ConnectionStatusPill } from '@/components/room/ConnectionBar';
import { cn } from '@/lib/utils';

export function RoomTopBar({
  name,
  topic,
  code,
  shareUrl,
  participantCount,
  maxParticipants,
  status,
  menu,
}: {
  name: string;
  topic: string | null;
  code: string;
  shareUrl: string;
  participantCount: number;
  maxParticipants: number;
  status: ConnectionStatus;
  menu: ReactNode;
}) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-bg px-2 sm:px-3">
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            href="/dashboard"
            aria-label="Back to your rooms"
            className={cn(
              'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
              'text-secondary transition-colors duration-120 ease-standard',
              'hover:bg-surface-2 hover:text-primary',
            )}
          >
            <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" />
          </Link>
        </TooltipTrigger>
        <TooltipContent>Your rooms</TooltipContent>
      </Tooltip>

      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <h1 className="min-w-0 truncate text-sm font-medium text-primary">{name}</h1>
        {topic !== null && topic.length > 0 ? (
          <p className="hidden min-w-0 truncate text-13 text-tertiary lg:block">{topic}</p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-surface-1 py-0.5 pl-2 pr-0.5">
        <span className="hidden font-mono text-13 tracking-[0.04em] text-secondary sm:inline">
          {formatRoomCode(code)}
        </span>
        {/* The value is the full URL, not `code` — see the note at the top. */}
        <CopyButton value={shareUrl} label="Copy link" />
      </div>

      {/* Before the snapshot lands the real count is unknown. An em dash says so;
          rendering "0" would claim an empty room to the person standing in it. */}
      <span
        aria-label={
          participantCount === 0
            ? 'Counting who is in this room'
            : `${participantCount} of ${maxParticipants} people in this room`
        }
        className="hidden shrink-0 items-center gap-1.5 text-13 text-secondary sm:flex"
      >
        <Users size={16} strokeWidth={1.5} aria-hidden="true" />
        <span aria-hidden="true">
          {participantCount === 0 ? '—' : participantCount}
          <span className="text-tertiary">/{maxParticipants}</span>
        </span>
      </span>

      <ConnectionStatusPill status={status} />

      {menu}
    </header>
  );
}
