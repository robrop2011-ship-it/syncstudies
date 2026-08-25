'use client';

/**
 * The call half of the control bar (PLAN.md §12.4, §14 Phase 6.11).
 *
 * Order is by frequency of use — mic, camera, share — and every button carries
 * a label as well as an icon, because a bar of four unlabelled glyphs is a
 * puzzle. On a phone the labels collapse and the touch targets grow to 44px
 * (§12.6); nothing is hidden from the accessibility tree at any size.
 *
 * Before anyone joins the call there is exactly one control: "Join voice".
 * Rendering a disabled mic button next to it would suggest the microphone is
 * broken rather than that the call has not started.
 */
import { useEffect } from 'react';
import { Mic, MicOff, MonitorUp, PhoneOff, Video, VideoOff, Volume2, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Spinner } from '@/components/ui/spinner';
import { useCall } from '@/lib/call/provider';
import { useCallStore } from '@/lib/stores/call-store';
import { useMyPermissions, useParticipants } from '@/lib/stores/room-store';
import { cn } from '@/lib/utils';

export function CallControls({ youId }: { youId: string }) {
  const call = useCall();
  const permissions = useMyPermissions();
  const participants = useParticipants();

  const status = useCallStore((s) => s.status);
  const error = useCallStore((s) => s.error);
  const micOn = useCallStore((s) => s.micOn);
  const cameraOn = useCallStore((s) => s.cameraOn);
  const sharing = useCallStore((s) => s.sharing);
  const pttHeld = useCallStore((s) => s.pttHeld);
  const screenHolder = useCallStore((s) => s.screenHolder);

  const me = participants.find((p) => p.id === youId);
  const inCallCount = participants.filter((p) => p.inCall).length;
  // Null until the snapshot lands (~200 ms). "You cannot join" and "we do not
  // know yet" are different claims, and rendering the first for the second put
  // "Voice is turned off in this room" under every freshly opened room.
  const canJoin = permissions?.canJoinCall ?? false;
  const permissionsKnown = permissions !== null;
  const canShare = permissions?.canScreenShare ?? false;
  const forceMuted = me?.forceMuted === true;
  const joining = status === 'joining';
  const leaving = status === 'leaving';
  const inCall = status === 'joined' || joining;

  // Push-to-talk (§12.5). Space is the playback shortcut when PTT is off, so
  // the two can never be bound at once — the shortcut sheet says which is live.
  useEffect(() => {
    if (!inCall || !call.preferences.pushToTalk) return;

    const isTyping = (target: EventTarget | null): boolean => {
      const element = target as HTMLElement | null;
      if (element === null) return false;
      const tag = element.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || element.isContentEditable;
    };

    const down = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || event.repeat || isTyping(event.target)) return;
      event.preventDefault();
      call.setPushToTalk(true);
    };
    const up = (event: KeyboardEvent): void => {
      if (event.code !== 'Space') return;
      call.setPushToTalk(false);
    };
    // A blur while the key is held would otherwise leave the mic open — the
    // one push-to-talk bug everybody has been on the wrong end of.
    const blur = (): void => call.setPushToTalk(false);

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [inCall, call]);

  if (!inCall) {
    return (
      <div className="flex min-w-0 items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          className="h-11 lg:h-9"
          disabled={!canJoin || joining || !permissionsKnown}
          loading={joining}
          onClick={() => {
            void call.join();
          }}
        >
          <Mic size={16} strokeWidth={1.5} aria-hidden="true" />
          Join voice
        </Button>

        {inCallCount > 0 ? (
          <span className="hidden items-center gap-1.5 text-13 text-secondary sm:flex">
            <Volume2 size={16} strokeWidth={1.5} aria-hidden="true" />
            {inCallCount} in call
          </span>
        ) : null}

        {permissionsKnown && !canJoin ? (
          <span className="hidden text-13 text-tertiary md:inline">
            Voice is turned off in this room.
          </span>
        ) : null}

        {error !== null ? (
          <span className="min-w-0 truncate text-13 text-danger" role="status">
            {error}
          </span>
        ) : null}
      </div>
    );
  }

  const micLabel = forceMuted
    ? 'Muted by the host'
    : call.preferences.pushToTalk
      ? 'Hold Space to talk'
      : micOn
        ? 'Mute'
        : 'Unmute';

  return (
    <div className="flex min-w-0 items-center gap-1">
      <IconToggle
        icon={micOn ? Mic : MicOff}
        active={micOn}
        live={pttHeld}
        label={micLabel}
        text={micOn ? 'Mic on' : 'Mic off'}
        disabled={forceMuted || joining}
        onClick={() => {
          void call.toggleMic();
        }}
      />
      <IconToggle
        icon={cameraOn ? Video : VideoOff}
        active={cameraOn}
        label={cameraOn ? 'Turn camera off' : 'Turn camera on'}
        text={cameraOn ? 'Camera on' : 'Camera off'}
        disabled={joining}
        onClick={() => {
          void call.toggleCamera();
        }}
      />
      <IconToggle
        icon={MonitorUp}
        active={sharing}
        label={
          sharing
            ? 'Stop sharing your screen'
            : screenHolder !== null
              ? 'Someone else is sharing'
              : 'Share your screen'
        }
        text="Share"
        disabled={joining || !canShare || (screenHolder !== null && !sharing)}
        onClick={() => {
          void call.toggleShare();
        }}
      />

      <Button
        type="button"
        variant="ghost"
        className="ml-1 h-11 lg:h-9"
        disabled={leaving}
        onClick={() => {
          void call.leave();
        }}
      >
        <PhoneOff size={16} strokeWidth={1.5} aria-hidden="true" />
        <span className="hidden sm:inline">Leave voice</span>
      </Button>

      {joining ? (
        <span className="flex items-center gap-1.5 text-13 text-secondary">
          <Spinner size={14} />
          Connecting
        </span>
      ) : null}

      {error !== null ? (
        <span className="min-w-0 truncate text-13 text-danger" role="status">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/**
 * `active` is the on/off state; `live` is the momentary "transmitting right
 * now" of push-to-talk. They are separate because a held PTT key is not the
 * same claim as an unmuted microphone, and the border says so.
 */
function IconToggle({
  icon: Icon,
  active,
  live = false,
  label,
  text,
  disabled,
  onClick,
}: {
  icon: LucideIcon;
  active: boolean;
  live?: boolean;
  label: string;
  text: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={active}
          disabled={disabled}
          onClick={onClick}
          className={cn(
            'inline-flex h-11 w-11 items-center justify-center rounded-md border lg:h-9 lg:w-9',
            'transition-colors duration-120 ease-standard',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            'disabled:pointer-events-none disabled:opacity-50',
            live
              ? 'border-live text-live'
              : active
                ? 'border-border-strong bg-surface-2 text-primary hover:bg-surface-3'
                : 'border-border-strong text-tertiary hover:bg-surface-2 hover:text-secondary',
          )}
        >
          <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
          <span className="sr-only">{text}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
