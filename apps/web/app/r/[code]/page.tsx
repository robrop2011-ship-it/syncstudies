/**
 * The room route (PLAN.md §5.1, §11.3).
 *
 * A server component that answers four questions and then gets out of the way:
 * are you signed in, does this room exist, is it still joinable, and are you
 * banned from it. Everything after that arrives over the socket.
 *
 * What it deliberately does NOT do is fetch participants, chat or notes. Those
 * are in `room:snapshot` roughly 200ms after mount, and fetching them here as
 * well would render them once from Postgres and again from Redis — a visible
 * content swap on the most-looked-at surface in the product (§5.1).
 */
import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { normalizeRoomCode } from '@syncstudy/shared';
import { prisma } from '@syncstudy/db';
import { RoomClosedScreen } from '@/components/room/RoomClosedScreen';
import { RoomShell } from '@/components/room/RoomShell';
import type { RoomBootstrap, RoomPreferences } from '@/components/room/types';
import { getCurrentSession } from '@/lib/server/session';
import { avatarUrlFor } from '@/lib/server/views';

export const dynamic = 'force-dynamic';

type RouteParams = { params: Promise<{ code: string }> };

/**
 * `cache()` dedupes this between `generateMetadata` and the page body, so the
 * two of them cost one query between them.
 */
const loadRoom = cache(async (code: string) =>
  prisma.room.findUnique({
    where: { code },
    select: {
      id: true,
      code: true,
      name: true,
      topic: true,
      hostId: true,
      status: true,
      maxParticipants: true,
      playbackControl: true,
      host: { select: { displayName: true } },
    },
  }),
);

const loadBan = cache(async (roomId: string, userId: string) =>
  prisma.roomBan.findUnique({
    where: { roomId_userId: { roomId, userId } },
    select: { userId: true },
  }),
);

const loadSettings = cache(async (userId: string) =>
  prisma.userSettings.findUnique({
    where: { userId },
    select: {
      joinMuted: true,
      joinCameraOff: true,
      pushToTalk: true,
      hideIpFromPeers: true,
      reduceMotion: true,
    },
  }),
);

/**
 * The safe defaults are the DEFAULTS, not a fallback (§11.9). A user with no
 * settings row, or a minor whatever their row says, arrives muted, with the
 * camera off, and with their address hidden from peers. Resolving this on the
 * server rather than in the call layer means there is no window in which the
 * client is running with the wrong answer.
 */
function resolvePreferences(
  row: Awaited<ReturnType<typeof loadSettings>>,
  isMinor: boolean,
): RoomPreferences {
  return {
    joinMuted: row?.joinMuted ?? true,
    joinCameraOff: row?.joinCameraOff ?? true,
    pushToTalk: row?.pushToTalk ?? false,
    hideIpFromPeers: isMinor || (row?.hideIpFromPeers ?? false),
    reduceMotion: row?.reduceMotion ?? false,
  };
}

/**
 * The room name is only ever put in the document title for someone who is
 * signed in and not banned — a `<title>` is a side channel, and the room code
 * space is the whole access-control story (§11.3). `noindex` for the same reason.
 */
export async function generateMetadata({ params }: RouteParams): Promise<Metadata> {
  const base: Metadata = { title: 'Room', robots: { index: false, follow: false } };

  const { code: raw } = await params;
  const code = normalizeRoomCode(raw);
  if (code === null) return base;

  const session = await getCurrentSession();
  if (session === null) return base;

  const room = await loadRoom(code);
  if (room === null) return base;
  if ((await loadBan(room.id, session.user.id)) !== null) return base;

  // Built by mutation rather than a spread with `?? undefined`: under
  // `exactOptionalPropertyTypes`, an explicit `undefined` is not the same thing
  // as an absent key, and `Metadata.description` does not accept it.
  const metadata: Metadata = { ...base, title: room.name };
  if (room.topic !== null) metadata.description = room.topic;
  return metadata;
}

export default async function RoomPage({ params }: RouteParams) {
  const { code: raw } = await params;

  const code = normalizeRoomCode(raw);
  // Not a code at all — a typed `0`, `I` or `L` lands here, and those characters
  // were removed from the alphabet precisely so nothing "repairs" into somebody
  // else's room (§3.2 R2).
  if (code === null) notFound();
  // Canonicalise the address bar, so what somebody copies out of it is the form
  // everything else expects.
  if (raw !== code) redirect(`/r/${code}`);

  const session = await getCurrentSession();
  if (session === null) redirect(`/login?next=${encodeURIComponent(`/r/${code}`)}`);

  const room = await loadRoom(code);
  if (room === null) notFound();

  if (room.status === 'ended' || room.status === 'archived') {
    return (
      <RoomClosedScreen
        kind={room.status === 'ended' ? 'ended' : 'archived'}
        roomName={room.name}
        code={room.code}
      />
    );
  }

  // Checked here as well as at the socket handshake (§11.3): the shell should
  // never mount for someone who is only going to be refused a second later.
  if ((await loadBan(room.id, session.user.id)) !== null) {
    return <RoomClosedScreen kind="banned" roomName={room.name} code={room.code} />;
  }

  const settings = await loadSettings(session.user.id);

  const bootstrap: RoomBootstrap = {
    roomId: room.id,
    code: room.code,
    name: room.name,
    topic: room.topic,
    hostId: room.hostId,
    hostName: room.host.displayName,
    maxParticipants: room.maxParticipants,
    playbackControl: asPlaybackControl(room.playbackControl),
    isHost: room.hostId === session.user.id,
    viewer: {
      id: session.user.id,
      handle: session.user.handle,
      displayName: session.user.displayName,
      avatarUrl: avatarUrlFor(session.user.avatarKey),
    },
    prefs: resolvePreferences(settings, session.user.isMinor),
  };

  return <RoomShell roomCode={room.code} bootstrap={bootstrap} />;
}

/** The column is a varchar; the union is the contract. Anything else is `everyone`. */
function asPlaybackControl(value: string): RoomBootstrap['playbackControl'] {
  return value === 'host_only' || value === 'host_and_cohosts' ? value : 'everyone';
}
