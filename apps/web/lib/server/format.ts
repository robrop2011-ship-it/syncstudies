/**
 * Small formatting helpers for server-rendered surfaces.
 *
 * Rendered on the server only, so there is no clock skew between markup and
 * hydration to worry about.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now" · "12m ago" · "3h ago" · "5d ago" · "12 Mar". */
export function relativeTime(value: Date, now: Date = new Date()): string {
  const elapsed = now.getTime() - value.getTime();
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) return `${Math.round(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `${Math.round(elapsed / HOUR)}h ago`;
  if (elapsed < 7 * DAY) return `${Math.round(elapsed / DAY)}d ago`;
  return value.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export function formatDate(value: Date): string {
  return value.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}
