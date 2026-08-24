/**
 * The auth shell (PLAN.md §12.1).
 *
 * The same header and footer as the marketing page, then one column, one card,
 * one border. No hero, no gradient, no illustration of a person at a desk — the
 * shortest possible path from here into a room.
 */
import type { ReactNode } from 'react';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { Card } from '@/components/ui/card';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />

      <main className="flex flex-1 justify-center px-4 py-10 sm:py-16">
        <div className="w-full max-w-[400px]">
          <Card className="p-6">{children}</Card>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
