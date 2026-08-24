import type * as React from 'react';
import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/toaster';
import { THEME_INIT_SCRIPT } from '@/lib/theme';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
  // The stack globals.css falls back to while the font loads, and forever if it
  // never does. Inter's metrics are close enough to these that the swap barely moves.
  fallback: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial'],
});

export const metadata: Metadata = {
  title: {
    default: 'SyncStudy — watch lectures together, in sync',
    template: '%s · SyncStudy',
  },
  description:
    'Watch a YouTube lecture with your study group, kept to the same second, with voice, chat and shared notes in one window.',
  applicationName: 'SyncStudy',
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  // No maximumScale / userScalable:false — pinch-zoom stays available, which
  // matters more than a tidy layout for anyone reading chat on a phone.
  width: 'device-width',
  initialScale: 1,
  // Both entries, so the browser chrome matches whichever theme resolves.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#131211' },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    // suppressHydrationWarning: the script below mutates <html> before React sees
    // it, which is the entire point — without it the server markup and the client
    // markup are guaranteed to differ for anyone not on the default theme.
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <head>
        {/* Must be inline and synchronous. An external file or a useEffect both
            run after first paint, which is precisely the white flash this exists
            to prevent. See lib/theme.ts. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-dvh bg-bg text-primary antialiased">
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster />
      </body>
    </html>
  );
}
