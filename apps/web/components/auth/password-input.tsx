'use client';

/**
 * Password field with a show/hide toggle.
 *
 * The toggle is why there is no "confirm password" field anywhere in this app:
 * letting someone read what they typed catches a typo better than asking them to
 * make the same typo twice.
 *
 * Props are forwarded verbatim to `<Input>` — including the `aria-describedby`
 * that `<Field>` injects into its child, which is why nothing here sets one of
 * its own. Overwriting it would quietly unhook the error message from the input
 * for a screen reader, and that failure is invisible to everyone who can see.
 */
import type { InputHTMLAttributes } from 'react';
import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export type PasswordInputProps = InputHTMLAttributes<HTMLInputElement> & {
  invalid?: boolean | undefined;
};

export function PasswordInput(props: PasswordInputProps) {
  const { className, ...rest } = props;
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <Input {...rest} type={visible ? 'text' : 'password'} className={cn('pr-10', className)} />
      <button
        type="button"
        onClick={() => {
          setVisible((current) => !current);
        }}
        // The label names the action, not the state: announcing "Show password"
        // on a field that is already showing would be a lie.
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
        className={cn(
          'absolute right-1 top-1/2 flex h-7 w-8 -translate-y-1/2 items-center justify-center rounded-sm',
          'text-tertiary transition-colors duration-120 ease-standard',
          'hover:text-secondary',
        )}
      >
        {visible ? <EyeOff size={16} strokeWidth={1.5} /> : <Eye size={16} strokeWidth={1.5} />}
      </button>
    </div>
  );
}
