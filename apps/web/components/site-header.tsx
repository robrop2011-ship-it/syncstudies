import type * as React from 'react';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { Logo } from '@/components/ui/logo';
import { ThemeToggle } from '@/components/theme-toggle';
import { cn } from '@/lib/utils';

/**
 * The marketing and dashboard shell header. The room has its own 48px top bar
 * (PLAN.md §12.4) and deliberately does not reuse this one — different density,
 * different contents, different job.
 *
 * `actions` replaces the signed-out pair so the dashboard can drop a user menu in
 * without a second header component drifting away from this one.
 */
export function SiteHeader({
  actions,
  className,
}: {
  actions?: React.ReactNode;
  className?: string | undefined;
}): React.JSX.Element {
  return (
    <header className={cn('sticky top-0 z-40 border-b border-border bg-bg', className)}>
      <div className="mx-auto flex h-14 max-w-5xl items-center gap-4 px-4 sm:px-6">
        <Link
          href="/"
          className="flex items-center gap-2 rounded-sm text-sm font-medium text-primary"
        >
          {/* Not accent-coloured: the accent belongs to the primary action on the
              right, and a page with two accent things has no accent (§12.1 rule 2). */}
          <Logo size={16} />
          <span>SyncStudy</span>
        </Link>

        <div className="flex-1" />

        <ThemeToggle />

        {actions ?? (
          <div className="flex items-center gap-2">
            <Link href="/login" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
              Sign in
            </Link>
            <Link href="/rooms/new" className={buttonVariants({ variant: 'primary', size: 'sm' })}>
              Create a room
            </Link>
          </div>
        )}
      </div>
    </header>
  );
}
