/**
 * Environment parsing (PLAN.md §11.10 — secrets come from the platform's secret
 * store, never the repo).
 *
 * Fail fast and loudly. A realtime node that boots with a missing REDIS_URL and
 * only discovers it on the first room join has already taken the outage; the
 * process should refuse to start instead, so the deploy fails and the old
 * machines keep serving.
 */
import { hostname } from 'node:os';
import { z } from 'zod';

const csv = (v: string): string[] =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const Csv = z.string().transform(csv);

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** Postgres. Durable truth for snapshots, membership and bans. */
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (postgres connection string)'),
  /** Redis. Live truth for the video anchor, presence and rate limits. */
  REDIS_URL: z.string().min(1, 'REDIS_URL is required (redis:// or rediss:// url)'),

  /**
   * Exact origins allowed to open a socket. Socket.IO does not enforce
   * same-origin on its own (§11.4), so this list is the only thing standing
   * between a room and any page on the internet.
   */
  ALLOWED_ORIGINS: Csv.refine((v) => v.length > 0, 'ALLOWED_ORIGINS must list at least one origin'),

  /** Salt for sha256(ip). We never store or log a raw address (§11.9). */
  IP_HASH_SALT: z.string().min(16, 'IP_HASH_SALT must be at least 16 characters'),

  /** coturn `static-auth-secret`. Absent in dev — calling then falls back to STUN only. */
  TURN_SECRET: z.string().min(1).optional(),
  TURN_URLS: Csv.optional(),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /** Identifies this process in leader leases and `sock:{id}` rows. */
  NODE_ID: z.string().min(1).default(`${hostname()}-${process.pid}`),
});

export type Config = z.infer<typeof EnvSchema> & { isProduction: boolean };

/**
 * Turn a ZodError into something a human reading deploy logs at 2am can act on.
 * Exported so the config test can assert on the message without a process exit.
 */
export function formatEnvError(error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const name = issue.path.join('.') || '(root)';
    return `  ${name}: ${issue.message}`;
  });
  return `Invalid environment for @syncstudy/realtime:\n${lines.join('\n')}\n\nSee apps/realtime/.env.example for the full list.`;
}

export interface ParseResult {
  ok: boolean;
  config?: Config;
  error?: string;
}

/** Pure parse — no throwing, no exiting. The boot path wraps this. */
export function parseConfig(env: NodeJS.ProcessEnv): ParseResult {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) return { ok: false, error: formatEnvError(parsed.error) };
  return { ok: true, config: { ...parsed.data, isProduction: parsed.data.NODE_ENV === 'production' } };
}

/** Boot-time accessor. Throws with a readable message rather than a stack of `undefined`. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = parseConfig(env);
  if (!result.ok || !result.config) throw new Error(result.error ?? 'Invalid environment');
  return result.config;
}
