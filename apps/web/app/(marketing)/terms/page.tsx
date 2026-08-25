import type { Metadata } from 'next';
import Link from 'next/link';
import { List, PageTitle, Section } from '../prose';

export const metadata: Metadata = {
  title: 'Terms',
  description: 'The rules for using SyncStudy, in plain language.',
};

/**
 * Terms of use (PLAN.md §14 Phase 8.8).
 *
 * Written to be read. A student who is about to be told they broke a rule
 * should be able to find that rule in under a minute, which is the only test a
 * document like this has to pass.
 */
export default function TermsPage() {
  return (
    <>
      <PageTitle updated="25 August 2026">Terms of use</PageTitle>

      <Section title="What SyncStudy is">
        <p>
          A private room where a few people watch the same YouTube video in sync, talk over it, and
          keep shared notes. It is a consumer product, not a service sold to schools, and it is
          provided as-is with no guarantee of availability.
        </p>
      </Section>

      <Section title="Your account">
        <List>
          <li>You must be 13 or older.</li>
          <li>One person per account. Do not share your password.</li>
          <li>You are responsible for what is posted from your account.</li>
          <li>
            Your recovery code is the only way back in if you forget your password. We cannot
            recover an account without it, because we hold no email address for you.
          </li>
        </List>
      </Section>

      <Section title="What you may not do">
        <List>
          <li>Harass, threaten, bully or sexualise anyone — rooms often contain minors.</li>
          <li>Post sexual content involving minors, or anything that promotes self-harm. This is reported and the account is removed permanently.</li>
          <li>Post hate speech or targeted abuse.</li>
          <li>Share malware, phishing links, or links designed to collect other people&rsquo;s IP addresses.</li>
          <li>Attempt to break, overload or probe the service, or to access rooms you were not invited to.</li>
          <li>Record other participants without their knowledge.</li>
        </List>
      </Section>

      <Section title="Rooms and hosts">
        <p>
          Whoever creates a room hosts it, and can remove or ban people from it, hand hosting to
          someone else, and end it. If a host leaves, hosting passes to whoever has been in the room
          longest. A host can moderate their room; they cannot see anything about you that the rest
          of the room cannot.
        </p>
      </Section>

      <Section title="Content you write">
        <p>
          Your messages and notes are yours. You give us only what is needed to run the product:
          permission to store them and show them to the other people in that room. We do not use
          them to train anything, and we do not sell them.
        </p>
      </Section>

      <Section title="Video">
        <p>
          SyncStudy plays YouTube videos through YouTube&rsquo;s own embedded player. We do not host,
          copy or download video. Your use of that player is also subject to YouTube&rsquo;s terms.
        </p>
      </Section>

      <Section title="Reporting and enforcement">
        <p>
          Every message has a report action, and reports are reviewed. Depending on what happened, an
          account may be warned, suspended, or removed. Serious harm — threats, sexual content
          involving minors — is removed immediately and permanently.
        </p>
      </Section>

      <Section title="Ending it">
        <p>
          You can delete your account at any time from{' '}
          <Link href="/settings/account" className="text-accent underline-offset-2 hover:underline">
            your account settings
          </Link>
          . We may close an account that breaks these rules. If we do, and it was a mistake, write to
          us and we will fix it.
        </p>
      </Section>
    </>
  );
}
