import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { PrivacyForm } from '@/components/app/privacy-form';
import { getMeView } from '@/lib/server/me';
import { requireSession } from '@/lib/server/session';

export const metadata: Metadata = { title: 'Privacy settings' };
export const dynamic = 'force-dynamic';

export default async function PrivacySettingsPage() {
  const session = await requireSession('/settings/privacy');
  const me = await getMeView(session.user.id);
  if (me === null) redirect('/login');

  return <PrivacyForm settings={me.settings} isMinor={me.user.isMinor} />;
}
