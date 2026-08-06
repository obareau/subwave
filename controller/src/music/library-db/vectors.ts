// Vector search over the sqlite-vec tables — text embeddings, audio (CLAP)
// embeddings, and the 2-D sound-map projection derived from them.

import { requireDb } from './handle.js';

// ---------------------------------------------------------------------------
// Vector queries
// ---------------------------------------------------------------------------

export interface KnnHit {
  id: string;
  similarity: number; // 1 - cosine_distance, so 1.0 = identical, 0 = orthogonal
}

export interface KnnOpts {
  // Ids never to return — the callers' recently-played sets. Excluded INSIDE
  // the query walk (the result is the k nearest NON-excluded neighbours), not
  // post-filtered by the caller: a heavily-aired cluster then answers with
  // neighbours k+1… instead of thinning toward empty, which is exactly the
  // moment the old shape silently contributed nothing (all k nearest recent →
  // source yields zero → the walk stays stuck in the aired bubble).
  excludeIds?: ReadonlySet<string> | null;
}

export function knnById(id: string, k: number, opts: KnnOpts = {}): KnnHit[] {
  const d = requireDb();
  const row = d.prepare(`SELECT embedding FROM track_vectors WHERE id = ?`).get(id) as
    | { embedding: Buffer }
    | undefined;
  if (!row) return [];
  return knnByBuffer(row.embedding, k, id, 'track_vectors', opts.excludeIds);
}

export function knnByVector(vec: number[] | Float32Array, k: number, opts: KnnOpts = {}): KnnHit[] {
  const buf = Buffer.from(
    vec instanceof Float32Array ? vec.buffer : new Float32Array(vec).buffer,
  );
  return knnByBuffer(buf, k, null, 'track_vectors', opts.excludeIds);
}

// Audio (CLAP) KNN — same logic as the text path, against track_audio_vectors.
// Returns [] when the seed has no audio vector, so callers fall through exactly
// like the text path does on an un-embedded seed.
export function knnAudioById(id: string, k: number, opts: KnnOpts = {}): KnnHit[] {
  const d = requireDb();
  const row = d.prepare(`SELECT embedding FROM track_audio_vectors WHERE id = ?`).get(id) as
    | { embedding: Buffer }
    | undefined;
  if (!row) return [];
  return knnByBuffer(row.embedding, k, id, 'track_audio_vectors', opts.excludeIds);
}

export function knnByAudioVector(vec: number[] | Float32Array, k: number, opts: KnnOpts = {}): KnnHit[] {
  const buf = Buffer.from(
    vec instanceof Float32Array ? vec.buffer : new Float32Array(vec).buffer,
  );
  return knnByBuffer(buf, k, null, 'track_audio_vectors', opts.excludeIds);
}

// How far past k the first pass widens for the exclusion set, as a multiple of
// k. The LIMIT has to clear the excluded rows for k survivors to exist, but
// sizing it by the raw set size over-reads badly: callers pass the picker's
// RECENCY union (recentIds ∪ hardRecentIds — hundreds of ids at the current
// noRepeatWindow and library-scaled windows), and most of those are Subsonic
// ids from auto.m3u plays or backfilled history that were never embedded, so
// they cannot appear in this table and cannot displace a hit. Widening by all
// of them made every KNN materialise several hundred rows to discard. The
// bounded pass covers the realistic overlap; the exact pass below still
// guarantees the old result whenever it doesn't.
const EXCLUDE_WIDEN_K_FACTOR = 3;

// `table` is always a hardcoded vec0 table name from our own code (never user
// input), so interpolating it is safe — the MATCH buffer is still bound.
function knnByBuffer(
  buf: Buffer,
  k: number,
  excludeId: string | null,
  table: 'track_vectors' | 'track_audio_vectors',
  excludeIds?: ReadonlySet<string> | null,
): KnnHit[] {
  const base = excludeId ? k + 1 : k;
  const want = excludeIds ? excludeIds.size : 0;
  const stmt = requireDb().prepare(
    `SELECT id, distance FROM ${table} WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
  );
  const run = (limit: number): KnnHit[] => {
    const rows = stmt.all(buf, limit) as Array<{ id: string; distance: number }>;
    const hits: KnnHit[] = [];
    for (const r of rows) {
      if (excludeId && r.id === excludeId) continue;
      if (excludeIds && excludeIds.has(r.id)) continue;
      hits.push({ id: r.id, similarity: 1 - r.distance });
      if (hits.length === k) break;
    }
    return hits;
  };

  const widened = Math.min(want, k * EXCLUDE_WIDEN_K_FACTOR);
  const hits = run(base + widened);
  // Only when the bounded pass actually fell short of k does the overlap turn
  // out to be larger than assumed — then pay for the full widening, which is
  // byte-for-byte the previous behaviour.
  if (hits.length < k && widened < want) return run(base + want);
  return hits;
}

// Whether a track has a CLAP vector at all, without decoding the blob — the
// cheap gate for callers that need to SAMPLE ids the audio index covers rather
// than discover the gaps by averaging around them (see the journey destination
// in broadcast/dj-agent/runs.ts).
export function hasAudioVector(id: string): boolean {
  return !!requireDb()
    .prepare(`SELECT 1 FROM track_audio_vectors WHERE id = ? LIMIT 1`)
    .get(id);
}

export function vectorCount(): number {
  return (requireDb().prepare('SELECT COUNT(*) AS n FROM track_vectors').get() as {
    n: number;
  }).n;
}

// The raw TEXT embedding vector for a track (a copy, not a view into the DB
// buffer), or null when the track has no text vector. The text-space twin of
// getAudioVector() — used by the Library Observatory dossier to render the
// learned vector as a heatmap fingerprint. vec0 stores the embedding as a
// packed float32 blob.
export function getVector(id: string): Float32Array | null {
  const row = requireDb()
    .prepare(`SELECT embedding FROM track_vectors WHERE id = ?`)
    .get(id) as { embedding: Buffer } | undefined;
  if (!row) return null;
  const b = row.embedding;
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)).slice();
}

// The raw CLAP vector for a track (a copy, not a view into the DB buffer), or
// null when the track has no audio vector. Used by the journey builder to
// resolve start/destination points in the audio space. vec0 stores the
// embedding as a packed float32 blob.
export function getAudioVector(id: string): Float32Array | null {
  const row = requireDb()
    .prepare(`SELECT embedding FROM track_audio_vectors WHERE id = ?`)
    .get(id) as { embedding: Buffer } | undefined;
  if (!row) return null;
  const b = row.embedding;
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)).slice();
}

export function audioVectorCount(): number {
  return (requireDb().prepare('SELECT COUNT(*) AS n FROM track_audio_vectors').get() as {
    n: number;
  }).n;
}

// Every stored CLAP vector in one pass — the sound-map projection's input.
// Each entry is a copy (not a view into the DB page), safe to hold across
// further DB work. ~18MB at 9k×512, well within a one-shot job's budget.
export function allAudioVectors(): { id: string; vector: Float32Array }[] {
  const rows = requireDb()
    .prepare('SELECT id, embedding FROM track_audio_vectors')
    .all() as { id: string; embedding: Buffer }[];
  return rows.map((r) => ({
    id: r.id,
    vector: new Float32Array(
      r.embedding.buffer,
      r.embedding.byteOffset,
      Math.floor(r.embedding.byteLength / 4),
    ).slice(),
  }));
}

// ---------------------------------------------------------------------------
// Sound-map projection coordinates (music/map-projection.ts)
// ---------------------------------------------------------------------------

export function setMapCoordsBulk(coords: { id: string; x: number; y: number }[]): void {
  const d = requireDb();
  const clear = d.prepare('UPDATE tracks SET map_x = NULL, map_y = NULL WHERE map_x IS NOT NULL');
  const stmt = d.prepare('UPDATE tracks SET map_x = ?, map_y = ? WHERE id = ?');
  // Clear-then-set in one transaction so coords always reflect exactly the
  // last projection — a track whose audio vector was since deleted can't keep
  // a stale position on the map.
  const tx = d.transaction((list: { id: string; x: number; y: number }[]) => {
    clear.run();
    for (const c of list) stmt.run(c.x, c.y, c.id);
  });
  tx(coords);
}

export function mapCoordsCount(): number {
  return (requireDb().prepare('SELECT COUNT(*) AS n FROM tracks WHERE map_x IS NOT NULL').get() as {
    n: number;
  }).n;
}

export function getMapProjectionMeta(): { algo: string; space: string; count: number; setAt: string } | null {
  const row = requireDb()
    .prepare('SELECT algo, space, count, set_at FROM map_projection_meta WHERE pk = 1')
    .get() as { algo: string; space: string; count: number; set_at: string } | undefined;
  return row ? { algo: row.algo, space: row.space, count: row.count, setAt: row.set_at } : null;
}

export function setMapProjectionMeta(algo: string, space: string, count: number): void {
  requireDb()
    .prepare(
      `INSERT INTO map_projection_meta (pk, algo, space, count, set_at) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(pk) DO UPDATE SET algo = excluded.algo, space = excluded.space,
         count = excluded.count, set_at = excluded.set_at`,
    )
    .run(algo, space, count, new Date().toISOString());
}


