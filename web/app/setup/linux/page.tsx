import Linux from "@/components/setup/Linux";
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Setup · Linux',
  description:
    'Install SUB/WAVE on a Linux host — Docker Engine, firewall, SELinux, state placement, sizing, and reboot persistence.',
  path: '/setup/linux',
});

export default function LinuxPage() {
  return <Linux />;
}
