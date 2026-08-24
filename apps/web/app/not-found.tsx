import type * as React from 'react';
import Link from 'next/link';
import { SiteHeader } from '@/components/site-header';
import { SiteFooter } from '@/components/site-footer';
import { buttonVariants } from '@/components/ui/button';

export default function NotFound(): React.JSX.Element {
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center px-4 py-24 sm:px-6">
        {/* The only all-caps in the system: 11px / 500 / 0.04em section labels. */}
        <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-tertiary">404</p>
        <h1 className="mt-2 text-xl font-semibold text-primary">This page doesn&rsquo;t exist</h1>
        {/* Plain and specific: the most likely reason someone is here is a room
            code that has ended or was mistyped, so say so and offer the fix. */}
        <p className="mt-2 max-w-md text-sm text-secondary">
          If you were opening a room link, the room may have ended, or the code may have a typo in
          it. Room codes never contain 0, 1, I, L, O or U.
        </p>

        <div className="mt-6 flex flex-wrap items-center gap-2">
          <Link href="/join" className={buttonVariants({ variant: 'primary' })}>
            Enter a room code
          </Link>
          <Link href="/" className={buttonVariants({ variant: 'secondary' })}>
            Go home
          </Link>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
