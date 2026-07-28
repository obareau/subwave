// Library-wide counts for the admin dashboard, cached briefly because the
// aggregate scan is the most expensive read in this module.

import { SQL_HAS_MOODS, getDbNonce, requireDb } from './handle.js';
import type { LibraryStats } from './types.js';

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

// stats() runs ~7 full-table scans/GROUP BYs (byMood alone is a json_each walk
// over every row). It's polled every 30s by the admin Library panel and hit by
// several admin pages (/library, /debug, /observatory) + /settings. Post-
// analysis the fattened rows make each scan slow, so uncached these stacked up
// on the synchronous DB thread and blocked listener polls (#723). A short TTL
// collapses page-load / multi-tab bursts into one computation; 5s is well within
// the display's freshness needs, and analysis writes don't change these tallies
// anyway (they touch bpm/*_json, not moods/genre/energy).
let statsCache: { at: number; value: LibraryStats } | null = null;
const STATS_TTL_MS = 5000;

// Drop the memoised stats() result — call when the DB handle is swapped
// (reset/reload) so a fresh library never briefly serves the old one's tallies.
export function invalidateStats(): void {
  statsCache = null;
}

export function stats(): LibraryStats {
  const now = Date.now();
  if (statsCache && now - statsCache.at < STATS_TTL_MS) return statsCache.value;
  const value = computeStats();
  // Stamp AFTER the compute: computeStats() itself can exceed the TTL on a
  // very large library (≈15 s at 200k tracks), and a start-of-compute stamp
  // would mean the entry is already expired the moment it's stored — every
  // call recomputes, which is exactly what the cache exists to prevent.
  statsCache = { at: Date.now(), value };
  return value;
}

// A cheap opaque token that changes whenever ANY write lands in the library:
// `data_version` bumps on commits from OTHER connections (the tagger and
// analyzer hold the DB concurrently), `total_changes()` counts THIS
// connection's row changes, and the per-open nonce covers handle swaps. Both
// reads are O(1). Powers the observatory ETag — anything derived purely from
// library rows can be revalidated with this instead of rebuilding the payload.
export function changeToken(): string {
  const d = requireDb();
  const dataVersion = d.pragma('data_version', { simple: true }) as number;
  const ownChanges = (d.prepare('SELECT total_changes() AS c').get() as { c: number }).c;
  return `${getDbNonce()}.${dataVersion}.${ownChanges}`;
}

function computeStats(): LibraryStats {
  const d = requireDb();
  const total =
    (d.prepare(`SELECT COUNT(*) AS n FROM tracks WHERE ${SQL_HAS_MOODS}`).get() as {
      n: number;
    }).n;
  const distinctArtists =
    (
      d
        .prepare(
          `SELECT COUNT(DISTINCT LOWER(TRIM(artist))) AS n
           FROM tracks
           WHERE ${SQL_HAS_MOODS}
             AND artist IS NOT NULL
             AND TRIM(artist) != ''`,
        )
        .get() as { n: number }
    ).n;
  const byMood: Record<string, number> = {};
  for (const r of d
    .prepare(
      `SELECT value AS mood, COUNT(*) AS n FROM tracks, json_each(tracks.moods)
       WHERE tracks.moods IS NOT NULL GROUP BY value`,
    )
    .all() as Array<{ mood: string; n: number }>) {
    byMood[r.mood] = r.n;
  }
  const byEnergy: Record<string, number> = {};
  for (const r of d
    .prepare(
      `SELECT energy, COUNT(*) AS n FROM tracks WHERE energy IS NOT NULL GROUP BY energy`,
    )
    .all() as Array<{ energy: string; n: number }>) {
    byEnergy[r.energy] = r.n;
  }
  // json_each over the multi-genre array: a track tagged Hip-Hop + Rap counts
  // toward both tallies (so the sum can exceed `total` — these are per-tag
  // counts for filter dropdowns/suggestions, not a partition of the library).
  const byGenre: Record<string, number> = {};
  for (const r of d
    .prepare(
      `SELECT value AS genre, COUNT(*) AS n FROM tracks, json_each(tracks.genres)
       WHERE tracks.genres IS NOT NULL GROUP BY value`,
    )
    .all() as Array<{ genre: string; n: number }>) {
    byGenre[r.genre] = r.n;
  }
  const bySource: Record<string, number> = {};
  for (const r of d
    .prepare(
      `SELECT source, COUNT(*) AS n FROM tracks WHERE source IS NOT NULL GROUP BY source`,
    )
    .all() as Array<{ source: string; n: number }>) {
    bySource[r.source] = r.n;
  }
  const withEmbedding = (d.prepare('SELECT COUNT(*) AS n FROM track_vectors').get() as {
    n: number;
  }).n;
  const withAudioEmbedding = (
    d.prepare('SELECT COUNT(*) AS n FROM track_audio_vectors').get() as { n: number }
  ).n;
  const updatedAt =
    ((d.prepare('SELECT MAX(tagged_at) AS t FROM tracks').get() as { t: string | null }).t) ||
    null;
  return {
    total, distinctArtists, byMood, byEnergy, byGenre, bySource,
    withEmbedding, withAudioEmbedding, updatedAt,
  };
}


