/**
 * Minting the handshake ticket the socket authenticates with (§11.4).
 *
 * `POST /api/realtime/ticket` is same-origin, so the session cookie reaches it
 * in every browser. The token it returns is what crosses to the realtime
 * service, where cookies may not go at all. See
 * packages/auth/src/realtime-ticket.ts for the full reasoning.
 */
import { api } from '@/lib/api';
import type { RealtimeTicket } from '@/app/api/realtime/ticket/route';
import type { HandshakeAuth } from '@/lib/socket/client';

export async function fetchRealtimeTicket(): Promise<string> {
  const { ticket } = await api.post<RealtimeTicket>('/api/realtime/ticket');
  return ticket;
}

/**
 * The `auth` provider handed to socket.io, called before every attempt.
 *
 * A failed mint resolves with an EMPTY payload rather than hanging. The
 * handshake then falls back to the cookie and, if that is absent too, refuses
 * with `unauthenticated` — which the provider turns into a trip to /login. That
 * is the correct outcome for the case that actually causes it: a session that
 * expired while the tab was open. Never call `cb` twice and never leave it
 * uncalled; socket.io waits on it and an uncalled callback is a socket that
 * never connects and never reports why.
 */
export function ticketAuth(): HandshakeAuth {
  return (cb) => {
    void fetchRealtimeTicket()
      .then((ticket) => {
        cb({ ticket });
      })
      .catch(() => {
        cb({});
      });
  };
}
