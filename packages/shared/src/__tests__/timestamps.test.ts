/**
 * Timestamp formatting (PLAN.md §3.6 — timestamped questions, chat linkification).
 *
 * `formatTimestamp` is what a student reads on the scrubber; `parseTimestamp` is
 * what turns "@41:12" typed in chat into a seek. They have to be exact inverses
 * over the canonical form, because a one-second disagreement makes a bookmark
 * point at the wrong sentence.
 */
import { describe, expect, it } from 'vitest';
import { formatTimestamp, parseTimestamp } from '../video';

describe('formatTimestamp', () => {
  it('formats under an hour as m:ss', () => {
    expect(formatTimestamp(0)).toBe('0:00');
    expect(formatTimestamp(5)).toBe('0:05');
    expect(formatTimestamp(59)).toBe('0:59');
    expect(formatTimestamp(60)).toBe('1:00');
    expect(formatTimestamp(65)).toBe('1:05');
    expect(formatTimestamp(600)).toBe('10:00');
    expect(formatTimestamp(2_472)).toBe('41:12');
  });

  it('switches to h:mm:ss exactly at the hour', () => {
    expect(formatTimestamp(3_599)).toBe('59:59');
    expect(formatTimestamp(3_600)).toBe('1:00:00');
    expect(formatTimestamp(3_601)).toBe('1:00:01');
    expect(formatTimestamp(3_661)).toBe('1:01:01');
    expect(formatTimestamp(7_325)).toBe('2:02:05');
    expect(formatTimestamp(86_399)).toBe('23:59:59');
  });

  it('floors fractional seconds rather than rounding up past the frame', () => {
    expect(formatTimestamp(90.9)).toBe('1:30');
    expect(formatTimestamp(0.4)).toBe('0:00');
    expect(formatTimestamp(3_599.99)).toBe('59:59');
  });

  it('clamps a negative position to zero', () => {
    expect(formatTimestamp(-1)).toBe('0:00');
    expect(formatTimestamp(-10_000)).toBe('0:00');
  });
});

describe('parseTimestamp', () => {
  it('parses the canonical forms', () => {
    expect(parseTimestamp('0:00')).toBe(0);
    expect(parseTimestamp('0:05')).toBe(5);
    expect(parseTimestamp('1:05')).toBe(65);
    expect(parseTimestamp('41:12')).toBe(2_472);
    expect(parseTimestamp('59:59')).toBe(3_599);
    expect(parseTimestamp('1:00:00')).toBe(3_600);
    expect(parseTimestamp('2:02:05')).toBe(7_325);
    expect(parseTimestamp('23:59:59')).toBe(86_399);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseTimestamp('  1:05  ')).toBe(65);
    expect(parseTimestamp('\t1:00:00\n')).toBe(3_600);
  });

  it('accepts a minutes value above 59 when there is no hours part', () => {
    // Deliberate: "90:00" is a perfectly clear way to refer to the 90th minute of a
    // long lecture, and someone will type it. It is not the canonical output form,
    // so this direction does not round-trip.
    expect(parseTimestamp('90:00')).toBe(5_400);
    expect(parseTimestamp('99:30')).toBe(5_970);
    expect(formatTimestamp(5_970)).toBe('1:39:30');
  });

  it('rejects a minutes value above 59 once an hours part is present', () => {
    expect(parseTimestamp('1:99:30')).toBeNull();
    expect(parseTimestamp('1:60:00')).toBeNull();
  });

  it('rejects a seconds value above 59', () => {
    expect(parseTimestamp('1:60')).toBeNull();
    expect(parseTimestamp('1:00:60')).toBeNull();
    expect(parseTimestamp('0:99')).toBeNull();
  });

  it('returns null for anything that is not a timestamp', () => {
    for (const bad of [
      '',
      '   ',
      'abc',
      '12',
      '1:2:3',
      '0:0',
      '12:345',
      '-1:00',
      '1:00:00:00',
      '1:00 pm',
      '::',
      'NaN:NaN',
      '1;05',
      '1.05',
    ]) {
      expect(parseTimestamp(bad)).toBeNull();
    }
  });
});

describe('round trip', () => {
  it('parse(format(s)) === s across the hour boundary and beyond', () => {
    const seconds = [
      0, 1, 5, 59, 60, 61, 90, 599, 600, 3_599, 3_600, 3_601, 3_661, 7_325, 36_000, 86_399,
    ];
    for (const s of seconds) {
      expect(parseTimestamp(formatTimestamp(s))).toBe(s);
    }
  });

  it('format(parse(t)) === t for every canonical string', () => {
    for (const t of ['0:00', '0:07', '9:59', '10:00', '59:59', '1:00:00', '1:23:45', '23:59:59']) {
      const parsed = parseTimestamp(t);
      expect(parsed).not.toBeNull();
      expect(formatTimestamp(parsed ?? -1)).toBe(t);
    }
  });
});
