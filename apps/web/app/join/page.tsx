import type { Metadata } from 'next';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { Card } from '@/components/ui/card';
import { UserMenu } from '@/components/app/user-menu';
import { JoinFlow } from '@/components/room/JoinFlow';
import { getCurrentSession } from '@/lib/server/session';
import { avatarUrlFor } from '@/lib/server/views';

export const metadata: Metadata = {
  title: 'Join a room',
  description: 'Enter a room code to see what you were invited to.',
  // Room codes are the whole access-control story (§11.3). Nothing under /join
  // or /r belongs in an index.
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Deliberately outside both the `(app)` and `(auth)` groups: this page has to
 * work signed out — §12.7 is explicit that a joining student should never have
 * to sign up first just to find out what they were invited to — so it carries
 * the marketing shell rather than the signed-in one.
 *
 * `?code=` is what the marketing page's no-JavaScript form submits.
 */
export default async function JoinPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.code;
  const session = await getCurrentSession();

  return (
    <div className="flex min-h-dvh flex-col">
      {/* Signed out this is the marketing header, sign-in button and all — which
          is the point. Signed in it has to be the app one, or the page tells
          somebody who is already signed in to sign in. */}
      <SiteHeader
        actions={
          session === null ? undefined : (
            <UserMenu
              displayName={session.user.displayName}
              handle={session.user.handle}
              avatarUrl={avatarUrlFor(session.user.avatarKey)}
            />
          )
        }
      />

      <main className="flex flex-1 justify-center px-4 py-10 sm:py-16">
        <div className="w-full max-w-[440px]">
          <Card className="p-6">
            <JoinFlow
              initialCode={typeof raw === 'string' ? raw : ''}
              signedIn={session !== null}
            />
          </Card>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
