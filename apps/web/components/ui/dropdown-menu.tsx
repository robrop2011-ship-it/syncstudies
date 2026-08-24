'use client';

import * as React from 'react';
import * as MenuPrimitive from '@radix-ui/react-dropdown-menu';
import { cn } from '@/lib/utils';

export const DropdownMenu = MenuPrimitive.Root;
export const DropdownMenuTrigger = MenuPrimitive.Trigger;

export const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof MenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.Content>
>(function DropdownMenuContent({ className, sideOffset = 6, ...rest }, ref) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          'z-50 min-w-44 overflow-hidden rounded-md border border-border bg-bg p-1 shadow-menu',
          'data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out',
          className,
        )}
        {...rest}
      />
    </MenuPrimitive.Portal>
  );
});

export const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof MenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.Item> & {
    /** Destructive entries read in --danger; they still get a confirm step upstream. */
    destructive?: boolean | undefined;
  }
>(function DropdownMenuItem({ className, destructive = false, ...rest }, ref) {
  return (
    <MenuPrimitive.Item
      ref={ref}
      className={cn(
        // 32px rows, the same density as the participant list (PLAN.md §12.1 rule 8).
        'flex h-8 cursor-default select-none items-center gap-2 rounded-sm px-2 text-13 outline-none',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        '[&_svg]:shrink-0',
        destructive
          ? 'text-danger data-[highlighted]:bg-danger-subtle'
          : 'text-primary data-[highlighted]:bg-surface-2',
        className,
      )}
      {...rest}
    />
  );
});

export const DropdownMenuSeparator = React.forwardRef<
  React.ElementRef<typeof MenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.Separator>
>(function DropdownMenuSeparator({ className, ...rest }, ref) {
  return (
    <MenuPrimitive.Separator
      ref={ref}
      className={cn('-mx-1 my-1 h-px bg-border', className)}
      {...rest}
    />
  );
});

export const DropdownMenuLabel = React.forwardRef<
  React.ElementRef<typeof MenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.Label>
>(function DropdownMenuLabel({ className, ...rest }, ref) {
  return (
    <MenuPrimitive.Label
      ref={ref}
      // The one place all-caps is allowed: 11px / 500 / 0.04em section labels.
      className={cn(
        'px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-[0.04em] text-tertiary',
        className,
      )}
      {...rest}
    />
  );
});
