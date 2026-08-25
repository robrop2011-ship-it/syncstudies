/**
 * The `RoomBootstrap` prop (PLAN.md §5.1).
 *
 * The room page is a server component that resolves auth, membership and the
 * room row, then hands the client exactly this much — enough to render the top
 * bar and the frame on the first paint, and nothing more.
 *
 * Deliberately absent: participants, chat, notes, and the video anchor. Those
 * arrive in `room:snapshot` ~200 ms after mount. Fetching them here as well
 * would render them twice and produce a visible content swap (§5.1).
 *
 * This module has no `'use client'` directive and no imports beyond types, so
 * both the server page and the client shell can import it without either one
 * pulling the other's dependencies across the boundary.
 */
import type { PlaybackControlPolicy } from '@syncstudy/shared';

export interface RoomViewer {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
}

/**
 * The account settings the room actually acts on, resolved server-side.
 *
 * Read here rather than fetched by the call layer because they decide the very
 * first thing that happens when someone presses "Join voice" — arriving unmuted
 * because a preference had not loaded yet is not a defect you can apologise for
 * afterwards (§11.9).
 */
export interface RoomPreferences {
  joinMuted: boolean;
  joinCameraOff: boolean;
  pushToTalk: boolean;
  /** Forces relay-only ICE so peers never learn this user's address (§11.5). */
  hideIpFromPeers: boolean;
  reduceMotion: boolean;
}

export interface RoomBootstrap {
  roomId: string;
  code: string;
  name: string;
  topic: string | null;
  hostId: string;
  hostName: string;
  maxParticipants: number;
  playbackControl: PlaybackControlPolicy;
  /** Resolved from the room row, so host affordances render before the snapshot lands. */
  isHost: boolean;
  viewer: RoomViewer;
  prefs: RoomPreferences;
}

/** Why a room stopped being joinable. Rendered by `RoomClosedScreen`. */
export type RoomClosedKind = 'ended' | 'archived' | 'banned' | 'kicked';
