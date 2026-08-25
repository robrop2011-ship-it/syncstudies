'use client';

/**
 * "Ask a question at 41:12" (PLAN.md §2.5, §3.6 S3, §12.5).
 *
 * §2.5 calls this the retention feature, so it gets a real affordance in the
 * control bar *and* the `?` hotkey — not one or the other. The timestamp is
 * captured at the moment the dialog opens, not when it is submitted: someone
 * types for twenty seconds and means the moment they were confused by, not the
 * moment they finished writing about it.
 *
 * `?` is bound here rather than in a global shortcut map because the timestamp
 * has to come from the live playhead, which only the sync controller knows.
 *
 * That position is read by CALLING the controller, not by sampling
 * `usePlayheadRef()`. The ref is written by a requestAnimationFrame loop that
 * restarts whenever the controller is re-attached, so there is a window — small,
 * but real, and observed — where it still reads 0 while the video is minutes in.
 * A question pinned to 0:00 because of a dropped frame is a silent wrong answer;
 * `getPlayheadSec()` is synchronous and cannot be stale.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Bookmark, CircleHelp, NotebookPen, type LucideIcon } from 'lucide-react';
import { MAX_NOTE_LENGTH, formatTimestamp, type NoteItemView } from '@syncstudy/shared';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { useSocket } from '@/lib/socket/provider';
import { useMyPermissions, useRoomStoreApi } from '@/lib/stores/room-store';
import { useSyncController } from '@/lib/sync/useSyncController';
import { ackWithTimeout } from '@/components/room/socket-ack';
import { cn } from '@/lib/utils';

type Kind = NoteItemView['kind'];

const KINDS: { kind: Kind; label: string; icon: LucideIcon; hint: string }[] = [
  { kind: 'question', label: 'Question', icon: CircleHelp, hint: 'Something to come back to' },
  { kind: 'note', label: 'Note', icon: NotebookPen, hint: 'A thought at this moment' },
  { kind: 'bookmark', label: 'Bookmark', icon: Bookmark, hint: 'Mark this spot' },
];

export function AddNoteButton({ className }: { className?: string | undefined }) {
  const permissions = useMyPermissions();
  const controller = useSyncController();
  const socket = useSocket();
  const store = useRoomStoreApi();

  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>('question');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Frozen when the dialog opens. Null when there is no video to pin to. */
  const [atSec, setAtSec] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const canEdit = permissions?.canEditNotes ?? false;

  const openWith = useCallback(
    (nextKind: Kind) => {
      if (!canEdit) return;
      setKind(nextKind);
      setBody('');
      setError(null);
      setAtSec(controller === null ? null : Math.max(0, controller.getPlayheadSec()));
      setOpen(true);
    },
    [canEdit, controller],
  );

  // §12.5: `?` opens this at the current timestamp — unless focus is in a text
  // field, where `?` is a character somebody is trying to type.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== '?' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
      }
      event.preventDefault();
      openWith('question');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openWith]);

  const submit = async (): Promise<void> => {
    const trimmed = body.trim();
    if (socket === null || trimmed.length === 0 || busy) return;
    setBusy(true);
    setError(null);

    const ack = await ackWithTimeout<NoteItemView>((cb) =>
      socket.emit(
        'notes:item_create',
        { kind, body: trimmed, ...(atSec === null ? {} : { videoTs: Number(atSec.toFixed(2)) }) },
        cb,
      ),
    );
    setBusy(false);
    if (!ack.ok) {
      setError(ack.message);
      return;
    }
    // The sender is excluded from the broadcast, so the server's row lands here.
    store.getState().upsertNoteItem(ack.data);
    setOpen(false);
  };

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        className={cn('h-11 lg:h-9', className)}
        disabled={!canEdit}
        title={canEdit ? 'Ask a question at this timestamp — ?' : 'Your role cannot add notes'}
        onClick={() => openWith('question')}
      >
        <CircleHelp size={16} strokeWidth={1.5} aria-hidden="true" />
        <span className="hidden lg:inline">Question</span>
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
        }}
      >
        <DialogContent>
          <DialogTitle>
            {atSec === null ? 'Add to the notes' : `At ${formatTimestamp(atSec)}`}
          </DialogTitle>
          <DialogDescription>
            {atSec === null
              ? 'There is no video playing, so this will not be pinned to a timestamp.'
              : 'This becomes a tick on the scrubber. Anyone can click it to bring the room back here.'}
          </DialogDescription>

          <div className="flex flex-col gap-3 px-4 pb-1">
            <div className="flex gap-1.5" role="radiogroup" aria-label="Kind">
              {KINDS.map((option) => {
                const Icon = option.icon;
                const active = option.kind === kind;
                return (
                  <button
                    key={option.kind}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    title={option.hint}
                    onClick={() => setKind(option.kind)}
                    className={cn(
                      'inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-13',
                      'transition-colors duration-120 ease-standard',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                      active
                        ? 'border-accent bg-accent-subtle text-primary'
                        : 'border-border-strong text-secondary hover:bg-surface-2',
                    )}
                  >
                    <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
                    {option.label}
                  </button>
                );
              })}
            </div>

            <Textarea
              ref={textareaRef}
              autoFocus
              rows={3}
              value={body}
              maxLength={MAX_NOTE_LENGTH}
              aria-label={kind}
              placeholder={
                kind === 'question'
                  ? 'What did not make sense here?'
                  : kind === 'note'
                    ? 'What is worth remembering?'
                    : 'What is this spot?'
              }
              onChange={(event) => setBody(event.target.value)}
              onKeyDown={(event) => {
                // Enter sends, Shift+Enter breaks the line — the same contract
                // as the chat composer, so there is one habit to learn.
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />

            {error !== null ? <Callout tone="danger">{error}</Callout> : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              loading={busy}
              disabled={busy || body.trim().length === 0}
              onClick={() => {
                void submit();
              }}
            >
              Pin it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
