'use client';

/**
 * The message box (PLAN.md §3.5 H1/H6, §12.1, §12.5, §12.6).
 *
 * Enter sends, Shift+Enter is a newline — the convention every chat client
 * shares, and the one people's fingers already know. IME composition is checked
 * before either: pressing Enter to accept a Japanese candidate must not post a
 * half-finished sentence.
 *
 * The counter appears only near the limit. A number that is visible from the
 * first keystroke reads as a warning, and there is nothing to warn about at
 * eleven characters out of two thousand.
 *
 * The clock button inserts `@mm:ss` at the caret. Without it, §3.5 H6 is a
 * feature nobody discovers: linkifying a timestamp is only useful once somebody
 * knows they can type one.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Clock, SendHorizontal } from 'lucide-react';
import { MAX_MESSAGE_LENGTH, formatTimestamp } from '@syncstudy/shared';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** Show the counter once this close to the ceiling. */
const COUNTER_AT = 200;
/** Grow to about six lines, then scroll — the panel is 380px wide, not tall. */
const MAX_ROWS_PX = 132;

export function ChatComposer({
  disabled,
  disabledReason,
  playheadSec,
  onSend,
}: {
  disabled: boolean;
  /** Said in text, not only conveyed by the greyed-out control (§12.6). */
  disabledReason: string | null;
  /** Null when there is no video loaded; hides the timestamp affordance. */
  playheadSec: (() => number) | null;
  onSend: (body: string) => void;
}) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-grow. Reset to `auto` first or the box can only ever get taller:
  // `scrollHeight` of an element already sized to its content is that size.
  useEffect(() => {
    const element = textareaRef.current;
    if (element === null) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, MAX_ROWS_PX)}px`;
  }, [value]);

  const trimmed = value.trim();
  const remaining = MAX_MESSAGE_LENGTH - value.length;
  const tooLong = remaining < 0;
  const canSend = !disabled && trimmed.length > 0 && !tooLong;

  function send(): void {
    if (!canSend) return;
    onSend(trimmed);
    setValue('');
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // `nativeEvent.isComposing` is the only reliable IME check; `keyCode === 229`
    // is the older spelling of the same thing and is not present everywhere.
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  }

  function insertTimestamp(): void {
    if (playheadSec === null) return;
    const stamp = `@${formatTimestamp(playheadSec())}`;
    const element = textareaRef.current;
    if (element === null) {
      setValue((current) => `${current}${stamp} `);
      return;
    }
    const start = element.selectionStart;
    const end = element.selectionEnd;
    const next = `${value.slice(0, start)}${stamp} ${value.slice(end)}`;
    setValue(next);
    // Put the caret after what was just inserted, on the next frame — React has
    // not written the new value into the DOM yet.
    requestAnimationFrame(() => {
      const caret = start + stamp.length + 1;
      element.focus();
      element.setSelectionRange(caret, caret);
    });
  }

  return (
    <div className="shrink-0 border-t border-border bg-surface-1 p-2">
      {disabledReason !== null ? (
        <p className="px-1 pb-2 text-13 text-tertiary">{disabledReason}</p>
      ) : null}

      <div
        className={cn(
          'flex items-end gap-1 rounded-md border bg-bg px-1 py-1',
          'transition-colors duration-120 ease-standard focus-within:border-accent',
          tooLong ? 'border-danger' : 'border-border-strong',
        )}
      >
        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          disabled={disabled}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={disabled ? 'Chat is unavailable' : 'Message the room'}
          aria-label="Message the room"
          aria-invalid={tooLong || undefined}
          className={cn(
            'ss-scroll min-w-0 flex-1 resize-none bg-transparent px-2 py-1.5 text-13 leading-5 text-primary',
            'placeholder:text-tertiary focus-visible:outline-none',
            'disabled:cursor-not-allowed disabled:text-tertiary',
          )}
        />

        {playheadSec !== null && !disabled ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={insertTimestamp}
                aria-label="Insert the current video time"
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-tertiary transition-colors duration-120 ease-standard hover:bg-surface-2 hover:text-secondary"
              >
                <Clock size={16} strokeWidth={1.5} aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Insert the current time — clicking it seeks the room</TooltipContent>
          </Tooltip>
        ) : null}

        <button
          type="button"
          onClick={send}
          disabled={!canSend}
          aria-label="Send message"
          className={cn(
            'inline-flex h-8 w-8 items-center justify-center rounded-md',
            'transition-colors duration-120 ease-standard',
            canSend
              ? 'bg-accent text-accent-text hover:bg-accent-hover'
              : 'cursor-not-allowed text-tertiary',
          )}
        >
          <SendHorizontal size={16} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>

      {remaining <= COUNTER_AT ? (
        <p
          className={cn(
            'px-1 pt-1 text-right text-[11px] tabular-nums',
            tooLong ? 'text-danger' : 'text-tertiary',
          )}
          // Announced when it starts mattering, not on every keystroke.
          aria-live="polite"
        >
          {remaining} left
        </p>
      ) : null}
    </div>
  );
}
