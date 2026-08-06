import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import DocShell from '@/components/docs/DocShell';
import { MANUAL_PAGES } from '@/components/manual/pages';

export const metadata: Metadata = {
  title: 'SUB/WAVE — Manual',
  description:
    'How to use SUB/WAVE — tuning in, making requests, how the AI DJ works, and running the station from the admin console.',
};

// Per-request so every manual page's canonical/og:url picks up the runtime
// SITE_URL; a build-time render bakes localhost into image-based installs (see
// lib/site.ts).
export const dynamic = 'force-dynamic';

export default function ManualLayout({ children }: { children: ReactNode }) {
  return (
    <DocShell pages={MANUAL_PAGES} eyebrow="THE MANUAL" ariaLabel="Manual contents">
      {children}
    </DocShell>
  );
}
