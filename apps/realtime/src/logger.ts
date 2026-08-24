/**
 * Structured logging (PLAN.md §11.10, §16.5).
 *
 * The hard rule: every line carries ids, never content. `userId` yes, `handle`
 * and `displayName` no. Message bodies, SDP, passwords, recovery codes and
 * session tokens never reach a log line — a log shipper is a third party and a
 * breach of it must not be a breach of the room.
 *
 * The redaction list below is a safety net for accidental object spreads, not a
 * licence to pass those fields in.
 */
import { pino, type Logger } from 'pino';

/** Field names that must never appear in a log line, whatever the call site does. */
export const REDACTED_PATHS = [
  'handle',
  'displayName',
  'body',
  'text',
  'content',
  'sdp',
  'candidate',
  'password',
  'newPassword',
  'currentPassword',
  'recoveryCode',
  'token',
  'cookie',
  'authorization',
  'ip',
  'req.headers.cookie',
  'req.headers.authorization',
  '*.handle',
  '*.displayName',
  '*.body',
  '*.sdp',
];

export interface LoggerOptions {
  level: string;
  nodeId: string;
  pretty: boolean;
}

export function createLogger(opts: LoggerOptions): Logger {
  return pino({
    level: opts.level,
    base: { service: 'realtime', node: opts.nodeId },
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Pretty printing is a dev convenience only; production ships raw JSON to
    // the log shipper, which is what Axiom/Better Stack want.
    ...(opts.pretty
      ? { transport: { target: 'pino/file', options: { destination: 1 } } }
      : {}),
  });
}

/**
 * The shape every socket log line should carry (§16.5: "{roomId, userId,
 * socketId, event}"). Building it through a helper keeps call sites from
 * inventing their own field names.
 */
export interface SocketLogContext {
  socketId: string;
  userId?: string;
  roomId?: string;
  event?: string;
}

export function socketContext(ctx: SocketLogContext): Record<string, string> {
  const out: Record<string, string> = { socketId: ctx.socketId };
  if (ctx.userId !== undefined) out['userId'] = ctx.userId;
  if (ctx.roomId !== undefined) out['roomId'] = ctx.roomId;
  if (ctx.event !== undefined) out['event'] = ctx.event;
  return out;
}

export type { Logger };
