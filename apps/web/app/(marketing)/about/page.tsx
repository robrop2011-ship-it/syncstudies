import type { Metadata } from 'next';
import Link from 'next/link';
import { PageTitle, Section, List } from '../prose';
import { buttonVariants } from '@/components/ui/button';

export const metadata: Metadata = {
  title: 'About',
  description: 'Why SyncStudy exists and how the synchronisation actually works.',
};

/**
 * About (PLAN.md §14 Phase 8.8).
 *
 * The one genuinely interesting thing about this product is how the sync works,
 * so that is what this page is about. A page of adjectives would be worse than
 * no page.
 */
export default function AboutPage() {
  return (
    <>
      <PageTitle>About SyncStudy</PageTitle>

      <Section title="The problem">
        <p>
          Studying a lecture with friends over a call means four apps and a lot of &ldquo;okay,
          pause — three, two, one&rdquo;. Someone&rsquo;s Wi-Fi drops and everyone re-syncs by hand.
          Somebody asks a question about &ldquo;the bit with the matrix&rdquo; and nobody can find it
          again.
        </p>
      </Section>

      <Section title="How the sync works">
        <p>
          The server does not broadcast a position. It stores an{' '}
          <strong className="font-medium text-primary">anchor</strong>: where the video was, at what
          instant, and whether it was playing. Everyone derives the current position from that
          anchor and from a clock offset their browser measures against the server.
        </p>
        <p>
          The difference matters. Broadcasting a position means every client is as far behind as its
          own network latency, permanently. An anchor means a client that missed three events still
          lands on the right second, and a client on a slow connection compensates for its own lag
          rather than inheriting someone else&rsquo;s.
        </p>
        <p>
          Each browser then measures its own drift twice a second and corrects it — a gentle nudge
          for small errors, a real seek only when it has to. In testing, six people on latencies from
          25 to 220 milliseconds with 2% packet loss stayed within a quarter of a second of each
          other for the length of a lecture.
        </p>
      </Section>

      <Section title="What is in a room">
        <List>
          <li><strong className="font-medium text-primary">Synchronised video.</strong> Play, pause and seek reach everyone. The host can lock playback if a room needs it.</li>
          <li><strong className="font-medium text-primary">Voice.</strong> Peer-to-peer, so it costs nothing and adds no delay. Cameras and screen sharing too.</li>
          <li><strong className="font-medium text-primary">Chat.</strong> Type <code className="rounded-sm bg-surface-2 px-1 text-13">41:12</code> and it becomes a link that takes the whole room there.</li>
          <li><strong className="font-medium text-primary">Shared notes.</strong> One document everyone edits, plus questions pinned to the second they were asked, and a shared checklist.</li>
        </List>
      </Section>

      <Section title="What we do not do">
        <p>
          No email addresses, no advertising, no trackers, no call recording, no AI summaries. The
          reasoning is in the{' '}
          <Link href="/privacy" className="text-accent underline-offset-2 hover:underline">
            privacy page
          </Link>
          , which is written to be read rather than to be defensible.
        </p>
      </Section>

      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-6">
        <Link href="/rooms/new" className={buttonVariants({ variant: 'primary' })}>
          Create a room
        </Link>
        <Link href="/join" className={buttonVariants({ variant: 'secondary' })}>
          Join with a code
        </Link>
      </div>
    </>
  );
}
