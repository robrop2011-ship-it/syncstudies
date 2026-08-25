# Deployment runbook

PLAN.md §16 is the architecture. This is the sequence, in order, with the things
that go wrong called out where they go wrong.

**Everything below is written and configured. Nothing is deployed** — that needs
accounts (Vercel, Fly, Neon, Upstash, Cloudflare, Hetzner) that this repository
does not have.

---

## 1. Topology

| Piece | Where | Why not somewhere simpler |
|---|---|---|
| `apps/web` | Vercel | Stateless; every route is a request/response |
| `apps/realtime` | Fly.io, 2 machines, one region | Holds WebSockets and per-room state. **Must be a long-lived container.** |
| Postgres | Neon | PITR, branching for migration rehearsals |
| Redis | Upstash | The live tier; both apps must point at the **same instance** (ADR 0003) |
| coturn | One Hetzner CX22 | TURN is bandwidth-bound, not CPU-bound |
| Avatars | Cloudflare R2 | Never served from the app origin (§11.8) |

### DNS

| Name | Points at | Cloudflare proxy |
|---|---|---|
| `syncstudy.app` | Vercel | Yes |
| `rt.syncstudy.app` | Fly | **No** — unless you have verified WebSocket support end to end |
| `turn.syncstudy.app` | The coturn box | **Never.** TURN is UDP; proxying it breaks it |
| `cdn.syncstudy.app` | R2 bucket | Yes |

---

## 2. Order of operations

Provisioning out of order costs an afternoon, because each step needs the
previous one's connection string.

1. **Neon.** Create the project and a `prod` branch. Keep the pooled and direct
   URLs apart: migrations need the direct one.
2. **Upstash.** Create the database. Copy the `rediss://` URL.
3. **coturn.** `infra/coturn/turnserver.conf` is already hardened. Generate the
   static auth secret with `openssl rand -hex 32` and put it in
   `static-auth-secret`. Open 3478/udp, 3478/tcp and 5349/tcp. Verify the
   `denied-peer-ip` block is present — without it your TURN server is a proxy
   into your own private network, and that is a well-known and actively
   scanned-for misconfiguration.
4. **Fly.**
   ```bash
   fly apps create syncstudy-rt
   fly secrets set --app syncstudy-rt \
     DATABASE_URL='postgresql://…'      \
     REDIS_URL='rediss://…'             \
     IP_HASH_SALT="$(openssl rand -base64 32)" \
     TURN_SECRET='…the coturn secret…'  \
     TURN_URLS='turn:turn.syncstudy.app:3478?transport=udp,turn:turn.syncstudy.app:3478?transport=tcp,turns:turn.syncstudy.app:5349?transport=tcp' \
     STUN_URLS='stun:turn.syncstudy.app:3478,stun:stun.l.google.com:19302' \
     ALLOWED_ORIGINS='https://syncstudy.app' \
     NODE_ENV=production
   fly deploy --config infra/fly.realtime.toml
   ```
5. **Vercel.** Import the repo, root directory `apps/web`, and set:
   `DATABASE_URL`, `REDIS_URL`, `APP_ORIGIN=https://syncstudy.app`,
   `NEXT_PUBLIC_APP_URL=https://syncstudy.app`,
   `NEXT_PUBLIC_REALTIME_URL=https://rt.syncstudy.app`,
   `NEXT_PUBLIC_AVATAR_BASE_URL=https://cdn.syncstudy.app`,
   `IP_HASH_SALT` (**the same value as Fly** — different salts mean the two
   services compute different hashes for the same address and the connection cap
   silently stops working).

### Things that bite here

- **`NEXT_PUBLIC_REALTIME_URL` is baked into the client bundle at build time.**
  Changing it needs a redeploy, not an environment update.
- **The CSP names the realtime origin.** `next.config.ts` derives `connect-src`
  from `NEXT_PUBLIC_REALTIME_URL`; if that is wrong the socket is blocked by the
  browser with a console error and no server-side symptom at all.
- **`ALLOWED_ORIGINS` on Fly must be the exact scheme and host.** A trailing
  slash or `http://` fails every handshake with `bad_origin`.

---

## 3. Migrations

```bash
# Rehearse against a Neon branch first — this is the whole point of branching.
neon branches create --name migration-rehearsal --parent prod
DATABASE_URL='…branch url…' pnpm --filter @syncstudy/db exec prisma migrate deploy

# Then production, gated on a green CI run and a human approval.
DATABASE_URL='…prod direct url…' pnpm --filter @syncstudy/db exec prisma migrate deploy
```

Never `prisma db push` against production. It has no migration history, so the
next `migrate deploy` finds a schema it cannot reconcile and refuses.

---

## 4. Deploying, and what a deploy costs a user

Fly's rolling strategy plus the drain in `apps/realtime/src/server.ts` means a
deploy costs each user about a second and no state:

1. `io.engine.close()` — no new connections.
2. `sys:notice` "Reconnecting…" so the UI shows a bar rather than an error.
3. Every socket disconnected; the client's backoff lands it on a new machine.
4. Wait-for-slow rooms resumed, tickers stopped, led rooms snapshotted.
5. Leadership released rather than left to expire.
6. **The chat write-behind queue drained.** This is the one step with no
   fallback: unlike video state, an unwritten message is reconstructible from
   nowhere.
7. Notes flushed, bus stopped, HTTP closed, Prisma and Redis disconnected.

The 20-second hard exit in `index.ts` is the backstop for a Postgres that has
stopped answering.

**Verify it under load before trusting it** (§15.5's fifth scenario):

```bash
# terminal 1 — generate load against the deployed service
cd apps/realtime
RT_URL=https://rt.syncstudy.app npx tsx --env-file=.env scripts/load-test.mjs \
  --sockets 200 --rooms 20 --seconds 120

# terminal 2 — deploy into it
fly deploy --config infra/fly.realtime.toml
```

Target: under 2% of clients need a manual reload.

---

## 5. Rollback

```bash
fly releases --app syncstudy-rt
fly deploy --image registry.fly.io/syncstudy-rt:<previous-tag>
```

Vercel rolls back from its dashboard by promoting a previous deployment.

**Execute a rollback in staging at least once before launch.** A rollback path
nobody has run is a rollback path you are testing for the first time during an
incident. §14 Phase 10's definition of done says exactly this.

A database migration does **not** roll back with the deploy. Write migrations so
the previous release still runs against the new schema — add columns, do not
rename them; drop a column one release after the code that used it is gone.

---

## 6. Monitoring

`/metrics` on the realtime service is Prometheus text. The four that matter:

| Metric | Alert when | Why |
|---|---|---|
| `ss_video_drift_seconds` p95 | > 1 s for 5 min | The product has stopped working, whatever else is green |
| `ss_write_behind_depth` | climbing and not returning | Messages people can read are ahead of messages that will survive a restart |
| `nodejs_eventloop_lag_p99_seconds` | > 0.05 | Everything else is about to get worse |
| `ss_ice_grants_total{relay="stun"}` | non-zero in production | `TURN_SECRET` is missing, and 10–15% of peer pairs silently cannot connect |

`/health` returns 503 when Postgres or Redis is unreachable, and is what Fly's
check reads. `pendingWrites` is reported but deliberately excluded from `ok`: a
backed-up queue is a reason to look, not a reason to take a machine holding live
WebSockets out of rotation.

---

## 7. Before the soft launch

- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm build` green on `main`
- [ ] `pnpm --filter @syncstudy/realtime test:integration` green against the real services
- [ ] Load test run against staging, §15.5 targets recorded
- [ ] A rollback executed in staging
- [ ] Neon PITR verified by restoring into a scratch branch **and reading a row out of it**
- [ ] `ss_ice_grants_total{relay="turn"}` non-zero after one real call
- [ ] A relayed call verified from a network with UDP blocked (tether through a phone)
- [ ] Legal pages reachable: `/privacy`, `/terms`, `/about`
- [ ] `SECURITY.md` contact address monitored
- [ ] Two realtime machines running, and presence verified to cross between them
