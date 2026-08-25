'use client';

/**
 * The shared checklist (PLAN.md §3.6 S6).
 *
 * Anyone in the room can tick an item; the completion is attributed, because a
 * shared checklist with anonymous ticks is a checklist nobody trusts. Ordering
 * is a fractional index, so a reorder is one UPDATE — and the move controls are
 * buttons rather than a drag handle: drag-and-drop with no keyboard equivalent
 * is a control half the room cannot use, and the list is six items long.
 *
 * The tick is optimistic and the server's echo is authoritative: it carries the
 * completer's name, which the client cannot know until a write has actually
 * landed (two people ticking at once converge on whoever's write was second).
 */
import { useState } from 'react';
import { ArrowDown, ArrowUp, Check, Plus, Trash2 } from 'lucide-react';
import { MAX_CHECKLIST_LABEL, type ChecklistItemView } from '@syncstudy/shared';
import { Button } from '@/components/ui/button';
import { useSocket } from '@/lib/socket/provider';
import { useChecklist, useMyPermissions, useRoomStoreApi } from '@/lib/stores/room-store';
import { ackWithTimeout } from '@/components/room/socket-ack';
import { cn } from '@/lib/utils';

export function Checklist({ youId, canEdit }: { youId: string; canEdit: boolean }) {
  const items = useChecklist();
  const socket = useSocket();
  const store = useRoomStoreApi();
  const permissions = useMyPermissions();
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async (): Promise<void> => {
    const trimmed = label.trim();
    if (socket === null || trimmed.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    const ack = await ackWithTimeout<ChecklistItemView>((cb) =>
      socket.emit('checklist:create', { label: trimmed }, cb),
    );
    setBusy(false);
    if (!ack.ok) {
      setError(ack.message);
      return;
    }
    // The sender is excluded from the broadcast, so apply the server's row here.
    store.getState().upsertChecklistItem(ack.data);
    setLabel('');
  };

  const toggle = (item: ChecklistItemView): void => {
    if (socket === null) return;
    void ackWithTimeout((cb) =>
      socket.emit('checklist:toggle', { id: item.id, completed: item.completedAt === null }, cb),
    );
  };

  const remove = (id: string): void => {
    if (socket === null) return;
    void ackWithTimeout((cb) => socket.emit('checklist:delete', { id }, cb));
  };

  /**
   * Move one place, by writing a position midway between its two new
   * neighbours. Fractional indices mean this touches one row rather than
   * renumbering the list, which is the whole reason `position` is a float.
   */
  const move = (index: number, direction: -1 | 1): void => {
    if (socket === null) return;
    const item = items[index];
    const target = items[index + direction];
    if (item === undefined || target === undefined) return;
    const beyond = items[index + direction * 2];
    const position =
      beyond === undefined ? target.position + direction : (target.position + beyond.position) / 2;

    store.getState().upsertChecklistItem({ ...item, position });
    void ackWithTimeout((cb) => socket.emit('checklist:reorder', { id: item.id, position }, cb));
  };

  const done = items.filter((item) => item.completedAt !== null).length;

  return (
    <div className="flex flex-col gap-1">
      {items.length === 0 ? (
        <p className="px-3 text-13 text-tertiary">
          A shared to-do list for this session. Anyone can tick an item off.
        </p>
      ) : (
        <>
          <p className="px-3 text-[11px] text-tertiary" role="status">
            {done} of {items.length} done
          </p>
          <ul className="flex flex-col">
            {items.map((item, index) => (
              <li
                key={item.id}
                className="flex items-start gap-2 rounded-sm px-3 py-1 transition-colors duration-120 ease-standard hover:bg-surface-2"
              >
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={item.completedAt !== null}
                  aria-label={item.label}
                  disabled={!canEdit}
                  onClick={() => toggle(item)}
                  className={cn(
                    'mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border',
                    'transition-colors duration-120 ease-standard',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                    'disabled:pointer-events-none disabled:opacity-50',
                    item.completedAt === null
                      ? 'border-border-strong hover:bg-surface-3'
                      : 'border-accent bg-accent text-accent-text',
                  )}
                >
                  {item.completedAt === null ? null : (
                    <Check size={12} strokeWidth={2} aria-hidden="true" />
                  )}
                </button>

                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      'block text-13',
                      item.completedAt === null ? 'text-primary' : 'text-tertiary line-through',
                    )}
                  >
                    {item.label}
                  </span>
                  {item.completedBy === null ? null : (
                    <span className="block text-[11px] text-tertiary">
                      {item.completedBy.id === youId ? 'You' : item.completedBy.displayName} ticked
                      this
                    </span>
                  )}
                </span>

                {canEdit ? (
                  <span className="flex shrink-0 items-center gap-0.5">
                    <MoveButton
                      label="Move up"
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    >
                      <ArrowUp size={14} strokeWidth={1.5} aria-hidden="true" />
                    </MoveButton>
                    <MoveButton
                      label="Move down"
                      disabled={index === items.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <ArrowDown size={14} strokeWidth={1.5} aria-hidden="true" />
                    </MoveButton>
                    {item.createdBy?.id === youId || permissions?.canDeleteAnyMessage === true ? (
                      <MoveButton label="Delete" disabled={false} onClick={() => remove(item.id)}>
                        <Trash2 size={14} strokeWidth={1.5} aria-hidden="true" />
                      </MoveButton>
                    ) : null}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}

      {canEdit ? (
        <form
          className="flex items-center gap-1.5 px-3 pt-1"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <input
            value={label}
            maxLength={MAX_CHECKLIST_LABEL}
            placeholder="Add an item…"
            aria-label="New checklist item"
            onChange={(event) => setLabel(event.target.value)}
            className={cn(
              'min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 py-1 text-13 text-primary',
              'placeholder:text-tertiary focus-visible:border-accent focus-visible:outline-none',
              'transition-colors duration-120 ease-standard',
            )}
          />
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            loading={busy}
            disabled={label.trim().length === 0 || busy}
          >
            <Plus size={16} strokeWidth={1.5} aria-hidden="true" />
            Add
          </Button>
        </form>
      ) : null}

      {error !== null ? (
        <p className="px-3 text-13 text-danger" role="status">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function MoveButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex h-6 w-6 items-center justify-center rounded-sm text-tertiary',
        'transition-colors duration-120 ease-standard hover:bg-surface-3 hover:text-secondary',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        'disabled:pointer-events-none disabled:opacity-30',
      )}
    >
      {children}
    </button>
  );
}
