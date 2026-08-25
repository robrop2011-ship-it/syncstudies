# Backlog

Everything here is **out of scope until the MVP (PLAN.md §13) has shipped**.
Add ideas freely. Do not implement them. Do not debate them.

A few entries are marked **[groundwork exists]**. That does not promote them. It means the
schema column, the event, or the server half is already there — because building it later
would otherwise have forced a contract change — and that finishing it is a UI job rather
than an architecture job. Finishing one still requires moving it out of this file first.

## Moved out of this file, and why

**Camera video in call** and **screen sharing** were v1.1 here and are now built.
The reason is that they were specified in full in PLAN §9.4 and §9.6 — bitrate
caps, `scaleResolutionDownBy` per mesh size, the single-holder Redis lock, 5 fps
with `contentHint: 'detail'`, `MESH_VIDEO_MAX_WITH_SHARE` — and building the mesh
transport without them would have meant writing the sender-parameter and
track-mapping code twice. Both are behind the same `CallTransport` seam and both
enforce the §9.1 caps server-side. §13.3 still lists them as v1.1; treat this
paragraph as the amendment.

Everything below is still deliberately not built.

## v1.1 — first six weeks after launch
- Device picker + input level meter
- Chat replies — **[groundwork exists]** `messages.reply_to_id` and `ChatSend.replyToId`
  are real, and `chat:send` validates that the target is in the same room rather than
  ignoring it. No client sends one. What is missing is the quote UI and the reply chip.
- Emoji reactions
- Typing indicator — **[groundwork exists]** `chat:typing` is registered, guarded,
  rate-limited at 1 / 3 s, and broadcasts `{userId}` to the rest of the room. Nothing
  renders it. Do not "finish" it by adding the indicator without moving this line.
- Slow mode — **[groundwork exists]** `rooms.slow_mode_sec` is enforced server-side on
  every send, and hosts and co-hosts bypass it. There is no host control to set it, so it
  is 0 for every room. That is the whole remaining work.
- Room passcode
- Guest access (per-room opt-in)
- Session export to markdown
- Synced Pomodoro timer (reuses the anchor pattern, §8.13)
- Question answer threads + resolve
- Host mute-all — **[groundwork exists]** `host:force_mute` is implemented,
  enforced (a force-muted participant cannot unmute themselves, on the client and
  on the server) and reaches the target across nodes through the room bus. What is
  missing is a "mute everyone" control and the UI to reach the per-person one.

## v1.2
- LiveKit SFU transport behind `CallTransport`
- Playback rate sync
- Room playlist / video queue
- Yjs CRDT shared notes with cursors
- Personal blocking
- Room code regeneration UI
- HTML5 `<video>` PlayerAdapter (direct MP4/HLS)

## Explicitly never, or not without a change of mind

These are not waiting for time. They are decided.

- **Link unfurls / previews in chat** (§3.5 H5). Fetching a URL a stranger posted is an
  SSRF primitive, and rendering a title and thumbnail from it is a phishing surface aimed
  at teenagers. The link is shown in full, as text, with an anchor. That is the feature.
- **File and image uploads in chat** (§3.5 H12). Not without a moderation vendor under
  contract. This is a CSAM liability with under-18 users, not a storage problem.
- **A moderation platform** (§11.6). v1 reads `reports` with SQL. Building a queue UI
  before there is a queue is how a two-person team spends a month on an admin tool.

## Later / needs a real reason
- Public room directory (moderation liability — needs capacity first)
- Scheduled rooms + calendar invites
- Session recording (consent + storage + legal)
- Native mobile apps
- AI summaries / flashcards
- Institutional accounts, SSO, billing
- Internationalization
