'use client';

import type * as React from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { cn } from '@/lib/utils';

/**
 * A switch commits immediately — there is no Save button behind it. That is why
 * it is only used for settings that are genuinely instant; anything needing a
 * round trip with a failure mode belongs in a form.
 *
 * The pill shape here is not the "rounded-full everywhere" anti-pattern from
 * §12.2: a track and thumb is what a switch is, and squaring it off would make it
 * read as a checkbox.
 */
export function Switch({
  checked,
  onCheckedChange,
  id,
  disabled = false,
  className,
}: {
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
  id?: string | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
}): React.JSX.Element {
  return (
    <SwitchPrimitive.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      className={cn(
        // 36×20 track, 2px inset, 16px thumb → exactly 16px of travel (translate-x-4).
        'inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5',
        'transition-colors duration-120 ease-standard',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'data-[state=unchecked]:bg-surface-3 data-[state=checked]:bg-accent',
        className,
      )}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'block h-4 w-4 rounded-full bg-bg',
          'transition-transform duration-120 ease-standard',
          'data-[state=unchecked]:translate-x-0 data-[state=checked]:translate-x-4',
        )}
      />
    </SwitchPrimitive.Root>
  );
}
