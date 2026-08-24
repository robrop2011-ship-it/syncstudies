-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "handle" VARCHAR(20) NOT NULL,
    "display_name" VARCHAR(40) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "recovery_hash" TEXT,
    "recovery_issued_at" TIMESTAMPTZ,
    "avatar_key" TEXT,
    "bio" VARCHAR(140),
    "school" VARCHAR(80),
    "is_guest" BOOLEAN NOT NULL DEFAULT false,
    "guest_expires_at" TIMESTAMPTZ,
    "is_minor" BOOLEAN NOT NULL DEFAULT false,
    "status" VARCHAR(16) NOT NULL DEFAULT 'active',
    "suspended_until" TIMESTAMPTZ,
    "deleted_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_settings" (
    "user_id" UUID NOT NULL,
    "profile_visibility" VARCHAR(16) NOT NULL DEFAULT 'rooms_only',
    "show_online_status" BOOLEAN NOT NULL DEFAULT true,
    "default_room_privacy" VARCHAR(16) NOT NULL DEFAULT 'private',
    "theme" VARCHAR(8) NOT NULL DEFAULT 'system',
    "default_mic_id" TEXT,
    "default_camera_id" TEXT,
    "default_speaker_id" TEXT,
    "join_muted" BOOLEAN NOT NULL DEFAULT true,
    "join_camera_off" BOOLEAN NOT NULL DEFAULT true,
    "push_to_talk" BOOLEAN NOT NULL DEFAULT false,
    "reduce_motion" BOOLEAN NOT NULL DEFAULT false,
    "hide_ip_from_peers" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "user_settings_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip_hash" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rooms" (
    "id" UUID NOT NULL,
    "code" VARCHAR(8) NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "topic" VARCHAR(120),
    "host_id" UUID NOT NULL,
    "privacy" VARCHAR(16) NOT NULL DEFAULT 'private',
    "passcode_hash" TEXT,
    "max_participants" SMALLINT NOT NULL DEFAULT 8,
    "allow_guests" BOOLEAN NOT NULL DEFAULT false,
    "playback_control" VARCHAR(20) NOT NULL DEFAULT 'everyone',
    "chat_locked" BOOLEAN NOT NULL DEFAULT false,
    "slow_mode_sec" SMALLINT NOT NULL DEFAULT 0,
    "wait_for_slow" BOOLEAN NOT NULL DEFAULT false,
    "call_enabled" BOOLEAN NOT NULL DEFAULT true,
    "screenshare_enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" VARCHAR(16) NOT NULL DEFAULT 'active',
    "last_active_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ,

    CONSTRAINT "rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_participants" (
    "room_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" VARCHAR(10) NOT NULL DEFAULT 'member',
    "first_joined_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_joined_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMPTZ,
    "total_seconds" INTEGER NOT NULL DEFAULT 0,
    "force_muted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "room_participants_pkey" PRIMARY KEY ("room_id","user_id")
);

-- CreateTable
CREATE TABLE "room_bans" (
    "room_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "banned_by" UUID NOT NULL,
    "reason" VARCHAR(200),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "room_bans_pkey" PRIMARY KEY ("room_id","user_id")
);

-- CreateTable
CREATE TABLE "room_video_state" (
    "room_id" UUID NOT NULL,
    "provider" VARCHAR(10) NOT NULL DEFAULT 'none',
    "video_ref" TEXT,
    "title" TEXT,
    "duration_sec" INTEGER,
    "status" VARCHAR(10) NOT NULL DEFAULT 'paused',
    "anchor_position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "anchor_server_ms" BIGINT NOT NULL DEFAULT 0,
    "playback_rate" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "revision" BIGINT NOT NULL DEFAULT 0,
    "last_actor_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "room_video_state_pkey" PRIMARY KEY ("room_id")
);

-- CreateTable
CREATE TABLE "room_video_history" (
    "id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "provider" VARCHAR(10) NOT NULL,
    "video_ref" TEXT NOT NULL,
    "title" TEXT,
    "duration_sec" INTEGER,
    "added_by" UUID,
    "watched_sec" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ,

    CONSTRAINT "room_video_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "user_id" UUID,
    "client_msg_id" TEXT,
    "body" TEXT NOT NULL,
    "kind" VARCHAR(8) NOT NULL DEFAULT 'user',
    "reply_to_id" UUID,
    "video_ts" DOUBLE PRECISION,
    "deleted_at" TIMESTAMPTZ,
    "deleted_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_notes" (
    "room_id" UUID NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "ydoc" BYTEA,
    "version" BIGINT NOT NULL DEFAULT 0,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "room_notes_pkey" PRIMARY KEY ("room_id")
);

-- CreateTable
CREATE TABLE "note_items" (
    "id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "user_id" UUID,
    "kind" VARCHAR(10) NOT NULL,
    "body" VARCHAR(1000) NOT NULL,
    "video_ref" TEXT,
    "video_ts" DOUBLE PRECISION,
    "resolved_at" TIMESTAMPTZ,
    "resolved_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "note_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "note_replies" (
    "id" UUID NOT NULL,
    "note_item_id" UUID NOT NULL,
    "user_id" UUID,
    "body" VARCHAR(1000) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "note_replies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checklist_items" (
    "id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "label" VARCHAR(200) NOT NULL,
    "position" DOUBLE PRECISION NOT NULL,
    "created_by" UUID,
    "completed_at" TIMESTAMPTZ,
    "completed_by" UUID,
    "video_ts" DOUBLE PRECISION,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checklist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "study_sessions" (
    "id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "joined_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMPTZ,
    "seconds" INTEGER,
    "in_call_seconds" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "study_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" UUID NOT NULL,
    "reporter_id" UUID,
    "target_type" VARCHAR(10) NOT NULL,
    "target_id" UUID NOT NULL,
    "room_id" UUID,
    "message_id" UUID,
    "reason" VARCHAR(20) NOT NULL,
    "details" VARCHAR(1000),
    "snapshot" JSONB,
    "status" VARCHAR(12) NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_events" (
    "id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "actor_id" UUID,
    "type" VARCHAR(32) NOT NULL,
    "payload" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "room_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_handle_key" ON "users"("handle");

-- CreateIndex
CREATE INDEX "users_guest_expiry_idx" ON "users"("guest_expires_at");

-- CreateIndex
CREATE INDEX "auth_sessions_user_idx" ON "auth_sessions"("user_id");

-- CreateIndex
CREATE INDEX "auth_sessions_expiry_idx" ON "auth_sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "rooms_code_key" ON "rooms"("code");

-- CreateIndex
CREATE INDEX "rooms_host_idx" ON "rooms"("host_id");

-- CreateIndex
CREATE INDEX "rooms_active_idx" ON "rooms"("last_active_at" DESC);

-- CreateIndex
CREATE INDEX "room_participants_user_idx" ON "room_participants"("user_id", "last_joined_at" DESC);

-- CreateIndex
CREATE INDEX "room_video_history_room_idx" ON "room_video_history"("room_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "messages_room_time_idx" ON "messages"("room_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "messages_client_dedupe_idx" ON "messages"("room_id", "user_id", "client_msg_id");

-- CreateIndex
CREATE INDEX "note_items_room_ts_idx" ON "note_items"("room_id", "video_ts");

-- CreateIndex
CREATE INDEX "checklist_room_pos_idx" ON "checklist_items"("room_id", "position");

-- CreateIndex
CREATE INDEX "study_sessions_user_idx" ON "study_sessions"("user_id", "joined_at" DESC);

-- CreateIndex
CREATE INDEX "reports_status_idx" ON "reports"("status", "created_at");

-- CreateIndex
CREATE INDEX "room_events_room_idx" ON "room_events"("room_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_host_id_fkey" FOREIGN KEY ("host_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_participants" ADD CONSTRAINT "room_participants_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_participants" ADD CONSTRAINT "room_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_bans" ADD CONSTRAINT "room_bans_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_bans" ADD CONSTRAINT "room_bans_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_bans" ADD CONSTRAINT "room_bans_banned_by_fkey" FOREIGN KEY ("banned_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_video_state" ADD CONSTRAINT "room_video_state_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_video_state" ADD CONSTRAINT "room_video_state_last_actor_id_fkey" FOREIGN KEY ("last_actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_video_history" ADD CONSTRAINT "room_video_history_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_video_history" ADD CONSTRAINT "room_video_history_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_id_fkey" FOREIGN KEY ("reply_to_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_deleted_by_fkey" FOREIGN KEY ("deleted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_notes" ADD CONSTRAINT "room_notes_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_notes" ADD CONSTRAINT "room_notes_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_items" ADD CONSTRAINT "note_items_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_items" ADD CONSTRAINT "note_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_items" ADD CONSTRAINT "note_items_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_replies" ADD CONSTRAINT "note_replies_note_item_id_fkey" FOREIGN KEY ("note_item_id") REFERENCES "note_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_replies" ADD CONSTRAINT "note_replies_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_items" ADD CONSTRAINT "checklist_items_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_items" ADD CONSTRAINT "checklist_items_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_items" ADD CONSTRAINT "checklist_items_completed_by_fkey" FOREIGN KEY ("completed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_sessions" ADD CONSTRAINT "study_sessions_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_sessions" ADD CONSTRAINT "study_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_events" ADD CONSTRAINT "room_events_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_events" ADD CONSTRAINT "room_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
