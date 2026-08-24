'use client';

/**
 * Settings sections.
 *
 * Links rather than a `Tabs` widget: each section is its own route, so the back
 * button and a bookmarked URL both behave. Styled as tabs, marked with the
 * accent rule (§12.1 rule 2).
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const SECTIONS = [
  { href: '/settings/profile', label: 'Profile' },
  { href: '/settings/privacy', label: 'Privacy' },
  { href: '/settings/account', label: 'Account' },
] as const;

export function SettingsNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Settings sections"
      className="flex items-stretch gap-1 border-b border-border"
    >
      {SECTIONS.map((section) => {
        const active = pathname === section.href;
        return (
          <Link
            key={section.href}
            href={section.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              '-mb-px inline-flex h-9 items-center border-b-2 px-3 text-sm',
              'transition-colors duration-120 ease-standard',
              active
                ? 'border-accent text-primary'
                : 'border-transparent text-secondary hover:text-primary',
            )}
          >
            {section.label}
          </Link>
        );
      })}
    </nav>
  );
}
