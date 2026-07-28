// Per-track reads and writes: metadata, tags, enrichment, analysis and vectors.
// The write path every ingest pass (tagger, analyzer, enricher) goes through.

import { ANALYSIS_VERSION, AUDIO_EMBEDDING_DIM, SQL_HAS_MOODS, TAGGER_VERSION, getEmbeddingDim, requireDb } from './handle.js';
import type { TagWrite, TrackEnrichment, TrackKeyRange, TrackMeta, TrackOutro, TrackPaceSpan, TrackRecord, TrackRow, TrackSection } from './types.js';
import { normaliseYear, rowToTrack, safeParseArray } from './rows.js';
import { runDdl } from './schema.js';

// ---------------------------------------------------------------------------
// Track CRUD
// ---------------------------------------------------------------------------

export function getTrack(id: string): TrackRecord | null {
  const row = requireDb()
    .prepare(`SELECT * FROM tracks WHERE id = ?`)
    .get(id) as TrackRow | undefined;
  return row ? rowToTrack(row) : null;
}

export interface TrackLite {
  genres: string[];
  genre: string | null;
  bpm: number | null;
  musicalKey: string | null;
  moods: string[];
  energy: string | null;
  year: number | null;
  // Era-year surface (issue #842) — lets show-filter resolve a track's true
  // era without the full getTrack() blob parse. null = unresolved / unknown.
  originalYear: number | null;
  isCompilation: boolean | null;
  durationSec: number | null;
}

// Lean read for the /now-playing hot path (polled every ~5s by every listener).
// Selects only the light scalar columns the player's metadata strip renders,
// skipping the heavy acoustic *_json blobs (structure/pace/beats/bars/key/vocal
// ranges) that a full getTrack() → rowToTrack() SELECTs and JSON.parses on every
// call. After acoustic analysis those blobs are populated and fat, so parsing
// them per poll — on better-sqlite3's single synchronous thread — stalled every
// concurrent HTTP response, making the whole UI sluggish (#723).
export function getTrackLite(id: string): TrackLite | null {
  const row = requireDb()
    .prepare(`SELECT genres, genre, bpm, musical_key, moods, energy, year, original_year, is_compilation, duration_sec FROM tracks WHERE id = ?`)
    .get(id) as Pick<TrackRow, 'genres' | 'genre' | 'bpm' | 'musical_key' | 'moods' | 'energy' | 'year' | 'original_year' | 'is_compilation' | 'duration_sec'> | undefined;
  if (!row) return null;
  return {
    genres: row.genres ? safeParseArray(row.genres) : [],
    genre: row.genre ?? null,
    bpm: row.bpm ?? null,
    musicalKey: row.musical_key ?? null,
    moods: row.moods ? safeParseArray(row.moods) : [],
    energy: row.energy ?? null,
    year: row.year ?? null,
    originalYear: row.original_year ?? null,
    isCompilation: row.is_compilation == null ? null : !!row.is_compilation,
    durationSec: row.duration_sec ?? null,
  };
}

// COUNT(*) of tagged tracks — the O(1)-ish query behind the coverage meter's
// "tagged" tally. Replaces allTaggedIds().length, which materialised a ~30k-
// element JS id array on every coverage poll only to read its .length (#723).
// Predicate is `moods IS NOT NULL` to match allTaggedIds() exactly (NOT the
// stricter SQL_HAS_MOODS) so the coverage percentage is unchanged.
export function countTagged(): number {
  return (
    requireDb().prepare(`SELECT COUNT(*) AS n FROM tracks WHERE moods IS NOT NULL`).get() as {
      n: number;
    }
  ).n;
}

export function hasTags(id: string): boolean {
  const row = requireDb()
    .prepare(`SELECT 1 FROM tracks WHERE id = ? AND ${SQL_HAS_MOODS}`)
    .get(id);
  return !!row;
}

export function hasVector(id: string): boolean {
  const row = requireDb().prepare(`SELECT 1 FROM track_vectors WHERE id = ?`).get(id);
  return !!row;
}

export function upsertTrackMeta(id: string, meta: TrackMeta): void {
  requireDb()
    .prepare(
      `
      INSERT INTO tracks (id, title, artist, album, year, original_year, original_year_source, is_compilation, genres, duration_sec)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title        = COALESCE(excluded.title, tracks.title),
        artist       = COALESCE(excluded.artist, tracks.artist),
        album        = COALESCE(excluded.album, tracks.album),
        year         = COALESCE(excluded.year, tracks.year),
        -- Walk-time 'album-tag' years never clobber a per-track 'musicbrainz'
        -- resolution — the MB lookup is the more specific signal (issue #842).
        original_year = CASE WHEN tracks.original_year_source = 'musicbrainz'
                             THEN tracks.original_year
                             ELSE COALESCE(excluded.original_year, tracks.original_year) END,
        original_year_source = CASE WHEN tracks.original_year_source = 'musicbrainz'
                                    THEN tracks.original_year_source
                                    ELSE COALESCE(excluded.original_year_source, tracks.original_year_source) END,
        is_compilation = COALESCE(excluded.is_compilation, tracks.is_compilation),
        genres       = COALESCE(excluded.genres, tracks.genres),
        duration_sec = COALESCE(excluded.duration_sec, tracks.duration_sec)
    `,
    )
    .run(
      id,
      meta.title ?? null,
      meta.artist ?? null,
      meta.album ?? null,
      normaliseYear(meta.year),
      normaliseYear(meta.originalYear),
      normaliseYear(meta.originalYear) != null ? 'album-tag' : null,
      meta.isCompilation == null ? null : meta.isCompilation ? 1 : 0,
      meta.genres?.length ? JSON.stringify(meta.genres) : null,
      Number.isFinite(meta.duration as number) ? (meta.duration as number) : null,
    );
}

// Tracks still owed an original-year lookup (issue #842): compilation-album
// tracks with no resolved year. Deliberately NOT scoped to the tagger's
// untagged/enriched sets — the column landed after most libraries were tagged,
// so the backfill must see the whole catalogue. `retryMisses` widens to tracks
// already checked-but-missed (--re-enrich).
export function idsNeedingOriginalYear(retryMisses = false): string[] {
  const extra = retryMisses ? '' : 'AND original_year_checked_at IS NULL';
  return (
    requireDb()
      .prepare(
        `SELECT id FROM tracks WHERE is_compilation = 1 AND original_year IS NULL ${extra}`,
      )
      .all() as Array<{ id: string }>
  ).map((r) => r.id);
}

// Record the result of a per-track original-year lookup (issue #842).
// `checked_at` is stamped on hit AND miss so a resumed enrichment pass skips
// tracks it already asked MusicBrainz about; a miss leaves original_year NULL
// (era filtering then treats a compilation track's year as unknown).
export function setOriginalYear(id: string, year: number | null): void {
  requireDb()
    .prepare(
      `UPDATE tracks SET
         original_year            = COALESCE(?, original_year),
         original_year_source     = CASE WHEN ? IS NOT NULL THEN 'musicbrainz' ELSE original_year_source END,
         original_year_checked_at = ?
       WHERE id = ?`,
    )
    .run(year, year, new Date().toISOString(), id);
}

export function upsertTrackEnrichment(id: string, enrich: TrackEnrichment): void {
  requireDb()
    .prepare(
      `UPDATE tracks SET lastfm_tags = ?, lyric_excerpt = ?, enriched_at = ? WHERE id = ?`,
    )
    .run(
      enrich.lastfmTags ? JSON.stringify(enrich.lastfmTags) : null,
      enrich.lyricExcerpt ?? null,
      new Date().toISOString(),
      id,
    );
}

export function upsertTrackTags(id: string, tags: TagWrite): void {
  requireDb()
    .prepare(
      `UPDATE tracks SET
        moods          = ?,
        energy         = ?,
        source         = ?,
        confidence     = ?,
        tagger_version = ?,
        prompt_hash    = ?,
        model          = ?,
        tagged_at      = ?
      WHERE id = ?`,
    )
    .run(
      JSON.stringify(tags.moods),
      tags.energy,
      tags.source,
      tags.confidence ?? null,
      TAGGER_VERSION,
      tags.promptHash ?? null,
      tags.model ?? null,
      new Date().toISOString(),
      id,
    );
}

// Remove a track's tags entirely (back to the untagged pool). NULLing every
// tag column — rather than writing moods='[]' — keeps source/tagged_at from
// going stale on a row that is no longer tagged.
export function clearTrackTags(id: string): void {
  requireDb()
    .prepare(
      `UPDATE tracks SET
        moods          = NULL,
        energy         = NULL,
        source         = NULL,
        confidence     = NULL,
        tagger_version = NULL,
        prompt_hash    = NULL,
        model          = NULL,
        tagged_at      = NULL
      WHERE id = ?`,
    )
    .run(id);
}

interface TrackAnalysisWrite {
  bpm?: number | null;
  musicalKey?: string | null;
  introMs?: number | null;
  confidence?: number | null;
  loudnessLufs?: number | null;
  peakDb?: number | null;
  sections?: TrackSection[] | null;
  // [] is meaningful (analysed instrumental) vs null/undefined (not computed) —
  // only a non-null array is written, so a vocal-off pass leaves the column be.
  vocalRanges?: TrackSection[] | null;
  pace?: TrackPaceSpan[] | null;
  beats?: number[] | null;
  bars?: number[] | null;
  keyRanges?: TrackKeyRange[] | null;
  // Outro features — null keeps an existing value (COALESCE, like vocal): a
  // pass that couldn't compute the tail (capped download, url path) must not
  // wipe an outro a previous complete-file pass measured.
  outro?: TrackOutro | null;
  // Whether this pass ran a stem-caching attempt for the track (feature: stem
  // backfill). true stamps stems_at so the backfill scope drops it; false/
  // undefined leaves the stamp alone. Pass true for a MISS too — see the
  // migration-17 note on why the stamp records the attempt, not disk presence.
  stemsAttempted?: boolean;
}

// Write acoustic-analysis results for a track. Stamps ANALYSIS_VERSION so
// resumable runs can skip already-analysed rows and a bump re-targets stale
// ones. Mirrors upsertTrackTags (UPDATE on an existing meta row).
export function upsertTrackAnalysis(id: string, a: TrackAnalysisWrite): void {
  requireDb()
    .prepare(
      `UPDATE tracks SET
        bpm                 = ?,
        musical_key         = ?,
        intro_ms            = ?,
        analysis_confidence = ?,
        loudness_lufs       = ?,
        peak_db             = ?,
        structure_json      = ?,
        pace_json           = ?,
        beats_json          = ?,
        bars_json           = ?,
        key_ranges_json     = ?,
        -- COALESCE: vocal activity is gated separately (ANALYZE_VOCAL_ACTIVITY),
        -- so a normal bpm/key pass passes null here and must NOT wipe an
        -- existing vocal_ranges_json. A non-null value (incl. "[]" for an
        -- analysed instrumental) overwrites; null keeps what's there.
        vocal_ranges_json   = COALESCE(?, vocal_ranges_json),
        -- Same for the outro: only computable off a COMPLETE file, so a pass
        -- that analysed a capped download passes null and keeps what's there.
        outro_json          = COALESCE(?, outro_json),
        -- Same COALESCE shape: a pass with the stem cache off passes null and
        -- must not clear a stamp an earlier stem pass set.
        stems_at            = COALESCE(?, stems_at),
        analysis_version    = ?
      WHERE id = ?`,
    )
    .run(
      Number.isFinite(a.bpm as number) ? (a.bpm as number) : null,
      a.musicalKey ?? null,
      Number.isFinite(a.introMs as number) ? Math.round(a.introMs as number) : null,
      Number.isFinite(a.confidence as number) ? (a.confidence as number) : null,
      Number.isFinite(a.loudnessLufs as number) ? (a.loudnessLufs as number) : null,
      Number.isFinite(a.peakDb as number) ? (a.peakDb as number) : null,
      a.sections && a.sections.length ? JSON.stringify(a.sections) : null,
      a.pace && a.pace.length ? JSON.stringify(a.pace) : null,
      a.beats && a.beats.length ? JSON.stringify(a.beats) : null,
      a.bars && a.bars.length ? JSON.stringify(a.bars) : null,
      a.keyRanges && a.keyRanges.length ? JSON.stringify(a.keyRanges) : null,
      a.vocalRanges != null ? JSON.stringify(a.vocalRanges) : null,
      a.outro != null ? JSON.stringify(a.outro) : null,
      a.stemsAttempted ? new Date().toISOString() : null,
      ANALYSIS_VERSION,
      id,
    );
}

// Ids that still need acoustic analysis: never analysed, or analysed by an
// older ANALYSIS_VERSION. Ordered for stable resumption. `limit` caps a run.
export function needsAnalysisIds(limit?: number): string[] {
  const sql =
    `SELECT id FROM tracks
       WHERE analysis_version IS NULL OR analysis_version < ?
       ORDER BY id` + (limit && limit > 0 ? ` LIMIT ${Math.floor(limit)}` : '');
  const rows = requireDb().prepare(sql).all(ANALYSIS_VERSION) as Array<{ id: string }>;
  return rows.map(r => r.id);
}

// Drop the acoustic analysis so a --re-analyze can recompute it. `keepVocal`
// preserves vocal_ranges_json — used when re-analysing bpm/key + sounds-like
// WITHOUT redoing the (very slow) Demucs vocal pass, so existing vocal data
// isn't wiped and left NULL (it wouldn't be rebuilt that run). #646-adjacent.
// `clearStems` drops the stem-cache stamps for the same reason in reverse:
// only a pass that will actually REWRITE stems (the cache is on) should reset
// them, or the stamps would be lost to a cache-off re-analyse and the whole
// library would re-separate the next time the operator turned the cache on.
export function clearAnalysis(opts: { keepVocal?: boolean; clearStems?: boolean } = {}): void {
  const d = requireDb();
  const vocalCol = opts.keepVocal ? '' : ' vocal_ranges_json = NULL,';
  const stemsCol = opts.clearStems ? ' stems_at = NULL,' : '';
  d.prepare(
    `UPDATE tracks SET bpm = NULL, musical_key = NULL, intro_ms = NULL,
      analysis_confidence = NULL, loudness_lufs = NULL, peak_db = NULL,
      structure_json = NULL, pace_json = NULL, beats_json = NULL, bars_json = NULL,
      key_ranges_json = NULL, outro_json = NULL,${vocalCol}${stemsCol} analysis_version = NULL,
      audio_moods = NULL, audio_mood_scores_json = NULL`,
  ).run();
  // The audio (CLAP) vectors are written in the same pass, so a --re-analyze
  // that redoes bpm/key drops them too — the next pass re-embeds from scratch.
  // Audio moods above go with them: they're derived from those vectors.
  d.prepare('DELETE FROM track_audio_vectors').run();
}

export function upsertTrackVector(id: string, vector: number[] | Float32Array): void {
  if (getEmbeddingDim() === null) {
    throw new Error('library-db opened without embedding dim');
  }
  if (vector.length !== getEmbeddingDim()) {
    throw new Error(
      `vector dim ${vector.length} != schema dim ${getEmbeddingDim()}; run --reseed if you changed embedding model`,
    );
  }
  const buf = Buffer.from(
    vector instanceof Float32Array ? vector.buffer : new Float32Array(vector).buffer,
  );
  // sqlite-vec vec0 tables don't support INSERT OR REPLACE — delete + insert
  // is the documented upsert pattern.
  const d = requireDb();
  d.prepare(`DELETE FROM track_vectors WHERE id = ?`).run(id);
  d.prepare(`INSERT INTO track_vectors (id, embedding) VALUES (?, ?)`).run(id, buf);
}

export function dropVectors(): void {
  if (getEmbeddingDim() === null) throw new Error('library-db not opened');
  const d = requireDb();
  runDdl(d, 'DROP TABLE IF EXISTS track_vectors');
  runDdl(d,
    `CREATE VIRTUAL TABLE track_vectors USING vec0(` +
      `id TEXT PRIMARY KEY, embedding FLOAT[${getEmbeddingDim()}] distance_metric=cosine)`,
  );
}

// Write a CLAP audio embedding for a track. Independent of getEmbeddingDim()
// (that's the TEXT index's dim) — the audio space is fixed at
// AUDIO_EMBEDDING_DIM. Same delete+insert upsert pattern vec0 requires.
export function upsertTrackAudioVector(id: string, vector: number[] | Float32Array): void {
  if (vector.length !== AUDIO_EMBEDDING_DIM) {
    throw new Error(
      `audio vector dim ${vector.length} != ${AUDIO_EMBEDDING_DIM} (CLAP); ` +
        `check CLAP_MODEL / the analyzer's audio_embedding output`,
    );
  }
  const buf = Buffer.from(
    vector instanceof Float32Array ? vector.buffer : new Float32Array(vector).buffer,
  );
  const d = requireDb();
  d.prepare(`DELETE FROM track_audio_vectors WHERE id = ?`).run(id);
  d.prepare(`INSERT INTO track_audio_vectors (id, embedding) VALUES (?, ?)`).run(id, buf);
}


