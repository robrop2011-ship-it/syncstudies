'use client';

/**
 * Where the call is plugged into the room (PLAN.md §9, §12.4).
 *
 * This component owns the transport, the local voice-activity detector and the
 * video ducking, and it is the only thing that writes to the call store. It is
 * mounted for the whole room but creates nothing until someone presses "Join
 * voice" — the transport, and with it the entire WebRTC layer, is imported
 * dynamically at that moment (§14 Phase 8.7).
 *
 * The one rule worth stating: **the transport never touches the room store, and
 * the room store never touches the transport.** Presence (`inCall`, `muted`,
 * `speaking`, `camOn`) is server state that happens to be about the call;
 * `RTCPeerConnection` state is local. Mixing them is how you end up with a
 * participant list that says someone is talking after they closed their laptop.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type * as React from 'react';
import { useSocket } from '@/lib/socket/provider';
import { useRoomStoreApi } from '@/lib/stores/room-store';
import { CallStoreContext, createCallStore, type CallStoreApi } from '@/lib/stores/call-store';
import { useSyncController } from '@/lib/sync/useSyncController';
import type { CallTransport, JoinFailure } from './types';
import { startVad, type VadHandle } from './vad';

/** §9.4 C5: duck the room video to 35% while anyone in the call is speaking. */
const DUCK_TO = 0.35;
const DUCK_IN_MS = 180;
const DUCK_RELEASE_MS = 600;

export interface CallPreferences {
  joinMuted: boolean;
  pushToTalk: boolean;
  /** Forces relay-only ICE so peers never learn this user's address (§11.5). */
  hideIpFromPeers: boolean;
}

export interface CallApi {
  join(opts?: { video?: boolean }): Promise<void>;
  leave(): Promise<void>;
  toggleMic(): Promise<void>;
  setMic(on: boolean): Promise<void>;
  toggleCamera(): Promise<void>;
  toggleShare(): Promise<void>;
  /** Push-to-talk: hold to transmit. No-op unless PTT is on in settings. */
  setPushToTalk(held: boolean): void;
  preferences: CallPreferences;
}

const CallApiContext = createContext<CallApi | null>(null);

export function useCall(): CallApi {
  const api = useContext(CallApiContext);
  if (api === null) throw new Error('useCall() is only available inside <CallProvider>.');
  return api;
}

const FAILURE_COPY: Record<JoinFailure, string> = {
  call_disabled: 'Voice is turned off in this room.',
  call_full: 'The call is full. Someone has to leave before you can join.',
  video_full: 'Too many cameras are already on.',
  not_permitted: 'You do not have permission to join the call.',
  no_device: 'No microphone found. Plug one in and try again.',
  permission_denied: 'Your browser blocked microphone access.',
  device_busy: 'Another app is using your microphone.',
  insecure_context: 'Voice calling needs an https:// address.',
  unsupported: 'This browser does not support voice calls.',
  transport_error: 'Could not join the call. Try again in a moment.',
};

export function CallProvider({
  selfUserId,
  preferences,
  children,
}: {
  selfUserId: string;
  preferences: CallPreferences;
  children: React.ReactNode;
}): React.ReactElement {
  const socket = useSocket();
  const roomStore = useRoomStoreApi();
  const controller = useSyncController();

  const storeRef = useRef<CallStoreApi | null>(null);
  storeRef.current ??= createCallStore();
  const store = storeRef.current;

  const transportRef = useRef<CallTransport | null>(null);
  const vadRef = useRef<VadHandle | null>(null);
  /** Set while a join is in flight so a double-click cannot open two meshes. */
  const busyRef = useRef(false);
  /** True when we were in the call before a reconnect and should rejoin. */
  const wantsCallRef = useRef(false);
  const [, forceRender] = useState(0);

  // ── ducking (§9.4 C5) ────────────────────────────────────────────────────
  const duckRef = useRef({ raf: 0, from: 1, to: 1, startedAt: 0, durationMs: DUCK_IN_MS });

  const rampDuck = useCallback(
    (to: number, durationMs: number) => {
      if (controller === null) return;
      const anim = duckRef.current;
      cancelAnimationFrame(anim.raf);
      anim.from = anim.to;
      anim.to = to;
      anim.startedAt = performance.now();
      anim.durationMs = durationMs;

      const step = (): void => {
        const elapsed = performance.now() - anim.startedAt;
        const t = Math.min(1, elapsed / anim.durationMs);
        controller.setDuck(anim.from + (anim.to - anim.from) * t);
        if (t < 1) anim.raf = requestAnimationFrame(step);
      };
      anim.raf = requestAnimationFrame(step);
    },
    [controller],
  );

  // Anyone speaking — remote or local — ducks the lecture. Reading it off the
  // room store rather than the transport means a peer whose audio we cannot
  // hear yet still ducks, which is the behaviour people expect.
  useEffect(() => {
    if (controller === null) return;
    let releaseTimer: ReturnType<typeof setTimeout> | null = null;

    const unsubscribe = roomStore.subscribe((state, previous) => {
      const speaking = state.participants.some((p) => p.speaking && p.inCall);
      const wasSpeaking = previous.participants.some((p) => p.speaking && p.inCall);
      if (speaking === wasSpeaking) return;

      if (releaseTimer !== null) {
        clearTimeout(releaseTimer);
        releaseTimer = null;
      }
      if (speaking) {
        rampDuck(DUCK_TO, DUCK_IN_MS);
        return;
      }
      // §9.4: restore after 600 ms of silence, not immediately — otherwise the
      // lecture's volume pumps between every sentence.
      releaseTimer = setTimeout(() => {
        releaseTimer = null;
        rampDuck(1, DUCK_IN_MS);
      }, DUCK_RELEASE_MS);
    });

    // Copied inside the effect: the lint rule is right that `duckRef.current`
    // could be a different object by cleanup time, and cancelling the wrong
    // frame would leave the lecture stuck at 35% volume.
    const anim = duckRef.current;
    return () => {
      unsubscribe();
      if (releaseTimer !== null) clearTimeout(releaseTimer);
      cancelAnimationFrame(anim.raf);
      controller.setDuck(1);
    };
  }, [controller, roomStore, rampDuck]);

  // ── server-driven call state ──────────────────────────────────────────────
  useEffect(() => {
    if (socket === null) return;

    const onScreenshare = ({ holder }: { holder: string | null }): void => {
      store.getState().setScreenHolder(holder);
    };

    const onForceMuted = (): void => {
      // A host muted us. Stop transmitting immediately — the presence patch
      // that follows is what the rest of the room sees, but the microphone has
      // to go quiet here, now.
      store.getState().setMicOn(false);
      void transportRef.current?.setMicEnabled(false);
    };

    const onPeerLeft = ({ userId }: { userId: string }): void => {
      store.getState().removePeer(userId);
    };

    socket.on('rtc:screenshare_changed', onScreenshare);
    socket.on('rtc:force_muted', onForceMuted);
    socket.on('rtc:peer_left', onPeerLeft);

    return () => {
      socket.off('rtc:screenshare_changed', onScreenshare);
      socket.off('rtc:force_muted', onForceMuted);
      socket.off('rtc:peer_left', onPeerLeft);
    };
  }, [socket, store]);

  // ── teardown ──────────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      vadRef.current?.stop();
      vadRef.current = null;
      transportRef.current?.destroy();
      transportRef.current = null;
    };
  }, []);

  /**
   * A socket drop tears the mesh down server-side (§9.5), so the client has to
   * put it back rather than sitting in a call whose peers all closed. The flag
   * survives the reconnect; the transport does not.
   */
  const connection = useRef<string>('');
  useEffect(() => {
    if (socket === null) return;
    const onDisconnect = (): void => {
      connection.current = 'down';
      if (store.getState().status === 'joined') {
        store.getState().setStatus('joining');
      }
    };
    const onConnect = (): void => {
      if (connection.current !== 'down') return;
      connection.current = 'up';
      if (!wantsCallRef.current) return;
      // The room has to be rejoined before the call can be; `room:join` runs on
      // the same connect handler, so give it the tick it needs to land.
      setTimeout(() => {
        if (!wantsCallRef.current || transportRef.current === null) return;
        void transportRef.current
          .join({ audio: store.getState().micOn, video: store.getState().cameraOn })
          .then((result) => {
            store.getState().setStatus(result.ok ? 'joined' : 'error');
            if (!result.ok && result.reason !== undefined) {
              store.getState().setError(FAILURE_COPY[result.reason]);
            }
          });
      }, 600);
    };
    socket.on('disconnect', onDisconnect);
    socket.on('connect', onConnect);
    return () => {
      socket.off('disconnect', onDisconnect);
      socket.off('connect', onConnect);
    };
  }, [socket, store]);

  const emitPresence = useCallback(
    (patch: { muted?: boolean; camOn?: boolean; speaking?: boolean; inCall?: boolean; sharing?: boolean }) => {
      if (socket === null || !socket.connected) return;
      socket.emit('presence:update', patch);
      // Optimistic, so this client's own row does not lag its own microphone by
      // a round trip. The server's echo goes to everyone else.
      roomStore.getState().participantPatched(selfUserId, patch);
    },
    [socket, roomStore, selfUserId],
  );

  const api = useMemo<CallApi>(() => {
    const state = () => store.getState();

    const startVoiceDetection = (transport: CallTransport): void => {
      vadRef.current?.stop();
      const stream = transport.getLocalStream();
      if (stream === null) return;
      vadRef.current = startVad(stream, (speaking) => {
        state().setSpeaking(speaking);
        emitPresence({ speaking });
      });
    };

    const join: CallApi['join'] = async (opts = {}) => {
      if (socket === null || busyRef.current) return;
      if (state().status === 'joined' || state().status === 'joining') return;
      busyRef.current = true;
      state().setStatus('joining');
      state().setError(null);

      try {
        // The WebRTC layer is imported here and nowhere else, so the room's
        // first-load bundle never contains it (§14 Phase 8.7).
        const { MeshTransport } = await import('./mesh');
        const transport = new MeshTransport({
          socket,
          selfUserId,
          relayOnly: preferences.hideIpFromPeers,
          events: {
            onRemoteTrack: (peerId, track, kind) => state().setPeerTrack(peerId, kind, track),
            onPeerState: (peerId, peerState) => state().setPeerState(peerId, peerState),
            onLocalTrack: (kind, track) => state().setLocalTrack(kind, track),
            onNotice: (level, message) => {
              if (level === 'warn') state().setError(message);
              roomStore.getState().pushNotice({ level, code: 'call', message });
            },
          },
        });
        transportRef.current = transport;

        // Safe defaults (§11.9): you arrive muted unless the user has said
        // otherwise, and push-to-talk implies muted until the key is held.
        const micOn = !preferences.joinMuted && !preferences.pushToTalk;
        const result = await transport.join({ audio: micOn, video: opts.video === true });

        if (!result.ok) {
          transport.destroy();
          transportRef.current = null;
          state().setStatus('error');
          state().setError(FAILURE_COPY[result.reason ?? 'transport_error']);
          return;
        }

        wantsCallRef.current = true;
        state().setStatus('joined');
        state().setMicOn(micOn);
        startVoiceDetection(transport);
        emitPresence({ inCall: true, muted: !micOn, camOn: opts.video === true });
        if (result.videoDowngraded === true) {
          state().setError('Cameras are full in this room — you joined with audio only.');
        }
      } catch (err) {
        transportRef.current?.destroy();
        transportRef.current = null;
        state().setStatus('error');
        state().setError('Could not start the call. Try again in a moment.');
        if (process.env.NODE_ENV !== 'production') {
          // eslint-disable-next-line no-console -- developer-facing only
          console.error('[call] join failed', err);
        }
      } finally {
        busyRef.current = false;
        forceRender((n) => n + 1);
      }
    };

    const leave: CallApi['leave'] = async () => {
      wantsCallRef.current = false;
      const transport = transportRef.current;
      if (transport === null) {
        state().reset();
        return;
      }
      state().setStatus('leaving');
      vadRef.current?.stop();
      vadRef.current = null;
      await transport.leave().catch(() => undefined);
      transport.destroy();
      transportRef.current = null;
      state().reset();
      emitPresence({ inCall: false, camOn: false, speaking: false, sharing: false, muted: true });
    };

    const setMic: CallApi['setMic'] = async (on) => {
      const transport = transportRef.current;
      if (transport === null) return;
      // A force-muted participant cannot unmute themselves (R7). The server
      // enforces it too; refusing here keeps the button honest.
      const me = roomStore.getState().participants.find((p) => p.id === selfUserId);
      if (on && me?.forceMuted === true) return;
      await transport.setMicEnabled(on);
      state().setMicOn(on);
      emitPresence({ muted: !on, ...(on ? {} : { speaking: false }) });
      if (!on) state().setSpeaking(false);
    };

    return {
      preferences,
      join,
      leave,
      setMic,
      async toggleMic() {
        await setMic(!state().micOn);
      },
      async toggleCamera() {
        const transport = transportRef.current;
        if (transport === null) return;
        const next = !state().cameraOn;
        await transport.setCameraEnabled(next);
        // `setCameraEnabled` may refuse (no camera, permission denied) and says
        // so through `onLocalTrack`; read the result rather than assuming.
        const actual = state().cameraOn;
        emitPresence({ camOn: actual });
      },
      async toggleShare() {
        const transport = transportRef.current;
        if (transport === null) return;
        if (state().sharing) {
          await transport.stopScreenShare();
          emitPresence({ sharing: false });
          return;
        }
        const started = await transport.startScreenShare();
        if (started) emitPresence({ sharing: true, camOn: false });
      },
      setPushToTalk(held) {
        if (!preferences.pushToTalk) return;
        if (state().pttHeld === held) return;
        state().setPttHeld(held);
        void setMic(held);
      },
    };
  }, [socket, store, roomStore, selfUserId, preferences, emitPresence]);

  return (
    <CallStoreContext.Provider value={store}>
      <CallApiContext.Provider value={api}>{children}</CallApiContext.Provider>
    </CallStoreContext.Provider>
  );
}
