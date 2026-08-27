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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { canControlVideo, type Role } from '@syncstudy/shared';
import { RoomSocketProvider } from '@/lib/socket/provider';
import {
  useConnection,
  useJoinError,
  useMyPermissions,
  useParticipants,
  useRoomMeta,
  useRoomNotice,
  useNoteItems,
  useRoomPolicy,
  useRoomStore,
} from '@/lib/stores/room-store';
import { ConnectionBar } from '@/components/room/ConnectionBar';
import { ControlBar } from '@/components/room/ControlBar';
import { RoomClosedScreen } from '@/components/room/RoomClosedScreen';
import { RoomOverflowMenu } from '@/components/room/HostControls';
import { PlayerControls } from '@/components/room/PlayerControls';
import { RoomSidebar } from '@/components/room/RoomSidebar';
import { RoomTopBar } from '@/components/room/RoomTopBar';
import { RoomShortcuts } from '@/components/room/ShortcutSheet';
import { Onboarding } from '@/components/room/Onboarding';
import { FeedbackDialog } from '@/components/room/FeedbackDialog';
import { VideoStage } from '@/components/room/VideoStage';
import { CallProvider } from '@/lib/call/provider';
import { InkProvider } from '@/lib/ink/provider';
import { CallAudio } from '@/components/room/call/CallAudio';
import { CallTiles } from '@/components/room/call/CallTiles';
import { ScreenShareStage, useActiveShare } from '@/components/room/call/ScreenShareStage';
import { useSyncController } from '@/lib/sync/useSyncController';
import type { ScrubberTick } from '@/components/room/Scrubber';
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
      {/* Mounted for the whole room, but it creates nothing until someone
          presses "Join voice" — the WebRTC layer is a dynamic import inside
          `join()`, so it is absent from the room's first-load bundle (§14
          Phase 8.7). */}
      <CallProvider
        selfUserId={bootstrap.viewer.id}
        preferences={{
          joinMuted: bootstrap.prefs.joinMuted,
          pushToTalk: bootstrap.prefs.pushToTalk,
          hideIpFromPeers: bootstrap.prefs.hideIpFromPeers,
        }}
      >
        {/* Ink lives inside the socket and clock providers because it needs
            both: strokes go out over the socket, and they are aged off SERVER
            time so the same stroke fades at the same instant for everyone. */}
        <InkProvider selfUserId={bootstrap.viewer.id}>
          <RoomFrame bootstrap={bootstrap} />
        </InkProvider>
        <CallAudio />
        <RoomShortcuts />
        <Onboarding isHost={bootstrap.isHost} />
        <FeedbackDialog roomId={bootstrap.roomId} />
      </CallProvider>
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
  // Until the snapshot lands, resolve it the same way the server will (§11.2) —
  // guessing "no" would disable the controls of the person who just opened their
  // own room for the first 200ms.
  const canControl = permissions?.canControlVideo ?? canControlVideo(myRole, playbackControl);
  // The host's name is what §8.5a's "Only Priya can control playback" needs. The
  // bootstrap value covers the window before presence has arrived.
  const hostName =
    participants.find((participant) => participant.id === hostId)?.displayName ??
    bootstrap.hostName;

  // §3.6 S3/S4: the same items feed the scrubber ticks and the Notes panel, so
  // the two cannot disagree about where a question was asked.
  const noteItems = useNoteItems();
  const controller = useSyncController();
  const ticks = useMemo<ScrubberTick[]>(
    () =>
      noteItems
        .filter((item) => item.videoTs !== null)
        .map((item) => ({
          id: item.id,
          atSec: item.videoTs ?? 0,
          label: item.body,
          kind: item.kind,
        })),
    [noteItems],
  );
  // Seeking from a tick goes through the same permission-checked path as the
  // scrubber. There is no second seek path to keep in step.
  const seekRoom = useCallback(
    (positionSec: number) => {
      if (!canControl) return;
      void controller?.commitSeek(positionSec);
    },
    [controller, canControl],
  );

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
        // `meta` is non-null only once a snapshot has landed, which is exactly
        // "we were in this room at some point on this mount".
        everConnected={meta !== null}
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
        {/* The video column: stage on top, scrubber and transport under it. One
            grid cell holding a flex column rather than two cells, so the control
            bar tracks the video's width at every breakpoint without a second set
            of grid placements to keep in step. */}
        <div className="col-start-1 row-start-1 flex min-h-0 min-w-0 flex-col">
          {/* Pinned to 16:9 at the top on a phone as a MINIMUM height rather than
              a fixed ratio: with no player in it, a strict 16:9 box on a 375px
              phone is 211px tall and clips its own empty state. The iframe fills
              the width and lands on the ratio anyway. */}
          {/* §12.4: cameras live in a row above the video, capped at four and
              rendered only when somebody actually has one on. */}
          <CallTiles youId={bootstrap.viewer.id} />
          <StageArea canSetVideo={canSetVideo} loading={loading} />
          <PlayerControls
            canControl={canControl}
            playbackControl={playbackControl}
            hostName={hostName}
            ticks={ticks}
            onTickSeek={seekRoom}
          />
        </div>

        <RoomSidebar
          youId={bootstrap.viewer.id}
          hostId={hostId}
          loading={loading}
          canSeek={canControl}
          onSeek={seekRoom}
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


/**
 * The video area, and what happens to it when somebody shares a screen (§9.6).
 *
 * The player element is never re-parented — only its class changes — because
 * moving an iframe in the DOM reloads it, and a reload here means losing the
 * player, the buffer and the sync state to a cosmetic layout change. While a
 * share is up the lecture keeps playing in the corner: sync continues, the
 * audio ducks, and stopping the share puts it straight back.
 */
function StageArea({ canSetVideo, loading }: { canSetVideo: boolean; loading: boolean }) {
  const share = useActiveShare();

  return (
    <div className="relative flex min-h-[56.25vw] w-full min-w-0 flex-col md:min-h-0 md:flex-1">
      {share === null ? null : <ScreenShareStage share={share} />}
      <VideoStage
        canSetVideo={canSetVideo}
        loading={loading}
        className={
          share === null
            ? 'min-h-[56.25vw] w-full md:min-h-0 md:flex-1'
            : // 16:9 at 40% width, clear of the share's own caption bar.
              'absolute bottom-12 right-3 z-10 w-40 rounded-md border border-border-strong shadow-dropdown sm:w-56 lg:w-64'
        }
      />
    </div>
  );
}
