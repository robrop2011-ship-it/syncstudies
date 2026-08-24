/**
 * The video probe's URL validation and response handling (PLAN.md §11.6, §11.7).
 *
 * The route takes a URL from a user and then makes an outbound request, which is
 * the textbook shape of a server-side request forgery. The only thing preventing
 * one is that the user's string is never fetched: it is reduced to an 11-char id
 * and the request is rebuilt from that id against a hardcoded host. These tests
 * exist to make sure that stays true, so most of them are about what is REFUSED.
 *
 * No network. `probeVideo` is not exercised here; everything under test is a
 * pure function or a locally constructed `Response`.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_PROBE_URL_LENGTH,
  OEMBED_ORIGIN,
  buildOembedUrl,
  consumeProbeLimit,
  parseProbeInput,
  probeMessage,
  probeResultFor,
  readCappedText,
  resetProbeLimitsForTests,
  titleFromOembed,
} from '@/app/api/video/probe/probe';

const ID = 'dQw4w9WgXcQ';

describe('parseProbeInput — shapes a student will actually paste', () => {
  it('accepts a watch URL', () => {
    expect(parseProbeInput({ url: `https://www.youtube.com/watch?v=${ID}` })).toEqual({
      videoId: ID,
      startSec: 0,
    });
  });

  it('accepts a short link with a time offset', () => {
    expect(parseProbeInput({ url: `https://youtu.be/${ID}?t=1m30s` })).toEqual({
      videoId: ID,
      startSec: 90,
    });
  });

  it('accepts embed, shorts, mobile, music and nocookie forms', () => {
    const forms = [
      `https://www.youtube-nocookie.com/embed/${ID}`,
      `https://www.youtube.com/shorts/${ID}`,
      `https://m.youtube.com/watch?v=${ID}`,
      `https://music.youtube.com/watch?v=${ID}`,
      `https://www.youtube.com/live/${ID}`,
    ];
    for (const url of forms) {
      expect(parseProbeInput({ url })?.videoId).toBe(ID);
    }
  });

  it('accepts a bare video id', () => {
    expect(parseProbeInput({ url: ID })?.videoId).toBe(ID);
  });
});

describe('parseProbeInput — the SSRF boundary', () => {
  it('refuses a host that merely looks like YouTube', () => {
    const impostors = [
      `https://youtube.com.evil.test/watch?v=${ID}`,
      `https://www.youtube.com.evil.test/watch?v=${ID}`,
      `https://evil.test/watch?v=${ID}`,
      `https://evil.test/?next=https://www.youtube.com/watch?v=${ID}`,
      `https://notyoutube.com/watch?v=${ID}`,
    ];
    for (const url of impostors) {
      expect(parseProbeInput({ url })).toBeNull();
    }
  });

  it('refuses internal and link-local addresses', () => {
    const internal = [
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      'http://127.0.0.1:6379/',
      'http://localhost:5432/',
      'http://[::1]:8080/',
      'http://10.0.0.5/admin',
      'http://metadata.google.internal/computeMetadata/v1/',
    ];
    for (const url of internal) {
      expect(parseProbeInput({ url })).toBeNull();
    }
  });

  it('refuses non-http schemes', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<script>', 'gopher://x/']) {
      expect(parseProbeInput({ url })).toBeNull();
    }
  });

  it('refuses a valid host with an invalid id', () => {
    expect(parseProbeInput({ url: 'https://www.youtube.com/watch?v=../../etc/passwd' })).toBeNull();
    expect(parseProbeInput({ url: 'https://www.youtube.com/watch?v=short' })).toBeNull();
    expect(parseProbeInput({ url: 'https://www.youtube.com/watch?v=waytoolongforanid' })).toBeNull();
  });

  it('refuses a body that is not { url: string }', () => {
    expect(parseProbeInput(null)).toBeNull();
    expect(parseProbeInput(undefined)).toBeNull();
    expect(parseProbeInput('a string')).toBeNull();
    expect(parseProbeInput({})).toBeNull();
    expect(parseProbeInput({ url: 42 })).toBeNull();
    expect(parseProbeInput({ url: '' })).toBeNull();
    expect(parseProbeInput({ url: ['a'] })).toBeNull();
  });

  it('refuses an absurdly long string before trying to parse it', () => {
    const padded = `https://www.youtube.com/watch?v=${ID}&x=${'a'.repeat(MAX_PROBE_URL_LENGTH)}`;
    expect(padded.length).toBeGreaterThan(MAX_PROBE_URL_LENGTH);
    expect(parseProbeInput({ url: padded })).toBeNull();
  });
});

describe('buildOembedUrl — the request is rebuilt, never forwarded', () => {
  it('always targets the hardcoded YouTube origin', () => {
    const built = new URL(buildOembedUrl(ID));
    expect(built.origin).toBe(OEMBED_ORIGIN);
    expect(built.pathname).toBe('/oembed');
    expect(built.searchParams.get('format')).toBe('json');
  });

  it('puts only the validated id into the outbound request', () => {
    const built = new URL(buildOembedUrl(ID));
    expect(built.searchParams.get('url')).toBe(`${OEMBED_ORIGIN}/watch?v=${ID}`);
  });

  it('throws rather than interpolate an unvalidated id', () => {
    // Reaching here without a parse step is a programming error on the security
    // boundary, and it must fail loudly rather than quietly build something.
    for (const bad of ['', 'short', '../../secret', 'http://evil.test', `${ID}&x=1`, `${ID} `]) {
      expect(() => buildOembedUrl(bad)).toThrow();
    }
  });
});

describe('probeResultFor — a "no" from YouTube is a 200, not a 500', () => {
  it('treats 200 as embeddable', () => {
    expect(probeResultFor(ID, 200, 'Organic Chemistry Lecture 7')).toEqual({
      ok: true,
      videoId: ID,
      title: 'Organic Chemistry Lecture 7',
      embeddable: true,
      reason: 'ok',
    });
  });

  it('maps 401 to embed_denied — the §5.3 quirk 5 case, caught at paste time', () => {
    const result = probeResultFor(ID, 401, null);
    expect(result.ok).toBe(false);
    expect(result.embeddable).toBe(false);
    expect(result.reason).toBe('embed_denied');
  });

  it('maps 404 to not_found', () => {
    expect(probeResultFor(ID, 404, null).reason).toBe('not_found');
  });

  it('maps anything else, including an unfollowed redirect, to unavailable', () => {
    expect(probeResultFor(ID, 500, null).reason).toBe('unavailable');
    expect(probeResultFor(ID, 302, null).reason).toBe('unavailable');
  });

  it('never reports a duration, because oEmbed does not carry one', () => {
    expect(probeResultFor(ID, 200, 'A title')).not.toHaveProperty('durationSec');
  });

  it('has copy for every failure and none for success', () => {
    expect(probeMessage(probeResultFor(ID, 200, 'x'))).toBeNull();
    for (const status of [401, 404, 500]) {
      expect(probeMessage(probeResultFor(ID, status, null))).toBeTruthy();
    }
  });
});

describe('titleFromOembed', () => {
  it('reads the title', () => {
    expect(titleFromOembed(JSON.stringify({ title: '  Lecture 7  ', author_name: 'MIT' }))).toBe('Lecture 7');
  });

  it('returns null for anything that is not an oEmbed payload', () => {
    expect(titleFromOembed('not json')).toBeNull();
    expect(titleFromOembed('[]')).toBeNull();
    expect(titleFromOembed('null')).toBeNull();
    expect(titleFromOembed(JSON.stringify({ title: 123 }))).toBeNull();
    expect(titleFromOembed(JSON.stringify({ title: '   ' }))).toBeNull();
  });

  it('truncates to the length Schemas.VideoSet accepts', () => {
    const title = titleFromOembed(JSON.stringify({ title: 'x'.repeat(1_000) }));
    expect(title).not.toBeNull();
    expect(title?.length).toBe(300);
  });
});

describe('readCappedText', () => {
  it('reads a small body', async () => {
    expect(await readCappedText(new Response('{"title":"ok"}'), 1_024)).toBe('{"title":"ok"}');
  });

  it('gives up on a body that overruns the cap mid-stream', async () => {
    expect(await readCappedText(new Response('x'.repeat(200)), 100)).toBeNull();
  });

  it('gives up early on a content-length that overruns the cap', async () => {
    const res = new Response('short', { headers: { 'content-length': '99999' } });
    expect(await readCappedText(res, 100)).toBeNull();
  });

  it('reads a body sitting exactly on the cap', async () => {
    const text = 'y'.repeat(100);
    expect(await readCappedText(new Response(text), 100)).toBe(text);
  });
});

describe('consumeProbeLimit — 20 per minute per user (§11.7)', () => {
  beforeEach(() => {
    resetProbeLimitsForTests();
  });

  it('allows twenty and refuses the twenty-first', () => {
    const now = 1_700_000_000_000;
    for (let i = 0; i < 20; i += 1) {
      expect(consumeProbeLimit('user-a', now).allowed).toBe(true);
    }
    const refused = consumeProbeLimit('user-a', now);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBeGreaterThan(0);
  });

  it('meters each user separately', () => {
    const now = 1_700_000_000_000;
    for (let i = 0; i < 20; i += 1) consumeProbeLimit('user-a', now);
    expect(consumeProbeLimit('user-b', now).allowed).toBe(true);
  });

  it('refills over the window', () => {
    const now = 1_700_000_000_000;
    for (let i = 0; i < 20; i += 1) consumeProbeLimit('user-a', now);
    expect(consumeProbeLimit('user-a', now).allowed).toBe(false);
    // One token is worth a twentieth of the window.
    expect(consumeProbeLimit('user-a', now + 3_100).allowed).toBe(true);
  });

  it('fails closed when the caller cannot be identified', () => {
    expect(consumeProbeLimit(null).allowed).toBe(false);
    expect(consumeProbeLimit('').allowed).toBe(false);
  });
});
