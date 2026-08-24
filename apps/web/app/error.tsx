'use client';

import * as React from 'react';
import Link from 'next/link';
import { Button, buttonVariants } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';

/**
 * The route-level error boundary. Client component by requirement — Next needs
 * `reset` to be callable from the browser.
 *
 * It shows the digest, not the message: `error.message` is scrubbed to a generic
 * string in production anyway, and the digest is the one value that lets someone
 * find the actual stack in the logs.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  React.useEffect(() => {
    // eslint-disable-next-line no-console
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col justify-center px-4 py-24 sm:px-6">
      <h1 className="text-xl font-semibold text-primary">Something went wrong</h1>
      <p className="mt-2 max-w-md text-sm text-secondary">
        This page failed to load. Trying again usually works; if it doesn&rsquo;t, the room itself is
        unaffected and your notes are saved.
      </p>

      {error.digest !== undefined ? (
        <Callout tone="info" className="mt-5 max-w-md" title="Reference">
          <span className="font-mono">{error.digest}</span> — quote this if you report it.
        </Callout>
      ) : null}

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={reset}>
          Try again
        </Button>
        <Link href="/" className={buttonVariants({ variant: 'secondary' })}>
          Go home
        </Link>
      </div>
    </main>
  );
}
