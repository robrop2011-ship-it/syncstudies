/**
 * Turning a Socket.IO ack callback into a promise, with a deadline.
 *
 * Every client→server event in §10.2 acks, which is what lets the UI tell
 * "rejected" apart from "still in flight". What an ack cannot tell you is that
 * the server is gone: the callback simply never fires, and a dialog that awaited
 * it spins until the tab is closed. So every call here has a deadline, and a
 * missed deadline is reported as a normal failure with a sentence a person can
 * act on.
 */
import type { Ack, AckError } from '@syncstudy/shared';

export const ACK_TIMEOUT_MS = 8_000;

/**
 * Typed `AckError`, not `Ack`: callers read `.message` off it directly, and the
 * union would make them narrow a constant they can see the shape of.
 */
export const NO_SOCKET: AckError = {
  ok: false,
  code: 'offline',
  message: 'Not connected to the room right now.',
};

export function ackWithTimeout(
  run: (ack: (result: Ack) => void) => void,
  timeoutMs: number = ACK_TIMEOUT_MS,
): Promise<Ack> {
  return new Promise<Ack>((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({
        ok: false,
        code: 'timeout',
        message: 'No answer from the room. Check your connection and try again.',
      });
    }, timeoutMs);

    run((result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    });
  });
}
