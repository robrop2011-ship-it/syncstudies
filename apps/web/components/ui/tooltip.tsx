'use client';

import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from '@/lib/utils';

/**
 * Mounted once in app/layout.tsx. `delayDuration` is deliberately not 0: a tooltip
 * that appears the instant the pointer crosses the control bar turns a row of
 * icon buttons into a strobe.
 */
export function TooltipProvider({
  delayDuration = 400,
  skipDelayDuration = 200,
  children,
  ...rest
}: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Provider>): React.JSX.Element {
  return (
    <TooltipPrimitive.Provider
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
      {...rest}
    >
      {children}
    </TooltipPrimitive.Provider>
  );
}

export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

/**
 * Every icon-only button in this app has both a tooltip and an `aria-label`
 * (PLAN.md §12.6). The tooltip is for the mouse; the label is for everyone else.
 */
export const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(function TooltipContent({ className, sideOffset = 6, ...rest }, ref) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          'z-50 rounded-md border border-border bg-bg px-2 py-1 text-13 text-primary shadow-menu',
          'data-[state=delayed-open]:animate-fade-in data-[state=closed]:animate-fade-out',
          className,
        )}
        {...rest}
      />
    </TooltipPrimitive.Portal>
  );
});
