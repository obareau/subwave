'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';

// The mixer reports its music chain starved (#1300 bug 7): nothing to play, so
// the emergency loop is on air. Broader than NavidromeBanner on purpose — a
// starve also happens with Navidrome perfectly healthy (an empty auto.m3u, an
// over-strict show whose pool resolved to nothing), and it reports what is
// actually happening ON AIR rather than which dependency is down.
//
// Renders nothing until a starved reading arrives, and stands down entirely
// while the Navidrome banner is up, which is the more specific message.
export default function MusicStarvedBanner({
  adminFetch,
  suppressed = false,
}: {
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  suppressed?: boolean;
}) {
  const [starved, setStarved] = useState(false);
  // adminFetch's identity changes as auth state ticks; hold the latest in a ref
  // so the poll interval mounts once instead of tearing down every render.
  const fetchRef = useRef(adminFetch);
  fetchRef.current = adminFetch;

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const r = await fetchRef.current('/state');
        if (!r.ok) return; // 401 / 5xx — don't flip the banner on an auth blip
        const j = (await r.json()) as { musicStarved?: boolean };
        if (!cancelled) setStarved(j.musicStarved === true);
      } catch {
        // Controller unreachable — leave the last known state rather than
        // flapping; a dead controller has its own, louder failure modes.
      }
    };
    check();
    const id = setInterval(check, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!starved || suppressed) return null;

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--danger)] bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] px-5 py-2 text-[11px] text-ink sm:px-7"
    >
      <AlertTriangle size={14} className="shrink-0 text-[var(--danger)]" aria-hidden="true" />
      <span>
        <b>No music to play.</b> The station has run out of tracks and is airing the emergency
        loop. Check that your music source is reachable and that the current show isn&rsquo;t
        filtered down to nothing.
      </span>
      <Link
        href="/admin/doctor"
        className="ml-auto inline-flex min-h-9 items-center font-bold text-[var(--danger)] underline-offset-2 hover:underline sm:min-h-0"
      >
        Run the Doctor &rarr;
      </Link>
    </div>
  );
}
