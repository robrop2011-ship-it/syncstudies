'use client';

/**
 * The room's client-side state (PLAN.md §5.2, §5.4).
 *
 * TWO decisions here are structural, not stylistic:
 *
 * 1. **Per-room store, created by the provider — never a module-level singleton.**
 *    A singleton survives client-side navigation, so walking from /r/AAAA to
 *    /r/BBBB would render the second room with the first room's participants and
 *    video anchor until the new snapshot landed. Worse, the stale participants are
 *    real people with real avatars, so it looks correct. The store is created in
 *    `RoomSocketProvider`, handed down through React context, and dies with it.
 *
 * 2. **Granular selectors over a coarse "give me the room" hook.** §5.4 sets a
 *    budget of under 60 React commits per minute on an idle room with an active
 *    call, and presence patches (`speaking`) alone arrive several times a second.
 *    Every reducer below therefore returns early when nothing actually changed,
 *    and keeps object identity stable when it did not — so a `speaking` patch
 *    re-renders the participant list and nothing else.
 *
 * The store holds *state*, never the socket: emitting is the provider's job, and
 * a store that can emit is a store that can be made to emit from a render.
 */
import { createContext, useContext } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  IDLE_ANCHOR,
  type ControlRejectReason,
  type Participant,
  type ResolvedPermissions,
  type RoomPolicy,
  type RoomSnapshot,
  type RoomView,
  type VideoAnchor,
} from '@syncstudy/shared';

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface ConnectionState {
  status: ConnectionStatus;
  /** `Date.now()` when the status last changed. Drives "Reconnecting… 12s". */
  since: number;
  /** socket.io's reconnection attempt counter; 0 whenever we are not retrying. */
  attempts: number;
}

/**
 * Why this client is not in the room.
 *
 * Deliberately one field for every terminal outcome — join refused, host ended
 * the room, you were kicked, you were banned. They are the same thing from the
 * UI's point of view (you are not in this room, here is the one sentence that
 * says why) and splitting them into separate flags means four ways to render the
 * same screen and a bug in whichever one is rarest.
 */
export interface JoinError {
  code: string;
  message: string;
}

export interface RoomNotice {
  level: 'info' | 'warn';
  code: string;
  message: string;
  /** Local ms. Makes a repeat of the same notice a distinct value. */
  at: number;
}

export interface RateLimitNotice {
  event: string;
  retryAfterMs: number;
  at: number;
}

export interface ControlRejection {
  reason: ControlRejectReason;
  at: number;
}

interface RoomData {
  room: RoomView | null;
  policy: RoomPolicy | null;
  participants: Participant[];
  video: VideoAnchor;
  you: ResolvedPermissions | null;
  connection: ConnectionState;
  joinError: JoinError | null;
  /** serverNow ≈ Date.now() + this. Published by the provider after each clock sync. */
  serverTimeOffsetMs: number;
  /** Last `video:control_rejected`. Phase 3 records it; Phase 4 reconciles on it. */
  controlRejection: ControlRejection | null;
  notice: RoomNotice | null;
  rateLimit: RateLimitNotice | null;
}

export interface RoomStoreState extends RoomData {
  applySnapshot(snapshot: RoomSnapshot): void;
  applyRoomPatch(patch: Partial<RoomPolicy & { name: string; topic: string | null }>): void;
  setHost(hostId: string): void;
  participantJoined(participant: Participant): void;
  participantLeft(userId: string): void;
  participantPatched(userId: string, patch: Partial<Participant>): void;
  setVideo(anchor: VideoAnchor): void;
  noteControlRejected(reason: ControlRejectReason): void;
  setConnection(status: ConnectionStatus, attempts?: number): void;
  setJoinError(error: JoinError | null): void;
  setServerTimeOffset(offsetMs: number): void;
  pushNotice(notice: Omit<RoomNotice, 'at'>): void;
  clearNotice(): void;
  noteRateLimited(event: string, retryAfterMs: number): void;
  reset(): void;
}

function initialData(): RoomData {
  return {
    room: null,
    policy: null,
    participants: [],
    video: IDLE_ANCHOR,
    you: null,
    // `since: 0`, not `Date.now()`: this object is built during render, and a
    // timestamp there differs between the server pass and the client pass, which
    // is a hydration mismatch for anything that renders it. The provider stamps a
    // real time on the first `setConnection` inside its effect.
    connection: { status: 'connecting', since: 0, attempts: 0 },
    joinError: null,
    serverTimeOffsetMs: 0,
    controlRejection: null,
    notice: null,
    rateLimit: null,
  };
}

/**
 * Join order, oldest first, with the id as a tie-break so the order is total.
 *
 * Sorted once here rather than in the list component: an unsorted list would
 * reorder itself on every reconnect (the server's map iteration order is not a
 * promise), and avatars swapping places for no reason reads as a bug.
 */
function sortParticipants(list: Participant[]): Participant[] {
  return [...list].sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id));
}

export type RoomStoreApi = StoreApi<RoomStoreState>;

export function createRoomStore(): RoomStoreApi {
  return createStore<RoomStoreState>()((set, get) => ({
    ...initialData(),

    applySnapshot(snapshot) {
      // Note what is NOT taken from here: `serverTimeOffsetMs`. Deriving it from
      // `snapshot.serverMs - Date.now()` would bake in a full one-way network
      // delay — tens of milliseconds of pure bias — where ServerClock's median of
      // the fastest half has already cancelled most of it (§8.3).
      set({
        room: snapshot.room,
        policy: snapshot.policy,
        participants: sortParticipants(snapshot.participants),
        video: snapshot.video,
        you: snapshot.you,
        joinError: null,
      });
    },

    applyRoomPatch(patch) {
      const state = get();
      if (state.room === null || state.policy === null) return;

      const { name, topic, ...policyPatch } = patch;
      const nextRoom =
        name === undefined && topic === undefined
          ? state.room
          : {
              ...state.room,
              ...(name === undefined ? {} : { name }),
              ...(topic === undefined ? {} : { topic }),
            };
      const nextPolicy =
        Object.keys(policyPatch).length === 0 ? state.policy : { ...state.policy, ...policyPatch };

      if (nextRoom === state.room && nextPolicy === state.policy) return;
      set({ room: nextRoom, policy: nextPolicy });
    },

    setHost(hostId) {
      const state = get();
      if (state.room === null || state.room.hostId === hostId) return;
      // Roles arrive separately, as presence patches; and if WE are the new host
      // the server pushes a fresh `room:snapshot` rather than making the client
      // re-derive its own permissions from a role string (§11.2 — one resolver).
      set({ room: { ...state.room, hostId } });
    },

    participantJoined(participant) {
      const current = get().participants;
      // Replace rather than append: a reconnect inside the grace window can
      // deliver `presence:join` for someone already in the list.
      const without = current.filter((p) => p.id !== participant.id);
      set({ participants: sortParticipants([...without, participant]) });
    },

    participantLeft(userId) {
      const current = get().participants;
      const next = current.filter((p) => p.id !== userId);
      if (next.length === current.length) return;
      set({ participants: next });
    },

    participantPatched(userId, patch) {
      const current = get().participants;
      const index = current.findIndex((p) => p.id === userId);
      // A patch for somebody we have never seen means our list is stale, not that
      // we should invent a participant out of a partial record.
      if (index === -1) return;

      const existing = current[index];
      if (existing === undefined) return;

      // Bail before touching identity when nothing actually differs. Presence
      // patches are the highest-frequency event in the room — a `speaking` flag
      // arrives up to 4x/sec per talker — and rebuilding the array for a no-op
      // re-renders every participant row for nothing. This is the one reducer
      // that was rebuilding unconditionally.
      let changed = false;
      for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
        if (patch[key] !== undefined && patch[key] !== existing[key]) {
          changed = true;
          break;
        }
      }
      if (!changed) return;

      const next = current.slice();
      next[index] = { ...existing, ...patch };
      set({ participants: next });
    },

    setVideo(anchor) {
      // §8.5b: `revision` is monotonic per room, so an out-of-order or duplicated
      // delivery must not rewind the anchor. Snapshots bypass this on purpose —
      // they ARE the new truth, including after a room reset.
      if (anchor.revision < get().video.revision) return;
      set({ video: anchor });
    },

    noteControlRejected(reason) {
      set({ controlRejection: { reason, at: Date.now() } });
    },

    setConnection(status, attempts = 0) {
      const current = get().connection;
      // `since === 0` is the un-stamped initial value from `initialData`, which
      // exists so that render is not a source of timestamps. The first call after
      // a mount or a reset therefore has to go through even when the status is
      // unchanged, or the room reports having been connecting since 1970.
      const stamped = current.since !== 0;
      if (current.status === status && current.attempts === attempts && stamped) return;
      // `since` tracks the STATUS, not the attempt counter, so a "reconnecting for
      // 40 seconds" label keeps counting up instead of resetting on every retry.
      const since = current.status === status && stamped ? current.since : Date.now();
      set({ connection: { status, since, attempts } });
    },

    setJoinError(error) {
      const current = get().joinError;
      if (current === error) return;
      if (current !== null && error !== null && current.code === error.code) return;
      set({ joinError: error });
    },

    setServerTimeOffset(offsetMs) {
      // Sub-millisecond churn every 30 seconds would re-render every subscriber
      // for a change no one can observe.
      if (Math.abs(get().serverTimeOffsetMs - offsetMs) < 1) return;
      set({ serverTimeOffsetMs: offsetMs });
    },

    pushNotice(notice) {
      set({ notice: { ...notice, at: Date.now() } });
    },

    clearNotice() {
      if (get().notice === null) return;
      set({ notice: null });
    },

    noteRateLimited(event, retryAfterMs) {
      set({ rateLimit: { event, retryAfterMs, at: Date.now() } });
    },

    reset() {
      // Data only — `set` merges, so the reducers above keep their identities and
      // any handler already holding one stays valid.
      set(initialData());
    },
  }));
}

/** Null outside a room: every hook below says so rather than silently returning empty. */
export const RoomStoreContext = createContext<RoomStoreApi | null>(null);

function useRoomStoreApi(): RoomStoreApi {
  const api = useContext(RoomStoreContext);
  if (api === null) {
    throw new Error('Room state is only available inside <RoomSocketProvider>.');
  }
  return api;
}

export function useRoomStore<T>(selector: (state: RoomStoreState) => T): T {
  return useStore(useRoomStoreApi(), selector);
}

/**
 * For selectors that build a NEW object or array each call (`(s) => ({ a, b })`).
 * Without shallow comparison such a selector re-renders on every store write,
 * because its result is a fresh reference every time.
 */
export function useRoomStoreShallow<T>(selector: (state: RoomStoreState) => T): T {
  return useStore(useRoomStoreApi(), useShallow(selector));
}

export function useParticipants(): Participant[] {
  return useRoomStore((s) => s.participants);
}

export function useRoomMeta(): RoomView | null {
  return useRoomStore((s) => s.room);
}

export function useRoomPolicy(): RoomPolicy | null {
  return useRoomStore((s) => s.policy);
}

export function useMyPermissions(): ResolvedPermissions | null {
  return useRoomStore((s) => s.you);
}

export function useConnection(): RoomStoreState['connection'] {
  return useRoomStore((s) => s.connection);
}

export function useJoinError(): JoinError | null {
  return useRoomStore((s) => s.joinError);
}

export function useVideoAnchor(): VideoAnchor {
  return useRoomStore((s) => s.video);
}

/** `sys:notice` — server-initiated, transient. Render it as a toast, then clear it. */
export function useRoomNotice(): RoomNotice | null {
  return useRoomStore((s) => s.notice);
}

/** `sys:rate_limited` — "you are going too fast", with how long until it lifts. */
export function useRateLimitNotice(): RateLimitNotice | null {
  return useRoomStore((s) => s.rateLimit);
}
