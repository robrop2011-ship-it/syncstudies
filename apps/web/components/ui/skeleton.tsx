import type * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A static grey block. No shimmer, no pulse — PLAN.md §12.1 rule 6 rules both out,
 * and a shimmering skeleton is the single most recognisable "AI demo" tell after
 * the gradient hero.
 *
 * Its job is to hold the exact geometry of the content that is about to land, so
 * nothing moves when it does. Always give it real width/height classes.
 */
export function Skeleton({ className }: { className?: string | undefined }): React.JSX.Element {
  return <div aria-hidden="true" className={cn('rounded-sm bg-surface-2', className)} />;
}
