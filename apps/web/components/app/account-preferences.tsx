'use client';

/**
 * Bridges the account's saved appearance settings to this device.
 *
 * Two stores exist and they answer different questions. `lib/theme.ts` holds the
 * DEVICE preference in localStorage, applied before first paint by the script in
 * app/layout.tsx. `user_settings.theme` holds the ACCOUNT preference, which is
 * what follows you to a library computer.
 *
 * The rule between them: the account preference seeds a device that has never
 * expressed one; after that the device wins. Without that rule this effect and
 * the header's theme toggle would fight — you would flip to dark, navigate, and
 * watch it snap back to whatever the account said.
 *
 * Reduced motion has no device-level store, so it applies unconditionally.
 */
import { useEffect } from 'react';
import { setTheme, THEME_STORAGE_KEY, type Theme } from '@/lib/theme';

export function applyReduceMotion(reduceMotion: boolean): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (reduceMotion) root.setAttribute('data-reduce-motion', 'true');
  else root.removeAttribute('data-reduce-motion');
}

function deviceHasThemePreference(): boolean {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) !== null;
  } catch {
    // localStorage throws in some private-browsing and embedded contexts. Treat
    // that as "this device cannot hold a preference", so the account's applies.
    return false;
  }
}

export function AccountPreferences({
  theme,
  reduceMotion,
}: {
  theme: Theme;
  reduceMotion: boolean;
}) {
  useEffect(() => {
    if (theme !== 'system' && !deviceHasThemePreference()) setTheme(theme);
  }, [theme]);

  useEffect(() => {
    applyReduceMotion(reduceMotion);
  }, [reduceMotion]);

  return null;
}
