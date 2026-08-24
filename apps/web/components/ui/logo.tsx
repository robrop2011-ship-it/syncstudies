import type * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Two timelines, one playhead crossing both at the same position. It is the
 * product in four strokes, drawn in currentColor at strokeWidth 1.5 like every
 * other icon in the app — no wordmark lockup, no gradient, no rounded blob.
 */
export function Logo({
  size = 16,
  className,
}: {
  size?: number | undefined;
  className?: string | undefined;
}): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      aria-hidden="true"
      className={cn('shrink-0', className)}
    >
      <path d="M1.75 5h12.5" />
      <path d="M1.75 11h12.5" />
      <path d="M10.5 2.25v11.5" />
    </svg>
  );
}
