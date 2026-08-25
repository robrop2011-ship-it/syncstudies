'use client';

/**
 * Camera tiles (PLAN.md §12.4).
 *
 * A row above the sidebar on desktop, overlaid bottom-right of the video on
 * narrow screens. Max four, 16:9, 6px radius, and every state is carried by a
 * border and an icon rather than a colour wash — speaking is a 2px `--live`
 * rule that appears instantly and fades over 200 ms, never a pulse (§12.1
 * rule 6).
 *
 * Renders nothing when no camera is on, which is the normal state of a study
 * room: §9.4 item 6 makes audio-only the default precisely because it is both
 * what people want and the largest bandwidth lever there is.
 */
import { MicOff, MonitorUp } from 'lucide-react';
import { MESH_VIDEO_MAX } from '@syncstudy/shared';
import { Avatar } from '@/components/ui/avatar';
import { useCallPeers, useCallStore } from '@/lib/stores/call-store';
import { useParticipants } from '@/lib/stores/room-store';
import { VideoTrack } from './VideoTrack';
import { cn } from '@/lib/utils';

export function CallTiles({ youId, className }: { youId: string; className?: string | undefined }) {
  const peers = useCallPeers();
  const participants = useParticipants();
  const localCamera = useCallStore((s) => s.localCamera);
  const localSpeaking = useCallStore((s) => s.speaking);
  const micOn = useCallStore((s) => s.micOn);

  const remote = peers
    .filter((peer) => peer.media.camera !== null)
    .slice(0, MESH_VIDEO_MAX - (localCamera === null ? 0 : 1));

  if (localCamera === null && remote.length === 0) return null;

  const nameOf = (userId: string): string =>
    participants.find((p) => p.id === userId)?.displayName ?? 'Someone';

  return (
    <div
      aria-label="Cameras"
      className={cn('flex shrink-0 gap-1.5 overflow-x-auto border-b border-border bg-bg p-1.5', className)}
    >
      {localCamera === null ? null : (
        <Tile
          name="You"
          track={localCamera}
          mirrored
          muted
          speaking={localSpeaking}
          micOff={!micOn}
          sharing={false}
          handle={participants.find((p) => p.id === youId)?.handle ?? ''}
        />
      )}
      {remote.map((peer) => {
        const participant = participants.find((p) => p.id === peer.userId);
        return (
          <Tile
            key={peer.userId}
            name={nameOf(peer.userId)}
            handle={participant?.handle ?? ''}
            track={peer.media.camera}
            speaking={participant?.speaking === true}
            micOff={participant?.muted !== false}
            sharing={participant?.sharing === true}
          />
        );
      })}
    </div>
  );
}

function Tile({
  name,
  handle,
  track,
  speaking,
  micOff,
  sharing,
  mirrored = false,
  muted = false,
}: {
  name: string;
  handle: string;
  track: MediaStreamTrack | null;
  speaking: boolean;
  micOff: boolean;
  sharing: boolean;
  mirrored?: boolean;
  muted?: boolean;
}) {
  return (
    <figure
      className={cn(
        'relative aspect-video w-32 shrink-0 overflow-hidden rounded-md border sm:w-40',
        // Instant on, 200ms out — §12.4. No pulse, ever.
        speaking ? 'border-2 border-live' : 'border-border',
        'transition-colors duration-160 ease-standard',
      )}
    >
      {track === null ? (
        <div className="flex h-full w-full items-center justify-center bg-surface-2">
          <Avatar size={32} name={name} handle={handle} src={null} />
        </div>
      ) : (
        <VideoTrack track={track} mirrored={mirrored} muted={muted} />
      )}

      {/* The only permitted gradient in the product: a functional scrim so
          white text stays readable over arbitrary video (§12.1 rule 4). */}
      <figcaption className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/70 to-transparent px-1.5 pb-1 pt-3 text-[11px] text-white">
        {micOff ? <MicOff size={12} strokeWidth={1.5} aria-hidden="true" /> : null}
        {sharing ? <MonitorUp size={12} strokeWidth={1.5} aria-hidden="true" /> : null}
        <span className="truncate">{name}</span>
        {speaking ? <span className="sr-only">speaking</span> : null}
        {micOff ? <span className="sr-only">microphone off</span> : null}
      </figcaption>
    </figure>
  );
}
