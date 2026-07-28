'use client';

// The blocked-tracks tab: what the operator has excluded, and un-blocking.
//
// Part of the library/ split - see ../LibraryPanel.tsx.

import { Fragment } from 'react';
import { RefreshCw, X, Ban } from 'lucide-react';
import { Card, Btn } from '../ui';
import { cn } from '../../../lib/cn';
 
import { SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import type { BlockEntry } from './types';

export function BlockedTab({ entries, loading, unblocking, onUnblock, onRefresh }: {
  entries: BlockEntry[] | null;
  loading: boolean;
  unblocking: string | null;
  onUnblock: (e: BlockEntry) => void;
  onRefresh: () => void;
}) {
  const rows = (entries || []).slice().sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));
  return (
    <Card
      title="Never play"
      sub={entries ? `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} — these are refused everywhere: DJ picks, requests, even manual queueing` : ''}
      right={
        <Btn sm onClick={onRefresh} disabled={loading}>
          <RefreshCw size={11} /> {loading ? 'Loading…' : 'Refresh'}
        </Btn>
      }
      bodyClass="!p-0"
    >
      {rows.length === 0 ? (
        loading ? (
          <SkeletonRows rows={4} className="m-4" />
        ) : (
          <EmptyState
            compact
            title="Nothing blocked"
            description={<>Use the <Ban size={11} className="inline align-[-1px]" /> action on any track row to keep a track, album or artist off the air.</>}
          />
        )
      ) : (
        <div className={cn(loading && 'opacity-60 transition-opacity')}>
          {rows.map(e => {
            const key = `${e.type}:${e.id}`;
            return (
              <div key={key} className="flex items-center gap-3 border-b border-dashed border-[var(--separator-strong)] px-4 py-2.5 last:border-b-0">
                <span className="lib-mtag shrink-0" title={`blocked ${e.type}`}>{e.type}</span>
                <div className="min-w-0 flex-1">
                  <div className="lib-title">{e.name || e.id}</div>
                  {(e.artist || e.album) && e.type !== 'artist' && (
                    <div className="lib-artist">{e.artist || ''}{e.album && e.type === 'track' ? ` · ${e.album}` : ''}</div>
                  )}
                </div>
                <span className="hidden text-[11px] text-muted sm:block" title="blocked on">
                  {e.addedAt ? new Date(e.addedAt).toLocaleDateString('en-GB') : ''}
                </span>
                <Btn sm onClick={() => onUnblock(e)} disabled={!!unblocking}>
                  {unblocking === key ? '…' : <><X size={12} /> Unblock</>}
                </Btn>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// HistoryTab — the durable play log (GET /library/history), newest first.
// Every aired track with when it played, how it was picked (DJ / request /
// auto playlist), and which show was on air. Rows with a track id can be
// re-queued straight from here. Grouped by day so a scan of "what aired last
// night" doesn't need to parse timestamps.
// ---------------------------------------------------------------------------

