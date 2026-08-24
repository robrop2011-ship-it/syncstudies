-- transactVideo.lua — PLAN.md §6.4
--
-- The atomic read-check-write of {revision, status, anchor}. This is the
-- concurrency guarantee that makes §8.5's conflict resolution correct across
-- multiple realtime nodes: two nodes cannot both win, because the check and the
-- write happen inside one Redis execution.
--
-- It is a faithful transliteration of `decideControl` + `applyControl` from
-- packages/shared/src/video.ts. The caller computes the next anchor with
-- `applyControl` (so there is exactly one implementation of the arithmetic) and
-- passes the resulting fields in; this script re-checks the guards against the
-- state as it is RIGHT NOW and refuses the write if they no longer hold.
-- If you change decideControl, change this.
--
-- KEYS[1]  room:{id}:state
-- ARGV[1]  expectedRevision  (-1 skips the check — resync only)
-- ARGV[2]  status
-- ARGV[3]  anchorPos
-- ARGV[4]  anchorServerMs
-- ARGV[5]  rate
-- ARGV[6]  actorId           ('' for a system action, which is never lock-checked)
-- ARGV[7]  nowMs
-- ARGV[8]  lockMs            (CONTROL_LOCK_MS; 0 disables the lock check)
-- ARGV[9]  ttlMs             (ROOM_STATE_TTL_MS)
-- ARGV[10..] optional field,value pairs written in the same transaction
--            (provider/videoRef/title/durationSec for video:set)
--
-- Returns {ok, reason, revision}: {1,'ok',newRev} or {0,'<reason>',currentRev}.

local cur = redis.call('HMGET', KEYS[1], 'revision', 'lastChangeMs', 'lastActorId')
local rev = tonumber(cur[1]) or 0
local lastChange = tonumber(cur[2]) or 0
local lastActor = cur[3]
-- An absent field comes back as `false`; we also normalise the empty string we
-- write for "no actor", because '' is truthy in Lua and would arm the lock.
if lastActor == '' then lastActor = false end

local expected = tonumber(ARGV[1])
if expected >= 0 and expected ~= rev then
  return { 0, 'stale_revision', rev }
end

-- Control lock: another user changed it very recently (§8.5c). The same actor is
-- never locked out of their own follow-ups, so a scrub drag works normally.
if lastActor and lastActor ~= ARGV[6]
   and (tonumber(ARGV[7]) - lastChange) < tonumber(ARGV[8]) then
  return { 0, 'recently_changed', rev }
end

rev = rev + 1
redis.call('HSET', KEYS[1],
  'revision', rev, 'status', ARGV[2], 'anchorPos', ARGV[3],
  'anchorServerMs', ARGV[4], 'rate', ARGV[5], 'lastActorId', ARGV[6],
  'lastChangeMs', ARGV[7])

-- Optional trailing field/value pairs (video metadata on a set_video).
local i = 10
while i < #ARGV do
  redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1])
  i = i + 2
end

redis.call('PEXPIRE', KEYS[1], ARGV[9])
return { 1, 'ok', rev }
