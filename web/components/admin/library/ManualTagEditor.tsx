'use client';

// Inline editor for a single track's moods and energy.
//
// Part of the library/ split - see ../LibraryPanel.tsx.

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
            return (
              <Pill
                key={m}
                tone={on ? 'accent' : 'default'}
                onClick={busy || (!on && sel.length >= 3) ? undefined : () => toggle(m)}
                className={cn(
                  (busy || (!on && sel.length >= 3)) && !on && 'opacity-40',
                  !busy && 'cursor-pointer',
                )}
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

// ---------------------------------------------------------------------------
// AddToPlaylistBar — shown while rows are selected on any track tab. Adds the
// selection to an existing Navidrome playlist or creates a new one; both go
// through the controller's /playlists routes (Subsonic createPlaylist /
// updatePlaylist under the hood).
// ---------------------------------------------------------------------------

