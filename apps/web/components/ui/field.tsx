import * as React from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import { cn } from '@/lib/utils';

export type FieldProps = {
  label: string;
  htmlFor: string;
  hint?: string | undefined;
  error?: string | undefined;
  children: React.ReactNode;
  optional?: boolean | undefined;
  className?: string | undefined;
};

type DescribableProps = { 'aria-describedby'?: string | undefined };

/**
 * The standard form row: label, control, then hint or error.
 *
 * The error replaces the hint rather than stacking under it — two lines of
 * secondary text below one input is how a form starts to look like a settings
 * page. Errors sit inline in --danger next to the cause, never in a toast (§12.5).
 *
 * `aria-describedby` is wired onto the child control automatically, so a caller
 * cannot forget the half of the accessibility contract that isn't visible.
 */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  optional = false,
  className,
}: FieldProps): React.JSX.Element {
  const hintId = `${htmlFor}-hint`;
  const errorId = `${htmlFor}-error`;
  const messageId = error ? errorId : hint ? hintId : undefined;

  const child = React.isValidElement<DescribableProps>(children)
    ? React.cloneElement(children, {
        'aria-describedby':
          [children.props['aria-describedby'], messageId].filter(Boolean).join(' ') || undefined,
      })
    : children;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex items-baseline justify-between gap-2">
        <LabelPrimitive.Root htmlFor={htmlFor} className="text-13 font-medium text-primary">
          {label}
        </LabelPrimitive.Root>
        {optional ? <span className="text-13 text-tertiary">Optional</span> : null}
      </div>

      {child}

      {error ? (
        <p id={errorId} className="text-13 text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-13 text-secondary">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
