import type * as React from 'react';
import Link from 'next/link';
import { Logo } from '@/components/ui/logo';
import { cn } from '@/lib/utils';

const LINKS: ReadonlyArray<{ href: string; label: string }> = [
  { href: '/about', label: 'About' },
  { href: '/privacy', label: 'Privacy' },
  { href: '/join', label: 'Join a room' },
];

export function SiteFooter({ className }: { className?: string | undefined }): React.JSX.Element {
  return (
    <footer className={cn('border-t border-border', className)}>
      <div className="mx-auto flex max-w-5xl flex-col gap-3 px-4 py-6 sm:flex-row sm:items-center sm:px-6">
        <div className="flex items-center gap-2 text-13 text-secondary">
          <Logo size={16} className="text-tertiary" />
          <span>SyncStudy</span>
          <span className="text-tertiary">·</span>
          {/* Plain and specific, and true: PLAN.md §11.9 means there is no email
              column to leak and no third-party tracker to load. */}
          <span className="text-tertiary">No email, no ads, no trackers.</span>
        </div>

        <div className="flex-1" />

        <nav className="flex items-center gap-4 text-13">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded-sm text-secondary transition-colors duration-120 ease-standard hover:text-primary"
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}
