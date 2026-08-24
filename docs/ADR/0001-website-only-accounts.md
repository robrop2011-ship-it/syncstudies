# ADR 0001 — Website-only accounts (no email anywhere)

- **Status:** Accepted
- **Date:** 2026-08-23
- **Applies to:** `packages/auth`, `packages/db`, `apps/web` auth routes
- **Supersedes:** the email-based parts of PLAN.md §3.1, §11.1 (recorded in the plan as Amendment A1)

## Context

The original plan assumed a conventional account: email address, verification link,
password reset by email, and an OAuth "Continue with Google" button. That pulls in a
transactional mail provider (Resend or SMTP), a deliverability problem, a verification
state machine, a token table, and a second identity system to reconcile.

The user asked for email to be removed entirely. The reasons hold up on their own
merits for this product:

- The audience is students, and a study room is joined by a link from a friend. There
  is no acquisition funnel that needs an email address.
- Email verification is the single biggest drop-off point in a signup flow, and it
  buys almost nothing here: the app sends no email, so an unverified address is an
  unused address.
- Storing an email address for every 13-year-old user is a privacy liability we get
  to simply not have (PLAN.md §11.9).
- A mail provider is an external dependency that fails on weekends.

## Decision

An account is **handle + display name + password**, and nothing else.

- No `email` column, no `email_verified` flag, no verification-token table, no OAuth
  account table. The Prisma schema in `packages/db/prisma/schema.prisma` has none of
  these, and adding one requires superseding this ADR.
- The handle (`[a-z0-9_]{3,20}`, case-insensitively unique) is both the login
  identifier and the public name. `packages/auth/src/handle.ts` owns the rules,
  including reserved words compared with separators stripped, so `a_d_m_i_n` is
  rejected alongside `admin`.
- Password reset by email is replaced by a **one-time recovery code**: 24 symbols
  over a 30-character confusable-free alphabet (~117 bits), shown exactly once at
  signup, stored only as an argon2id hash, single-use, and rotated on every password
  change and every successful recovery. See `packages/auth/src/recovery.ts`.
- No transactional mail dependency exists in any `package.json`. There is no
  `RESEND_API_KEY`, `SMTP_URL`, or `MAIL_FROM` in any `.env.example`.

## Consequences

**What we gain**

- Signup is one screen with three fields and no inbox round trip.
- One fewer vendor, one fewer secret, one fewer failure mode, one fewer privacy
  surface. There is no personal contact information in the database at all.
- No verification state to reason about: every account is either usable or deleted.

**What we lose, and what we do about it**

1. **No "forgot password" link.** Covered by the recovery code — but only for users
   who kept it. A user who loses both the password and the code has no path back to
   the account, and support cannot help them, because there is nothing to verify
   ownership against. Mitigation is entirely in the UI: the code is presented as a
   deliberate step at signup (copy button, download-as-text, an explicit "I've saved
   it" confirmation), it can be regenerated from settings at any time while signed
   in, and the recovery screen states plainly that this is the only route.
   **Accepted risk:** some users will lose access permanently and create a new
   account. For a study tool whose content is chat history and notes, that is a
   tolerable outcome; it would not be for a product holding money or coursework of
   record.

2. **No login or security alerts.** We cannot tell a user "a new device signed in".
   Compensating controls: sessions are listed in settings with device, approximate
   location-free metadata and last-seen time, and can be revoked individually or all
   at once; a password change revokes every other session. **Accepted.**

3. **No out-of-band moderation or safety contact.** We cannot email a user about a
   report, a suspension, or a safety issue, and a suspended user cannot be reached
   at all. Everything must be delivered in-app on next sign-in. For a v1 with small
   private rooms joined by invite this is proportionate; it would not scale to public
   rooms, which is exactly why a public room directory sits in `docs/BACKLOG.md`
   under "needs a real reason". **Accepted for v1, and a gate on public rooms.**

## Reversal path

If the constraints change — public rooms, institutional accounts, or a support load
dominated by lost recovery codes — the way back is **additive and opt-in**, not a
migration back to email-as-identity:

1. Add a nullable `recovery_email` and `recovery_email_verified_at` to `users`. The
   handle stays the login identifier; email is never a second way to sign in.
2. Offer it in **Settings → Account** only, for a signed-in user, clearly labelled as
   an optional backup. Never on the signup form — the signup flow is the thing worth
   protecting.
3. Verification is a one-time link that only sets `recovery_email_verified_at`. An
   unverified or absent address changes nothing about the account's status.
4. Password reset by email becomes a **second** route alongside the recovery code,
   available only to accounts that opted in. The recovery code stays primary.
5. Minors (`is_minor`) are excluded by default, consistent with §11.9.

Anything beyond that list — email at signup, email as a login identifier, marketing
mail, or an OAuth provider — is a new decision that supersedes this ADR rather than
extending it.
