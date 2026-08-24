/**
 * Session management (PLAN.md §11.1).
 *
 * Opaque random tokens, sha256 of the token stored in Postgres, raw token only
 * ever present in an httpOnly cookie. Deliberately framework-free: the export
 * that matters most is `getSessionFromCookieHeader()`, which the Socket.IO
 * handshake calls with a raw header string and no request context (§11.4).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { prisma, type PrismaClient } from '@syncstudy/db';
import { SESSION_TTL_MS, SESSION_REFRESH_AFTER_MS } from '@syncstudy/shared';

export const SESSION_COOKIE = 'ss_session';

export interface SessionUser {
  id: string;
  handle: string;
  displayName: string;
  avatarKey: string | null;
  isMinor: boolean;
  isGuest: boolean;
  status: string;
}

export interface ActiveSession {
  sessionId: string;
  user: SessionUser;
  expiresAt: Date;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Hash an IP for abuse tracking. Never store or log the address itself (§11.9). */
export function hashIp(ip: string, salt: string): string {
  return sha256(`${salt}:${ip}`).slice(0, 32);
}

export interface CreateSessionOptions {
  ipHash?: string | null;
  userAgent?: string | null;
  db?: PrismaClient;
}

export async function createSession(
  userId: string,
  opts: CreateSessionOptions = {},
): Promise<{ token: string; expiresAt: Date }> {
  const db = opts.db ?? prisma;
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.authSession.create({
    data: {
      id: sha256(token),
      userId,
      expiresAt,
      ipHash: opts.ipHash ?? null,
      userAgent: opts.userAgent?.slice(0, 400) ?? null,
    },
  });
  return { token, expiresAt };
}

/**
 * Validate a raw token. Returns null for missing, unknown, expired, deleted, or
 * suspended accounts — one indistinguishable "not signed in" outcome.
 *
 * Sliding expiry only rewrites the row once a day, so a busy session doesn't
 * turn every request into a write.
 */
export async function validateSessionToken(
  token: string | null | undefined,
  db: PrismaClient = prisma,
): Promise<ActiveSession | null> {
  if (!token) return null;
  const id = sha256(token);

  const row = await db.authSession.findUnique({
    where: { id },
    include: {
      user: {
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
      },
    },
  });

  if (!row) return null;

  if (row.expiresAt.getTime() <= Date.now()) {
    await db.authSession.delete({ where: { id } }).catch(() => undefined);
    return null;
  }
  if (row.user.deletedAt || row.user.status === 'deleted') return null;

  const now = Date.now();
  let expiresAt = row.expiresAt;
  if (now - row.lastSeenAt.getTime() > SESSION_REFRESH_AFTER_MS) {
    expiresAt = new Date(now + SESSION_TTL_MS);
    await db.authSession
      .update({ where: { id }, data: { lastSeenAt: new Date(now), expiresAt } })
      .catch(() => undefined);
  }

  const { deletedAt: _deletedAt, ...user } = row.user;
  return { sessionId: id, user, expiresAt };
}

export async function revokeSession(token: string, db: PrismaClient = prisma): Promise<void> {
  await db.authSession.delete({ where: { id: sha256(token) } }).catch(() => undefined);
}

/** Used after a password change or recovery — everything else must be logged out. */
export async function revokeAllSessions(
  userId: string,
  opts: { exceptToken?: string; db?: PrismaClient } = {},
): Promise<number> {
  const db = opts.db ?? prisma;
  const { count } = await db.authSession.deleteMany({
    where: {
      userId,
      ...(opts.exceptToken ? { id: { not: sha256(opts.exceptToken) } } : {}),
    },
  });
  return count;
}

/**
 * Minimal, dependency-free cookie parsing.
 *
 * The socket handshake gets a raw `Cookie:` header and no framework helpers, so
 * this has to work on a bare string.
 */
export function parseCookieHeader(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/** The function the Socket.IO handshake middleware calls (PLAN.md §11.4). */
export async function getSessionFromCookieHeader(
  cookieHeader: string | null | undefined,
  db: PrismaClient = prisma,
): Promise<ActiveSession | null> {
  const token = parseCookieHeader(cookieHeader)[SESSION_COOKIE];
  return validateSessionToken(token, db);
}

/** Cookie attributes, in one place so web and any future surface can't disagree. */
export function sessionCookieOptions(expiresAt: Date, secure = process.env.NODE_ENV === 'production') {
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
    path: '/',
    expires: expiresAt,
  };
}

/** Constant-time string compare, for CSRF tokens and similar. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
