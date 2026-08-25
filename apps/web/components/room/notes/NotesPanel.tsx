'use client';

/**
 * The Notes tab (PLAN.md §3.6, §12.4).
 *
 * Three sections in one scroller, not three nested tabs. §12.4's argument
 * against stacked panels was about panels that each want the full height —
 * these do not: a checklist is six lines, the pinned items are a short list, and
 * the document is the only thing that grows. Nesting tabs inside a tab would
 * also mean a person has to remember which of six places they left something.
 *
 * Each section carries its own heading, so the panel is navigable by heading in
 * a screen reader rather than being one undifferentiated region.
 */
import type { ReactNode } from 'react';
import { useMyPermissions } from '@/lib/stores/room-store';
import { NotesDoc } from './NotesDoc';
import { NoteItems } from './NoteItems';
import { Checklist } from './Checklist';

export function NotesPanel({
  youId,
  canSeek,
  onSeek,
}: {
  youId: string;
  canSeek: boolean;
  onSeek: (positionSec: number) => void;
}) {
  const permissions = useMyPermissions();
  const canEditNotes = permissions?.canEditNotes ?? false;
  const canEditChecklist = permissions?.canEditChecklist ?? false;

  return (
    <div className="flex flex-col gap-4 py-3">
      <Section title="Shared notes">
        <NotesDoc youId={youId} canEdit={canEditNotes} />
      </Section>

      <Section title="Pinned to the video">
        <NoteItems youId={youId} canSeek={canSeek} onSeek={onSeek} />
      </Section>

      <Section title="Checklist">
        <Checklist youId={youId} canEdit={canEditChecklist} />
      </Section>
    </div>
  );
}

/** 11px/500/0.04em — the one place §12.1 rule 7 permits an all-caps label. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="px-3 text-[11px] font-medium uppercase tracking-[0.04em] text-tertiary">
        {title}
      </h3>
      {children}
    </section>
  );
}
