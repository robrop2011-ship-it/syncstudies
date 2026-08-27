# Architecture decision records

Eight decisions where the obvious choice is wrong.

Each of these exists for one reason: somebody — a new contributor, a future you, a coding
agent tidying up — would otherwise "fix" it back, and the code would break quietly. None of
them is a matter of taste. Every one was written after the wrong version was either
shipped or seriously considered.

| # | Decision | The thing you would otherwise do |
|---|---|---|
| [0001](./0001-website-only-accounts.md) | Accounts are username + password, with a one-time recovery code. No email, ever. | Add email for password reset. It puts a contact identifier for minors in the database. |
| [0002](./0002-extensionless-imports.md) | Relative imports inside `packages/**` carry no file extension. | Write `./video.js`, as TypeScript's own docs tell you to. It typechecks and then breaks Turbopack, in dev only. |
| [0003](./0003-redis-in-the-web-tier.md) | The web tier holds a Redis client, purely to invalidate the realtime service's room cache. | Keep the tiers cleanly separated. Then a host ends a room and everyone stays in it for an hour. |
| [0004](./0004-rest-join-writes-no-membership.md) | `POST /api/rooms/:code/join` is a pre-flight check that writes no membership row. | Write the row where the route is named after it. The socket path has to re-verify anyway, and now there are ghost members. |
| [0005](./0005-host-transfer-happens-at-removal.md) | Host transfer happens at the moment of removal, never on a separate timer. | Run a second timer for the transfer. The removal timer fires first and cancels it, leaving the room permanently hostless. |
| [0006](./0006-chat-is-broadcast-first.md) | Chat is broadcast before it is persisted, so every read-back path must account for the queue. | Assume a message you can see is in the database. Two shipped features were broken by exactly this, and both of their tests passed. |
| [0007](./0007-order-messages-by-id.md) | The transcript is ordered by `id`, never by `created_at`. | Order by the timestamp column, which reads better and already has an index. It is not a total order and it cannot be a cursor. |
| [0008](./0008-ink-is-ephemeral.md) | Ink is never stored, and its coordinates are 0..1 on the **picture**, not on the stage box. | Persist the strokes so late joiners see them, and normalise against the canvas — which is not reliably 16:9, so the same 0.5 is a different part of the lecture on a differently shaped window. |

## Writing another one

An ADR earns its place when **the correct code looks like a mistake**. If a reasonable
person reading the diff would want to simplify it, and simplifying it would break
something they cannot see from that file, write the ADR. Otherwise a comment is enough.

Keep the format: status, date, what it applies to, the context that made the obvious
choice tempting, the decision, and the consequences — including the ones you do not like.
