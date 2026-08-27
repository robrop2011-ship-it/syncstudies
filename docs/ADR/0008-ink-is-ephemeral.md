# ADR 0008 — Ink is ephemeral, and is measured against the picture

- **Status:** Accepted
- **Date:** 2026-08-27
- **Applies to:** `apps/web/lib/ink/**`, `apps/realtime/src/handlers/draw.ts`, the `draw:*` events

## Context

Participants can draw over the video with a pointer or a finger. Everyone in the room sees
the strokes appear live, and each one fades out and disappears a few seconds later. It is a
shared laser pointer for "look at *this* term here" — not a whiteboard.

Two decisions in that feature look like oversights and will be "fixed" by somebody who has
not read this.

## Decision 1 — nothing is stored, anywhere

No Postgres table. No Redis key. No field in the room snapshot. No replay for late joiners.
`apps/realtime/src/handlers/draw.ts` validates, checks permission and policy, and relays;
it holds no per-stroke state and imports nothing that could store one.

A stroke that expired two seconds before you joined is **correctly** invisible to you.
Reconstructing it would be showing you a gesture about a moment that has passed.

This is also what makes the feature cheap. Ink is the highest-frequency event in the
product — ~20 messages/second per drawing user — and none of it touches a database. It is
the only event family in the app with no durable write at all.

Consequences worth knowing:

- **The rate limit is `scope: 'local'` and `failOpen: true`.** The limiter keys on
  `socketId + event` and a socket lives on one node for its whole life, so an in-process
  window holds the same count a Redis one would — without a round trip at 20 Hz per
  drawing user. Ink has nothing to steal or corrupt, so Redis being down must not take
  away the room's ability to point at something.
- **The server cannot enforce per-stroke caps.** Counting points across batches means
  holding the stroke, which is the state this refuses to have. The ceiling is the
  receiver's per-author cap on active strokes.
- **Eviction is per author, not oldest-first.** With no server-side stroke table, one
  client minting fresh stroke ids at the rate limit could otherwise walk a global
  oldest-first table and silently delete everybody else's ink off every screen in the
  room. Budgeting eviction to the arriving author means a flood costs the flooder and
  nobody else. `apps/web/lib/ink/__tests__/controller.test.ts` pins this, and the test has
  been mutation-checked: reverting to global oldest-first fails it.
- **A stroke's fade countdown may be refreshed while it grows, but only up to a ceiling
  from first sight.** Without the refresh, a drag longer than the lifetime fades out from
  under the pointer still drawing it. Without the ceiling, a client that keeps sending
  points — even duplicates — holds its ink on everyone's screen indefinitely.

## Decision 2 — coordinates are 0..1 on the picture, not on the stage box

Every participant's window is a different size, so a stroke travels as normalised
coordinates. The subtlety is *which rectangle* they are normalised against, and the
obvious answer is wrong.

The stage box is sized by CSS and is **not reliably 16:9**. `aspect-ratio` on a
non-replaced element only computes the axis that is not already determined, so a
`width:100%` box with `max-height:100%` has its height clamped without its width shrinking
to match. In the tablet band and on short windows the box is routinely wider than 16:9. The
player fills that box and letterboxes the picture inside it — so normalising against the
box puts one person's `0.5` at the middle of the *box* and another's at the middle of the
*picture*.

That failure is invisible in testing, because it only appears when two people have
differently shaped windows, and it defeats the entire point of normalising.

So both ends measure against the centred 16:9 rect **inside** the box — the picture
itself — through one function, `inkContentRect` in `apps/web/lib/ink/geometry.ts`. The
pointer path and the paint path both call it. **If you change one, you have already broken
it.**

Verified live: a drag across a 900×506 canvas arrived at the second participant as
`x 0.1778 → 0.8889` at `y 0.5049`, matching the hand-computed values exactly.

## Reversal path

If ink ever needs to persist — a "keep this annotation" pin, say — that is a **different
feature** with a different name, its own table, and its own retention and moderation
story. It is not this one growing a database call. Ephemerality is why this feature needs
no moderation queue: nothing drawn can outlive the conversation it belonged to.
