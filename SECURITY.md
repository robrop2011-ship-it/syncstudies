# Security

## Reporting a vulnerability

Email **security@syncstudy.app**. Please include what you found, how to
reproduce it, and how you would like to be credited.

We will acknowledge within **3 working days** and tell you what we intend to do
within **10**. If a fix needs longer than that, you will get a date and then
updates against it. We will not take legal action against anyone who reports in
good faith, stops at proof of concept, and does not access, modify or retain
other people's data.

Please do **not** open a public issue for anything that could be exploited
before it is fixed.

## In scope

- Authentication and session handling (`packages/auth`)
- Room access control and the socket handshake (`apps/realtime/src/auth`)
- Authorization on any REST route or socket handler
- The WebRTC signaling relay — in particular, reaching a peer in another room
- Injection of any kind into chat, notes, room names or handles
- The oEmbed probe (SSRF) and the room-code space (enumeration)
- TURN credential issuance

## Out of scope

- Anything requiring physical access to a user's unlocked device
- Social engineering of our users or staff
- Denial of service through sheer volume — we know, and the rate limits are
  where the answer lives
- Missing security headers on endpoints that serve no content
- Reports from automated scanners with no demonstrated impact
- **That other participants in a voice call can see your IP address.** This is
  documented behaviour of peer-to-peer media, is stated plainly on the privacy
  page, and is why "Hide my IP from other participants" exists — and is on by
  default for anyone under 18.

## What the design already assumes an attacker will try

These are handled deliberately. A report showing one of them still works is very
much in scope.

| Attack | Where the defence lives |
|---|---|
| Room-code enumeration | `room:join` answers `room_not_found` identically for a missing room and a forbidden one; 8 characters over a 30-symbol alphabet with no confusable pairs |
| Ghost joins on a remembered code | Every join re-reads membership and bans from Postgres; nothing is trusted from a cache or a previous session |
| Signalling into another room | `rtc:signal` resolves `to` against the sender's own room's presence hash before relaying |
| Forged identity in a payload | Every handler reads `socket.data.userId`; a `userId` in a payload is ignored |
| IDOR on a message, note or checklist item | Every mutation is scoped by `roomId` in the same query, so an id from another room updates zero rows |
| Privilege escalation by a co-host | `canActOn` requires strictly outranking the target; there are no `role === 'host'` checks in handlers |
| SSRF through the video probe | Host allowlist and IP-literal rejection before any fetch |
| XSS in user content | Nothing is rendered as HTML; the chat tokenizer emits text nodes and anchors only |
| A stolen TURN credential | Credentials are per-user HMACs that expire in 10 minutes; no static credential is ever sent to a browser |
| Rate-limit evasion | Limits are in Redis and keyed per socket; three breaches disconnect and impose a 60-second cooldown at the handshake |

## Handling of secrets

Secrets come from the platform's secret store, never from the repository.
`.env.example` documents names only. Structured logs carry user ids and never
handles, display names, message bodies, SDP, tokens or recovery codes.
