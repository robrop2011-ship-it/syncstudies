'use client';

/**
 * The room (PLAN.md §5.1, §5.2, §12.4).
 *
 * Everything below the server page is socket-driven. The shell mounts
 * `RoomSocketProvider` — which owns the socket, the `ServerClock` and the room
 * store, and is the only thing that writes to any of them — renders the frame
 * from `bootstrap` so the top bar is correct on the first paint, and then lets
 * `room:snapshot` (roughly 200ms later) take over. Every value has that same
 * shape: store first, bootstrap as the fallback, so nothing pops in and nothing
 * renders empty.
 *
 * Layout is one CSS grid rather than two component trees (§5.5):
 *
 *   <lg   rows: video (16:9, pinned top) · sidebar · control bar (44px targets)
 *   ≥lg   cols: video column | sidebar;  control bar under the video column only
 *
 * That matters because the alternative — rendering the control bar twice and
 * hiding one — puts two of every button in the accessibility tree.
 */
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { Role } from '@syncstudy/shared';
import { RoomSocketProvider } from '@/lib/socket/provider';
import {
  useConnection,
  useJoinError,
  useMyPermissions,
  useParticipants,
  useRoomMeta,
  useRoomNotice,
  useRoomPolicy,
  useRoomStore,
} from '@/lib/stores/room-store';
import { ConnectionBar } from '@/components/room/ConnectionBar';
import { ControlBar } from '@/components/room/ControlBar';
import { RoomClosedScreen } from '@/components/room/RoomClosedScreen';
import { RoomOverflowMenu } from '@/components/room/HostControls';
import { RoomSidebar } from '@/components/room/RoomSidebar';
import { RoomTopBar } from '@/components/room/RoomTopBar';
import { VideoStage } from '@/components/room/VideoStage';
import type { RoomBootstrap, RoomClosedKind } from '@/components/room/types';

/**
 * Join failures that mean "there is no room here for you", as opposed to "not
 * right now". These take over the whole viewport; everything else stays inside
 * the video region so the frame, the code and the way out stay put.
 */
const TERMINAL: Record<string, RoomClosedKind> = {
  kicked: 'kicked',
  banned: 'banned',
  room_ended: 'ended',
  room_archived: 'archived',
};

export function RoomShell({
  roomCode,
  bootstrap,
}: {
  roomCode: string;
  bootstrap: RoomBootstrap;
}) {
  // The provider creates the store per mount and publishes it through context,
  // so there is no module-level singleton to carry one room's participants into
  // the next one on a client-side navigation.
  return (
    <RoomSocketProvider roomCode={roomCode}>
      <RoomFrame bootstrap={bootstrap} />
    </RoomSocketProvider>
  );
}

function RoomFrame({ bootstrap }: { bootstrap: RoomBootstrap }) {
  const meta = useRoomMeta();
  const policy = useRoomPolicy();
  const permissions = useMyPermissions();
  const participants = useParticipants();
  const connection = useConnection();
  const joinError = useJoinError();

  // Rendered server-side too, so it starts as the relative path and becomes
  // absolute once there is a `window` to ask. No hydration mismatch either way.
  const [shareUrl, setShareUrl] = useState(`/r/${bootstrap.code}`);
  useEffect(() => {
    setShareUrl(`${window.location.origin}/r/${bootstrap.code}`);
  }, [bootstrap.code]);

  useServerNoticeToasts();

  const name = meta?.name ?? bootstrap.name;
  const topic = meta?.topic ?? bootstrap.topic;
  const hostId = meta?.hostId ?? bootstrap.hostId;
  const maxParticipants = policy?.maxParticipants ?? bootstrap.maxParticipants;
  const playbackControl = policy?.playbackControl ?? bootstrap.playbackControl;
  const myRole: Role = permissions?.role ?? (bootstrap.isHost ? 'host' : 'member');
  const canSetVideo = permissions?.canSetVideo ?? bootstrap.isHost;

  const terminal = joinError === null ? undefined : TERMINAL[joinError.code];
  if (terminal !== undefined) {
    return <RoomClosedScreen kind={terminal} roomName={name} code={bootstrap.code} />;
  }

  // The snapshot has not landed yet. Not an error — the sidebar shows skeletons
  // at the real row geometry and the rest of the frame is already correct.
  const loading =
    participants.length === 0 && joinError === null && connection.status !== 'failed';

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg text-primary">
      <ConnectionBar
        status={connection.status}
        onRetry={() => {
          window.location.reload();
        }}
      />

      <RoomTopBar
        name={name}
        topic={topic}
        code={bootstrap.code}
        shareUrl={shareUrl}
        participantCount={participants.length}
        maxParticipants={maxParticipants}
        status={connection.status}
        menu={<RoomOverflowMenu myRole={myRole} playbackControl={playbackControl} />}
      />

      <main
        className={[
          // <768: video / sidebar / control bar, with the video sized by its own
          // 16:9 minimum and the sidebar taking the rest.
          'grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)_auto]',
          // 768–1023: the sidebar is a bottom sheet at 45% and the video fills
          // what is left, rather than the other way round (§5.5).
          'md:grid-rows-[minmax(0,1fr)_45%_auto]',
          'lg:grid-cols-[minmax(0,1fr)_320px] lg:grid-rows-[minmax(0,1fr)_auto]',
          'xl:grid-cols-[minmax(0,1fr)_380px]',
        ].join(' ')}
      >
        {/* Pinned to 16:9 at the top on a phone as a MINIMUM height rather than a
            fixed ratio: with no player in it, a strict 16:9 box on a 375px phone
            is 211px tall and clips its own empty state. Phase 4's iframe fills
            the width and lands on the ratio anyway. */}
        <VideoStage
          canSetVideo={canSetVideo}
          className="col-start-1 row-start-1 min-h-[56.25vw] w-full md:h-full md:min-h-0"
        />

        <RoomSidebar
          youId={bootstrap.viewer.id}
          hostId={hostId}
          loading={loading}
          className="col-start-1 row-start-2 border-t border-border lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:border-l lg:border-t-0"
        />

        <ControlBar
          youId={bootstrap.viewer.id}
          fallbackIsHost={bootstrap.isHost}
          className="col-start-1 row-start-3 lg:row-start-2"
        />
      </main>
    </div>
  );
}

/**
 * `sys:notice` is the one thing in the room that earns a toast: a background
 * event nobody on this page caused (§12.5). Consumed and cleared, so the same
 * notice arriving twice shows twice rather than being swallowed as "unchanged".
 */
function useServerNoticeToasts(): void {
  const notice = useRoomNotice();
  const clearNotice = useRoomStore((state) => state.clearNotice);

  useEffect(() => {
    if (notice === null) return;
    if (notice.level === 'warn') toast.warning(notice.message);
    else toast(notice.message);
    clearNotice();
  }, [notice, clearNotice]);
}
