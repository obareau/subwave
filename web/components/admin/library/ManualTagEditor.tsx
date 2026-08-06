'use client';

import type { ChangeEvent } from 'react';
import { useState } from 'react';
import { Btn, Eyebrow, Pill, Seg } from '../ui';
import { cn } from '../../../lib/cn';
 
import { SkeletonText } from '@/components/ui/skeleton';
import type { Track } from './types';

const ENERGY_SEG: { id: string; label: string }[] = [
  { id: 'none', label: 'none' },
  { id: 'low', label: 'low' },
  { id: 'medium', label: 'med' },
  { id: 'high', label: 'high' },
];

export function ManualTagEditor(props: {
  track: Track;
  vocab: string[];
  busy: boolean;
  onSave: (moods: string[], energy: string | null, applyToAlbum: boolean) => void;
  onCancel: () => void;
}) {
  const { track, vocab, busy } = props;
  const [sel, setSel] = useState<string[]>((track.moods || []).slice(0, 3));
  const [energy, setEnergy] = useState<string>(track.energy || 'none');
  const [applyToAlbum, setApplyToAlbum] = useState(false);

  const toggle = (m: string) =>
    setSel(cur => cur.includes(m) ? cur.filter(x => x !== m) : (cur.length >= 3 ? cur : [...cur, m]));
  const energyVal = energy === 'none' ? null : energy;

  return (
    <div className="grid gap-3 border-b border-ink bg-[var(--ink-softer)] px-4 py-3">
      <div className="grid gap-1.5">
        <Eyebrow>moods · up to 3</Eyebrow>
        <div className="flex flex-wrap gap-1.5">
          {vocab.length === 0 && <SkeletonText lines={1} />}
          {vocab.map(m => {
            const on = sel.includes(m);
            // Unpicked chips go unavailable once three are chosen, and every
            // chip does while a save is in flight. Passed as `disabled` rather
            // than by dropping onClick: without a handler the Pill falls back
            // to a Badge <span>, which is neither focusable nor announced as
            // unavailable — so the cap was invisible to a keyboard user, who
            // simply found that chips had stopped responding.
            const unavailable = busy || (!on && sel.length >= 3);
            return (
              <Pill
                key={m}
                tone={on ? 'accent' : 'default'}
                pressed={on}
                disabled={unavailable}
                onClick={() => toggle(m)}
                className={cn(unavailable && !on && 'opacity-40')}
              >
                {m}
              </Pill>
            );
          })}
        </div>
      </div>
      <div className="grid gap-1.5">
        <Eyebrow>energy</Eyebrow>
        <div><Seg value={energy} options={ENERGY_SEG} onChange={setEnergy} /></div>
      </div>
      <label className="flex items-center gap-2 text-[12px] text-ink">
        <input
          type="checkbox"
          checked={applyToAlbum}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setApplyToAlbum(e.target.checked)}
          disabled={busy}
        />
        apply to whole album{track.album ? ` “${track.album}”` : ''}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Btn sm tone="accent" onClick={() => props.onSave(sel, energyVal, applyToAlbum)} disabled={busy || sel.length === 0}>
          {busy ? 'Saving…' : 'Save tags'}
        </Btn>
        <Btn sm tone="danger" onClick={() => props.onSave([], null, applyToAlbum)} disabled={busy}>
          Clear tags
        </Btn>
        <Btn sm onClick={props.onCancel} disabled={busy}>Cancel</Btn>
      </div>
    </div>
  );
}

