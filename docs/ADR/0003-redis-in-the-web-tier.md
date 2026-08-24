# ADR 0003 — The web tier talks to Redis, to invalidate the realtime cache

- **Status:** Accepted
- **Date:** 2026-08-24
- **Applies to:** `apps/web/lib/server/realtime-cache.ts`, the rooms REST API

## Context

The realtime service caches each room's row and policy in Redis under `room:{id}:meta`
(and `code:{code}`) with a one-hour TTL, so a permission check on the hot path is a Redis
read rather than a Postgres round trip. It refreshes that cache itself after any change it
makes — see `ctx.meta.refresh` in `apps/realtime/src/handlers/host.ts`.

The REST tier writes the same columns. `PATCH /api/rooms/:id` changes playback policy;
`DELETE` ends the room. Without invalidation the two tiers disagree for up to an hour, and
the symptoms are severe rather than cosmetic:

- A host ends a room and **everyone stays in it**, because `room:join` reads
  `meta.status` from a cache that still says `active`.
- A host locks playback to host-only and **members keep controlling the video**.

Both were confirmed against a live stack before the fix, and the second one is how the
gap was found — `DELETE` appeared to work while `PATCH` did not, which turned out to be a
cold-start bug in the client rather than a difference between the routes.

## Decision

`apps/web` gets a small `ioredis` client used **only** for cache invalidation, in
`lib/server/realtime-cache.ts`. `PATCH` and `DELETE` call `invalidateRoomCache(roomId, code)`
after their Postgres write.

This is not a new architectural direction: PLAN.md §4.1's topology diagram already draws
the `web` box connecting to Redis, and §11.7 says rate-limit buckets belong there too.

Three properties the implementation must keep:

1. **It never throws.** The durable write has already succeeded, so a Redis outage must
   degrade to "the change lands within the TTL", not turn a successful policy change into
   a 500.
2. **The offline queue stays ON.** The client is created lazily on first use; with
   `enableOfflineQueue: false` the very first command is rejected with "Stream isn't
   writeable" because the socket has not finished connecting. That made the first
   invalidation after every deploy silently fail while every later one worked — the
   hardest possible version of this bug to notice.
3. **Key names are duplicated, not imported.** `apps/web` must not depend on
   `apps/realtime`. The duplication is guarded by a test asserting the strings match
   `apps/realtime/src/redis.ts`.

## Consequences

- `REDIS_URL` must point at the **same** instance the realtime service uses. It is
  documented in `apps/web/.env.example`; unset is tolerated and logged loudly, not fatal.
- The in-process rate limiter in `lib/server/rate-limit.ts` should move onto this client
  when the web tier runs on more than one instance. It has not yet, and that is the
  next obvious use.
- **A durable write that another service caches is only half a write.** Any future REST
  route that touches `rooms` must invalidate too.
