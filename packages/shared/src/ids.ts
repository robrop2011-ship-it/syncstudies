/**
 * Identifier generation: uuidv7 (time-sortable), room codes, recovery codes.
 *
 * Everything here uses the Web Crypto API, so it runs unchanged in Node 22,
 * the browser, and edge runtimes.
 */

/**
 * Crockford base32 with BOTH members of every confusable pair removed:
 * no 0/O, no 1/I/L, no U. 30 symbols.
 *
 * Removing both members (rather than folding O→0 the way Crockford does) means a
 * code can never contain a character the reader could misread, so there is no
 * repair step and no chance of "repairing" to the wrong code. A typed 0/1/I/L/O/U
 * is simply not a valid code and we say so.
 *
 * 30^8 ≈ 6.6e11 possibilities for an 8-char room code (PLAN.md §3.2 R2).
 */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ROOM_CODE_LENGTH = 8;

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/**
 * Uniform random string over `alphabet`.
 *
 * Rejection sampling, not `% alphabet.length` — the naive modulo biases toward
 * the early symbols whenever the alphabet doesn't divide 256, which for a 30-symbol
 * alphabet makes the first 16 symbols measurably likelier than the rest.
 */
export function randomCode(length: number, alphabet: string = CODE_ALPHABET): string {
  const n = alphabet.length;
  const limit = Math.floor(256 / n) * n; // largest multiple of n representable in a byte
  let out = '';
  while (out.length < length) {
    const need = length - out.length;
    for (const byte of randomBytes(Math.ceil(need * 1.4) + 8)) {
      if (byte >= limit) continue; // reject: keeps the distribution flat
      const ch = alphabet[byte % n];
      if (ch === undefined) continue; // unreachable, but keeps strict indexing honest
      out += ch;
      if (out.length === length) break;
    }
  }
  return out;
}

export function generateRoomCode(): string {
  return randomCode(ROOM_CODE_LENGTH);
}

/**
 * Normalise a user-typed room code: strip separators and whitespace, uppercase.
 * Returns null when the result isn't a plausible code, so callers get one
 * unambiguous "that isn't a room code" path.
 */
export function normalizeRoomCode(input: string): string | null {
  const code = input.trim().toUpperCase().replace(/[\s\-_.]/g, '');
  if (code.length !== ROOM_CODE_LENGTH) return null;
  if (![...code].every((c) => CODE_ALPHABET.includes(c))) return null;
  return code;
}

/** Display form: K3M7-QP2X. Purely cosmetic — never store this form. */
export function formatRoomCode(code: string): string {
  return code.length === ROOM_CODE_LENGTH ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/**
 * A one-time account recovery code (PLAN.md Amendment A1).
 * 6 groups of 4 over a 30-symbol alphabet → 24 symbols ≈ 117 bits of entropy.
 */
export function generateRecoveryCode(groups = 6, groupLen = 4): string {
  return Array.from({ length: groups }, () => randomCode(groupLen)).join('-');
}

/** Codes are compared in normalised form so formatting never affects a match. */
export function normalizeRecoveryCode(input: string): string {
  return input.trim().toUpperCase().replace(/[\s\-_.]/g, '');
}

/**
 * UUIDv7 — 48-bit big-endian millisecond timestamp, then 74 bits of entropy.
 *
 * Time-sortable, which gives `messages` the btree index locality that uuidv4
 * destroys, and which is the whole basis of ADR 0007: the transcript is ordered
 * by `id`, never by `created_at`.
 *
 * **Monotonic within a millisecond** (RFC 9562 §6.2, "monotonic random"). Drawing
 * fresh randomness on every call makes two ids minted in the same millisecond
 * sort arbitrarily against each other — stably, on every client, but not in send
 * order. That is a real defect for a chat transcript: a burst, a retry, or two
 * sends from one node inside one millisecond could display backwards. Instead
 * the entropy is INCREMENTED while the millisecond is unchanged, which keeps the
 * ids unguessable, keeps them valid UUIDv7, and makes the ordering claim true
 * rather than nearly true.
 *
 * Found by an integration test that generated five messages in a loop and
 * asserted their ids were already sorted. Two of the five were not.
 *
 * The consequence to know about: `uuidv7(ms)` embeds `ms` only when `ms` is
 * later than the last id this process issued. It cannot honour a timestamp that
 * would move an id backwards — that is the point. Use `uuidv7At()` when you need
 * an id at an exact instant and do not care about ordering.
 */
let lastMs = -1;
/** The 74 entropy bits of the most recent id, as one integer. */
let lastEntropy = 0n;
const ENTROPY_BITS = 74n;
const ENTROPY_MAX = (1n << ENTROPY_BITS) - 1n;

function freshEntropy(): bigint {
  const bytes = randomBytes(10);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  // 80 bits drawn, 74 kept.
  return value & ENTROPY_MAX;
}

export function uuidv7(nowMs: number = Date.now()): string {
  let ms = nowMs;
  let entropy: bigint;

  if (ms > lastMs) {
    entropy = freshEntropy();
  } else {
    // Same millisecond, or a clock that stepped backwards. Either way the id
    // must not go backwards, so continue from the last one.
    ms = lastMs;
    entropy = lastEntropy + 1n;
    if (entropy > ENTROPY_MAX) {
      // 2^74 ids in one millisecond is unreachable, but the overflow has to go
      // somewhere and RFC 9562 permits borrowing from the timestamp.
      ms += 1;
      entropy = freshEntropy();
    }
  }

  lastMs = ms;
  lastEntropy = entropy;
  return pack(ms, entropy);
}

/** 48-bit timestamp, then the 74 entropy bits around the version/variant nibbles. */
function pack(ms: number, entropy: bigint): string {
  const bytes = new Uint8Array(16);
  const ts = BigInt(ms);
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  // The 74 bits, most significant first: the 4 low bits of byte 6, all of byte
  // 7, the 6 low bits of byte 8, then bytes 9-15.
  bytes[6] = 0x70 | Number((entropy >> 70n) & 0x0fn); // version 7
  bytes[7] = Number((entropy >> 62n) & 0xffn);
  bytes[8] = 0x80 | Number((entropy >> 56n) & 0x3fn); // RFC 4122 variant
  for (let i = 0; i < 7; i += 1) {
    bytes[9 + i] = Number((entropy >> BigInt(48 - i * 8)) & 0xffn);
  }

  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A uuidv7 at an exact instant, with no monotonic state.
 *
 * The pure form: it always embeds the timestamp it is handed, and it never
 * consults or updates the sequence `uuidv7()` maintains. For tests, for tools
 * that reconstruct an id at a known time, and for nothing on a write path — two
 * calls in the same millisecond are unordered relative to each other, which is
 * the property `uuidv7()` exists to fix.
 */
export function uuidv7At(ms: number): string {
  return pack(ms, freshEntropy());
}

/** Extract the embedded timestamp from a uuidv7. Useful in tests and debugging. */
export function uuidv7Time(id: string): number {
  return parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}

/** Short unguessable id for client-generated things (optimistic message ids). */
export function clientId(): string {
  return randomCode(16, 'abcdefghijklmnopqrstuvwxyz0123456789');
}
