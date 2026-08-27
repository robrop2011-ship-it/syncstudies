/**
 * Tuning constants for the whole system.
 *
 * The sync numbers here are the ones PLAN.md §8.6 tells you to tune against the
 * simulator. They live in one place, shared by client and server, so a change is
 * a one-line diff rather than an archaeology expedition.
 */

// ── Video synchronisation (PLAN.md §8.6) ────────────────────────────────────
/** Below this, drift is indistinguishable from YouTube's own ~4Hz time resolution. */
export const DEAD_ZONE_SEC = 0.35;
/** Above DEAD_ZONE and below this: nudge or micro-seek. */
export const SOFT_MAX_SEC = 1.2;
/** At or above this: hard seek. */
export const HARD_SEEK_AT_SEC = 2.0;
/** Never hard-seek more often than this (anti-stutter-loop). */
export const MIN_HARD_SEEK_GAP_MS = 5_000;
/** Ignore drift measurements for this long after any local seek. */
export const POST_SEEK_BLIND_MS = 700;
/** Minimum gap between micro-seeks in the soft band. */
export const MIN_MICRO_SEEK_GAP_MS = 3_000;
/** Drift loop cadence. */
export const DRIFT_TICK_MS = 500;
/** A drift larger than this is far more likely a clock event than a playback event. */
export const CLOCK_SANITY_DRIFT_SEC = 30;
/** How far ahead to load when joining a playing room, to cover buffering. */
export const JOIN_LOAD_LEAD_SEC = 0.6;
/** Seek-latency EWMA seed and bounds. */
export const SEEK_LATENCY_INIT_MS = 250;
export const SEEK_LATENCY_MIN_MS = 80;
export const SEEK_LATENCY_MAX_MS = 1_200;
export const SEEK_LATENCY_ALPHA = 0.25;

// ── Clock sync (PLAN.md §8.3) ───────────────────────────────────────────────
export const CLOCK_SAMPLES_JOIN = 8;
export const CLOCK_SAMPLES_RESYNC = 4;
export const CLOCK_SAMPLES_VISIBLE = 3;
export const CLOCK_SAMPLES_PERIODIC = 2;
export const CLOCK_SAMPLE_SPACING_MS = 50;
export const CLOCK_RESYNC_INTERVAL_MS = 30_000;
/** Discard pathological samples; they poison the offset estimate. */
export const CLOCK_MAX_RTT_MS = 1_500;
/** EWMA weight for the previous offset on re-sync. */
export const CLOCK_EWMA_PREV = 0.7;

// ── Control conflict resolution (PLAN.md §8.5) ──────────────────────────────
/** After a control from user A, other users are locked out for this long. */
export const CONTROL_LOCK_MS = 600;
/** While dragging the scrubber, emit at most one intermediate seek this often. */
export const SCRUB_EMIT_INTERVAL_MS = 400;

// ── Room / presence lifecycle (PLAN.md §6.3, §8.8) ──────────────────────────
/** How long a dropped participant stays in the list as 'reconnecting'. */
export const DISCONNECT_GRACE_MS = 45_000;
/**
 * The host gets a longer window than everyone else before being removed, because
 * removing them also hands the room to someone else — a costlier, noisier event
 * than a member briefly vanishing. Host transfer happens AT removal, never on a
 * separate timer: a room whose hostId points at someone no longer present cannot
 * be moderated by anyone.
 */
export const HOST_DISCONNECT_GRACE_MS = 60_000;
export const ROOM_HEARTBEAT_MS = 10_000;
export const ROOM_SNAPSHOT_MS = 15_000;
export const ROOM_STATE_TTL_MS = 6 * 60 * 60 * 1000;
export const LEADER_LOCK_TTL_MS = 15_000;
export const LEADER_RENEW_MS = 5_000;
export const BUFFERING_REPORT_AFTER_MS = 1_200;
export const WAIT_FOR_SLOW_MAX_MS = 10_000;

// ── WebRTC caps (PLAN.md §9.1) ──────────────────────────────────────────────
export const MESH_AUDIO_MAX = 8;
export const MESH_VIDEO_MAX = 4;
export const MESH_VIDEO_MAX_WITH_SHARE = 3;
export const TURN_CREDENTIAL_TTL_SEC = 600;
export const AUDIO_MAX_BITRATE = 32_000;
export const VIDEO_MAX_BITRATE = 500_000;
export const SCREEN_MAX_BITRATE = 1_200_000;

// ── Shared annotation ink (PLAN.md §5.4) ────────────────────────────────────
/**
 * Ink is a shared laser pointer, not a whiteboard: a stroke is drawn, held for a
 * beat, fades, and is gone. Both halves of that life are counted from a SERVER
 * timestamp, because a stroke that expires at a different moment for each person
 * stops being the same gesture — one of them is still circling a term that
 * vanished for everyone else.
 */
/** Fully opaque for this long after the stroke was born. */
export const INK_HOLD_MS = 1_500;
/** Then fades to nothing over this. */
export const INK_FADE_MS = 2_500;
export const INK_LIFETIME_MS = INK_HOLD_MS + INK_FADE_MS;
/**
 * Points are batched at 20 Hz rather than sent per pointer event. A pointermove
 * stream reaches 120 Hz on a good trackpad, and six of those in one room is a
 * message rate a study group should not have to pay for to point at a word.
 */
export const INK_EMIT_INTERVAL_MS = 50;
export const INK_MAX_POINTS_PER_MESSAGE = 64;
/** A stroke past this is truncated; a lecture-long unbroken scribble is a bug. */
export const INK_MAX_POINTS_PER_STROKE = 400;
/** Per room, oldest dropped first, so nobody can paper over the video. */
export const INK_MAX_ACTIVE_STROKES = 32;
/** CSS px at the stage's rendered size, not at the canvas backing size. */
export const INK_STROKE_WIDTH = 3;

// ── Limits ──────────────────────────────────────────────────────────────────
export const MAX_MESSAGE_LENGTH = 2000;
export const MAX_NOTE_LENGTH = 1000;
export const MAX_CHECKLIST_LABEL = 200;
export const MAX_DISPLAY_NAME = 40;
export const MAX_BIO = 140;
export const MAX_SCHOOL = 80;
export const MAX_ROOM_NAME = 60;
export const MAX_ROOM_TOPIC = 120;
export const DEFAULT_MAX_PARTICIPANTS = 8;
export const ROOM_PARTICIPANTS_FLOOR = 2;
export const ROOM_PARTICIPANTS_CEILING = 25;
export const MESSAGE_PAGE_SIZE = 50;
export const INITIAL_MESSAGE_COUNT = 50;
/**
 * Ceiling on a reconnect backfill (§8.8).
 *
 * A client that was away for two minutes gets everything it missed. A client
 * that was away for an hour in a busy room gets the newest 200 and fills the
 * rest by scrolling, which is what the pagination endpoint is for. Shared,
 * because the client has to recognise a page of exactly this size as "there is
 * a gap behind this" rather than "this is the whole story".
 */
export const MESSAGE_BACKFILL_MAX = 200;

// ── Accounts (PLAN.md Amendment A1) ─────────────────────────────────────────
export const MIN_PASSWORD_LENGTH = 6;
export const MAX_PASSWORD_LENGTH = 200;
export const HANDLE_MIN = 3;
export const HANDLE_MAX = 20;
export const MIN_SIGNUP_AGE = 13;
export const MINOR_AGE_CEILING = 18;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Sliding-expiry refresh: only rewrite the row when this much has elapsed. */
export const SESSION_REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;
export const RECOVERY_CODE_GROUPS = 6;
export const RECOVERY_CODE_GROUP_LEN = 4;
