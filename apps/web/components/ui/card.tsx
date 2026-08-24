import type * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A card is a 1px border and nothing else — no shadow, no gradient, no hover lift.
 * PLAN.md §12.2 names `shadow-2xl` on a card as a thing not to do; elevation is
 * reserved for layers that genuinely float above the page (dropdown, dialog, toast).
 */
export function Card({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn('rounded-lg border border-border bg-bg', className)} {...rest} />;
}

export function CardHeader({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: string | undefined;
  action?: React.ReactNode;
  className?: string | undefined;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex items-start justify-between gap-4 border-b border-border px-4 py-3',
        className,
      )}
    >
      <div className="min-w-0">
        <h3 className="text-sm font-medium text-primary">{title}</h3>
        {description ? <p className="mt-0.5 text-13 text-secondary">{description}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function CardBody({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn('p-4', className)} {...rest} />;
}
