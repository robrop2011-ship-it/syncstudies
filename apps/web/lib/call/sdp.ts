/**
 * Opus SDP munging (PLAN.md §9.4 item 3).
 *
 * DTX is the single biggest saving in a study room: five of six people are
 * silent most of the time, and DTX stops sending during silence entirely.
 * `stereo=0` halves the payload for a voice call that has no stereo content,
 * and inband FEC buys back a packet-loss tolerance that costs almost nothing at
 * 32 kbps.
 *
 * The function is **idempotent** — applying it to already-munged SDP produces
 * the same string. Perfect negotiation re-offers on every renegotiation, so a
 * munger that appended a duplicate `usedtx=1` each time would grow the fmtp line
 * without bound and eventually produce SDP a browser refuses to parse.
 */
import { AUDIO_MAX_BITRATE } from '@syncstudy/shared';

const OPUS_PARAMS: Record<string, string> = {
  usedtx: '1',
  stereo: '0',
  'sprop-stereo': '0',
  useinbandfec: '1',
  maxaveragebitrate: String(AUDIO_MAX_BITRATE),
};

/** Payload types declared as opus in this SDP, in order of appearance. */
function opusPayloadTypes(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const match = /^a=rtpmap:(\d+) opus\/48000/i.exec(line);
    if (match?.[1] !== undefined) out.push(match[1]);
  }
  return out;
}

function mergeFmtp(existing: string): string {
  const params = new Map<string, string>();
  for (const pair of existing.split(';')) {
    const trimmed = pair.trim();
    if (trimmed.length === 0) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) params.set(trimmed, '');
    else params.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
  }
  for (const [key, value] of Object.entries(OPUS_PARAMS)) params.set(key, value);

  return [...params.entries()].map(([k, v]) => (v === '' ? k : `${k}=${v}`)).join(';');
}

export function mungeOpus(sdp: string): string {
  // Preserve the original line ending: some stacks are strict about CRLF.
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(/\r?\n/);
  const payloads = opusPayloadTypes(lines);
  if (payloads.length === 0) return sdp;

  const seen = new Set<string>();
  const out: string[] = [];

  for (const line of lines) {
    const match = /^a=fmtp:(\d+) (.*)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined && payloads.includes(match[1])) {
      seen.add(match[1]);
      out.push(`a=fmtp:${match[1]} ${mergeFmtp(match[2])}`);
      continue;
    }
    out.push(line);
  }

  // An offer can declare opus in rtpmap with no fmtp line at all; insert one
  // directly after the rtpmap so the ordering stays conventional.
  for (const payload of payloads) {
    if (seen.has(payload)) continue;
    const index = out.findIndex((line) => line.startsWith(`a=rtpmap:${payload} opus/48000`));
    if (index === -1) continue;
    out.splice(index + 1, 0, `a=fmtp:${payload} ${mergeFmtp('')}`);
  }

  return out.join(eol);
}
