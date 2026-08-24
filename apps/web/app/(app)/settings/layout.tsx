import type { ReactNode } from 'react';
import { SettingsNav } from '@/components/app/settings-nav';

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <h1 className="text-xl font-semibold tracking-[-0.01em] text-primary">Settings</h1>
      <div className="mt-4">
        <SettingsNav />
      </div>
      <div className="mt-6 flex flex-col gap-6">{children}</div>
    </div>
  );
}
