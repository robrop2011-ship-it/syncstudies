/**
 * The signed-in shell.
 *
 * `middleware.ts` has already bounced anyone without a session cookie; this is
 * the check that actually looks the session up, so an expired or revoked cookie
 * lands on the login page rather than on a half-rendered dashboard.
 */
import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { SiteHeader } from '@/components/site-header';
import { AccountPreferences } from '@/components/app/account-preferences';
import { UserMenu } from '@/components/app/user-menu';
import { getMeView } from '@/lib/server/me';
import { getCurrentSession } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await getCurrentSession();
  if (session === null) redirect('/login');

  const me = await getMeView(session.user.id);
  if (me === null) redirect('/login');

  return (
    <div className="flex min-h-dvh flex-col">
      <AccountPreferences theme={me.settings.theme} reduceMotion={me.settings.reduceMotion} />
      <SiteHeader
        actions={
          <UserMenu
            displayName={me.user.displayName}
            handle={me.user.handle}
            avatarUrl={me.user.avatarUrl}
          />
        }
      />
      <main className="flex-1">{children}</main>
    </div>
  );
}
