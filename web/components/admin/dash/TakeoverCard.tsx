'use client';

// Show takeover (#930) — pin one show over the weekly grid for a bounded window.
// Unlike the other dash cards this one fetches for itself: GET /schedule and the two
// /schedule/override mutations are the only calls on this screen no other card wants.

import type { ChangeEvent } from 'react';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAdminAuth } from '../../../lib/adminAuth';
import { notify, errorMessage } from '../../../lib/notify';
import { fmtClock } from '../../../lib/format';
import type { StationLocale } from '../../../lib/types';
import { cn } from '../../../lib/cn';
import { Card, Btn, Pill, Seg } from '../ui';
import { ColorChip, SlotMenu } from '../schedule/bits';
import { SHOW_COLORS } from '../schedule/lib';

/** One show pinned over the grid until `expiresAt` (epoch ms). */
interface ScheduleOverride {
  showId: string;
  startedAt: number;
  expiresAt: number;
}

interface TakeoverShow {
  id: string;
  name: string;
}

// Mirror the controller's OVERRIDE_MIN/MAX_MINUTES (settings.ts).
const MIN_MINUTES = 15;
const MAX_MINUTES = 720;
const PRESETS = [
  { minutes: 60, label: '1h' },
  { minutes: 120, label: '2h' },
  { minutes: 180, label: '3h' },
];

export function TakeoverCard({ tz, locale }: { tz?: string; locale?: StationLocale }) {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [shows, setShows] = useState<TakeoverShow[]>([]);
  const [override, setOverride] = useState<ScheduleOverride | null>(null);
  const [pinShowId, setPinShowId] = useState('');
  const [minutes, setMinutes] = useState(60);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // GET /schedule carries the roster and the pin in force (expired or dangling ones
  // already report as null). The 30s beat doubles as the clock behind "min left", so a
  // pin made in another tab or lapsing on its own lands here without a reload.
  useEffect(() => {
    if (!hydrated || needsAuth) return;
    let cancelled = false;
    const tick = async () => {
      setNow(Date.now());
      try {
        const r = await adminFetch('/schedule');
        if (!r.ok || cancelled) return;
        const j = (await r.json()) as { shows?: TakeoverShow[]; override?: ScheduleOverride | null };
        setShows(
          Array.isArray(j.shows)
            ? j.shows.filter(s => s && typeof s.id === 'string' && s.id)
            : [],
        );
        setOverride(j.override ?? null);
      } catch {}
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [hydrated, needsAuth]); // eslint-disable-line react-hooks/exhaustive-deps

  // Same index-into-the-roster colour the board and the shows page paint with.
  const colorOf = (id: string): string => {
    const idx = shows.findIndex(s => s.id === id);
    return idx >= 0 ? (SHOW_COLORS[idx % SHOW_COLORS.length] ?? 'transparent') : 'transparent';
  };
  const showById = (id: string) => shows.find(s => s.id === id) ?? null;

  const live = override && override.expiresAt > now ? override : null;
  const pinned = live ? showById(live.showId) : null;
  const minutesLeft = live ? Math.max(1, Math.ceil((live.expiresAt - now) / 60_000)) : 0;

  const pin = async () => {
    if (!pinShowId) return;
    setBusy(true);
    try {
      const r = await adminFetch('/schedule/override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ showId: pinShowId, minutes }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string; override?: ScheduleOverride };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      setOverride(j.override ?? null);
      setNow(Date.now());
      const name = showById(pinShowId)?.name || 'show';
      notify.ok(`“${name}” takes over — the switch airs on the next track.`);
    } catch (e) {
      notify.err(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    try {
      const r = await adminFetch('/schedule/override', { method: 'DELETE' });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      setOverride(null);
      notify.ok('Takeover cancelled — back to the weekly schedule.');
    } catch (e) {
      notify.err(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const onAir = !!(live && pinned);

  return (
    <Card
      title="Takeover"
      // No sub while one is live — a third line of the same news wraps the header.
      sub={onAir ? undefined : 'jump a show to the front'}
      // Box-shadow, not a border: `.admin-root .card` owns the border at a higher
      // specificity than any utility class can beat.
      className={cn(onAir && 'shadow-[0_0_0_2px_color-mix(in_oklab,var(--accent)_28%,transparent)]')}
      right={
        <span className="flex items-center gap-2">
          {onAir && (
            <Pill tone="accent" dot>
              on air
            </Pill>
          )}
          <Link
            href="/admin/shows/schedule"
            className="inline-flex min-h-9 items-center text-[9px] font-bold tracking-[0.2em] text-muted uppercase hover:text-ink sm:min-h-0"
          >
            the week →
          </Link>
        </span>
      }
    >
      {live && pinned ? (
        <div className="grid gap-2.5">
          <div className="grid gap-1 border border-[color-mix(in_oklab,var(--accent)_35%,transparent)] bg-[var(--accent-soft)] px-2.5 py-2">
            <div className="flex items-baseline gap-2">
              <ColorChip color={colorOf(pinned.id)} className="size-[11px] self-center" />
              <span className="min-w-0 truncate text-[13px] font-bold text-ink">{pinned.name}</span>
              <span className="mono-num ml-auto flex-none text-[10px] whitespace-nowrap text-muted">
                ends {fmtClock(live.expiresAt, tz, locale)}
              </span>
            </div>
            <div className="text-[10px] text-muted">
              on air over the schedule · {minutesLeft} min left
            </div>
          </div>
          <Btn sm className="w-full" disabled={busy} onClick={cancel}>
            {busy ? 'cancelling…' : 'Cancel takeover'}
          </Btn>
        </div>
      ) : shows.length === 0 ? (
        <div className="text-muted italic">
          no shows to pin —{' '}
          <Link href="/admin/shows" className="underline hover:text-ink">
            build one first
          </Link>
        </div>
      ) : (
        <div className="grid gap-2.5">
          <SlotMenu
            ariaLabel="Pin a show"
            // justify-self, not self-start: the grid otherwise stretches the slot to
            // full width, where it reads as a text field rather than a value you pick.
            className="min-h-9 justify-self-start text-[12px] sm:min-h-0"
            label={showById(pinShowId)?.name ?? 'Pin a show…'}
            chipColor={pinShowId ? colorOf(pinShowId) : undefined}
            options={shows.map(s => ({ key: s.id, label: s.name, chipColor: colorOf(s.id) }))}
            onSelect={setPinShowId}
          />
          <div className="flex flex-wrap items-center gap-2.5">
            <Seg
              value={String(minutes)}
              options={PRESETS.map(p => ({ id: String(p.minutes), label: p.label }))}
              onChange={id => setMinutes(Number(id))}
            />
            <label className="flex items-baseline gap-1.5 border border-separator-strong px-2 py-[9px] sm:py-1">
              <input
                type="number"
                min={MIN_MINUTES}
                max={MAX_MINUTES}
                value={minutes}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) setMinutes(Math.round(v));
                }}
                aria-label="Takeover minutes"
                className="w-11 [appearance:textfield] border-0 bg-transparent p-0 text-right font-mono text-[11px] font-bold text-ink outline-none"
              />
              <span className="caption">min</span>
            </label>
          </div>
          <Btn
            tone="accent"
            sm
            className="w-full"
            disabled={busy || !pinShowId || minutes < MIN_MINUTES || minutes > MAX_MINUTES}
            onClick={pin}
          >
            {busy ? 'pinning…' : 'Pin to air →'}
          </Btn>
          <div className="text-[10px] text-muted">
            the switch airs on the next track · the schedule picks up again after
          </div>
        </div>
      )}
    </Card>
  );
}
