'use client';

/**
 * The signed-in slot of `<SiteHeader actions=…>`.
 *
 * Rooms and Settings live in this menu rather than as top-level nav items: the
 * signed-in app has exactly two destinations outside a room, and a nav bar for
 * two links is furniture.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, LayoutGrid, LogOut, Settings } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

export interface UserMenuProps {
  displayName: string;
  handle: string;
  avatarUrl: string | null;
}

export function UserMenu({ displayName, handle, avatarUrl }: UserMenuProps) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  const signOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await api.send('POST', '/api/auth/logout');
    } finally {
      // Whether or not there was a row left to delete, the intent was to end up
      // signed out — so the destination is the same either way.
      router.push('/login');
      router.refresh();
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex h-8 items-center gap-2 rounded-md border border-transparent pl-1 pr-1.5 text-13',
            'text-primary transition-colors duration-120 ease-standard hover:bg-surface-2',
          )}
        >
          <Avatar name={displayName} handle={handle} src={avatarUrl} size={24} />
          <span className="hidden max-w-[140px] truncate sm:inline">{displayName}</span>
          <ChevronDown size={16} strokeWidth={1.5} aria-hidden="true" className="text-tertiary" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{handle}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            router.push('/dashboard');
          }}
        >
          <LayoutGrid size={16} strokeWidth={1.5} aria-hidden="true" />
          Rooms
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            router.push('/settings/profile');
          }}
        >
          <Settings size={16} strokeWidth={1.5} aria-hidden="true" />
          Settings
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            void signOut();
          }}
        >
          <LogOut size={16} strokeWidth={1.5} aria-hidden="true" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
