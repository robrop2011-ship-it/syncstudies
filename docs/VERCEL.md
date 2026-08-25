# Deploying to Vercel for a personal test

**Read this first: Vercel hosts half of SyncStudy.**

`apps/web` is stateless and fits Vercel exactly. `apps/realtime` does not and
cannot — it holds long-lived WebSocket connections and per-room state, and a
serverless function has neither. Deploying only to Vercel gives you a site where
you can sign up, sign in, create a room and copy its link, and where **opening
that room shows "Can't reach the realtime server"**. Video sync, chat, voice and
notes all live on the socket.

So this is a two-service deploy. It takes about twenty minutes.

---

## What you need

| Piece | Free option | What it is for |
|---|---|---|
| Postgres | [Neon](https://neon.tech) | Durable truth: accounts, rooms, messages, notes |
| Redis | [Upstash](https://upstash.com) | Live truth: video anchor, presence, rate limits |
| Vercel | free | `apps/web` |
| A container host | Render / Railway / Fly.io | `apps/realtime` |

**Both services must point at the same Postgres and the same Redis.** The web
tier invalidates the realtime tier's room cache through Redis (ADR 0003); two
different instances means a host can end a room and nobody leaves it.

---

## 1. Postgres and Redis

Create a Neon project and an Upstash database. Copy:

- Neon's **pooled** connection string → `DATABASE_URL` for both services.
- Neon's **direct** connection string → only for running migrations.
- Upstash's `rediss://` URL → `REDIS_URL` for both services.

Then create the schema, from your machine:

```bash
DATABASE_URL='<neon direct url>' pnpm --filter @syncstudy/db exec prisma migrate deploy
```

Optionally seed two accounts to log in with:

```bash
DATABASE_URL='<neon direct url>' pnpm db:seed
# priya / studytogether1, and sam / studytogether1
```

Generate one salt now and keep it — **both** services need the identical value:

```bash
openssl rand -base64 32
```

---

## 2. The realtime service

Any container host works; the image is `apps/realtime/Dockerfile` with the
**repo root** as its build context.

**Render** — `render.yaml` in this repo is a blueprint. New → Blueprint → pick
the repo, then set `DATABASE_URL`, `REDIS_URL`, `IP_HASH_SALT` and
`ALLOWED_ORIGINS` in the dashboard.

**Railway** — New Project → Deploy from repo → set the Dockerfile path to
`apps/realtime/Dockerfile`, root directory `/`. Add the same four variables.

**Fly.io** — `infra/fly.realtime.toml` is already written; see `docs/DEPLOY.md`.

Set these:

| Variable | Value |
|---|---|
| `DATABASE_URL` | the Neon pooled URL |
| `REDIS_URL` | the Upstash `rediss://` URL |
| `IP_HASH_SALT` | the salt from step 1 |
| `ALLOWED_ORIGINS` | your Vercel URL, exactly — `https://yourapp.vercel.app`, no trailing slash |
| `NODE_ENV` | `production` |

Then check it:

```bash
curl https://your-realtime-host/health
# {"ok":true,"version":"0.1.0","db":true,"redis":true,"pendingWrites":0}
```

If `db` or `redis` is `false`, fix that before going further — the web app will
deploy happily and the rooms will not work.

---

## 3. Vercel

Import the repo. **Leave the root directory as the repository root** —
`vercel.json` already tells Vercel where the Next.js app is and how to build it:

```json
"buildCommand": "pnpm --filter @syncstudy/db exec prisma generate && pnpm --filter @syncstudy/web build",
"outputDirectory": "apps/web/.next"
```

Environment variables:

| Variable | Value |
|---|---|
| `DATABASE_URL` | the Neon pooled URL |
| `REDIS_URL` | the Upstash `rediss://` URL |
| `IP_HASH_SALT` | **the same salt as the realtime service** |
| `APP_ORIGIN` | `https://yourapp.vercel.app` |
| `NEXT_PUBLIC_APP_URL` | `https://yourapp.vercel.app` |
| `NEXT_PUBLIC_REALTIME_URL` | `https://your-realtime-host` |

### The chicken-and-egg, and how to break it

`ALLOWED_ORIGINS` on the realtime service needs the Vercel URL, and
`NEXT_PUBLIC_REALTIME_URL` on Vercel needs the realtime URL. Deploy Vercel
first with a placeholder realtime URL, note the domain Vercel gives you, set
`ALLOWED_ORIGINS` on the realtime service, then set the real
`NEXT_PUBLIC_REALTIME_URL` on Vercel and **redeploy**.

The redeploy is not optional. `NEXT_PUBLIC_*` variables are compiled into the
browser bundle at build time, so changing one in the dashboard does nothing
until the next build.

---

## 4. Check it actually works

1. Open the site. The marketing page, `/about`, `/privacy` and `/terms` load.
2. Sign up, or sign in as `priya` / `studytogether1` if you seeded.
3. Create a room. It opens, and the top bar says **Connected** — not "Offline".
4. Paste a YouTube link. It loads and plays.
5. Open the room link in a second browser (or a private window, signed in as
   `sam`). Both participants appear in the list.
6. Press play in one. The other follows.
7. Send a chat message. It arrives in the other window.
8. Open Notes, add a paragraph. It appears in the other window as you type.
9. Press `?`, pin a question. A tick appears on the scrubber in both.
10. Click "Join voice" in both. You should hear yourself — use headphones.

If step 3 says "Offline", the problem is one of exactly three things:
`NEXT_PUBLIC_REALTIME_URL` wrong or not rebuilt, `ALLOWED_ORIGINS` not matching
the Vercel origin exactly, or the realtime service not running. Its `/health`
tells you which.

---

## What will not work, and why

**Voice between two different networks may fail.** Without `TURN_SECRET` and
`TURN_URLS`, calls are STUN-only, which covers most home networks and fails
behind symmetric NAT or a firewall that blocks UDP — roughly 10–15% of peer
pairs (§9.3). Two laptops on the same Wi-Fi will connect fine. Deploying coturn
(`infra/coturn/turnserver.conf`) is what fixes the rest.

**Avatar upload is not built.** It needs an R2 bucket. Everyone gets the
generated fallback avatar, which is deterministic from their user id.

**A free-tier container host will spin down when idle** and drop every socket in
the room. Clients reconnect and resync (§8.8) once it wakes, so a personal test
survives it; real users would not enjoy it.

**Serverless connection limits.** Each Vercel function instance opens its own
Postgres connection. Use Neon's **pooled** URL, not the direct one, or a busy
moment exhausts the pool.
