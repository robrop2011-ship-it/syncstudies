'use client';

/**
 * The video region (PLAN.md §12.4, §8.7, §5.3).
 *
 * It owns the rectangle, the player's lifetime, and everything drawn on top of
 * the picture: the shared ink canvas, the autoplay gate, the "this video refuses
 * to be embedded" state, the rejected-control pill, and the empty state with the
 * paste-a-link form.
 *
 * **Why the player is constructed here and not in the sync layer.** The iframe
 * belongs to a DOM node, and a DOM node belongs to the component that renders
 * it. So this component builds the `PlayerAdapter` for the room's current video
 * and hands it *up* through `useAttachPlayer()`; the `SyncController` borrows it
 * and never destroys it. The alternative — a headless controller reaching into
 * the document for a container — is how you get a player that survives a route
 * change with its audio still playing.
 *
 * **It is built once, not once per video.** When the room switches videos the
 * controller calls `player.load()` on the existing player (§8.4 `set_video`).
 * Tearing the iframe down and building a new one would drop the buffer, the
 * quality ladder and roughly two seconds on every change, and would race the
 * controller's own reload. Hence the `epoch` indirection below: the create
 * effect's cleanup must run on unmount, and never merely because the anchor
 * moved.
 *
 * The stage is black and 16:9. Where the region is taller than 16:9 the box
 * stays wider than the video and YouTube letterboxes inside it — black on black,
 * so there is no grey gutter anywhere.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Lock, Youtube } from 'lucide-react';
import type { ControlRejectReason, PlayerAdapter, PlayerErrorInfo } from '@syncstudy/shared';
import { Button } from '@/components/ui/button';
import { AutoplayGate } from '@/components/room/AutoplayGate';
import { InkOverlay } from '@/components/room/InkOverlay';
import { InkToolbar, setDrawMode, useDrawMode } from '@/components/room/InkToolbar';
import { SetVideoForm } from '@/components/room/SetVideoForm';
import { useJoinError, useRoomStore, useVideoAnchor } from '@/lib/stores/room-store';
import { useServerClock } from '@/lib/sync/clock';
import { joinStartPositionSec } from '@/lib/sync/controller';
import { createPlayer, PlayerLoadError, UnsupportedProviderError } from '@/lib/sync/players';
import { useAttachPlayer, useSyncController, useSyncStatus } from '@/lib/sync/useSyncController';
import { cn } from '@/lib/utils';

/** The element the iframe is mounted into. Named so E2E can find the stage. */
export const PLAYER_MOUNT_ID = 'syncstudy-player';

/** How long the §8.5d rejected-control pill stays up. Long enough to read once. */
const REJECTION_PILL_MS = 2_000;

/** Everything that can go wrong before the player is usable, as one shape. */
function toErrorInfo(failure: unknown): PlayerErrorInfo {
  if (failure instanceof PlayerLoadError) return failure.info;
  if (failure instanceof UnsupportedProviderError) {
    return { code: 0, embedDenied: false, message: failure.message };
  }
  const message =
    failure instanceof Error && failure.message.length > 0 && failure.message.length < 200
      ? failure.message
      : "YouTube's player didn't load. Check your connection and try again.";
  return { code: 0, embedDenied: false, message };
}

export function VideoStage({
  canSetVideo,
  loading = false,
  className,
}: {
  canSetVideo: boolean;
  /** The snapshot has not landed. Show the shape of the stage, not an empty state. */
  loading?: boolean | undefined;
  className?: string | undefined;
}) {
  const video = useVideoAnchor();
  const joinError = useJoinError();
  const status = useSyncStatus();
  const controller = useSyncController();
  const attach = useAttachPlayer();
  const clock = useServerClock();
  const drawing = useDrawMode();

  // Draw mode is a module-level switch, so it survives leaving a room. Landing
  // in the NEXT room with the pencil still down would put a transparent canvas
  // over the player that quietly eats the first click on play. Put it down with
  // the stage that owns it.
  useEffect(() => () => setDrawMode(false), []);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<PlayerAdapter | null>(null);
  /** Latest anchor, for the create effect — which must not re-run when it moves. */
  const anchorRef = useRef(video);
  anchorRef.current = video;

  const [loadError, setLoadError] = useState<PlayerErrorInfo | null>(null);
  const [epoch, setEpoch] = useState(0);
  /** Bumped by the retry button so a transient load failure is not terminal. */
  const [retryNonce, setRetryNonce] = useState(0);

  // A video appeared where there was none — the room's first, or a different one
  // after a failed load. An existing player is left alone: the controller
  // reloads it, which is cheaper and cannot race with this.
  //
  // Keyed on revision as well as videoRef so a re-issued `set_video` for the SAME
  // video rebuilds. Player construction fails for transient reasons (the IFrame
  // API script blocked, slow, or timing out on ready), and without this the
  // failure was terminal for that client: `playerRef.current` stays null, no
  // adapter is ever attached, no controller runs, and nothing short of a page
  // reload recovers. `PlayerFailure` also offers a retry (see `retryNonce`).
  useEffect(() => {
    if (video.videoRef === null || playerRef.current !== null) return;
    setLoadError(null);
    setEpoch((current) => current + 1);
  }, [video.videoRef, video.revision, retryNonce]);

  useEffect(() => {
    const container = containerRef.current;
    const anchor = anchorRef.current;
    if (container === null || clock === null) return;
    if (anchor.provider === 'none' || anchor.videoRef === null) return;
    if (playerRef.current !== null) return;

    let disposed = false;
    let created: PlayerAdapter | null = null;
    const videoRef = anchor.videoRef;

    void createPlayer({
      provider: anchor.provider,
      container,
      videoRef,
      // §8.7 step 4: aim slightly ahead of the room when it is playing, because
      // loading and buffering take real time. Shared with the controller's own
      // reload path so the two cannot disagree about where "now" is.
      startAtSec: joinStartPositionSec(anchor, clock.now()),
    }).then(
      (player) => {
        // StrictMode mounts, unmounts and remounts every effect in development,
        // so a player that lands after the cleanup must destroy itself rather
        // than become an invisible second iframe playing audio.
        if (disposed) {
          player.destroy();
          return;
        }
        created = player;
        playerRef.current = player;
        attach(player, videoRef);
      },
      (failure: unknown) => {
        if (disposed) return;
        setLoadError(toErrorInfo(failure));
      },
    );

    return () => {
      disposed = true;
      if (created === null) return;
      attach(null);
      playerRef.current = null;
      created.destroy();
    };
  }, [epoch, clock, attach]);

  const hasVideo = video.provider !== 'none' && video.videoRef !== null;
  // The controller reports errors the player raises once it is running; this
  // component reports the ones that stop it existing at all.
  const playerError = loadError ?? status.error;
  const showPlayer = joinError === null && hasVideo && playerError === null;

  // No picture, no shared surface. An error state or the paste-a-link screen is
  // laid out differently for everyone looking at it, so there is nothing here a
  // coordinate could mean — and a control bar still claiming draw mode over it
  // would be claiming something that is not on screen.
  useEffect(() => {
    if (!showPlayer) setDrawMode(false);
  }, [showPlayer]);

  // Draw mode is a module-level switch shared with the control bar, so the room
  // has to hand it back when it goes: without this, walking from /r/AAAA to
  // /r/BBBB arrives in the next room with the pencil already down.
  useEffect(() => {
    return () => {
      setDrawMode(false);
    };
  }, []);

  return (
    <section
      aria-label="Video"
      className={cn(
        'relative flex min-h-0 items-center justify-center overflow-hidden',
        showPlayer ? 'bg-black' : 'bg-surface-1',
        className,
      )}
    >
      {/* Rendered unconditionally so the iframe is never re-parented; only its
          visibility changes. */}
      <div
        className={cn(
          'relative aspect-video max-h-full w-full',
          '[&_iframe]:block [&_iframe]:h-full [&_iframe]:w-full [&_iframe]:border-0',
          showPlayer ? 'block' : 'hidden',
        )}
      >
        <div id={PLAYER_MOUNT_ID} ref={containerRef} className="absolute inset-0" />

        {/*
          THE INK SURFACE IS THIS BOX, AND ONLY THIS BOX.

          A stroke travels as x,y in 0..1 relative to the rect this div occupies
          and is painted back against the receiver's own copy of it, so a circle
          drawn around a term lands on that term on every screen whatever size
          the window is. That only holds because the box is the same shape for
          everybody: it is 16:9 at every breakpoint, and the player letterboxes
          inside it. The sidebar, the chat and the control bar are laid out
          differently for every participant and below `lg` some of them are not
          on screen at all, so a coordinate over any of those means nothing to
          anyone else — which is why "draw anywhere on the screen" is not what
          this is, and must not become it.

          Above the iframe, below the gate: someone who still has to tap "join
          with sound" must not find a drawing surface swallowing the tap. The
          canvas carries no z-index, so it paints over the iframe and under the
          `z-10` gate; the toolbar is `z-10` too but sits earlier in the DOM, so
          the gate — same layer, later — covers it while it is up.
        */}
        <InkOverlay drawing={drawing} />
        <InkToolbar drawing={drawing} />

        <AutoplayGate
          needsGesture={showPlayer && status.needsGesture}
          mutedForAutoplay={status.mutedForAutoplay}
          onAccept={async () => {
            await controller?.acceptGesture();
          }}
        />

        <ControlRejectionPill />
      </div>

      {showPlayer ? null : (
        <div className="ss-scroll absolute inset-0 flex overflow-y-auto p-4 sm:p-6">
          <div className="m-auto w-full max-w-md">
            {joinError !== null ? (
              <JoinFailure code={joinError.code} message={joinError.message} />
            ) : playerError !== null ? (
              <PlayerFailure
                error={playerError}
                canSetVideo={canSetVideo}
                onRetry={() => {
                  setLoadError(null);
                  setRetryNonce((n) => n + 1);
                }}
              />
            ) : loading ? (
              <StageSkeleton />
            ) : (
              <NoVideo canSetVideo={canSetVideo} />
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * A 16px icon in a bordered 32px square. §12.1 rule 9 fixes the icon size at 16,
 * and the square is what gives an empty state something to hang on without
 * reaching for a 48px glyph or an illustration of somebody at a desk.
 */
function EmptyMark({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border-strong text-tertiary">
      {children}
    </span>
  );
}

/** Grey blocks at the real geometry, never a centred spinner (§12.1 rule 11). */
function StageSkeleton() {
  return (
    <div aria-hidden="true" className="w-full">
      <div className="aspect-video w-full rounded-md bg-surface-2" />
    </div>
  );
}

function NoVideo({ canSetVideo }: { canSetVideo: boolean }) {
  return (
    <div className="flex w-full flex-col items-center gap-4 text-center">
      <EmptyMark>
        <Youtube size={16} strokeWidth={1.5} aria-hidden="true" />
      </EmptyMark>

      <div className="flex flex-col gap-1">
        <h2 className="text-base font-medium text-primary">No video yet</h2>
        <p className="text-13 text-secondary">
          {canSetVideo
            ? 'Paste a YouTube link. Everyone in the room loads it at the same position.'
            : 'The host will paste a YouTube link. Everyone loads it at the same position.'}
        </p>
      </div>

      {canSetVideo ? <SetVideoForm id="video-url-empty" /> : null}
    </div>
  );
}

/**
 * The player refused the video (§5.3 quirk 5).
 *
 * 101 and 150 are the same thing wearing two numbers: the owner disabled
 * embedding. It is the most common way a pasted link fails, and the copy says
 * what to do about it rather than printing a code at somebody.
 */
function describePlayerError(error: PlayerErrorInfo): { title: string; body: string } {
  if (error.embedDenied) {
    return {
      title: "This video can't be played outside YouTube",
      body: 'Its owner turned off embedding. Try another link.',
    };
  }
  switch (error.code) {
    case 100:
      return {
        title: 'That video is gone',
        body: 'It is private or has been deleted. Try another link.',
      };
    case 2:
      return { title: 'That link is not a video', body: 'Check the address and paste it again.' };
    case 5:
      return {
        title: "This browser couldn't play that video",
        body: 'Reload the page, or try another link.',
      };
    case 0:
      // Not YouTube refusing the video — the player never got off the ground.
      // The adapter's own sentence is the useful one here.
      return { title: "The player didn't load", body: error.message };
    default:
      return { title: 'That video will not play', body: 'Try another link.' };
  }
}

function PlayerFailure({
  error,
  canSetVideo,
  onRetry,
}: {
  error: PlayerErrorInfo;
  canSetVideo: boolean;
  onRetry: () => void;
}) {
  const described = describePlayerError(error);

  return (
    <div className="flex w-full flex-col items-center gap-4 text-center">
      <EmptyMark>
        <Youtube size={16} strokeWidth={1.5} aria-hidden="true" />
      </EmptyMark>

      <div className="flex flex-col gap-1">
        <h2 className="text-base font-medium text-primary">{described.title}</h2>
        <p className="text-13 text-secondary">{described.body}</p>
      </div>

      {/*
        A denied embed will never load however many times you ask, but every other
        failure here is transient — the IFrame API script blocked, slow, or timing
        out on ready — and without a way back the client is stuck on this screen
        until it reloads the page, while the rest of the room watches on.
      */}
      {error.embedDenied ? null : (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}

      {canSetVideo ? (
        <SetVideoForm id="video-url-error" />
      ) : (
        <p className="text-13 text-tertiary">Ask the host to try a different video.</p>
      )}
    </div>
  );
}

/**
 * A rejected control (§8.5d).
 *
 * Two seconds, one line, over the corner of the video. Not a red error and not a
 * modal: losing a race with somebody else's seek is a normal thing that happens
 * in a shared room, and the user's own change has already reverted to the
 * authoritative anchor by the time this appears.
 *
 * Its own component because it is the only thing in the stage that needs the
 * participant list, and the selector returns a plain string — so a `speaking`
 * patch arriving four times a second cannot re-render the video region (§5.4).
 */
function ControlRejectionPill() {
  const rejection = useRoomStore((state) => state.controlRejection);
  const actorName = useRoomStore((state) => {
    const actorId = state.video.lastActorId;
    if (actorId === null) return null;
    return state.participants.find((participant) => participant.id === actorId)?.displayName ?? null;
  });
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (rejection === null) return;
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), REJECTION_PILL_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [rejection]);

  if (rejection === null || !visible) return null;

  return (
    <p
      role="status"
      className={cn(
        'absolute left-3 top-3 z-10 animate-fade-in rounded-md border border-border',
        'bg-bg/95 px-2 py-1 text-13 text-primary',
      )}
    >
      {rejectionText(rejection.reason, actorName)}
    </p>
  );
}

function rejectionText(reason: ControlRejectReason, actorName: string | null): string {
  switch (reason) {
    case 'recently_changed':
      return actorName === null
        ? 'Someone just changed the video'
        : `${actorName} just changed the video`;
    case 'stale_revision':
      return 'The room moved on — you are back in step';
    case 'not_permitted':
      return 'You cannot control playback in this room';
    case 'rate_limited':
      return 'Too many changes just now — try again in a moment';
    case 'no_video':
      return 'There is no video to control yet';
  }
}

interface Failure {
  title: string;
  body: string;
  retry: boolean;
}

/**
 * The socket refused the join. This is not a toast and not a dialog: it is the
 * content of the region that would otherwise hold the video, so the top bar and
 * the sidebar stay where they are and the page stays navigable.
 */
function JoinFailure({ code, message }: { code: string; message: string }) {
  const failure = describe(code, message);

  return (
    <div className="flex w-full flex-col items-center gap-4 text-center">
      <EmptyMark>
        <Lock size={16} strokeWidth={1.5} aria-hidden="true" />
      </EmptyMark>

      <div className="flex flex-col gap-1">
        <h2 className="text-base font-medium text-primary">{failure.title}</h2>
        <p className="text-13 text-secondary">{failure.body}</p>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2">
        {failure.retry ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              window.location.reload();
            }}
          >
            Try again
          </Button>
        ) : null}
        <Link
          href="/dashboard"
          className="rounded-sm px-1 text-13 text-secondary underline-offset-2 hover:text-primary hover:underline"
        >
          Back to your rooms
        </Link>
      </div>
    </div>
  );
}

/**
 * `kicked`, `banned`, `room_ended` and `room_archived` never reach here — the
 * shell renders those full-viewport, because there is no room left to frame.
 * What is left is "not right now", which keeps the top bar and the code on
 * screen so the way back in is one click.
 */
function describe(code: string, message: string): Failure {
  switch (code) {
    case 'room_full':
      return {
        title: 'This room is full',
        body: 'Everyone the host allowed is already in it. You can get in as soon as somebody leaves.',
        retry: true,
      };
    case 'room_not_found':
      return {
        title: 'This room no longer exists',
        body: 'The code may have been regenerated, or the room was deleted.',
        retry: false,
      };
    case 'rate_limited':
      return {
        title: 'Too many attempts',
        body: 'Wait a few seconds, then try again.',
        retry: true,
      };
    default:
      return { title: "Couldn't join this room", body: message, retry: true };
  }
}
