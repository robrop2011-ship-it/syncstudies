'use client';

/**
 * The room sidebar (PLAN.md §12.4, §5.4).
 *
 * Tabs, not three stacked panels: three panels inside 380px means all three are
 * useless. People, Chat and Notes are all live.
 *
 * §5.4 requires the panels to be hidden with CSS rather than unmounted, so a
 * chat scroll position and a notes cursor survive a tab switch. `forceMount`
 * plus Radix's `hidden` attribute is exactly that.
 *
 * One consequence of `forceMount` is load-bearing for chat: the transcript is
 * mounted from the moment the room opens, whether or not anyone has looked at
 * the tab. That is what lets the unread badge below be true — a panel that
 * mounted on first click would have nothing to count.
 */
import { useEffect, useRef, useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ParticipantCount, ParticipantList } from '@/components/room/ParticipantList';
import { ChatPanel } from '@/components/room/chat/ChatPanel';
import { FOCUS_CHAT_EVENT } from '@/components/room/ShortcutSheet';
import { NotesPanel } from '@/components/room/notes/NotesPanel';
import { useMessages } from '@/lib/stores/room-store';
import { cn } from '@/lib/utils';

type Panel = 'people' | 'chat' | 'notes';

const PANEL_CLASS =
  'ss-scroll min-h-0 flex-1 overflow-y-auto data-[state=inactive]:hidden';

export function RoomSidebar({
  youId,
  hostId,
  loading,
  canSeek,
  onSeek,
  className,
}: {
  youId: string;
  hostId: string;
  loading: boolean;
  /** §3.6 S4: whether this client may take the room to a pinned timestamp. */
  canSeek: boolean;
  onSeek: (positionSec: number) => void;
  className?: string | undefined;
}) {
  const [panel, setPanel] = useState<Panel>('people');
  const unread = useUnreadChat(panel === 'chat', youId);

  // §12.5's `/`. The tab has to be switched here — the panels are kept mounted
  // but hidden, and focusing a `display: none` textarea does nothing at all.
  useEffect(() => {
    const onFocusChat = (): void => {
      setPanel('chat');
      // After the tab has actually been shown, not before.
      requestAnimationFrame(() => {
        document.querySelector<HTMLTextAreaElement>('[aria-label="Message the room"]')?.focus();
      });
    };
    window.addEventListener(FOCUS_CHAT_EVENT, onFocusChat);
    return () => window.removeEventListener(FOCUS_CHAT_EVENT, onFocusChat);
  }, []);

  return (
    <aside
      aria-label="Room panels"
      className={cn('flex min-h-0 flex-col bg-surface-1', className)}
    >
      <Tabs
        value={panel}
        onValueChange={(value) => setPanel(value as Panel)}
        className="flex min-h-0 flex-1 flex-col"
      >
        {/* 48px to match the top bar. `items-end` keeps the 36px triggers on the
            list's bottom border, so the active underline sits on it rather than
            floating 12px above it. */}
        <TabsList className="h-12 shrink-0 items-end px-2">
          <TabsTrigger value="people">
            People
            <ParticipantCount className="text-tertiary" />
          </TabsTrigger>
          <TabsTrigger value="chat">
            Chat
            {unread > 0 ? (
              <span
                className="ml-1.5 rounded-sm bg-accent px-1 text-[11px] tabular-nums text-accent-text"
                aria-label={`${unread} unread messages`}
              >
                {unread > 99 ? '99+' : unread}
              </span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="notes">Notes</TabsTrigger>
        </TabsList>

        <TabsContent forceMount value="people" className={PANEL_CLASS}>
          <ParticipantList youId={youId} hostId={hostId} loading={loading} />
        </TabsContent>

        {/* `overflow-hidden`, not the shared scrolling class: the transcript
            owns its own scroller so it can control the scroll position. */}
        <TabsContent
          forceMount
          value="chat"
          className="flex min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden"
        >
          <ChatPanel youId={youId} />
        </TabsContent>

        <TabsContent forceMount value="notes" className={PANEL_CLASS}>
          <NotesPanel youId={youId} canSeek={canSeek} onSeek={onSeek} />
        </TabsContent>
      </Tabs>
    </aside>
  );
}

/**
 * Messages that arrived while the Chat tab was not the one being looked at.
 *
 * Counts arrivals rather than diffing lengths against a stored id: a history
 * page prepended by a scroll-up also grows the array, and a badge that counted
 * those would tell someone they have eleven unread messages from 2019. Only the
 * newest id moving forward means something new arrived.
 */
function useUnreadChat(active: boolean, youId: string): number {
  const messages = useMessages();
  const [unread, setUnread] = useState(0);
  const lastSeenRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const newest = messages[messages.length - 1];
    const previous = lastSeenRef.current;
    lastSeenRef.current = newest?.id;

    if (active) {
      setUnread(0);
      return;
    }
    if (newest === undefined || newest.id === previous) return;
    // Your own message is not something you have to catch up on, and neither is
    // a system line about someone joining.
    if (newest.author?.id === youId || newest.kind === 'system') return;
    setUnread((n) => n + 1);
  }, [messages, active, youId]);

  return unread;
}
