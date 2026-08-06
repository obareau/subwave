'use client';

import { Fragment } from 'react';
import { RefreshCw, ListPlus } from 'lucide-react';
import { Card, Btn } from '../ui';
import { cn } from '../../../lib/cn';
import { num } from '../LibraryTaggingPanel';
import { SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { PAGE_SIZE } from './types';
import type { PlayEntry, Track } from './types';
import { Thumb } from './bits';

function playDayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

function playSourceLabel(p: PlayEntry): string {
  if (p.source === 'request') return p.requestedBy ? `request · ${p.requestedBy}` : 'request';
  if (p.source === 'ai') return 'DJ pick';
  return 'auto';
}

export function HistoryTab({ rows, total, page, setPage, loading, queuing, onQueue, onRefresh }: {
  rows: PlayEntry[] | null;
  total: number;
  page: number;
  setPage: (fn: (p: number) => number) => void;
  loading: boolean;
  queuing: string | null;
  onQueue: (t: Track) => void;
  onRefresh: () => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return (
    <>
      <Card
        title="Play history"
        sub={rows ? `${num(total)} play${total === 1 ? '' : 's'} on record — every aired track, with how it was picked and what show was on` : ''}
        right={
          <Btn sm onClick={onRefresh} disabled={loading}>
            <RefreshCw size={11} /> {loading ? 'Loading…' : 'Refresh'}
          </Btn>
        }
        bodyClass="!p-0"
      >
        {!rows || rows.length === 0 ? (
          loading || !rows ? (
            <SkeletonRows rows={4} className="m-4" />
          ) : (
            <EmptyState
              compact
              title="Nothing on record yet"
              description="Plays are logged from the moment this version starts airing tracks."
            />
          )
        ) : (
          <div className={cn(loading && 'opacity-60 transition-opacity')}>
            {rows.map((p, i) => {
              const day = playDayLabel(p.playedAt);
              const prev = i > 0 ? rows[i - 1] : null;
              const prevDay = prev ? playDayLabel(prev.playedAt) : null;
              const time = new Date(p.playedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
              return (
                <Fragment key={p.id}>
                  {day !== prevDay && (
                    <div className="caption border-b border-dashed border-[var(--separator-strong)] px-4 py-1.5 text-muted">{day}</div>
                  )}
                  <div className="flex items-center gap-3 border-b border-dashed border-[var(--separator-strong)] px-4 py-2.5 last:border-b-0">
                    <span className="mono-num w-11 shrink-0 text-[11px] text-muted" title={new Date(p.playedAt).toLocaleString('en-GB')}>
                      {time}
                    </span>
                    <Thumb track={{ id: p.trackId || '', title: p.title || undefined, artist: p.artist || undefined, album: p.album || undefined }} />
                    <div className="min-w-0 flex-1">
                      <div className="lib-title">{p.title || 'unknown'}</div>
                      <div className="lib-artist">{p.artist || ''}{p.album ? ` · ${p.album}` : ''}</div>
                    </div>
                    {p.showName && (
                      <span className="lib-mtag hidden shrink-0 md:inline-block" title="show on air">{p.showName}</span>
                    )}
                    <span className="hidden w-24 shrink-0 text-right text-[11px] text-muted sm:block" title="how it was picked">
                      {playSourceLabel(p)}
                    </span>
                    <Btn
                      sm
                      onClick={() => onQueue({ id: p.trackId!, title: p.title || undefined, artist: p.artist || undefined, album: p.album || undefined })}
                      disabled={!p.trackId || !!queuing}
                      title={p.trackId ? 'queue this track again' : 'no track id recorded for this play'}
                    >
                      {queuing && queuing === p.trackId ? '…' : <><ListPlus size={12} /> Queue</>}
                    </Btn>
                  </div>
                </Fragment>
              );
            })}
          </div>
        )}
      </Card>

      {total > PAGE_SIZE && (
        <div className="flex flex-wrap items-center justify-between gap-y-2 text-[11px] text-muted">
          <span className="mono-num">
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {num(total)}
          </span>
          <span className="flex items-center gap-2">
            <Btn sm disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))}>‹ prev</Btn>
            <span className="mono-num">page {page + 1} of {totalPages}</span>
            <Btn sm disabled={page + 1 >= totalPages} onClick={() => setPage(p => p + 1)}>next ›</Btn>
          </span>
        </div>
      )}
    </>
  );
}

// ManualTagEditor lives in ManualTagEditor.tsx: operator tags (source='manual') feed
// songsByMood() like the LLM tagger's, and "apply to whole album" targets a whole
// album at once (discussion #336).

