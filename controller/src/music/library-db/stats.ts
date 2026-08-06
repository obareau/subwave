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

// How many EMBEDDED tracks carry no musical signal in their vector at all —
// the whole text is the `artist — title · album (year) [genre]` head line
// (#1246). Those vectors can only be compared on label text, so the similarity
// tools rank them by how close their artist/album strings are while presenting
// themselves to the picker as mood similarity: a prolific artist self-clusters,
// and "Nick Drake" lands next to "Drake".
//
// Counted over track_vectors, not tracks: a track with no vector isn't in the
// KNN space and isn't the problem. The five signals mirror what feeds
// formatTrackText's optional lines (Last.fm tags, lyric excerpt, and the Sound
// line's audio moods, tempo and key mode) — keep them in step, or the advisory
// stops describing the text. The key predicate is a non-empty check rather
// than full Camelot validation (SQL has no cheap regex); the analyzer only
// ever writes Camelot codes there, so the approximation only matters for
// hand-edited rows, and then it undercounts — the safe direction for an
// advisory.
//
// vocal_ranges (the 'instrumental' marker) is deliberately NOT predicated
// here: it's only ever written by an analysis pass that also writes bpm, so
// the bpm check subsumes it. And the Era: line never counts as musical signal
// at all — it's derived from the year LABEL, i.e. exactly the kind of text
// this count exists to flag.
//
// Deliberately a raw count with no threshold or verdict attached: what counts
// as "too high" depends on library size and on which enrichment the operator
// has deliberately turned off, so the judgement belongs at the surface that
// shows it, not here.
// Memoised on the same reasoning (and the same TTL) as stats() below: this is
// a full scan of `tracks` with no index to help the predicate, and it rides the
// coverage payload the admin Library panel polls every 30s from every open tab.
// Its own TTL, deliberately much longer than stats(): this figure only moves
// when the TAGGER runs, and it is read on a PICK path too (the picker tools
// gate one advisory sentence on it, llm/…/picker/scope.ts). Picks are minutes
// apart, so at the 5s display TTL every pick paid for a fresh full scan to
// decide the wording of a tool description. Handle swaps still clear it
// through invalidateStats(), so the staleness is bounded to "how recently did
// the tagger change the answer", where minutes are immaterial.
const LABEL_ONLY_TTL_MS = 5 * 60 * 1000;
let labelOnlyCache: { at: number; value: number } | null = null;

export function labelOnlyVectorCount(): number {
  const now = Date.now();
  if (labelOnlyCache && now - labelOnlyCache.at < LABEL_ONLY_TTL_MS) return labelOnlyCache.value;
  const value = computeLabelOnlyVectorCount();
  labelOnlyCache = { at: Date.now(), value };
  return value;
}

function computeLabelOnlyVectorCount(): number {
  return (requireDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM track_vectors v
         JOIN tracks t ON t.id = v.id
        WHERE (t.lastfm_tags   IS NULL OR t.lastfm_tags   = '' OR t.lastfm_tags   = '[]')
          AND (t.lyric_excerpt IS NULL OR t.lyric_excerpt = '')
          AND (t.audio_moods   IS NULL OR t.audio_moods   = '' OR t.audio_moods   = '[]')
          AND (t.bpm IS NULL OR t.bpm <= 0)
          AND (t.musical_key   IS NULL OR t.musical_key   = '')`,
    )
    .get() as { n: number }).n;
}

// Drop the memoised stats() result — call when the DB handle is swapped
// (reset/reload) so a fresh library never briefly serves the old one's tallies.
export function invalidateStats(): void {
  statsCache = null;
  labelOnlyCache = null;
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
  // Every row in the mirror, tagged or not. `total` counts only TAGGED tracks,
  // which is the right denominator for the tagging-coverage displays and the
  // wrong one for anything asking "how big is this library" — the picker's
  // recency windows, the no-repeat clamp and the deepCuts availability gate all
  // operate over rows the tagger may never have reached. A synced-but-untagged
  // install has total = 0 and a mirror full of playable tracks.
  const mirrorTotal =
    (d.prepare(`SELECT COUNT(*) AS n FROM tracks`).get() as { n: number }).n;
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
    total, mirrorTotal, distinctArtists, byMood, byEnergy, byGenre, bySource,
    withEmbedding, withAudioEmbedding, updatedAt,
  };
}


