'use client';

import { cn } from '../../../lib/cn';
import type { Persona } from './types';
import { abbrev } from './lib';

// A persona avatar — the initials-behind-<img> pattern shared with the show
// pickers (a broken/absent avatar falls back to readable initials). Two sizes:
// 'lg' anchors the host; 'sm' builds the overlapping guest cluster.
export function ShowAvatar({
  persona, apiBase, size, className,
}: {
  persona: Persona | null;
  apiBase: string;
  size: 'lg' | 'sm';
  className?: string;
}) {
  const src = persona?.avatar
    ? `${apiBase}/persona-avatar/${encodeURIComponent(persona.id)}`
    : null;
  const name = persona?.name?.trim();
  return (
    <span
      className={cn(
        'relative grid flex-none place-items-center overflow-hidden border border-ink bg-[var(--ink-softer)]',
        size === 'lg' ? 'size-12' : 'size-6',
        className,
      )}
    >
      <span className={cn('font-extrabold text-muted', size === 'lg' ? 'text-[13px]' : 'text-[8px]')}>
        {name ? abbrev(name) : '—'}
      </span>
      {src && (
        <img
          src={src}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
        />
      )}
    </span>
  );
}


