/**
 * The bundled link blocklist (PLAN.md §11.6).
 *
 * "Domains on a small bundled blocklist (known phishing/grabber/malware hosts,
 * refreshed monthly) render as plain text with a warning badge and are not
 * clickable."
 *
 * Three things this deliberately is not:
 *
 * - **Not a live feed.** A network fetch on the render path of every message is
 *   a latency cost, an outage surface, and a way for a third party to learn what
 *   students are linking to. Monthly, in a commit, reviewed like code.
 * - **Not comprehensive.** It cannot be. It exists to catch the handful of
 *   grabber and token-stealer domains that circulate in student communities,
 *   not to be an anti-malware product. Everything else relies on the link being
 *   plainly visible, unfurled by nothing, and marked `nofollow`.
 * - **Not a moderation decision.** A blocked host is still shown as text, so
 *   nothing is hidden from the reader — it is simply not one click away.
 *
 * Matching is host-suffix based, so `sub.grabify.link` is caught by `grabify.link`
 * without also catching `notgrabify.link`.
 */

/**
 * Seeded with the IP-grabber and link-logger families, which are the ones that
 * actually show up in a study room: they are marketed as pranks, they deanonymise
 * whoever clicks, and they are trivially reachable by a fourteen-year-old.
 *
 * Add entries as bare registrable domains, lowercase, no scheme, no `www.`.
 */
const BLOCKED_HOSTS: readonly string[] = [
  'grabify.link',
  'iplogger.org',
  'iplogger.com',
  'iplogger.ru',
  'iplis.ru',
  '2no.co',
  'yip.su',
  'iplo.ru',
  'blasze.tk',
  'blasze.com',
  'ps3cfw.com',
  'stopify.co',
  'kraken-files.com',
];

const BLOCKED = new Set(BLOCKED_HOSTS);

/**
 * `true` when this host, or any parent of it, is on the list.
 *
 * Walks labels off the front rather than using `endsWith`: `endsWith('2no.co')`
 * would also match `evil2no.co`, which is a different site and possibly an
 * innocent one.
 */
export function isBlockedHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, '');
  let candidate = normalized;
  for (;;) {
    if (BLOCKED.has(candidate)) return true;
    const dot = candidate.indexOf('.');
    if (dot === -1) return false;
    candidate = candidate.slice(dot + 1);
    if (!candidate.includes('.')) return BLOCKED.has(candidate);
  }
}
