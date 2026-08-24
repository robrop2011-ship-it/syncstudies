-- rateLimit.lua — PLAN.md §11.7
--
-- INCR + PEXPIRE in one script, so a burst arriving on two nodes at the same
-- millisecond cannot both see n == 1 and both re-arm the window.
--
-- KEYS[1]  rl:{scope}:{id}
-- ARGV[1]  limit
-- ARGV[2]  windowMs
--
-- Returns {allowed, retryAfterMs}.

local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
if n > tonumber(ARGV[1]) then
  local ttl = redis.call('PTTL', KEYS[1])
  -- Hardening: a counter that somehow lost its expiry would lock the caller out
  -- forever. Re-arm rather than serve a permanent 'too many requests'.
  if ttl < 0 then
    redis.call('PEXPIRE', KEYS[1], ARGV[2])
    ttl = tonumber(ARGV[2])
  end
  return { 0, ttl }
end
return { 1, 0 }
