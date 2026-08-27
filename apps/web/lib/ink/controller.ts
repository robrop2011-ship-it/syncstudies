'use client';

/**
 * The ink engine (PLAN.md §5.4, §12.1).
 *
 * Shared ink is a laser pointer, not a whiteboard: you draw over the lecture,
 * everyone sees it as you draw it, and it is gone four seconds later. Nothing is
 * stored anywhere. A participant who joins after a stroke expired never sees it,
 * and that is the correct outcome — there is no replay to add.
 *
 * Four decisions carry the whole design:
 *
 *  1. **React is not in the loop.** Pointer events arrive at up to 120 Hz on a
 *     trackpad and faster on a stylus. A `setState` per point would re-render the
 *     room several times a frame and stutter the player on exactly the machines
 *     this product is for (§5.4). So points go into plain arrays and a
 *     `requestAnimationFrame` loop writes pixels; the only thing React ever
 *     learns is that a controller exists.
 *  2. **The loop dies when the ink does.** A room sits idle for hours. The rAF
 *     callback is scheduled by whatever creates a stroke and stops rescheduling
 *     itself the frame after the last one expires, so an idle room costs nothing.
 *  3. **Each message carries only the NEW points.** The receiver appends by
 *     stroke id. Resending the stroke so far would make a 400-point stroke cost
 *     O(n²) bytes, which is how a nice feature becomes the reason the room lags.
 *  4. **Age is measured against SERVER time.** See `now()`.
 *
 * The controller knows nothing about React, sockets or the DOM beyond a canvas
 * it is handed — which is what lets the tests drive it with a fake clock, a fake
 * canvas and a manual frame pump.
 */
import {
  clientId,
  INK_EMIT_INTERVAL_MS,
  INK_FADE_MS,
  INK_HOLD_MS,
  INK_LIFETIME_MS,
  INK_MAX_ACTIVE_STROKES,
  INK_MAX_POINTS_PER_MESSAGE,
  INK_MAX_POINTS_PER_STROKE,
  INK_STROKE_WIDTH,
} from '@syncstudy/shared';
import { inkContentRect, type ContentRect } from '@/lib/ink/geometry';
import type { InkClock, InkPoint, InkStroke } from '@/lib/ink/types';

/**
 * Two points closer than this are the same point.
 *
 * A pointer resting on a term still fires events, and each of those invisible
 * points costs a slot in everyone's rate-limit budget and bytes on everyone's
 * connection. At a 16:9 stage 0.002 is roughly 2.5 css px wide on a 1280px
 * stage — under the stroke width, so nothing that would have been visible is
 * ever dropped.
 */
const MIN_POINT_DISTANCE = 0.002;
const MIN_POINT_DISTANCE_SQ = MIN_POINT_DISTANCE * MIN_POINT_DISTANCE;

/**
 * Retina is worth paying for; a 3x phone panel is not. The stroke is 3px of
 * translucent colour over video — the third pixel of precision is invisible and
 * costs 2.25× the fill rate on the weakest device in the room (§5.4).
 */
const MAX_DEVICE_PIXEL_RATIO = 2;

/**
 * The longest a single stroke may keep resetting its fade, measured from when it
 * was first seen. A real drag is a second or two; this is a ceiling on abuse,
 * not a limit anyone drawing normally will meet.
 */
const MAX_STROKE_EXTENSION_MS = 30_000;

export interface InkControllerDeps {
  clock: InkClock;
  selfId: string;
  colorFor: (userId: string) => string;
  sendStroke: (payload: { strokeId: string; points: InkPoint[]; done: boolean }) => void;
  sendClear: () => void;
}

/** `draw:stroke`, server → client. */
export interface RemoteStroke {
  from: string;
  strokeId: string;
  points: InkPoint[];
  done: boolean;
  serverMs: number;
}

/**
 * How visible a stroke of this age is.
 *
 * Fully opaque for `INK_HOLD_MS` — long enough to look at — then a straight ramp
 * to nothing over `INK_FADE_MS`. Linear on purpose: an eased fade reads as an
 * animation, and this is not decoration. It is the feature, which is also why it
 * survives `prefers-reduced-motion` when every other movement in the room does
 * not (§12.1 rule 12).
 *
 * A negative age (a stamp from slightly in our future, which a clock offset of a
 * few tens of ms will produce) is treated as brand new rather than as expired.
 */
export function strokeAlpha(ageMs: number): number {
  if (ageMs <= INK_HOLD_MS) return 1;
  const faded = (ageMs - INK_HOLD_MS) / INK_FADE_MS;
  return faded >= 1 ? 0 : 1 - faded;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  return value > 1 ? 1 : value;
}

/** Coordinates arrive from a pointer that may have been dragged off the stage. */
export function clampPoint(point: InkPoint): InkPoint {
  return { x: clamp01(point.x), y: clamp01(point.y) };
}

function tooClose(a: InkPoint, b: InkPoint): boolean {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy < MIN_POINT_DISTANCE_SQ;
}

/**
 * One stroke, as a path.
 *
 * Each reported point becomes the CONTROL point of a quadratic whose endpoints
 * are the midpoints either side of it, so a fast drag comes out as a curve
 * rather than the polygon `lineTo` would give. At 20 Hz over a wire that
 * difference is the whole difference between "ink" and "a chart".
 */
function tracePath(
  ctx: CanvasRenderingContext2D,
  points: readonly InkPoint[],
  rect: ContentRect,
): void {
  // Points are 0..1 on the PICTURE, not on the canvas box — see geometry.ts for
  // why those are different rectangles and why using the box breaks sharing.
  const px = (p: InkPoint): { x: number; y: number } => ({
    x: rect.x + p.x * rect.width,
    y: rect.y + p.y * rect.height,
  });

  const first = points[0];
  if (first === undefined) return;
  const start = px(first);
  const startX = start.x;
  const startY = start.y;

  // A tap. `moveTo` + `lineTo` to the same coordinate paints nothing at all,
  // round cap or not, so a single point has to be drawn as a disc.
  if (points.length === 1) {
    ctx.beginPath();
    ctx.arc(startX, startY, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  ctx.beginPath();
  ctx.moveTo(startX, startY);
  for (let i = 1; i < points.length - 1; i += 1) {
    const current = points[i];
    const next = points[i + 1];
    if (current === undefined || next === undefined) break;
    const c = px(current);
    const mid = px({ x: (current.x + next.x) / 2, y: (current.y + next.y) / 2 });
    ctx.quadraticCurveTo(c.x, c.y, mid.x, mid.y);
  }
  const last = points[points.length - 1];
  if (last !== undefined) {
    const end = px(last);
    ctx.lineTo(end.x, end.y);
  }
  ctx.stroke();
}

export class InkController {
  private readonly deps: InkControllerDeps;

  /**
   * Live strokes, keyed `${userId}:${strokeId}`.
   *
   * A `Map` because insertion order is first-seen order, which is what
   * "oldest" means when the room runs past `INK_MAX_ACTIVE_STROKES`.
   */
  private readonly strokes = new Map<string, InkStroke>();

  /**
   * Stroke ids this client minted.
   *
   * Our own strokes are on screen from the instant the pointer went down, so if
   * the server echoes them back to us they must not be drawn a second time.
   * `from === selfId` catches that already; this catches it as well, and keeps
   * catching it if the provider was never told who "self" is. Entries are
   * dropped with the stroke, so the set is bounded by the four-second lifetime.
   */
  private readonly minted = new Set<string>();

  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;

  private running = false;
  private frame = 0;

  /** The stroke under this client's own pointer, if any. */
  private active: InkStroke | null = null;
  /** Points accepted since the last flush. Never the whole stroke. */
  private pending: InkPoint[] = [];
  /** Last point accepted into `active`; the yardstick for simplification. */
  private lastPoint: InkPoint | null = null;
  /** The pointer is up; the next flush that drains `pending` carries `done`. */
  private ending = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: InkControllerDeps) {
    this.deps = deps;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  attachCanvas(canvas: HTMLCanvasElement | null): void {
    if (this.canvas === canvas) return;
    this.canvas = canvas;
    this.ctx = canvas === null ? null : canvas.getContext('2d');
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // No frame is scheduled for an empty room. The first stroke starts the loop
    // and the last one to expire stops it again (see `tick`).
    if (this.strokes.size > 0) this.kick();
  }

  stop(): void {
    this.running = false;
    if (this.frame !== 0) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    this.stopFlush();
    this.strokes.clear();
    this.minted.clear();
    this.active = null;
    this.pending = [];
    this.lastPoint = null;
    this.ending = false;
    this.wipe();
    this.canvas = null;
    this.ctx = null;
  }

  // ── this client's own pointer ─────────────────────────────────────────────

  /**
   * The stroke is rendered from this call, not from the server's echo of it.
   * A pointer that waits for a round trip does not feel like a pen, and the
   * whole point of ink is that it feels like one.
   */
  beginStroke(point: InkPoint): void {
    // A second pointerdown without a pointerup in between — a stolen capture, a
    // second finger. Finish the old stroke properly rather than orphaning it
    // `done: false` on everyone else's screen.
    this.endStroke();

    const start = clampPoint(point);
    const strokeId = clientId();
    const stroke: InkStroke = {
      id: strokeId,
      userId: this.deps.selfId,
      color: this.deps.colorFor(this.deps.selfId),
      points: [start],
      bornServerMs: this.now(),
      firstSeenServerMs: this.now(),
      done: false,
    };

    this.minted.add(strokeId);
    this.active = stroke;
    this.insert(`${this.deps.selfId}:${strokeId}`, stroke);
    this.lastPoint = start;
    this.pending = [start];
    this.ending = false;
    this.startFlush();
    this.kick();
  }

  extendStroke(point: InkPoint): void {
    const stroke = this.active;
    if (stroke === null || this.ending) return;

    // Truncated at the cap. The stroke stops growing and ages out from where it
    // stopped: something this long stopped being a gesture some seconds ago, and
    // the alternative is one person's scribble crowding out everyone else's.
    if (stroke.points.length >= INK_MAX_POINTS_PER_STROKE) return;

    const next = clampPoint(point);
    const previous = this.lastPoint;
    if (previous !== null && tooClose(previous, next)) return;

    this.lastPoint = next;
    stroke.points.push(next);
    this.pending.push(next);
    // Still being drawn, so it has not finished being born; the countdown starts
    // from the last point, not the first. Bounded from first sight by the same
    // ceiling the remote path uses, so a pointer held down for ten minutes
    // cannot pin its own stroke on screen indefinitely.
    stroke.bornServerMs = Math.min(
      stroke.firstSeenServerMs + MAX_STROKE_EXTENSION_MS,
      this.now(),
    );
    this.kick();
  }

  endStroke(): void {
    const stroke = this.active;
    if (stroke === null) return;
    stroke.done = true;
    this.ending = true;
    // Everyone has to be told the stroke finished, and the wire schema has no
    // empty point list. With nothing left to send, the final point is repeated:
    // one message, and the receiver drops a point identical to the one before
    // it, so nothing changes on screen.
    if (this.pending.length === 0 && this.lastPoint !== null) this.pending = [this.lastPoint];
    // Drained, not flushed once. A backlog bigger than one message would
    // otherwise leave the stroke `done: false` on every other screen until the
    // next interval — and if the pointer went straight back down, `beginStroke`
    // would take the slot and the tail would never be sent at all. Each flush
    // removes at least one point, so this terminates.
    while (this.active !== null && this.pending.length > 0) this.flush();
  }

  /** The eraser. Removes only this client's ink, here and everywhere else. */
  clearMine(): void {
    // Silently, not through `endStroke()`: announcing that a stroke finished and
    // then asking the room to delete it in the same breath is two messages for
    // one intent.
    this.forgetLocal();
    this.clearFrom(this.deps.selfId);
    this.deps.sendClear();
  }

  // ── the room ──────────────────────────────────────────────────────────────

  applyRemote(message: RemoteStroke): void {
    if (message.from === this.deps.selfId || this.minted.has(message.strokeId)) return;

    const key = `${message.from}:${message.strokeId}`;
    const now = this.now();
    let stroke = this.strokes.get(key);

    if (stroke === undefined) {
      // Already dead when it landed: a tab that was frozen, or a very late
      // packet. Nothing missed is ever replayed, so it is dropped rather than
      // flashed on screen for whatever is left of its fade.
      if (now - message.serverMs >= INK_LIFETIME_MS) return;
      stroke = {
        id: message.strokeId,
        userId: message.from,
        color: this.deps.colorFor(message.from),
        points: [],
        bornServerMs: message.serverMs,
        firstSeenServerMs: message.serverMs,
        done: false,
      };
      this.insert(key, stroke);
    }

    const growable = !stroke.done;
    const before = stroke.points.length;

    for (const raw of message.points) {
      if (stroke.points.length >= INK_MAX_POINTS_PER_STROKE) break;
      const next = clampPoint(raw);
      const previous = stroke.points[stroke.points.length - 1];
      if (previous !== undefined && previous.x === next.x && previous.y === next.y) continue;
      stroke.points.push(next);
    }

    // Refresh the countdown ONLY when the stroke actually grew, and only up to a
    // hard ceiling from first sight.
    //
    // A live stroke has to keep resetting its clock or a drag longer than the
    // lifetime fades out from under the pointer still drawing it. But refreshing
    // on every message regardless — including messages whose points were all
    // dropped as duplicates — makes the ink immortal: a client that keeps
    // sending the same point holds its stroke on everyone's screen for as long
    // as it likes. The ceiling bounds even a genuinely endless drag.
    if (growable && stroke.points.length > before) {
      const ceiling = stroke.firstSeenServerMs + MAX_STROKE_EXTENSION_MS;
      stroke.bornServerMs = Math.min(ceiling, Math.max(stroke.bornServerMs, message.serverMs));
    }
    if (message.done) stroke.done = true;

    this.kick();
  }

  /** `draw:cleared` — that person asked for their own ink to go. */
  clearFrom(userId: string): void {
    let removed = false;
    for (const [key, stroke] of this.strokes) {
      if (stroke.userId !== userId) continue;
      this.strokes.delete(key);
      this.forget(stroke);
      removed = true;
    }
    // One more frame, to wipe what is still painted. The loop stops itself
    // again immediately afterwards if nothing is left.
    if (removed) this.kick();
  }

  /** True while any stroke is still alive — lets the overlay skip work when idle. */
  hasInk(): boolean {
    if (this.strokes.size === 0) return false;
    const now = this.now();
    for (const stroke of this.strokes.values()) {
      if (now - stroke.bornServerMs < INK_LIFETIME_MS) return true;
    }
    return false;
  }

  // ── time ──────────────────────────────────────────────────────────────────

  /**
   * Now, in server time.
   *
   * Every stroke's lifetime is measured against this, so the same stroke leaves
   * every screen in the room at the same instant. Local wall clocks are wrong by
   * seconds routinely, and ink that outlives its own explanation on one person's
   * screen is worse than ink that never appeared.
   *
   * The fallback matters more than it looks. Refusing to age until the clock is
   * ready would leave every stroke on the stage forever, which is a permanently
   * broken screen; drawing against local time for the couple of hundred
   * milliseconds before the first sync completes is a fade that runs slightly
   * early or slightly late. The socket provider syncs the clock BEFORE it joins
   * the room, so in practice no draw event ever arrives inside that window.
   */
  private now(): number {
    return this.deps.clock.isReady ? this.deps.clock.now() : Date.now();
  }

  // ── outbound batching ─────────────────────────────────────────────────────

  private startFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setInterval(() => {
      this.flush();
    }, INK_EMIT_INTERVAL_MS);
  }

  private stopFlush(): void {
    if (this.flushTimer === null) return;
    clearInterval(this.flushTimer);
    this.flushTimer = null;
  }

  /**
   * Send whatever has accumulated since the last flush — 20 Hz, not one message
   * per pointer event.
   *
   * A flush with nothing to say sends nothing: a pointer held still over a term
   * is simplified down to zero new points, and should cost zero bytes.
   */
  private flush(): void {
    const stroke = this.active;
    if (stroke === null) return;

    if (this.pending.length === 0) {
      if (this.ending) this.forgetLocal();
      return;
    }

    const points = this.pending.slice(0, INK_MAX_POINTS_PER_MESSAGE);
    this.pending = this.pending.slice(points.length);
    // `done` rides on the message carrying the last point, never on one of its
    // own — the receiver has to have every point before it is told the stroke
    // finished.
    const done = this.ending && this.pending.length === 0;
    this.deps.sendStroke({ strokeId: stroke.id, points, done });
    if (done) this.forgetLocal();
  }

  /** Drop the local drawing state. The stroke itself stays on screen to fade. */
  private forgetLocal(): void {
    this.stopFlush();
    this.active = null;
    this.pending = [];
    this.lastPoint = null;
    this.ending = false;
  }

  // ── the stroke table ──────────────────────────────────────────────────────

  private insert(key: string, stroke: InkStroke): void {
    this.strokes.set(key, stroke);
    while (this.strokes.size > INK_MAX_ACTIVE_STROKES) {
      // Evict the incoming AUTHOR's own oldest stroke before anyone else's.
      //
      // A single global oldest-first table is a griefing tool: nothing on the
      // server tracks strokes (deliberately — it holds no per-stroke state), so
      // one client minting fresh stroke ids at the rate limit would walk the
      // table and silently delete everybody else's ink while their own stayed.
      // Budgeting eviction to the author means a flood can only ever cost that
      // author their own strokes.
      // `key` is excluded: it was inserted a line ago, so without that it is the
      // author's only stroke and the arriving stroke evicts itself.
      const victim = this.oldestKeyFor(stroke.userId, key) ?? this.oldestKey(key);
      if (victim === null) break;
      const evicted = this.strokes.get(victim);
      this.strokes.delete(victim);
      if (evicted !== undefined) this.forget(evicted);
    }
  }

  /** First inserted is first seen, which is what "oldest" means here. */
  private oldestKey(except: string): string | null {
    for (const key of this.strokes.keys()) {
      if (key !== except) return key;
    }
    return null;
  }

  /** That author's oldest OTHER stroke, or null if this is their only one. */
  private oldestKeyFor(userId: string, except: string): string | null {
    for (const [key, stroke] of this.strokes) {
      if (key !== except && stroke.userId === userId) return key;
    }
    return null;
  }

  private forget(stroke: InkStroke): void {
    if (stroke.userId === this.deps.selfId) this.minted.delete(stroke.id);
    // Our own in-progress stroke was evicted or expired out from under us. There
    // is nothing left to draw into, so stop feeding it; the pointer has to be
    // lifted and put down again.
    if (this.active === stroke) this.forgetLocal();
  }

  // ── the render loop ───────────────────────────────────────────────────────

  private kick(): void {
    if (!this.running || this.frame !== 0) return;
    this.frame = requestAnimationFrame(this.tick);
  }

  private readonly tick = (): void => {
    this.frame = 0;
    const now = this.now();

    for (const [key, stroke] of this.strokes) {
      if (now - stroke.bornServerMs < INK_LIFETIME_MS) continue;
      this.strokes.delete(key);
      this.forget(stroke);
    }

    this.paint(now);

    // The frame that empties the table has already painted the empty canvas, so
    // there is nothing left to do until somebody draws again.
    if (this.strokes.size > 0) this.kick();
  };

  private paint(now: number): void {
    const canvas = this.canvas;
    const ctx = this.ctx;
    if (canvas === null || ctx === null) return;

    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    if (cssWidth === 0 || cssHeight === 0) return;

    const ratio = Math.min(MAX_DEVICE_PIXEL_RATIO, Math.max(1, globalThis.devicePixelRatio || 1));
    const width = Math.round(cssWidth * ratio);
    const height = Math.round(cssHeight * ratio);
    // Assigning either dimension reallocates and clears the backing store, so it
    // happens only when the stage actually changed size — not sixty times a
    // second for a box that has not moved.
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    // Draw in css pixels and let the transform scale into the backing store: the
    // stroke is then INK_STROKE_WIDTH thick and crisp on a retina panel, instead
    // of being either blurry or half as thick depending on which half of the
    // problem you forgot.
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = INK_STROKE_WIDTH;

    // The picture, not the box. Identical computation to the pointer path in
    // InkOverlay, which is the whole reason it lives in one function.
    const picture = inkContentRect(cssWidth, cssHeight);
    if (picture.width === 0 || picture.height === 0) return;

    for (const stroke of this.strokes.values()) {
      const alpha = strokeAlpha(now - stroke.bornServerMs);
      if (alpha <= 0) continue;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = stroke.color;
      ctx.fillStyle = stroke.color;
      tracePath(ctx, stroke.points, picture);
    }
    ctx.globalAlpha = 1;
  }

  private wipe(): void {
    const canvas = this.canvas;
    const ctx = this.ctx;
    if (canvas === null || ctx === null) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}
