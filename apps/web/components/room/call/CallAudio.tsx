'use client';

/**
 * Remote audio playback.
 *
 * One `<audio>` element per peer, hidden, `autoPlay`. This is not decoration:
 * a received `MediaStreamTrack` produces no sound until it is attached to a
 * media element, and a mesh call with no `<audio>` elements is a call where
 * everything works and nobody can hear anything.
 *
 * `srcObject` is set imperatively because it is not a serialisable attribute —
 * React has no prop for it, and stringifying a `MediaStream` into `src` yields
 * "[object MediaStream]".
 */
import { useEffect, useRef } from 'react';
import { useCallPeers } from '@/lib/stores/call-store';

export function CallAudio() {
  const peers = useCallPeers();

  return (
    <div className="sr-only" aria-hidden="true">
      {peers.map((peer) => (
        <PeerAudio key={peer.userId} userId={peer.userId} track={peer.media.audio} />
      ))}
      {peers.map((peer) =>
        peer.media.screenAudio === null ? null : (
          <PeerAudio
            key={`${peer.userId}:screen`}
            userId={`${peer.userId}:screen`}
            track={peer.media.screenAudio}
          />
        ),
      )}
    </div>
  );
}

function PeerAudio({ userId, track }: { userId: string; track: MediaStreamTrack | null }) {
  const ref = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    if (track === null) {
      element.srcObject = null;
      return;
    }
    element.srcObject = new MediaStream([track]);
    // Autoplay for audio without a user gesture is allowed once the page has
    // had one — and joining a call is one. The catch is here because a refusal
    // must not throw an unhandled rejection into the console on every join.
    void element.play().catch(() => undefined);
  }, [track]);

  return <audio ref={ref} autoPlay playsInline data-peer={userId} />;
}
