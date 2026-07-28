'use client';

// The track table and its per-row action menus. One table serves all four
// listing variants (recent, browse, search, untagged); `variant` decides which
// columns and actions are offered.
//
// Part of the library/ split - see ../LibraryPanel.tsx.

import { Fragment, useRef, useState } from 'react';
import { RotateCcw, Sparkles, ListPlus, X, Pencil, Ban, Tags, MoreVertical } from 'lucide-react';
import { Btn } from '../ui';
import { cn } from '../../../lib/cn';
 
import { SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import type { BlockType, TableVariant, Track } from './types';
import {
  CHECK_HIT,
  EnergyMeter,
  MENU_ITEM,
  MENU_PANEL,
  Thumb,
  fmtDuration,
  useDismissOnOutside,
} from './bits';
import { ManualTagEditor } from './ManualTagEditor';

interface TrackTableProps {
  tab: TableVariant;
  rows: Track[];
  loading: boolean;
  queuing: string | null;
  retagging: string | null;
  flashId: string | null;
  onQueue: (t: Track) => void;
  onRetag: (t: Track) => void;
  blocking: string | null;
  onBlock: (t: Track, type: BlockType) => void;
  vocab: string[];
  editingId: string | null;
  manualBusy: string | null;
  onEdit: (t: Track) => void;
  onSaveManual: (t: Track, moods: string[], energy: string | null, applyToAlbum: boolean) => void;
  onCancelEdit: () => void;
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  onToggleAll: (rows: Track[]) => void;
}

export function TrackTable(p: TrackTableProps) {
  if (p.loading && p.rows.length === 0) {
    return <SkeletonRows rows={6} />;
  }
  if (p.rows.length === 0) {
    return (
      <>
        {p.tab === 'browse' && (
          <EmptyState compact title="No tracks match" description="Try clearing some filters." />
        )}
        {p.tab === 'search' && (
          <EmptyState compact title="Search your library" description="Find a track to queue on demand." />
        )}
        {p.tab === 'untagged' && (
          <EmptyState compact title="Everything's tagged" description="Nice — the whole library has moods." />
        )}
        {p.tab === 'recent' && <EmptyState compact title="Nothing here yet" />}
      </>
    );
  }

  const allSelected = p.rows.length > 0 && p.rows.every(t => p.selected.has(t.id));

  return (
    // Dim (don't blank) stale rows while a refetch is in flight, so filter
    // changes read as "updating" instead of silently showing old results.
    <div className={cn(p.loading && 'opacity-60 transition-opacity')}>
      {/* Below sm: the 5-column grid (which ends in a fixed 150px actions track)
          leaves the title ~60px, so header and rows lay out as a plain flex line
          instead — checkbox · art · title · one overflow menu. `!` is needed to
          beat `.admin-root .lib-colhead/.lib-row`; sm: hands it back to the CSS
          grid untouched. */}
      <div className="lib-colhead !flex sm:!grid">
        <span>
          <label className={CHECK_HIT}>
            <input
              type="checkbox"
              checked={allSelected}
              onChange={() => p.onToggleAll(p.rows)}
              aria-label={allSelected ? 'deselect all tracks' : 'select all tracks'}
            />
          </label>
        </span>
        <span className="hidden sm:block" />
        <span className="flex-1">title</span>
        <span className="h-tags">mood · energy</span>
        <span className="hidden sm:block" />
      </div>
      {p.rows.map(t => {
        const tagged = !!(t.moods && t.moods.length > 0);
        const editing = p.editingId === t.id;
        const dur = fmtDuration(t.duration);
        return (
          <Fragment key={t.id}>
          <div className={cn('lib-row !flex sm:!grid', p.flashId === t.id && 'flash')}>
            <label className={CHECK_HIT}>
              <input
                type="checkbox"
                checked={p.selected.has(t.id)}
                onChange={() => p.onToggleSelect(t.id)}
                aria-label={`select ${t.title || 'track'}`}
              />
            </label>
            <Thumb track={t} />
            {/* flex-1 drives the phone layout; grid items ignore flex-*, so the
                sm:+ grid column sizing is untouched. */}
            <div className="min-w-0 flex-1">
              <div className="lib-title">{t.title || '—'}</div>
              <div className="lib-artist">{t.artist || '—'}{t.year ? ` · ${t.year}` : ''}{dur ? ` · ${dur}` : ''}</div>
              {t.album && <div className="lib-album">{t.album}</div>}
            </div>
            <div className="lib-tags">
              {tagged ? (
                <>
                  {t.moods!.slice(0, 2).map(m => <span key={m} className="lib-mtag">{m}</span>)}
                  {t.energy && <span className="lib-mtag"><EnergyMeter level={t.energy} />{t.energy}</span>}
                  {t.source === 'manual' && <span className="lib-mtag" title="hand-tagged by an operator">manual</span>}
                </>
              ) : (
                <span className="lib-needs" title="needs tags — tag it so the DJ can pick it" aria-label="needs tags">
                  <Tags size={12} />
                </span>
              )}
              {/* acoustic-analysis badges — independent of mood tagging, shown
                  whenever the analyze pass has filled them in */}
              {t.bpm != null && <span className="lib-mtag lib-atag" title="tempo">{Math.round(t.bpm)} BPM</span>}
              {t.musicalKey && <span className="lib-mtag lib-atag" title="musical key">{t.musicalKey}</span>}
              {t.loudnessLufs != null && <span className="lib-mtag lib-atag" title="integrated loudness (LUFS)">{t.loudnessLufs.toFixed(1)} LUFS</span>}
              {t.instrumental === true && <span className="lib-mtag lib-atag" title="no vocals detected">instrumental</span>}
              {/* sounds-like results carry their cosine match vs the query —
                  shows where relevance falls off down the list */}
              {t.similarity != null && <span className="lib-mtag lib-atag" title="sound match vs your description">≈ {Math.round(t.similarity * 100)}%</span>}
            </div>
            {/* icon-only action cluster — tooltips carry the verbs; the fixed
                150px grid track keeps it aligned under the (empty) header cell.
                Four 36px buttons are worth more than the title is on a phone, so
                below sm: they collapse into the single overflow menu below and
                each inline button hides. */}
            <div className="flex items-center justify-end gap-1.5">
              <RowActionsMenu
                track={t}
                tagged={tagged}
                editing={editing}
                queuing={p.queuing === t.id}
                retagging={p.retagging === t.id}
                blocking={p.blocking === t.id}
                disabled={!!p.queuing || !!p.retagging || !!p.manualBusy || !!p.blocking}
                onQueue={p.onQueue}
                onEdit={p.onEdit}
                onRetag={p.onRetag}
                onBlock={p.onBlock}
              />
              <Btn sm className="hidden sm:inline-flex" onClick={() => p.onQueue(t)} disabled={!!p.queuing} title="Queue on air">
                {p.queuing === t.id ? '…' : <ListPlus size={12} />}
              </Btn>
              <Btn
                sm
                className="hidden sm:inline-flex"
                tone={editing ? 'accent' : undefined}
                onClick={() => p.onEdit(t)}
                disabled={!!p.manualBusy}
                title="Edit moods manually"
              >
                {editing ? <X size={12} /> : <Pencil size={12} />}
              </Btn>
              {/* All track tabs — an untagged track found via search/recent can
                  be LLM-tagged on the spot (/library/retag takes the row body). */}
              <Btn
                sm
                className="hidden sm:inline-flex"
                tone={p.tab === 'untagged' || !tagged ? 'accent' : 'solid'}
                onClick={() => p.onRetag(t)}
                disabled={!!p.retagging}
                title={tagged ? 'Retag with AI' : 'Tag with AI'}
              >
                {p.retagging === t.id ? '…' : tagged
                  ? <RotateCcw size={11} />
                  : <Sparkles size={11} />}
              </Btn>
              <BlockMenu
                className="hidden sm:block"
                track={t}
                busy={p.blocking === t.id}
                disabled={!!p.blocking}
                onBlock={p.onBlock}
              />
            </div>
          </div>
          {editing && (
            <ManualTagEditor
              track={t}
              vocab={p.vocab}
              busy={p.manualBusy === t.id}
              onSave={(moods, energy, applyToAlbum) => p.onSaveManual(t, moods, energy, applyToAlbum)}
              onCancel={p.onCancelEdit}
            />
          )}
          </Fragment>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row disclosure plumbing, shared by BlockMenu and RowActionsMenu.
// ---------------------------------------------------------------------------
// Padded label wrapper around a row checkbox: the native box stays 13px, but the
// negative margin cancels the padding so the ~37px touch target costs the layout
// nothing. Reset at sm:, where the box sits in a 16px grid column.

export function RowActionsMenu({
  track, tagged, editing, queuing, retagging, blocking, disabled, onQueue, onEdit, onRetag, onBlock,
}: {
  track: Track;
  tagged: boolean;
  editing: boolean;
  queuing: boolean;
  retagging: boolean;
  blocking: boolean;
  disabled: boolean;
  onQueue: (t: Track) => void;
  onEdit: (t: Track) => void;
  onRetag: (t: Track) => void;
  onBlock: (t: Track, type: BlockType) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const run = (fn: () => void) => { setOpen(false); fn(); };
  useDismissOnOutside(open, () => setOpen(false), rootRef, triggerRef);
  const busy = queuing || retagging || blocking;

  return (
    <div ref={rootRef} className="relative sm:hidden">
      <Btn
        ref={triggerRef}
        sm
        // 36px square: this is the only row action on a phone, so it carries the
        // whole cluster's tap target.
        className="size-9"
        onClick={() => setOpen(o => !o)}
        aria-label={`actions for ${track.title || 'track'}`}
        aria-expanded={open}
        aria-haspopup="true"
      >
        {busy ? '…' : <MoreVertical size={15} />}
      </Btn>
      {open && (
        <div className={MENU_PANEL}>
          <button type="button" className={MENU_ITEM} disabled={disabled} onClick={() => run(() => onQueue(track))}>
            <ListPlus size={13} /> Queue on air
          </button>
          <button type="button" className={MENU_ITEM} disabled={disabled} onClick={() => run(() => onEdit(track))}>
            {editing ? <X size={13} /> : <Pencil size={13} />} {editing ? 'Close mood editor' : 'Edit moods'}
          </button>
          <button type="button" className={MENU_ITEM} disabled={disabled} onClick={() => run(() => onRetag(track))}>
            {tagged ? <RotateCcw size={13} /> : <Sparkles size={13} />} {tagged ? 'Retag with AI' : 'Tag with AI'}
          </button>
          <span className="my-1 block border-t border-dashed border-separator-strong" />
          <button type="button" className={MENU_ITEM} disabled={disabled} onClick={() => run(() => onBlock(track, 'track'))}>
            <Ban size={13} /> Never play this track
          </button>
          {track.album && (
            <button type="button" className={MENU_ITEM} disabled={disabled} onClick={() => run(() => onBlock(track, 'album'))}>
              <Ban size={13} /> Never play this album
            </button>
          )}
          {track.artist && (
            <button type="button" className={cn(MENU_ITEM, 'items-start')} disabled={disabled} onClick={() => run(() => onBlock(track, 'artist'))}>
              <Ban size={13} className="mt-px flex-none" />
              <span>
                Never play this artist
                <span className="block text-[10px] text-muted">primary credit only — collabs filed under other artists still play</span>
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BlockMenu — the per-row "Never play" action. A Ban button opening a small
// scope menu (track / album / artist); the server resolves album/artist ids
// from the track id, so the row only needs t.id. No confirm dialog — blocking
// is one-click reversible from the Blocked tab.
// ---------------------------------------------------------------------------
function BlockMenu({ track, busy, disabled, onBlock, className }: {
  track: Track;
  busy: boolean;
  disabled: boolean;
  onBlock: (t: Track, type: BlockType) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pick = (type: BlockType) => { setOpen(false); onBlock(track, type); };
  useDismissOnOutside(open, () => setOpen(false), rootRef, triggerRef);

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <Btn
        ref={triggerRef}
        sm
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        title="Never play this on air"
        aria-expanded={open}
        aria-haspopup="true"
      >
        {busy ? '…' : <Ban size={12} />}
      </Btn>
      {open && (
        <div className="absolute top-full right-0 z-50 mt-1 max-w-[calc(100vw-2rem)] min-w-[200px] rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
          <button type="button" className="block w-full rounded px-2.5 py-1.5 text-left text-[12px] hover:bg-[var(--ink-soft)] hover:text-ink" onClick={() => pick('track')}>
            Never play this track
          </button>
          {track.album && (
            <button type="button" className="block w-full rounded px-2.5 py-1.5 text-left text-[12px] hover:bg-[var(--ink-soft)] hover:text-ink" onClick={() => pick('album')}>
              Never play this album
            </button>
          )}
          {track.artist && (
            <button type="button" className="block w-full rounded px-2.5 py-1.5 text-left text-[12px] hover:bg-[var(--ink-soft)] hover:text-ink" onClick={() => pick('artist')}>
              Never play this artist
              <span className="block text-[10px] text-muted">primary credit only — collabs filed under other artists still play</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BlockedTab — the never-play blocklist manager. Lists entries newest-first
// with a type badge and one-click unblock. The list governs AIRING only:
// blocked tracks still appear in browse/search (the library browser shows the
// library), they just never make it to the queue.
// ---------------------------------------------------------------------------

