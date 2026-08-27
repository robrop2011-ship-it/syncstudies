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

You do **not** need Docker (see §2b), coturn, or a YouTube API key — synchronized
playback uses the public IFrame Player API, which needs no key.

**Without coturn, voice calls are STUN-only.** That works on most home networks
and fails behind symmetric NAT or a firewall that blocks UDP — roughly 10–15% of
peer pairs (§9.3). The server is explicit about it rather than shipping a static
credential: with `TURN_SECRET` unset, no credential is issued at all, and
`ss_ice_grants_total{relay="stun"}` counts every grant.

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
curl -s localhost:4000/health   # {"ok":true,"version":…,"db":true,"redis":true,"pendingWrites":0}
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/
```

`pendingWrites` is the depth of the chat write-behind queue (§6.5). It should sit at 0 and
spike to single digits under load. It is deliberately **not** part of `ok`: a backed-up
queue is a reason to look, not a reason to take a node holding live WebSockets out of
rotation. `curl -s localhost:4000/metrics | grep ss_` is the fuller picture.

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

### 5a. The integration suite — run this before writing a script

Most of what §5b describes is now a checked-in test suite. Before hand-rolling a
verification script, check whether the assertion belongs in one of these:

```bash
# Needs Postgres and Redis up. Boots the real server on an ephemeral port.
pnpm --filter @syncstudy/realtime test:integration
```

77 tests across `apps/realtime/src/__integration__/`: rooms and presence, chat,
the video transact, WebRTC signalling authorization, and shared notes. They mint
sessions with `@syncstudy/auth` directly, so they need no web app running and are
not subject to the login rate limiter.

Adding one is a new `it()` in the matching file. The harness (`harness.ts`) hands
out authenticated sockets and cleans up every user and room it created.

### 5b. Writing a one-off socket verification script

For something the suite does not cover — a browser-adjacent behaviour, or a
measurement rather than an assertion. Four things will cost you an hour each if
nobody tells you:

```js
// 1. withCredentials:false + an explicit Cookie header. socket.io-client in Node
//    hands the cookie to its own jar with credentials on, and drops one set via
//    extraHeaders. Browsers are unaffected.
const socket = io('http://localhost:4000', {
  transports: ['websocket'],
  withCredentials: false,
  extraHeaders: { Cookie: cookie, Origin: 'http://localhost:3000' },
  forceNew: true,
});

// 2. A socket keeps the Node event loop alive forever. A script that throws does
//    not exit — it hangs, with the failure invisible inside a buffered pipe.
function done(code) { for (const s of sockets) s.disconnect(); process.exit(code); }
main().catch((err) => { console.error(err); done(1); });

// 3. Pace chat sends. `chat:send` is 5 / 5s with a burst of 10, and THREE breaches
//    inside a minute disconnects the socket for 60s. A tight loop strikes out in
//    under a second and then talks to a socket the server has hung up on.
//    ~1 send/second, or insert history rows directly with Prisma.

// 4. Cache the login cookies to disk. The login limiter is 5 per 15 minutes per
//    handle and is in-process, so a script that logs in on every run locks you
//    out of your own dev environment on the sixth run.
```

Scripts live in `apps/realtime/scripts/` and are run with **tsx**, not plain node:
`@syncstudy/db` uses extensionless relative imports (ADR 0002), which Node's own
ESM resolver rejects.

```bash
cd apps/realtime
npx tsx --env-file=.env scripts/verify-rtc.mjs     # Phase 6 signalling, 30 checks
npx tsx --env-file=.env scripts/verify-notes.mjs   # Phase 7 study tools, 43 checks
npx tsx --env-file=.env scripts/watch-room.mjs CODE 20   # an independent observer
```

`watch-room.mjs` is the one to reach for when a browser looks wrong: it prints
every `video:state` the **server** actually emitted, which is a second opinion on
whether a bug is in the server or in the rendering. It is how the "seeking stopped
working" scare turned out to be the Browser pane throttling
`requestAnimationFrame`.

**Do not sleep before asserting on a read-back.** Chat is broadcast before it is
persisted, so a test that waits for the queue to flush will pass against code that is
broken for every real user. Two shipped features were broken exactly that way; see
[ADR 0006](./ADR/0006-chat-is-broadcast-first.md).

---

## 6. Things that will bite you

**The web app must be on port 3000 specifically.** Three things pin it:
`ALLOWED_ORIGINS` in `apps/realtime/.env` is an **exact-match** allowlist checked at the
socket handshake, and `APP_ORIGIN` / `NEXT_PUBLIC_APP_URL` in `apps/web/.env` back the
CSRF Origin check on the REST routes. Move the web app to another port without changing
all three and the symptom is not "wrong port" — it is `bad_origin` at the handshake, so
the room loads and then never connects. `.claude/launch.json` therefore sets
`"autoPort": false`; free port 3000 rather than letting the dev server pick another.

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

**Every API route suddenly returns a plain-text `Internal Server Error`.** Not the JSON
envelope — that means the route module failed to load, not that the handler threw. The
usual cause is running `pnpm build` while `next dev` is running: the build rewrites
`.next/` underneath the dev server. `rm -rf apps/web/.next` and restart it.

**A brand-new API route 500s while every existing one works.** Same cause. Turbopack does
not always pick up a newly created `route.ts` in a server that was already running;
restart `dev:web`.

**`⚠ [externals]/@prisma/client — unexpected export *`.** A Turbopack warning, not an
error, from `export * from '@prisma/client'` in `packages/db/src/index.ts`. It is emitted
once per route that imports `@syncstudy/db`, it is pre-existing, and the build succeeds.
Ignore it.

**`pnpm db:push` fails with a validation error but `npx prisma db push` works.** The
Prisma CLI reads `DATABASE_URL` from the package's own environment, and `packages/db` has
no `.env`. Run it with the variable in front:
`DATABASE_URL=… npx prisma db push` from `packages/db`.

**The load test dies with `too_many_connections` at the 13th socket.** §11.4 caps
connections per IP at 12, and every socket in a load test comes from 127.0.0.1.
Start the service with `MAX_CONNECTIONS_PER_IP=2000` for the run only.

**A form in a manual browser check "silently did nothing".** Check whether you had
just saved a file: Fast Refresh remounts the component, which clears what was
typed and closes the dialog. Re-run the check with no edits pending.

**The scrubber readout freezes but seeks still work.** The playhead is driven by a
`requestAnimationFrame` loop (§5.4), and rAF does not run in a tab that is not
painting — a background tab, or an automated browser pane. The seek itself is fine;
confirm with `scripts/watch-room.mjs`. Anything that needs the position at a moment
in time must call `controller.getPlayheadSec()` rather than read the ref.

**Chat says "That message no longer exists" for a message you can see.** If this comes
back, someone removed a `ctx.chat.settle()` call. The message is in the write-behind
queue, not in Postgres. ADR 0006 exists because that call looks removable.
