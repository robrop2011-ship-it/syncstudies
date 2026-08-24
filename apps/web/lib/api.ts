/**
 * The browser side of the REST envelope (PLAN.md §10.1).
 *
 * Every route handler answers with `{ ok: true, data }` or
 * `{ ok: false, error: { code, message, details? } }`. This module is the only
 * place that knows that shape on the client: components call `api.post(...)`,
 * get the unwrapped `data` back, and catch an `ApiError` when the server said no.
 *
 * Deliberately dependency-free — it is imported by client components, so it must
 * not pull in zod, Prisma, or anything from `@syncstudy/auth` (that package
 * reaches for argon2 and the database and would poison the client bundle).
 */

export interface ApiFieldIssue {
  /** Dotted path of the offending field, e.g. `handle`. */
  path: string;
  message: string;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: { fields?: ApiFieldIssue[] };
}

export type ApiEnvelope<T> = { ok: true; data: T } | { ok: false; error: ApiErrorBody };

/** Thrown by every helper below when the server returns `ok: false`. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  /** Field path → message, ready to hand to react-hook-form's `setError`. */
  readonly fields: Readonly<Record<string, string>>;

  constructor(code: string, message: string, status: number, fields: Record<string, string> = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.fields = fields;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readEnvelope(payload: unknown): ApiEnvelope<unknown> | null {
  if (!isRecord(payload) || typeof payload.ok !== 'boolean') return null;
  if (payload.ok) return { ok: true, data: payload.data };
  const error = payload.error;
  if (!isRecord(error) || typeof error.code !== 'string' || typeof error.message !== 'string') {
    return null;
  }
  const body: ApiErrorBody = { code: error.code, message: error.message };
  const details = error.details;
  if (isRecord(details) && Array.isArray(details.fields)) {
    const fields: ApiFieldIssue[] = [];
    for (const raw of details.fields) {
      if (isRecord(raw) && typeof raw.path === 'string' && typeof raw.message === 'string') {
        fields.push({ path: raw.path, message: raw.message });
      }
    }
    if (fields.length > 0) body.details = { fields };
  }
  return { ok: false, error: body };
}

function fieldMap(error: ApiErrorBody): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.details?.fields ?? []) {
    if (out[issue.path] === undefined) out[issue.path] = issue.message;
  }
  return out;
}

const GENERIC_FAILURE = 'Something went wrong. Try that again.';

async function send(method: string, path: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const init: RequestInit = { method, credentials: 'same-origin' };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  init.headers = headers;

  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError('network', "Couldn't reach SyncStudy. Check your connection.", 0);
  }

  if (res.status === 204) return null;

  const text = await res.text();
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  const envelope = readEnvelope(payload);
  if (envelope === null) {
    throw new ApiError(res.ok ? 'malformed_response' : 'internal', GENERIC_FAILURE, res.status);
  }
  if (envelope.ok) return envelope.data;
  throw new ApiError(envelope.error.code, envelope.error.message, res.status, fieldMap(envelope.error));
}

/**
 * The single `unknown` → `T` cast in the app. Route handlers and clients share
 * their payload types through `@syncstudy/shared`, so this boundary is the one
 * place where a runtime shape is taken on trust.
 */
async function typed<T>(method: string, path: string, body?: unknown): Promise<T> {
  return (await send(method, path, body)) as T;
}

export const api = {
  get: <T>(path: string): Promise<T> => typed<T>('GET', path),
  post: <T>(path: string, body?: unknown): Promise<T> => typed<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown): Promise<T> => typed<T>('PATCH', path, body),
  del: <T>(path: string, body?: unknown): Promise<T> => typed<T>('DELETE', path, body),
  /** For 204 routes, where there is nothing to unwrap. */
  send: async (method: string, path: string, body?: unknown): Promise<void> => {
    await send(method, path, body);
  },
};

/** Human-readable message for anything that lands in a `catch`. */
export function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message.length > 0 && error.message.length < 200) {
    return error.message;
  }
  return GENERIC_FAILURE;
}

/** Field-level messages for anything that lands in a `catch`. */
export function fieldsOf(error: unknown): Readonly<Record<string, string>> {
  return error instanceof ApiError ? error.fields : {};
}

/**
 * Guard for `?next=` round-trips. Only same-site absolute paths are honoured —
 * `//evil.example` and `https://evil.example` are open redirects, not destinations.
 */
export function safeNextPath(value: string | null | undefined, fallback = '/dashboard'): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback;
  return value;
}
