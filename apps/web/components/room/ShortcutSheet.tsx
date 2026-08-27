'use client';

/**
 * Room-wide keyboard shortcuts and the sheet that lists them (PLAN.md §12.5).
 *
 * The video keys (Space, ←/→, J/L, and `D` for draw mode) live in
 * `PlayerControls`, which owns the player and the pencil; the `?` question key
 * lives in `AddNoteDialog`, which owns the timestamp; `Esc`-to-stop-drawing
 * lives in `InkToolbar`, which is only mounted while there is drawing to stop.
 * What is left — the ones that belong to no single control — is here, along with
 * the sheet, because a shortcut list that is maintained somewhere other than the
 * shortcuts themselves goes stale within a week.
 *
 * **One deviation from §12.5, deliberate.** The plan binds `?` to *both* "new
 * question at the current timestamp" and "open the shortcut sheet". They are the
 * same keystroke and cannot both work. `?` keeps the question — it is §2.5's
 * retention feature and the more valuable of the two — and the sheet answers to
 * `Ctrl`/`Cmd` + `/`, plus a button in the room menu. The sheet says so itself.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useCall } from '@/lib/call/provider';
import { useCallStore } from '@/lib/stores/call-store';

/** The event `RoomSidebar` listens for; `/` focuses the composer through it. */
export const FOCUS_CHAT_EVENT = 'syncstudy:focus-chat';
/** Fired by the room menu, which lives outside this component's subtree. */
export const SHOW_SHORTCUTS_EVENT = 'syncstudy:show-shortcuts';

export function showShortcuts(): void {
  window.dispatchEvent(new CustomEvent(SHOW_SHORTCUTS_EVENT));
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.closest('[role="menu"],[role="dialog"]') !== null;
}

export function RoomShortcuts() {
  const call = useCall();
  const inCall = useCallStore((s) => s.status === 'joined');
  const [open, setOpen] = useState(false);

  const openSheet = useCallback(() => setOpen(true), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // Cmd/Ctrl + / opens the sheet, and is the one binding here allowed to
      // fire while someone is typing: it is help, and you ask for help exactly
      // when you are stuck mid-task.
      if ((event.metaKey || event.ctrlKey) && event.key === '/') {
        event.preventDefault();
        setOpen((was) => !was);
        return;
      }
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;

      switch (event.key) {
        case '/':
          event.preventDefault();
          window.dispatchEvent(new CustomEvent(FOCUS_CHAT_EVENT));
          return;
        case 'm':
        case 'M':
          if (!inCall || call.preferences.pushToTalk) return;
          event.preventDefault();
          void call.toggleMic();
          return;
        case 'v':
        case 'V':
          if (!inCall) return;
          event.preventDefault();
          void call.toggleCamera();
          return;
        default:
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [call, inCall]);

  useEffect(() => {
    const onRequest = (): void => openSheet();
    window.addEventListener(SHOW_SHORTCUTS_EVENT, onRequest);
    return () => window.removeEventListener(SHOW_SHORTCUTS_EVENT, onRequest);
  }, [openSheet]);

  const pushToTalk = call.preferences.pushToTalk;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogTitle>Keyboard shortcuts</DialogTitle>
        <DialogDescription>
          These work anywhere in the room, except while you are typing.
        </DialogDescription>

        <div className="ss-scroll max-h-[60vh] overflow-y-auto px-4 pb-1">
          <Group title="Video">
            <Row keys={pushToTalk ? [] : ['Space']} label="Play or pause for everyone">
              {pushToTalk ? (
                <span className="text-13 text-tertiary">
                  Space is push-to-talk while that setting is on
                </span>
              ) : null}
            </Row>
            <Row keys={['←', '→']} label="Back or forward 5 seconds" />
            <Row keys={['J', 'L']} label="Back or forward 10 seconds" />
            <Row keys={['D']} label="Draw on the video for everyone" />
          </Group>

          <Group title="Notes and chat">
            <Row keys={['?']} label="Ask a question at the current timestamp" />
            <Row keys={['/']} label="Jump to the message box" />
          </Group>

          <Group title="Voice">
            <Row
              keys={pushToTalk ? ['Space'] : ['M']}
              label={pushToTalk ? 'Hold to talk' : 'Mute or unmute'}
            />
            <Row keys={['V']} label="Camera on or off" />
          </Group>

          <Group title="Everything else">
            <Row keys={['Ctrl', '/']} label="Open this sheet" />
            <Row keys={['Esc']} label="Close a dialog, a menu, or draw mode" />
          </Group>
        </div>

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-border py-3 last:border-b-0">
      <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.04em] text-tertiary">
        {title}
      </h3>
      <dl className="flex flex-col gap-1.5">{children}</dl>
    </section>
  );
}

function Row({
  keys,
  label,
  children,
}: {
  keys: readonly string[];
  label: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-13 text-secondary">{label}</dt>
      <dd className="flex shrink-0 items-center gap-1">
        {children}
        {keys.map((key) => (
          <kbd
            key={key}
            className="rounded-sm border border-border-strong px-1.5 py-0.5 text-[11px] font-medium text-secondary"
          >
            {key}
          </kbd>
        ))}
      </dd>
    </div>
  );
}
