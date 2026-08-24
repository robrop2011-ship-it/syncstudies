'use client';

/**
 * The autoplay gate (PLAN.md §8.7 step 5, §5.3 quirk 3, §12.1).
 *
 * Every browser refuses to start audible playback without a user gesture, and
 * muted autoplay is the escape hatch every browser allows. So a late joiner gets
 * the video *moving* immediately, muted, and one tap turns the sound on. The
 * alternative — do nothing until they click — is a frozen frame on a page that
 * says everyone else is watching, which reads as broken. That single failure is
 * the entire reason this component exists.
 *
 * Two shapes, and the choice is not cosmetic:
 *
 *  - **muted autoplay worked** → ONE unobtrusive bar across the bottom of the
 *    player. The video is already playing and already in sync; the only thing
 *    missing is sound, so the affordance must not cover the picture.
 *  - **playback could not start at all** (iOS Low Power Mode, and iOS after a
 *    backgrounded tab — §8.9) → a centred button, because there is nothing worth
 *    seeing behind it yet.
 *
 * Not a modal, not a spinner, and no countdown. It disappears the moment the
 * gesture lands.
 */
import { useEffect, useRef, useState } from 'react';
import { Play, Volume2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

export function AutoplayGate({
  needsGesture,
  mutedForAutoplay,
  onAccept,
}: {
  needsGesture: boolean;
  /** True when we are only muted because autoplay demanded it. */
  mutedForAutoplay: boolean;
  onAccept: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  if (!needsGesture) return null;

  const accept = (): void => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    void onAccept()
      .catch(() => {
        if (mounted.current) setFailed(true);
      })
      .finally(() => {
        if (mounted.current) setBusy(false);
      });
  };

  if (mutedForAutoplay) {
    return (
      <div className="absolute inset-x-0 bottom-0 z-10 animate-fade-in">
        {/* The one gradient permitted anywhere in this app (§12.1 rule 4): a
            functional scrim so white text stays readable over an arbitrary frame. */}
        <button
          type="button"
          onClick={accept}
          className={cn(
            'flex w-full items-center justify-center gap-2 bg-gradient-to-t from-black/80 to-transparent',
            'px-3 pb-3 pt-8 text-sm font-medium text-white',
            'transition-opacity duration-120 ease-standard hover:opacity-90',
          )}
        >
          {busy ? (
            <Spinner size={16} />
          ) : (
            <Volume2 size={16} strokeWidth={1.5} aria-hidden="true" />
          )}
          {failed ? 'Sound is still off. Tap again.' : 'Tap to join with sound'}
        </button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'absolute inset-0 z-10 flex animate-fade-in flex-col items-center justify-center gap-3',
        // A flat wash, not a blur: `backdrop-filter` costs more than the video
        // decode on the machines this has to run on (§12.1 rule 5).
        'bg-black/55 p-4 text-center',
      )}
    >
      <p className="text-13 text-white/80">
        {failed
          ? "Your browser blocked playback. Tap the button — that's the gesture it wants."
          : 'The room is already playing.'}
      </p>
      <Button type="button" variant="primary" loading={busy} onClick={accept}>
        {busy ? null : <Play size={16} strokeWidth={1.5} aria-hidden="true" />}
        Join playback
      </Button>
    </div>
  );
}
