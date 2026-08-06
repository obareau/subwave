import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Masthead from '@/components/landing/Masthead';
import StationFooter from '@/components/landing/StationFooter';

export const metadata: Metadata = {
  title: 'SUB/WAVE — Community Personas',
  description:
    'The community persona catalog for SUB/WAVE: DJ identities other operators wrote, installable from any station’s admin console.',
};

// Shared chrome for the /personas showcase: masthead, full-width broadsheet
// column, station footer.
export default function PersonasLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-bg text-ink">
      <Masthead />
      <main className="bs-paper">
        {children}
        <StationFooter />
      </main>
    </div>
  );
}
