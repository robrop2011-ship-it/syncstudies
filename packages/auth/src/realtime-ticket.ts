/**
 * Short-lived handshake tickets for the realtime socket (PLAN.md §11.4).
 *
 * WHY THIS EXISTS, since §11.4 says the handshake reads the session cookie:
 *
 * The cookie works only when the browser considers the realtime origin to be the
 * SAME SITE as the web app. That holds for the intended topology —
 * `rt.syncstudy.app` beside `syncstudy.app` — and fails on every PaaS whose
 * wildcard domain is on the Public Suffix List. Two `*.up.railway.app`
 * subdomains are separate registrable domains, so the cookie is third-party
 * there: `SameSite=None` is required to send it at all, and Safari and Firefox
 * refuse it even then. The handshake returns `unauthenticated`, the client
 * bounces to `/login`, the login page sees a perfectly valid session and bounces
 * back, and the room flickers between the two forever.
 *
 * A ticket removes the browser's cookie policy from the path entirely. The web
 * app — which reads the cookie first-party, where it always works — mints an
 * opaque token into Redis; the client hands it to the socket in the handshake
 * `auth` payload; the realtime service redeems it for a user id.
 *
 * Three properties keep this from being a weaker session:
 *
 *   - It is stored HASHED, like the session token itself. Redis holds
 *     sha256(ticket), so a dump of the live tier yields nothing usable.
 *   - It is single-use and expires in two minutes, so a leaked one is worth
 *     almost nothing. The client mints a fresh one per connection attempt.
 *   - It travels in the handshake `auth` payload, never a query string. That
 *     distinction is the point of §11.4's "no token in a query string": query
 *     strings land in access logs and Referer headers, and `auth` does not.
 *
 * The cookie path is retained as a fallback, so a same-site deployment keeps
 * working with no ticket at all.
 */
import { createHash, randomBytes } from 'node:crypto';
import { prisma, type PrismaClient } from '@syncstudy/db';
import type { SessionUser } from './session';

/**
 * Two minutes. Long enough to survive a slow page load and a retry or two,
 * short enough that a ticket captured from memory is stale before it is useful.
 */
export const REALTIME_TICKET_TTL_MS = 120_000;

/** Same 32 bytes of entropy as a session token. */
export function generateRealtimeTicket(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The Redis key holding a ticket, derived from its HASH.
 *
 * Defined here rather than in the realtime service's key map because both tiers
 * need it and they must not drift: the web app writes this key and the realtime
 * service reads it. One definition, imported by both.
 */
export function realtimeTicketKey(ticket: string): string {
  return `rt:ticket:${createHash('sha256').update(ticket).digest('hex')}`;
}

/**
 * The user behind a redeemed ticket, in the shape the handshake already expects
 * from a cookie session.
 *
 * Reads Postgres rather than trusting a snapshot written at mint time: an
 * account suspended or deleted in the last two minutes must not be able to open
 * a socket on a ticket issued before that.
 */
export async function sessionUserById(
  userId: string,
  db: PrismaClient = prisma,
): Promise<SessionUser | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      handle: true,
      displayName: true,
      avatarKey: true,
      isMinor: true,
      isGuest: true,
      status: true,
      deletedAt: true,
    },
  });

  if (!user) return null;
  if (user.deletedAt || user.status === 'deleted') return null;

  return {
    id: user.id,
    handle: user.handle,
    displayName: user.displayName,
    avatarKey: user.avatarKey,
    isMinor: user.isMinor,
    isGuest: user.isGuest,
    status: user.status,
  };
}
