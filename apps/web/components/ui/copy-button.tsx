'use client';

import * as React from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { buttonVariants } from './button';

const CONFIRM_MS = 1200;

/**
 * Copy, with the confirmation on the button itself.
 *
 * PLAN.md §12.5 is specific here: the icon flips to a check for 1.2s and there is
 * no toast. Copying the room link is the most-used action after Play, and a toast
 * per copy would mean a toast every few minutes in a live room.
 */
export function CopyButton({
  value,
  label,
  className,
}: {
  value: string;
  label?: string | undefined;
  className?: string | undefined;
}): React.JSX.Element {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  async function copy(): Promise<void> {
    const ok = await writeToClipboard(value);
    if (!ok) return;
    setCopied(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), CONFIRM_MS);
  }

  const accessibleLabel = label ?? 'Copy';

  return (
    <button
      type="button"
      onClick={() => {
        void copy();
      }}
      aria-label={accessibleLabel}
      className={cn(
        buttonVariants({ variant: 'ghost', size: 'sm' }),
        label ? undefined : 'w-8 px-0',
        className,
      )}
    >
      {copied ? (
        <Check size={16} strokeWidth={1.5} aria-hidden="true" className="text-success" />
      ) : (
        <Copy size={16} strokeWidth={1.5} aria-hidden="true" />
      )}
      {label ? <span>{label}</span> : null}
      {/* Sighted users get the icon flip; this is the same signal for everyone else. */}
      <span aria-live="polite" className="sr-only">
        {copied ? 'Copied' : ''}
      </span>
    </button>
  );
}

/**
 * `navigator.clipboard` is undefined on insecure origins and inside some in-app
 * browsers, which is exactly where a shared room link gets opened. The execCommand
 * path is deprecated but still the only fallback that works there.
 */
async function writeToClipboard(value: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Fall through to the legacy path rather than failing silently.
    }
  }
  if (typeof document === 'undefined') return false;
  const field = document.createElement('textarea');
  field.value = value;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.appendChild(field);
  field.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(field);
  return ok;
}
