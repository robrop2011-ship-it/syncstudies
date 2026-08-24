'use client';

/**
 * A native `<select>` styled to sit next to `<Input>`.
 *
 * The UI kit (components/ui) has no select primitive, and a Radix listbox would
 * be a worse trade here: a native select gets the platform picker on phones,
 * keyboard type-ahead for free, and no portal to fight with inside a dialog.
 */
import type { SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export type NativeSelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  invalid?: boolean | undefined;
};

export function NativeSelect(props: NativeSelectProps) {
  const { invalid = false, className, children, ...rest } = props;

  return (
    <div className="relative">
      <select
        {...rest}
        aria-invalid={invalid || undefined}
        className={cn(
          'h-9 w-full appearance-none rounded-md border bg-bg pl-3 pr-9 text-sm text-primary',
          'transition-colors duration-120 ease-standard',
          'focus-visible:border-accent',
          'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-tertiary',
          invalid ? 'border-danger' : 'border-border-strong',
          className,
        )}
      >
        {children}
      </select>
      <ChevronDown
        size={16}
        strokeWidth={1.5}
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-tertiary"
      />
    </div>
  );
}
