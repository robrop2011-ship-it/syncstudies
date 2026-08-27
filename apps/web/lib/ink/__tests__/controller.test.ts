/**
 * The ink engine's model, with the pixels mocked out.
 *
 * Everything worth breaking in this feature is arithmetic — when a stroke dies,
 * which points survive simplification, what gets evicted when the room is busy,
 * and whose clock the countdown is read against. None of that needs a browser,
 * so the canvas is a recorder, `requestAnimationFrame` is a queue this file
 * pumps by hand, and the clock is a number the test moves.
 *
 * The rAF queue being manual is not just convenience: "the loop stops when there
 * is no ink" is a real requirement (§5.4), and the only way to assert it is to
 * be able to see that nothing is scheduled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INK_EMIT_INTERVAL_MS,
  INK_FADE_MS,
  INK_HOLD_MS,
  INK_LIFETIME_MS,
  INK_MAX_ACTIVE_STROKES,
  INK_MAX_POINTS_PER_MESSAGE,
  INK_MAX_POINTS_PER_STROKE,
} from '@syncstudy/shared';
import { InkController, strokeAlpha, type RemoteStroke } from '@/lib/ink/controller';
import type { InkPoint } from '@/lib/ink/types';

const SERVER_MS = 1_700_000_000_000;
const STAGE_WIDTH = 1280;
const STAGE_HEIGHT = 720;

// ── a canvas that remembers instead of painting ─────────────────────────────

/** One `stroke()`/`fill()`, and enough context to say what it was. */
interface Painted {
  alpha: number;
  color: string;
  /**
   * Path-building calls since `beginPath`. For an n-point stroke that is
   * `moveTo` + (n-2) quadratics + `lineTo` = n, so it counts points.
   */
  nodes: number;
}

interface FakeContext {
  globalAlpha: number;
  strokeStyle: string;
  fillStyle: string;
  lineWidth: number;
  lineJoin: string;
  lineCap: string;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, width: number, height: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void;
  arc(x: number, y: number, radius: number, start: number, end: number): void;
  stroke(): void;
  fill(): void;
}

interface FakeCanvas {
  width: number;
  height: number;
  clientWidth: number;
  clientHeight: number;
  getContext(id: string): FakeContext;
}

function fakeCanvas(cssWidth = STAGE_WIDTH, cssHeight = STAGE_HEIGHT) {
  const painted: Painted[] = [];
  /** Every coordinate handed to the path API, in order. */
  const path: number[] = [];
  const scales: number[] = [];
  const cleared: number[] = [];
  let nodes = 0;

  const ctx: FakeContext = {
    globalAlpha: 1,
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    lineJoin: '',
    lineCap: '',
    setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
      scales.push(a, b, c, d, e, f);
    },
    clearRect(x: number, y: number, width: number, height: number): void {
      cleared.push(x, y, width, height);
    },
    beginPath(): void {
      nodes = 0;
    },
    moveTo(x: number, y: number): void {
      nodes += 1;
      path.push(x, y);
    },
    lineTo(x: number, y: number): void {
      nodes += 1;
      path.push(x, y);
    },
    quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
      nodes += 1;
      path.push(cx, cy, x, y);
    },
    arc(x: number, y: number, radius: number, start: number, end: number): void {
      nodes += 1;
      path.push(x, y, radius, start, end);
    },
    stroke(): void {
      painted.push({ alpha: ctx.globalAlpha, color: ctx.strokeStyle, nodes });
    },
    fill(): void {
      painted.push({ alpha: ctx.globalAlpha, color: ctx.fillStyle, nodes });
    },
  };

  const canvas: FakeCanvas = {
    width: 0,
    height: 0,
    clientWidth: cssWidth,
    clientHeight: cssHeight,
    getContext: () => ctx,
  };

  return {
    element: canvas as unknown as HTMLCanvasElement,
    raw: canvas,
    painted,
    path,
    scales,
    cleared,
    clear(): void {
      painted.length = 0;
      path.length = 0;
      scales.length = 0;
      cleared.length = 0;
    },
  };
}

// ── the harness ─────────────────────────────────────────────────────────────

interface SentStroke {
  strokeId: string;
  points: InkPoint[];
  done: boolean;
}

const frames = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;

/** Runs the oldest scheduled frame, if there is one. */
function pump(): boolean {
  for (const [id, callback] of frames) {
    frames.delete(id);
    callback(0);
    return true;
  }
  return false;
}

function buildHarness() {
  let serverMs = SERVER_MS;
  const sent: SentStroke[] = [];
  let clears = 0;

  const canvas = fakeCanvas();
  const controller = new InkController({
    clock: { now: () => serverMs, isReady: true },
    selfId: 'me',
    // The id doubles as the colour, so a painted stroke says who drew it.
    colorFor: (userId) => userId,
    sendStroke: (payload) => {
      sent.push({ ...payload, points: payload.points.map((point) => ({ ...point })) });
    },
    sendClear: () => {
      clears += 1;
    },
  });

  controller.attachCanvas(canvas.element);
  controller.start();

  return {
    controller,
    canvas,
    sent,
    clearCount: (): number => clears,
    serverNow: (): number => serverMs,
    /** Move SERVER time. Deliberately independent of the local clock. */
    travel(ms: number): void {
      serverMs += ms;
    },
    /** One frame, with the canvas record wiped first. */
    paint(): Painted[] {
      canvas.clear();
      pump();
      return canvas.painted;
    },
  };
}

function remote(overrides: Partial<RemoteStroke> & { serverMs: number }): RemoteStroke {
  return {
    from: 'them',
    strokeId: 's1',
    points: [
      { x: 0.2, y: 0.2 },
      { x: 0.8, y: 0.8 },
    ],
    done: false,
    ...overrides,
  };
}

beforeEach(() => {
  frames.clear();
  nextFrameId = 1;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date(SERVER_MS));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    const id = nextFrameId;
    nextFrameId += 1;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
    frames.delete(id);
  });
  vi.stubGlobal('devicePixelRatio', 1);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ── the ageing curve ────────────────────────────────────────────────────────

describe('strokeAlpha', () => {
  it('holds at full opacity for the whole hold window', () => {
    expect(strokeAlpha(0)).toBe(1);
    expect(strokeAlpha(INK_HOLD_MS - 1)).toBe(1);
    expect(strokeAlpha(INK_HOLD_MS)).toBe(1);
  });

  it('ramps to nothing across the fade window', () => {
    expect(strokeAlpha(INK_HOLD_MS + INK_FADE_MS / 4)).toBeCloseTo(0.75, 5);
    expect(strokeAlpha(INK_HOLD_MS + INK_FADE_MS / 2)).toBeCloseTo(0.5, 5);
    expect(strokeAlpha(INK_HOLD_MS + (INK_FADE_MS * 3) / 4)).toBeCloseTo(0.25, 5);
  });

  it('is gone at the lifetime and stays gone', () => {
    expect(strokeAlpha(INK_LIFETIME_MS)).toBe(0);
    expect(strokeAlpha(INK_LIFETIME_MS + 60_000)).toBe(0);
  });

  it('treats a stamp from the near future as brand new, not as expired', () => {
    // A clock offset of a few tens of ms routinely produces one of these.
    expect(strokeAlpha(-80)).toBe(1);
  });
});

describe('ageing a live stroke', () => {
  it('is opaque, then fades, then is deleted', () => {
    const room = buildHarness();
    room.controller.applyRemote(remote({ serverMs: room.serverNow(), done: true }));

    expect(room.paint()[0]?.alpha).toBe(1);

    room.travel(INK_HOLD_MS);
    expect(room.paint()[0]?.alpha).toBe(1);

    room.travel(INK_FADE_MS / 2);
    const fading = room.paint()[0]?.alpha ?? 0;
    expect(fading).toBeGreaterThan(0.4);
    expect(fading).toBeLessThan(0.6);

    room.travel(INK_FADE_MS / 2);
    expect(room.paint()).toHaveLength(0);
    expect(room.controller.hasInk()).toBe(false);
  });

  it('stops the frame loop once the last stroke has expired', () => {
    const room = buildHarness();
    // Nothing drawn yet: an idle room must not be holding a frame callback open.
    expect(frames.size).toBe(0);

    room.controller.applyRemote(remote({ serverMs: room.serverNow(), done: true }));
    expect(frames.size).toBe(1);

    room.paint();
    expect(frames.size).toBe(1);

    room.travel(INK_LIFETIME_MS);
    room.paint();
    expect(frames.size).toBe(0);
  });

  it('keeps a stroke alive while it is still being extended', () => {
    const room = buildHarness();
    room.controller.applyRemote(remote({ serverMs: room.serverNow() }));

    // Six seconds of drawing — half as long again as the whole lifetime. The
    // stroke must not die under the pointer that is still drawing it.
    for (let i = 0; i < 6; i += 1) {
      room.travel(1_000);
      room.controller.applyRemote(
        remote({ serverMs: room.serverNow(), points: [{ x: 0.1 * i, y: 0.5 }] }),
      );
      expect(room.paint()[0]?.alpha).toBe(1);
    }

    room.travel(INK_LIFETIME_MS);
    expect(room.paint()).toHaveLength(0);
  });
});

describe('server time, not local time', () => {
  it('dies at the right server instant however wrong the local clock is', () => {
    // The machine's wall clock is nine seconds slow. Aged against `Date.now()`
    // this stroke would be immortal for nine seconds.
    vi.setSystemTime(new Date(SERVER_MS - 9_000));

    const room = buildHarness();
    room.controller.applyRemote(remote({ serverMs: room.serverNow(), done: true }));

    room.travel(INK_LIFETIME_MS - 100);
    expect(room.paint()).toHaveLength(1);

    room.travel(100);
    expect(room.paint()).toHaveLength(0);
    expect(room.controller.hasInk()).toBe(false);
  });
});

// ── outbound ────────────────────────────────────────────────────────────────

describe('sending', () => {
  it('drops points that land on top of the previous one', () => {
    const room = buildHarness();
    room.controller.beginStroke({ x: 0.5, y: 0.5 });
    // A pointer resting on a term. Invisible, and it would cost a slot in
    // everyone's rate-limit budget on every event.
    room.controller.extendStroke({ x: 0.5005, y: 0.5 });
    room.controller.extendStroke({ x: 0.5, y: 0.5008 });
    room.controller.extendStroke({ x: 0.51, y: 0.5 });

    vi.advanceTimersByTime(INK_EMIT_INTERVAL_MS);

    expect(room.sent).toHaveLength(1);
    expect(room.sent[0]?.points).toEqual([
      { x: 0.5, y: 0.5 },
      { x: 0.51, y: 0.5 },
    ]);
  });

  it('batches on the emit interval rather than sending per pointer event', () => {
    const room = buildHarness();
    room.controller.beginStroke({ x: 0, y: 0 });
    for (let i = 1; i <= 20; i += 1) room.controller.extendStroke({ x: i / 100, y: i / 100 });

    // Twenty-one points in, nothing on the wire until the timer fires.
    expect(room.sent).toHaveLength(0);
    vi.advanceTimersByTime(INK_EMIT_INTERVAL_MS);
    expect(room.sent).toHaveLength(1);
    expect(room.sent[0]?.points).toHaveLength(21);
  });

  it('sends only the new points, never the stroke so far', () => {
    const room = buildHarness();
    room.controller.beginStroke({ x: 0, y: 0 });
    room.controller.extendStroke({ x: 0.1, y: 0.1 });
    vi.advanceTimersByTime(INK_EMIT_INTERVAL_MS);
    room.controller.extendStroke({ x: 0.2, y: 0.2 });
    room.controller.extendStroke({ x: 0.3, y: 0.3 });
    vi.advanceTimersByTime(INK_EMIT_INTERVAL_MS);

    expect(room.sent.map((message) => message.points.length)).toEqual([2, 2]);
    expect(room.sent[1]?.points).toEqual([
      { x: 0.2, y: 0.2 },
      { x: 0.3, y: 0.3 },
    ]);
    // One stroke id throughout, so the receiver appends rather than starting over.
    expect(room.sent[0]?.strokeId).toBe(room.sent[1]?.strokeId);
  });

  it('marks done on the message carrying the last point', () => {
    const room = buildHarness();
    room.controller.beginStroke({ x: 0, y: 0 });
    room.controller.extendStroke({ x: 0.4, y: 0.4 });
    room.controller.endStroke();

    expect(room.sent).toHaveLength(1);
    expect(room.sent[0]?.done).toBe(true);
    expect(room.sent[0]?.points).toHaveLength(2);
  });

  it('still announces the end when the last point has already been sent', () => {
    const room = buildHarness();
    room.controller.beginStroke({ x: 0, y: 0 });
    room.controller.extendStroke({ x: 0.4, y: 0.4 });
    vi.advanceTimersByTime(INK_EMIT_INTERVAL_MS);
    expect(room.sent[0]?.done).toBe(false);

    room.controller.endStroke();
    // The wire schema has no empty point list, so the final point is repeated.
    expect(room.sent).toHaveLength(2);
    expect(room.sent[1]?.done).toBe(true);
    expect(room.sent[1]?.points).toEqual([{ x: 0.4, y: 0.4 }]);
  });

  it('never puts more than one message worth of points on the wire at once', () => {
    const room = buildHarness();
    const total = INK_MAX_POINTS_PER_MESSAGE * 3 + 9;
    room.controller.beginStroke({ x: 0, y: 0 });
    for (let i = 1; i < total; i += 1) room.controller.extendStroke({ x: i / total, y: 0.5 });
    room.controller.endStroke();

    // Drained on pointer-up rather than dribbled out over the next few
    // intervals, so nobody is left holding a stroke that never said it finished.
    expect(room.sent.map((message) => message.points.length)).toEqual([
      INK_MAX_POINTS_PER_MESSAGE,
      INK_MAX_POINTS_PER_MESSAGE,
      INK_MAX_POINTS_PER_MESSAGE,
      9,
    ]);
    expect(room.sent.map((message) => message.done)).toEqual([false, false, false, true]);
  });

  it('sends nothing while the pointer is held still', () => {
    const room = buildHarness();
    room.controller.beginStroke({ x: 0.5, y: 0.5 });
    vi.advanceTimersByTime(INK_EMIT_INTERVAL_MS);
    expect(room.sent).toHaveLength(1);

    room.controller.extendStroke({ x: 0.5001, y: 0.5001 });
    vi.advanceTimersByTime(INK_EMIT_INTERVAL_MS * 10);
    expect(room.sent).toHaveLength(1);
  });

  it('renders the local stroke immediately, without waiting for the server', () => {
    const room = buildHarness();
    room.controller.beginStroke({ x: 0.2, y: 0.2 });
    room.controller.extendStroke({ x: 0.6, y: 0.6 });

    const painted = room.paint();
    expect(painted).toHaveLength(1);
    expect(painted[0]?.color).toBe('me');
  });

});

// ── painting ────────────────────────────────────────────────────────────────

describe('painting', () => {
  it('paints normalised points against the receiver’s own stage box', () => {
    // The whole feature rests on this: 0..1 in, this window’s pixels out. A
    // stroke sent in pixels would land somewhere else on the lecture for
    // everybody whose window is a different size, which is worse than no ink.
    const room = buildHarness();
    room.controller.applyRemote(
      remote({
        serverMs: room.serverNow(),
        points: [
          { x: 0.5, y: 0.25 },
          { x: 0.75, y: 0.5 },
        ],
        done: true,
      }),
    );

    room.paint();
    expect(room.canvas.path).toEqual([
      0.5 * STAGE_WIDTH,
      0.25 * STAGE_HEIGHT,
      0.75 * STAGE_WIDTH,
      0.5 * STAGE_HEIGHT,
    ]);
  });

  it('wipes the canvas before every redraw', () => {
    const room = buildHarness();
    room.controller.applyRemote(remote({ serverMs: room.serverNow() }));
    room.paint();

    expect(room.canvas.cleared).toEqual([0, 0, STAGE_WIDTH, STAGE_HEIGHT]);
  });

  it('paints a single tap as a dot', () => {
    const room = buildHarness();
    room.controller.beginStroke({ x: 0.5, y: 0.5 });

    // One `arc` + `fill`. A `moveTo`/`lineTo` pair on one coordinate paints
    // nothing at all, so this is the difference between a visible tap and none.
    expect(room.paint()).toEqual([{ alpha: 1, color: 'me', nodes: 1 }]);
  });
});

// ── inbound ─────────────────────────────────────────────────────────────────

describe('applyRemote', () => {
  it('creates a stroke on first sight and appends to it by id', () => {
    const room = buildHarness();
    room.controller.applyRemote(
      remote({
        serverMs: room.serverNow(),
        points: [
          { x: 0, y: 0 },
          { x: 0.1, y: 0.1 },
        ],
      }),
    );
    room.controller.applyRemote(
      remote({
        serverMs: room.serverNow(),
        points: [
          { x: 0.2, y: 0.2 },
          { x: 0.3, y: 0.3 },
        ],
        done: true,
      }),
    );

    const painted = room.paint();
    expect(painted).toHaveLength(1);
    expect(painted[0]?.nodes).toBe(4);
  });

  it('keeps two authors apart even when they pick the same stroke id', () => {
    const room = buildHarness();
    room.controller.applyRemote(remote({ from: 'ana', strokeId: 'x', serverMs: room.serverNow() }));
    room.controller.applyRemote(remote({ from: 'bo', strokeId: 'x', serverMs: room.serverNow() }));

    expect(room.paint().map((entry) => entry.color)).toEqual(['ana', 'bo']);
  });

  it('ignores the server echo of our own stroke', () => {
    const room = buildHarness();
    room.controller.beginStroke({ x: 0.1, y: 0.1 });
    room.controller.extendStroke({ x: 0.9, y: 0.9 });
    room.controller.endStroke();
    const strokeId = room.sent[0]?.strokeId ?? '';

    room.controller.applyRemote(
      remote({ from: 'me', strokeId, serverMs: room.serverNow(), done: true }),
    );

    // One stroke, not two, and its points were not appended a second time.
    const painted = room.paint();
    expect(painted).toHaveLength(1);
    expect(painted[0]?.nodes).toBe(2);
  });

  it('drops a stroke that was already dead when it arrived', () => {
    const room = buildHarness();
    // A tab that was frozen, or a very late packet. A late joiner missing a
    // stroke that expired is the correct outcome — there is no replay.
    room.controller.applyRemote(
      remote({ serverMs: room.serverNow() - INK_LIFETIME_MS, done: true }),
    );

    expect(room.controller.hasInk()).toBe(false);
    expect(frames.size).toBe(0);
  });
});

// ── caps ────────────────────────────────────────────────────────────────────

describe('caps', () => {
  it('truncates a stroke at the per-stroke point cap', () => {
    const room = buildHarness();
    const total = INK_MAX_POINTS_PER_STROKE + 112;

    for (let offset = 0; offset < total; offset += INK_MAX_POINTS_PER_MESSAGE) {
      const points: InkPoint[] = [];
      for (let i = offset; i < Math.min(offset + INK_MAX_POINTS_PER_MESSAGE, total); i += 1) {
        points.push({ x: i / total, y: (i % 7) / 10 });
      }
      room.controller.applyRemote(remote({ serverMs: room.serverNow(), points }));
    }

    expect(room.paint()[0]?.nodes).toBe(INK_MAX_POINTS_PER_STROKE);
  });

  it('evicts the oldest stroke once the room is over the active cap', () => {
    const room = buildHarness();
    for (let i = 0; i <= INK_MAX_ACTIVE_STROKES; i += 1) {
      room.controller.applyRemote(remote({ from: `u${i}`, serverMs: room.serverNow() }));
    }

    const colors = room.paint().map((entry) => entry.color);
    expect(colors).toHaveLength(INK_MAX_ACTIVE_STROKES);
    expect(colors).not.toContain('u0');
    expect(colors[0]).toBe('u1');
    expect(colors.at(-1)).toBe(`u${INK_MAX_ACTIVE_STROKES}`);
  });

  it('makes a flooding author evict only their own ink', () => {
    // The griefing case. Nothing on the server tracks strokes — it relays and
    // forgets — so this cap is the only thing standing between one client
    // minting stroke ids at the rate limit and everybody else's ink vanishing
    // off every screen in the room. Evicting globally-oldest would let them.
    const room = buildHarness();
    room.controller.applyRemote(remote({ from: 'ana', strokeId: 'a1', serverMs: room.serverNow() }));
    room.controller.applyRemote(remote({ from: 'bo', strokeId: 'b1', serverMs: room.serverNow() }));

    for (let i = 0; i < INK_MAX_ACTIVE_STROKES * 2; i += 1) {
      room.controller.applyRemote(
        remote({ from: 'mal', strokeId: `m${i}`, serverMs: room.serverNow() }),
      );
    }

    const authors = room.paint().map((entry) => entry.color);
    expect(authors).toContain('ana');
    expect(authors).toContain('bo');
    expect(authors.length).toBeLessThanOrEqual(INK_MAX_ACTIVE_STROKES);
  });
});

// ── clearing ────────────────────────────────────────────────────────────────

describe('clearing', () => {
  it('removes only the ink belonging to the author who cleared', () => {
    const room = buildHarness();
    room.controller.applyRemote(remote({ from: 'ana', serverMs: room.serverNow() }));
    room.controller.applyRemote(remote({ from: 'bo', serverMs: room.serverNow() }));

    room.controller.clearFrom('ana');

    expect(room.paint().map((entry) => entry.color)).toEqual(['bo']);
  });

  it('clearMine wipes our own strokes and tells the room once', () => {
    const room = buildHarness();
    room.controller.beginStroke({ x: 0.1, y: 0.1 });
    room.controller.extendStroke({ x: 0.9, y: 0.9 });
    room.controller.applyRemote(remote({ from: 'ana', serverMs: room.serverNow() }));

    room.controller.clearMine();

    expect(room.clearCount()).toBe(1);
    expect(room.paint().map((entry) => entry.color)).toEqual(['ana']);
    // The stroke in progress went with it — no trailing `done` for something
    // that has already been erased.
    const before = room.sent.length;
    vi.advanceTimersByTime(INK_EMIT_INTERVAL_MS * 4);
    expect(room.sent).toHaveLength(before);
  });
});

// ── the backing store ───────────────────────────────────────────────────────

describe('device pixel ratio', () => {
  it('sizes the backing store for the display so ink is not blurry', () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const room = buildHarness();
    room.controller.applyRemote(remote({ serverMs: room.serverNow() }));
    room.paint();

    expect(room.canvas.raw.width).toBe(STAGE_WIDTH * 2);
    expect(room.canvas.raw.height).toBe(STAGE_HEIGHT * 2);
    expect(room.canvas.scales[0]).toBe(2);
  });

  it('caps the ratio rather than paying for a 3x panel', () => {
    vi.stubGlobal('devicePixelRatio', 3);
    const room = buildHarness();
    room.controller.applyRemote(remote({ serverMs: room.serverNow() }));
    room.paint();

    expect(room.canvas.raw.width).toBe(STAGE_WIDTH * 2);
  });
});

// ── teardown ────────────────────────────────────────────────────────────────

describe('stop', () => {
  it('releases the frame, the flush timer and every stroke', () => {
    const room = buildHarness();
    room.controller.applyRemote(remote({ serverMs: room.serverNow() }));
    room.controller.beginStroke({ x: 0.1, y: 0.1 });
    expect(frames.size).toBe(1);

    room.controller.stop();

    expect(frames.size).toBe(0);
    expect(room.controller.hasInk()).toBe(false);
    const before = room.sent.length;
    vi.advanceTimersByTime(INK_EMIT_INTERVAL_MS * 10);
    expect(room.sent).toHaveLength(before);
  });
});
