import type * as React from 'react';
import { LoaderCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

const SIZE_CLASS: Record<14 | 16 | 20, string> = {
  14: 'h-3.5 w-3.5',
  16: 'h-4 w-4',
  20: 'h-5 w-5',
};

/**
 * Inline loading indicator. Never used full-screen — PLAN.md §12.1 rule 11 is
 * skeletons for content, this for buttons and small inline waits.
 *
 * Rotation is the one animation that survives `prefers-reduced-motion` (slowed,
 * in globals.css): a frozen spinner reads as a hung page, which is worse than
 * the motion it was meant to avoid.
 */
export function Spinner({
  size = 16,
  className,
}: {
  size?: 14 | 16 | 20 | undefined;
  className?: string | undefined;
}): React.JSX.Element {
  return (
    <LoaderCircle
      aria-hidden="true"
      strokeWidth={1.5}
      className={cn('ss-spin shrink-0', SIZE_CLASS[size], className)}
    />
  );
}
