/**
 * Identifier generation (PLAN.md §3.2 R2, §7.2).
 *
 * Room codes are read aloud and typed by hand, so the properties that matter are
 * "no character can be misread" and "normalisation is the exact inverse of
 * display". UUIDv7 exists for index locality, which is a property of the bytes
 * rather than of anything visible, so it is asserted directly.
 */
import { describe, expect, it } from 'vitest';
import {
  CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  clientId,
  formatRoomCode,
  generateRecoveryCode,
  generateRoomCode,
  normalizeRecoveryCode,
  normalizeRoomCode,
  randomCode,
  uuidv7,
  uuidv7At,
  uuidv7Time,
} from '../ids';

/** Indexing under `noUncheckedIndexedAccess` without scattering non-null asserts. */
function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new Error('index ' + index + ' is out of range');
  return value;
}

const CONFUSABLES = ['0', '1', 'I', 'L', 'O', 'U'] as const;

describe('CODE_ALPHABET', () => {
  it('excludes both members of every confusable pair', () => {
    // Crockford folds O to 0 on input. We remove both instead, so a typed 0 is
    // simply invalid — there is no repair step that could repair to the wrong room.
    for (const c of CONFUSABLES) {
      expect(CODE_ALPHABET).not.toContain(c);
    }
  });

  it('has no duplicates and is the size the entropy claim assumes', () => {
    expect(new Set(CODE_ALPHABET).size).toBe(CODE_ALPHABET.length);
    expect(CODE_ALPHABET.length).toBe(30);
  });
});

describe('normalizeRoomCode / formatRoomCode', () => {
  it('round-trips the display form back to the stored form', () => {
    for (let i = 0; i < 50; i += 1) {
      const code = generateRoomCode();
      const shown = formatRoomCode(code);
      expect(shown).toMatch(/^[^-]{4}-[^-]{4}$/);
      expect(normalizeRoomCode(shown)).toBe(code);
    }
  });

  it('accepts the ways a person actually types a code', () => {
    const canonical = 'K3M7QP2X';
    for (const typed of [
      'K3M7QP2X',
      'k3m7qp2x',
      'K3M7-QP2X',
      'k3m7-qp2x',
      '  K3M7-QP2X  ',
      'K3M7 QP2X',
      'K3M7_QP2X',
      'K3M7.QP2X',
      '\tk3m7\nqp2x ',
    ]) {
      expect(normalizeRoomCode(typed)).toBe(canonical);
    }
  });

  it('rejects the wrong length', () => {
    expect(normalizeRoomCode('')).toBeNull();
    expect(normalizeRoomCode('K3M7QP2')).toBeNull();
    expect(normalizeRoomCode('K3M7QP2XY')).toBeNull();
    expect(normalizeRoomCode('----')).toBeNull();
  });

  it('rejects every character outside the alphabet, especially the confusables', () => {
    for (const c of CONFUSABLES) {
      expect(normalizeRoomCode('K3M7QP2' + c)).toBeNull();
      expect(normalizeRoomCode(c + 'K3M7QP2')).toBeNull();
    }
    // Lowercase confusables are uppercased first, so they are rejected too.
    expect(normalizeRoomCode('k3m7qp2l')).toBeNull();
    expect(normalizeRoomCode('k3m7qp2o')).toBeNull();
    // And anything else a paste might drag in.
    for (const bad of ['K3M7QP2!', 'K3M7QP2%', 'K3M7QP2é', 'K3M7QP2/']) {
      expect(normalizeRoomCode(bad)).toBeNull();
    }
  });

  it('leaves a string that is not code-length untouched when formatting', () => {
    expect(formatRoomCode('ABC')).toBe('ABC');
    expect(formatRoomCode('')).toBe('');
    expect(formatRoomCode('K3M7QP2XY')).toBe('K3M7QP2XY');
  });
});

describe('generateRoomCode', () => {
  it('produces codes of the declared length from the declared alphabet', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateRoomCode();
      expect(code).toHaveLength(ROOM_CODE_LENGTH);
      expect([...code].every((c) => CODE_ALPHABET.includes(c))).toBe(true);
      expect(normalizeRoomCode(code)).toBe(code);
    }
  });

  it('does not repeat itself', () => {
    const codes = new Set(Array.from({ length: 500 }, () => generateRoomCode()));
    expect(codes.size).toBe(500);
  });
});

describe('randomCode', () => {
  it('returns exactly the requested length', () => {
    for (const n of [0, 1, 4, 8, 64, 129]) {
      expect(randomCode(n)).toHaveLength(n);
    }
  });

  it('honours a custom alphabet', () => {
    const code = randomCode(200, 'ab');
    expect(code).toHaveLength(200);
    expect(/^[ab]+$/.test(code)).toBe(true);
  });

  it('covers the whole alphabet, roughly evenly', () => {
    // A smoke test for the rejection sampling. A naive `byte % 30` would still
    // cover every symbol, but the first 16 would come up measurably more often;
    // truncating the range instead (a common "fix") would drop symbols entirely.
    // 30,000 draws over 30 symbols expects 1,000 each with a standard deviation of
    // about 31, so a floor of 700 is ~10 sigma away and cannot flake.
    const counts = new Map<string, number>();
    for (let i = 0; i < 500; i += 1) {
      for (const ch of randomCode(60)) {
        counts.set(ch, (counts.get(ch) ?? 0) + 1);
      }
    }

    expect(counts.size).toBe(CODE_ALPHABET.length);
    for (const symbol of CODE_ALPHABET) {
      expect(counts.get(symbol) ?? 0).toBeGreaterThan(700);
      expect(counts.get(symbol) ?? 0).toBeLessThan(1_400);
    }
  });
});

describe('recovery codes', () => {
  it('generates six groups of four from the confusable-free alphabet', () => {
    const code = generateRecoveryCode();
    const groups = code.split('-');

    expect(groups).toHaveLength(6);
    for (const group of groups) {
      expect(group).toHaveLength(4);
      expect([...group].every((c) => CODE_ALPHABET.includes(c))).toBe(true);
    }
    // 24 symbols over a 30-symbol alphabet is the ~117 bits the ADR claims.
    expect(normalizeRecoveryCode(code)).toHaveLength(24);
  });

  it('honours a custom shape', () => {
    const code = generateRecoveryCode(2, 3);
    expect(code.split('-')).toHaveLength(2);
    expect(at(code.split('-'), 0)).toHaveLength(3);
  });

  it('normalises the way people retype it', () => {
    expect(normalizeRecoveryCode('  k3m7-qp2x  ')).toBe('K3M7QP2X');
    expect(normalizeRecoveryCode('K3M7 QP2X')).toBe('K3M7QP2X');
    expect(normalizeRecoveryCode('k3m7_qp2x')).toBe('K3M7QP2X');
    expect(normalizeRecoveryCode('K3M7QP2X')).toBe('K3M7QP2X');
  });

  it('does not repeat itself', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateRecoveryCode()));
    expect(codes.size).toBe(200);
  });
});

describe('uuidv7', () => {
  const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('is a well-formed version 7, RFC 4122 variant uuid', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(uuidv7()).toMatch(UUID_V7);
    }
  });

  // `uuidv7At` rather than `uuidv7`: the latter is monotonic per process and
  // therefore cannot embed a timestamp that would move an id backwards, which
  // is exactly the guarantee ADR 0007 needs. The pure form keeps this property.
  it('embeds the timestamp so uuidv7Time recovers it exactly', () => {
    for (const ms of [0, 1, 1_700_000_000_000, Date.now(), 2 ** 40 + 12_345]) {
      expect(uuidv7Time(uuidv7At(ms))).toBe(ms);
    }
  });

  it('sorts lexicographically in creation order', () => {
    // This is the entire point: `messages` is indexed by id, and a v4 id would
    // scatter inserts across the btree instead of appending to the hot leaf.
    const base = 1_700_000_000_000;
    const ids = [0, 1, 2, 50, 999, 86_400_000].map((offset) => uuidv7(base + offset));
    expect([...ids].sort()).toEqual(ids);
  });

  it('stays ordered when generated back to back from the real clock', () => {
    const ids = Array.from({ length: 500 }, () => uuidv7());
    const times = ids.map(uuidv7Time);
    for (let i = 1; i < times.length; i += 1) {
      expect(at(times, i)).toBeGreaterThanOrEqual(at(times, i - 1));
    }
    // Ids minted inside the same millisecond differ only in the random tail, so
    // ordering within a millisecond is not guaranteed — uniqueness still is.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('recovers the timestamp of an id minted now to within a second', () => {
    const before = Date.now();
    const recovered = uuidv7Time(uuidv7());
    expect(recovered).toBeGreaterThanOrEqual(before);
    expect(recovered).toBeLessThanOrEqual(Date.now() + 1_000);
  });
});

describe('clientId', () => {
  it('is 16 lowercase alphanumerics and does not collide', () => {
    const ids = Array.from({ length: 500 }, () => clientId());
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9]{16}$/);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/**
 * Monotonicity within a millisecond (RFC 9562 §6.2).
 *
 * ADR 0007 orders the chat transcript by `id` and nothing else, so "later id
 * means later message" has to hold for two messages sent in the same
 * millisecond — not just for two sent in different ones.
 */
describe('uuidv7 monotonicity', () => {
  it('is strictly increasing across a tight burst', () => {
    const ids = Array.from({ length: 500 }, () => uuidv7());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is strictly increasing when the clock is pinned to one millisecond', () => {
    const ids = Array.from({ length: 200 }, () => uuidv7(1_700_000_000_000));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not go backwards when the clock steps back', () => {
    const forward = uuidv7(1_700_000_100_000);
    const backward = uuidv7(1_700_000_000_000);
    expect(backward > forward).toBe(true);
  });

  it('embeds a timestamp later than every id issued so far', () => {
    const at = Date.now() + 60_000;
    expect(uuidv7Time(uuidv7(at))).toBe(at);
  });

  it('uuidv7At is pure — it honours any timestamp and keeps no state', () => {
    expect(uuidv7Time(uuidv7At(1_700_000_200_000))).toBe(1_700_000_200_000);
    expect(uuidv7At(1_000)).not.toBe(uuidv7At(1_000));
  });

  it('keeps the version and variant nibbles', () => {
    const id = uuidv7(1_700_000_300_000);
    expect(id[14]).toBe('7');
    expect('89ab').toContain(id[19]);
  });
});
