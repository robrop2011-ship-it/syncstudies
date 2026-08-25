'use client';

/**
 * Timestamped notes, questions and bookmarks (PLAN.md §3.6 S3, S4, §2.5).
 *
 * This is the retention feature. Someone types a question at 41:12, it becomes a
 * tick on the scrubber, and anyone can click it later to take the whole room
 * back to that second. The list here and the ticks on the scrubber read the same
 * store, so they cannot disagree about where a question was asked.
 *
 * Seeking from here goes through the same permission-checked `video:control`
 * path as the scrubber (§3.6 S4) — there is no second seek path to keep in step.
 */
import { Bookmark, CircleHelp, NotebookPen, Trash2, type LucideIcon } from 'lucide-react';
import { formatTimestamp, type NoteItemView } from '@syncstudy/shared';
import { useSocket } from '@/lib/socket/provider';
import { useMyPermissions, useNoteItems } from '@/lib/stores/room-store';
import { ackWithTimeout } from '@/components/room/socket-ack';
import { cn } from '@/lib/utils';

const ICON: Record<NoteItemView['kind'], LucideIcon> = {
  note: NotebookPen,
  question: CircleHelp,
  bookmark: Bookmark,
};

export function NoteItems({
  youId,
  canSeek,
  onSeek,
}: {
  youId: string;
  canSeek: boolean;
  onSeek: (positionSec: number) => void;
}) {
  const items = useNoteItems();
  const permissions = useMyPermissions();
  const socket = useSocket();

  if (items.length === 0) {
    return (
      <p className="px-3 py-1 text-13 text-tertiary">
        Nothing pinned to the video yet. Press <kbd className="rounded-sm border border-border-strong px-1">?</kbd>{' '}
        while watching to ask a question at the current timestamp.
      </p>
    );
  }

  const remove = (id: string): void => {
    if (socket === null) return;
    void ackWithTimeout((cb) => socket.emit('notes:item_delete', { id }, cb));
  };

  const resolve = (item: NoteItemView): void => {
    if (socket === null) return;
    void ackWithTimeout((cb) =>
      socket.emit('notes:item_update', { id: item.id, resolved: item.resolvedAt === null }, cb),
    );
  };

  return (
    <ul className="flex flex-col">
      {items.map((item) => {
        const Icon = ICON[item.kind];
        const mine = item.author?.id === youId;
        const canDelete = mine || permissions?.canDeleteAnyMessage === true;
        const resolved = item.resolvedAt !== null;

        return (
          <li
            key={item.id}
            className="group flex items-start gap-2 rounded-sm px-3 py-1.5 transition-colors duration-120 ease-standard hover:bg-surface-2"
          >
            <Icon
              size={16}
              strokeWidth={1.5}
              aria-hidden="true"
              className={cn('mt-0.5 shrink-0', resolved ? 'text-tertiary' : 'text-secondary')}
            />

            <div className="min-w-0 flex-1">
              <p className={cn('text-13 text-primary', resolved ? 'text-tertiary line-through' : null)}>
                {item.body}
              </p>
              <p className="flex items-center gap-1.5 text-[11px] text-tertiary">
                {item.videoTs === null ? null : (
                  <button
                    type="button"
                    disabled={!canSeek}
                    onClick={() => onSeek(item.videoTs ?? 0)}
                    title={canSeek ? 'Take the room to this moment' : 'You cannot control playback'}
                    className={cn(
                      'rounded-sm tabular-nums underline-offset-2',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                      canSeek ? 'text-accent hover:underline' : 'text-tertiary',
                    )}
                  >
                    {formatTimestamp(item.videoTs)}
                  </button>
                )}
                <span className="truncate">{item.author?.displayName ?? 'Someone'}</span>
              </p>
            </div>

            {/* Actions stay in the tab order rather than appearing on hover:
                an action you can only reach with a mouse is not an action. */}
            <div className="flex shrink-0 items-center gap-0.5">
              {item.kind === 'question' ? (
                <IconAction
                  label={resolved ? 'Mark as unanswered' : 'Mark as answered'}
                  onClick={() => resolve(item)}
                >
                  <CircleHelp
                    size={14}
                    strokeWidth={1.5}
                    aria-hidden="true"
                    className={resolved ? 'text-success' : 'text-tertiary'}
                  />
                </IconAction>
              ) : null}
              {canDelete ? (
                <IconAction label="Delete" onClick={() => remove(item.id)}>
                  <Trash2 size={14} strokeWidth={1.5} aria-hidden="true" className="text-tertiary" />
                </IconAction>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function IconAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'inline-flex h-6 w-6 items-center justify-center rounded-sm',
        'transition-colors duration-120 ease-standard hover:bg-surface-3',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
      )}
    >
      {children}
    </button>
  );
}
