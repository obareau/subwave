'use client';

import { useState, type ReactNode } from 'react';
import { APP_TYPE_LABELS, type AppType } from '@/lib/apps';

// Wraps the server-rendered grid rather than rendering the cards itself: it
// sets data-filter here and CSS hides the cards whose data-type doesn't match
// (see .bs-apps-filterwrap in globals.css), which keeps AppCard a server
// component.
//
// `types` is only the types present in the catalog (lib/apps presentTypes), so
// every chip has a card behind it and there is no reachable "nothing matched"
// state to render.
export default function AppTypeFilter({
  types,
  children,
}: {
  types: AppType[];
  children: ReactNode;
}) {
  const [active, setActive] = useState<AppType | 'all'>('all');

  // One chip is no choice at all — render the grid bare.
  if (types.length < 2) return <>{children}</>;

  const chips: Array<{ key: AppType | 'all'; label: string }> = [
    { key: 'all', label: 'All' },
    ...types.map((t) => ({ key: t, label: APP_TYPE_LABELS[t] })),
  ];

  return (
    <div className="bs-apps-filterwrap" data-filter={active}>
      <div className="bs-apps-filter" role="group" aria-label="Filter apps by type">
        {chips.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            className="bs-apps-chip"
            aria-pressed={active === key}
            onClick={() => setActive(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {children}
    </div>
  );
}
