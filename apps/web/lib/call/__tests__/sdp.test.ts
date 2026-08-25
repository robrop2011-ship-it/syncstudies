/**
 * Opus SDP munging (PLAN.md §9.4 item 3).
 *
 * Idempotence is the test that matters. Perfect negotiation re-offers on every
 * renegotiation, so a munger that appended its parameters each time would grow
 * the fmtp line without bound until a browser refused to parse it.
 */
import { describe, expect, it } from 'vitest';
import { mungeOpus } from '../sdp';

const WITH_FMTP = [
  'v=0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:63 red/48000/2',
  'a=fmtp:63 111/111',
].join('\r\n');

const WITHOUT_FMTP = ['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2'].join('\r\n');

function fmtpFor(sdp: string, payload: string): string {
  const line = sdp.split(/\r?\n/).find((l) => l.startsWith(`a=fmtp:${payload} `));
  return line?.slice(`a=fmtp:${payload} `.length) ?? '';
}

function params(fmtp: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of fmtp.split(';')) {
    const [k, v] = pair.split('=');
    if (k !== undefined) out[k] = v ?? '';
  }
  return out;
}

describe('mungeOpus', () => {
  it('sets DTX, mono and FEC on the opus fmtp line', () => {
    const p = params(fmtpFor(mungeOpus(WITH_FMTP), '111'));
    expect(p['usedtx']).toBe('1');
    expect(p['stereo']).toBe('0');
    expect(p['useinbandfec']).toBe('1');
    expect(p['maxaveragebitrate']).toBe('32000');
  });

  it('keeps parameters it does not own', () => {
    expect(params(fmtpFor(mungeOpus(WITH_FMTP), '111'))['minptime']).toBe('10');
  });

  it('leaves other payload types alone', () => {
    expect(fmtpFor(mungeOpus(WITH_FMTP), '63')).toBe('111/111');
  });

  it('adds an fmtp line when opus is declared without one', () => {
    const p = params(fmtpFor(mungeOpus(WITHOUT_FMTP), '111'));
    expect(p['usedtx']).toBe('1');
    expect(mungeOpus(WITHOUT_FMTP).split(/\r?\n/).filter((l) => l.startsWith('a=fmtp:111')).length).toBe(1);
  });

  it('is idempotent — renegotiation must not grow the fmtp line', () => {
    const once = mungeOpus(WITH_FMTP);
    expect(mungeOpus(once)).toBe(once);
    expect(mungeOpus(mungeOpus(mungeOpus(WITHOUT_FMTP)))).toBe(mungeOpus(WITHOUT_FMTP));
  });

  it('leaves SDP with no opus untouched', () => {
    const videoOnly = ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=rtpmap:96 VP8/90000'].join('\r\n');
    expect(mungeOpus(videoOnly)).toBe(videoOnly);
  });

  it('preserves CRLF line endings', () => {
    expect(mungeOpus(WITH_FMTP).includes('\r\n')).toBe(true);
  });
});
