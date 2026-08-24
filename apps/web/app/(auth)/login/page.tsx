import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { LoginForm } from '@/components/auth/login-form';
import { getCurrentSession } from '@/lib/server/session';
import { safeNextPath } from '@/lib/api';

export const metadata: Metadata = {
  title: 'Sign in',
  description: 'Sign in to SyncStudy.',
};

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.next;
  // `?next=` comes from middleware and from room invite links (§2.2). It is
  // filtered to same-site paths so it cannot be used to bounce someone off-site
  // after a successful sign-in.
  const next = safeNextPath(typeof raw === 'string' ? raw : undefined);

  const session = await getCurrentSession();
  if (session !== null) redirect(next);

  return <LoginForm next={next} />;
}
