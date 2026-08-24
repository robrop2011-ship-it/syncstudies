/**
 * Regression tests for the disconnect-grace timer.
 *
 * These exist because of a specific bug: `arm()` used to schedule TWO timers —
 * a 45s removal timer and a 60s host-transfer timer. Since 45 < 60 the removal
 * always fired first, and the removal path called `cancel()`, which cleared
 * BOTH. The host-transfer callback was therefore unreachable, and a host whose
 * connection dropped left the room permanently hostless.
 *
 * The fix is one timer whose delay depends on the role, with the handover done
 * at removal. The assertions below pin that: with the old two-timer code, the
 * "host is untouched at 45s" case fails immediately.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DISCONNECT_GRACE_MS, HOST_DISCONNECT_GRACE_MS } from '@syncstudy/shared';
import { GraceTimers } from '../handlers/presence.js';
import type { AppContext } from '../handlers/context.js';

function stubContext() {
  const getParticipant = vi.fn().mockResolvedValue(null);
  const ctx = {
    store: { getParticipant },
    log: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
  } as unknown as AppContext;
  return { ctx, getParticipant };
}

/** Let the timer's async callback settle after the fake clock advances. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('GraceTimers', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('removes a non-host participant at DISCONNECT_GRACE_MS, not before', async () => {
    const { ctx, getParticipant } = stubContext();
    const timers = new GraceTimers();
    timers.attach(ctx);

    timers.arm('room-1', 'user-1', false);

    await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS - 1);
    await flush();
    expect(getParticipant).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2);
    await flush();
    expect(getParticipant).toHaveBeenCalledWith('room-1', 'user-1');
  });

  it('gives the host the longer window and does NOT act at the member deadline', async () => {
    const { ctx, getParticipant } = stubContext();
    const timers = new GraceTimers();
    timers.attach(ctx);

    timers.arm('room-1', 'host-1', true);

    // The regression: the old code armed a 45s timer for everyone, so this
    // advance fired it and then cancelled the 60s host-transfer timer.
    await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS + 1);
    await flush();
    expect(getParticipant).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(HOST_DISCONNECT_GRACE_MS - DISCONNECT_GRACE_MS);
    await flush();
    expect(getParticipant).toHaveBeenCalledTimes(1);
    expect(getParticipant).toHaveBeenCalledWith('room-1', 'host-1');
  });

  it('fires exactly once, so there is no second timer to be cancelled', async () => {
    const { ctx, getParticipant } = stubContext();
    const timers = new GraceTimers();
    timers.attach(ctx);

    timers.arm('room-1', 'host-1', true);
    await vi.advanceTimersByTimeAsync(HOST_DISCONNECT_GRACE_MS * 3);
    await flush();

    expect(getParticipant).toHaveBeenCalledTimes(1);
  });

  it('cancel() stops a pending removal (the reconnect-in-time path)', async () => {
    const { ctx, getParticipant } = stubContext();
    const timers = new GraceTimers();
    timers.attach(ctx);

    timers.arm('room-1', 'user-1', false);
    await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS / 2);
    timers.cancel('room-1', 'user-1');

    await vi.advanceTimersByTimeAsync(HOST_DISCONNECT_GRACE_MS * 2);
    await flush();
    expect(getParticipant).not.toHaveBeenCalled();
  });

  it('re-arming replaces the pending timer rather than stacking another', async () => {
    const { ctx, getParticipant } = stubContext();
    const timers = new GraceTimers();
    timers.attach(ctx);

    timers.arm('room-1', 'user-1', false);
    await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS - 100);
    timers.arm('room-1', 'user-1', false); // e.g. a second tab dropped too

    // The original deadline must no longer apply...
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    expect(getParticipant).not.toHaveBeenCalled();

    // ...and the new one fires exactly once.
    await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS);
    await flush();
    expect(getParticipant).toHaveBeenCalledTimes(1);
  });

  it('tracks rooms and users independently', async () => {
    const { ctx, getParticipant } = stubContext();
    const timers = new GraceTimers();
    timers.attach(ctx);

    timers.arm('room-1', 'user-1', false);
    timers.arm('room-2', 'user-1', false);
    timers.cancel('room-1', 'user-1');

    await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS + 1);
    await flush();

    expect(getParticipant).toHaveBeenCalledTimes(1);
    expect(getParticipant).toHaveBeenCalledWith('room-2', 'user-1');
  });

  it('clearAll() drops every pending timer', async () => {
    const { ctx, getParticipant } = stubContext();
    const timers = new GraceTimers();
    timers.attach(ctx);

    timers.arm('room-1', 'user-1', false);
    timers.arm('room-2', 'user-2', true);
    timers.clearAll();

    await vi.advanceTimersByTimeAsync(HOST_DISCONNECT_GRACE_MS * 2);
    await flush();
    expect(getParticipant).not.toHaveBeenCalled();
  });

  it('is inert until a context is attached', async () => {
    const timers = new GraceTimers();
    // No attach() — wiring order must not schedule orphaned callbacks.
    expect(() => timers.arm('room-1', 'user-1', false)).not.toThrow();
    await vi.advanceTimersByTimeAsync(HOST_DISCONNECT_GRACE_MS * 2);
  });

  it('gives the host strictly more time than everyone else', () => {
    // A guard on the constants themselves: if these ever converge, the whole
    // point of the role-aware delay is gone and the two paths become one.
    expect(HOST_DISCONNECT_GRACE_MS).toBeGreaterThan(DISCONNECT_GRACE_MS);
  });
});
