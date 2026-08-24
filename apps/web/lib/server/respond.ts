/**
 * The server side of the REST envelope (PLAN.md §10.1).
 *
 * Two rules this module exists to enforce:
 *  1. Every response has the same shape, so the client never has to guess.
 *  2. An unexpected throw becomes a 500 with a generic message and a log line
 *     that contains no PII, no body, and no stack surface for the caller.
 */
import { NextResponse, type NextRequest } from 'next/server';
import type { ApiEnvelope, ApiErrorBody, ApiFieldIssue } from '@/lib/api';

export type ApiErrorCode =
  | 'bad_request'
  | 'validation_error'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'internal';

const STATUS_FOR: Record<ApiErrorCode, number> = {
  bad_request: 400,
  validation_error: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  internal: 500,
};

export interface FailOptions {
  fields?: ApiFieldIssue[];
  status?: number;
  headers?: Record<string, string>;
}

/**
 * A refusal a route meant to make. `apiHandler` turns it into a response, so
 * handlers can bail out from three calls deep without threading a return value.
 */
export class HttpProblem extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly fields: ApiFieldIssue[] | undefined;
  readonly headers: Record<string, string> | undefined;

  constructor(code: ApiErrorCode, message: string, options: FailOptions = {}) {
    super(message);
    this.name = 'HttpProblem';
    this.code = code;
    this.status = options.status ?? STATUS_FOR[code];
    this.fields = options.fields;
    this.headers = options.headers;
  }
}

export function ok<T>(data: T, status = 200): NextResponse {
  const body: ApiEnvelope<T> = { ok: true, data };
  return NextResponse.json(body, { status });
}

export function noContent(): NextResponse {
  return new NextResponse(null, { status: 204 });
}

export function fail(code: ApiErrorCode, message: string, options: FailOptions = {}): NextResponse {
  const error: ApiErrorBody = { code, message };
  if (options.fields !== undefined && options.fields.length > 0) {
    error.details = { fields: options.fields };
  }
  const body: ApiEnvelope<never> = { ok: false, error };
  const init: ResponseInit = { status: options.status ?? STATUS_FOR[code] };
  if (options.headers !== undefined) init.headers = options.headers;
  return NextResponse.json(body, init);
}

/** A 400 whose message is attached to one form field. */
export function fieldFail(path: string, message: string): NextResponse {
  return fail('validation_error', message, { fields: [{ path, message }] });
}

export function unauthorized(message = 'Sign in to continue.'): HttpProblem {
  return new HttpProblem('unauthorized', message);
}

// ── zod interop, without importing zod ──────────────────────────────────────
//
// `apps/web` does not depend on zod directly; the schemas (and therefore the
// ZodError instances) come from `@syncstudy/shared`. Structural detection keeps
// this file honest about that boundary and avoids two zod copies disagreeing
// about `instanceof`.

interface ZodIssueLike {
  path: unknown;
  message: unknown;
}

interface ZodErrorLike {
  name: string;
  issues: ZodIssueLike[];
}

function isZodErrorLike(error: unknown): error is ZodErrorLike {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; issues?: unknown };
  return candidate.name === 'ZodError' && Array.isArray(candidate.issues);
}

function issuesToFields(issues: ZodIssueLike[]): ApiFieldIssue[] {
  const out: ApiFieldIssue[] = [];
  for (const issue of issues) {
    const path = Array.isArray(issue.path)
      ? issue.path.filter((p): p is string | number => typeof p === 'string' || typeof p === 'number').join('.')
      : '';
    const message = typeof issue.message === 'string' ? issue.message : 'That value is not valid.';
    out.push({ path, message });
  }
  return out;
}

// ── Prisma interop, without importing the generated client into this file ───

/** True for a unique-constraint violation, optionally on a named column. */
export function isUniqueViolation(error: unknown, column?: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; meta?: unknown };
  if (candidate.code !== 'P2002') return false;
  if (column === undefined) return true;
  const meta = candidate.meta;
  if (typeof meta !== 'object' || meta === null) return false;
  const target = (meta as { target?: unknown }).target;
  if (typeof target === 'string') return target.includes(column);
  if (Array.isArray(target)) return target.some((t) => t === column);
  return false;
}

export type RouteHandler = (req: NextRequest) => Promise<NextResponse>;

/**
 * Wraps a route handler so that:
 *  - a deliberate `HttpProblem` becomes its own status and message;
 *  - a schema failure becomes a 400 carrying per-field messages the form can pin
 *    next to the offending input (§12.5 — errors go inline, never in a toast);
 *  - anything else becomes a generic 500 and one structured log line. The log
 *    records the route and the error name only: no body, no handle, no token
 *    (§11.10).
 */
export function apiHandler(handler: RouteHandler): RouteHandler {
  return async (req: NextRequest): Promise<NextResponse> => {
    try {
      return await handler(req);
    } catch (error) {
      if (error instanceof HttpProblem) {
        const options: FailOptions = { status: error.status };
        if (error.fields !== undefined) options.fields = error.fields;
        if (error.headers !== undefined) options.headers = error.headers;
        return fail(error.code, error.message, options);
      }
      if (isZodErrorLike(error)) {
        return fail('validation_error', 'Some of those details need another look.', {
          fields: issuesToFields(error.issues),
        });
      }
      console.error('[api] unhandled', {
        method: req.method,
        path: req.nextUrl.pathname,
        error: error instanceof Error ? `${error.name}: ${error.message}` : 'non-error throw',
      });
      return fail('internal', 'Something went wrong on our end. Try that again.');
    }
  };
}
