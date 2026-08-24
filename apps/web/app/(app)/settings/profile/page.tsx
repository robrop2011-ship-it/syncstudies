import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ProfileForm } from '@/components/app/profile-form';
import { getMeView } from '@/lib/server/me';
import { requireSession } from '@/lib/server/session';

export const metadata: Metadata = { title: 'Profile settings' };
export const dynamic = 'force-dynamic';

export default async function ProfileSettingsPage() {
  const session = await requireSession('/settings/profile');
  const me = await getMeView(session.user.id);
  if (me === null) redirect('/login');

  return (
    <ProfileForm
      handle={me.user.handle}
      displayName={me.user.displayName}
      bio={me.user.bio}
      school={me.user.school}
    />
  );
}
