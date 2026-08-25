'use client';

/**
 * One line of the transcript (PLAN.md §3.5 H1/H2/H10, §12.1, §12.6).
 *
 * Two shapes, decided by `kind`:
 *
 * - **system** — a centred, low-contrast line with no avatar and no actions.
 *   "Sam joined", "Paused — waiting for Priya". It is context, not conversation,
 *   and it should read as furniture.
 * - **user** — avatar, name, time, body. Consecutive messages from the same
 *   person inside a couple of minutes are *grouped*: the second one drops the
 *   avatar and the name and keeps its indent. Without grouping, three quick
 *   messages from one person cost three avatars and three names, and a 380px
 *   panel becomes mostly metadata.
 *
 * The actions menu is keyboard-reachable and not hover-only (§12.6): it is
 * always in the DOM, visually revealed on hover, and always revealed on focus.
 */
import { memo } from 'react';
import { AlertCircle, Flag, MoreHorizontal, Trash2 } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MessageText } from '@/components/room/chat/MessageText';
import type { ChatMessage as ChatMessageModel } from '@/lib/stores/room-store';
import { cn } from '@/lib/utils';

/** Absolute time on hover (§3.5 H2); the visible label stays short. */
function absolute(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export interface ChatMessageProps {
  message: ChatMessageModel;
  /** False when this message continues a run from the same author. */
  showHeader: boolean;
  isYou: boolean;
  canDelete: boolean;
  onSeek: ((seconds: number) => void) | null;
  onDelete: (messageId: string) => void;
  onReport: (message: ChatMessageModel) => void;
  onRetry: (message: ChatMessageModel) => void;
  onDiscard: (message: ChatMessageModel) => void;
}

function ChatMessageRow({
  message,
  showHeader,
  isYou,
  canDelete,
  onSeek,
  onDelete,
  onReport,
  onRetry,
  onDiscard,
}: ChatMessageProps) {
  if (message.kind === 'system') {
    return (
      <div className="px-4 py-1">
        <p className="text-center text-13 text-tertiary">{message.body}</p>
      </div>
    );
  }

  if (message.deletedAt !== null) {
    return (
      <div className={cn('px-3', showHeader ? 'pt-3' : 'pt-0.5')}>
        <p className="pl-9 text-13 italic text-tertiary">Message deleted</p>
      </div>
    );
  }

  const author = message.author;
  const name = author?.displayName ?? 'Former member';
  const failed = message.delivery === 'failed';
  const sending = message.delivery === 'sending';

  return (
    <div
      className={cn(
        'group/message relative px-3',
        showHeader ? 'pt-3' : 'pt-0.5',
        // A failed message is tinted rather than badged alone, because the row
        // is what the retry applies to and the row is what should look wrong.
        failed && 'bg-danger-subtle',
      )}
    >
      {showHeader ? (
        <div className="flex items-baseline gap-2 pl-9">
          <span className="-ml-9 self-center">
            <Avatar
              size={24}
              name={name}
              handle={author?.handle ?? 'unknown'}
              src={author?.avatarUrl}
            />
          </span>
          <span className="truncate text-13 font-medium text-primary">
            {name}
            {isYou ? <span className="font-normal text-tertiary"> · you</span> : null}
          </span>
          <time
            dateTime={new Date(message.createdAt).toISOString()}
            title={absolute(message.createdAt)}
            className="shrink-0 text-[11px] tabular-nums text-tertiary"
          >
            {clock(message.createdAt)}
          </time>
        </div>
      ) : null}

      <div className="flex items-start gap-2 pl-9">
        <p
          className={cn(
            'min-w-0 flex-1 text-13 leading-5 text-primary',
            sending && 'text-secondary',
          )}
        >
          <MessageText body={message.body} onSeek={onSeek} />
        </p>

        <div className="shrink-0 opacity-0 transition-opacity duration-120 ease-standard focus-within:opacity-100 group-hover/message:opacity-100">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`Actions for ${name}'s message`}
                className="inline-flex h-6 w-6 items-center justify-center rounded-md text-tertiary transition-colors duration-120 ease-standard hover:bg-surface-2 hover:text-secondary"
              >
                <MoreHorizontal size={14} strokeWidth={1.5} aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-40">
              {isYou || canDelete ? (
                <DropdownMenuItem onSelect={() => onDelete(message.id)}>
                  <Trash2 size={16} strokeWidth={1.5} aria-hidden="true" />
                  Delete
                </DropdownMenuItem>
              ) : null}
              {isYou ? null : (
                <DropdownMenuItem onSelect={() => onReport(message)}>
                  <Flag size={16} strokeWidth={1.5} aria-hidden="true" />
                  Report
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {failed ? (
        <p className="flex items-center gap-1.5 pb-1 pl-9 pt-1 text-13 text-danger">
          <AlertCircle size={13} strokeWidth={1.5} aria-hidden="true" />
          Not sent.
          <button
            type="button"
            onClick={() => onRetry(message)}
            className="underline underline-offset-2"
          >
            Retry
          </button>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            onClick={() => onDiscard(message)}
            className="underline underline-offset-2"
          >
            Discard
          </button>
        </p>
      ) : null}
    </div>
  );
}

/**
 * Memoised on the message object.
 *
 * The list re-renders on every arrival, and in a 500-message room that is 500
 * `tokenizeMessage` calls per keystroke of someone else's typing. The store
 * keeps object identity stable for messages that did not change, so this
 * comparison is the difference between linear and constant work per message.
 */
export const ChatMessageRowMemo = memo(ChatMessageRow);
