// Zero-shot audio moods: mood labels derived by scoring CLAP audio vectors
// against the mood vocabulary's text prompts (music/audio-moods.ts), plus the
// vocab hash that decides when a re-score is due.

import { AUDIO_EMBEDDING_DIM, requireDb } from './handle.js';

// ---------------------------------------------------------------------------
// Zero-shot audio moods (music/audio-moods.ts) — mood labels derived by scoring
// the vocabulary's CLAP TEXT embeddings against each track's stored audio
// vector. Sound-derived, so they complement the LLM's metadata-guessed `moods`.
// ---------------------------------------------------------------------------

// Transactional bulk write for the scoring pass — one commit per batch instead
// of one per track (the pass touches every vector-carrying row).
export function setTrackAudioMoodsBulk(
  rows: Array<{ id: string; moods: string[]; scores: Record<string, number> }>,
): void {
  if (rows.length === 0) return;
  const d = requireDb();
  const stmt = d.prepare(
    `UPDATE tracks SET audio_moods = ?, audio_mood_scores_json = ? WHERE id = ?`,
  );
  d.transaction((rs: typeof rows) => {
    for (const r of rs) stmt.run(JSON.stringify(r.moods), JSON.stringify(r.scores), r.id);
  })(rows);
}

// Every id carrying an audio vector — the full re-score scope when the mood
// vocabulary/prompts change. JOINed to tracks so a vector whose track row was
// pruned is never scored.
export function audioVectorIds(): string[] {
  const rows = requireDb()
    .prepare(
      `SELECT v.id FROM track_audio_vectors v JOIN tracks t ON t.id = v.id ORDER BY v.id`,
    )
    .all() as Array<{ id: string }>;
  return rows.map(r => r.id);
}

// Ids with an audio vector but no audio moods yet — the incremental scope for
// an unchanged vocabulary (newly analysed tracks since the last scoring pass).
export function idsNeedingAudioMoods(): string[] {
  const rows = requireDb()
    .prepare(
      `SELECT v.id FROM track_audio_vectors v JOIN tracks t ON t.id = v.id
       WHERE t.audio_moods IS NULL ORDER BY v.id`,
    )
    .all() as Array<{ id: string }>;
  return rows.map(r => r.id);
}

// The full {mood: cosine} score map behind a track's audio_moods — the
// dossier/tuning surface only (hot paths read the pre-picked audio_moods
// labels; this column is never parsed on a playback path).
export function getAudioMoodScores(id: string): Record<string, number> | null {
  const row = requireDb()
    .prepare('SELECT audio_mood_scores_json AS s FROM tracks WHERE id = ?')
    .get(id) as { s: string | null } | undefined;
  if (!row?.s) return null;
  try {
    const v = JSON.parse(row.s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// The vocabulary hash the current audio_moods were scored with, or null (never
// scored / legacy meta row). A mismatch re-scores everything.
export function getAudioMoodVocabHash(): string | null {
  const row = requireDb()
    .prepare('SELECT mood_vocab_hash FROM audio_embedding_meta WHERE pk = 1')
    .get() as { mood_vocab_hash: string | null } | undefined;
  return row?.mood_vocab_hash ?? null;
}

export function setAudioMoodVocabHash(hash: string): void {
  // The meta row normally exists by the time moods are scored (the analyze pass
  // stamps it with the first vector), but seed defensively — model/dim are
  // NOT NULL, and setAudioEmbeddingMeta's own upsert never touches the hash.
  requireDb()
    .prepare(
      `INSERT INTO audio_embedding_meta (pk, model, dim, set_at, mood_vocab_hash)
       VALUES (1, 'unknown', ?, ?, ?)
       ON CONFLICT(pk) DO UPDATE SET mood_vocab_hash = excluded.mood_vocab_hash`,
    )
    .run(AUDIO_EMBEDDING_DIM, new Date().toISOString(), hash);
}

// Tracks with vocal-activity analysis done — vocal_ranges_json IS NOT NULL,
// where a stored "[]" (analysed instrumental) counts as done. The inverse of
// needsVocalIds, surfaced as a coverage meter (#646).
export function vocalAnalyzedCount(): number {
  return (requireDb().prepare(
    'SELECT COUNT(*) AS n FROM tracks WHERE vocal_ranges_json IS NOT NULL',
  ).get() as { n: number }).n;
}

// Ids that have no audio vector yet (never embedded). Resumable, ordered for
// stable resumption, independent of the bpm/key analysis scope so the audio
// backfill can run on its own cadence. LEFT JOIN where the vector row is absent.
export function unanalysedAudioIds(limit?: number): string[] {
  const q = limit && limit > 0
    ? `SELECT t.id FROM tracks t LEFT JOIN track_audio_vectors v ON v.id = t.id
       WHERE v.id IS NULL ORDER BY t.id LIMIT ${Math.floor(limit)}`
    : `SELECT t.id FROM tracks t LEFT JOIN track_audio_vectors v ON v.id = t.id
       WHERE v.id IS NULL ORDER BY t.id`;
  const rows = requireDb().prepare(q).all() as Array<{ id: string }>;
  return rows.map(r => r.id);
}

// Ids with no vocal-activity analysis yet (vocal_ranges_json IS NULL — a stored
// "[]" instrumental counts as done and is skipped). Independent of the bpm/key
// scope, like unanalysedAudioIds, so the (expensive, opt-in) Demucs backfill
// runs on its own cadence. Ordered for stable resumption.
//
// `includeTailMissing` (feature: vocal-aware transitions) widens the scope to
// tracks whose outro was measured BEFORE tail vocal detection existed —
// head-analysed but tail-missing. The probe is textual on the raw outro_json:
// the worker/transport omit the vocalRanges key entirely when not computed
// (never write null), so its absence in the JSON.stringify output is exact.
// Tracks with outro_json NULL (short/truncated files) are excluded — they can
// never gain tail data, so including them would churn. Callers must only pass
// true when the backend advertises tail_vocal (analyzer.tailVocalAvailable()
// === true), or a stale sidecar re-analyses these tracks forever for a
// guaranteed no-op.
export function needsVocalIds(limit?: number, includeTailMissing = false): string[] {
  const where = includeTailMissing
    ? `vocal_ranges_json IS NULL
       OR (outro_json IS NOT NULL AND outro_json NOT LIKE '%"vocalRanges"%')`
    : `vocal_ranges_json IS NULL`;
  const q =
    `SELECT id FROM tracks WHERE ${where} ORDER BY id` +
    (limit && limit > 0 ? ` LIMIT ${Math.floor(limit)}` : '');
  const rows = requireDb().prepare(q).all() as Array<{ id: string }>;
  return rows.map(r => r.id);
}

// Ids that have never had a stem-caching pass (feature: stem backfill), so
// turning the stem cache on for an already-analysed library fills it in
// without the destructive, non-resumable --re-analyze that was the only path
// before. Independent of the bpm/key scope like the two above, ordered for
// stable resumption across nights.
//
// stems_at stamps the ATTEMPT, not disk presence — see the migration-17 note.
// That is what makes this converge: the LRU sweep evicts stem dirs whenever
// the cache outgrows its budget, and a presence-based scope would drag every
// evicted track back in on the next pass, forever, on any library bigger than
// the budget.
export function needsStemsIds(limit?: number): string[] {
  const q =
    `SELECT id FROM tracks WHERE stems_at IS NULL ORDER BY id` +
    (limit && limit > 0 ? ` LIMIT ${Math.floor(limit)}` : '');
  const rows = requireDb().prepare(q).all() as Array<{ id: string }>;
  return rows.map(r => r.id);
}

// Coverage meter companion to vocalAnalyzedCount — how many tracks have had a
// stem pass. Surfaced next to the analysis counts so the operator can see the
// backfill advancing instead of guessing from the folder size.
export function stemsCachedCount(): number {
  return (requireDb().prepare(
    'SELECT COUNT(*) AS n FROM tracks WHERE stems_at IS NOT NULL',
  ).get() as { n: number }).n;
}

// Total tracks known to the catalogue. Used by the analyze CLI to decide
// whether to walk Navidrome (only on an empty/bootstrap catalogue).
export function trackCount(): number {
  return (requireDb().prepare('SELECT COUNT(*) AS n FROM tracks').get() as {
    n: number;
  }).n;
}

// Drop track rows (and their vectors) for ids that are no longer in the live
// Navidrome catalogue. `liveIds` MUST be the id set from a COMPLETE, successful
// walk of subsonic.iterateAllSongs() — passing a partial set would delete live
// tags. Callers guard on a non-empty walk so a transient empty Navidrome
// response can't wipe the DB.
//
// Why this is needed: the walk only ever upserts, never deletes. A Navidrome
// full rescan can re-mint track IDs, orphaning every previous row; across
// several rescans the DB balloons far past the live catalogue. Those orphans
// inflate the coverage percentage past 100% and blow up the acoustic-analysis
// scope with dead, un-downloadable ids. Returns the number of rows deleted.
export function pruneMissingTracks(liveIds: ReadonlySet<string>): number {
  const d = requireDb();
  const all = (d.prepare('SELECT id FROM tracks').all() as Array<{ id: string }>).map(r => r.id);
  const orphans = all.filter(id => !liveIds.has(id));
  if (orphans.length === 0) return 0;
  const delTrack = d.prepare('DELETE FROM tracks WHERE id = ?');
  const delVec = d.prepare('DELETE FROM track_vectors WHERE id = ?');
  const delAudioVec = d.prepare('DELETE FROM track_audio_vectors WHERE id = ?');
  const runPrune = d.transaction((ids: string[]) => {
    for (const id of ids) {
      delTrack.run(id);
      delVec.run(id);
      delAudioVec.run(id);
    }
  });
  runPrune(orphans);
  return orphans.length;
}

// Tracks with acoustic analysis. A track is "analysed" iff bpm IS NOT NULL
// (bpm/musical_key/intro_ms are written together by upsertTrackAnalysis).
export function analysedCount(): number {
  return (requireDb().prepare('SELECT COUNT(*) AS n FROM tracks WHERE bpm IS NOT NULL').get() as {
    n: number;
  }).n;
}

// IDs of tracks that already carry acoustic analysis (bpm filled). The re-scan
// "Re-analyse" scope — capture BEFORE clearAnalysis() so the redo targets only
// the previously-analysed population, not the whole (mostly un-analysed) library.
export function analysedIds(): string[] {
  return (
    requireDb()
      .prepare('SELECT id FROM tracks WHERE bpm IS NOT NULL ORDER BY id')
      .all() as Array<{ id: string }>
  ).map(r => r.id);
}


