/**
 * The listener plumbing shared by every PlayerAdapter (PLAN.md §5.3).
 *
 * `PlayerAdapter.on` is declared as four overloads, one per event, so a listener
 * for `statechange` is typed as receiving a `PlayerState` and a listener for
 * `error` receives a `PlayerErrorInfo`. That is worth keeping, but it means each
 * adapter would otherwise re-implement the same overload set plus a store of
 * heterogeneously-typed callbacks. This base class does it once.
 *
 * Deliberately environment-free: no DOM, no timers. `fake.ts` and the sync
 * simulator both run in plain Node, and this file sits underneath both of them.
 */
import type { PlayerErrorInfo, PlayerEvent, PlayerState } from '@syncstudy/shared';

/** The payload each event carries. The single source of truth for `emit`. */
export interface PlayerEventPayloads {
  statechange: PlayerState;
  ready: undefined;
  error: PlayerErrorInfo;
  ratechange: number;
}

/**
 * How a listener is stored once its event type has been erased.
 *
 * `never` in the parameter position is what makes the store sound: a function
 * that accepts anything specific is assignable to one that accepts `never`, so
 * every concrete listener fits here, and nothing can call it without asserting
 * back to a real payload type first (which `emit` does, once, with the payload
 * map to keep it honest).
 */
type StoredListener = (payload: never) => void;

export class PlayerEmitter {
  private readonly listeners = new Map<PlayerEvent, Set<StoredListener>>();
  /**
   * `ready` is sticky. An adapter that is handed to its caller already
   * initialised — which is exactly what `createYouTubePlayer` does, since it
   * resolves *on* ready — would otherwise fire the event before anybody could
   * subscribe, and every later `on('ready')` would hang forever.
   */
  private readyFired = false;

  on(event: 'statechange', cb: (state: PlayerState) => void): () => void;
  on(event: 'ready', cb: () => void): () => void;
  on(event: 'error', cb: (err: PlayerErrorInfo) => void): () => void;
  on(event: 'ratechange', cb: (rate: number) => void): () => void;
  on(event: PlayerEvent, cb: (payload: never) => void): () => void {
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set<StoredListener>();
      this.listeners.set(event, set);
    }
    const bucket = set;
    bucket.add(cb);

    // Synchronous rather than queued: `ready` is a fact, not an event in flight,
    // and a microtask here would make the simulator's ordering depend on the
    // event loop, which is precisely what it exists to avoid.
    if (event === 'ready' && this.readyFired) (cb as () => void)();

    return () => {
      bucket.delete(cb);
    };
  }

  protected emit<K extends PlayerEvent>(event: K, payload: PlayerEventPayloads[K]): void {
    if (event === 'ready') this.readyFired = true;

    const set = this.listeners.get(event);
    if (set === undefined) return;

    // Copy first: a listener that unsubscribes itself (the `waitForStart` helper
    // in youtube.ts does exactly that) would otherwise mutate the set mid-loop.
    for (const listener of Array.from(set)) {
      try {
        (listener as (p: PlayerEventPayloads[K]) => void)(payload);
      } catch (error) {
        // One broken listener must not stop the others, and must never take the
        // drift loop down with it.
        console.error('[player] a listener threw', error);
      }
    }
  }

  protected clearListeners(): void {
    this.listeners.clear();
  }
}
