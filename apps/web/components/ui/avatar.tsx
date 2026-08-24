import * as React from 'react';
import * as AvatarPrimitive from '@radix-ui/react-avatar';
import { cn } from '@/lib/utils';

export type AvatarSize = 20 | 24 | 32 | 40 | 64;

const SIZE_CLASS: Record<AvatarSize, string> = {
  20: 'h-5 w-5 text-[11px] rounded-sm',
  24: 'h-6 w-6 text-[11px] rounded-sm',
  32: 'h-8 w-8 text-13 rounded-md',
  40: 'h-10 w-10 text-sm rounded-md',
  64: 'h-16 w-16 text-xl rounded-lg',
};

/** The five tints defined in globals.css. All are existing tokens; none is red. */
const TINT_COUNT = 5;

/**
 * FNV-1a. Deterministic, stable across processes, and — unlike `String#hashCode`
 * style loops on `charCodeAt` alone — spreads short handles like `sam` and `sammy`
 * into different buckets instead of adjacent ones.
 */
function hashHandle(handle: string): number {
  let h = 0x811c9dc5;
  const key = handle.toLowerCase();
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return Math.abs(h);
}

function initial(name: string, handle: string): string {
  const source = name.trim() || handle.trim();
  // Array.from, not [0]: an emoji or an accented cluster must not be sliced in half.
  const first = Array.from(source)[0];
  return first ? first.toUpperCase() : '?';
}

/**
 * Avatar with a generated fallback.
 *
 * The fallback is computed locally from the handle — no Gravatar, no DiceBear, no
 * outbound request of any kind. PLAN.md §11.9 is explicit that we hold no contact
 * identifier, and shipping a hash of one to a third party would quietly undo that.
 */
export function Avatar({
  name,
  handle,
  src,
  size = 32,
  className,
}: {
  name: string;
  handle: string;
  src?: string | null | undefined;
  size?: AvatarSize | undefined;
  className?: string | undefined;
}): React.JSX.Element {
  const tint = hashHandle(handle) % TINT_COUNT;

  return (
    <AvatarPrimitive.Root
      className={cn(
        'relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden border border-border',
        SIZE_CLASS[size],
        className,
      )}
    >
      {src ? (
        // alt="" on purpose: every place this renders (participant row, chat line,
        // profile header) puts the display name in text right beside it, and an
        // alt would make a screen reader announce the same name twice per row.
        <AvatarPrimitive.Image
          src={src}
          alt=""
          className="h-full w-full object-cover"
          draggable={false}
        />
      ) : null}
      <AvatarPrimitive.Fallback
        // No delay: a delayed fallback shows an empty hole first, which reads as a
        // broken image on the exact rows (participant list) that update most often.
        className={cn(
          'flex h-full w-full items-center justify-center font-medium leading-none',
          `ss-avatar-${tint}`,
        )}
      >
        {initial(name, handle)}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}
