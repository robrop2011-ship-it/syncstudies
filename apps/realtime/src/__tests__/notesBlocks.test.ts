/**
 * The pure half of the shared-notes document (PLAN.md §8.12).
 *
 * `splitIntoBlocks` and `serialise` are a round trip: a document written before
 * this feature existed has to re-open as sensible paragraphs, and what goes back
 * to Postgres has to be the same plain markdown a person typed — the session
 * export (§3.6 S7) reads that column directly.
 */
import { describe, expect, it } from 'vitest';
import { serialise, splitIntoBlocks } from '../notes/store.js';

describe('splitIntoBlocks', () => {
  it('splits on a blank line, exactly as §8.12 says', () => {
    const blocks = splitIntoBlocks('First paragraph.\n\nSecond paragraph.');
    expect(blocks.map((b) => b.text)).toEqual(['First paragraph.', 'Second paragraph.']);
  });

  it('keeps single newlines inside a paragraph', () => {
    const blocks = splitIntoBlocks('- one\n- two\n\nNext');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.text).toBe('- one\n- two');
  });

  it('tolerates whitespace-only separator lines', () => {
    expect(splitIntoBlocks('a\n   \nb').map((b) => b.text)).toEqual(['a', 'b']);
  });

  it('produces nothing for an empty or blank document', () => {
    expect(splitIntoBlocks('')).toEqual([]);
    expect(splitIntoBlocks('\n\n   \n')).toEqual([]);
  });

  it('assigns increasing positions and distinct ids', () => {
    const blocks = splitIntoBlocks('a\n\nb\n\nc');
    expect(blocks.map((b) => b.position)).toEqual([1, 2, 3]);
    expect(new Set(blocks.map((b) => b.id)).size).toBe(3);
  });

  it('starts every block at version 1, so the first edit bases on it', () => {
    expect(splitIntoBlocks('a\n\nb').every((b) => b.version === 1)).toBe(true);
  });
});

describe('serialise', () => {
  it('round-trips a document through split and back', () => {
    const original = 'Vectors are arrows.\n\nMatrices are transformations.\n\n- and\n- lists survive';
    expect(serialise(splitIntoBlocks(original))).toBe(original);
  });

  it('is empty for no blocks, rather than a stray blank line', () => {
    expect(serialise([])).toBe('');
  });

  it('joins in the order it is given, not by position', () => {
    // The store sorts before calling this; keeping serialise dumb means there is
    // one place ordering is decided rather than two that can disagree.
    expect(
      serialise([
        { id: 'b', text: 'second', version: 1, position: 2 },
        { id: 'a', text: 'first', version: 1, position: 1 },
      ]),
    ).toBe('second\n\nfirst');
  });
});
