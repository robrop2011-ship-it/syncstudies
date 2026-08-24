# Runbook — getting a working dev environment

Everything below has been run end to end on macOS (Apple Silicon, Node 24). If a step
does not behave as written, the doc is wrong; fix it here.

---

## 1. Prerequisites

| Need | Why | Check |
|---|---|---|
| Node ≥ 22 | `--env-file-if-exists`, native fetch | `node -v` |
| pnpm 9 | workspace resolution | `corepack enable pnpm && pnpm -v` |
| PostgreSQL 16+ | the database | see §2 |
| Redis 7+ | live room state, presence, rate limits | see §2 |

You do **not** need Docker (see §2b), coturn (Phase 6), or a YouTube API key —
synchronized playback uses the public IFrame Player API, which needs no key.

---

## 2. Postgres and Redis

### 2a. The documented path (Docker)

```bash
pnpm services:up      # infra/docker-compose.dev.yml — postgres:16, redis:7, coturn
```

### 2b. Without Docker

This is what the environment the project was built in actually used, so it is known to
work. Both run as ordinary user processes and touch nothing system-wide.

**Postgres** — real binaries, no system install, no Homebrew:

```bash
mkdir -p ~/.syncstudy-dev && cd ~/.syncstudy-dev
npm init -y >/dev/null && npm install embedded-postgres
# npm blocks the postinstall by default; run it explicitly, from the package dir
# (the script resolves its paths relative to cwd)
(cd node_modules/@embedded-postgres/darwin-arm64 && node scripts/hydrate-symlinks.js)

BIN=$PWD/node_modules/@embedded-postgres/darwin-arm64/native/bin
mkdir -p /tmp/sspg                       # short socket dir: the 103-byte path limit is real
$BIN/initdb -D "$PWD/data" -U syncstudy --auth-local=trust --auth-host=trust -E UTF8
$BIN/pg_ctl -D "$PWD/data" \
  -o "-p 5432 -k /tmp/sspg -c listen_addresses=127.0.0.1" \
  -l "$PWD/pg.log" start
```

That package ships **server** binaries only — no `psql`, no `createdb`. Create the role
password and database with the `pg` driver:

```bash
npm install pg
node -e "
const {Client}=require('pg');
(async()=>{const c=new Client({host:'127.0.0.1',port:5432,user:'syncstudy',database:'postgres'});
await c.connect();
await c.query(\"ALTER ROLE syncstudy WITH PASSWORD 'syncstudy'\");
const e=await c.query(\"select 1 from pg_database where datname='syncstudy'\");
if(!e.rowCount) await c.query('CREATE DATABASE syncstudy OWNER syncstudy');
await c.end(); console.log('ready');})()"
```

**Redis** — build from source, about a minute:

```bash
cd ~/.syncstudy-dev
curl -sLO https://download.redis.io/releases/redis-7.2.5.tar.gz
tar xzf redis-7.2.5.tar.gz && cd redis-7.2.5 && make -j4 redis-server redis-cli
./src/redis-server --port 6379 --daemonize yes --save '' --appendonly no --dir /tmp
./src/redis-cli ping     # PONG
```

To stop either later: `$BIN/pg_ctl -D ~/.syncstudy-dev/data stop` and
`~/.syncstudy-dev/redis-7.2.5/src/redis-cli shutdown nosave`.

---

## 3. Environment files

Next.js reads `.env` from the **app** directory, not the repo root, so `apps/web` and
`apps/realtime` each need their own. Both are gitignored.

```bash
cp .env.example .env
cp apps/web/.env.example apps/web/.env
cp apps/realtime/.env.example apps/realtime/.env
```

Then set, in **both** app files, the same values:

```
DATABASE_URL="postgresql://syncstudy:syncstudy@127.0.0.1:5432/syncstudy?schema=public"
REDIS_URL="redis://127.0.0.1:6379"
IP_HASH_SALT="<at least 16 characters — generate with: openssl rand -base64 32>"
```

`apps/web` additionally wants `APP_ORIGIN`, `NEXT_PUBLIC_APP_URL` and
`NEXT_PUBLIC_REALTIME_URL=http://localhost:4000`; `apps/realtime` wants
`ALLOWED_ORIGINS=http://localhost:3000` and `NODE_ID`.

`REDIS_URL` **must be the same instance** for both apps — the web tier invalidates the
realtime service's room cache through it (ADR 0003).

---

## 4. Install, migrate, seed, run

```bash
pnpm install
pnpm db:generate         # prisma client
pnpm db:migrate          # applies packages/db/prisma/migrations
pnpm db:seed             # two users + one room
pnpm dev                 # web on :3000, realtime on :4000
```

Seeded logins — **`priya`** and **`sam`**, password **`studytogether1`** for both.

Health check both processes:

```bash
curl -s localhost:4000/health          # {"ok":true,"db":true,"redis":true}
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/
```

---

## 5. Verifying it actually works

`pnpm typecheck && pnpm lint && pnpm test && pnpm build` is the CI gate and needs no
services. **Run the build, not just the typecheck** — a whole class of module-resolution
error is invisible to `tsc` (ADR 0002).

For anything touching rooms or sockets, exercise it against the running stack. Note that
API routes enforce an `Origin` header as a CSRF control, so curl needs it:

```bash
API=http://localhost:3000/api
H=(-H 'Content-Type: application/json' -H 'Origin: http://localhost:3000')
curl -s -c /tmp/c.txt -X POST "$API/auth/login" "${H[@]}" \
  -d '{"handle":"priya","password":"studytogether1"}'
curl -s -b /tmp/c.txt -X POST "$API/rooms" "${H[@]}" \
  -d '{"name":"Test room","maxParticipants":6}'
```

---

## 6. Things that will bite you

**`pnpm dev:realtime` exits with `DATABASE_URL: Required`.** `apps/realtime/.env` is
missing. The config validator is doing its job.

**"Too many sign-in attempts."** The login limiter is 5 per 15 minutes per handle and is
**in-process**, so repeated scripted logins will lock you out of your own dev environment.
Restart `apps/web` to clear it.

**Postgres refuses to start with "Unix-domain socket path is too long".** The socket
directory path exceeds 103 bytes. Use `-k /tmp/sspg` as in §2b.

**A socket client authenticates in the browser but not from Node.** `socket.io-client`
with `withCredentials: true` hands the Cookie header to its own Node cookie jar, which
drops one set via `extraHeaders`. In test scripts use `withCredentials: false` and pass
`Cookie` explicitly. Browsers are unaffected — they send the httpOnly cookie natively.

**A room says it is ended but people are still in it.** The realtime service's Redis
cache was not invalidated. See ADR 0003.

**`next dev --turbopack` reports `Can't resolve './something.js'`.** Someone added a file
extension to a relative import inside `packages/**`. See ADR 0002.
