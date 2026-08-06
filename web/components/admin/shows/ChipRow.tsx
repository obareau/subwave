'use client';

import { cn } from '../../../lib/cn';
import { FILTER_VALUES_MAX } from './types';

// Toggleable chip row for the multi-select music filters (#929). Selected
// chips invert; unselected ones grey out once the cap is hit. Same visual
// language as the LibraryPanel energy pills.
export function ChipRow({ options, selected, onToggle, cap = FILTER_VALUES_MAX }: {
  options: { key: string; label: string }[];
  selected: string[];
  onToggle: (key: string) => void;
  cap?: number;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map(o => {
        const on = selected.includes(o.key);
        const atCap = !on && selected.length >= cap;
        return (
          <button
            key={o.key}
            type="button"
            aria-pressed={on}
            disabled={atCap}
            onClick={() => onToggle(o.key)}
            className={cn(
              // Tappable on a phone; desktop keeps the padding-driven height.
              'min-h-9 border border-ink px-2 py-0.5 text-[12px] sm:min-h-0',
              on ? 'bg-ink text-bg' : 'text-ink hover:bg-[var(--ink-soft)]',
              atCap && 'cursor-not-allowed opacity-40',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

