import type { Metadata } from 'next';
import Link from 'next/link';
import { List, PageTitle, Section } from '../prose';

export const metadata: Metadata = {
  title: 'Privacy',
  description: 'What SyncStudy collects, what it does not, and what other people in a room can see.',
};

/**
 * The privacy page (PLAN.md §11.9).
 *
 * §11.9's instruction is explicit: "a plain-language privacy page that actually
 * says what happens (including 'in a call, other participants can see your IP
 * address unless you enable Hide my IP'). Legalese hides the one fact users
 * needed." So that fact is in its own section, near the top, in plain words —
 * not buried in a paragraph about third-party service providers.
 */
export default function PrivacyPage() {
  return (
    <>
      <PageTitle updated="25 August 2026">Privacy</PageTitle>

      <Section title="The short version">
        <p>
          We ask for a username, a display name and a password. That is the whole account. There
          is no email address in our database, no advertising, no third-party trackers, and
          nothing is sold to anyone. The one thing worth reading in full is the section on voice
          calls below, because it is the only place where another person can learn something
          about your connection.
        </p>
      </Section>

      <Section title="Voice calls show other people your IP address">
        <p>
          Voice and video go <strong className="font-medium text-primary">directly between
          participants</strong> rather than through our servers. That is what keeps calls fast and
          free. It also means that, while you are in a call, the other people in that room can see
          your IP address — roughly, the town your internet connection is in.
        </p>
        <p>
          If you do not want that, turn on{' '}
          <Link href="/settings/privacy" className="text-accent underline-offset-2 hover:underline">
            Hide my IP from other participants
          </Link>{' '}
          in your privacy settings. Your audio is then relayed through our server instead. It is
          slightly slower and it is on by default for anyone under 18.
        </p>
      </Section>

      <Section title="What we collect">
        <List>
          <li>Your username, display name and a hash of your password — never the password itself.</li>
          <li>Optionally: an avatar, a one-line bio, and a school name, if you fill them in.</li>
          <li>Your birth <em>year</em>, used once to check you are 13 or older and to set safer defaults if you are under 18. The date is never stored.</li>
          <li>The rooms you create or join, and what you write in them: chat messages, shared notes, questions and checklist items.</li>
          <li>A salted hash of your IP address, for blocking abuse. Not the address itself, and deleted after 30 days.</li>
        </List>
      </Section>

      <Section title="What we do not collect">
        <List>
          <li>No email address. There is no field for one.</li>
          <li>No real name, home address, phone number or precise location.</li>
          <li>No contacts, no device fingerprinting, no cross-site identifiers.</li>
          <li>No advertising or marketing trackers of any kind.</li>
          <li>No call recordings. Calls are never recorded, by us or by the product.</li>
        </List>
      </Section>

      <Section title="The cost of having no email address">
        <p>
          Stated plainly, because it affects you: with no email on file we cannot send you a
          password-reset link, we cannot warn you about a suspicious sign-in, and we cannot contact
          you about a moderation decision. That is why you are shown a one-time recovery code when
          you sign up. Keep it somewhere safe — it is the only way back into an account whose
          password has been forgotten.
        </p>
      </Section>

      <Section title="How long we keep things">
        <List>
          <li>Messages, notes and checklists live as long as the room does. Rooms are archived after 14 idle days and deleted after 180.</li>
          <li>Sign-in sessions last 30 days, or until you sign out.</li>
          <li>Moderation reports are kept for 12 months after they are resolved.</li>
          <li>Room moderation history (kicks, bans, host changes) is kept for 90 days.</li>
          <li>Hashed IP addresses are kept for 30 days.</li>
        </List>
      </Section>

      <Section title="Getting your data out, and deleting it">
        <p>
          <Link href="/settings/account" className="text-accent underline-offset-2 hover:underline">
            Your account settings
          </Link>{' '}
          have a button that downloads everything tied to your account as a JSON file, and a button
          that deletes the account. Deleting removes your personal information within seven days.
          Messages and notes you wrote in someone else&rsquo;s room stay, with your name removed —
          otherwise deleting an account would silently tear holes in other people&rsquo;s study
          sessions.
        </p>
      </Section>

      <Section title="If you are under 18">
        <p>
          You must be at least 13 to use SyncStudy. If you told us at signup that you are under 18,
          these are set for you and cannot be turned off: your profile is private, rooms you create
          are private, your online status is hidden, and your IP address is hidden from other people
          in a call.
        </p>
      </Section>

      <Section title="Questions">
        <p>
          Write to{' '}
          <a href="mailto:privacy@syncstudy.app" className="text-accent underline-offset-2 hover:underline">
            privacy@syncstudy.app
          </a>
          . Security issues go to{' '}
          <a href="mailto:security@syncstudy.app" className="text-accent underline-offset-2 hover:underline">
            security@syncstudy.app
          </a>
          .
        </p>
      </Section>
    </>
  );
}
