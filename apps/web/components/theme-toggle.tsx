'use client';

import * as React from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { getStoredTheme, setTheme, subscribeTheme, type Theme } from '@/lib/theme';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

const OPTIONS: ReadonlyArray<{ value: Theme; label: string; Icon: typeof Monitor }> = [
  { value: 'system', label: 'Match system', Icon: Monitor },
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
];

/**
 * Three states, not a two-state toggle. "System" is the default and has to be
 * reachable — a binary switch strands anyone whose OS flips at sunset in whichever
 * mode they last happened to be in.
 *
 * The first client render deliberately shows 'system' regardless of what is
 * stored, matching what the server rendered; the effect corrects it a tick later.
 * Reading localStorage during render would produce a hydration mismatch, and the
 * page is already showing the right *colours* by then — the pre-paint script in
 * app/layout.tsx handled that before React existed.
 */
export function ThemeToggle({ className }: { className?: string | undefined }): React.JSX.Element {
  const [theme, setThemeState] = React.useState<Theme>('system');

  React.useEffect(() => {
    setThemeState(getStoredTheme());
    return subscribeTheme(setThemeState);
  }, []);

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className={cn(
        'inline-flex items-center gap-0.5 rounded-md border border-border p-0.5',
        className,
      )}
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = theme === value;
        return (
          <Tooltip key={value}>
            <TooltipTrigger asChild>
              <button
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={label}
                onClick={() => {
                  setTheme(value);
                  setThemeState(value);
                }}
                className={cn(
                  'inline-flex h-6 w-6 items-center justify-center rounded-sm',
                  'transition-colors duration-120 ease-standard',
                  active
                    ? 'bg-surface-2 text-primary'
                    : 'text-tertiary hover:bg-surface-2 hover:text-secondary',
                )}
              >
                <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
