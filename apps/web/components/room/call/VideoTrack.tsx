'use client';

/**
 * A `<video>` bound to one `MediaStreamTrack`.
 *
 * `muted` is not optional on the self-view: an unmuted local camera element
 * feeds the microphone back through the speakers, and the echo canceller does
 * not save you from your own output.
 */
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

export function VideoTrack({
  track,
  muted = false,
  mirrored = false,
  className,
}: {
  track: MediaStreamTrack | null;
  muted?: boolean;
  /** Self-view only: people expect their own camera to behave like a mirror. */
  mirrored?: boolean;
  className?: string | undefined;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    if (track === null) {
      element.srcObject = null;
      return;
    }
    element.srcObject = new MediaStream([track]);
    void element.play().catch(() => undefined);
    return () => {
      element.srcObject = null;
    };
  }, [track]);

  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted={muted}
      className={cn('h-full w-full bg-black object-cover', mirrored ? '-scale-x-100' : null, className)}
    />
  );
}
