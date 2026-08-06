import MacOs from "@/components/setup/MacOs";
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Setup · macOS',
  description:
    'Install SUB/WAVE on a Mac — Docker Desktop or OrbStack, VM sizing, Apple Silicon notes, and the Mac-specific gotchas.',
  path: '/setup/macos',
});

export default function MacOsPage() {
  return <MacOs />;
}
