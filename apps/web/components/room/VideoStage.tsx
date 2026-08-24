'use client';

/**
 * The video region — Phase 3 edition (PLAN.md §12.1 rule 10, §14 Phase 3 task 10).
 *
 * There is no player yet: synchronised playback is Phase 4 and the `video:*`
 * socket handlers currently answer `not_implemented`. So this renders a real
 * empty state and says so.
 *
 * What it deliberately does NOT do is fake one. A black rectangle with a
 * play triangle drawn on it, or a "Paste a link" field that silently does
 * nothing, both cost the same amount of code as this and teach people that the
 * controls in this app are decorative.
 */
import type { ReactNode } from 'react';
import Link from 'next/link';
import { Lock, Youtube } from 'lucide-react';
import { formatTimestamp } from '@syncstudy/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useJoinError, useVideoAnchor } from '@/lib/stores/room-store';
import { cn } from '@/lib/utils';

export function VideoStage({
  canSetVideo,
  className,
}: {
  canSetVideo: boolean;
  className?: string | undefined;
}) {
  const video = useVideoAnchor();
  const joinError = useJoinError();

  return (
    <section
      aria-label="Video"
      className={cn(
        // Scrolls rather than clips: on a phone the 16:9 box is ~210px tall and
        // the host's empty state is a little taller than that.
        'ss-scroll flex min-h-0 items-center justify-center overflow-y-auto bg-surface-1 p-4 sm:p-6',
        className,
      )}
    >
      {joinError !== null ? (
        <JoinFailure code={joinError.code} message={joinError.message} />
      ) : video.videoRef !== null ? (
        <VideoQueued
          title={video.title}
          videoRef={video.videoRef}
          durationSec={video.durationSec}
        />
      ) : (
        <NoVideo canSetVideo={canSetVideo} />
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

function NoVideo({ canSetVideo }: { canSetVideo: boolean }) {
  return (
    <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
      <EmptyMark>
        <Youtube size={16} strokeWidth={1.5} aria-hidden="true" />
      </EmptyMark>

      <div className="flex flex-col gap-1">
        <h2 className="text-base font-medium text-primary">No video yet</h2>
        <p className="text-13 text-secondary">
          {canSetVideo
            ? 'Paste a YouTube link and everyone in the room loads it at the same position.'
            : 'The host will paste a YouTube link. Everyone loads it at the same position.'}
        </p>
      </div>

      {canSetVideo ? (
        <form
          className="flex w-full flex-col gap-2"
          onSubmit={(event) => event.preventDefault()}
          aria-describedby="video-phase-note"
        >
          <div className="flex items-start gap-2">
            <label htmlFor="video-url" className="sr-only">
              YouTube link
            </label>
            <Input
              id="video-url"
              disabled
              placeholder="https://www.youtube.com/watch?v=…"
              className="flex-1"
            />
            <Button type="submit" variant="primary" disabled>
              Load video
            </Button>
          </div>
          <p id="video-phase-note" className="text-13 text-tertiary">
            Not wired up yet — synchronised playback arrives in Phase 4.
          </p>
        </form>
      ) : null}
    </div>
  );
}

/**
 * Phase 4 will replace this with the player. Until then, a video that somehow
 * exists on the anchor is reported honestly rather than rendered as a frame.
 */
function VideoQueued({
  title,
  videoRef,
  durationSec,
}: {
  title: string | null;
  videoRef: string;
  durationSec: number | null;
}) {
  return (
    <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
      <EmptyMark>
        <Youtube size={16} strokeWidth={1.5} aria-hidden="true" />
      </EmptyMark>

      <div className="flex flex-col gap-1">
        <h2 className="text-base font-medium text-primary">{title ?? 'A video is set'}</h2>
        <p className="text-13 text-secondary">
          <span className="font-mono">{videoRef}</span>
          {durationSec !== null ? ` · ${formatTimestamp(durationSec)}` : null}
        </p>
        <p className="text-13 text-tertiary">
          The player and the sync loop arrive in Phase 4. Nothing plays yet.
        </p>
      </div>
    </div>
  );
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
    <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
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
