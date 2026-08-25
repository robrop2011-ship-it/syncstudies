import type * as React from 'react';

/**
 * The three elements a policy page is made of.
 *
 * Declared once so the four prose pages cannot drift apart typographically, and
 * so the type scale stays inside §12.1 rule 7's six sizes.
 */
export function PageTitle({ children, updated }: { children: React.ReactNode; updated?: string }) {
  return (
    <header className="mb-8 border-b border-border pb-6">
      <h1 className="text-28 font-semibold text-primary">{children}</h1>
      {updated === undefined ? null : (
        <p className="mt-2 text-13 text-tertiary">Last updated {updated}</p>
      )}
    </header>
  );
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="mb-2 text-base font-medium text-primary">{title}</h2>
      <div className="flex flex-col gap-3 text-sm leading-6 text-secondary">{children}</div>
    </section>
  );
}

export function List({ children }: { children: React.ReactNode }) {
  return <ul className="flex list-disc flex-col gap-2 pl-5">{children}</ul>;
}
