import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Masthead from '@/components/landing/Masthead';
import StationFooter from '@/components/landing/StationFooter';

export const metadata: Metadata = {
  title: 'SUB/WAVE — Community Shows',
  description:
    'The community show catalog for SUB/WAVE: show templates other operators built, installable from any station’s admin console.',
};

// Shared chrome for the /shows showcase: masthead, full-width broadsheet
// column, station footer.
export default function ShowsLayout({ children }: { children: ReactNode }) {
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
