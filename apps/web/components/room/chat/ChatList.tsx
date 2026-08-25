'use client';

/**
 * The transcript (PLAN.md §14 Phase 5.3/5.5, §5.4).
 *
 * Three scroll behaviours, and each one is a bug if it is missing:
 *
 * 1. **Stick to the bottom, but only if you were already there.** A new message
 *    must not yank the view away from someone reading history. "At the bottom"
 *    is a tolerance, not an equality — sub-pixel scroll heights and a fractional
 *    device pixel ratio make `scrollTop + clientHeight === scrollHeight` false on
 *    a list that is visibly at the bottom.
 * 2. **Preserve the reading position when older messages are prepended.** The
 *    anchor is the distance from the BOTTOM of the content, not `scrollTop`:
 *    prepending changes every offset above the viewport and none below it, so
 *    distance-from-bottom is the one quantity the operation cannot disturb. It
 *    is re-applied across a few frames because the virtualizer measures rows
 *    after paint, and each measurement moves `scrollHeight` again.
 * 3. **Load the next page before the user hits the ceiling**, so a fast scroll
 *    does not stop dead at the top waiting for a fetch.
 *
 * Virtualized throughout rather than above a threshold: two rendering paths
 * would mean the scroll logic above has to be right twice, and it is the part
 * that is hard to get right once.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { ChatMessageRowMemo } from '@/components/room/chat/ChatMessage';
import type { ChatMessage, ChatHistory } from '@/lib/stores/room-store';
import { cn } from '@/lib/utils';

/** Below this many pixels from the bottom, new messages scroll the view. */
const STICK_TOLERANCE_PX = 48;
/** Start fetching the previous page this far from the top. */
const LOAD_TRIGGER_PX = 240;
/** A one-line message with no header. Only an estimate; rows are measured. */
const ESTIMATED_ROW_PX = 32;

/** Two messages from the same person this close together render as one block. */
const GROUP_WINDOW_MS = 2 * 60 * 1000;

function startsBlock(message: ChatMessage, previous: ChatMessage | undefined): boolean {
  if (message.kind === 'system') return true;
  if (previous === undefined || previous.kind === 'system') return true;
  if (previous.author?.id !== message.author?.id) return true;
  return message.createdAt - previous.createdAt > GROUP_WINDOW_MS;
}

export interface ChatListProps {
  messages: ChatMessage[];
  history: ChatHistory;
  youId: string;
  canDeleteAny: boolean;
  onSeek: ((seconds: number) => void) | null;
  onLoadOlder: () => void;
  onDelete: (messageId: string) => void;
  onReport: (message: ChatMessage) => void;
  onRetry: (message: ChatMessage) => void;
  onDiscard: (message: ChatMessage) => void;
}

export function ChatList({
  messages,
  history,
  youId,
  canDeleteAny,
  onSeek,
  onLoadOlder,
  onDelete,
  onReport,
  onRetry,
  onDiscard,
}: ChatListProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [stuck, setStuck] = useState(true);
  const [unread, setUnread] = useState(0);

  /** Distance from the bottom to restore after a prepend. See rule 2. */
  const restoreRef = useRef<number | null>(null);
  const previousCountRef = useRef(messages.length);
  const previousOldestRef = useRef<string | undefined>(messages[0]?.id);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_PX,
    overscan: 12,
    // Keyed by message id so a prepend does not make the virtualizer believe
    // every row changed size; only the new rows are unmeasured.
    getItemKey: (index) => messages[index]?.id ?? index,
  });

  const scrollToBottom = useCallback((): void => {
    const element = scrollRef.current;
    if (element === null) return;
    element.scrollTop = element.scrollHeight;
    setUnread(0);
    setStuck(true);
  }, []);

  const onScroll = useCallback((): void => {
    const element = scrollRef.current;
    if (element === null) return;

    const fromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    const atBottom = fromBottom <= STICK_TOLERANCE_PX;
    setStuck(atBottom);
    if (atBottom) setUnread(0);

    if (element.scrollTop <= LOAD_TRIGGER_PX && history.hasMore && !history.loading) {
      restoreRef.current = element.scrollHeight - element.scrollTop;
      onLoadOlder();
    }
  }, [history.hasMore, history.loading, onLoadOlder]);

  // Everything that reacts to the list changing, in ONE layout effect and in
  // this order: restore first (a prepend must not be treated as an arrival),
  // then stick, then count what the reader has not seen.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;

    const previousCount = previousCountRef.current;
    const previousOldest = previousOldestRef.current;
    previousCountRef.current = messages.length;
    previousOldestRef.current = messages[0]?.id;

    const prepended = previousOldest !== undefined && messages[0]?.id !== previousOldest;
    const added = messages.length - previousCount;

    if (prepended && restoreRef.current !== null) {
      const target = restoreRef.current;
      const apply = (): void => {
        const el = scrollRef.current;
        if (el === null) return;
        el.scrollTop = el.scrollHeight - target;
      };
      apply();
      // Rows are measured after paint, so `scrollHeight` grows for a frame or
      // two afterwards. Re-applying is cheaper and steadier than trying to
      // predict the final height.
      const frame1 = requestAnimationFrame(() => {
        apply();
        requestAnimationFrame(() => {
          apply();
          restoreRef.current = null;
        });
      });
      return () => cancelAnimationFrame(frame1);
    }

    if (added <= 0) return;

    if (stuck) {
      element.scrollTop = element.scrollHeight;
      return;
    }
    setUnread((n) => n + added);
    return;
  }, [messages, stuck]);

  // First paint lands at the newest message, which is where a chat opens.
  useEffect(() => {
    scrollToBottom();
    // Deliberately once: this is the mount behaviour, not a subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const items = virtualizer.getVirtualItems();

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div ref={scrollRef} onScroll={onScroll} className="ss-scroll min-h-0 flex-1 overflow-y-auto">
        {history.loading ? (
          <p className="flex items-center justify-center gap-2 py-3 text-13 text-tertiary">
            <Spinner size={14} />
            Loading earlier messages…
          </p>
        ) : null}

        {history.error !== null ? (
          <p className="px-3 py-2 text-center text-13 text-danger">
            {history.error}{' '}
            <button type="button" onClick={onLoadOlder} className="underline underline-offset-2">
              Try again
            </button>
          </p>
        ) : null}

        {!history.hasMore && !history.loading && messages.length > 0 ? (
          <p className="px-3 py-3 text-center text-13 text-tertiary">
            This is the beginning of the room.
          </p>
        ) : null}

        <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
          {items.map((item) => {
            const message = messages[item.index];
            if (message === undefined) return null;
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${item.start}px)`,
                }}
              >
                <ChatMessageRowMemo
                  message={message}
                  showHeader={startsBlock(message, messages[item.index - 1])}
                  isYou={message.author?.id === youId}
                  canDelete={canDeleteAny}
                  onSeek={onSeek}
                  onDelete={onDelete}
                  onReport={onReport}
                  onRetry={onRetry}
                  onDiscard={onDiscard}
                />
              </div>
            );
          })}
        </div>

        {/* A little breathing room under the last message, inside the scroller
            so it is part of what "at the bottom" means. */}
        <div className="h-2" />
      </div>

      {unread > 0 ? (
        <button
          type="button"
          onClick={scrollToBottom}
          className={cn(
            'absolute inset-x-0 bottom-2 mx-auto flex w-fit items-center gap-1.5',
            'rounded-md border border-border-strong bg-surface-1 px-3 py-1.5 text-13 text-primary',
            'transition-colors duration-120 ease-standard hover:bg-surface-2',
          )}
        >
          <ArrowDown size={14} strokeWidth={1.5} aria-hidden="true" />
          {unread === 1 ? '1 new message' : `${unread} new messages`}
        </button>
      ) : null}
    </div>
  );
}
