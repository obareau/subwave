'use client';

// Three chip states off GET /library/genres/related: empty field → most-stocked
// genres, exact genre → its nearest by embedding similarity, partial text →
// substring matches.

import { useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/cn';

interface GenreItem {
  value: string;
  songCount: number;
}

interface SuggestData {
  genres: GenreItem[];
  related: Record<string, GenreItem[]>;
  hasEmbeddings: boolean;
}

interface Props {
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  value: string;
  onSelect: (genre: string) => void;
}

const POPULAR = 12;
const MATCHES = 10;
const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]/g, '');

export default function GenreSuggest({ adminFetch, value, onSelect }: Props) {
  const [data, setData] = useState<SuggestData | null>(null);
  const [error, setError] = useState(false);
  // The field is free text, so the typed value is resolved to a real genre here.
  const byNorm = useRef<Map<string, GenreItem>>(new Map());

  // No "already fetched" ref guard: under StrictMode the first mount's fetch is
  // cancelled by the cleanup, so the remount must be free to fetch again.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await adminFetch('/library/genres/related');
        if (!r.ok) throw new Error(String(r.status));
        const j = (await r.json()) as SuggestData;
        if (!live) return;
        if (j && Array.isArray(j.genres)) {
          byNorm.current = new Map(j.genres.map((g) => [norm(g.value), g]));
          setData(j);
        } else setData(null);
      } catch {
        if (live) setError(true);
      }
    })();
    return () => { live = false; };
  }, [adminFetch]);

  if (error || !data || data.genres.length === 0) return null;

  const typed = value.trim();
  const nv = norm(typed);
  const match = nv ? byNorm.current.get(nv) : undefined;

  let label: string;
  let chips: GenreItem[];
  if (match && data.related[match.value]?.length) {
    label = `similar to ${match.value}`;
    chips = data.related[match.value] ?? [];
  } else if (nv) {
    // Substring matches, minus the exact one already in the field.
    const subs = data.genres.filter((g) => norm(g.value).includes(nv) && norm(g.value) !== nv);
    if (subs.length) {
      label = 'matches';
      chips = subs.slice(0, MATCHES);
    } else {
      label = 'popular genres';
      chips = data.genres.slice(0, POPULAR);
    }
  } else {
    label = 'popular genres';
    chips = data.genres.slice(0, POPULAR);
  }

  if (chips.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <span className="field-hint m-0">
        {label}
        {match && !data.hasEmbeddings ? ' — tag your library with embeddings for related genres' : ''}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {chips.map((g) => (
          <button
            key={g.value}
            type="button"
            className={cn('lib-chip', norm(g.value) === nv && nv !== '' && 'on')}
            onClick={() => onSelect(g.value)}
            title={`${g.songCount} track${g.songCount === 1 ? '' : 's'}`}
          >
            {g.value}
            {g.songCount > 0 && <span className="n">{g.songCount}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
