'use client';

/**
 * Host and co-host controls (PLAN.md §3.2 R7, §11.2, §12.5).
 *
 * Every action here is one of the socket events the realtime service already
 * implements. Nothing is computed locally: the server re-checks the permission,
 * re-checks the rank, and broadcasts the result, so a client that lies about a
 * role gets a `not_permitted` ack and nothing else.
 *
 * The two rules from §11.2 decide what is even offered:
 *   `can(role, permission)`   — may this role do this at all?
 *   `canActOn(actor, target)` — may this role do it to THAT person?
 * Without the second, a co-host is offered a "remove" button for the host.
 *
 * §12.5 sets the confirmation policy, and the asymmetry is deliberate:
 * **kick is immediate**, because it is the button you reach for while someone is
 * being abusive and a dialog is two seconds of them still being in the room.
 * **Ban and End room get a dialog** that spells out what is about to be
 * irreversible.
 */
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Ban,
  Check,
  Crown,
  Keyboard,
  LifeBuoy,
  MoreHorizontal,
  PowerOff,
  ShieldMinus,
  ShieldPlus,
  UserMinus,
} from 'lucide-react';
import {
  can,
  canActOn,
  type Ack,
  type Participant,
  type PlaybackControlPolicy,
  type Role,
} from '@syncstudy/shared';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useSocket } from '@/lib/socket/provider';
import { NO_SOCKET, ackWithTimeout } from '@/components/room/socket-ack';
import { showShortcuts } from '@/components/room/ShortcutSheet';
import { showFeedback } from '@/components/room/FeedbackDialog';
import { cn } from '@/lib/utils';

// ── per-participant menu ────────────────────────────────────────────────────

type TargetConfirm = 'ban' | 'transfer';

export function ParticipantActions({
  target,
  youId,
  myRole,
}: {
  target: Participant;
  youId: string;
  myRole: Role;
}) {
  const socket = useSocket();
  const [confirm, setConfirm] = useState<TargetConfirm | null>(null);
  /** Last dialog kind that was OPENED; survives the close transition. */
  const [shownConfirm, setShownConfirm] = useState<TargetConfirm | null>(null);

  /** Open a confirm dialog and pin its copy for as long as it is on screen. */
  const openConfirm = (kind: TargetConfirm): void => {
    setShownConfirm(kind);
    setConfirm(kind);
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openingDialog = useRef(false);

  const isSelf = target.id === youId;
  const outranks = canActOn(myRole, target.role);

  const mayKick = !isSelf && outranks && can(myRole, 'host.kick');
  const mayBan = !isSelf && outranks && can(myRole, 'host.ban');
  const maySetRole = !isSelf && outranks && can(myRole, 'host.set_role') && target.role !== 'guest';
  const mayTransfer = !isSelf && can(myRole, 'host.transfer') && target.role !== 'guest';

  if (!mayKick && !mayBan && !maySetRole && !mayTransfer) return null;

  function fire(run: (ack: (result: Ack) => void) => void, onFail: (message: string) => void): void {
    if (socket === null) {
      onFail(NO_SOCKET.message);
      return;
    }
    void ackWithTimeout(run).then((result) => {
      if (!result.ok) onFail(result.message);
    });
  }

  function kick(): void {
    // No dialog, on purpose (§12.5). Undo is "let them back in with the code".
    fire(
      (ack) => socket?.emit('host:kick', { userId: target.id }, ack),
      (message) => toast.error(message),
    );
  }

  function setRole(role: 'co_host' | 'member'): void {
    fire(
      (ack) => socket?.emit('host:set_role', { userId: target.id, role }, ack),
      (message) => toast.error(message),
    );
  }

  async function runConfirmed(): Promise<void> {
    if (confirm === null) return;
    if (socket === null) {
      setError(NO_SOCKET.message);
      return;
    }
    setBusy(true);
    setError(null);

    const result = await ackWithTimeout((ack) => {
      if (confirm === 'ban') socket.emit('host:ban', { userId: target.id }, ack);
      else socket.emit('host:transfer', { userId: target.id }, ack);
    });

    setBusy(false);
    if (result.ok) {
      setConfirm(null);
      return;
    }
    setError(result.message);
  }

  const isCoHost = target.role === 'co_host';

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Manage ${target.displayName}`}
            className={cn(
              // §12.6 / §5.5 require a >=44px touch target. The visual box stays
              // small from `lg` up, where a pointer makes 24px fine — the same
              // split ControlBar.tsx uses for its buttons. Negative margin keeps
              // the 32px participant row from growing on touch.
              'inline-flex h-11 w-11 -my-2.5 shrink-0 items-center justify-center rounded-sm',
              'lg:my-0 lg:h-6 lg:w-6',
              'text-tertiary transition-[opacity,color,background-color] duration-120 ease-standard',
              'hover:bg-surface-3 hover:text-primary',
              // Revealed on hover on pointer devices; always there on touch,
              // where there is no hover to reveal it with.
              'lg:opacity-0 lg:group-hover:opacity-100 lg:focus-visible:opacity-100',
              'data-[state=open]:opacity-100',
            )}
          >
            <MoreHorizontal size={16} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent
          align="end"
          onCloseAutoFocus={(event) => {
            // A dialog is about to take focus; letting the menu restore it first
            // makes the focus ring jump back to the row for a frame.
            if (openingDialog.current) {
              openingDialog.current = false;
              event.preventDefault();
            }
          }}
        >
          {maySetRole ? (
            <DropdownMenuItem onSelect={() => setRole(isCoHost ? 'member' : 'co_host')}>
              {isCoHost ? (
                <ShieldMinus size={16} strokeWidth={1.5} aria-hidden="true" />
              ) : (
                <ShieldPlus size={16} strokeWidth={1.5} aria-hidden="true" />
              )}
              {isCoHost ? 'Remove co-host' : 'Make co-host'}
            </DropdownMenuItem>
          ) : null}

          {mayTransfer ? (
            <DropdownMenuItem
              onSelect={() => {
                openingDialog.current = true;
                setError(null);
                openConfirm('transfer');
              }}
            >
              <Crown size={16} strokeWidth={1.5} aria-hidden="true" />
              Make host
            </DropdownMenuItem>
          ) : null}

          {(maySetRole || mayTransfer) && (mayKick || mayBan) ? <DropdownMenuSeparator /> : null}

          {mayKick ? (
            <DropdownMenuItem destructive onSelect={kick}>
              <UserMinus size={16} strokeWidth={1.5} aria-hidden="true" />
              Remove from room
            </DropdownMenuItem>
          ) : null}

          {mayBan ? (
            <DropdownMenuItem
              destructive
              onSelect={() => {
                openingDialog.current = true;
                setError(null);
                openConfirm('ban');
              }}
            >
              <Ban size={16} strokeWidth={1.5} aria-hidden="true" />
              Ban from room
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {/*
        Copy is driven by `shownConfirm`, not `confirm`. Radix keeps the dialog
        mounted through its close transition, and clearing `confirm` to null on
        close flipped every ternary below to its "transfer host" branch — so a
        cancelled Ban visibly turned into "Make Priya the host?" on the way out.
        `shownConfirm` only ever changes when a dialog OPENS, so the copy holds
        still until the dialog is gone.
      */}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setConfirm(null);
            setError(null);
          }
        }}
        title={
          shownConfirm === 'ban'
            ? `Ban ${target.displayName}?`
            : `Make ${target.displayName} the host?`
        }
        description={
          shownConfirm === 'ban'
            ? `${target.displayName} is removed now and cannot rejoin with this account, even with the room code. Only you can undo it.`
            : `${target.displayName} gets every host control, including ending the room. You become a co-host, and only they can hand it back.`
        }
        confirmLabel={shownConfirm === 'ban' ? 'Ban from room' : 'Make host'}
        destructive={shownConfirm === 'ban'}
        busy={busy}
        error={error}
        onConfirm={() => {
          void runConfirmed();
        }}
      />
    </>
  );
}

// ── room-level menu (top bar) ───────────────────────────────────────────────

const CONTROL_LABEL: Record<PlaybackControlPolicy, string> = {
  everyone: 'Everyone in the room',
  host_and_cohosts: 'You and your co-hosts',
  host_only: 'Only you',
};

const CONTROL_ORDER: readonly PlaybackControlPolicy[] = [
  'everyone',
  'host_and_cohosts',
  'host_only',
];

/**
 * The top bar's overflow menu. Renders nothing for anyone who has no room-level
 * action — an overflow menu whose only entry is a duplicate of the copy button
 * next to it is a menu that trains people to ignore menus.
 */
export function RoomOverflowMenu({
  myRole,
  playbackControl,
}: {
  myRole: Role;
  playbackControl: PlaybackControlPolicy;
}) {
  const socket = useSocket();
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openingDialog = useRef(false);

  const mayPolicy = can(myRole, 'host.policy');
  const mayEnd = can(myRole, 'host.end');
  // The menu renders for everyone now: the shortcut sheet lives in it, and a
  // member with no way to find the keyboard shortcuts is a member who never
  // learns there are any. Host items stay conditional.

  function setPolicy(next: PlaybackControlPolicy): void {
    if (next === playbackControl) return;
    if (socket === null) {
      toast.error(NO_SOCKET.message);
      return;
    }
    void ackWithTimeout((ack) =>
      socket.emit('host:update_policy', { playbackControl: next }, ack),
    ).then((result) => {
      if (!result.ok) toast.error(result.message);
    });
  }

  async function endRoom(): Promise<void> {
    if (socket === null) {
      setError(NO_SOCKET.message);
      return;
    }
    setBusy(true);
    setError(null);
    const result = await ackWithTimeout((ack) => socket.emit('host:end_room', {}, ack));
    setBusy(false);
    if (result.ok) {
      setConfirmEnd(false);
      return;
    }
    setError(result.message);
  }

  return (
    <>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Room settings"
                className={cn(
                  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-transparent',
                  'text-secondary transition-colors duration-120 ease-standard',
                  'hover:bg-surface-2 hover:text-primary',
                )}
              >
                <MoreHorizontal size={16} strokeWidth={1.5} aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>Room settings</TooltipContent>
        </Tooltip>

        <DropdownMenuContent
          align="end"
          className="min-w-56"
          onCloseAutoFocus={(event) => {
            if (openingDialog.current) {
              openingDialog.current = false;
              event.preventDefault();
            }
          }}
        >
          <DropdownMenuItem
            onSelect={() => {
              openingDialog.current = true;
              showShortcuts();
            }}
          >
            <Keyboard size={16} strokeWidth={1.5} aria-hidden="true" />
            Keyboard shortcuts
          </DropdownMenuItem>

          <DropdownMenuItem
            onSelect={() => {
              openingDialog.current = true;
              showFeedback();
            }}
          >
            <LifeBuoy size={16} strokeWidth={1.5} aria-hidden="true" />
            Something wrong?
          </DropdownMenuItem>

          {mayPolicy || mayEnd ? <DropdownMenuSeparator /> : null}

          {mayPolicy ? (
            <>
              <DropdownMenuLabel>Who can control playback</DropdownMenuLabel>
              {CONTROL_ORDER.map((option) => (
                <DropdownMenuItem key={option} onSelect={() => setPolicy(option)}>
                  {option === playbackControl ? (
                    <Check size={16} strokeWidth={1.5} aria-hidden="true" className="text-accent" />
                  ) : (
                    <span aria-hidden="true" className="inline-block h-4 w-4" />
                  )}
                  {CONTROL_LABEL[option]}
                  {option === playbackControl ? <span className="sr-only">(current)</span> : null}
                </DropdownMenuItem>
              ))}
            </>
          ) : null}

          {mayPolicy && mayEnd ? <DropdownMenuSeparator /> : null}

          {mayEnd ? (
            <DropdownMenuItem
              destructive
              onSelect={() => {
                openingDialog.current = true;
                setError(null);
                setConfirmEnd(true);
              }}
            >
              <PowerOff size={16} strokeWidth={1.5} aria-hidden="true" />
              End room for everyone
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmDialog
        open={confirmEnd}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setConfirmEnd(false);
            setError(null);
          }
        }}
        title="End this room for everyone?"
        description="Everyone is disconnected straight away and the code stops working, so nobody can rejoin. The chat and the notes are kept and stay readable."
        confirmLabel="End room"
        destructive
        busy={busy}
        error={error}
        onConfirm={() => {
          void endRoom();
        }}
      />
    </>
  );
}

// ── confirm dialog ──────────────────────────────────────────────────────────

/**
 * §12.5: a destructive confirm has to spell out the consequence, not ask "are
 * you sure?". The description is the whole point of the dialog.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive = false,
  busy,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean | undefined;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>

        {error !== null ? (
          <div className="px-4 pb-1">
            <Callout tone="danger">{error}</Callout>
          </div>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant={destructive ? 'danger' : 'primary'}
            loading={busy}
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
