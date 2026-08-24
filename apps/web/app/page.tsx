import type * as React from 'react';
import Link from 'next/link';
import {
  Copy,
  Mic,
  MicOff,
  MonitorUp,
  NotebookPen,
  Play,
  SkipBack,
  SkipForward,
  Timer,
  Users,
  Video,
  Volume2,
} from 'lucide-react';
import { SiteHeader } from '@/components/site-header';
import { SiteFooter } from '@/components/site-footer';
import { buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Logo } from '@/components/ui/logo';
import { ROOM_CODE_LENGTH } from '@syncstudy/shared';

/**
 * The whole marketing page (PLAN.md §12.7): headline, one sentence, two actions
 * with the join code inline, a picture of the room, three features, footer.
 *
 * Everything that is not on that list is deliberately absent — no testimonials we
 * don't have, no logo bar, no counters, no gradient hero.
 */
export default function HomePage(): React.JSX.Element {
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />

      <main className="flex-1">
        <section className="mx-auto max-w-5xl px-4 pb-14 pt-16 sm:px-6 sm:pt-24">
          <h1 className="max-w-2xl text-28 font-semibold text-primary">
            Watch lectures together, in sync.
          </h1>
          <p className="mt-3 max-w-xl text-base text-secondary">
            Paste a YouTube lecture, share the room code, and everyone stays on the same second —
            with voice, chat and shared notes beside the video.
          </p>

          <div className="mt-8 flex flex-col gap-5 sm:flex-row sm:items-start sm:gap-8">
            <div>
              <Link href="/rooms/new" className={buttonVariants({ variant: 'primary' })}>
                Create a room
              </Link>
              <p className="mt-2 text-13 text-tertiary">
                Hosting needs an account: a username and a password, no email.
              </p>
            </div>

            {/* The code field is inline and needs no JavaScript — an invited student
                landing here should be able to act in one keystroke and one click,
                without signing up first to find out what they were invited to. */}
            <form action="/join" method="get" className="sm:border-l sm:border-border sm:pl-8">
              <div className="flex items-start gap-2">
                <Input
                  name="code"
                  aria-label="Room code"
                  aria-describedby="join-code-hint"
                  placeholder="K3M7-QP2X"
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  maxLength={ROOM_CODE_LENGTH + 1}
                  className="w-40 font-mono uppercase"
                />
                <button type="submit" className={buttonVariants({ variant: 'secondary' })}>
                  Join with a code
                </button>
              </div>
              <p id="join-code-hint" className="mt-2 text-13 text-tertiary">
                {ROOM_CODE_LENGTH} characters, from the link or the host.
              </p>
            </form>
          </div>
        </section>

        <section className="mx-auto max-w-5xl px-4 pb-16 sm:px-6">
          <RoomPreview />
          <p className="sr-only">
            A diagram of a study room: the video fills the left side under a bar showing the room
            name and its code, with a scrubber marked at the points where someone asked a question,
            and a sidebar on the right listing the four people in the room.
          </p>
        </section>

        <section className="mx-auto max-w-5xl px-4 pb-20 sm:px-6">
          <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3">
            <Feature
              icon={Timer}
              title="Playback that actually stays together"
              body="Play, pause and seek land on every screen at once, and small drift is corrected quietly while you watch instead of piling up over a three-hour session."
            />
            <Feature
              icon={Mic}
              title="Talk without a second app"
              body="Voice runs in the same window as the video, up to eight people. Everyone joins muted, and nothing is ever recorded."
            />
            <Feature
              icon={NotebookPen}
              title="Notes that keep their timestamp"
              body="Ask a question at 41:12 and it stays pinned to 41:12. Export the notes, questions and checklist as Markdown when you're done."
            />
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}

function Feature({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof Timer;
  title: string;
  body: string;
}): React.JSX.Element {
  return (
    <div className="bg-bg p-5">
      <Icon size={16} strokeWidth={1.5} aria-hidden="true" className="text-secondary" />
      <h2 className="mt-3 text-sm font-medium text-primary">{title}</h2>
      <p className="mt-1.5 text-13 text-secondary">{body}</p>
    </div>
  );
}

// ── The room, drawn rather than screenshotted ───────────────────────────────
// Built from the same tokens and the same geometry as the real thing (§12.4), so
// it cannot go stale the way a PNG does and it themes with the rest of the page.
// aria-hidden with a prose description beside it: this is a picture, not a UI.

const PARTICIPANTS: ReadonlyArray<{
  name: string;
  tint: 0 | 1 | 2 | 3 | 4;
  role?: string;
  speaking?: boolean;
  muted?: boolean;
}> = [
  { name: 'Priya', tint: 2, role: 'Host', speaking: true },
  { name: 'Sam', tint: 0, muted: true },
  { name: 'Ade', tint: 3 },
  { name: 'Mira', tint: 4, muted: true },
];

function RoomPreview(): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      className="overflow-hidden rounded-lg border border-border bg-surface-1"
    >
      {/* Top bar — 48px in the real room. Room code sits here because copying it
          is the most-used action after Play. */}
      <div className="flex h-11 items-center gap-2 border-b border-border bg-bg px-3">
        <Logo size={14} className="text-tertiary" />
        <span className="truncate text-13 font-medium text-primary">Organic Chem — Ch. 7</span>
        <span className="ml-auto inline-flex items-center gap-1.5 rounded-sm border border-border px-1.5 py-0.5 font-mono text-xs text-secondary">
          K3M7-QP2X
          <Copy size={12} strokeWidth={1.5} className="text-tertiary" />
        </span>
        <span className="inline-flex items-center gap-1 text-xs text-tertiary">
          <Users size={12} strokeWidth={1.5} />4
        </span>
      </div>

      <div className="flex">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex aspect-video items-center justify-center border-b border-border bg-surface-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-md border border-border-strong bg-bg">
              <Play size={16} strokeWidth={1.5} className="text-secondary" />
            </span>
          </div>

          {/* Our scrubber, not YouTube's — that is what makes the question ticks
              possible (§12.4). The two accent marks are the only accent in this
              drawing apart from the active sidebar tab. */}
          <div className="border-b border-border bg-bg px-3 py-2.5">
            <div className="relative h-1 rounded-full bg-surface-3">
              <span className="absolute inset-y-0 left-0 w-[49%] rounded-full bg-primary" />
              <span className="absolute -top-0.5 left-[49%] h-2 w-2 -translate-x-1/2 rounded-full bg-primary" />
              <span className="absolute -top-0.5 left-[31%] h-2 w-0.5 bg-accent" />
              <span className="absolute -top-0.5 left-[72%] h-2 w-0.5 bg-accent" />
            </div>
            <div className="mt-1.5 flex items-center justify-between font-mono text-xs text-tertiary">
              <span>41:12</span>
              <span>1:22:04</span>
            </div>
          </div>

          <div className="flex h-11 items-center gap-3 border-b border-border bg-bg px-3">
            <SkipBack size={16} strokeWidth={1.5} className="text-tertiary" />
            <Play size={16} strokeWidth={1.5} className="text-primary" />
            <SkipForward size={16} strokeWidth={1.5} className="text-tertiary" />
            <Volume2 size={16} strokeWidth={1.5} className="ml-1 text-tertiary" />
            <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-tertiary">
              <span className="h-1.5 w-1.5 rounded-full bg-tertiary" />
              In sync
            </span>
          </div>

          {/* Call bar. Leave room is isolated on the right and bordered, never a
              filled red button — a filled red button next to Play invites the
              misclick it is meant to prevent. */}
          <div className="flex h-12 items-center gap-4 bg-bg px-3">
            <span className="inline-flex items-center gap-1.5 text-xs text-secondary">
              <Mic size={16} strokeWidth={1.5} />
              Mic
            </span>
            <span className="inline-flex items-center gap-1.5 text-xs text-tertiary">
              <Video size={16} strokeWidth={1.5} />
              Camera
            </span>
            <span className="inline-flex items-center gap-1.5 text-xs text-tertiary">
              <MonitorUp size={16} strokeWidth={1.5} />
              Share
            </span>
            <span className="ml-auto rounded-md border border-border-strong px-2 py-1 text-xs text-secondary">
              Leave room
            </span>
          </div>
        </div>

        {/* Sidebar: tabs, not three stacked panels — 380px split three ways is
            three useless panels. Hidden on small screens, where the real room
            turns this into a bottom sheet. */}
        <div className="hidden w-52 shrink-0 flex-col border-l border-border bg-surface-1 md:flex">
          <div className="flex items-stretch gap-1 border-b border-border px-2">
            <span className="-mb-px border-b-2 border-accent px-2 py-2 text-13 font-medium text-primary">
              People
            </span>
            <span className="-mb-px border-b-2 border-transparent px-2 py-2 text-13 font-medium text-secondary">
              Chat
            </span>
            <span className="-mb-px border-b-2 border-transparent px-2 py-2 text-13 font-medium text-secondary">
              Notes
            </span>
          </div>

          <div className="flex flex-col gap-0.5 p-1.5">
            {PARTICIPANTS.map((person) => (
              <div
                key={person.name}
                // Speaking is a --live border plus the mic icon, never colour alone
                // (§12.4, §12.6). Every row carries the border in both states so the
                // list does not twitch when someone starts talking.
                className={`flex h-8 items-center gap-2 rounded-sm border px-1.5 ${
                  person.speaking === true ? 'border-live' : 'border-transparent'
                }`}
              >
                <span
                  className={`ss-avatar-${person.tint} flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-xs font-medium`}
                >
                  {person.name.slice(0, 1)}
                </span>
                <span className="truncate text-13 text-primary">{person.name}</span>
                {person.role !== undefined ? (
                  <span className="text-xs text-tertiary">{person.role}</span>
                ) : null}
                {person.muted === true ? (
                  <MicOff size={12} strokeWidth={1.5} className="ml-auto text-tertiary" />
                ) : (
                  <Mic size={12} strokeWidth={1.5} className="ml-auto text-tertiary" />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
