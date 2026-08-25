/**
 * The tokenizer is the one piece of chat that decides what becomes clickable, so
 * it is the one piece worth testing exhaustively (PLAN.md §14 Phase 5 testing:
 * "XSS payloads render as text").
 *
 * Every assertion below is really the same assertion: nothing that is not an
 * http/https URL may ever leave here as a `link`.
 */
import { describe, expect, it } from 'vitest';
import { tokenizeMessage, type MessageToken } from '@/lib/chat/linkify';

function kinds(body: string): MessageToken['kind'][] {
  return tokenizeMessage(body).map((token) => token.kind);
}

function first<K extends MessageToken['kind']>(
  body: string,
  kind: K,
): Extract<MessageToken, { kind: K }> | undefined {
  return tokenizeMessage(body).find((token): token is Extract<MessageToken, { kind: K }> =>
    token.kind === kind,
  );
}

describe('tokenizeMessage — links', () => {
  it('links a plain https url', () => {
    const link = first('see https://example.com/x for the proof', 'link');
    expect(link?.href).toBe('https://example.com/x');
    expect(link?.host).toBe('example.com');
  });

  it('treats a bare www. host as https', () => {
    expect(first('www.example.com', 'link')?.href).toBe('https://www.example.com/');
  });

  it('does NOT link a scheme-less domain in prose', () => {
    // "the file is notes.txt" must not become a link to a .txt TLD.
    expect(kinds('the file is notes.txt')).toEqual(['text']);
  });

  it('leaves a javascript: payload as text', () => {
    // The regex cannot match it, and `toLink` would refuse it anyway. Both
    // belts are tested because either one alone would be the whole defence.
    expect(kinds('javascript:alert(1)')).toEqual(['text']);
  });

  it('leaves a data: payload as text', () => {
    expect(kinds('data:text/html;base64,PHNjcmlwdD4=')).toEqual(['text']);
  });

  it('renders markup as text, never as a token boundary', () => {
    const tokens = tokenizeMessage('<script>alert(1)</script>');
    expect(tokens).toEqual([{ kind: 'text', text: '<script>alert(1)</script>' }]);
  });

  it('stops a url at a quote or angle bracket', () => {
    // Otherwise `<a href="https://x">` pasted into chat would swallow the tag.
    expect(first('<a href="https://example.com">hi</a>', 'link')?.href).toBe(
      'https://example.com/',
    );
  });

  it('drops sentence punctuation but keeps balanced brackets', () => {
    expect(first('read https://example.com/a.', 'link')?.text).toBe('https://example.com/a');
    expect(first('see https://en.wikipedia.org/wiki/Foo_(bar)', 'link')?.text).toBe(
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    );
    expect(first('(see https://example.com/a)', 'link')?.text).toBe('https://example.com/a');
  });

  it('blocks a known grabber host and keeps it as text', () => {
    const blocked = first('click https://grabify.link/abc123', 'blocked');
    expect(blocked?.host).toBe('grabify.link');
    expect(kinds('click https://grabify.link/abc123')).not.toContain('link');
  });

  it('blocks a subdomain of a blocked host but not a lookalike', () => {
    expect(first('https://a.grabify.link/x', 'blocked')).toBeDefined();
    expect(first('https://notgrabify.link/x', 'link')).toBeDefined();
  });
});

describe('tokenizeMessage — timestamps (§3.5 H6)', () => {
  it('linkifies @mm:ss', () => {
    expect(first('the proof is at @41:12', 'timestamp')?.seconds).toBe(41 * 60 + 12);
  });

  it('linkifies @h:mm:ss', () => {
    expect(first('@1:02:03', 'timestamp')?.seconds).toBe(3723);
  });

  it('leaves an impossible seconds value as text', () => {
    expect(kinds('@1:99')).toEqual(['text']);
  });

  it('does not swallow an email-ish or handle-ish @', () => {
    expect(kinds('ask @sam about it')).toEqual(['text']);
  });

  it('keeps surrounding text as separate tokens', () => {
    expect(kinds('look at @2:30 please')).toEqual(['text', 'timestamp', 'text']);
  });
});

describe('tokenizeMessage — structure', () => {
  it('round-trips the original body across all tokens', () => {
    const body = 'a https://example.com/x b @3:04 c www.example.org d';
    expect(tokenizeMessage(body).map((t) => t.text).join('')).toBe(body);
  });

  it('handles several links in one message', () => {
    const tokens = tokenizeMessage('https://a.example https://b.example');
    expect(tokens.filter((t) => t.kind === 'link')).toHaveLength(2);
  });

  it('returns a single text token for an empty-ish body', () => {
    expect(tokenizeMessage('hi')).toEqual([{ kind: 'text', text: 'hi' }]);
  });
});
