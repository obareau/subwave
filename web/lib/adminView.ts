'use client';

// Browser-local admin view preferences: roster view (cards or list) for
// /admin/skills, /admin/shows and /admin/personas, and the Rundown board's
// pixels-per-hour density.
//
// Stored PER SURFACE, not globally — an operator may want Skills as a dense
// list while Shows stays on cards. Browser-local like the skin/theme
// overrides: a cheap preference, not station state.

import { useCallback, useEffect, useState } from 'react';

export type RosterSurface = 'skills' | 'shows' | 'personas';
export type RosterView = 'cards' | 'list';

const KEY_PREFIX = 'subwave-admin-view:';

function isView(v: string | null): v is RosterView {
  return v === 'cards' || v === 'list';
}

export function readRosterView(surface: RosterSurface): RosterView {
  if (typeof window === 'undefined') return 'cards';
  try {
    const raw = window.localStorage.getItem(`${KEY_PREFIX}${surface}`);
    return isView(raw) ? raw : 'cards';
  } catch {
    return 'cards';
  }
}

function writeRosterView(surface: RosterSurface, view: RosterView): void {
  try {
    window.localStorage.setItem(`${KEY_PREFIX}${surface}`, view);
  } catch { /* private-mode browsers throw on setItem — the view still works */ }
}

/* `[view, setView]` for one roster surface. Starts on 'cards' and reads the
   stored preference in a mount effect rather than in the initial state, so
   server and first client render agree. A list-view operator sees one frame of
   cards on a cold load; the panels render a skeleton while the roster fetch is
   in flight, so in practice the view resolves before there is a roster to
   draw. */
export function useRosterView(surface: RosterSurface): [RosterView, (v: RosterView) => void] {
  const [view, setViewState] = useState<RosterView>('cards');

  useEffect(() => { setViewState(readRosterView(surface)); }, [surface]);

  const setView = useCallback((v: RosterView) => {
    setViewState(v);
    writeRosterView(surface, v);
  }, [surface]);

  return [view, setView];
}

export type BoardDensity = 'compact' | 'comfortable';

/** Compact is the tallest unit that still holds one line of card text, which
 *  puts a 24-hour day at ~630px instead of ~820px. */
export const BOARD_HOUR_PX: Record<BoardDensity, number> = { compact: 26, comfortable: 34 };

const DENSITY_KEY = 'subwave-admin-board-density';

function isDensity(v: string | null): v is BoardDensity {
  return v === 'compact' || v === 'comfortable';
}

/** Same hydration shape as `useRosterView`: the default renders on the server
 *  and the stored preference lands in a mount effect. */
export function useBoardDensity(): [BoardDensity, (d: BoardDensity) => void] {
  const [density, setDensityState] = useState<BoardDensity>('comfortable');

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(DENSITY_KEY);
      if (isDensity(raw)) setDensityState(raw);
    } catch { /* private-mode browsers throw on getItem — the default stands */ }
  }, []);

  const setDensity = useCallback((d: BoardDensity) => {
    setDensityState(d);
    try {
      window.localStorage.setItem(DENSITY_KEY, d);
    } catch { /* as above — the choice still applies for this session */ }
  }, []);

  return [density, setDensity];
}
