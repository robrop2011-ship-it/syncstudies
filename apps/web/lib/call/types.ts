/**
 * The `CallTransport` seam (PLAN.md §9.7).
 *
 * `MeshTransport` ships in v1; `LiveKitTransport` is v1.2. The room UI, the call
 * store and the participant tiles depend only on this interface, so switching is
 * a factory call rather than a rewrite. Nothing below this line may mention
 * `RTCPeerConnection`.
 */

export type TrackKind = 'mic' | 'camera' | 'screen' | 'screen_audio';

/**
 * §9.5's ladder, collapsed to what the UI can usefully render.
 *
 * `reconnecting` covers both `disconnected` (transient, often self-heals) and an
 * ICE restart in flight: from the reader's point of view they are the same
 * sentence, and splitting them would put a scarier word on the screen for the
 * case that usually fixes itself in four seconds.
 */
export type PeerConnectionState =
  | 'new'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed'
  | 'closed';

export type ConnectionQuality = 'unknown' | 'good' | 'fair' | 'poor';

export interface PeerState {
  connection: PeerConnectionState;
  quality: ConnectionQuality;
  /** Round-trip time in ms from the selected candidate pair, null before stats. */
  rttMs: number | null;
  /** 0–1 fraction of inbound packets lost over the last sampling window. */
  packetLoss: number;
  /** True once ICE settled on a relayed candidate pair — TURN is carrying it. */
  relayed: boolean;
}

export const INITIAL_PEER_STATE: PeerState = {
  connection: 'new',
  quality: 'unknown',
  rttMs: null,
  packetLoss: 0,
  relayed: false,
};

export interface CallStats {
  peers: number;
  /** Sum across peers, in bits per second, over the last sampling window. */
  outboundBitrate: number;
  inboundBitrate: number;
  relayedPeers: number;
}

export interface JoinOptions {
  audio: boolean;
  video: boolean;
}

export type JoinFailure =
  | 'call_disabled'
  | 'call_full'
  | 'video_full'
  | 'not_permitted'
  | 'no_device'
  | 'permission_denied'
  | 'device_busy'
  | 'insecure_context'
  | 'unsupported'
  | 'transport_error';

export interface JoinResult {
  ok: boolean;
  reason?: JoinFailure;
  /** True when the mesh came up audio-only because the camera cap was hit. */
  videoDowngraded?: boolean;
}

export interface CallTransportEvents {
  /** A remote track arrived, or was replaced. `null` means it went away. */
  onRemoteTrack(peerId: string, track: MediaStreamTrack | null, kind: TrackKind): void;
  onPeerState(peerId: string, state: PeerState): void;
  /** Local media changed underneath us — a device unplugged, or a share ended. */
  onLocalTrack(kind: TrackKind, track: MediaStreamTrack | null): void;
  /** Something the user has to be told about, in their own words. */
  onNotice(level: 'info' | 'warn', message: string): void;
}

export interface CallTransport {
  join(opts: JoinOptions): Promise<JoinResult>;
  leave(): Promise<void>;
  setMicEnabled(on: boolean): Promise<void>;
  setCameraEnabled(on: boolean): Promise<void>;
  startScreenShare(): Promise<boolean>;
  stopScreenShare(): Promise<void>;
  getStats(): Promise<CallStats>;
  /** The local mic/camera stream, for a self-view and the VAD analyser. */
  getLocalStream(): MediaStream | null;
  getScreenStream(): MediaStream | null;
  destroy(): void;
}
