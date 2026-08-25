/**
 * Chat, as one object (PLAN.md §3.5, §6.5, §14 Phase 5).
 *
 * Everything that puts a line in a room's transcript goes through here — the
 * `chat:send` handler, and the system lines that presence, host and video
 * changes produce. One path means one ordering, one dedupe rule and one place
 * where "broadcast first, persist behind it" is actually true.
 *
 * The order inside `deliver()` is the whole design:
 *
 *   1. assign a server id (uuidv7) and a server timestamp — never the client's;
 *   2. emit to the room;
 *   3. queue the INSERT and return.
 *
 * Step 3 never blocks step 2. §6.5 gives the broadcast a 10 ms budget and the
 * write 2 s, and a database that is having a bad afternoon must cost the room a
 * lagging transcript, not a frozen chat box.
 */
import { uuidv7, type MessageView } from '@syncstudy/shared';
import { createHash } from 'node:crypto';
import type { Logger } from '../logger.js';
import type { ScriptedRedis } from '../redis.js';
import { keys } from '../redis.js';
import { chatMessagesTotal } from '../metrics.js';
import { insertMessages, type PendingMessage } from './messages.js';
import { WriteBehind } from './writeBehind.js';
import { roomChannel, type TypedServer } from '../handlers/context.js';

/** §6.5's "DB within 2 s", with room to spare. */
const FLUSH_MS = 250;
const MAX_BATCH = 50;
/**
 * ~10k messages is minutes of a very busy room. Past this, Postgres has been
 * gone long enough that the honest failure is a loud one — see writeBehind.ts.
 */
const MAX_QUEUE = 10_000;
const MAX_ATTEMPTS = 5;

/** How long a `clientMsgId` is remembered, i.e. how late a retry may be. */
const DEDUPE_TTL_MS = 120_000;
/**
 * §11.6: the same body three times inside 30 s is dropped, and the sender — and
 * only the sender — is told. Two is a person being emphatic; three is a person
 * holding a key down or a script.
 *
 * The window runs from the FIRST occurrence, not the last: "ok" once every 25
 * seconds for an hour must never trip this, and a sliding window would.
 */
const DUPLICATE_WINDOW_MS = 30_000;
const DUPLICATE_MAX = 3;
/** Covers the largest `slowModeSec` the policy schema allows (300). */
const LAST_SENT_TTL_MS = 305_000;

/**
 * A system line is suppressed if the same subject produced one this recently.
 *
 * This is the flaky-connection guard: someone whose Wi-Fi drops every twenty
 * seconds would otherwise write "Sam left" / "Sam joined" down the transcript
 * until nobody can find a real message in it. Keyed by subject, so Sam
 * reconnecting is silent while Priya arriving still says so.
 */
const SYSTEM_DEDUPE_MS = 120_000;
/** And a per-room ceiling, for the case where the subjects are all different. */
const SYSTEM_ROOM_LIMIT = 8;
const SYSTEM_ROOM_WINDOW_MS = 60_000;

export type ChatSendFailure =
  | { code: 'slow_mode'; message: string }
  | { code: 'duplicate'; message: string }
  | { code: 'chat_locked'; message: string };

export interface ChatSendInput {
  roomId: string;
  author: { id: string; handle: string; displayName: string; avatarUrl: string | null };
  clientMsgId: string;
  body: string;
  replyToId: string | null;
  videoTs: number | null;
  /** Slow mode does not apply to the people who can turn it on. */
  bypassSlowMode: boolean;
  slowModeSec: number;
}

function bodyHash(body: string): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

export class ChatService {
  private readonly io: TypedServer;
  private readonly redis: ScriptedRedis;
  private readonly log: Logger;
  private readonly queue: WriteBehind<PendingMessage>;
  /** roomId → subject key → last emission (ms). Node-local; see `system()`. */
  private readonly systemSeen = new Map<string, Map<string, number>>();
  /** roomId → emission times inside the current window. */
  private readonly systemWindow = new Map<string, number[]>();

  constructor(deps: { io: TypedServer; redis: ScriptedRedis; log: Logger }) {
    this.io = deps.io;
    this.redis = deps.redis;
    this.log = deps.log;
    this.queue = new WriteBehind<PendingMessage>({
      name: 'messages',
      flushMs: FLUSH_MS,
      maxBatch: MAX_BATCH,
      maxQueue: MAX_QUEUE,
      maxAttempts: MAX_ATTEMPTS,
      write: insertMessages,
      log: deps.log,
    });
  }

  /** Unwritten rows, for `/health` and the shutdown log. */
  get pendingWrites(): number {
    return this.queue.depth;
  }

  /**
   * Send a user message.
   *
   * Returns the broadcast view, or a failure the caller acks verbatim. A
   * duplicate `clientMsgId` is NOT a failure: it returns the message the first
   * attempt produced, so a client that retried after a reconnect converges on
   * the room's copy instead of adding a second one.
   */
  async send(input: ChatSendInput): Promise<MessageView | ChatSendFailure> {
    const dedupeKey = keys.chatDedupe(input.roomId, input.author.id, input.clientMsgId);
    const lastKey = keys.chatLast(input.roomId, input.author.id);
    // One round-trip for both: this is the hot path, and MGET is exactly as
    // atomic as two GETs would have been.
    const [prior = null, last = null] = await this.redis
      .mget(dedupeKey, lastKey)
      .catch(() => [null, null]);

    if (prior !== null) {
      const replayed = this.parseView(prior);
      if (replayed !== null) return replayed;
    }

    const now = Date.now();
    if (last !== null && !input.bypassSlowMode && input.slowModeSec > 0) {
      const elapsed = now - Number(last);
      if (elapsed < input.slowModeSec * 1000) {
        const wait = Math.ceil((input.slowModeSec * 1000 - elapsed) / 1000);
        return { code: 'slow_mode', message: `Slow mode is on — wait ${wait}s.` };
      }
    }

    // INCR is the counter and the check in one atomic step, and `PEXPIRE … NX`
    // anchors the window to the first occurrence — set unconditionally, a repeat
    // would keep pushing the expiry out and the window would never close.
    const repeats = await this.countRepeat(input.roomId, input.author.id, input.body);
    if (repeats >= DUPLICATE_MAX) {
      return { code: 'duplicate', message: 'You have already said that.' };
    }

    const message: MessageView = {
      id: uuidv7(now),
      roomId: input.roomId,
      author: input.author,
      clientMsgId: input.clientMsgId,
      body: input.body,
      kind: 'user',
      replyToId: input.replyToId,
      videoTs: input.videoTs,
      createdAt: now,
      deletedAt: null,
    };

    // Claim the id atomically. Losing the race means a retry arrived at the same
    // moment on another node — take theirs, discard ours, broadcast nothing.
    // Fail open on a Redis error: a possible duplicate line beats a chat that
    // stops working because the dedupe cache is unreachable (§11.7's rule for
    // chat, applied to the same trade-off).
    const claimed = await this.redis
      .set(dedupeKey, JSON.stringify(message), 'PX', DEDUPE_TTL_MS, 'NX')
      .catch(() => 'OK' as const);
    if (claimed !== 'OK') {
      const winner = await this.redis.get(dedupeKey).catch(() => null);
      const view = winner === null ? null : this.parseView(winner);
      if (view !== null) return view;
    }

    await this.redis.set(lastKey, String(now), 'PX', LAST_SENT_TTL_MS).catch(() => undefined);

    this.deliver(message, input.author.id);
    return message;
  }

  /**
   * A centred, low-contrast line in the transcript: "Sam joined",
   * "Priya is now the host", "Paused — waiting for Sam".
   *
   * Returns null when it was throttled, which callers can ignore — a system line
   * is never the point of the operation that produced it.
   *
   * The throttle state is node-local. A user flapping between two nodes could
   * therefore produce two lines instead of one; that is the rare case, and the
   * alternative is a Redis round-trip on every join to suppress a cosmetic line.
   */
  system(roomId: string, subject: string, body: string): MessageView | null {
    const now = Date.now();

    const seen = this.systemSeen.get(roomId) ?? new Map<string, number>();
    const previous = seen.get(subject);
    if (previous !== undefined && now - previous < SYSTEM_DEDUPE_MS) return null;

    // Prune while we are here. Without this the map keeps one entry per user who
    // has ever joined, for the life of the process — a slow leak in the one
    // structure nobody would think to look at.
    for (const [key, at] of seen) {
      if (now - at >= SYSTEM_DEDUPE_MS) seen.delete(key);
    }

    const window = (this.systemWindow.get(roomId) ?? []).filter(
      (t) => now - t < SYSTEM_ROOM_WINDOW_MS,
    );
    if (window.length >= SYSTEM_ROOM_LIMIT) {
      this.systemWindow.set(roomId, window);
      return null;
    }

    seen.set(subject, now);
    this.systemSeen.set(roomId, seen);
    window.push(now);
    this.systemWindow.set(roomId, window);

    const message: MessageView = {
      id: uuidv7(now),
      roomId,
      author: null,
      clientMsgId: null,
      body,
      kind: 'system',
      replyToId: null,
      videoTs: null,
      createdAt: now,
      deletedAt: null,
    };
    this.deliver(message, null);
    return message;
  }

  /** The room is gone; its throttle bookkeeping should go with it. */
  forgetRoom(roomId: string): void {
    this.systemSeen.delete(roomId);
    this.systemWindow.delete(roomId);
  }

  /**
   * Wait — briefly — for this node's queued messages to reach Postgres.
   *
   * Called before a join reads history, so the joiner's snapshot includes the
   * message this node broadcast a moment ago. Bounded, because a joiner must
   * never be held behind a database that has stopped answering.
   */
  async settle(timeoutMs = 300): Promise<void> {
    await this.queue.drain(timeoutMs).catch(() => undefined);
  }

  /** Shutdown: finish every outstanding write. No timeout — that is the point. */
  async stop(): Promise<void> {
    const depth = this.queue.depth;
    if (depth > 0) this.log.info({ pending: depth }, 'flushing queued chat writes');
    await this.queue.stop();
  }

  private deliver(message: MessageView, authorId: string | null): void {
    // Everyone, sender included. The sender's optimistic copy is reconciled
    // against this one by `clientMsgId`, so every client in the room renders the
    // same object from the same source rather than two near-identical ones.
    this.io.to(roomChannel(message.roomId)).emit('chat:message', { message });
    chatMessagesTotal.inc({ kind: message.kind });
    this.queue.push({
      id: message.id,
      roomId: message.roomId,
      userId: authorId,
      clientMsgId: message.clientMsgId,
      body: message.body,
      kind: message.kind,
      replyToId: message.replyToId,
      videoTs: message.videoTs,
      createdAt: new Date(message.createdAt),
    });
  }

  /**
   * How many times this exact body has been sent by this user in this room
   * inside the current window, counting this attempt.
   *
   * Fails open at 0: repeat suppression is a politeness feature, and losing
   * Redis must not also lose chat (§11.7's rule for chat traffic).
   */
  private async countRepeat(roomId: string, userId: string, body: string): Promise<number> {
    const key = keys.chatRepeat(roomId, userId, bodyHash(body));
    try {
      const replies = await this.redis
        .pipeline()
        .incr(key)
        .pexpire(key, DUPLICATE_WINDOW_MS, 'NX')
        .exec();
      const count = replies?.[0]?.[1];
      return typeof count === 'number' ? count : 0;
    } catch {
      return 0;
    }
  }

  /** A malformed cache entry must not take a send down; treat it as a miss. */
  private parseView(raw: string): MessageView | null {
    try {
      return JSON.parse(raw) as MessageView;
    } catch {
      this.log.warn('discarding malformed chat dedupe entry');
      return null;
    }
  }
}
