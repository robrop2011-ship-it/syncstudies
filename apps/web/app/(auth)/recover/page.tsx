import type { Metadata } from 'next';
import { RecoverForm } from '@/components/auth/recover-form';
import { safeNextPath } from '@/lib/api';

export const metadata: Metadata = {
  title: 'Use your recovery code',
  description: 'Set a new password with the one-time recovery code from signup.',
};

export const dynamic = 'force-dynamic';

export default async function RecoverPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.next;
  const next = safeNextPath(typeof raw === 'string' ? raw : undefined);

  // Deliberately reachable while signed in: "I am logged in here but have lost
  // the password" is exactly when someone needs this page.
  return <RecoverForm next={next} />;
}
