'use client';

/**
 * The shared screen taking the main stage (PLAN.md §9.6).
 *
 * When a share starts, the screen fills the video area and the YouTube player
 * shrinks into the corner. It does **not** stop: sync keeps running, the audio
 * ducks, and stopping the share puts the lecture straight back where it was.
 * That is what people expect, and it is also the only implementation that does
 * not risk destroying the iframe — the player element is never re-parented, only
 * resized by the class the caller passes it.
 */
import { MonitorUp } from 'lucide-react';
import { useCallPeers, useCallStore } from '@/lib/stores/call-store';
import { useParticipants } from '@/lib/stores/room-store';
import { VideoTrack } from './VideoTrack';

/** The track being shared, and who is sharing it — local share included. */
export function useActiveShare(): { track: MediaStreamTrack; name: string; isYou: boolean } | null {
  const peers = useCallPeers();
  const participants = useParticipants();
  const localScreen = useCallStore((s) => s.localScreen);

  if (localScreen !== null) return { track: localScreen, name: 'You', isYou: true };

  for (const peer of peers) {
    if (peer.media.screen === null) continue;
    const participant = participants.find((p) => p.id === peer.userId);
    return { track: peer.media.screen, name: participant?.displayName ?? 'Someone', isYou: false };
  }
  return null;
}

export function ScreenShareStage({
  share,
}: {
  share: { track: MediaStreamTrack; name: string; isYou: boolean };
}) {
  return (
    <section
      aria-label={`${share.name} is sharing a screen`}
      className="absolute inset-0 flex flex-col bg-black"
    >
      <VideoTrack
        track={share.track}
        // Your own share echoed back at you is a hall of mirrors; and the audio
        // is already coming out of your own speakers.
        muted={share.isYou}
        className="min-h-0 flex-1 object-contain"
      />
      <p className="flex shrink-0 items-center gap-1.5 border-t border-border bg-bg px-3 py-1.5 text-13 text-secondary">
        <MonitorUp size={16} strokeWidth={1.5} aria-hidden="true" />
        {share.isYou ? 'You are sharing your screen' : `${share.name} is sharing their screen`}
        <span className="ml-auto text-tertiary">The lecture keeps playing in the corner.</span>
      </p>
    </section>
  );
}
