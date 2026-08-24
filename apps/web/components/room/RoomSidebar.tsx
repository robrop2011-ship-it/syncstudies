'use client';

/**
 * The room sidebar (PLAN.md §12.4, §5.4).
 *
 * Tabs, not three stacked panels: three panels inside 380px means all three are
 * useless. People is live from the socket; Chat and Notes are Phase 5 and Phase 7
 * and say so rather than showing a fake message list with fake names in it.
 *
 * §5.4 requires the panels to be hidden with CSS rather than unmounted, so a
 * chat scroll position and a notes cursor survive a tab switch. `forceMount`
 * plus Radix's `hidden` attribute is exactly that, and the habit is set here in
 * Phase 3 so Phase 5 doesn't have to remember it.
 */
import { useState, type ReactNode } from 'react';
import { MessageSquare, NotebookPen } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ParticipantCount, ParticipantList } from '@/components/room/ParticipantList';
import { cn } from '@/lib/utils';

type Panel = 'people' | 'chat' | 'notes';

const PANEL_CLASS =
  'ss-scroll min-h-0 flex-1 overflow-y-auto data-[state=inactive]:hidden';

export function RoomSidebar({
  youId,
  hostId,
  loading,
  className,
}: {
  youId: string;
  hostId: string;
  loading: boolean;
  className?: string | undefined;
}) {
  const [panel, setPanel] = useState<Panel>('people');

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
          <TabsTrigger value="chat">Chat</TabsTrigger>
          <TabsTrigger value="notes">Notes</TabsTrigger>
        </TabsList>

        <TabsContent forceMount value="people" className={PANEL_CLASS}>
          <ParticipantList youId={youId} hostId={hostId} loading={loading} />
        </TabsContent>

        <TabsContent forceMount value="chat" className={PANEL_CLASS}>
          <PhaseNotice
            icon={<MessageSquare size={16} strokeWidth={1.5} aria-hidden="true" />}
            title="Chat arrives in Phase 5"
            body="Messages, replies and timestamped questions land here. The socket handlers for them are not built yet."
          />
        </TabsContent>

        <TabsContent forceMount value="notes" className={PANEL_CLASS}>
          <PhaseNotice
            icon={<NotebookPen size={16} strokeWidth={1.5} aria-hidden="true" />}
            title="Shared notes arrive in Phase 7"
            body="One document everyone in the room can edit, plus a checklist and the questions people asked at a timestamp."
          />
        </TabsContent>
      </Tabs>
    </aside>
  );
}

/**
 * An honest empty state: what goes here, and when. No skeleton — a skeleton
 * promises content is on its way in a moment, and this content is weeks away.
 */
function PhaseNotice({
  icon,
  title,
  body,
}: {
  icon: ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <span className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border-strong text-tertiary">
        {icon}
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-13 font-medium text-primary">{title}</p>
        <p className="text-13 text-secondary">{body}</p>
      </div>
    </div>
  );
}
