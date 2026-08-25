'use client';

/**
 * A textarea styled to match `<Input>`.
 *
 * It lived under `components/app/` while the account surface was its only
 * caller, with a note saying to move it here when a second one appeared. The
 * room's report dialog and the "pin a question" dialog are the second and third.
 *
 * `forwardRef` because a dialog that opens on a keypress has to be able to put
 * the caret in the field; `autoFocus` alone loses that race with Radix's own
 * focus management often enough to be a real annoyance.
 */
import { forwardRef, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  invalid?: boolean | undefined;
};

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid = false, className, ...rest },
  ref,
) {
  return (
    <textarea
      {...rest}
      ref={ref}
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
});
