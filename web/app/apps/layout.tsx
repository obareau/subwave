import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import AppsShell from '@/components/apps/AppsShell';

export const metadata: Metadata = {
  title: 'SUB/WAVE — Apps',
  description:
    'Apps and integrations built for SUB/WAVE stations: players, bots, terminal clients and more, made by the community.',
};

export default function AppsLayout({ children }: { children: ReactNode }) {
  return <AppsShell>{children}</AppsShell>;
}
