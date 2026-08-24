// Deliberately NOT a 'use client' module. `buttonVariants` is called directly by
// server components (site-header, the marketing page) to style <Link>s, and every
// export of a 'use client' module becomes a client reference that throws if the
// server tries to call it.
import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { Spinner } from './spinner';

export type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type Size = 'sm' | 'md';

/**
 * Exactly one variant is accent-filled (PLAN.md §12.1 rule 2). `secondary` is the
 * bordered workhorse and is the default, so reaching for the accent has to be a
 * deliberate act rather than the path of least resistance.
 *
 * `danger` is bordered too, not red-filled: §12.4 is explicit that a filled red
 * button next to a video invites the misclick it is trying to guard against.
 */
const button = cva(
  [
    'inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap',
    'rounded-md border font-medium',
    'transition-[background-color,border-color,color,opacity] duration-120 ease-standard',
    'disabled:pointer-events-none disabled:opacity-50',
    '[&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        primary:
          'border-accent bg-accent text-accent-text hover:border-accent-hover hover:bg-accent-hover',
        secondary: 'border-border-strong bg-transparent text-primary hover:bg-surface-2',
        ghost:
          'border-transparent bg-transparent text-secondary hover:bg-surface-2 hover:text-primary',
        danger:
          'border-border-strong bg-transparent text-danger hover:border-danger hover:bg-danger-subtle',
      },
      size: {
        sm: 'h-8 px-2.5 text-13',
        md: 'h-9 px-3.5 text-sm',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

/** The class string on its own, for links and other non-`<button>` triggers. */
export function buttonVariants(opts?: {
  variant?: Variant | undefined;
  size?: Size | undefined;
}): string {
  return button({ variant: opts?.variant, size: opts?.size });
}

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant | undefined;
  size?: Size | undefined;
  loading?: boolean | undefined;
  asChild?: boolean | undefined;
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant,
    size = 'md',
    loading = false,
    asChild = false,
    className,
    children,
    disabled,
    ...rest
  },
  ref,
) {
  const classes = cn(buttonVariants({ variant, size }), className);

  // asChild hands rendering to the caller's element (usually a Next <Link>), so
  // there is nowhere safe to inject a spinner or a disabled attribute.
  if (asChild) {
    return (
      <Slot ref={ref} className={classes} {...rest}>
        {children}
      </Slot>
    );
  }

  return (
    <button
      ref={ref}
      className={classes}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={size === 'sm' ? 14 : 16} /> : null}
      {children}
    </button>
  );
});
