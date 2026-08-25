/**
 * The wire contract (PLAN.md §10.3).
 *
 * Write the schema, infer the type, never hand-write a payload interface twice.
 * Server handlers call `.parse()` before touching a payload; the client gets the
 * same types from the same file, so a mismatch is a compile error rather than a
 * 2am production mystery.
 */
import { z } from 'zod';
import * as C from './constants';

// ── primitives ──────────────────────────────────────────────────────────────
export const Uuid = z.string().uuid();
export const RoomCode = z.string().length(8).regex(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]+$/);
export const Handle = z
  .string()
  .min(C.HANDLE_MIN)
  .max(C.HANDLE_MAX)
  .regex(/^[a-zA-Z0-9_]+$/, 'Letters, numbers and underscores only')
  .transform((h) => h.toLowerCase());
export const DisplayName = z.string().trim().min(1).max(C.MAX_DISPLAY_NAME);
export const Password = z.string().min(C.MIN_PASSWORD_LENGTH).max(C.MAX_PASSWORD_LENGTH);
export const RoleSchema = z.enum(['host', 'co_host', 'member', 'guest']);
export const PlaybackControlSchema = z.enum(['everyone', 'host_and_cohosts', 'host_only']);
export const PlaybackStatusSchema = z.enum(['idle', 'playing', 'paused', 'ended']);
export const ProviderSchema = z.enum(['youtube', 'file', 'none']);

export type Role = z.infer<typeof RoleSchema>;
export type PlaybackControl = z.infer<typeof PlaybackControlSchema>;
export type PlaybackStatus = z.infer<typeof PlaybackStatusSchema>;
export type Provider = z.infer<typeof ProviderSchema>;

// ── auth (Amendment A1: username + password, no email) ──────────────────────
export const SignupInput = z.object({
  handle: Handle,
  displayName: DisplayName,
  password: Password,
  /** Used only to derive `is_minor` and enforce the 13+ floor. Never stored raw. */
  birthYear: z.number().int().min(1900).max(new Date().getUTCFullYear()),
});
export type SignupInput = z.infer<typeof SignupInput>;

export const LoginInput = z.object({
  handle: Handle,
  password: z.string().min(1).max(C.MAX_PASSWORD_LENGTH),
});
export type LoginInput = z.infer<typeof LoginInput>;

export const ChangePasswordInput = z.object({
  currentPassword: z.string().min(1).max(C.MAX_PASSWORD_LENGTH),
  newPassword: Password,
});
export type ChangePasswordInput = z.infer<typeof ChangePasswordInput>;

export const RecoverInput = z.object({
  handle: Handle,
  recoveryCode: z.string().min(8).max(64),
  newPassword: Password,
});
export type RecoverInput = z.infer<typeof RecoverInput>;

export const UpdateProfileInput = z.object({
  displayName: DisplayName.optional(),
  bio: z.string().max(C.MAX_BIO).nullable().optional(),
  school: z.string().max(C.MAX_SCHOOL).nullable().optional(),
});
export type UpdateProfileInput = z.infer<typeof UpdateProfileInput>;

export const UpdateSettingsInput = z.object({
  profileVisibility: z.enum(['public', 'rooms_only', 'private']).optional(),
  showOnlineStatus: z.boolean().optional(),
  theme: z.enum(['system', 'light', 'dark']).optional(),
  joinMuted: z.boolean().optional(),
  joinCameraOff: z.boolean().optional(),
  pushToTalk: z.boolean().optional(),
  reduceMotion: z.boolean().optional(),
  hideIpFromPeers: z.boolean().optional(),
});
export type UpdateSettingsInput = z.infer<typeof UpdateSettingsInput>;

// ── rooms ───────────────────────────────────────────────────────────────────
export const CreateRoomInput = z.object({
  name: z.string().trim().min(1).max(C.MAX_ROOM_NAME),
  topic: z.string().trim().max(C.MAX_ROOM_TOPIC).nullable().optional(),
  maxParticipants: z
    .number()
    .int()
    .min(C.ROOM_PARTICIPANTS_FLOOR)
    .max(C.ROOM_PARTICIPANTS_CEILING)
    .optional(),
  playbackControl: PlaybackControlSchema.optional(),
});
export type CreateRoomInput = z.infer<typeof CreateRoomInput>;

export const UpdateRoomPolicyInput = z.object({
  name: z.string().trim().min(1).max(C.MAX_ROOM_NAME).optional(),
  topic: z.string().trim().max(C.MAX_ROOM_TOPIC).nullable().optional(),
  playbackControl: PlaybackControlSchema.optional(),
  chatLocked: z.boolean().optional(),
  slowModeSec: z.number().int().min(0).max(300).optional(),
  waitForSlow: z.boolean().optional(),
  callEnabled: z.boolean().optional(),
  screenshareEnabled: z.boolean().optional(),
  maxParticipants: z
    .number()
    .int()
    .min(C.ROOM_PARTICIPANTS_FLOOR)
    .max(C.ROOM_PARTICIPANTS_CEILING)
    .optional(),
});
export type UpdateRoomPolicyInput = z.infer<typeof UpdateRoomPolicyInput>;

// ── socket: clock ───────────────────────────────────────────────────────────
export const TimePing = z.object({ t0: z.number() });
export type TimePing = z.infer<typeof TimePing>;
export const TimePong = z.object({ t0: z.number(), serverMs: z.number() });
export type TimePong = z.infer<typeof TimePong>;

// ── socket: room ────────────────────────────────────────────────────────────
export const RoomJoin = z.object({
  roomCode: RoomCode,
  /**
   * The newest message this client already has, if any.
   *
   * A reconnect goes through `room:join`, not `room:resync` (socket.io builds a
   * brand new server-side socket, so there is no room to resync into), which is
   * why the backfill cursor has to be accepted on both.
   */
  lastMessageId: Uuid.optional(),
});
export type RoomJoin = z.infer<typeof RoomJoin>;

export const RoomResync = z.object({
  lastRevision: z.number().int().optional(),
  lastMessageId: Uuid.optional(),
});
export type RoomResync = z.infer<typeof RoomResync>;

// ── socket: video ───────────────────────────────────────────────────────────
export const VideoSet = z.object({
  provider: ProviderSchema,
  videoRef: z.string().min(1).max(500),
  title: z.string().max(300).nullable().optional(),
  durationSec: z.number().min(0).max(86400).nullable().optional(),
});
export type VideoSet = z.infer<typeof VideoSet>;

export const VideoControl = z
  .object({
    action: z.enum(['play', 'pause', 'seek', 'rate']),
    positionSec: z.number().min(0).max(86400).optional(),
    rate: z.number().min(0.25).max(2).optional(),
    clientSentAtMs: z.number().int(),
    expectedRevision: z.number().int().min(-1),
  })
  .refine((v) => v.action !== 'seek' || v.positionSec !== undefined, {
    message: 'seek requires positionSec',
    path: ['positionSec'],
  })
  .refine((v) => v.action !== 'rate' || v.rate !== undefined, {
    message: 'rate requires rate',
    path: ['rate'],
  });
export type VideoControl = z.infer<typeof VideoControl>;

export const VideoBuffering = z.object({
  buffering: z.boolean(),
  positionSec: z.number().min(0).max(86400),
});
export type VideoBuffering = z.infer<typeof VideoBuffering>;

export const VideoReportDrift = z.object({
  driftP50: z.number(),
  driftP95: z.number(),
  hardSeeks: z.number().int().min(0),
  clockOffsetMs: z.number(),
});
export type VideoReportDrift = z.infer<typeof VideoReportDrift>;

// ── socket: chat ────────────────────────────────────────────────────────────
export const ChatSend = z.object({
  clientMsgId: z.string().min(1).max(64),
  body: z.string().trim().min(1).max(C.MAX_MESSAGE_LENGTH),
  replyToId: Uuid.optional(),
  videoTs: z.number().min(0).max(86400).optional(),
});
export type ChatSend = z.infer<typeof ChatSend>;

export const ChatDelete = z.object({ messageId: Uuid });
export type ChatDelete = z.infer<typeof ChatDelete>;

// ── socket: notes & checklist ───────────────────────────────────────────────
export const NoteBlockFocus = z.object({ blockId: z.string().min(1).max(64) });
export type NoteBlockFocus = z.infer<typeof NoteBlockFocus>;

export const NoteBlockUpdate = z.object({
  blockId: z.string().min(1).max(64),
  text: z.string().max(20000),
  baseVersion: z.number().int().min(0),
});
export type NoteBlockUpdate = z.infer<typeof NoteBlockUpdate>;

export const NoteItemCreate = z.object({
  kind: z.enum(['note', 'question', 'bookmark']),
  body: z.string().trim().min(1).max(C.MAX_NOTE_LENGTH),
  videoTs: z.number().min(0).max(86400).nullable().optional(),
});
export type NoteItemCreate = z.infer<typeof NoteItemCreate>;

export const NoteItemUpdate = z.object({
  id: Uuid,
  body: z.string().trim().min(1).max(C.MAX_NOTE_LENGTH).optional(),
  resolved: z.boolean().optional(),
});
export type NoteItemUpdate = z.infer<typeof NoteItemUpdate>;

export const ChecklistCreate = z.object({
  label: z.string().trim().min(1).max(C.MAX_CHECKLIST_LABEL),
  videoTs: z.number().min(0).max(86400).nullable().optional(),
});
export type ChecklistCreate = z.infer<typeof ChecklistCreate>;

export const ChecklistToggle = z.object({ id: Uuid, completed: z.boolean() });
export type ChecklistToggle = z.infer<typeof ChecklistToggle>;

export const ChecklistReorder = z.object({ id: Uuid, position: z.number() });
export type ChecklistReorder = z.infer<typeof ChecklistReorder>;

// ── socket: presence & rtc ──────────────────────────────────────────────────
export const PresencePatch = z.object({
  muted: z.boolean().optional(),
  camOn: z.boolean().optional(),
  sharing: z.boolean().optional(),
  speaking: z.boolean().optional(),
  inCall: z.boolean().optional(),
});
export type PresencePatch = z.infer<typeof PresencePatch>;

export const RtcJoin = z.object({ audio: z.boolean(), video: z.boolean() });
export type RtcJoin = z.infer<typeof RtcJoin>;

/** SDP is relayed verbatim and never parsed server-side (PLAN.md §9.2). */
export const RtcSignal = z.object({
  to: Uuid,
  kind: z.enum(['offer', 'answer', 'candidate', 'track_map']),
  sdp: z.string().max(64_000).optional(),
  candidate: z.unknown().optional(),
  trackMap: z.record(z.string().max(64), z.enum(['camera', 'mic', 'screen', 'screen_audio'])).optional(),
});
export type RtcSignal = z.infer<typeof RtcSignal>;

// ── socket: host actions ────────────────────────────────────────────────────
export const HostTargetUser = z.object({ userId: Uuid });
export type HostTargetUser = z.infer<typeof HostTargetUser>;

export const HostBan = z.object({ userId: Uuid, reason: z.string().max(200).optional() });
export type HostBan = z.infer<typeof HostBan>;

export const HostSetRole = z.object({ userId: Uuid, role: z.enum(['co_host', 'member']) });
export type HostSetRole = z.infer<typeof HostSetRole>;

export const HostForceMute = z.object({ userId: Uuid, muted: z.boolean() });
export type HostForceMute = z.infer<typeof HostForceMute>;

// ── reports ─────────────────────────────────────────────────────────────────
export const CreateReportInput = z.object({
  targetType: z.enum(['message', 'user', 'room', 'note']),
  targetId: Uuid,
  roomId: Uuid.optional(),
  reason: z.enum(['harassment', 'sexual_content', 'spam', 'hate', 'self_harm', 'other']),
  details: z.string().max(1000).optional(),
});
export type CreateReportInput = z.infer<typeof CreateReportInput>;
