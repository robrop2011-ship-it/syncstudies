/**
 * Typed Socket.IO event maps (PLAN.md §10.2).
 *
 * Both sides instantiate their socket with these generics, so an emit with the
 * wrong payload shape fails to compile rather than failing in production.
 */
import type { VideoAnchor, ControlRejectReason } from './video';
import type { Role, ResolvedPermissions } from './permissions';
import type * as S from './schemas';

// ── shared view models ──────────────────────────────────────────────────────

export type ConnState = 'connected' | 'reconnecting';

export interface PublicUser {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface Participant extends PublicUser {
  role: Role;
  connState: ConnState;
  joinedAt: number;
  inCall: boolean;
  muted: boolean;
  camOn: boolean;
  sharing: boolean;
  speaking: boolean;
  forceMuted: boolean;
  buffering: boolean;
}

export interface RoomPolicy {
  playbackControl: S.PlaybackControl;
  chatLocked: boolean;
  slowModeSec: number;
  waitForSlow: boolean;
  callEnabled: boolean;
  screenshareEnabled: boolean;
  maxParticipants: number;
}

export interface RoomView {
  id: string;
  code: string;
  name: string;
  topic: string | null;
  hostId: string;
  createdAt: number;
}

export interface MessageView {
  id: string;
  roomId: string;
  author: PublicUser | null;
  clientMsgId: string | null;
  body: string;
  kind: 'user' | 'system';
  replyToId: string | null;
  videoTs: number | null;
  createdAt: number;
  deletedAt: number | null;
}

export interface NoteItemView {
  id: string;
  kind: 'note' | 'question' | 'bookmark';
  author: PublicUser | null;
  body: string;
  videoRef: string | null;
  videoTs: number | null;
  resolvedAt: number | null;
  createdAt: number;
}

export interface ChecklistItemView {
  id: string;
  label: string;
  position: number;
  createdBy: PublicUser | null;
  completedAt: number | null;
  completedBy: PublicUser | null;
  videoTs: number | null;
}

/**
 * One paragraph of the shared document (PLAN.md §8.12, Amendment A3).
 *
 * The client cannot mint these ids for existing text: an update for an id the
 * server has never seen is a NEW block, so a client that invented ids would
 * duplicate the whole document on its first edit. They arrive with the snapshot
 * and with every broadcast; a client mints one only when a person genuinely
 * starts a new paragraph.
 */
export interface NoteBlockView {
  id: string;
  text: string;
  /** Per-block optimistic version — the `baseVersion` an update is checked against. */
  version: number;
  /** Fractional index. Inserting between two blocks is one write, never a renumber. */
  position: number;
}

export interface NotesDocView {
  /** Blocks joined by a blank line: the durable form, and what an export reads. */
  content: string;
  blocks: NoteBlockView[];
  /** Whole-document version, incremented on every accepted update. */
  version: number;
  updatedAt: number;
}

export interface RoomSnapshot {
  room: RoomView;
  policy: RoomPolicy;
  participants: Participant[];
  video: VideoAnchor;
  /** Server epoch ms at the moment the snapshot was built. */
  serverMs: number;
  messages: MessageView[];
  notes: NotesDocView;
  noteItems: NoteItemView[];
  checklist: ChecklistItemView[];
  you: ResolvedPermissions;
}

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

// ── acks ────────────────────────────────────────────────────────────────────

export interface AckError {
  ok: false;
  code: string;
  message: string;
}
/** `data` is required when the ack carries a payload, absent when it doesn't. */
export type AckOk<T> = undefined extends T ? { ok: true; data?: T } : { ok: true; data: T };
export type Ack<T = undefined> = AckOk<T> | AckError;

export interface ControlAck {
  ok: boolean;
  reason?: ControlRejectReason;
  /** Always present so a rejected client can immediately reconcile. */
  anchor: VideoAnchor;
}

export interface JoinAck {
  ok: boolean;
  code?: string;
  message?: string;
  snapshot?: RoomSnapshot;
}

export interface RtcJoinAck {
  ok: boolean;
  reason?: 'call_disabled' | 'call_full' | 'video_full' | 'not_permitted';
  iceServers?: IceServerConfig[];
  ttlSec?: number;
  peers?: { userId: string; polite: boolean; audio: boolean; video: boolean; sharing: boolean }[];
}

// ── client → server ─────────────────────────────────────────────────────────

export interface ClientToServerEvents {
  'time:ping': (p: S.TimePing, ack: (r: S.TimePong) => void) => void;

  'room:join': (p: S.RoomJoin, ack: (r: JoinAck) => void) => void;
  'room:leave': (p: Record<never, never>, ack: (r: Ack) => void) => void;
  'room:resync': (p: S.RoomResync, ack: (r: JoinAck) => void) => void;

  'video:set': (p: S.VideoSet, ack: (r: ControlAck) => void) => void;
  'video:control': (p: S.VideoControl, ack: (r: ControlAck) => void) => void;
  'video:buffering': (p: S.VideoBuffering) => void;
  'video:report_drift': (p: S.VideoReportDrift) => void;

  'chat:send': (p: S.ChatSend, ack: (r: Ack<MessageView>) => void) => void;
  'chat:delete': (p: S.ChatDelete, ack: (r: Ack) => void) => void;
  'chat:typing': (p: Record<never, never>) => void;

  'notes:block_focus': (p: S.NoteBlockFocus) => void;
  'notes:block_update': (
    p: S.NoteBlockUpdate,
    ack: (r: Ack<{ version: number; winning?: string }>) => void,
  ) => void;
  'notes:item_create': (p: S.NoteItemCreate, ack: (r: Ack<NoteItemView>) => void) => void;
  'notes:item_update': (p: S.NoteItemUpdate, ack: (r: Ack) => void) => void;
  'notes:item_delete': (p: { id: string }, ack: (r: Ack) => void) => void;

  'checklist:create': (p: S.ChecklistCreate, ack: (r: Ack<ChecklistItemView>) => void) => void;
  'checklist:toggle': (p: S.ChecklistToggle, ack: (r: Ack) => void) => void;
  'checklist:reorder': (p: S.ChecklistReorder, ack: (r: Ack) => void) => void;
  'checklist:delete': (p: { id: string }, ack: (r: Ack) => void) => void;

  'presence:update': (p: S.PresencePatch) => void;

  'rtc:join': (p: S.RtcJoin, ack: (r: RtcJoinAck) => void) => void;
  'rtc:leave': (p: Record<never, never>, ack: (r: Ack) => void) => void;
  'rtc:signal': (p: S.RtcSignal, ack: (r: Ack) => void) => void;
  'rtc:ice_refresh': (
    p: Record<never, never>,
    ack: (r: Ack<{ iceServers: IceServerConfig[]; ttlSec: number }>) => void,
  ) => void;
  'rtc:screenshare_claim': (p: Record<never, never>, ack: (r: Ack) => void) => void;
  'rtc:screenshare_release': (p: Record<never, never>, ack: (r: Ack) => void) => void;

  'host:kick': (p: S.HostTargetUser, ack: (r: Ack) => void) => void;
  'host:ban': (p: S.HostBan, ack: (r: Ack) => void) => void;
  'host:set_role': (p: S.HostSetRole, ack: (r: Ack) => void) => void;
  'host:transfer': (p: S.HostTargetUser, ack: (r: Ack) => void) => void;
  'host:force_mute': (p: S.HostForceMute, ack: (r: Ack) => void) => void;
  'host:update_policy': (p: S.UpdateRoomPolicyInput, ack: (r: Ack) => void) => void;
  'host:end_room': (p: Record<never, never>, ack: (r: Ack) => void) => void;
}

// ── server → client ─────────────────────────────────────────────────────────

export type VideoStateReason =
  | 'control'
  | 'heartbeat'
  | 'auto_buffer'
  | 'resync'
  | 'set_video';

export interface ServerToClientEvents {
  'room:snapshot': (p: RoomSnapshot) => void;
  'room:updated': (p: { patch: Partial<RoomPolicy & { name: string; topic: string | null }> }) => void;
  'room:host_changed': (p: { hostId: string; reason: 'transfer' | 'left' | 'timeout' }) => void;
  'room:ended': (p: { by: string | null; reason: string }) => void;
  'room:you_were_kicked': (p: { by: string; banned: boolean; reason?: string }) => void;

  'presence:join': (p: { participant: Participant }) => void;
  'presence:leave': (p: { userId: string; reason: 'left' | 'timeout' | 'kicked' }) => void;
  'presence:update': (p: { userId: string; patch: Partial<Participant> }) => void;

  'video:state': (p: {
    anchor: VideoAnchor;
    actorId: string | null;
    reason: VideoStateReason;
    serverMs: number;
  }) => void;
  'video:control_rejected': (p: { reason: ControlRejectReason; anchor: VideoAnchor }) => void;
  'video:waiting': (p: { waitingFor: string[]; untilServerMs: number }) => void;

  'chat:message': (p: { message: MessageView }) => void;
  'chat:deleted': (p: { messageId: string; by: string }) => void;
  'chat:typing': (p: { userId: string }) => void;

  'notes:block_locked': (p: { blockId: string; userId: string; untilServerMs: number }) => void;
  /** `text: ''` is a deleted paragraph — the only way to remove one (§8.12). */
  'notes:block_updated': (p: {
    blockId: string;
    text: string;
    version: number;
    position: number;
    by: string;
  }) => void;
  'notes:item_created': (p: { item: NoteItemView }) => void;
  'notes:item_updated': (p: { item: NoteItemView }) => void;
  'notes:item_deleted': (p: { id: string }) => void;

  'checklist:created': (p: { item: ChecklistItemView }) => void;
  'checklist:updated': (p: { item: ChecklistItemView }) => void;
  'checklist:deleted': (p: { id: string }) => void;

  'rtc:peers': (p: { peers: NonNullable<RtcJoinAck['peers']> }) => void;
  'rtc:peer_joined': (p: { userId: string; polite: boolean }) => void;
  'rtc:peer_left': (p: { userId: string }) => void;
  'rtc:signal': (p: S.RtcSignal & { from: string }) => void;
  'rtc:screenshare_changed': (p: { holder: string | null }) => void;
  'rtc:force_muted': (p: { by: string }) => void;

  'sys:notice': (p: { level: 'info' | 'warn'; code: string; message: string }) => void;
  'sys:rate_limited': (p: { event: string; retryAfterMs: number }) => void;
}

/** Per-socket data attached at handshake. Never read identity from a payload. */
export interface SocketData {
  userId: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  ipHash: string;
  roomId?: string;
  roomCode?: string;
  role?: Role;
}
