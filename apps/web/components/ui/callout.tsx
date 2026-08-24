import type * as React from 'react';
import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';

export type CalloutTone = 'info' | 'success' | 'warning' | 'danger';

const TONE: Record<
  CalloutTone,
  { icon: typeof Info; wrapper: string; iconColor: string; title: string }
> = {
  info: {
    icon: Info,
    wrapper: 'border-border bg-surface-1',
    iconColor: 'text-secondary',
    title: 'text-primary',
  },
  success: {
    icon: CircleCheck,
    wrapper: 'border-success/35 bg-success-subtle',
    iconColor: 'text-success',
    title: 'text-primary',
  },
  warning: {
    icon: TriangleAlert,
    wrapper: 'border-warning/35 bg-warning-subtle',
    iconColor: 'text-warning',
    title: 'text-primary',
  },
  danger: {
    icon: CircleAlert,
    wrapper: 'border-danger/35 bg-danger-subtle',
    iconColor: 'text-danger',
    title: 'text-primary',
  },
};

/**
 * An inline message block — not a toast. Toasts are for background events the
 * user didn't cause ("Sam joined"); anything caused by the thing on screen is
 * explained next to the thing on screen (PLAN.md §12.5).
 *
 * Tone is carried by an icon as well as a colour, so it survives a colour-blind
 * reader and a greyscale screenshot alike.
 */
export function Callout({
  tone,
  title,
  children,
  className,
}: {
  tone: CalloutTone;
  title?: string | undefined;
  children: React.ReactNode;
  className?: string | undefined;
}): React.JSX.Element {
  const spec = TONE[tone];
  const Icon = spec.icon;

  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn('flex gap-2.5 rounded-md border p-3', spec.wrapper, className)}
    >
      <Icon aria-hidden="true" size={16} strokeWidth={1.5} className={cn('mt-0.5', spec.iconColor)} />
      <div className="min-w-0 flex-1">
        {title ? (
          <p className={cn('text-13 font-medium', spec.title)}>{title}</p>
        ) : null}
        <div className={cn('text-13 text-secondary', title ? 'mt-0.5' : undefined)}>{children}</div>
      </div>
    </div>
  );
}
