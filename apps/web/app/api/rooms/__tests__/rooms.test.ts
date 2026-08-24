/**
 * Unit tests for the pure helpers behind the rooms REST API (PLAN.md §15.1).
 *
 * No database, no request, no Prisma. Everything under test is a function with
 * inputs and outputs, which is why these helpers were pulled out of the route
 * handlers in the first place — the two things worth guarding here are what a
 * preview is allowed to contain and who may be admitted to a full room, and
 * neither should need a running Postgres to check.
 */
import { describe, expect, it } from 'vitest';

import {
  asRole,
  asRoomStatus,
  canAdmit,
  consumeRoomLimit,
  isRoomFull,
  normalizeTopic,
  parseRoomRef,
  readPasscode,
  readScope,
  resolveMaxParticipants,
  roomRoleFor,
  toRoomPreview,
  toRoomSummary,
  type RoomPreviewRow,
  type RoomSummaryRow,
} from '@/lib/server/rooms';

const HOST_ID = '018f3b7a-0000-7000-8000-000000000001';
const MEMBER_ID = '018f3b7a-0000-7000-8000-000000000002';
const ROOM_ID = '018f3b7a-0000-7000-8000-00000000000a';

const CREATED_AT = new Date('2026-08-01T09:00:00.000Z');
const LAST_ACTIVE_AT = new Date('2026-08-20T17:30:00.000Z');

function summaryRow(overrides: Partial<RoomSummaryRow> = {}): RoomSummaryRow {
  return {
    id: ROOM_ID,
    code: 'K3M7QP2X',
    name: 'Organic chemistry, chapter 4',
    topic: 'Stereochemistry',
    hostId: HOST_ID,
    status: 'active',
    maxParticipants: 8,
    lastActiveAt: LAST_ACTIVE_AT,
    createdAt: CREATED_AT,
    host: { displayName: 'Priya' },
    _count: { participants: 3 },
    ...overrides,
  };
}

function previewRow(overrides: Partial<RoomPreviewRow> = {}): RoomPreviewRow {
  return {
    id: ROOM_ID,
    name: 'Organic chemistry, chapter 4',
    topic: 'Stereochemistry',
    hostId: HOST_ID,
    status: 'active',
    maxParticipants: 8,
    passcodeHash: null,
    host: { displayName: 'Priya' },
    _count: { participants: 3 },
    ...overrides,
  };
}

describe('toRoomSummary', () => {
  it('maps every field the room list renders', () => {
    const summary = toRoomSummary(summaryRow(), MEMBER_ID, 'member');

    expect(summary).toEqual({
      id: ROOM_ID,
      code: 'K3M7QP2X',
      name: 'Organic chemistry, chapter 4',
      topic: 'Stereochemistry',
      hostId: HOST_ID,
      hostName: 'Priya',
      role: 'member',
      status: 'active',
      participantCount: 3,
      maxParticipants: 8,
      lastActiveAt: '2026-08-20T17:30:00.000Z',
      createdAt: '2026-08-01T09:00:00.000Z',
      isHost: false,
    });
  });

  it('serialises timestamps as ISO strings, never Date objects', () => {
    const summary = toRoomSummary(summaryRow(), HOST_ID, 'host');
    expect(typeof summary.createdAt).toBe('string');
    expect(typeof summary.lastActiveAt).toBe('string');
  });

  it('sets isHost from the host FK, not from the participant role', () => {
    // A row that claims 'host' for someone who is not the host FK must not
    // produce isHost — that flag is what the UI grows host controls from.
    const summary = toRoomSummary(summaryRow(), MEMBER_ID, 'host');
    expect(summary.isHost).toBe(false);
    expect(summary.role).toBe('host');

    expect(toRoomSummary(summaryRow(), HOST_ID, null).isHost).toBe(true);
  });

  it('carries a null topic through unchanged', () => {
    expect(toRoomSummary(summaryRow({ topic: null }), HOST_ID, 'host').topic).toBe(null);
  });
});

describe('roomRoleFor', () => {
  it('lets the host FK outrank a stale participant row', () => {
    expect(roomRoleFor({ hostId: HOST_ID }, HOST_ID, 'member')).toBe('host');
  });

  it('falls back to guest when no participant row exists', () => {
    expect(roomRoleFor({ hostId: HOST_ID }, MEMBER_ID, null)).toBe('guest');
  });

  it('reads a co-host row as co_host', () => {
    expect(roomRoleFor({ hostId: HOST_ID }, MEMBER_ID, 'co_host')).toBe('co_host');
  });

  it('treats an unrecognised role string as the lowest rank', () => {
    expect(roomRoleFor({ hostId: HOST_ID }, MEMBER_ID, 'moderator')).toBe('guest');
    expect(asRole('nonsense')).toBe('guest');
    expect(asRole('co_host')).toBe('co_host');
  });
});

describe('toRoomPreview', () => {
  it('never leaks the room id, the host id or the passcode hash', () => {
    const preview = toRoomPreview(
      previewRow({ passcodeHash: '$argon2id$v=19$m=19456,t=2,p=1$abc$def' }),
      { isBanned: false, isMember: false },
    );

    const serialised = JSON.stringify(preview);
    expect(serialised.includes(ROOM_ID)).toBe(false);
    expect(serialised.includes(HOST_ID)).toBe(false);
    expect(serialised.includes('argon2')).toBe(false);

    expect(Object.keys(preview).sort()).toEqual([
      'hostName',
      'isBanned',
      'isFull',
      'isMember',
      'maxParticipants',
      'name',
      'participantCount',
      'requiresPasscode',
      'status',
      'topic',
    ]);
  });

  it('reports whether a passcode exists without revealing it', () => {
    const viewer = { isBanned: false, isMember: false };
    expect(toRoomPreview(previewRow(), viewer).requiresPasscode).toBe(false);
    expect(toRoomPreview(previewRow({ passcodeHash: 'hash' }), viewer).requiresPasscode).toBe(true);
    // The hash itself must never cross the wire.
    expect(JSON.stringify(toRoomPreview(previewRow({ passcodeHash: 'hash' }), viewer))).not.toContain(
      'hash',
    );
  });

  it('derives isFull from the occupancy and the cap', () => {
    const full = toRoomPreview(previewRow({ _count: { participants: 8 }, maxParticipants: 8 }), {
      isBanned: false,
      isMember: false,
    });
    expect(full.isFull).toBe(true);
    expect(full.participantCount).toBe(8);
  });

  it('passes the viewer flags through as given', () => {
    const preview = toRoomPreview(previewRow(), { isBanned: true, isMember: true });
    expect(preview.isBanned).toBe(true);
    expect(preview.isMember).toBe(true);
  });

  it('normalises an unknown status rather than echoing it', () => {
    const preview = toRoomPreview(previewRow({ status: 'wat' }), {
      isBanned: false,
      isMember: false,
    });
    expect(preview.status).toBe('active');
  });
});

describe('isRoomFull', () => {
  it('is true at the cap and above it', () => {
    expect(isRoomFull(7, 8)).toBe(false);
    expect(isRoomFull(8, 8)).toBe(true);
    // Over the cap can happen: the socket admits, then max_participants is
    // lowered. That is still full, not "room for one more".
    expect(isRoomFull(9, 8)).toBe(true);
  });
});

describe('canAdmit', () => {
  const base = { occupancy: 8, maxParticipants: 8, isHost: false, isExistingMember: false };

  it('refuses a newcomer once the room is at capacity', () => {
    expect(canAdmit(base)).toBe(false);
  });

  it('admits a newcomer while there is a free slot', () => {
    expect(canAdmit({ ...base, occupancy: 7 })).toBe(true);
  });

  it('always admits the host, even to a full room', () => {
    // §3.2 R8: the host must never be locked out of their own room by a count
    // that is an approximation of live presence in the first place.
    expect(canAdmit({ ...base, isHost: true })).toBe(true);
    expect(canAdmit({ ...base, occupancy: 99, isHost: true })).toBe(true);
  });

  it('always admits an existing member, so rejoining works', () => {
    expect(canAdmit({ ...base, isExistingMember: true })).toBe(true);
  });

  it('refuses a newcomer to a room whose cap was lowered below occupancy', () => {
    expect(canAdmit({ ...base, occupancy: 9, maxParticipants: 4 })).toBe(false);
  });
});

describe('normalizeTopic', () => {
  it('keeps undefined as undefined, so a PATCH that omits it leaves the column', () => {
    expect(normalizeTopic(undefined)).toBe(undefined);
  });

  it('treats null and whitespace alike as a cleared topic', () => {
    expect(normalizeTopic(null)).toBe(null);
    expect(normalizeTopic('')).toBe(null);
    expect(normalizeTopic('   ')).toBe(null);
  });

  it('trims a real topic', () => {
    expect(normalizeTopic('  Stereochemistry \n')).toBe('Stereochemistry');
  });
});

describe('resolveMaxParticipants', () => {
  it('defaults to DEFAULT_MAX_PARTICIPANTS', () => {
    expect(resolveMaxParticipants(undefined)).toBe(8);
  });

  it('honours an explicit value', () => {
    expect(resolveMaxParticipants(12)).toBe(12);
  });
});

describe('readPasscode', () => {
  it('reads a passcode out of a JSON body', () => {
    expect(readPasscode({ passcode: ' hunter22 ' })).toBe('hunter22');
  });

  it('returns null for a missing, empty or non-string passcode', () => {
    expect(readPasscode({})).toBe(null);
    expect(readPasscode(null)).toBe(null);
    expect(readPasscode('hunter22')).toBe(null);
    expect(readPasscode({ passcode: 1234 })).toBe(null);
    expect(readPasscode({ passcode: '   ' })).toBe(null);
  });

  it('refuses an out-of-range passcode rather than truncating it (§3.2 R3)', () => {
    expect(readPasscode({ passcode: 'abc' })).toBe(null);
    expect(readPasscode({ passcode: 'a'.repeat(33) })).toBe(null);
    expect(readPasscode({ passcode: 'a'.repeat(32) })).toBe('a'.repeat(32));
  });
});

describe('readScope', () => {
  it('defaults to recent', () => {
    expect(readScope(null)).toBe('recent');
    expect(readScope('')).toBe('recent');
    expect(readScope('everything')).toBe('recent');
  });

  it('reads mine', () => {
    expect(readScope('mine')).toBe('mine');
  });
});

describe('parseRoomRef', () => {
  it('recognises a uuid as an id', () => {
    expect(parseRoomRef(ROOM_ID)).toEqual({ id: ROOM_ID });
  });

  it('normalises a typed room code', () => {
    expect(parseRoomRef('k3m7-qp2x')).toEqual({ code: 'K3M7QP2X' });
    expect(parseRoomRef(' K3M7 QP2X ')).toEqual({ code: 'K3M7QP2X' });
  });

  it('rejects anything that is neither', () => {
    // The alphabet has no O, I, L, U or 0/1 — a code containing one is not a
    // near miss to be repaired, it is not a code.
    expect(parseRoomRef('K3M7QP2O')).toBe(null);
    expect(parseRoomRef('short')).toBe(null);
    expect(parseRoomRef('')).toBe(null);
    expect(parseRoomRef('../../etc/passwd')).toBe(null);
  });
});

describe('asRoomStatus', () => {
  it('recognises the three statuses and defaults the rest to active', () => {
    expect(asRoomStatus('ended')).toBe('ended');
    expect(asRoomStatus('archived')).toBe('archived');
    expect(asRoomStatus('active')).toBe('active');
    expect(asRoomStatus('paused-for-lunch')).toBe('active');
  });
});

describe('consumeRoomLimit', () => {
  it('spends the bucket and then refuses', () => {
    // 5 attempts / 10 min for a passcode (§3.2 R3), keyed on IP + code.
    const identifier = 'test-bucket-drain';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(consumeRoomLimit('rooms:passcode:ip-code', identifier).allowed).toBe(true);
    }
    const refused = consumeRoomLimit('rooms:passcode:ip-code', identifier);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs > 0);
  });

  it('keys buckets separately, so one room does not spend another room allowance', () => {
    const a = 'test-bucket-a';
    const b = 'test-bucket-b';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      consumeRoomLimit('rooms:passcode:ip-code', a);
    }
    expect(consumeRoomLimit('rooms:passcode:ip-code', a).allowed).toBe(false);
    expect(consumeRoomLimit('rooms:passcode:ip-code', b).allowed).toBe(true);
  });

  it('fails closed when the caller cannot be identified', () => {
    // No forwarded IP in production means an unmetered enumeration surface,
    // which is the one thing these two windows exist to prevent (§11.7).
    expect(consumeRoomLimit('rooms:preview:ip:minute', null).allowed).toBe(false);
    expect(consumeRoomLimit('rooms:preview:ip:day', '').allowed).toBe(false);
  });
});
