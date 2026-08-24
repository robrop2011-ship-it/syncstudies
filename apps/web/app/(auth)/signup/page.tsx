import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { SignupForm } from '@/components/auth/signup-form';
import { getCurrentSession } from '@/lib/server/session';
import { safeNextPath } from '@/lib/api';

export const metadata: Metadata = {
  title: 'Create your account',
  description: 'A username and a password. No email address required.',
};

export const dynamic = 'force-dynamic';

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.next;
  const next = safeNextPath(typeof raw === 'string' ? raw : undefined);

  // Already signed in: honour the intent they arrived with (§2.1) rather than
  // showing a signup form to somebody who has an account.
  const session = await getCurrentSession();
  if (session !== null) redirect(next);

  return <SignupForm next={next} />;
}
