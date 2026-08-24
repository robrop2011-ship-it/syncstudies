/**
 * Route protection for `/dashboard` and `/settings` (PLAN.md §14 Phase 2).
 *
 * This checks that a session cookie EXISTS and nothing more. It cannot check
 * whether the session is valid, because middleware runs on the edge runtime with
 * no database connection — and pretending otherwise would mean either shipping
 * Prisma to the edge or trusting a signed claim we would then have to revoke.
 *
 * So the split is: middleware answers "should this person be sent to the login
 * page?" in ~1 ms with no I/O, and every protected page calls `requireSession()`
 * (lib/server/session.ts), which does the real lookup and redirects identically
 * if the cookie is expired, revoked, or points at a deleted account. A stale
 * cookie therefore reaches the page and is rejected there — one extra hop, no
 * false sense of security here.
 */
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Must match `SESSION_COOKIE` in `@syncstudy/auth`. It is hardcoded because that
 * package pulls in `node:crypto`, argon2 and Prisma, none of which load on the
 * edge. `SESSION_COOKIE_NAME` in lib/server/session.ts is a compile-time guard
 * that fails the build if the two ever drift apart.
 */
const SESSION_COOKIE = 'ss_session';

export function middleware(req: NextRequest): NextResponse {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token !== undefined && token.length > 0) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  url.searchParams.set('next', `${req.nextUrl.pathname}${req.nextUrl.search}`);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/dashboard', '/dashboard/:path*', '/settings', '/settings/:path*'],
};
