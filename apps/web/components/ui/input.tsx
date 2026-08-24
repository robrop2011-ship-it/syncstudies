import * as React from 'react';
import { cn } from '@/lib/utils';

export type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  invalid?: boolean | undefined;
};

/**
 * `invalid` drives both the border and `aria-invalid`, so the state can never be
 * conveyed by colour alone (PLAN.md §12.6). The message itself belongs in
 * <Field error=…>, inline and next to the cause — never in a toast.
 */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid = false, type = 'text', ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      type={type}
      aria-invalid={invalid || undefined}
      className={cn(
        'h-9 w-full rounded-md border bg-bg px-2.5 text-sm text-primary',
        'transition-[border-color] duration-120 ease-standard',
        'hover:border-border-strong',
        'focus-visible:border-accent',
        'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-tertiary',
        invalid ? 'border-danger hover:border-danger' : 'border-border-strong',
        className,
      )}
      {...rest}
    />
  );
});
