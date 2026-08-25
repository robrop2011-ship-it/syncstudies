import type * as React from 'react';
import { SiteHeader } from '@/components/site-header';
import { SiteFooter } from '@/components/site-footer';

/**
 * The frame for the prose pages (PLAN.md §14 Phase 8.8, §14 Phase 10.7).
 *
 * One column, generous whitespace — §12.1 rule 8's "generous on the marketing
 * page, tight in the room". These are read once and then never again, so they
 * are optimised for being read rather than for density.
 */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-12 sm:px-6 sm:py-16">{children}</main>
      <SiteFooter />
    </div>
  );
}
