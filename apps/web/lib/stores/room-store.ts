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
  INITIAL_MESSAGE_COUNT,
  MESSAGE_BACKFILL_MAX,
  type ChecklistItemView,
  type ControlRejectReason,
  type NoteBlockView,
  type NoteItemView,
  type MessageView,
  type Participant,
  type ResolvedPermissions,
  type RoomPolicy,
  type RoomSnapshot,
  type RoomView,
  type VideoAnchor,
} from '@syncstudy/shared';
import { IDLE_SYNC_STATUS, syncStatusEquals, type SyncStatus } from '@/lib/sync/types';

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

/**
 * The room is auto-paused waiting for someone whose video is still loading
 * (§8.10), and this is who for.
 *
 * `untilServerMs` is the server's own deadline, not a suggestion: the wait is
 * capped at WAIT_FOR_SLOW_MAX_MS precisely so one broken connection cannot hold
 * a session hostage. The client mirrors that cap locally, so a lost `waitingFor:
 * []` broadcast leaves a stale label for at most as long as the server would
 * have waited anyway.
 */
export interface WaitingForSlow {
  /** Never empty — the store stores `null` instead of an empty list. */
  userIds: string[];
  untilServerMs: number;
}

/**
 * A message plus what this client knows about its fate (§3.5 H4).
 *
 * `sending` and `failed` exist only on the sender's own screen: an optimistic
 * message is a local promise until the server's copy of it arrives, and the
 * whole point of `clientMsgId` is that the two are recognisably the same
 * message when it does.
 */
export type Delivery = 'sent' | 'sending' | 'failed';

export interface ChatMessage extends MessageView {
  delivery: Delivery;
}

/**
 * The sort key for the transcript.
 *
 * Server ids are uuidv7, so id order IS time order — a total order, identical on
 * every client, with no ties to break. A message that has not been acked yet has
 * no server id, so it sorts under `~`: greater than every hex digit, which puts
 * pending messages after everything the server has confirmed. That is also what
 * a person expects, because they just typed it.
 */
function orderKey(message: ChatMessage): string {
  if (message.delivery === 'sent') return message.id;
  return `~${String(message.createdAt).padStart(15, '0')}${message.clientMsgId ?? ''}`;
}

/**
 * Fold server messages into the list.
 *
 * Two dedupe rules, and both are load-bearing:
 *
 * 1. **By `clientMsgId` first.** The sender's optimistic copy and the server's
 *    broadcast are the same message; matching on the id would miss that, because
 *    the optimistic copy never had the server's id.
 * 2. **By `id` second.** The socket joins the room channel before the snapshot
 *    is built, so a message can legitimately arrive twice — once live, once in
 *    the history. Late is fine. Doubled is not.
 */
function mergeMessages(existing: ChatMessage[], incoming: MessageView[]): ChatMessage[] {
  if (incoming.length === 0) return existing;

  const byId = new Map<string, ChatMessage>();
  const pendingByClientId = new Map<string, ChatMessage>();
  for (const message of existing) {
    if (message.delivery === 'sent') byId.set(message.id, message);
    else if (message.clientMsgId !== null) pendingByClientId.set(message.clientMsgId, message);
  }

  for (const message of incoming) {
    if (message.clientMsgId !== null) pendingByClientId.delete(message.clientMsgId);
    byId.set(message.id, { ...message, delivery: 'sent' });
  }

  const merged = [...byId.values(), ...pendingByClientId.values()];
  merged.sort((a, b) => (orderKey(a) < orderKey(b) ? -1 : orderKey(a) > orderKey(b) ? 1 : 0));
  return merged;
}

/** How far back the transcript has been loaded, and whether there is more. */
export interface ChatHistory {
  /** Pass as `?before=`. Null once the first message in the room is loaded. */
  cursor: string | null;
  hasMore: boolean;
  loading: boolean;
  /** Last page failure, surfaced inline above the list rather than as a toast. */
  error: string | null;
}

interface RoomData {
  room: RoomView | null;
  policy: RoomPolicy | null;
  participants: Participant[];
  video: VideoAnchor;
  /**
   * How synchronisation is going for THIS client (§8.6).
   *
   * Kept in the store rather than in a context of its own so a component that
   * only reads `quality` re-renders on `quality`, and not on every drift
   * measurement. The `SyncController` publishes into it and nothing else writes
   * it; it is the one-way valve between a 2 Hz timer and React.
   */
  sync: SyncStatus;
  you: ResolvedPermissions | null;
  connection: ConnectionState;
  joinError: JoinError | null;
  /** serverNow ≈ Date.now() + this. Published by the provider after each clock sync. */
  serverTimeOffsetMs: number;
  /** Last `video:control_rejected`. Phase 3 records it; Phase 4 reconciles on it. */
  controlRejection: ControlRejection | null;
  /** §8.10. Non-null only while the server is holding the room for a slow client. */
  waiting: WaitingForSlow | null;
  /** The transcript, oldest first. See `orderKey` for why that order is safe. */
  messages: ChatMessage[];
  history: ChatHistory;
  notice: RoomNotice | null;
  rateLimit: RateLimitNotice | null;
  /** The shared document, in position order (§8.12). */
  blocks: NoteBlockView[];
  /** Whole-document version. Drives the "saved" indicator, nothing else. */
  notesVersion: number;
  /** blockId → who is editing it and until when, in SERVER time. */
  blockLocks: Record<string, { userId: string; untilServerMs: number }>;
  /** Timestamped notes/questions/bookmarks, in video order (§3.6 S3). */
  noteItems: NoteItemView[];
  checklist: ChecklistItemView[];
}

export interface RoomStoreState extends RoomData {
  applySnapshot(snapshot: RoomSnapshot, opts?: { backfilled?: boolean }): void;
  applyRoomPatch(patch: Partial<RoomPolicy & { name: string; topic: string | null }>): void;
  setHost(hostId: string): void;
  participantJoined(participant: Participant): void;
  participantLeft(userId: string): void;
  participantPatched(userId: string, patch: Partial<Participant>): void;
  setVideo(anchor: VideoAnchor): void;
  /** Published by the SyncController. `null` resets to idle (the player went away). */
  setSyncStatus(status: SyncStatus | null): void;
  /** Server messages: the snapshot's page, a live broadcast, or a history page. */
  receiveMessages(messages: MessageView[]): void;
  /** Prepend an older page and record the new cursor. */
  prependHistory(messages: MessageView[], hasMore: boolean): void;
  setHistoryLoading(loading: boolean): void;
  setHistoryError(error: string | null): void;
  /** Show it immediately, before the ack (§3.5 H4). */
  addOptimisticMessage(message: ChatMessage): void;
  /** The send failed or timed out; offer a retry rather than losing the text. */
  markMessageFailed(clientMsgId: string): void;
  /** Drop a failed message — the user gave up on it, or is retrying it. */
  removeMessage(clientMsgId: string): void;
  /** `chat:deleted`: tombstone in place, never a gap in the transcript. */
  markMessageDeleted(messageId: string): void;
  noteControlRejected(reason: ControlRejectReason): void;
  /** `video:waiting`. An empty list means the wait ended; pass it through as null. */
  setWaiting(waiting: WaitingForSlow | null): void;
  setConnection(status: ConnectionStatus, attempts?: number): void;
  setJoinError(error: JoinError | null): void;
  setServerTimeOffset(offsetMs: number): void;
  pushNotice(notice: Omit<RoomNotice, 'at'>): void;
  clearNotice(): void;
  noteRateLimited(event: string, retryAfterMs: number): void;
  /** `text: ''` removes the block — that is how a paragraph is deleted (§8.12). */
  applyBlockUpdate(block: NoteBlockView): void;
  /** Local-only: a paragraph this client just started, before any ack. */
  addLocalBlock(block: NoteBlockView): void;
  setBlockLock(blockId: string, userId: string, untilServerMs: number): void;
  upsertNoteItem(item: NoteItemView): void;
  removeNoteItem(id: string): void;
  upsertChecklistItem(item: ChecklistItemView): void;
  removeChecklistItem(id: string): void;
  reset(): void;
}

function initialData(): RoomData {
  return {
    room: null,
    policy: null,
    participants: [],
    video: IDLE_ANCHOR,
    sync: IDLE_SYNC_STATUS,
    you: null,
    // `since: 0`, not `Date.now()`: this object is built during render, and a
    // timestamp there differs between the server pass and the client pass, which
    // is a hydration mismatch for anything that renders it. The provider stamps a
    // real time on the first `setConnection` inside its effect.
    connection: { status: 'connecting', since: 0, attempts: 0 },
    joinError: null,
    serverTimeOffsetMs: 0,
    controlRejection: null,
    waiting: null,
    messages: [],
    history: { cursor: null, hasMore: false, loading: false, error: null },
    notice: null,
    rateLimit: null,
    blocks: [],
    notesVersion: 0,
    blockLocks: {},
    noteItems: [],
    checklist: [],
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

/** Position order, with the id as a total tie-break so it never reshuffles. */
function sortBlocks(blocks: NoteBlockView[]): NoteBlockView[] {
  return [...blocks].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}

/**
 * Video order, because these are read against the scrubber. Items with no
 * timestamp sort last, in creation order — they are notes about the session
 * rather than about a moment in it.
 */
function sortNoteItems(items: NoteItemView[]): NoteItemView[] {
  return [...items].sort((a, b) => {
    if (a.videoTs === null && b.videoTs === null) return a.createdAt - b.createdAt;
    if (a.videoTs === null) return 1;
    if (b.videoTs === null) return -1;
    return a.videoTs - b.videoTs || a.createdAt - b.createdAt;
  });
}

function sortChecklist(items: ChecklistItemView[]): ChecklistItemView[] {
  return [...items].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}

export type RoomStoreApi = StoreApi<RoomStoreState>;

export function createRoomStore(): RoomStoreApi {
  return createStore<RoomStoreState>()((set, get) => ({
    ...initialData(),

    applySnapshot(snapshot, opts = {}) {
      const state = get();
      // MERGED, not replaced. A reconnect snapshot carries only what this client
      // missed (the `lastMessageId` backfill on `room:join` and `room:resync`),
      // so replacing would throw away every page the reader had scrolled back
      // to — and on a fresh join the existing list is empty, which makes merge
      // and replace the same thing. One code path, no branch to get wrong.
      const messages = mergeMessages(state.messages, snapshot.messages);

      // A backfill that came back completely full was truncated, which means
      // there is a hole between what this client had and what it just received.
      // Pointing the scroll-up cursor at the start of the NEW run is what closes
      // it: the next page fetched is the missing middle, not the messages before
      // the transcript's first line. Without this the gap is invisible and
      // permanent until a reload.
      const truncated =
        opts.backfilled === true && snapshot.messages.length >= MESSAGE_BACKFILL_MAX;
      const gapStart = truncated ? snapshot.messages[0] : undefined;
      const oldest = gapStart ?? messages[0];

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
        // A snapshot carries no wait state, and the anchor it carries is already
        // the paused one. Keeping a pre-reconnect "waiting for Sam" would outlive
        // the thing it describes.
        waiting: null,
        messages,
        // Replaced, not merged: unlike the transcript these arrive complete on
        // every snapshot, so merging would resurrect an item somebody deleted
        // while this client was away.
        blocks: sortBlocks(snapshot.notes.blocks),
        notesVersion: snapshot.notes.version,
        blockLocks: {},
        noteItems: sortNoteItems(snapshot.noteItems),
        checklist: sortChecklist(snapshot.checklist),
        history: {
          cursor: oldest?.id ?? null,
          // A full page back means there is almost certainly more behind it; a
          // short one means the room's history starts here. The pagination
          // endpoint returns the authoritative answer on the first scroll-up, so
          // the cost of guessing wrong is one request that returns nothing.
          hasMore: truncated
            ? true
            : state.history.cursor === null
              ? snapshot.messages.length >= INITIAL_MESSAGE_COUNT
              : state.history.hasMore,
          loading: false,
          error: null,
        },
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

    setSyncStatus(status) {
      const next = status ?? IDLE_SYNC_STATUS;
      // The controller publishes on change, but "changed" there means "a field
      // moved"; this is the second gate, and it is the one that keeps a drift
      // measurement that rounded to the same tenth from re-rendering the room.
      if (syncStatusEquals(get().sync, next)) return;
      set({ sync: next });
    },

    receiveMessages(incoming) {
      const current = get().messages;
      const next = mergeMessages(current, incoming);
      if (next === current) return;
      set({ messages: next });
    },

    prependHistory(incoming, hasMore) {
      const state = get();
      const next = mergeMessages(state.messages, incoming);
      const oldest = next[0];
      set({
        messages: next,
        history: { cursor: oldest?.id ?? null, hasMore, loading: false, error: null },
      });
    },

    setHistoryLoading(loading) {
      const state = get();
      if (state.history.loading === loading) return;
      set({ history: { ...state.history, loading } });
    },

    setHistoryError(error) {
      const state = get();
      if (state.history.error === error) return;
      set({ history: { ...state.history, loading: false, error } });
    },

    addOptimisticMessage(message) {
      const current = get().messages;
      // A retry re-uses its `clientMsgId`, so replace rather than append —
      // otherwise the failed copy and the retry both sit in the list.
      const without = current.filter((m) => m.clientMsgId !== message.clientMsgId);
      const next = [...without, message];
      next.sort((a, b) => (orderKey(a) < orderKey(b) ? -1 : orderKey(a) > orderKey(b) ? 1 : 0));
      set({ messages: next });
    },

    markMessageFailed(clientMsgId) {
      const current = get().messages;
      const index = current.findIndex(
        (m) => m.clientMsgId === clientMsgId && m.delivery === 'sending',
      );
      // Not found means the broadcast beat the ack — the message is already in
      // the room. Marking it failed then would be a lie with a retry button.
      if (index === -1) return;
      const existing = current[index];
      if (existing === undefined) return;
      const next = current.slice();
      next[index] = { ...existing, delivery: 'failed' };
      set({ messages: next });
    },

    removeMessage(clientMsgId) {
      const current = get().messages;
      const next = current.filter((m) => m.clientMsgId !== clientMsgId || m.delivery === 'sent');
      if (next.length === current.length) return;
      set({ messages: next });
    },

    markMessageDeleted(messageId) {
      const current = get().messages;
      const index = current.findIndex((m) => m.id === messageId);
      if (index === -1) return;
      const existing = current[index];
      if (existing === undefined || existing.deletedAt !== null) return;
      const next = current.slice();
      // The body goes here as well as on the server: a client that already has
      // the text must not keep rendering it after a moderator removed it.
      //
      // Who deleted it is deliberately not kept. The `chat:deleted` event
      // carries it, but a message loaded from history does not, and a tombstone
      // that reads "removed by a host" live and "message deleted" after a reload
      // is a worse answer than one that reads the same both times.
      next[index] = { ...existing, body: '', deletedAt: Date.now() };
      set({ messages: next });
    },

    noteControlRejected(reason) {
      set({ controlRejection: { reason, at: Date.now() } });
    },

    setWaiting(waiting) {
      const current = get().waiting;
      if (current === null && waiting === null) return;
      if (
        current !== null &&
        waiting !== null &&
        current.untilServerMs === waiting.untilServerMs &&
        current.userIds.length === waiting.userIds.length &&
        current.userIds.every((id, i) => id === waiting.userIds[i])
      ) {
        return;
      }
      set({ waiting });
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

    applyBlockUpdate(block) {
      const current = get().blocks;
      const index = current.findIndex((b) => b.id === block.id);

      if (block.text === '') {
        if (index === -1) return;
        set({ blocks: current.filter((b) => b.id !== block.id) });
        return;
      }

      if (index === -1) {
        set({ blocks: sortBlocks([...current, block]) });
        return;
      }
      const existing = current[index];
      // Out-of-order delivery must not rewind a block. Per-block versions are
      // monotonic, which makes this a total order with no ties to break.
      if (existing === undefined || existing.version > block.version) return;
      if (existing.text === block.text && existing.version === block.version) return;
      const next = current.slice();
      next[index] = block;
      set({ blocks: next });
    },

    addLocalBlock(block) {
      const current = get().blocks;
      if (current.some((b) => b.id === block.id)) return;
      set({ blocks: sortBlocks([...current, block]) });
    },

    setBlockLock(blockId, userId, untilServerMs) {
      const current = get().blockLocks;
      const existing = current[blockId];
      if (existing?.userId === userId && existing.untilServerMs === untilServerMs) return;
      set({ blockLocks: { ...current, [blockId]: { userId, untilServerMs } } });
    },

    upsertNoteItem(item) {
      const current = get().noteItems;
      const index = current.findIndex((i) => i.id === item.id);
      if (index === -1) {
        set({ noteItems: sortNoteItems([...current, item]) });
        return;
      }
      const next = current.slice();
      next[index] = item;
      set({ noteItems: sortNoteItems(next) });
    },

    removeNoteItem(id) {
      const current = get().noteItems;
      const next = current.filter((i) => i.id !== id);
      if (next.length === current.length) return;
      set({ noteItems: next });
    },

    upsertChecklistItem(item) {
      const current = get().checklist;
      const index = current.findIndex((i) => i.id === item.id);
      if (index === -1) {
        set({ checklist: sortChecklist([...current, item]) });
        return;
      }
      const next = current.slice();
      next[index] = item;
      set({ checklist: sortChecklist(next) });
    },

    removeChecklistItem(id) {
      const current = get().checklist;
      const next = current.filter((i) => i.id !== id);
      if (next.length === current.length) return;
      set({ checklist: next });
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

/**
 * The store handle itself, for callers that need to WRITE without subscribing.
 *
 * Event handlers want `api.getState().receiveMessages(…)`. Selecting the actions
 * with `useRoomStore` would work, but every such component would then re-render
 * on every store write — and in a room that is a chat message, a presence patch
 * and a drift publication several times a second.
 */
export function useRoomStoreApi(): RoomStoreApi {
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

/**
 * The last control the server refused (§8.5d).
 *
 * Render it as a 2-second inline pill under the player — "Aditya just changed
 * the video" — never as a red error and never as a modal. `at` changes on every
 * rejection, so the same reason twice in a row is still two distinct values.
 */
export function useControlRejection(): ControlRejection | null {
  return useRoomStore((s) => s.controlRejection);
}

export function useMessages(): ChatMessage[] {
  return useRoomStore((s) => s.messages);
}

export function useChatHistory(): ChatHistory {
  return useRoomStore((s) => s.history);
}

/** Stable identity so the shallow comparison sees "still nothing", not a new []. */
const EMPTY_NAMES: string[] = [];

/**
 * Who the room is waiting for (§8.10), resolved to display names.
 *
 * Ids are resolved here rather than in the component because the server sends
 * ids and only the store knows the roster. Someone whose presence entry has
 * already gone is dropped rather than rendered as a raw uuid.
 */
export function useWaitingForNames(): string[] {
  return useRoomStoreShallow((s) => {
    if (s.waiting === null) return EMPTY_NAMES;
    const names = s.waiting.userIds
      .map((id) => s.participants.find((p) => p.id === id)?.displayName)
      .filter((name): name is string => name !== undefined);
    return names.length === 0 ? EMPTY_NAMES : names;
  });
}

/** `sys:notice` — server-initiated, transient. Render it as a toast, then clear it. */
export function useRoomNotice(): RoomNotice | null {
  return useRoomStore((s) => s.notice);
}

/** `sys:rate_limited` — "you are going too fast", with how long until it lifts. */
export function useRateLimitNotice(): RateLimitNotice | null {
  return useRoomStore((s) => s.rateLimit);
}


// ── study tools (§3.6) ──────────────────────────────────────────────────────

export function useNoteBlocks(): NoteBlockView[] {
  return useRoomStore((s) => s.blocks);
}

export function useNoteItems(): NoteItemView[] {
  return useRoomStore((s) => s.noteItems);
}

export function useChecklist(): ChecklistItemView[] {
  return useRoomStore((s) => s.checklist);
}

/**
 * Who is editing a block right now, or null.
 *
 * Resolved to a display name here because the server sends ids and only the
 * store knows the roster; expired against a passed-in `serverNow` rather than
 * on a timer, because a lock's whole life is eight seconds and a per-block
 * timer would be one timer per paragraph on a busy document.
 */
export function useBlockEditor(blockId: string, youId: string, serverNow: number): string | null {
  return useRoomStore((s) => {
    const lock = s.blockLocks[blockId];
    if (lock === undefined || lock.userId === youId) return null;
    if (lock.untilServerMs <= serverNow) return null;
    return s.participants.find((p) => p.id === lock.userId)?.displayName ?? null;
  });
}
