'use client';

/**
 * Full-mesh P2P calling (PLAN.md §9.1–§9.6).
 *
 * One `RTCPeerConnection` per peer, signaling over the room's already
 * authenticated socket. Four things in here are load-bearing and each has a
 * failure mode that is silent if you get it wrong:
 *
 *  1. **Perfect negotiation** (§9.2), implemented exactly as the W3C example.
 *     Without it, two peers renegotiating in the same moment — both switching a
 *     camera on — hit `InvalidStateError` and the call dies with no error the
 *     user can see. Politeness is derived from the user ids both sides already
 *     hold, so there is no round trip and no glare.
 *  2. **The impolite peer offers.** Deterministic and mutual, so exactly one
 *     side initiates and the mesh never doubles its ICE work.
 *  3. **The bandwidth work in §9.4 is not optional.** Browsers default video far
 *     too high for a mesh; the caps, the resolution scaling and the Opus munge
 *     together roughly halve what a student's uplink has to carry.
 *  4. **Teardown is driven by signaling, not by ICE.** `rtc:peer_left` arrives
 *     in about five seconds; an ICE timeout takes thirty (§9.5).
 */
import {
  AUDIO_MAX_BITRATE,
  SCREEN_MAX_BITRATE,
  VIDEO_MAX_BITRATE,
  type IceServerConfig,
  type Schemas,
} from '@syncstudy/shared';
import type { TypedClientSocket } from '@/lib/socket/client';
import { getCamera, getMicrophone, getScreen, MediaError } from './media';
import { mungeOpus } from './sdp';
import {
  INITIAL_PEER_STATE,
  type CallStats,
  type CallTransport,
  type CallTransportEvents,
  type ConnectionQuality,
  type JoinOptions,
  type JoinResult,
  type PeerState,
  type TrackKind,
} from './types';

/** §9.5: `disconnected` usually self-heals; give it this long before restarting ICE. */
const DISCONNECTED_GRACE_MS = 4_000;
/** How often `getStats()` is polled for the quality indicator (§9.5). */
const STATS_INTERVAL_MS = 3_000;
/** §9.5: two ICE restarts, then a full teardown and re-negotiate. */
const MAX_ICE_RESTARTS = 2;
/** After this long muted, stop sending entirely rather than sending silence. */
const MUTE_REPLACE_TRACK_AFTER_MS = 10_000;
/** Above this inbound loss, back the matching sender off by 30% (§9.5). */
const LOSS_BACKOFF_THRESHOLD = 0.05;
const LOSS_BACKOFF_FACTOR = 0.7;
/** Never let congestion control starve a voice call into unintelligibility. */
const MIN_AUDIO_BITRATE = 12_000;

type SignalPayload = Schemas.RtcSignal;

interface Peer {
  userId: string;
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  settingRemoteAnswerPending: boolean;
  state: PeerState;
  micSender: RTCRtpSender | null;
  cameraSender: RTCRtpSender | null;
  screenSender: RTCRtpSender | null;
  iceRestarts: number;
  disconnectedTimer: ReturnType<typeof setTimeout> | null;
  /** mid → what that track actually is, learned from `track_map` (§9.6). */
  midKind: Map<string, TrackKind>;
  /** mid → the track we handed upward, and the kind we claimed it was. */
  reported: Map<string, { track: MediaStreamTrack; kind: TrackKind }>;
  /** Last stats sample, for deriving bitrate and loss deltas. */
  lastStats: { at: number; bytesSent: number; bytesReceived: number; lost: number; received: number } | null;
  audioBitrateCap: number;
}

export interface MeshTransportOptions {
  socket: TypedClientSocket;
  selfUserId: string;
  events: CallTransportEvents;
  /**
   * §11.5 / the `hide_ip_from_peers` setting: force every candidate through
   * TURN so a peer never learns this user's address. Forced on for minors.
   */
  relayOnly?: boolean;
}

export class MeshTransport implements CallTransport {
  private readonly socket: TypedClientSocket;
  private readonly selfUserId: string;
  private readonly events: CallTransportEvents;
  private readonly relayOnly: boolean;

  private readonly peers = new Map<string, Peer>();
  private iceServers: IceServerConfig[] = [];
  private localStream: MediaStream | null = null;
  private screenStream: MediaStream | null = null;
  private micEnabled = false;
  private cameraEnabled = false;
  private joined = false;
  private destroyed = false;

  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private muteReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  private iceRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly detach: Array<() => void> = [];

  constructor(opts: MeshTransportOptions) {
    this.socket = opts.socket;
    this.selfUserId = opts.selfUserId;
    this.events = opts.events;
    this.relayOnly = opts.relayOnly === true;
    this.listen();
  }

  // ── socket wiring ─────────────────────────────────────────────────────────

  private listen(): void {
    const onPeerJoined = ({ userId, polite }: { userId: string; polite: boolean }): void => {
      if (!this.joined || userId === this.selfUserId) return;
      const peer = this.ensurePeer(userId, polite);
      // §9.2: the impolite side creates the offer, so exactly one of the two
      // starts and there is no glare to resolve in the common case.
      if (!peer.polite) void this.negotiate(peer);
    };

    const onPeerLeft = ({ userId }: { userId: string }): void => {
      this.closePeer(userId);
    };

    const onSignal = (payload: SignalPayload & { from: string }): void => {
      if (!this.joined) return;
      void this.handleSignal(payload).catch((err: unknown) => {
        // A malformed or out-of-order signal must cost one peer, never the call.
        this.warn(`Signal from ${payload.from} failed`, err);
      });
    };

    this.socket.on('rtc:peer_joined', onPeerJoined);
    this.socket.on('rtc:peer_left', onPeerLeft);
    this.socket.on('rtc:signal', onSignal);

    this.detach.push(() => {
      this.socket.off('rtc:peer_joined', onPeerJoined);
      this.socket.off('rtc:peer_left', onPeerLeft);
      this.socket.off('rtc:signal', onSignal);
    });
  }

  private send(signal: SignalPayload): void {
    if (!this.socket.connected) return;
    this.socket.emit('rtc:signal', signal, () => undefined);
  }

  // ── join / leave ──────────────────────────────────────────────────────────

  async join(opts: JoinOptions): Promise<JoinResult> {
    if (this.destroyed) return { ok: false, reason: 'transport_error' };

    // Media BEFORE signaling. Announcing yourself in the call and then failing
    // to find a microphone leaves everyone else opening a peer connection to
    // somebody who is not there.
    try {
      this.localStream = await getMicrophone();
      this.micEnabled = opts.audio;
      for (const track of this.localStream.getAudioTracks()) {
        track.enabled = opts.audio;
        track.contentHint = 'speech';
      }
    } catch (err) {
      const reason = err instanceof MediaError ? err.reason : 'transport_error';
      if (err instanceof MediaError) this.events.onNotice('warn', err.message);
      return { ok: false, reason };
    }

    const joinAck = await this.emitJoin(opts);
    if (!joinAck.ok) {
      this.stopLocalMedia();
      return { ok: false, reason: joinAck.reason ?? 'transport_error' };
    }

    this.joined = true;
    this.iceServers = joinAck.iceServers ?? [];
    this.scheduleIceRefresh(joinAck.ttlSec ?? 600);
    this.events.onLocalTrack('mic', this.localStream.getAudioTracks()[0] ?? null);

    if (opts.video) {
      // Requested and granted by the server; if the camera itself refuses we
      // continue audio-only rather than failing the join.
      await this.setCameraEnabled(true).catch(() => undefined);
    }

    for (const summary of joinAck.peers ?? []) {
      const peer = this.ensurePeer(summary.userId, summary.polite);
      if (!peer.polite) void this.negotiate(peer);
    }

    this.startStatsLoop();
    const downgraded = opts.video && !this.cameraEnabled;
    return downgraded ? { ok: true, videoDowngraded: true } : { ok: true };
  }

  private emitJoin(opts: JoinOptions): Promise<{
    ok: boolean;
    reason?: JoinResult['reason'];
    iceServers?: IceServerConfig[];
    ttlSec?: number;
    peers?: { userId: string; polite: boolean; audio: boolean; video: boolean; sharing: boolean }[];
  }> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, reason: 'transport_error' });
      }, 8_000);

      this.socket.emit('rtc:join', { audio: opts.audio, video: opts.video }, (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      });
    });
  }

  async leave(): Promise<void> {
    if (!this.joined) return;
    this.joined = false;

    await this.stopScreenShare().catch(() => undefined);
    for (const userId of [...this.peers.keys()]) this.closePeer(userId);
    this.stopLocalMedia();
    this.stopStatsLoop();
    if (this.iceRefreshTimer !== null) clearTimeout(this.iceRefreshTimer);
    this.iceRefreshTimer = null;

    await new Promise<void>((resolve) => {
      if (!this.socket.connected) return resolve();
      const timer = setTimeout(resolve, 3_000);
      this.socket.emit('rtc:leave', {}, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    void this.leave().catch(() => undefined);
    for (const off of this.detach) off();
    this.detach.length = 0;
  }

  // ── peers ─────────────────────────────────────────────────────────────────

  private ensurePeer(userId: string, polite: boolean): Peer {
    const existing = this.peers.get(userId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({
      iceServers: this.iceServers as RTCIceServer[],
      // §11.5: relay-only never exposes a host candidate, so a peer cannot
      // learn this user's address from the SDP.
      ...(this.relayOnly ? { iceTransportPolicy: 'relay' as const } : {}),
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    });

    const peer: Peer = {
      userId,
      pc,
      polite,
      makingOffer: false,
      ignoreOffer: false,
      settingRemoteAnswerPending: false,
      state: { ...INITIAL_PEER_STATE },
      micSender: null,
      cameraSender: null,
      screenSender: null,
      iceRestarts: 0,
      disconnectedTimer: null,
      midKind: new Map(),
      reported: new Map(),
      lastStats: null,
      audioBitrateCap: AUDIO_MAX_BITRATE,
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate === null) return;
      this.send({ to: userId, kind: 'candidate', candidate: candidate.toJSON() });
    };

    pc.ontrack = ({ track, transceiver }) => {
      const mid = transceiver.mid ?? `pending:${track.id}`;
      const kind = peer.midKind.get(mid) ?? (track.kind === 'audio' ? 'mic' : 'camera');
      peer.reported.set(mid, { track, kind });
      this.events.onRemoteTrack(userId, track, kind);
      track.onended = () => {
        peer.reported.delete(mid);
        this.events.onRemoteTrack(userId, null, kind);
      };
    };

    pc.onnegotiationneeded = () => {
      void this.negotiate(peer);
    };

    pc.onconnectionstatechange = () => {
      this.onConnectionStateChange(peer);
    };

    pc.oniceconnectionstatechange = () => {
      // Safari reports useful transitions here that it does not report on
      // `connectionState`; §9.5 says track both and trust the former.
      if (pc.iceConnectionState === 'failed') this.onConnectionStateChange(peer);
    };

    this.peers.set(userId, peer);
    this.attachLocalTracks(peer);
    this.applyScaling();
    this.publishPeerState(peer, { connection: 'connecting' });
    return peer;
  }

  private closePeer(userId: string): void {
    const peer = this.peers.get(userId);
    if (!peer) return;
    if (peer.disconnectedTimer !== null) clearTimeout(peer.disconnectedTimer);
    for (const [, entry] of peer.reported) {
      this.events.onRemoteTrack(userId, null, entry.kind);
    }
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onnegotiationneeded = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.oniceconnectionstatechange = null;
    try {
      peer.pc.close();
    } catch {
      // Already closed; nothing to do.
    }
    this.peers.delete(userId);
    this.publishPeerState(peer, { connection: 'closed' });
    this.applyScaling();
  }

  // ── perfect negotiation (§9.2) ────────────────────────────────────────────

  private async negotiate(peer: Peer): Promise<void> {
    if (!this.joined || peer.pc.signalingState === 'closed') return;
    try {
      peer.makingOffer = true;
      // No argument: `setLocalDescription()` with none creates the right
      // description for the current signaling state, which is precisely the
      // property that makes the perfect-negotiation example correct.
      await peer.pc.setLocalDescription();
      const description = peer.pc.localDescription;
      if (description === null) return;
      this.send({ to: peer.userId, kind: 'offer', sdp: mungeOpus(description.sdp) });
      this.sendTrackMap(peer);
    } catch (err) {
      this.warn('negotiation failed', err);
    } finally {
      peer.makingOffer = false;
    }
  }

  private async handleSignal(payload: SignalPayload & { from: string }): Promise<void> {
    if (payload.kind === 'track_map') {
      const peer = this.peers.get(payload.from);
      if (!peer) return;
      for (const [mid, kind] of Object.entries(payload.trackMap ?? {})) {
        peer.midKind.set(mid, kind);
        const reported = peer.reported.get(mid);
        // A track can arrive before the map that explains it: `ontrack` fires
        // during `setRemoteDescription`, and the map is the next message on the
        // wire. Re-announce under the correct kind rather than leaving a screen
        // share rendered as somebody's webcam.
        if (reported !== undefined && reported.kind !== kind) {
          this.events.onRemoteTrack(payload.from, null, reported.kind);
          peer.reported.set(mid, { track: reported.track, kind });
          this.events.onRemoteTrack(payload.from, reported.track, kind);
        }
      }
      return;
    }

    // A signal from someone we have not met yet is a legitimate race: their
    // `rtc:peer_joined` and their offer can cross. Politeness is computable
    // from the ids alone, so we can create the peer right here.
    const peer = this.peers.get(payload.from) ?? this.ensurePeer(payload.from, this.selfUserId < payload.from);

    if (payload.kind === 'candidate') {
      const candidate = payload.candidate as RTCIceCandidateInit | null | undefined;
      if (candidate === undefined || candidate === null) return;
      try {
        await peer.pc.addIceCandidate(candidate);
      } catch (err) {
        // Expected when we deliberately ignored the offer these candidates
        // belong to. Anything else is worth a line in the console.
        if (!peer.ignoreOffer) this.warn('addIceCandidate failed', err);
      }
      return;
    }

    const description: RTCSessionDescriptionInit = {
      type: payload.kind === 'offer' ? 'offer' : 'answer',
      sdp: payload.sdp ?? '',
    };

    const readyForOffer =
      !peer.makingOffer && (peer.pc.signalingState === 'stable' || peer.settingRemoteAnswerPending);
    const offerCollision = description.type === 'offer' && !readyForOffer;

    peer.ignoreOffer = !peer.polite && offerCollision;
    if (peer.ignoreOffer) return;

    peer.settingRemoteAnswerPending = description.type === 'answer';
    await peer.pc.setRemoteDescription(description);
    peer.settingRemoteAnswerPending = false;

    if (description.type !== 'offer') return;

    await peer.pc.setLocalDescription();
    const answer = peer.pc.localDescription;
    if (answer === null) return;
    this.send({ to: peer.userId, kind: 'answer', sdp: mungeOpus(answer.sdp) });
    this.sendTrackMap(peer);
  }

  /**
   * Tell the peer which transceiver carries what (§9.6).
   *
   * Screen share is a second video transceiver on the SAME peer connection —
   * never a second connection, which would double the ICE work and the TURN
   * allocations — so `mid` is the only thing that distinguishes it from a
   * camera.
   */
  private sendTrackMap(peer: Peer): void {
    const map: Record<string, TrackKind> = {};
    for (const transceiver of peer.pc.getTransceivers()) {
      const mid = transceiver.mid;
      const track = transceiver.sender.track;
      if (mid === null || track === null) continue;
      if (track.kind === 'audio') {
        map[mid] = this.screenStream?.getAudioTracks().includes(track) === true ? 'screen_audio' : 'mic';
      } else {
        map[mid] = peer.screenSender?.track === track ? 'screen' : 'camera';
      }
    }
    if (Object.keys(map).length === 0) return;
    this.send({ to: peer.userId, kind: 'track_map', trackMap: map });
  }

  // ── local media ───────────────────────────────────────────────────────────

  private attachLocalTracks(peer: Peer): void {
    const mic = this.localStream?.getAudioTracks()[0] ?? null;
    if (mic !== null && peer.micSender === null) {
      peer.micSender = peer.pc.addTrack(mic, this.localStream as MediaStream);
      void this.applySenderParams(peer, peer.micSender, 'mic');
    }
    const camera = this.localStream?.getVideoTracks()[0] ?? null;
    if (camera !== null && peer.cameraSender === null) {
      peer.cameraSender = peer.pc.addTrack(camera, this.localStream as MediaStream);
      void this.applySenderParams(peer, peer.cameraSender, 'camera');
    }
    const screen = this.screenStream?.getVideoTracks()[0] ?? null;
    if (screen !== null && peer.screenSender === null) {
      peer.screenSender = peer.pc.addTrack(screen, this.screenStream as MediaStream);
      void this.applySenderParams(peer, peer.screenSender, 'screen');
    }
  }

  /**
   * §9.4 item 1. Browsers pick video bitrates for a one-to-one call; in a mesh
   * every one of those is multiplied by N−1 on a student's uplink.
   */
  private async applySenderParams(peer: Peer, sender: RTCRtpSender, kind: TrackKind): Promise<void> {
    try {
      const params = sender.getParameters();
      // Chrome requires at least one encoding object to exist before it will
      // accept `setParameters`, and an empty array is the state right after
      // `addTrack` on some versions.
      const encodings = params.encodings?.length ? params.encodings : [{}];
      const first = encodings[0];
      if (first === undefined) return;

      if (kind === 'mic' || kind === 'screen_audio') {
        first.maxBitrate = peer.audioBitrateCap;
      } else if (kind === 'screen') {
        first.maxBitrate = SCREEN_MAX_BITRATE;
        first.maxFramerate = 5;
      } else {
        first.maxBitrate = VIDEO_MAX_BITRATE;
        first.maxFramerate = 24;
        first.scaleResolutionDownBy = this.scaleFactor();
      }

      await sender.setParameters({ ...params, encodings });
    } catch (err) {
      // Not fatal: the call works at the browser's defaults, it just costs more.
      this.warn('setParameters failed', err);
    }
  }

  /** §9.4 item 2: 2 peers → full, 3 → half-ish, 4+ → quarter. */
  private scaleFactor(): number {
    const mesh = this.peers.size + 1;
    if (mesh <= 2) return 1;
    if (mesh === 3) return 1.5;
    return 2;
  }

  /** Recompute video scaling whenever the mesh grows or shrinks (§9.5). */
  private applyScaling(): void {
    for (const peer of this.peers.values()) {
      if (peer.cameraSender !== null) void this.applySenderParams(peer, peer.cameraSender, 'camera');
    }
  }

  async setMicEnabled(on: boolean): Promise<void> {
    this.micEnabled = on;
    const track = this.localStream?.getAudioTracks()[0];

    if (this.muteReleaseTimer !== null) {
      clearTimeout(this.muteReleaseTimer);
      this.muteReleaseTimer = null;
    }

    if (on) {
      if (track !== undefined) track.enabled = true;
      // We may have replaced the sender's track with null while muted; put it
      // back before the next word is spoken rather than after it.
      const restored = this.localStream?.getAudioTracks()[0] ?? null;
      if (restored !== null) {
        for (const peer of this.peers.values()) {
          if (peer.micSender !== null && peer.micSender.track === null) {
            await peer.micSender.replaceTrack(restored).catch(() => undefined);
          }
        }
      }
      return;
    }

    if (track !== undefined) track.enabled = false;
    // §14 Phase 6.6: `enabled = false` still sends comfort noise packets. After
    // ten seconds of being muted, stop sending altogether — in a six-person room
    // where five people are quiet, that is most of the audio bandwidth.
    this.muteReleaseTimer = setTimeout(() => {
      this.muteReleaseTimer = null;
      if (this.micEnabled) return;
      for (const peer of this.peers.values()) {
        void peer.micSender?.replaceTrack(null).catch(() => undefined);
      }
    }, MUTE_REPLACE_TRACK_AFTER_MS);
  }

  async setCameraEnabled(on: boolean): Promise<void> {
    if (on === this.cameraEnabled) return;

    if (!on) {
      const existing = this.localStream?.getVideoTracks() ?? [];
      for (const track of existing) {
        track.stop();
        this.localStream?.removeTrack(track);
      }
      for (const peer of this.peers.values()) {
        if (peer.cameraSender === null) continue;
        await peer.cameraSender.replaceTrack(null).catch(() => undefined);
      }
      this.cameraEnabled = false;
      this.events.onLocalTrack('camera', null);
      return;
    }

    let camera: MediaStreamTrack;
    try {
      const stream = await getCamera();
      const track = stream.getVideoTracks()[0];
      if (track === undefined) throw new MediaError({ reason: 'no_device', message: 'No camera found.' });
      camera = track;
    } catch (err) {
      if (err instanceof MediaError) this.events.onNotice('warn', err.message);
      this.cameraEnabled = false;
      return;
    }

    this.localStream?.addTrack(camera);
    camera.onended = () => {
      void this.setCameraEnabled(false);
    };

    for (const peer of this.peers.values()) {
      if (peer.cameraSender !== null) {
        await peer.cameraSender.replaceTrack(camera).catch(() => undefined);
      } else if (this.localStream !== null) {
        peer.cameraSender = peer.pc.addTrack(camera, this.localStream);
      }
      if (peer.cameraSender !== null) await this.applySenderParams(peer, peer.cameraSender, 'camera');
    }

    this.cameraEnabled = true;
    this.events.onLocalTrack('camera', camera);
  }

  // ── screen share (§9.6) ───────────────────────────────────────────────────

  async startScreenShare(): Promise<boolean> {
    if (this.screenStream !== null) return true;

    // Claim the single-holder lock BEFORE opening the picker: two people racing
    // should see one refusal, not two screen-picker dialogs and then a refusal.
    const claimed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5_000);
      this.socket.emit('rtc:screenshare_claim', {}, (ack) => {
        clearTimeout(timer);
        if (!ack.ok) this.events.onNotice('warn', ack.message);
        resolve(ack.ok);
      });
    });
    if (!claimed) return false;

    let stream: MediaStream;
    try {
      stream = await getScreen();
    } catch (err) {
      this.socket.emit('rtc:screenshare_release', {}, () => undefined);
      if (err instanceof MediaError && err.message !== 'Screen sharing was cancelled.') {
        this.events.onNotice('warn', err.message);
      }
      return false;
    }

    this.screenStream = stream;
    // §9.6: the sharer's own camera is paused while sharing rather than silently
    // degrading — three simultaneous 1.2 Mbps uploads is already the ceiling.
    if (this.cameraEnabled) await this.setCameraEnabled(false);

    const video = stream.getVideoTracks()[0];
    if (video !== undefined) {
      video.onended = () => {
        // The browser's own "Stop sharing" bar, which is where most people stop.
        void this.stopScreenShare();
      };
      for (const peer of this.peers.values()) {
        peer.screenSender = peer.pc.addTrack(video, stream);
        await this.applySenderParams(peer, peer.screenSender, 'screen');
      }
    }
    this.events.onLocalTrack('screen', video ?? null);
    return true;
  }

  async stopScreenShare(): Promise<void> {
    const stream = this.screenStream;
    if (stream === null) return;
    this.screenStream = null;

    for (const peer of this.peers.values()) {
      if (peer.screenSender === null) continue;
      try {
        peer.pc.removeTrack(peer.screenSender);
      } catch {
        // The connection may already be closed.
      }
      peer.screenSender = null;
    }
    for (const track of stream.getTracks()) track.stop();
    this.events.onLocalTrack('screen', null);

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3_000);
      this.socket.emit('rtc:screenshare_release', {}, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // ── connection lifecycle (§9.5) ───────────────────────────────────────────

  private onConnectionStateChange(peer: Peer): void {
    const state = peer.pc.connectionState;

    if (peer.disconnectedTimer !== null) {
      clearTimeout(peer.disconnectedTimer);
      peer.disconnectedTimer = null;
    }

    switch (state) {
      case 'connected':
        peer.iceRestarts = 0;
        this.publishPeerState(peer, { connection: 'connected' });
        return;

      case 'connecting':
      case 'new':
        this.publishPeerState(peer, { connection: 'connecting' });
        return;

      case 'disconnected':
        // Often self-heals: a Wi-Fi handover, a NAT rebinding. Give it four
        // seconds before doing anything that costs a renegotiation.
        this.publishPeerState(peer, { connection: 'reconnecting' });
        peer.disconnectedTimer = setTimeout(() => {
          peer.disconnectedTimer = null;
          if (peer.pc.connectionState === 'disconnected') this.escalate(peer);
        }, DISCONNECTED_GRACE_MS);
        return;

      case 'failed':
        this.publishPeerState(peer, { connection: 'reconnecting' });
        this.escalate(peer);
        return;

      case 'closed':
        this.publishPeerState(peer, { connection: 'closed' });
        return;
    }
  }

  /** The §9.5 ladder: restart ICE twice, then rebuild the peer connection. */
  private escalate(peer: Peer): void {
    if (!this.joined) return;

    if (peer.iceRestarts < MAX_ICE_RESTARTS) {
      peer.iceRestarts += 1;
      try {
        peer.pc.restartIce();
      } catch (err) {
        this.warn('restartIce failed', err);
      }
      // Only the impolite side re-offers, so a mutual restart does not collide.
      if (!peer.polite) void this.negotiate(peer);
      return;
    }

    this.publishPeerState(peer, { connection: 'failed' });
    this.events.onNotice(
      'warn',
      "Can't connect to one of the people in the call — they or you may need to refresh.",
    );
    const { userId, polite } = peer;
    this.closePeer(userId);
    // The retry is TURN-only: a pair that has failed twice on direct candidates
    // is almost always a symmetric-NAT pair, and relay is the answer (§9.3).
    const rebuilt = this.ensurePeerRelayOnly(userId, polite);
    if (!rebuilt.polite) void this.negotiate(rebuilt);
  }

  private ensurePeerRelayOnly(userId: string, polite: boolean): Peer {
    const peer = this.ensurePeer(userId, polite);
    try {
      peer.pc.setConfiguration({
        iceServers: this.iceServers as RTCIceServer[],
        iceTransportPolicy: 'relay',
      });
    } catch {
      // Firefox has historically refused `setConfiguration` mid-life. The plain
      // rebuild is still a real second chance.
    }
    return peer;
  }

  private publishPeerState(peer: Peer, patch: Partial<PeerState>): void {
    const next: PeerState = { ...peer.state, ...patch };
    if (
      next.connection === peer.state.connection &&
      next.quality === peer.state.quality &&
      next.rttMs === peer.state.rttMs &&
      next.relayed === peer.state.relayed &&
      Math.abs(next.packetLoss - peer.state.packetLoss) < 0.01
    ) {
      return;
    }
    peer.state = next;
    this.events.onPeerState(peer.userId, next);
  }

  // ── stats & congestion response (§9.5) ────────────────────────────────────

  private startStatsLoop(): void {
    if (this.statsTimer !== null) return;
    this.statsTimer = setInterval(() => {
      void this.sampleStats().catch(() => undefined);
    }, STATS_INTERVAL_MS);
  }

  private stopStatsLoop(): void {
    if (this.statsTimer === null) return;
    clearInterval(this.statsTimer);
    this.statsTimer = null;
  }

  private async sampleStats(): Promise<void> {
    const now = Date.now();
    for (const peer of this.peers.values()) {
      if (peer.pc.connectionState === 'closed') continue;
      let bytesSent = 0;
      let bytesReceived = 0;
      let lost = 0;
      let received = 0;
      let rttMs: number | null = null;
      let relayed = false;

      const report = await peer.pc.getStats().catch(() => null);
      if (report === null) continue;

      report.forEach((stat) => {
        const entry = stat as Record<string, unknown> & { type: string };
        if (entry.type === 'outbound-rtp') bytesSent += Number(entry['bytesSent'] ?? 0);
        if (entry.type === 'inbound-rtp') {
          bytesReceived += Number(entry['bytesReceived'] ?? 0);
          lost += Number(entry['packetsLost'] ?? 0);
          received += Number(entry['packetsReceived'] ?? 0);
        }
        if (entry.type === 'candidate-pair' && entry['state'] === 'succeeded' && entry['nominated'] === true) {
          const rtt = Number(entry['currentRoundTripTime'] ?? NaN);
          if (Number.isFinite(rtt)) rttMs = Math.round(rtt * 1000);
        }
        if (entry.type === 'local-candidate' && entry['candidateType'] === 'relay') relayed = true;
      });

      const previous = peer.lastStats;
      peer.lastStats = { at: now, bytesSent, bytesReceived, lost, received };
      if (previous === null) continue;

      const windowPackets = received - previous.received;
      const windowLost = lost - previous.lost;
      const loss =
        windowPackets + windowLost > 0 ? Math.max(0, windowLost) / (windowPackets + windowLost) : 0;

      this.publishPeerState(peer, { rttMs, relayed, packetLoss: loss, quality: quality(rttMs, loss) });

      // §9.5's crude congestion response, on top of the browser's own: sustained
      // loss above 5% means back the sender off 30%, floored so a voice call
      // never degrades into unintelligibility chasing a lossy link.
      if (loss > LOSS_BACKOFF_THRESHOLD && peer.micSender !== null) {
        const next = Math.max(MIN_AUDIO_BITRATE, Math.round(peer.audioBitrateCap * LOSS_BACKOFF_FACTOR));
        if (next !== peer.audioBitrateCap) {
          peer.audioBitrateCap = next;
          void this.applySenderParams(peer, peer.micSender, 'mic');
        }
      } else if (loss < LOSS_BACKOFF_THRESHOLD / 2 && peer.audioBitrateCap < AUDIO_MAX_BITRATE) {
        peer.audioBitrateCap = Math.min(AUDIO_MAX_BITRATE, Math.round(peer.audioBitrateCap / LOSS_BACKOFF_FACTOR));
        if (peer.micSender !== null) void this.applySenderParams(peer, peer.micSender, 'mic');
      }
    }
  }

  async getStats(): Promise<CallStats> {
    let outbound = 0;
    let inbound = 0;
    let relayedPeers = 0;
    for (const peer of this.peers.values()) {
      if (peer.state.relayed) relayedPeers += 1;
      const sample = peer.lastStats;
      if (sample !== null) {
        outbound += sample.bytesSent;
        inbound += sample.bytesReceived;
      }
    }
    return { peers: this.peers.size, outboundBitrate: outbound * 8, inboundBitrate: inbound * 8, relayedPeers };
  }

  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  getScreenStream(): MediaStream | null {
    return this.screenStream;
  }

  // ── housekeeping ──────────────────────────────────────────────────────────

  /**
   * TURN credentials expire (§9.3). Refresh a minute before they do so an ICE
   * restart during a long call still has a working relay to fall back on.
   */
  private scheduleIceRefresh(ttlSec: number): void {
    if (this.iceRefreshTimer !== null) clearTimeout(this.iceRefreshTimer);
    const delay = Math.max(60_000, (ttlSec - 60) * 1000);
    this.iceRefreshTimer = setTimeout(() => {
      this.iceRefreshTimer = null;
      if (!this.joined || !this.socket.connected) return;
      this.socket.emit('rtc:ice_refresh', {}, (ack) => {
        if (!ack.ok || ack.data === undefined) return;
        this.iceServers = ack.data.iceServers;
        for (const peer of this.peers.values()) {
          try {
            peer.pc.setConfiguration({ iceServers: this.iceServers as RTCIceServer[] });
          } catch {
            // Not every browser allows this mid-call; the existing credentials
            // keep working for the connections that are already up.
          }
        }
        this.scheduleIceRefresh(ack.data.ttlSec);
      });
    }, delay);
  }

  private stopLocalMedia(): void {
    for (const track of this.localStream?.getTracks() ?? []) track.stop();
    this.localStream = null;
    this.cameraEnabled = false;
    this.micEnabled = false;
    if (this.muteReleaseTimer !== null) clearTimeout(this.muteReleaseTimer);
    this.muteReleaseTimer = null;
    this.events.onLocalTrack('mic', null);
    this.events.onLocalTrack('camera', null);
  }

  private warn(message: string, err?: unknown): void {
    if (process.env.NODE_ENV === 'production') return;
    // eslint-disable-next-line no-console -- developer-facing only, never in prod
    console.warn(`[mesh] ${message}`, err);
  }
}

/** Thresholds chosen so "good" really is the boring, ignorable steady state. */
function quality(rttMs: number | null, loss: number): ConnectionQuality {
  if (loss > 0.08 || (rttMs !== null && rttMs > 400)) return 'poor';
  if (loss > 0.03 || (rttMs !== null && rttMs > 200)) return 'fair';
  if (rttMs === null && loss === 0) return 'unknown';
  return 'good';
}
