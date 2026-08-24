/**
 * Request-level helpers: client IP (hashed, never stored raw), JSON body
 * reading, and the Origin check that backs up `SameSite=Lax` (PLAN.md §11.1).
 */
import type { NextRequest } from 'next/server';
import { hashIp } from '@syncstudy/auth';
import { HttpProblem } from '@/lib/server/respond';

/**
 * Single-value headers written by our own edge, in the order we believe them.
 *
 * These are *overwritten* (not appended to) by the proxy, so a value a client
 * tries to send is discarded before it reaches us. That makes them strictly
 * safer than `x-forwarded-for` and they are consulted first.
 */
const FORWARD_HEADERS = ['cf-connecting-ip', 'x-real-ip', 'fly-client-ip', 'x-vercel-forwarded-for'] as const;

/**
 * How many proxies we control append to `x-forwarded-for`.
 * Vercel alone, or Cloudflare alone, is 1. Cloudflare in front of Vercel is 2.
 */
function trustedProxyHops(): number {
  const raw = Number.parseInt(process.env.TRUSTED_PROXY_HOPS ?? '1', 10);
  return Number.isFinite(raw) && raw >= 1 ? raw : 1;
}

/**
 * The caller's address, as reported by the edge in front of us.
 *
 * `x-forwarded-for` grows left-to-right: each proxy APPENDS the address of the
 * peer it received the request from. So the leftmost entry is whatever the
 * *caller* chose to send — forgeable, and worthless for rate limiting. Only the
 * entries our own proxies appended, counted in from the RIGHT, are trustworthy.
 *
 * Reading the leftmost entry lets anyone mint a fresh rate-limit identity per
 * request with `curl -H 'X-Forwarded-For: 203.0.113.9'`, which would leave every
 * auth route unmetered — so we never index from the left.
 *
 * Returns null in production when no proxy header is present: the caller is
 * unidentifiable and auth routes must then fail closed (§11.7). In development
 * there is no proxy at all, so a fixed loopback stands in.
 */
export function getClientIp(headers: Headers): string | null {
  for (const name of FORWARD_HEADERS) {
    const value = headers.get(name)?.trim();
    if (value !== undefined && value.length > 0) return value;
  }

  const forwardedFor = headers.get('x-forwarded-for');
  if (forwardedFor !== null) {
    const parts = forwardedFor
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    // `client, proxyA, proxyB` with 1 trusted hop → the last entry is what our
    // edge observed. With 2 hops, step one further in.
    const index = parts.length - trustedProxyHops();
    const candidate = parts[Math.max(0, index)];
    if (candidate !== undefined && candidate.length > 0) return candidate;
  }

  if (process.env.NODE_ENV !== 'production') return '127.0.0.1';
  return null;
}

/**
 * The salt for IP hashing.
 *
 * Missing in production is a hard failure rather than a silent fallback: an
 * unsalted or default-salted hash of an IP is trivially reversible by rainbow
 * table, and §11.9 promises addresses are only ever stored salted-and-hashed.
 */
function ipSalt(): string {
  const salt = process.env.IP_HASH_SALT;
  if (salt !== undefined && salt.length >= 16) return salt;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('IP_HASH_SALT is missing or shorter than 16 characters');
  }
  return 'development-only-ip-hash-salt';
}

/**
 * Salted hash of the caller's address — the only form we keep (§11.9).
 * Also the rate-limit key, so raw addresses never sit in memory either.
 */
export function clientIpHash(headers: Headers): string | null {
  const ip = getClientIp(headers);
  return ip === null ? null : hashIp(ip, ipSalt());
}

export function userAgentOf(headers: Headers): string | null {
  return headers.get('user-agent');
}

/**
 * Read a JSON body.
 *
 * Requiring `content-type: application/json` is a CSRF control as much as a
 * parsing one: an HTML form cross-posting to this route cannot set that header,
 * so it is rejected before any handler logic runs.
 */
export async function readJson(req: NextRequest): Promise<unknown> {
  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new HttpProblem('bad_request', 'Send this request as JSON.');
  }
  try {
    return await req.json();
  } catch {
    throw new HttpProblem('bad_request', 'That request body was not valid JSON.');
  }
}

function hostOf(value: string): string | null {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

/**
 * Every state-changing route requires `Origin` to match us (§11.1).
 *
 * `SameSite=Lax` already blocks cross-site POSTs in current browsers; this is the
 * belt to that pair of braces, and it costs one header read.
 */
export function requireSameOrigin(req: NextRequest): void {
  if (req.method === 'GET' || req.method === 'HEAD') return;

  const origin = req.headers.get('origin');
  if (origin === null) {
    throw new HttpProblem('forbidden', 'That request is missing its origin.');
  }
  const originHost = hostOf(origin);
  if (originHost === null) {
    throw new HttpProblem('forbidden', "That request didn't come from SyncStudy.");
  }

  const allowed = new Set<string>();
  const forwardedHost = req.headers.get('x-forwarded-host');
  if (forwardedHost !== null) allowed.add(forwardedHost);
  const host = req.headers.get('host');
  if (host !== null) allowed.add(host);
  // NEXT_PUBLIC_APP_URL is the canonical origin in .env.example; APP_ORIGIN is
  // honoured first for a deployment that sets one without the public copy.
  const configured = process.env.APP_ORIGIN ?? process.env.NEXT_PUBLIC_APP_URL;
  if (configured !== undefined) {
    const configuredHost = hostOf(configured);
    if (configuredHost !== null) allowed.add(configuredHost);
  }

  if (!allowed.has(originHost)) {
    throw new HttpProblem('forbidden', "That request didn't come from SyncStudy.");
  }
}
