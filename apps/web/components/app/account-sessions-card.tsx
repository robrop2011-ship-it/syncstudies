'use client';

/**
 * Sessions and data export (PLAN.md feature A3, §11.9).
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Download, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { api, messageOf } from '@/lib/api';

export function AccountSessionsCard({ sessionCount }: { sessionCount: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signOutEverywhere = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/logout-all');
      router.push('/login');
      router.refresh();
    } catch (caught) {
      setError(messageOf(caught));
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Sessions and data" description="Where you are signed in, and what we hold." />
      <CardBody>
        <div className="flex flex-col">
          {error !== null ? (
            <div className="pb-4">
              <Callout tone="danger">{error}</Callout>
            </div>
          ) : null}

          <div className="flex items-start justify-between gap-6 border-b border-border pb-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-primary">Sign out everywhere</p>
              <p className="mt-0.5 text-13 leading-5 text-secondary">
                {sessionCount === 1
                  ? 'You are signed in on this device only. This will end that session.'
                  : `You are signed in on ${sessionCount} devices. This ends all of them, including this one.`}
              </p>
            </div>
            <Button
              type="button"
              variant="secondary"
              loading={busy}
              disabled={busy}
              onClick={() => {
                void signOutEverywhere();
              }}
            >
              <LogOut size={16} strokeWidth={1.5} aria-hidden="true" />
              Sign out everywhere
            </Button>
          </div>

          <div className="flex items-start justify-between gap-6 pt-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-primary">Export your data</p>
              <p className="mt-0.5 text-13 leading-5 text-secondary">
                A JSON file with everything tied to this account: your profile, settings, rooms,
                messages, notes and study sessions.
              </p>
            </div>
            <Button asChild variant="secondary">
              <a href="/api/me/export" download>
                <Download size={16} strokeWidth={1.5} aria-hidden="true" />
                Download
              </a>
            </Button>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
