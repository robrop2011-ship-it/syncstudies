'use client';

/**
 * The three-step coach-mark shown the first time someone creates a room
 * (PLAN.md §14 Phase 8.9).
 *
 * Three constraints from the plan, and one from §12:
 *
 *  - **Only for the host, only on a room they just created.** A student who was
 *    invited does not need to be told how to paste a video; they need to see
 *    the video.
 *  - **Dismissible, and never shown twice.** The flag is in `localStorage`, so
 *    it is per-browser and per-person, and dismissing is one click or `Esc`.
 *  - **Not a modal.** §12.1 rule 11 forbids blocking the screen, and the whole
 *    point is to point *at* things that are on it. This is a small card in the
 *    corner with a step counter.
 *
 * `localStorage` can throw outright — Safari in private mode, a browser set to
 * block site data — so every access is guarded and the failure mode is "show
 * nothing", never a crash on the most-looked-at page in the product.
 */
import { useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const STORAGE_KEY = 'syncstudy:onboarded';

const STEPS: { title: string; body: string }[] = [
  {
    title: 'Invite someone',
    // Deliberately does not say "the code is in the top bar": on a phone it is
    // not — the bar collapses to the Copy link button alone. Copy is true at
    // every width, and it is also the better thing to send.
    body: 'Copy link, in the top bar, copies the whole address. Send that to whoever you are studying with.',
  },
  {
    title: 'Paste a lecture',
    body: 'Any YouTube link goes in the middle of the screen. Everyone lands on the same second, and stays there.',
  },
  {
    title: 'Talk about it',
    body: 'Join voice from the bar below. Questions you pin with ? become marks on the scrubber that take the room back.',
  },
];

function alreadyOnboarded(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    // Storage blocked. Treat it as "already seen": showing the coach-mark on
    // every single visit is far worse than never showing it.
    return true;
  }
}

function markOnboarded(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, '1');
  } catch {
    // Nothing to do; it will be offered again next time, which is acceptable.
  }
}

export function Onboarding({ isHost }: { isHost: boolean }) {
  const [step, setStep] = useState(0);
  const [visible, setVisible] = useState(false);

  // Read storage in an effect, never during render: the server pass has no
  // `window`, and a value that differs between the two is a hydration mismatch.
  useEffect(() => {
    if (!isHost) return;
    if (alreadyOnboarded()) return;
    setVisible(true);
  }, [isHost]);

  useEffect(() => {
    if (!visible) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setVisible(false);
      markOnboarded();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible]);

  if (!visible) return null;

  const current = STEPS[step];
  if (current === undefined) return null;
  const last = step === STEPS.length - 1;

  const dismiss = (): void => {
    setVisible(false);
    markOnboarded();
  };

  return (
    <aside
      aria-label="Getting started"
      className={cn(
        // Above the control bar, clear of the sidebar, and out of the way of
        // the video. Never centred — a card in the middle of the screen is a
        // modal wearing a different hat.
        'fixed bottom-20 left-3 z-40 w-[19rem] rounded-lg border border-border-strong bg-surface-1 p-3',
        'shadow-dropdown',
      )}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-tertiary">
            Step {step + 1} of {STEPS.length}
          </p>
          <h2 className="mt-0.5 text-13 font-medium text-primary">{current.title}</h2>
          <p className="mt-1 text-13 leading-5 text-secondary">{current.body}</p>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={dismiss}
          className={cn(
            'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-tertiary',
            'transition-colors duration-120 ease-standard hover:bg-surface-2 hover:text-secondary',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          )}
        >
          <X size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>

      <div className="mt-2.5 flex items-center gap-1.5">
        <Button
          type="button"
          variant={last ? 'primary' : 'secondary'}
          size="sm"
          onClick={() => {
            if (last) {
              dismiss();
              return;
            }
            setStep((n) => n + 1);
          }}
        >
          {last ? (
            <>
              <Check size={16} strokeWidth={1.5} aria-hidden="true" />
              Got it
            </>
          ) : (
            'Next'
          )}
        </Button>
        {last ? null : (
          <Button type="button" variant="ghost" size="sm" onClick={dismiss}>
            Skip
          </Button>
        )}
      </div>
    </aside>
  );
}
