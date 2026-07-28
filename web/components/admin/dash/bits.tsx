'use client';

// Small dashboard pieces: the sortable table header, the manual-segment
// buttons, the toggle rows, and one booth turn's text.
//
// Part of the dash/ split - see ../DashPanel.tsx.

import { eventTurnSummary, turnText } from '../../../lib/sessionFeed';
import type { SessionTurn } from '../../../lib/types';
import { Toggle } from '../ui';
import { type LucideIcon } from 'lucide-react';
import { cn } from '../../../lib/cn';
import type { SortKey, SortState } from './types';

export function SortableTh({
  label,
  col,
  sort,
  onSort,
  className,
}: {
  label: string;
  col: SortKey;
  sort: SortState;
  onSort: (s: SortState) => void;
  className?: string;
}) {
  const active = sort.key === col;
  const arrow = active ? (sort.dir === 'asc' ? '↑' : '↓') : '';
  return (
    <th className={cn('py-1.5 font-bold', className)}>
      <button
        type="button"
        className={cn('uppercase hover:text-ink', active && 'text-ink')}
        onClick={() =>
          onSort(
            active
              ? { key: col, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
              : { key: col, dir: col === 'connectedSeconds' ? 'desc' : 'asc' },
          )
        }
      >
        {label}
        {arrow ? <span className="ml-1">{arrow}</span> : null}
      </button>
    </th>
  );
}

interface SegmentButtonProps {
  label: string;
  icon: LucideIcon;
  busyHere: boolean;
  anyBusy: boolean;
  onFire: () => void;
}

// A studio cart-machine pad — all visual states live in .seg-pad (globals.css):
// hover arms the LED, .is-firing blinks it and sweeps the base while on air.
export function SegmentButton({ label, icon: Icon, busyHere, anyBusy, onFire }: SegmentButtonProps) {
  return (
    <button
      type="button"
      disabled={anyBusy}
      onClick={onFire}
      className={cn('seg-pad', busyHere && 'is-firing')}
    >
      <span className="seg-led" aria-hidden />
      <Icon className="seg-glyph" strokeWidth={1.5} aria-hidden />
      <span className="seg-label">{label}</span>
      <span className="seg-cta">{busyHere ? 'on air' : 'fire'}</span>
    </button>
  );
}

interface ToggleRowProps {
  label: string;
  desc: string;
  on: boolean;
  disabled?: boolean;
  onToggle: () => void;
}

export function ToggleRow({ label, desc, on, disabled, onToggle }: ToggleRowProps) {
  return (
    <div className="flex items-center gap-2.5">
      <div className="flex-1">
        <div className="text-[12px] font-bold">{label}</div>
        <div className="text-[10px] text-muted">{desc}</div>
      </div>
      <Toggle on={on} disabled={disabled} onClick={onToggle} ariaLabel={label} />
    </div>
  );
}

export function classTone(cls: string): string {
  switch (cls) {
    case 'voice':
    case 'track':
      return 'accent';
    default:
      return 'muted';
  }
}

// One booth-log message. Long `event` turns (the pick prompt posted to the DJ
// agent — link/clock/transition coaching) render as a one-line summary; the
// raw prompt never shows here (it's in the session JSON if ever needed).
export function BoothTurnText({ turn }: { turn: SessionTurn }) {
  // Plain text, deliberately not markdown-rendered — booth turns are speech
  // scripts, not documents.
  return <span className="break-words text-ink">{eventTurnSummary(turn) ?? turnText(turn)}</span>;
}

// Collapse whitespace + truncate, for the one-line request preview in a summary.
export function oneLine(s: unknown, n = 80): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

// The Requests card — every listener request and exactly how the AI DJ
// resolved it. Newest first; each row expands to the full debug trace.

