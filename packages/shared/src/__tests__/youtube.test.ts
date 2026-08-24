/**
 * YouTube URL parsing (PLAN.md §11.6).
 *
 * Two jobs. The obvious one is accepting every shape a student will actually
 * paste. The security-relevant one is refusing everything else: the returned id is
 * what gets interpolated into an iframe src, so a parser that accepts a hostile
 * host or lets a non-id through is an injection point, not a UX bug.
 */
import { describe, expect, it } from 'vitest';
import { isValidYouTubeId, parseTimeParam, parseYouTubeUrl } from '../video';

const ID = 'dQw4w9WgXcQ';

describe('parseYouTubeUrl — the shapes people paste', () => {
  it('parses a standard watch URL', () => {
    expect(parseYouTubeUrl('https://www.youtube.com/watch?v=' + ID)).toEqual({
      videoId: ID,
      startSec: 0,
    });
    expect(parseYouTubeUrl('https://youtube.com/watch?v=' + ID)).toEqual({
      videoId: ID,
      startSec: 0,
    });
    expect(parseYouTubeUrl('http://www.youtube.com/watch?v=' + ID)).toEqual({
      videoId: ID,
      startSec: 0,
    });
  });

  it('ignores the playlist and tracking parameters that come with a share link', () => {
    expect(
      parseYouTubeUrl('https://www.youtube.com/watch?v=' + ID + '&list=PL123&index=4&pp=abc'),
    ).toEqual({ videoId: ID, startSec: 0 });
  });

  it('parses a youtu.be short link', () => {
    expect(parseYouTubeUrl('https://youtu.be/' + ID)).toEqual({ videoId: ID, startSec: 0 });
    expect(parseYouTubeUrl('https://youtu.be/' + ID + '?si=trackingblob')).toEqual({
      videoId: ID,
      startSec: 0,
    });
  });

  it('parses shorts, embed, live and the legacy /v/ path', () => {
    expect(parseYouTubeUrl('https://www.youtube.com/shorts/' + ID)).toEqual({
      videoId: ID,
      startSec: 0,
    });
    expect(parseYouTubeUrl('https://www.youtube.com/embed/' + ID)).toEqual({
      videoId: ID,
      startSec: 0,
    });
    expect(parseYouTubeUrl('https://www.youtube.com/live/' + ID)).toEqual({
      videoId: ID,
      startSec: 0,
    });
    expect(parseYouTubeUrl('https://www.youtube.com/v/' + ID)).toEqual({
      videoId: ID,
      startSec: 0,
    });
  });

  it('accepts the mobile, music and nocookie hosts', () => {
    expect(parseYouTubeUrl('https://m.youtube.com/watch?v=' + ID)?.videoId).toBe(ID);
    expect(parseYouTubeUrl('https://music.youtube.com/watch?v=' + ID)?.videoId).toBe(ID);
    expect(parseYouTubeUrl('https://www.youtube-nocookie.com/embed/' + ID)?.videoId).toBe(ID);
  });

  it('accepts a URL with no scheme, which is what a copy from the address bar gives you', () => {
    expect(parseYouTubeUrl('youtube.com/watch?v=' + ID)).toEqual({ videoId: ID, startSec: 0 });
    expect(parseYouTubeUrl('www.youtube.com/watch?v=' + ID)).toEqual({ videoId: ID, startSec: 0 });
    expect(parseYouTubeUrl('youtu.be/' + ID)).toEqual({ videoId: ID, startSec: 0 });
  });

  it('accepts a bare 11-character id', () => {
    expect(parseYouTubeUrl(ID)).toEqual({ videoId: ID, startSec: 0 });
    expect(parseYouTubeUrl('_-aBcDeFgH1')).toEqual({ videoId: '_-aBcDeFgH1', startSec: 0 });
  });

  it('tolerates surrounding whitespace and a mixed-case host', () => {
    expect(parseYouTubeUrl('  https://youtu.be/' + ID + '  \n')).toEqual({
      videoId: ID,
      startSec: 0,
    });
    expect(parseYouTubeUrl('HTTPS://WWW.YouTube.com/watch?v=' + ID)).toEqual({
      videoId: ID,
      startSec: 0,
    });
  });

  it('ignores extra path segments after a youtu.be id', () => {
    expect(parseYouTubeUrl('https://youtu.be/' + ID + '/somethingelse')?.videoId).toBe(ID);
  });
});

describe('parseYouTubeUrl — start offsets', () => {
  it('reads every format YouTube puts in t=', () => {
    const base = 'https://www.youtube.com/watch?v=' + ID + '&t=';
    expect(parseYouTubeUrl(base + '90')?.startSec).toBe(90);
    expect(parseYouTubeUrl(base + '90s')?.startSec).toBe(90);
    expect(parseYouTubeUrl(base + '1m30s')?.startSec).toBe(90);
    expect(parseYouTubeUrl(base + '1h2m3s')?.startSec).toBe(3_723);
    expect(parseYouTubeUrl(base + '2h')?.startSec).toBe(7_200);
    expect(parseYouTubeUrl(base + '45m')?.startSec).toBe(2_700);
    expect(parseYouTubeUrl(base + '0')?.startSec).toBe(0);
  });

  it('reads t= from a youtu.be link, which is where share-at-timestamp puts it', () => {
    expect(parseYouTubeUrl('https://youtu.be/' + ID + '?t=41m12s')?.startSec).toBe(2_472);
    expect(parseYouTubeUrl('https://youtu.be/' + ID + '?t=125')?.startSec).toBe(125);
  });

  it('falls back to start= when there is no t=', () => {
    expect(parseYouTubeUrl('https://www.youtube.com/embed/' + ID + '?start=42')?.startSec).toBe(42);
  });

  it('prefers t= when both are present', () => {
    expect(
      parseYouTubeUrl('https://www.youtube.com/watch?v=' + ID + '&t=10&start=999')?.startSec,
    ).toBe(10);
  });

  it('treats an unparseable offset as zero rather than NaN', () => {
    // NaN would propagate into the anchor and poison every position calculation
    // downstream, so this fallback is load-bearing.
    const base = 'https://www.youtube.com/watch?v=' + ID + '&t=';
    for (const bad of ['abc', '1x2', '-5', '1h2x', 'm', '9,5']) {
      expect(parseYouTubeUrl(base + encodeURIComponent(bad))?.startSec).toBe(0);
    }
  });
});

describe('parseYouTubeUrl — everything it must refuse', () => {
  it('returns null for a non-YouTube host', () => {
    expect(parseYouTubeUrl('https://vimeo.com/watch?v=' + ID)).toBeNull();
    expect(parseYouTubeUrl('https://example.com/watch?v=' + ID)).toBeNull();
    expect(parseYouTubeUrl('https://notyoutube.com/watch?v=' + ID)).toBeNull();
  });

  it('returns null for a lookalike host', () => {
    // The whole point of matching the host exactly rather than with `includes`.
    expect(parseYouTubeUrl('https://youtube.com.evil.tld/watch?v=' + ID)).toBeNull();
    expect(parseYouTubeUrl('https://evil.tld/youtube.com/watch?v=' + ID)).toBeNull();
    expect(parseYouTubeUrl('https://fake-youtube.com/watch?v=' + ID)).toBeNull();
    expect(parseYouTubeUrl('https://youtu.be.evil.tld/' + ID)).toBeNull();
  });

  it('returns null for a malformed URL instead of throwing', () => {
    // These come straight from a paste box, so `new URL` throwing here would be a
    // client-side crash on a typo.
    for (const bad of [
      '',
      '   ',
      'https://',
      'not a url at all',
      'ht!tp://x',
      'https://%%%',
      '://youtube.com/watch?v=' + ID,
    ]) {
      expect(() => parseYouTubeUrl(bad)).not.toThrow();
      expect(parseYouTubeUrl(bad)).toBeNull();
    }
  });

  it('returns null when the id is missing or the wrong length', () => {
    expect(parseYouTubeUrl('https://www.youtube.com/watch?v=')).toBeNull();
    expect(parseYouTubeUrl('https://www.youtube.com/watch?v=tooshort')).toBeNull();
    expect(parseYouTubeUrl('https://www.youtube.com/watch?v=waaaaaytoolongforanid')).toBeNull();
    expect(parseYouTubeUrl('https://www.youtube.com/watch')).toBeNull();
    expect(parseYouTubeUrl('https://youtu.be/')).toBeNull();
    expect(parseYouTubeUrl('https://www.youtube.com/')).toBeNull();
    expect(parseYouTubeUrl('https://www.youtube.com/results?search_query=eigenvalues')).toBeNull();
  });

  it('returns null for an id containing characters outside the id alphabet', () => {
    expect(parseYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXc.')).toBeNull();
    expect(parseYouTubeUrl('https://www.youtube.com/embed/..%2Fetc%2Fpasswd')).toBeNull();
    expect(parseYouTubeUrl('<script>aaa</script>')).toBeNull();
  });
});

describe('isValidYouTubeId', () => {
  it('accepts exactly 11 characters from the id alphabet', () => {
    expect(isValidYouTubeId(ID)).toBe(true);
    expect(isValidYouTubeId('_-aBcDeFgH1')).toBe(true);
    expect(isValidYouTubeId('00000000000')).toBe(true);
  });

  it('rejects the wrong length or a character outside the alphabet', () => {
    expect(isValidYouTubeId('')).toBe(false);
    expect(isValidYouTubeId('dQw4w9WgXc')).toBe(false);
    expect(isValidYouTubeId('dQw4w9WgXcQQ')).toBe(false);
    expect(isValidYouTubeId('dQw4w9WgXc/')).toBe(false);
    expect(isValidYouTubeId('dQw4w9WgXc ')).toBe(false);
    expect(isValidYouTubeId('dQw4w9WgXc\n')).toBe(false);
  });
});

describe('parseTimeParam', () => {
  it('handles the absent case', () => {
    expect(parseTimeParam(null)).toBe(0);
    expect(parseTimeParam('')).toBe(0);
  });

  it('handles plain seconds and the h/m/s form', () => {
    expect(parseTimeParam('0')).toBe(0);
    expect(parseTimeParam('7')).toBe(7);
    expect(parseTimeParam('3600')).toBe(3_600);
    expect(parseTimeParam('7s')).toBe(7);
    expect(parseTimeParam('2m')).toBe(120);
    expect(parseTimeParam('1h')).toBe(3_600);
    expect(parseTimeParam('1h2m3s')).toBe(3_723);
    expect(parseTimeParam('90m')).toBe(5_400);
  });

  it('is case-insensitive', () => {
    expect(parseTimeParam('1H2M3S')).toBe(3_723);
  });

  it('returns 0 for anything it cannot parse', () => {
    for (const bad of ['abc', '1m2h', '--', '1.5s', '1 m 30 s', 'NaN']) {
      expect(parseTimeParam(bad)).toBe(0);
    }
  });
});
