'use client';

// Small presentational pieces and the menu styling every row action reuses.
//
// Part of the library/ split - see ../LibraryPanel.tsx.

import type { RefObject } from 'react';
import { useEffect, useState } from 'react';
import { ADMIN_API_URL } from '../../../lib/adminAuth';
import { cn } from '../../../lib/cn';
 
import type { Track } from './types';

export function fmtDuration(sec?: number | null): string | null {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return null;
  const total = Math.round(sec);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function EnergyMeter({ level }: { level?: string | null }) {
  const cls = level === 'high' ? 'h' : level === 'medium' ? 'm' : level === 'low' ? 'l' : '';
  return (
    <span className={cn('lib-emeter', cls)} aria-hidden>
      <span /><span /><span />
    </span>
  );
}

// Album thumbnail via the public /cover/:id proxy, with a letter-tile fallback
// when art is missing or the request errors. The fallback is token-coloured so
// it never clashes with the active theme.
export function Thumb({ track }: { track: Track }) {
  const [errored, setErrored] = useState(false);
  const letter = (track.album || track.title || track.artist || '?').trim()[0]?.toUpperCase() || '?';
  const showImg = !!track.id && !errored;
  return (
    <span className="lib-thumb">
      {showImg ? (
         
        <img
          src={`${ADMIN_API_URL}/cover/${encodeURIComponent(track.id)}`}
          alt=""
          loading="lazy"
          onError={() => setErrored(true)}
        />
      ) : letter}
    </span>
  );
}

// ---------------------------------------------------------------------------
// panel
// ---------------------------------------------------------------------------

export const CHECK_HIT = '-m-3 flex cursor-pointer items-center p-3 sm:m-0 sm:p-0';

// Dismiss an open disclosure on an outside pointer/touch, on focus leaving the
// group, or on Escape — via document listeners rather than a full-screen
// click-catcher div, which relies on a non-semantic clickable element with no
// keyboard path. `pointerdown` covers mouse, touch, and pen in one listener.
//
// The disclosed panels are deliberately plain groups of <button>s and NOT
// role="menu"/"menuitem": that role pair is a contract for the full menu
// keyboard pattern (arrow-key roving focus, Home/End, focus into the first
// item on open). Announcing a menu we don't implement leaves screen-reader
// users pressing arrow keys at something that only answers to Tab, which is
// worse than the plain buttons they'd otherwise get.
export function useDismissOnOutside(
  open: boolean,
  close: () => void,
  rootRef: RefObject<HTMLDivElement | null>,
  triggerRef: RefObject<HTMLButtonElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    const outside = (target: EventTarget | null) =>
      !!rootRef.current && !rootRef.current.contains(target as Node);
    const onPointer = (e: PointerEvent) => { if (outside(e.target)) close(); };
    const onFocusIn = (e: FocusEvent) => { if (outside(e.target)) close(); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      close();
      // Escape returns focus to the control that opened the panel, so keyboard
      // users don't get dropped back to the top of the document.
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('keydown', onKey);
    };
    // close/refs are stable for the life of the row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

// Shared popup shell + item chrome for both row menus. Items are ≥36px tall so
// they stay thumb-sized on the phone layout that surfaces them.
export const MENU_PANEL =
  'absolute top-full right-0 z-50 mt-1 max-w-[calc(100vw-2rem)] min-w-[220px] rounded-md border bg-popover p-1 text-popover-foreground shadow-md';
export const MENU_ITEM =
  'flex w-full items-center gap-2 rounded px-2.5 py-2.5 text-left text-[12px] hover:bg-[var(--ink-soft)] hover:text-ink disabled:opacity-40';

// ---------------------------------------------------------------------------
// RowActionsMenu — the phone-only overflow menu. The four inline row buttons
// (queue / edit / retag / never-play) cost ~160px, which is more than the track
// title gets at 390px, so below sm: every action lives behind this one control
// and the inline cluster hides. Same actions, same handlers — no mobile-only
// behaviour, just a different affordance.
// ---------------------------------------------------------------------------

