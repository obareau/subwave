'use client';

// The likes card - most-liked tracks and the most recent likes.
//
// Part of the dash/ split - see ../DashPanel.tsx.

import { fmtClock } from '../../../lib/format';
import type { StationLocale } from '../../../lib/types';
import { SkeletonText } from '@/components/ui/skeleton';
import { Card } from '../ui';
import { ScrollArea } from '../../ui/scroll-area';
import type { LikesPayload } from './types';

export function LikesCard({
  likes,
  err,
  tz,
  locale,
}: {
  likes: LikesPayload | null;
  err: string | null;
  tz?: string;
  locale?: StationLocale;
}) {
  const top = likes?.top ?? [];
  const recent = likes?.recent ?? [];
  return (
    <Card
      title="Likes"
      sub={
        err
          ? 'unavailable'
          : likes
            ? `${likes.totals?.total ?? 0} likes across ${likes.totals?.songs ?? 0} tracks`
            : 'loading…'
      }
    >
      {err ? (
        <div className="text-muted italic">can’t load likes: {err}</div>
      ) : !likes ? (
        <SkeletonText lines={2} />
      ) : recent.length === 0 ? (
        <span className="text-[12px] text-muted">No likes yet — the heart on the player feeds this.</span>
      ) : (
        <div className="grid gap-3">
          {top.length > 0 && (
            <div className="grid gap-1.5">
              <div className="caption text-[10px]">most liked</div>
              {top.slice(0, 8).map((t, i) => (
                <div
                  key={`${t.track?.id ?? ''}:${i}`}
                  className="grid grid-cols-[auto_1fr_auto] items-center gap-2.5 text-[12px]"
                >
                  <span className="mono-num text-[10px] text-muted">{i + 1}.</span>
                  <span className="min-w-0 truncate">
                    <span className="font-bold">{t.track?.title || '—'}</span>
                    {t.track?.artist && <span className="text-muted"> — {t.track.artist}</span>}
                  </span>
                  <span className="mono-num text-[11px] text-vermilion">
                    ♥ {t.count ?? 0}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="grid gap-1.5">
            <div className="caption text-[10px]">recent</div>
            <ScrollArea className="max-h-[280px]">
              <div className="grid gap-1.5">
                {recent.map((l, i) => (
                  <div
                    key={`${l.likedAt ?? ''}:${i}`}
                    // Four columns don't leave the title anything to truncate
                    // into at 390px — the anonymous handle drops on mobile.
                    className="grid grid-cols-[auto_1fr_auto] items-center gap-2.5 text-[12px] sm:grid-cols-[auto_1fr_auto_auto]"
                  >
                    <span className="font-bold text-vermilion">♥</span>
                    <span className="min-w-0 truncate">
                      {l.title || '—'}
                      {l.artist && <span className="text-muted"> — {l.artist}</span>}
                    </span>
                    <span
                      className="caption hidden text-[10px] sm:inline"
                      title="anonymous listener handle"
                    >
                      {l.listener || ''}
                    </span>
                    <span className="mono-num text-[10px] text-muted">
                      {fmtClock(l.likedAt, tz, locale) || '—'}
                    </span>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>
        </div>
      )}
    </Card>
  );
}


