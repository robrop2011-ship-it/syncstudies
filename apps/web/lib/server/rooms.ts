/**
 * Rooms: the shapes the REST layer returns, the predicates it decides with, and
 * the room-scoped rate-limit buckets (PLAN.md §3.2, §10.1, §11.3, §11.7).
 *
 * Everything above the "queries" heading is pure — no Prisma, no request, no
 * clock. That is deliberate: the two decisions in this feature that are easy to
 * get quietly wrong (what a room summary is allowed to contain, and who may be
 * admitted to a full room) are functions with inputs and outputs, so they are
 * covered by `app/api/rooms/__tests__/rooms.test.ts` without a database.
 *
 * ── Error codes the room routes answer with ─────────────────────────────────
 * `lib/server/respond.ts` owns a closed `ApiErrorCode` union for the generic
 * routes. The room routes need finer codes than that union carries, and they
 * need the SAME strings the socket layer already acks with
 * (`apps/realtime/src/handlers/room.ts`) so a client can handle "this room is
 * full" once rather than twice. `roomFail()` below emits the identical envelope
 * with a room-specific code — same shape, same helper style, one extra vocabulary.
 *
 *   404 not_found          no room with that code (also: a malformed code)
 *   403 banned             you are on this room's ban list
 *   403 forbidden          host-only route, and you are not the host
 *   409 room_full          live occupancy is at max_participants
 *   410 room_ended         status='ended'
 *   410 room_archived      status='archived'
 *   403 passcode_required  the room has a passcode and you sent none
 *   403 passcode_incorrect the passcode did not match
 */
import { NextResponse, type NextRequest } from 'next/server';
import {
  DEFAULT_MAX_PARTICIPANTS,
  normalizeRoomCode,
  Schemas,
  type Role,
} from '@syncstudy/shared';
import type { ApiEnvelope } from '@/lib/api';
import { apiHandler, fail } from '@/lib/server/respond';

/** Re-exported so a room route imports its whole vocabulary from one module. */
export type { Role };

// ── shapes ──────────────────────────────────────────────────────────────────

export type RoomStatus = 'active' | 'ended' | 'archived';

/**
 * One room, as the dashboard and the room list render it.
 *
 * `hostName` rather than a nested user: a room list is not a place to publish
 * profile fields, and a display name is all the UI shows. `id` is present here
 * because every consumer of a summary is already a member or the host — the
 * preview shape below, which anyone may fetch, is the one that must not carry it.
 */
export interface RoomSummary {
  id: string;
  code: string;
  name: string;
  topic: string | null;
  hostId: string;
  hostName: string;
  role: Role;
  status: RoomStatus;
  participantCount: number;
  maxParticipants: number;
  /** ISO 8601, like every other timestamp on the wire (see `toSelfView`). */
  lastActiveAt: string;
  createdAt: string;
  isHost: boolean;
}

/**
 * What anyone holding a room code may learn before signing up (§2.2).
 *
 * Note what is NOT here: the room id, the participant list, the host's handle.
 * A code is a bearer token for "may I see the door", not for "may I see inside".
 */
export interface RoomPreview {
  name: string;
  topic: string | null;
  hostName: string;
  participantCount: number;
  maxParticipants: number;
  requiresPasscode: boolean;
  isFull: boolean;
  isBanned: boolean;
  isMember: boolean;
  status: RoomStatus;
}

/** The columns `toRoomSummary` needs. Prisma's row satisfies this structurally. */
export interface RoomSummaryRow {
  id: string;
  code: string;
  name: string;
  topic: string | null;
  hostId: string;
  status: string;
  maxParticipants: number;
  lastActiveAt: Date;
  createdAt: Date;
  host: { displayName: string };
  /** Participants whose `leftAt` is null — see `countsAreApproximate` below. */
  _count: { participants: number };
}

/** The columns `toRoomPreview` needs. `id` and `passcodeHash` never leave it. */
export interface RoomPreviewRow {
  id: string;
  name: string;
  topic: string | null;
  hostId: string;
  status: string;
  maxParticipants: number;
  passcodeHash: string | null;
  host: { displayName: string };
  _count: { participants: number };
}

export interface PreviewViewer {
  isBanned: boolean;
  isMember: boolean;
}

// ── pure helpers ────────────────────────────────────────────────────────────

const ROLES: readonly Role[] = ['host', 'co_host', 'member', 'guest'];

/** A `role` column is a VarChar; anything unrecognised is treated as the floor. */
export function asRole(value: string): Role {
  return ROLES.find((role) => role === value) ?? 'guest';
}

export function asRoomStatus(value: string): RoomStatus {
  return value === 'ended' || value === 'archived' ? value : 'active';
}

/**
 * The viewer's role in a room.
 *
 * `rooms.host_id` outranks the participant row, exactly as the socket layer
 * resolves it (`resolveMembership` in apps/realtime). If a host transfer wrote
 * one row and not the other, the room still has precisely one host and it is the
 * one the FK names.
 *
 * No participant row means no role was ever granted, so the answer is `guest` —
 * the lowest rank — rather than an invented `member`.
 */
export function roomRoleFor(
  room: { hostId: string },
  viewerId: string,
  participantRole: string | null,
): Role {
  if (room.hostId === viewerId) return 'host';
  if (participantRole === null) return 'guest';
  return asRole(participantRole);
}

export function toRoomSummary(
  row: RoomSummaryRow,
  viewerId: string,
  participantRole: string | null,
): RoomSummary {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    topic: row.topic,
    hostId: row.hostId,
    hostName: row.host.displayName,
    role: roomRoleFor(row, viewerId, participantRole),
    status: asRoomStatus(row.status),
    participantCount: row._count.participants,
    maxParticipants: row.maxParticipants,
    lastActiveAt: row.lastActiveAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    isHost: row.hostId === viewerId,
  };
}

export function toRoomPreview(row: RoomPreviewRow, viewer: PreviewViewer): RoomPreview {
  return {
    name: row.name,
    topic: row.topic,
    hostName: row.host.displayName,
    participantCount: row._count.participants,
    maxParticipants: row.maxParticipants,
    // The hash never crosses the wire; only whether one exists.
    requiresPasscode: row.passcodeHash !== null,
    isFull: isRoomFull(row._count.participants, row.maxParticipants),
    isBanned: viewer.isBanned,
    isMember: viewer.isMember,
    status: asRoomStatus(row.status),
  };
}

export function isRoomFull(occupancy: number, maxParticipants: number): boolean {
  return occupancy >= maxParticipants;
}

export interface AdmissionInput {
  /** Non-left `room_participants` rows. See `countsAreApproximate`. */
  occupancy: number;
  maxParticipants: number;
  isHost: boolean;
  /** A `room_participants` row exists, `leftAt` set or not (§3.2 R8). */
  isExistingMember: boolean;
}

/**
 * May this user take a slot?
 *
 * The host and anyone who already has a participant row are exempt. §3.2 R8
 * makes rejoining a first-class operation: a dropped Wi-Fi connection must not
 * turn into "your own room is full", and a member who steps out for a minute
 * must be able to come back. They occupy a slot they were already counted in.
 */
export function canAdmit(input: AdmissionInput): boolean {
  if (input.isHost || input.isExistingMember) return true;
  return !isRoomFull(input.occupancy, input.maxParticipants);
}

/**
 * WHY THE COUNT IS AN APPROXIMATION — read before trusting `participantCount`.
 *
 * §11.3 requires `max_participants` to be enforced ATOMICALLY, and it is: the
 * socket layer does it in Redis (`addParticipantIfRoom` in
 * apps/realtime/src/rooms/RoomStore.ts), which is the only place that sees live
 * presence and the only check that actually protects the cap.
 *
 * This app has no Redis client — the realtime service owns that connection, and
 * adding a second one to Next.js for a display number is a dependency for
 * nothing. So the web tier counts `room_participants` rows with `left_at IS
 * NULL`, which is the durable membership record rather than who is connected
 * right now. It drifts in two directions:
 *
 *   - too high, for a member whose `left_at` was never written (a node died
 *     mid-session, so the row still reads as open);
 *   - too low, never — a connected participant always has an open row.
 *
 * The consequence, stated plainly: `POST /join` can admit someone the socket
 * then refuses with `room_full`, and `participantCount` can read high on a room
 * nobody is in. Both are acceptable, because the REST check is advisory (it
 * exists so the join page can say "this room is full" before a socket is opened)
 * and the socket check is authoritative.
 *
 * TO MAKE THIS EXACT: read `SCARD room:{id}:presence` from the same Redis the
 * realtime service uses, and fall back to this count when Redis is unreachable.
 */
export const countsAreApproximate = true;

/**
 * `''` and `'   '` are a cleared topic, not a topic. `undefined` stays
 * `undefined` so a PATCH that omits the field leaves the column alone —
 * `exactOptionalPropertyTypes` makes that distinction load-bearing.
 */
export function normalizeTopic(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function resolveMaxParticipants(requested: number | undefined): number {
  return requested ?? DEFAULT_MAX_PARTICIPANTS;
}

/** 4–32 characters (§3.2 R3). Longer input is refused, never silently truncated. */
export const MIN_PASSCODE_LENGTH = 4;
export const MAX_PASSCODE_LENGTH = 32;

/** Mirrors `readPassword` in /api/me: hand-read one optional string, no schema. */
export function readPasscode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as { passcode?: unknown }).passcode;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length < MIN_PASSCODE_LENGTH || trimmed.length > MAX_PASSCODE_LENGTH) return null;
  return trimmed;
}

export type RoomListScope = 'mine' | 'recent';

/** Anything that is not exactly `mine` is the default view. */
export function readScope(value: string | null): RoomListScope {
  return value === 'mine' ? 'mine' : 'recent';
}

/**
 * `/api/rooms/:id` and `/api/rooms/:code/*` share one dynamic segment, because
 * Next.js refuses two different slug names at the same path depth. The segment
 * is therefore called `[room]` and each route says what it accepts: the two
 * `:code` routes take a room code, and the `:id` routes take a uuid — or a code,
 * so the shared slug name is not a lie.
 */
export function parseRoomRef(segment: string): { id: string } | { code: string } | null {
  if (Schemas.Uuid.safeParse(segment).success) return { id: segment };
  const code = normalizeRoomCode(segment);
  return code === null ? null : { code };
}

// ── error responses ─────────────────────────────────────────────────────────

export type RoomErrorCode =
  | 'room_not_found'
  | 'forbidden'
  | 'banned'
  | 'room_full'
  | 'room_ended'
  | 'room_archived'
  | 'passcode_required'
  | 'passcode_incorrect';

/** The envelope from §10.1, with a room-specific code. See the file header. */
export function roomFail(code: RoomErrorCode, message: string, status: number): NextResponse {
  const body: ApiEnvelope<never> = { ok: false, error: { code, message } };
  return NextResponse.json(body, { status });
}

/**
 * One refusal for "no such room" and for "a code you may not resolve".
 * §11.3: the code space is the enumeration surface, so it must not leak hits.
 */
export function roomNotFound(): NextResponse {
  // Same string the socket layer acks with (`ackError('room_not_found', …)` in
  // apps/realtime/src/handlers/room.ts), so a client handles it once, not twice.
  return roomFail('room_not_found', 'No room with that code.', 404);
}

/** A room past its life is `410 Gone`, not `404` — it existed, and you had it. */
export function roomGone(status: RoomStatus): NextResponse | null {
  if (status === 'ended') {
    return roomFail('room_ended', 'This room has ended.', 410);
  }
  if (status === 'archived') {
    return roomFail(
      'room_archived',
      'This room is archived. Its notes and chat are readable, but it cannot be joined.',
      410,
    );
  }
  return null;
}

export function notTheHost(action: string): NextResponse {
  return roomFail('forbidden', `Only the host can ${action}.`, 403);
}

// ── dynamic-segment routes ──────────────────────────────────────────────────

export interface RoomRouteContext {
  /** Next.js 15: route params are async. */
  params: Promise<{ room: string }>;
}

export type RoomRouteHandler = (req: NextRequest, segment: string) => Promise<NextResponse>;

/**
 * `apiHandler` for a route with a dynamic segment.
 *
 * It exists only because `apiHandler`'s `RouteHandler` takes the request alone,
 * and awaiting `context.params` inside the wrapper keeps the failure handling
 * identical to every other route: one `HttpProblem` path, one zod path, one 500.
 */
export function roomRoute(
  handler: RoomRouteHandler,
): (req: NextRequest, context: RoomRouteContext) => Promise<NextResponse> {
  return async (req, context) =>
    apiHandler(async (request) => handler(request, (await context.params).room))(req);
}

// ── rate limiting ───────────────────────────────────────────────────────────
//
// These four buckets are not in `RATE_LIMITS` in lib/server/rate-limit.ts
// because that file belongs to another change in this phase and this one owns
// only `lib/server/rooms.ts`. The policy shape, the token maths, the fail-closed
// rule and the `limitOr429` signature are the same, so folding them into the
// shared table later is a move-and-delete, not a rewrite. Everything the shared
// limiter's header says about being in-process (N instances → N × the limit,
// buckets reset on deploy) is equally true here.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

interface RoomRatePolicy {
  limit: number;
  windowMs: number;
  /** true → refuse when the caller cannot be identified (§11.7). */
  failClosed: boolean;
  message: string;
}

export const ROOM_RATE_LIMITS = {
  'rooms:create:user': {
    limit: 20,
    windowMs: DAY,
    failClosed: true,
    message: 'You can create 20 rooms a day. Try again tomorrow.',
  },
  'rooms:join:user': {
    limit: 30,
    windowMs: MINUTE,
    failClosed: true,
    message: 'Too many join attempts. Wait a moment.',
  },
  // Both preview windows fail closed: an unidentifiable caller on the room-code
  // enumeration surface is exactly the caller these limits are for (§11.3).
  'rooms:preview:ip:minute': {
    limit: 20,
    windowMs: MINUTE,
    failClosed: true,
    message: 'Too many room codes tried. Wait a minute.',
  },
  'rooms:preview:ip:day': {
    limit: 200,
    windowMs: DAY,
    failClosed: true,
    message: 'Too many room codes tried from this connection today.',
  },
  // §3.2 R3: 5 attempts / 10 min / IP + code.
  'rooms:passcode:ip-code': {
    limit: 5,
    windowMs: 10 * MINUTE,
    failClosed: true,
    message: 'Too many passcode attempts for this room. Try again in ten minutes.',
  },
} as const satisfies Record<string, RoomRatePolicy>;

export type RoomRateScope = keyof typeof ROOM_RATE_LIMITS;

interface Bucket {
  tokens: number;
  updatedMs: number;
}

interface LimiterState {
  buckets: Map<string, Bucket>;
  lastSweepMs: number;
}

/** Survives the dev-server module reload, so limits are testable by hand. */
const globalForLimiter = globalThis as unknown as { __ssRoomRateLimiter?: LimiterState };

const state: LimiterState = (globalForLimiter.__ssRoomRateLimiter ??= {
  buckets: new Map(),
  lastSweepMs: Date.now(),
});

const SWEEP_INTERVAL_MS = 5 * MINUTE;
/** The longest window above; a bucket idle this long has refilled by definition. */
const MAX_WINDOW_MS = DAY;

function sweep(now: number): void {
  if (now - state.lastSweepMs < SWEEP_INTERVAL_MS) return;
  state.lastSweepMs = now;
  for (const [key, bucket] of state.buckets) {
    if (now - bucket.updatedMs > MAX_WINDOW_MS) state.buckets.delete(key);
  }
}

export interface RoomRateResult {
  allowed: boolean;
  retryAfterMs: number;
  policy: RoomRatePolicy;
}

export function consumeRoomLimit(scope: RoomRateScope, identifier: string | null): RoomRateResult {
  const policy: RoomRatePolicy = ROOM_RATE_LIMITS[scope];

  if (identifier === null || identifier.length === 0) {
    return {
      allowed: !policy.failClosed,
      retryAfterMs: policy.failClosed ? policy.windowMs : 0,
      policy,
    };
  }

  const now = Date.now();
  sweep(now);

  const key = `${scope}|${identifier}`;
  const refillPerMs = policy.limit / policy.windowMs;
  const bucket = state.buckets.get(key);

  if (bucket === undefined) {
    state.buckets.set(key, { tokens: policy.limit - 1, updatedMs: now });
    return { allowed: true, retryAfterMs: 0, policy };
  }

  const refilled = Math.min(policy.limit, bucket.tokens + (now - bucket.updatedMs) * refillPerMs);
  bucket.updatedMs = now;

  if (refilled < 1) {
    bucket.tokens = refilled;
    return { allowed: false, retryAfterMs: Math.ceil((1 - refilled) / refillPerMs), policy };
  }

  bucket.tokens = refilled - 1;
  return { allowed: true, retryAfterMs: 0, policy };
}

/** Null when the request may proceed, or a ready-made 429 when it may not. */
export function roomLimitOr429(
  scope: RoomRateScope,
  identifier: string | null,
): NextResponse | null {
  const result = consumeRoomLimit(scope, identifier);
  if (result.allowed) return null;

  const retryAfterSec = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
  return fail('rate_limited', result.policy.message, {
    headers: { 'retry-after': String(retryAfterSec) },
  });
}

// ── queries ─────────────────────────────────────────────────────────────────

/** Cap on any room list (§10.1). Pagination is not a Phase 3 problem. */
export const ROOM_LIST_LIMIT = 50;

/**
 * Retries for a room-code collision. At 30^8 ≈ 6.6e11 codes, five failures in a
 * row is not bad luck — it is a broken RNG or a broken index, and the honest
 * answer to that is a 500 rather than a sixth attempt.
 */
export const ROOM_CODE_ATTEMPTS = 5;

export const ROOM_SUMMARY_SELECT = {
  id: true,
  code: true,
  name: true,
  topic: true,
  hostId: true,
  status: true,
  maxParticipants: true,
  lastActiveAt: true,
  createdAt: true,
  host: { select: { displayName: true } },
  _count: { select: { participants: { where: { leftAt: null } } } },
} as const;

export const ROOM_PREVIEW_SELECT = {
  id: true,
  name: true,
  topic: true,
  hostId: true,
  status: true,
  maxParticipants: true,
  passcodeHash: true,
  host: { select: { displayName: true } },
  _count: { select: { participants: { where: { leftAt: null } } } },
} as const;
