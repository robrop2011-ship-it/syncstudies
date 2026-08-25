'use client';

/**
 * The shared document (PLAN.md §8.12, §3.6 S1).
 *
 * One textarea per paragraph, not one for the whole document. That is the whole
 * concurrency design made visible: a block is the unit that gets locked, the
 * unit that carries a version, and the unit a conflict duplicates. A single
 * textarea over the whole document would make every keystroke a whole-document
 * write and every simultaneous edit a whole-document conflict.
 *
 * Three behaviours to know about:
 *
 *  - **Focus takes a soft lock**, refreshed while typing. Other people see
 *    "Priya is editing" and the block goes read-only for them. It is advisory:
 *    the version check on update is what actually protects the text, because a
 *    lock that expires mid-sentence must never be able to lose work.
 *  - **Updates go out on 800 ms idle and on blur**, never per keystroke.
 *  - **A conflict is not an error.** The server keeps its copy, preserves yours
 *    as a new paragraph below, and this component says so in one line rather
 *    than throwing a dialog at someone who was in the middle of a sentence.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { NotebookPen, Plus } from 'lucide-react';
import { uuidv7, type NoteBlockView } from '@syncstudy/shared';
import { Button } from '@/components/ui/button';
import { useSocket } from '@/lib/socket/provider';
import { useNoteBlocks, useRoomStore, useRoomStoreApi } from '@/lib/stores/room-store';
import { ackWithTimeout } from '@/components/room/socket-ack';
import { cn } from '@/lib/utils';

/** §8.12: "on blur or 800 ms idle". */
const IDLE_MS = 800;
/** The lock lives 8 s; refresh well inside that while someone is still typing. */
const LOCK_REFRESH_MS = 4_000;

export function NotesDoc({ youId, canEdit }: { youId: string; canEdit: boolean }) {
  const blocks = useNoteBlocks();
  const addLocalBlock = useRoomStore((s) => s.addLocalBlock);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const addBlock = useCallback(() => {
    // The id is minted here and the server treats the first update for an
    // unknown id as a creation, so starting a paragraph costs no round trip and
    // you can type into it immediately.
    const position = (blocks[blocks.length - 1]?.position ?? 0) + 1;
    addLocalBlock({ id: uuidv7(), text: '', version: 0, position });
  }, [blocks, addLocalBlock]);

  if (!canEdit && blocks.length === 0) {
    return (
      <p className="px-3 py-2 text-13 text-tertiary">
        Nobody has written anything yet, and your role cannot edit these notes.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      {blocks.length === 0 ? (
        <p className="px-3 pb-1 text-13 text-tertiary">
          One document, everyone in the room can edit it. Start a paragraph and it appears on
          everyone else&rsquo;s screen as you type.
        </p>
      ) : null}

      {blocks.map((block) => (
        <BlockEditor
          key={block.id}
          block={block}
          youId={youId}
          canEdit={canEdit}
          onSaved={() => setSavedAt(Date.now())}
        />
      ))}

      {canEdit ? (
        <div className="flex items-center gap-2 px-3 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={addBlock}>
            <Plus size={16} strokeWidth={1.5} aria-hidden="true" />
            Add a paragraph
          </Button>
          {/* An autosave indicator, not a spinner: saving is the normal state
              and it finishes in milliseconds (§12.1 rule 11). */}
          <SavedIndicator at={savedAt} />
        </div>
      ) : null}
    </div>
  );
}

function SavedIndicator({ at }: { at: number | null }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (at === null) return;
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), 2_000);
    return () => clearTimeout(timer);
  }, [at]);

  if (!visible) return null;
  return (
    <span className="text-13 text-tertiary" role="status">
      Saved
    </span>
  );
}

function BlockEditor({
  block,
  youId,
  canEdit,
  onSaved,
}: {
  block: NoteBlockView;
  youId: string;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const socket = useSocket();
  const store = useRoomStoreApi();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [draft, setDraft] = useState(block.text);
  const [editing, setEditing] = useState(false);
  const [conflict, setConflict] = useState(false);

  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lockTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  /** The version this client's draft is based on. Not state: it changes per ack. */
  const baseVersion = useRef(block.version);
  const editingRef = useRef(false);
  editingRef.current = editing;

  // A remote edit only overwrites the draft when this client is NOT editing.
  // Clobbering someone mid-sentence because a broadcast arrived is exactly the
  // failure the block lock exists to make rare and this guard makes impossible.
  useEffect(() => {
    if (editingRef.current) return;
    setDraft(block.text);
    baseVersion.current = block.version;
  }, [block.text, block.version]);

  const editor = useRoomStore((s) => {
    const lock = s.blockLocks[block.id];
    if (lock === undefined || lock.userId === youId) return null;
    if (lock.untilServerMs <= Date.now() + s.serverTimeOffsetMs) return null;
    return s.participants.find((p) => p.id === lock.userId)?.displayName ?? null;
  });

  const send = useCallback(async () => {
    if (socket === null) return;
    const text = textareaRef.current?.value ?? draft;
    if (text === block.text && block.version !== 0) return;

    const ack = await ackWithTimeout<{ version: number; winning?: string }>((cb) =>
      socket.emit(
        'notes:block_update',
        { blockId: block.id, text, baseVersion: baseVersion.current },
        cb,
      ),
    );
    if (!ack.ok) return;

    if (ack.data?.winning !== undefined) {
      // §8.12: somebody else's edit landed first. Their text is what the
      // paragraph now says; ours was preserved as a new paragraph below, which
      // has already arrived as a `notes:block_updated`.
      setConflict(true);
      setDraft(ack.data.winning);
      setEditing(false);
      return;
    }
    baseVersion.current += 1;
    // The store never hears our own update over the wire — the server does not
    // echo it back to the sender — so this client applies it locally.
    store.getState().applyBlockUpdate({ ...block, text, version: baseVersion.current });
    onSaved();
  }, [socket, draft, block, store, onSaved]);

  const scheduleSend = useCallback(() => {
    if (idleTimer.current !== null) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      idleTimer.current = null;
      void send();
    }, IDLE_MS);
  }, [send]);

  const beginEditing = useCallback(() => {
    if (!canEdit || socket === null) return;
    setEditing(true);
    setConflict(false);
    socket.emit('notes:block_focus', { blockId: block.id });
    if (lockTimer.current === null) {
      lockTimer.current = setInterval(() => {
        socket.emit('notes:block_focus', { blockId: block.id });
      }, LOCK_REFRESH_MS);
    }
  }, [canEdit, socket, block.id]);

  const endEditing = useCallback(() => {
    setEditing(false);
    if (lockTimer.current !== null) {
      clearInterval(lockTimer.current);
      lockTimer.current = null;
    }
    if (idleTimer.current !== null) {
      clearTimeout(idleTimer.current);
      idleTimer.current = null;
    }
    void send();
  }, [send]);

  useEffect(
    () => () => {
      if (lockTimer.current !== null) clearInterval(lockTimer.current);
      if (idleTimer.current !== null) clearTimeout(idleTimer.current);
    },
    [],
  );

  const locked = editor !== null;
  const readOnly = !canEdit || locked;

  return (
    <div className="px-3">
      <textarea
        ref={textareaRef}
        value={draft}
        readOnly={readOnly}
        aria-label="Shared notes paragraph"
        rows={Math.min(12, Math.max(2, draft.split('\n').length + 1))}
        placeholder={canEdit ? 'Write here…' : undefined}
        onFocus={beginEditing}
        onBlur={endEditing}
        onChange={(event) => {
          setDraft(event.target.value);
          scheduleSend();
        }}
        className={cn(
          'ss-scroll w-full resize-none rounded-md border bg-transparent px-2 py-1.5 text-13 leading-relaxed text-primary',
          'transition-colors duration-120 ease-standard',
          'placeholder:text-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          readOnly ? 'border-transparent' : 'border-border hover:border-border-strong',
          locked ? 'opacity-70' : null,
        )}
      />
      {locked ? (
        <p className="flex items-center gap-1 px-2 pb-1 text-[11px] text-tertiary">
          <NotebookPen size={12} strokeWidth={1.5} aria-hidden="true" />
          {editor} is editing
        </p>
      ) : null}
      {conflict ? (
        <p className="px-2 pb-1 text-[11px] text-warning" role="status">
          Someone edited this at the same time. Their version is here; yours was kept as a new
          paragraph below.
        </p>
      ) : null}
    </div>
  );
}
