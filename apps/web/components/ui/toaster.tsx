'use client';

import type * as React from 'react';
import { Toaster as SonnerToaster } from 'sonner';

/**
 * Toasts are for background events the user did not cause — "Sam joined",
 * "Reconnected". Form errors and anything explaining the thing on screen go
 * inline in a <Callout> instead (PLAN.md §12.5).
 *
 * Bottom-left, because bottom-right is where the room's call bar and the video
 * controls live and a toast there would cover them mid-session.
 */
export function Toaster(): React.JSX.Element {
  return (
    <SonnerToaster
      position="bottom-left"
      duration={4000}
      visibleToasts={3}
      gap={8}
      offset={16}
      // Colours come from globals.css, driven by the same tokens as everything else.
      theme="system"
      toastOptions={{ className: 'ss-toast' }}
    />
  );
}
