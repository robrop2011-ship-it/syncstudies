import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { prisma } from '@syncstudy/db';
import { AccountSessionsCard } from '@/components/app/account-sessions-card';
import { ChangePasswordForm } from '@/components/app/change-password-form';
import { DeleteAccountCard } from '@/components/app/delete-account-card';
import { RecoveryCodeCard } from '@/components/app/recovery-code-card';
import { formatDate } from '@/lib/server/format';
import { requireSession } from '@/lib/server/session';

export const metadata: Metadata = { title: 'Account settings' };
export const dynamic = 'force-dynamic';

export default async function AccountSettingsPage() {
  const session = await requireSession('/settings/account');
  const userId = session.user.id;

  const [user, sessionCount] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { recoveryIssuedAt: true } }),
    prisma.authSession.count({ where: { userId, expiresAt: { gt: new Date() } } }),
  ]);
  if (user === null) redirect('/login');

  return (
    <>
      <ChangePasswordForm />
      <RecoveryCodeCard
        issuedAt={user.recoveryIssuedAt === null ? null : formatDate(user.recoveryIssuedAt)}
      />
      <AccountSessionsCard sessionCount={Math.max(1, sessionCount)} />
      <DeleteAccountCard />
    </>
  );
}
