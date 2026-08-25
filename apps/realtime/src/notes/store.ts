/**
 * The shared notes document (PLAN.md §8.12, §14 Phase 7).
 *
 * **This is not a CRDT, and that is the design.** The document is a list of
 * blocks (paragraphs) with stable ids. Editing one takes a soft lock; an update
 * carries the block's `baseVersion`; a conflict keeps the server's text and
 * preserves the loser's as a **new block below**. Worst case is a duplicated
 * paragraph. There is no merge algorithm to be subtly wrong, and the upgrade to
 * Yjs (§3.6 S2) keeps this UI.
 *
 * Storage follows the same two-tier rule as everything else in the room: **Redis
 * is the live truth, Postgres is the durable truth** (§7.3). A document being
 * typed into cannot round-trip Postgres per keystroke, and losing Redis costs at
 * most one debounce window — `room_notes.content` is re-split into blocks on the
 * next cold read.
 *
 * Amendment A3 adds the two keys this needs to §7.3.
 */
import { prisma } from '@syncstudy/db';
import { ROOM_STATE_TTL_MS, uuidv7, type NotesDocView } from '@syncstudy/shared';
import type { Logger } from '../logger.js';
import { keys, type ScriptedRedis } from '../redis.js';

/** Reserved hash field holding the document version and last-write time. */
const META_FIELD = '__meta';
const BLOCK_PREFIX = 'b:';
/** §8.12: focus locks live 8 s and are refreshed while typing. */
export const BLOCK_LOCK_TTL_MS = 8_000;
const HYDRATE_LOCK_MS = 5_000;
/** A single block. Anything longer is a document, not a paragraph. */
const MAX_BLOCK_LEN = 20_000;
/** Enough for a three-hour lecture's worth of notes; a ceiling, not a target. */
const MAX_BLOCKS = 500;

export interface NoteBlock {
  id: string;
  text: string;
  /** Optimistic per-block version. The `baseVersion` an update is checked against. */
  version: number;
  /** Fractional index, so inserting between two blocks is one write. */
  position: number;
}

export interface NotesDoc {
  blocks: NoteBlock[];
  /** Whole-document version, incremented on every accepted update (§8.12). */
  version: number;
  updatedAt: number;
}

export type BlockUpdateOutcome =
  | { ok: true; kind: 'updated'; block: NoteBlock; version: number }
  /**
   * Somebody else's edit landed first. `block` is the winner (unchanged), and
   * `preserved` is the caller's text, kept as a new block immediately below.
   */
  | { ok: true; kind: 'conflict'; block: NoteBlock; preserved: NoteBlock; version: number }
  | { ok: false; code: 'too_many_blocks' };

function blockField(blockId: string): string {
  return `${BLOCK_PREFIX}${blockId}`;
}

function parseBlock(raw: string): NoteBlock | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const b = value as Partial<NoteBlock>;
    if (typeof b.id !== 'string' || typeof b.text !== 'string') return null;
    return {
      id: b.id,
      text: b.text,
      version: typeof b.version === 'number' ? b.version : 0,
      position: typeof b.position === 'number' ? b.position : 0,
    };
  } catch {
    return null;
  }
}

function sortBlocks(blocks: NoteBlock[]): NoteBlock[] {
  return blocks.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}

/**
 * Blocks are paragraphs: split on a blank line, exactly as §8.12 says, so a
 * document written before this feature existed re-opens as sensible blocks
 * rather than one enormous one.
 */
export function splitIntoBlocks(content: string): NoteBlock[] {
  const parts = content
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.slice(0, MAX_BLOCKS).map((text, index) => ({
    id: uuidv7(),
    text: text.slice(0, MAX_BLOCK_LEN),
    version: 1,
    position: index + 1,
  }));
}

/** The durable form: blocks in order, joined by a blank line. Plain markdown. */
export function serialise(blocks: NoteBlock[]): string {
  return blocks.map((block) => block.text).join('\n\n');
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class NotesStore {
  constructor(
    private readonly redis: ScriptedRedis,
    private readonly log: Logger,
  ) {}

  /** Read the live document, hydrating from Postgres on a cold room. */
  async get(roomId: string): Promise<NotesDoc> {
    const hash = await this.redis.hgetall(keys.roomNotes(roomId));
    if (hash[META_FIELD] === undefined) return this.hydrate(roomId);
    return this.fromHash(hash);
  }

  private fromHash(hash: Record<string, string>): NotesDoc {
    const blocks: NoteBlock[] = [];
    for (const [field, raw] of Object.entries(hash)) {
      if (!field.startsWith(BLOCK_PREFIX)) continue;
      const block = parseBlock(raw);
      if (block !== null) blocks.push(block);
    }
    let version = 0;
    let updatedAt = 0;
    try {
      const meta: unknown = JSON.parse(hash[META_FIELD] ?? '{}');
      if (typeof meta === 'object' && meta !== null) {
        const m = meta as { version?: unknown; updatedAt?: unknown };
        if (typeof m.version === 'number') version = m.version;
        if (typeof m.updatedAt === 'number') updatedAt = m.updatedAt;
      }
    } catch {
      // A corrupt meta field costs a version number, not the document.
    }
    return { blocks: sortBlocks(blocks), version, updatedAt };
  }

  /**
   * Cold-room hydration, locked the same way the video anchor's is: two nodes
   * hydrating at once would each mint a different set of block ids for the same
   * text, and the loser's write would silently duplicate the whole document.
   */
  private async hydrate(roomId: string): Promise<NotesDoc> {
    const lockKey = `room:${roomId}:notes:hydrate`;
    const gotLock = await this.redis.set(lockKey, '1', 'PX', HYDRATE_LOCK_MS, 'NX');

    if (gotLock === null) {
      for (let i = 0; i < 20; i += 1) {
        await sleep(25);
        const hash = await this.redis.hgetall(keys.roomNotes(roomId));
        if (hash[META_FIELD] !== undefined) return this.fromHash(hash);
      }
      this.log.warn({ roomId }, 'notes hydrate lock wait timed out; hydrating anyway');
    }

    try {
      const existing = await this.redis.hgetall(keys.roomNotes(roomId));
      if (existing[META_FIELD] !== undefined) return this.fromHash(existing);

      const row = await prisma.roomNotes.findUnique({ where: { roomId } });
      const blocks = splitIntoBlocks(row?.content ?? '');
      const version = row === null ? 0 : Number(row.version);
      const updatedAt = row?.updatedAt.getTime() ?? 0;

      const fields: Record<string, string> = {
        [META_FIELD]: JSON.stringify({ version, updatedAt }),
      };
      for (const block of blocks) fields[blockField(block.id)] = JSON.stringify(block);

      // One HSET: no reader can observe a half-hydrated document, and the
      // absence of `__meta` is what "still cold" means.
      await this.redis.hset(keys.roomNotes(roomId), fields);
      await this.redis.pexpire(keys.roomNotes(roomId), ROOM_STATE_TTL_MS);
      this.log.info({ roomId, blocks: blocks.length }, 'notes hydrated from postgres');
      return { blocks, version, updatedAt };
    } finally {
      if (gotLock !== null) await this.redis.del(lockKey).catch(() => undefined);
    }
  }

  async view(roomId: string): Promise<NotesDocView> {
    const doc = await this.get(roomId);
    return {
      content: serialise(doc.blocks),
      // Ids and per-block versions travel with the snapshot because the client
      // cannot invent them: an update for an unknown id creates a new block.
      blocks: doc.blocks.map((block) => ({
        id: block.id,
        text: block.text,
        version: block.version,
        position: block.position,
      })),
      version: doc.version,
      updatedAt: doc.updatedAt,
    };
  }

  // ── soft locks (§8.12) ────────────────────────────────────────────────────

  /**
   * Take or refresh the focus lock on one block.
   *
   * Deliberately advisory: it is a courtesy label ("Priya is editing"), not
   * mutual exclusion. The version check on update is what actually protects the
   * text, because a lock that expires mid-sentence must not be able to lose
   * anybody's work.
   */
  async lockBlock(roomId: string, blockId: string, userId: string): Promise<string> {
    const key = keys.noteBlockLock(roomId, blockId);
    const won = await this.redis.set(key, userId, 'PX', BLOCK_LOCK_TTL_MS, 'NX');
    if (won !== null) return userId;

    const holder = await this.redis.get(key);
    if (holder === null || holder === userId) {
      await this.redis.set(key, userId, 'PX', BLOCK_LOCK_TTL_MS);
      return userId;
    }
    return holder;
  }

  async releaseBlock(roomId: string, blockId: string, userId: string): Promise<void> {
    const key = keys.noteBlockLock(roomId, blockId);
    const holder = await this.redis.get(key);
    if (holder === userId) await this.redis.del(key);
  }

  // ── updates ───────────────────────────────────────────────────────────────

  /**
   * Apply one block update with an optimistic version check.
   *
   * A `blockId` that does not exist is a NEW block, not an error: the client
   * mints the id when someone starts a fresh paragraph, so the first update for
   * it is also its creation. That keeps "add a paragraph" from needing its own
   * event and its own round trip before you can type.
   */
  async applyBlockUpdate(
    roomId: string,
    blockId: string,
    text: string,
    baseVersion: number,
  ): Promise<BlockUpdateOutcome> {
    const doc = await this.get(roomId);
    const trimmed = text.slice(0, MAX_BLOCK_LEN);
    const existing = doc.blocks.find((block) => block.id === blockId);
    const nextDocVersion = doc.version + 1;
    const now = Date.now();

    if (existing === undefined) {
      if (doc.blocks.length >= MAX_BLOCKS) return { ok: false, code: 'too_many_blocks' };
      const last = doc.blocks[doc.blocks.length - 1];
      const block: NoteBlock = {
        id: blockId,
        text: trimmed,
        version: 1,
        position: (last?.position ?? 0) + 1,
      };
      await this.write(roomId, [block], nextDocVersion, now);
      return { ok: true, kind: 'updated', block, version: nextDocVersion };
    }

    if (existing.version !== baseVersion) {
      // §8.12: the server's text wins, and the loser's is preserved as a new
      // block immediately below rather than dropped. `position` is fractional
      // precisely so "immediately below" is one write and never a renumbering.
      if (doc.blocks.length >= MAX_BLOCKS) return { ok: false, code: 'too_many_blocks' };
      const index = doc.blocks.indexOf(existing);
      const next = doc.blocks[index + 1];
      const position =
        next === undefined ? existing.position + 1 : (existing.position + next.position) / 2;
      const preserved: NoteBlock = { id: uuidv7(), text: trimmed, version: 1, position };
      await this.write(roomId, [preserved], nextDocVersion, now);
      return { ok: true, kind: 'conflict', block: existing, preserved, version: nextDocVersion };
    }

    // An emptied block is a deleted paragraph — the only way to remove one.
    if (trimmed.trim().length === 0) {
      await this.remove(roomId, blockId, nextDocVersion, now);
      return {
        ok: true,
        kind: 'updated',
        block: { ...existing, text: '', version: existing.version + 1 },
        version: nextDocVersion,
      };
    }

    const block: NoteBlock = { ...existing, text: trimmed, version: existing.version + 1 };
    await this.write(roomId, [block], nextDocVersion, now);
    return { ok: true, kind: 'updated', block, version: nextDocVersion };
  }

  private async write(
    roomId: string,
    blocks: NoteBlock[],
    version: number,
    updatedAt: number,
  ): Promise<void> {
    const fields: Record<string, string> = {
      [META_FIELD]: JSON.stringify({ version, updatedAt }),
    };
    for (const block of blocks) fields[blockField(block.id)] = JSON.stringify(block);
    await this.redis
      .multi()
      .hset(keys.roomNotes(roomId), fields)
      .pexpire(keys.roomNotes(roomId), ROOM_STATE_TTL_MS)
      .exec();
  }

  private async remove(
    roomId: string,
    blockId: string,
    version: number,
    updatedAt: number,
  ): Promise<void> {
    await this.redis
      .multi()
      .hdel(keys.roomNotes(roomId), blockField(blockId))
      .hset(keys.roomNotes(roomId), { [META_FIELD]: JSON.stringify({ version, updatedAt }) })
      .pexpire(keys.roomNotes(roomId), ROOM_STATE_TTL_MS)
      .exec();
  }

  /** Drop the live copy when a room ends. The durable copy stays. */
  async purge(roomId: string): Promise<void> {
    await this.redis.del(keys.roomNotes(roomId));
  }
}
