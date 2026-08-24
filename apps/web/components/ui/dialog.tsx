'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

/**
 * A dialog is one of the three layers allowed a shadow (PLAN.md §12.1 rule 1),
 * because it genuinely floats. The scrim is a flat alpha of the primary text
 * colour — no `backdrop-filter: blur()`, which §12.1 rule 5 rules out for being
 * expensive on the Chromebooks half our users are on.
 */
export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    /** Set false for a flow the user must complete or explicitly cancel. */
    showClose?: boolean | undefined;
  }
>(function DialogContent({ className, children, showClose = true, ...rest }, ref) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        className={cn(
          'fixed inset-0 z-50 bg-scrim',
          'data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out',
        )}
      />
      {/* Centring lives on this wrapper, not on Content: a `-translate-1/2` on
          Content and a keyframe that animates `transform` are the same property,
          and the animation would fling the dialog into the corner for 160ms.
          pointer-events-none lets outside clicks reach the overlay underneath. */}
      <div className="ss-scroll pointer-events-none fixed inset-0 z-50 flex items-center justify-center overflow-y-auto p-4">
        <DialogPrimitive.Content
          ref={ref}
          className={cn(
            'pointer-events-auto relative my-auto w-full max-w-md',
            'rounded-modal border border-border bg-bg shadow-modal',
            'data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out',
            className,
          )}
          {...rest}
        >
          {children}
          {showClose ? (
            <DialogPrimitive.Close
              aria-label="Close"
              className={cn(
                'absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center rounded-md',
                'text-tertiary transition-colors duration-120 ease-standard',
                'hover:bg-surface-2 hover:text-primary',
              )}
            >
              <X size={16} strokeWidth={1.5} />
            </DialogPrimitive.Close>
          ) : null}
        </DialogPrimitive.Content>
      </div>
    </DialogPrimitive.Portal>
  );
});

export const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function DialogTitle({ className, ...rest }, ref) {
  return (
    <DialogPrimitive.Title
      ref={ref}
      className={cn('px-4 pr-12 pt-4 text-base font-medium text-primary', className)}
      {...rest}
    />
  );
});

export const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function DialogDescription({ className, ...rest }, ref) {
  return (
    <DialogPrimitive.Description
      ref={ref}
      className={cn('px-4 pb-4 pt-1.5 text-13 text-secondary', className)}
      {...rest}
    />
  );
});

/**
 * Footer actions run left-to-right ending in the confirming action, with the
 * cancel path always present — §12.5 requires a destructive confirm to spell out
 * the consequence, and a footer with only one button gives it nowhere to go.
 */
export function DialogFooter({
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex items-center justify-end gap-2 border-t border-border px-4 py-3',
        className,
      )}
      {...rest}
    />
  );
}
