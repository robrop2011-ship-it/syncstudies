/**
 * Turning a message body into renderable tokens (PLAN.md §3.5 H5/H6, §11.6).
 *
 * This module produces DATA, never markup. Nothing here builds an HTML string,
 * and nothing downstream may pass its output to `dangerouslySetInnerHTML` —
 * §11.6's first row is "React escapes by default", and the only way to keep that
 * true is to never leave React's escaping in the first place.
 *
 * Three token kinds:
 *
 * - `text` — everything else, rendered as a text node.
 * - `link` — an http/https URL. Rendered as an anchor with
 *   `rel="noopener noreferrer nofollow"` and `target="_blank"`. **No unfurl, no
 *   preview, no fetch of any kind** (§3.5 H5): a preview is an SSRF primitive
 *   and a phishing surface, and it buys nothing a student needs.
 * - `timestamp` — `@41:12`, the feature that makes chat part of the video
 *   rather than bolted to the side of it (§3.5 H6).
 *
 * A URL whose host is on the bundled blocklist becomes a `blocked` token: shown
 * as text with a warning, never as something clickable.
 */
import { isBlockedHost } from '@/lib/chat/blocklist';

export type MessageToken =
  | { kind: 'text'; text: string }
  | { kind: 'link'; text: string; href: string; host: string }
  | { kind: 'blocked'; text: string; host: string }
  | { kind: 'timestamp'; text: string; seconds: number };

/**
 * One pass, two patterns.
 *
 * The URL half deliberately matches only `http://`, `https://` and a bare
 * `www.` — no scheme-less `example.com`, because "sam.i.am" in a sentence is not
 * a link and treating it as one is how a chat client starts underlining prose.
 * Trailing punctuation is trimmed afterwards; a regex that tries to do it inline
 * is unreadable and gets `(see https://x.com/a_(b))` wrong either way.
 *
 * The timestamp half accepts `@m:ss`, `@mm:ss` and `@h:mm:ss`. Seconds are
 * `[0-5]\d` so `@1:99` stays prose.
 */
const PATTERN =
  /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)|@(?:(\d{1,2}):)?(\d{1,3}):([0-5]\d)(?![:\d])/gi;

/** Punctuation that ends a sentence far more often than it ends a URL. */
const TRAILING = /[.,;:!?)\]}'"]+$/;

/**
 * Balance-aware trim.
 *
 * `https://en.wikipedia.org/wiki/Foo_(bar)` ends in a bracket that belongs to
 * the URL; `(see https://example.com)` ends in one that does not. Counting is
 * the only way to tell, and Wikipedia links in a study room are not a hypothetical.
 */
function trimTrailing(raw: string): { url: string; rest: string } {
  let url = raw;
  for (;;) {
    const match = TRAILING.exec(url);
    if (match === null) break;
    const candidate = url.slice(0, match.index);
    const last = url.slice(match.index);
    // Keep a closing bracket only when the URL opened one.
    if (last.startsWith(')') && countOf(candidate, '(') > countOf(candidate, ')')) break;
    if (last.startsWith(']') && countOf(candidate, '[') > countOf(candidate, ']')) break;
    url = candidate;
    if (url.length === 0) break;
  }
  return { url, rest: raw.slice(url.length) };
}

function countOf(text: string, char: string): number {
  let n = 0;
  for (const c of text) if (c === char) n += 1;
  return n;
}

/**
 * Parse a URL, or refuse it.
 *
 * `new URL` is the validator, not the regex: it is the same parser the browser
 * will use, so anything it rejects cannot become a working href either. The
 * protocol allowlist is the important line — `javascript:` and `data:` never
 * reach here through this regex, and the check costs nothing to keep honest.
 */
function toLink(raw: string): { href: string; host: string } | null {
  let url: URL;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.hostname.length === 0) return null;
  return { href: url.toString(), host: url.hostname.replace(/^www\./i, '').toLowerCase() };
}

export function tokenizeMessage(body: string): MessageToken[] {
  const tokens: MessageToken[] = [];
  let cursor = 0;

  const pushText = (text: string): void => {
    if (text.length === 0) return;
    const previous = tokens[tokens.length - 1];
    if (previous?.kind === 'text') previous.text += text;
    else tokens.push({ kind: 'text', text });
  };

  PATTERN.lastIndex = 0;
  for (let match = PATTERN.exec(body); match !== null; match = PATTERN.exec(body)) {
    pushText(body.slice(cursor, match.index));
    cursor = match.index + match[0].length;

    const [whole, urlPart, hours, minutes, seconds] = match;

    if (urlPart !== undefined) {
      const { url, rest } = trimTrailing(urlPart);
      const link = toLink(url);
      if (link === null) {
        pushText(whole);
        continue;
      }
      if (isBlockedHost(link.host)) tokens.push({ kind: 'blocked', text: url, host: link.host });
      else tokens.push({ kind: 'link', text: url, href: link.href, host: link.host });
      pushText(rest);
      continue;
    }

    const total =
      Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0);
    // A video is capped at 24h by the schemas; anything longer is a number that
    // happens to have a colon in it.
    if (total > 86_400) {
      pushText(whole);
      continue;
    }
    tokens.push({ kind: 'timestamp', text: whole, seconds: total });
  }

  pushText(body.slice(cursor));
  return tokens;
}
