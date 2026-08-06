'use client';

// Shared "station switch in flight" machinery for the sidebar switcher and the
// /admin/stations panel. station.id is boot-frozen
// (controller/src/routes/public.ts), so a /state response carrying the target id
// (or multiStation for CONVERT_SENTINEL) means the restart completed; then hard
// reload so every hook re-derives from the new station's settings.

import { useEffect, useRef } from 'react';
import { useAdminAuth } from '../lib/adminAuth';

// Target value for a fresh-install → multi-station conversion, where the
// switch lands back on the SAME station and only multiStation flips.
export const CONVERT_SENTINEL = '__convert__';

interface StateStationField {
  station?: {
    id?: string | null;
    multiStation?: boolean;
  };
}

export function useStationSwitchPoll(switching: string | null) {
  const { adminFetch } = useAdminAuth();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!switching) return;
    pollRef.current = setInterval(async () => {
      try {
        const r = await adminFetch('/state');
        if (!r.ok) return;
        const j = (await r.json()) as StateStationField;
        const arrived =
          switching === CONVERT_SENTINEL
            ? j?.station?.multiStation === true
            : j?.station?.id === switching;
        if (arrived) window.location.reload();
      } catch {
        /* controller still down mid-restart — keep polling */
      }
    }, 2000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [switching, adminFetch]);
}
