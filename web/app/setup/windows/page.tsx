import Windows from "@/components/setup/Windows";
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Setup · Windows',
  description:
    'Install SUB/WAVE on Windows — WSL2 with the full CLI, or plain docker compose from PowerShell, plus the Windows-specific gotchas.',
  path: '/setup/windows',
});

export default function WindowsPage() {
  return <Windows />;
}
