/**
 * One simulated participant (PLAN.md §15.3).
 *
 * This is the piece that makes the harness worth having: the `SyncController`
 * and the `ServerClock` below are the REAL classes, imported unmodified from
 * the app. Nothing is stubbed except the two things a browser would have
 * supplied — a player (`FakePlayer`) and a socket (a `Link`).
 *
 * ── WHY THE REAL ServerClock ────────────────────────────────────────────────
 * The offset estimator is where a clock-skew bug hides, and it hides *by sign*:
 * `serverNow = Date.now() + offset` is indistinguishable from
 * `Date.now() - offset` when every client's clock is already correct. So the
 * harness runs the genuine NTP-style estimator over a genuine round trip, and
 * `scheduler.setClockSkew()` moves a client's `Date.now()` out from under it.
 * A sign error then shows up as that client converging on a position two
 * skew-widths away from everybody else — loudly, and in the one test that
 * costs nothing to run.
 *
 * ── THE JOIN AND RECONNECT ORDER ────────────────────────────────────────────
 * Copied from `lib/socket/provider.tsx`, because the ORDER is the part with
 * bugs in it:
 *
 *     connect → clock.sync(8 on join / 4 on resume) → room:join → snapshot
 *             → applySnapshot(store first, then controller)
 *
 * The clock is synced BEFORE the snapshot on both paths, so no anchor is ever
 * applied while `clock.isReady` is false — an anchor read against an unsynced
 * clock resolves to the wrong position with total confidence (§8.7, §8.8).
 */
import {
  CLOCK_SAMPLES_JOIN,
  CLOCK_SAMPLES_RESYNC,
  CLOCK_SAMPLE_SPACING_MS,
  IDLE_ANCHOR,
  type ControlAck,
  type VideoAnchor,
  type VideoStateReason,
} from '@syncstudy/shared';
import type { Schemas } from '@syncstudy/shared';
import type { TypedClientSocket } from '@/lib/socket/client';
import { ServerClock } from '@/lib/sync/clock';
import { SyncController, joinStartPositionSec, type AnchorReason } from '@/lib/sync/controller';
import { FakePlayer } from '@/lib/sync/players/fake';
import type { Link } from './link';
import type { SimServer, VideoStatePayload } from './server';
import type { VirtualScheduler } from './scheduler';
import type { SimClientSpec } from './types';

/**
 * Mirrors `CONTROL_ACK_TIMEOUT_MS` in `lib/sync/provider.tsx`. A control whose
 * ack never comes back — the 2 % packet loss case — must resolve as a failure
 * the controller will NOT act on, rather than leaving an intent pending for the
 * rest of the session.
 */
const CONTROL_ACK_TIMEOUT_MS = 8_000;
/** `Schemas.VideoControl` caps positions at 24 hours, as the provider does. */
const MAX_POSITION_SEC = 86_400;

/** The §8.6 vocabulary is narrower than the wire's; copied from provider.tsx. */
const ANCHOR_REASON: Record<VideoStateReason, AnchorReason> = {
  control: 'control',
  heartbeat: 'heartbeat',
  // A wait-for-slow pause is a real authoritative change somebody's stall made
  // on everyone's behalf, so it lands with the urgency of a human pressing pause.
  auto_buffer: 'control',
  resync: 'resync',
  set_video: 'set_video',
};

/** The slice of a Socket.IO socket that `ServerClock` actually touches. */
interface PingSocket {
  readonly connected: boolean;
  emit(event: 'time:ping', payload: Schemas.TimePing, ack: (pong: Schemas.TimePong) => void): void;
}

function boundedPosition(positionSec: number): number {
  if (!Number.isFinite(positionSec)) return 0;
  return Number(Math.min(MAX_POSITION_SEC, Math.max(0, positionSec)).toFixed(3));
}

/** An ack the controller reads but will not act on. See CONTROL_ACK_TIMEOUT_MS. */
function unanswered(anchor: VideoAnchor): ControlAck {
  return { ok: false, anchor: { ...anchor, revision: -1 } };
}

export interface SimClientOptions {
  spec: SimClientSpec;
  scheduler: VirtualScheduler;
  server: SimServer;
  link: Link;
  videoRef: string;
  videoDurationSec: number;
  seekLatencyMs: number;
  rateError: number;
}

export class SimClient {
  readonly id: string;
  readonly spec: SimClientSpec;

  private readonly scheduler: VirtualScheduler;
  private readonly server: SimServer;
  private readonly link: Link;
  private readonly player: FakePlayer;
  private readonly clock: ServerClock;
  private readonly videoRef: string;

  private controller: SyncController | null = null;
  /** This client's copy of the room store's `video` slice. */
  private anchor: VideoAnchor = { ...IDLE_ANCHOR };
  private joinedOnce = false;
  private disposed = false;

  // ── recorded outcomes ─────────────────────────────────────────────────────
  /** Monotonic ms at which the drift loop started; null until it does. */
  startedAtMono: number | null = null;
  hardSeeks = 0;
  lastTelemetryMono: number | null = null;
  reportedDriftP95 = 0;
  reportedClockOffsetMs = 0;
  controlsSent = 0;
  controlsAccepted = 0;
  controlsRejected = 0;
  bufferingReports = 0;
  seeksIssued = 0;

  constructor(opts: SimClientOptions) {
    this.spec = opts.spec;
    this.id = opts.spec.id;
    this.scheduler = opts.scheduler;
    this.server = opts.server;
    this.link = opts.link;
    this.videoRef = opts.videoRef;

    this.player = new FakePlayer({
      durationSec: opts.videoDurationSec,
      seekLatencyMs: opts.seekLatencyMs,
      rateError: opts.rateError,
      stalls: (opts.spec.stalls ?? []).map((s) => ({ atSec: s.atVideoSec, forSec: s.forSec })),
      // The same monotonic clock the controller gets, so the player's post-seek
      // blind window and the loop's `suppressUntilMono` live on one timebase.
      now: () => this.scheduler.now(),
    });

    // Wrapped rather than mocked: the real implementation still runs, and the
    // count is diagnostics only — the harness NEVER infers "hard seek" from a
    // seek it watched, because it cannot tell the four kinds apart from outside.
    const realSeek = this.player.seek.bind(this.player);
    this.player.seek = (sec: number, allowSeekAhead?: boolean): Promise<void> => {
      this.seeksIssued += 1;
      return realSeek(sec, allowSeekAhead);
    };

    const pingSocket: PingSocket = {
      get connected(): boolean {
        return opts.link.up;
      },
      emit: (event, payload, ack): void => {
        // The only event that rides this socket. Everything else the room sends
        // has its own path through `Link`, because it needs the server's state.
        if (event !== 'time:ping') return;
        this.link.toServer(() => {
          const pong = this.server.ping(payload.t0);
          this.link.toClient(() => ack(pong));
        });
      },
    };
    // The cast is the price of not asking production code to accept an injected
    // transport: `ServerClock` reads exactly `connected` and `emit('time:ping')`,
    // and a structural match on the full Socket.IO type is not worth 200 lines
    // of stub. Same trade the scheduler makes with the timer globals.
    this.clock = new ServerClock(pingSocket as unknown as TypedClientSocket);

    this.server.subscribe(this.id, (payload) => {
      this.link.toClient(() => {
        this.onVideoState(payload);
      });
    });
  }

  // ── the sim drives these ──────────────────────────────────────────────────

  /** True once the loop is running, i.e. once this client is in the room. */
  get isJoined(): boolean {
    return this.controller !== null;
  }

  get positionSec(): number {
    return this.player.getPosition();
  }

  tickPlayer(deltaMs: number): void {
    this.player.tick(deltaMs);
  }

  /** Bring the wire up and run the §8.7 join (or the §8.8 resume). */
  connect(): void {
    if (this.disposed || this.link.up) return;
    this.link.setUp(true);
    this.controller?.setTransportConnected(true);

    const resuming = this.joinedOnce;
    void this.clock
      .sync(resuming ? CLOCK_SAMPLES_RESYNC : CLOCK_SAMPLES_JOIN, CLOCK_SAMPLE_SPACING_MS)
      .then(
        () => {
          if (this.disposed || !this.link.up) return;
          this.clock.startSchedule(() => undefined);
          this.requestSnapshot();
        },
        () => undefined,
      );
  }

  /** §8.8: keep playing, stop correcting, drop whatever was in flight. */
  disconnect(): void {
    if (!this.link.up) return;
    this.link.setUp(false);
    this.controller?.setTransportConnected(false);
    this.server.forgetClient(this.id);
  }

  /** A scripted user action. Runs through the controller's real intent path. */
  act(action: 'play' | 'pause' | 'seek', to?: number): boolean {
    const controller = this.controller;
    if (controller === null) return false;
    if (action === 'play') void controller.play();
    else if (action === 'pause') void controller.pause();
    else if (to !== undefined) void controller.seek(to);
    else return false;
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controller?.stop();
    this.clock.stopSchedule();
    this.player.destroy();
  }

  // ── transport plumbing ────────────────────────────────────────────────────

  private requestSnapshot(): void {
    this.link.toServer(() => {
      const snapshot = this.server.snapshot();
      this.link.toClient(() => {
        this.applySnapshot(snapshot.video);
      });
    });
  }

  /**
   * The store first, then the controller — the controller reads the anchor back
   * out of the store on every tick, so telling it about an anchor the store has
   * not accepted yet would have it converge on the previous one.
   */
  private applySnapshot(video: VideoAnchor): void {
    // A snapshot IS the truth, so it bypasses the monotonic-revision guard.
    this.anchor = video;
    if (this.controller === null) {
      this.startLoop(video);
      return;
    }
    this.controller.applyAnchor(video, 'snapshot');
  }

  private onVideoState(payload: VideoStatePayload): void {
    this.setVideo(payload.anchor);
    this.controller?.applyAnchor(payload.anchor, ANCHOR_REASON[payload.reason] ?? 'control');
  }

  /** §8.5b: an out-of-order or duplicated delivery must not rewind the anchor. */
  private setVideo(anchor: VideoAnchor): void {
    if (anchor.revision < this.anchor.revision) return;
    this.anchor = anchor;
  }

  /**
   * §8.7 steps 4–6, in the order the room does them: the component builds the
   * player already cued at the room's position (aiming `JOIN_LOAD_LEAD_SEC`
   * ahead when the room is playing), tells the controller what is loaded, and
   * only then does the loop start and run its autoplay gate.
   */
  private startLoop(video: VideoAnchor): void {
    this.joinedOnce = true;
    const startAt = joinStartPositionSec(video, this.clock.now());
    // `autoplay: false` matches `createPlayer`: the §8.7 gate owns starting
    // playback, because that is where the muted-autoplay fallback lives.
    void this.player.load(this.videoRef, startAt, false);

    const controller = new SyncController({
      player: this.player,
      clock: this.clock,
      getAnchor: () => this.anchor,
      canControl: () => this.spec.canControl !== false,
      sendControl: (cmd) => this.sendControl(cmd),
      // The position rides along on the real wire; the server only needs to know
      // WHO is stalled, so the harness takes the flag alone.
      reportBuffering: (buffering) => {
        this.bufferingReports += 1;
        this.link.toServer(() => {
          this.server.handleBuffering(this.id, buffering);
        });
      },
      reportDrift: (report) => {
        // §16.5's channel, and the only honest source for the hard-seek metric:
        // `hardSeeks` here is the controller's own counter, not something the
        // harness guessed by watching seeks go past.
        this.hardSeeks += report.hardSeeks;
        this.reportedDriftP95 = report.driftP95;
        this.reportedClockOffsetMs = report.clockOffsetMs;
        this.lastTelemetryMono = this.scheduler.now();
      },
      onStatus: () => undefined,
      now: () => this.scheduler.now(),
    });

    controller.noteLoadedVideo(this.videoRef);
    controller.setTransportConnected(this.link.up);
    this.controller = controller;
    this.startedAtMono = this.scheduler.now();
    controller.start();
  }

  /**
   * `video:control`, stamped exactly as `SyncProvider` stamps it (§8.4):
   * `clientSentAtMs` in SERVER time so the server can compensate for the flight,
   * and `expectedRevision` read at the instant of the emit so two people
   * scrubbing at once cannot both apply against the same base state (§8.5b).
   */
  private sendControl(
    cmd: Omit<Schemas.VideoControl, 'clientSentAtMs' | 'expectedRevision'>,
  ): Promise<ControlAck> {
    const anchor = this.anchor;
    if (!this.link.up) return Promise.resolve(unanswered(anchor));

    this.controlsSent += 1;
    const wire: Schemas.VideoControl = {
      action: cmd.action,
      ...(cmd.positionSec === undefined ? {} : { positionSec: boundedPosition(cmd.positionSec) }),
      ...(cmd.rate === undefined ? {} : { rate: cmd.rate }),
      clientSentAtMs: Math.round(this.clock.now()),
      expectedRevision: anchor.revision,
    };

    return new Promise<ControlAck>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(unanswered(anchor));
      }, CONTROL_ACK_TIMEOUT_MS);

      this.link.toServer(() => {
        const ack = this.server.handleControl(this.id, wire, this.spec.canControl !== false);
        this.link.toClient(() => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (ack.ok) this.controlsAccepted += 1;
          else this.controlsRejected += 1;
          // The provider reconciles the STORE here and lets the controller
          // reconcile the PLAYER from the ack it returns.
          this.setVideo(ack.anchor);
          resolve(ack);
        });
      });
    });
  }
}
