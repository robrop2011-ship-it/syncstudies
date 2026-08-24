/**
 * Session access for the Next.js side (PLAN.md §11.1).
 *
 * `@syncstudy/auth` owns the crypto and the database rows; this file owns the
 * cookie jar and the redirect. The realtime service calls the same package with
 * a raw `Cookie:` header, which is why none of that logic lives here.
 */
import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  SESSION_COOKIE,
  sessionCookieOptions,
  validateSessionToken,
  type ActiveSession,
} from '@syncstudy/auth';
import { HttpProblem } from '@/lib/server/respond';

export type { ActiveSession };

/**
 * `middleware.ts` cannot import `@syncstudy/auth` — the package reaches for
 * `node:crypto`, argon2 and Prisma, none of which exist in the edge runtime — so
 * it hardcodes the cookie name. This annotation is the compile-time tie between
 * the two: rename the cookie in the auth package and this line stops compiling.
 */
export const SESSION_COOKIE_NAME: 'ss_session' = SESSION_COOKIE;

export async function getSessionToken(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(SESSION_COOKIE)?.value ?? null;
}

/**
 * The current session, or null.
 *
 * `cache()` dedupes within a request, so a layout, a page and a route handler
 * asking independently cost one query between them.
 */
export const getCurrentSession = cache(async (): Promise<ActiveSession | null> => {
  const token = await getSessionToken();
  if (token === null) return null;
  return validateSessionToken(token);
});

/**
 * For pages. Redirects to `/login?next=…` when signed out.
 *
 * `middleware.ts` performs the same redirect from the cookie's presence alone;
 * this is the authoritative check (the cookie may be expired, revoked, or point
 * at a deleted account) and the reason middleware never touches the database.
 */
export async function requireSession(nextPath = '/dashboard'): Promise<ActiveSession> {
  const session = await getCurrentSession();
  if (session === null) redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  return session;
}

/** For route handlers. Throws a 401 that `apiHandler` renders. */
export async function requireApiSession(): Promise<{ session: ActiveSession; token: string }> {
  const token = await getSessionToken();
  const session = token === null ? null : await validateSessionToken(token);
  if (token === null || session === null) {
    throw new HttpProblem('unauthorized', 'Sign in to continue.');
  }
  return { session, token };
}

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, sessionCookieOptions(expiresAt));
}

export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, '', { ...sessionCookieOptions(new Date(0)), maxAge: 0 });
}
