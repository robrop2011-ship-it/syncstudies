# Moderation runbook

There is **no admin UI, and that is a decision rather than a gap.**
`docs/BACKLOG.md` puts a moderation platform under "explicitly never, or not
without a change of mind": building a queue interface before there is a queue is
how a two-person team spends a month on an admin tool. v1 reads `reports` with
SQL, and this file is that SQL.

PLAN §14 Phase 9.5 asks for a "reporting queue + admin page". The queue exists —
it is the `reports` table, populated by the in-product report action, with a
frozen snapshot of the content so deleting the message does not destroy the
evidence. The page is deliberately not built.

---

## 1. What is waiting

```sql
SELECT r.id,
       r.created_at,
       r.reason,
       r.target_type,
       r.details,
       u.handle          AS reporter,
       r.snapshot->>'body' AS reported_body,
       r.room_id
FROM reports r
LEFT JOIN users u ON u.id = r.reporter_id
WHERE r.status = 'open'
ORDER BY r.created_at ASC;
```

`snapshot` is a frozen copy taken when the report was filed. A message that has
since been deleted still has its body here — that is the whole point of freezing
it, and it is why the tombstone in `messages` keeps the row rather than removing
it.

A report with a **null snapshot** means the freeze failed. Historically that
happened when a report was filed within milliseconds of the message being sent,
before the write-behind queue had landed the row; the web app now retries with a
short bound. If you see a run of them, check `ss_write_behind_depth`.

## 2. Who is being reported repeatedly

The single most useful query, because one report is noise and five is a pattern.

```sql
SELECT m.user_id,
       u.handle,
       count(*) AS reports,
       max(r.created_at) AS most_recent
FROM reports r
JOIN messages m ON m.id = r.message_id
JOIN users u    ON u.id = m.user_id
WHERE r.created_at > now() - interval '30 days'
GROUP BY m.user_id, u.handle
HAVING count(*) > 1
ORDER BY reports DESC;
```

## 3. The context around a report

```sql
-- Twenty messages either side of the reported one, in the same room.
WITH target AS (SELECT room_id, id FROM messages WHERE id = :message_id)
SELECT m.created_at, u.handle, m.body, m.deleted_at
FROM messages m
LEFT JOIN users u ON u.id = m.user_id
WHERE m.room_id = (SELECT room_id FROM target)
ORDER BY abs(('x' || substr(replace(m.id::text,'-',''), 1, 12))::bit(48)::bigint
            - ('x' || substr(replace((SELECT id FROM target)::text,'-',''), 1, 12))::bit(48)::bigint)
LIMIT 41;
```

Ordering is by the timestamp embedded in the uuidv7 rather than by `created_at`,
for the same reason the transcript is (ADR 0007).

## 4. Acting

**Suspend an account.** Enforced in three places already — login, account
recovery, and the socket handshake — so this row is the whole action.

```sql
UPDATE users
SET status = 'suspended',
    suspended_until = now() + interval '7 days'
WHERE id = :user_id;

-- Their live sockets are refused on the next handshake. To remove them NOW,
-- also delete their sessions; the realtime service drops the connection when
-- the session no longer validates.
DELETE FROM auth_sessions WHERE user_id = :user_id;
```

**Permanent removal** — for threats or sexual content involving a minor:

```sql
UPDATE users SET status = 'suspended', suspended_until = NULL WHERE id = :user_id;
DELETE FROM auth_sessions WHERE user_id = :user_id;
```

`suspended_until = NULL` with `status = 'suspended'` is indefinite. The login
route says "This account is suspended." with no date in that case.

**Lift a suspension:**

```sql
UPDATE users SET status = 'active', suspended_until = NULL WHERE id = :user_id;
```

**Close the report.** Always do this — an open report you have already handled
is one somebody else will handle again.

```sql
UPDATE reports SET status = :outcome, resolved_at = now() WHERE id = :report_id;
-- :outcome is 'actioned' or 'dismissed'.
```

## 5. Retention

`reports` and their snapshots are kept for **12 months after resolution**
(§7.4). A periodic sweep is a Phase 10.x cron; until it exists, run:

```sql
DELETE FROM reports
WHERE resolved_at IS NOT NULL
  AND resolved_at < now() - interval '12 months';
```

## 6. What NOT to do

- **Do not delete a `messages` row to remove content.** Set `deleted_at` and
  `deleted_by`. Deleting gaps the transcript for everyone who was there and
  orphans the report that points at it. The in-product delete already does this.
- **Do not edit anybody's content.** There is no legitimate reason, and it makes
  every subsequent dispute unanswerable.
- **Do not read message bodies for any reason other than a report.** They are
  private conversations between students.
