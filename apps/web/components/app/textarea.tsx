'use client';

/**
 * A textarea styled to match `<Input>`.
 *
 * Not part of components/ui because the account surface is the only place that
 * needs one; if a second caller appears it should move there.
 */
import type { TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  invalid?: boolean | undefined;
};

export function Textarea(props: TextareaProps) {
  const { invalid = false, className, ...rest } = props;

  return (
    <textarea
      {...rest}
      aria-invalid={invalid || undefined}
      className={cn(
        'w-full resize-y rounded-md border bg-bg px-3 py-2 text-sm leading-5 text-primary',
        'placeholder:text-tertiary',
        'transition-colors duration-120 ease-standard',
        'focus-visible:border-accent',
        'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-tertiary',
        invalid ? 'border-danger' : 'border-border-strong',
        className,
      )}
    />
  );
}
