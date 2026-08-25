'use client';

/**
 * The call's client-side state, kept deliberately apart from the room store.
 *
 * Two reasons it is a second store rather than a slice of the first:
 *
 *  - **Lifetime.** The room store lives for as long as the room. The call store
 *    lives for as long as a call, and "leave the call, stay in the room" has to
 *    be a clean reset rather than a careful list of fields to null out.
 *  - **Bundle.** `lib/call/*` pulls in the whole WebRTC layer, and §14 Phase 8.7
 *    requires that to be lazy-loaded until someone presses "Join voice". A room
 *    store that imported call types would drag the transport into the room's
 *    first-load bundle through the type graph's runtime edges.
 *
 * `MediaStreamTrack` objects live here too. They are not serialisable and they
 * are not React state in any meaningful sense — but they are per-peer, they
 * change rarely, and the alternative (a ref map beside the store) means two
 * places to keep in step.
 */
import { createContext, useContext } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { INITIAL_PEER_STATE, type PeerState, type TrackKind } from '@/lib/call/types';

export type CallStatus = 'idle' | 'joining' | 'joined' | 'leaving' | 'error';

export interface PeerMedia {
  audio: MediaStreamTrack | null;
  camera: MediaStreamTrack | null;
  screen: MediaStreamTrack | null;
  screenAudio: MediaStreamTrack | null;
}

const EMPTY_MEDIA: PeerMedia = { audio: null, camera: null, screen: null, screenAudio: null };

export interface CallPeer {
  userId: string;
  state: PeerState;
  media: PeerMedia;
}

interface CallData {
  status: CallStatus;
  /** The last failure, in the user's words. Rendered inline, never as a toast. */
  error: string | null;
  micOn: boolean;
  cameraOn: boolean;
  sharing: boolean;
  /** True while push-to-talk is held. Independent of `micOn`. */
  pttHeld: boolean;
  speaking: boolean;
  peers: Record<string, CallPeer>;
  localAudio: MediaStreamTrack | null;
  localCamera: MediaStreamTrack | null;
  localScreen: MediaStreamTrack | null;
  /** Whoever holds the room's single screen-share lock, from the server. */
  screenHolder: string | null;
}

export interface CallStoreState extends CallData {
  setStatus(status: CallStatus): void;
  setError(error: string | null): void;
  setMicOn(on: boolean): void;
  setCameraOn(on: boolean): void;
  setSharing(sharing: boolean): void;
  setPttHeld(held: boolean): void;
  setSpeaking(speaking: boolean): void;
  setScreenHolder(userId: string | null): void;
  setPeerState(userId: string, state: PeerState): void;
  setPeerTrack(userId: string, kind: TrackKind, track: MediaStreamTrack | null): void;
  removePeer(userId: string): void;
  setLocalTrack(kind: TrackKind, track: MediaStreamTrack | null): void;
  reset(): void;
}

function initialData(): CallData {
  return {
    status: 'idle',
    error: null,
    micOn: false,
    cameraOn: false,
    sharing: false,
    pttHeld: false,
    speaking: false,
    peers: {},
    localAudio: null,
    localCamera: null,
    localScreen: null,
    screenHolder: null,
  };
}

const MEDIA_FIELD: Record<TrackKind, keyof PeerMedia> = {
  mic: 'audio',
  camera: 'camera',
  screen: 'screen',
  screen_audio: 'screenAudio',
};

export type CallStoreApi = StoreApi<CallStoreState>;

export function createCallStore(): CallStoreApi {
  return createStore<CallStoreState>()((set, get) => ({
    ...initialData(),

    setStatus(status) {
      if (get().status === status) return;
      set({ status, ...(status === 'joined' ? { error: null } : {}) });
    },
    setError(error) {
      if (get().error === error) return;
      set({ error });
    },
    setMicOn(on) {
      if (get().micOn === on) return;
      set({ micOn: on, ...(on ? {} : { speaking: false }) });
    },
    setCameraOn(cameraOn) {
      if (get().cameraOn === cameraOn) return;
      set({ cameraOn });
    },
    setSharing(sharing) {
      if (get().sharing === sharing) return;
      set({ sharing });
    },
    setPttHeld(pttHeld) {
      if (get().pttHeld === pttHeld) return;
      set({ pttHeld });
    },
    setSpeaking(speaking) {
      if (get().speaking === speaking) return;
      set({ speaking });
    },
    setScreenHolder(screenHolder) {
      if (get().screenHolder === screenHolder) return;
      set({ screenHolder });
    },

    setPeerState(userId, state) {
      const peers = get().peers;
      const existing = peers[userId];
      if (existing?.state === state) return;
      set({
        peers: {
          ...peers,
          [userId]: {
            userId,
            state,
            media: existing?.media ?? EMPTY_MEDIA,
          },
        },
      });
    },

    setPeerTrack(userId, kind, track) {
      const peers = get().peers;
      const existing = peers[userId];
      const field = MEDIA_FIELD[kind];
      const media = existing?.media ?? EMPTY_MEDIA;
      if (media[field] === track) return;
      set({
        peers: {
          ...peers,
          [userId]: {
            userId,
            state: existing?.state ?? { ...INITIAL_PEER_STATE },
            media: { ...media, [field]: track },
          },
        },
      });
    },

    removePeer(userId) {
      const peers = get().peers;
      if (peers[userId] === undefined) return;
      const next = { ...peers };
      delete next[userId];
      set({ peers: next });
    },

    setLocalTrack(kind, track) {
      switch (kind) {
        case 'mic':
          if (get().localAudio === track) return;
          set({ localAudio: track });
          return;
        case 'camera':
          if (get().localCamera === track) return;
          set({ localCamera: track, cameraOn: track !== null });
          return;
        case 'screen':
          if (get().localScreen === track) return;
          set({ localScreen: track, sharing: track !== null });
          return;
        case 'screen_audio':
          return;
      }
    },

    reset() {
      set(initialData());
    },
  }));
}

export const CallStoreContext = createContext<CallStoreApi | null>(null);

export function useCallStoreApi(): CallStoreApi {
  const api = useContext(CallStoreContext);
  if (api === null) throw new Error('Call state is only available inside <CallProvider>.');
  return api;
}

export function useCallStore<T>(selector: (state: CallStoreState) => T): T {
  return useStore(useCallStoreApi(), selector);
}

/** Stable identity so an empty mesh does not look like a new array each render. */
const EMPTY_PEERS: CallPeer[] = [];

export function useCallPeers(): CallPeer[] {
  return useStore(
    useCallStoreApi(),
    useShallow((state) => {
      const list = Object.values(state.peers);
      return list.length === 0 ? EMPTY_PEERS : list;
    }),
  );
}

export function useCallPeer(userId: string): CallPeer | undefined {
  return useCallStore((state) => state.peers[userId]);
}
