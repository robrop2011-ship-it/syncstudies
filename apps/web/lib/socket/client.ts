/**
 * The Socket.IO client, configured in exactly one place (PLAN.md §6.1, §8.8, §11.4).
 *
 * Four of these options are load-bearing and must not be "tidied up":
 *
 *  - `transports: ['websocket']` — no long-polling. The realtime server is
 *    configured the same way, so there is no session-affinity requirement and
 *    `fly scale count N` needs no sticky sessions (§6.1). It also keeps us inside
 *    the app's own CSP, whose `connect-src` allows `ws:`/`wss:` but not an `http:`
 *    origin on another port — allowing polling would mean widening the CSP.
 *  - `withCredentials: true` — the handshake authenticates from the SAME httpOnly
 *    session cookie the web app sets (§11.4). No token ever travels in a query
 *    string, because query strings land in access logs and Referer headers, so
 *    without the cookie the handshake is anonymous and is refused.
 *  - `autoConnect: false` — the provider owns the lifecycle. Connecting inside the
 *    constructor races React's StrictMode double-mount, and the socket that loses
 *    the race is a zombie: still connected, still receiving room broadcasts, with
 *    nothing rendering it.
 *  - `forceNew: true` — by default `io(url)` multiplexes, returning the *same*
 *    Socket instance for a URL it has seen before. Two `RoomSocketProvider`s
 *    briefly alive at once (the overlap while navigating from /r/A to /r/B) would
 *    then share one socket, and the first cleanup to run would tear down the
 *    other's listeners. One provider, one socket, no shared mutable object.
 */
import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@syncstudy/shared';

export type TypedClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** §8.8: "socket.io handles the backoff: 500ms→10s, ×1.5, jitter 0.5". */
export const RECONNECT_DELAY_MS = 500;
export const RECONNECT_DELAY_MAX_MS = 10_000;
export const RECONNECT_JITTER = 0.5;
/** Matches the server's `connectTimeout` (§11.4) so both sides give up together. */
export const CONNECT_TIMEOUT_MS = 20_000;

/**
 * The realtime origin, or null when it is not configured.
 *
 * Returned rather than thrown: this is read inside an effect, and a throw there
 * takes down the whole room tree with a stack trace instead of the one sentence
 * that actually tells you what is wrong. The provider turns null into a plain
 * "the realtime server address is not configured" state.
 *
 * The literal `process.env.NEXT_PUBLIC_REALTIME_URL` member expression is
 * required — Next.js inlines public env vars by static substitution, so reading
 * it through a variable yields `undefined` in the browser bundle.
 */
export function realtimeUrl(): string | null {
  const configured = process.env.NEXT_PUBLIC_REALTIME_URL;
  return typeof configured === 'string' && configured.length > 0 ? configured : null;
}

export function createSocket(url: string): TypedClientSocket {
  // `io()` is not generic in socket.io-client v4; the event maps are applied by
  // annotating the binding, which is the pattern the library's own docs use.
  const socket: TypedClientSocket = io(url, {
    transports: ['websocket'],
    withCredentials: true,
    autoConnect: false,
    forceNew: true,
    reconnection: true,
    reconnectionDelay: RECONNECT_DELAY_MS,
    reconnectionDelayMax: RECONNECT_DELAY_MAX_MS,
    randomizationFactor: RECONNECT_JITTER,
    // Infinity, deliberately. A study session outlives any retry budget we could
    // pick, and "gave up, reload the page" is a worse answer than a thin amber
    // bar that heals itself when the Wi-Fi comes back (§2.3).
    reconnectionAttempts: Infinity,
    timeout: CONNECT_TIMEOUT_MS,
  });
  return socket;
}
