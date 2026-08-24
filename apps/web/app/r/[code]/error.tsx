'use client';

/**
 * The room's error boundary.
 *
 * Scoped to `/r/[code]` rather than inherited from the root one because the
 * reassurance is different here: a room that fails to render has not lost
 * anything. The room itself lives in the realtime service and Postgres, the
 * other people in it are unaffected, and reloading rejoins.
 *
 * The digest is shown and the message is not — in production the message is
 * scrubbed to a generic string anyway, and the digest is the value that finds
 * the real stack in the logs (§11.10).
 */
import { useEffect } from 'react';
import Link from 'next/link';
import { TriangleAlert } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Logo } from '@/components/ui/logo';

export default function RoomError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-12 shrink-0 items-center border-b border-border px-4 sm:px-6">
        <Link
          href="/dashboard"
          className="flex items-center gap-2 rounded-sm text-sm font-medium text-primary"
        >
          <Logo size={16} />
          <span>SyncStudy</span>
        </Link>
      </header>

      <main className="flex flex-1 items-center justify-center px-4 py-16">
        <div className="w-full max-w-[420px]">
          <Card className="flex flex-col items-center gap-4 p-6 text-center">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border-strong text-tertiary">
              <TriangleAlert size={16} strokeWidth={1.5} aria-hidden="true" />
            </span>

            <div className="flex flex-col gap-1">
              <h1 className="text-base font-medium text-primary">This room failed to load</h1>
              <p className="text-13 text-secondary">
                The room itself is fine and everyone else is still in it. Rejoining almost always
                works.
              </p>
              {error.digest !== undefined ? (
                <p className="mt-1 text-13 text-tertiary">
                  Reference <span className="font-mono">{error.digest}</span>
                </p>
              ) : null}
            </div>

            <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
              <Button variant="primary" onClick={reset}>
                Rejoin
              </Button>
              <Link href="/dashboard" className={buttonVariants({ variant: 'secondary' })}>
                Your rooms
              </Link>
            </div>
          </Card>
        </div>
      </main>
    </div>
  );
}
