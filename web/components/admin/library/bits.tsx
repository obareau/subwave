'use client';

import type { RefObject } from 'react';
import { useEffect, useState } from 'react';
import { ADMIN_API_URL } from '../../../lib/adminAuth';
import { cn } from '../../../lib/cn';
 
import type { BlockRef, Track } from './types';

// Never-play wording, shared by the row badge, the row action and its tooltip so the
// operator reads the same scope word everywhere.
export function blockedByLabel(ref: BlockRef): string {
  if (ref.kind === 'rule') return `rule "${ref.label}"${ref.seasonal ? ' (out of season)' : ''}`;
  return ref.name ? `${ref.type} "${ref.name}"` : `this ${ref.type}`;
}

// Spells out the blast radius: unblocking an artist lets their whole catalogue back.
// Rule refs never get this — a rule can block hundreds of rows, so the row action
// points at the Blocked tab instead of offering a one-click mass unblock.
export function unblockLabel(ref: BlockRef): string {
  return `Unblock ${blockedByLabel(ref)}`;
}

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

// Letter-tile fallback when art is missing or the /cover/:id request errors.
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

export const CHECK_HIT = '-m-3 flex cursor-pointer items-center p-3 sm:m-0 sm:p-0';

// Document listeners rather than a full-screen click-catcher div, which would need a
// non-semantic clickable element with no keyboard path. `pointerdown` covers mouse,
// touch and pen in one listener.
//
// The disclosed panels are plain <button> groups and NOT role="menu"/"menuitem": that
// role pair promises the full menu keyboard pattern (roving focus, Home/End), and
// announcing a menu we don't implement is worse for screen readers than plain buttons.
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
      // Return focus to the trigger so keyboard users aren't dropped to the top.
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

// Items are ≥36px tall so they stay thumb-sized on the phone layout.
export const MENU_PANEL =
  'absolute top-full right-0 z-50 mt-1 max-w-[calc(100vw-2rem)] min-w-[220px] rounded-md border bg-popover p-1 text-popover-foreground shadow-md';
export const MENU_ITEM =
  'flex w-full items-center gap-2 rounded px-2.5 py-2.5 text-left text-[12px] hover:bg-[var(--ink-soft)] hover:text-ink disabled:opacity-40';

