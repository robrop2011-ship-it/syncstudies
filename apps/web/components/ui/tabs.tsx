'use client';

import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '@/lib/utils';

export const Tabs = TabsPrimitive.Root;

export const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(function TabsList({ className, ...rest }, ref) {
  return (
    <TabsPrimitive.List
      ref={ref}
      className={cn('flex items-stretch gap-1 border-b border-border', className)}
      {...rest}
    />
  );
});

/**
 * Active state is a 2px accent underline plus a text-colour change — never a
 * filled pill. The transparent border is present in both states and the trigger
 * is pulled up by 1px to sit on the list's own border, so switching tabs moves
 * nothing.
 */
export const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(function TabsTrigger({ className, ...rest }, ref) {
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        'relative -mb-px inline-flex h-9 items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-2.5',
        'text-13 font-medium text-secondary',
        'transition-[color,border-color] duration-120 ease-standard',
        'hover:text-primary',
        'disabled:pointer-events-none disabled:opacity-50',
        'data-[state=active]:border-accent data-[state=active]:text-primary',
        '[&_svg]:shrink-0',
        className,
      )}
      {...rest}
    />
  );
});

export const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(function TabsContent({ className, ...rest }, ref) {
  return <TabsPrimitive.Content ref={ref} className={cn('outline-none', className)} {...rest} />;
});
