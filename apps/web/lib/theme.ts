/**
 * Theme resolution (PLAN.md §12.3).
 *
 * Three states, not two. `system` is a real state, not "light" — it must clear
 * the attribute entirely so the `prefers-color-scheme` media query in globals.css
 * takes over. Stamping data-theme="light" for a system-light user would freeze
 * them in light mode when their OS flips at sunset.
 *
 * Everything here is framework-free and safe to call from the pre-paint inline
 * script, from the theme toggle, and from the room shell's "dark by default" path.
 */

export type Theme = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'ss-theme';
export const THEME_CHANGE_EVENT = 'ss:themechange';
export const THEMES: readonly Theme[] = ['system', 'light', 'dark'];

export function isTheme(value: unknown): value is Theme {
  return value === 'system' || value === 'light' || value === 'dark';
}

/** What the browser would pick on its own, right now. */
export function systemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  return theme === 'system' ? systemTheme() : theme;
}

/**
 * Read the stored preference. Returns 'system' for anything missing or corrupt,
 * and never throws — localStorage access is a SecurityError in some embedded and
 * private-browsing contexts, and a theme preference is not worth a broken page.
 */
export function getStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'system';
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(raw) ? raw : 'system';
  } catch {
    return 'system';
  }
}

/** Stamp the DOM. Does not persist — `setTheme` does both. */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (theme === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', theme);
  }
}

/** Persist + apply + notify any other mounted toggle in the tree. */
export function setTheme(theme: Theme): void {
  applyTheme(theme);
  if (typeof window === 'undefined') return;
  try {
    if (theme === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Preference is not persistable in this context; the applied theme still holds
    // for the session, which is the part the user can see.
  }
  window.dispatchEvent(new CustomEvent<Theme>(THEME_CHANGE_EVENT, { detail: theme }));
}

/**
 * Subscribe to theme changes from anywhere in the app: this tab's toggle, another
 * tab (the `storage` event), and the OS flipping while the preference is 'system'.
 * Returns an unsubscribe function.
 */
export function subscribeTheme(onChange: (theme: Theme) => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const onCustom = (event: Event): void => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (isTheme(detail)) onChange(detail);
  };
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== THEME_STORAGE_KEY) return;
    const next = isTheme(event.newValue) ? event.newValue : 'system';
    applyTheme(next);
    onChange(next);
  };
  // On 'system' the attribute is absent and the media query does the work, so
  // nothing needs re-stamping — but a consumer showing "System (dark)" wants to know.
  const onSystem = (): void => {
    if (getStoredTheme() === 'system') onChange('system');
  };

  const media =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null;

  window.addEventListener(THEME_CHANGE_EVENT, onCustom);
  window.addEventListener('storage', onStorage);
  media?.addEventListener('change', onSystem);

  return () => {
    window.removeEventListener(THEME_CHANGE_EVENT, onCustom);
    window.removeEventListener('storage', onStorage);
    media?.removeEventListener('change', onSystem);
  };
}

/**
 * The pre-paint script, as a string, injected by app/layout.tsx.
 *
 * It must be inline and synchronous: an external file or a `useEffect` both run
 * after first paint, which is exactly the white-flash-then-dark this exists to
 * prevent. Kept minimal and self-contained — it cannot import anything, because
 * it runs before the bundle does.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');var d=document.documentElement;if(t==='dark'||t==='light'){d.setAttribute('data-theme',t)}else{d.removeAttribute('data-theme')}}catch(e){}})();`;
