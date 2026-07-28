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

export function knnById(id: string, k: number): KnnHit[] {
  const d = requireDb();
  const row = d.prepare(`SELECT embedding FROM track_vectors WHERE id = ?`).get(id) as
    | { embedding: Buffer }
    | undefined;
  if (!row) return [];
  return knnByBuffer(row.embedding, k, id, 'track_vectors');
}

export function knnByVector(vec: number[] | Float32Array, k: number): KnnHit[] {
  const buf = Buffer.from(
    vec instanceof Float32Array ? vec.buffer : new Float32Array(vec).buffer,
  );
  return knnByBuffer(buf, k, null, 'track_vectors');
}

// Audio (CLAP) KNN — same logic as the text path, against track_audio_vectors.
// Returns [] when the seed has no audio vector, so callers fall through exactly
// like the text path does on an un-embedded seed.
export function knnAudioById(id: string, k: number): KnnHit[] {
  const d = requireDb();
  const row = d.prepare(`SELECT embedding FROM track_audio_vectors WHERE id = ?`).get(id) as
    | { embedding: Buffer }
    | undefined;
  if (!row) return [];
  return knnByBuffer(row.embedding, k, id, 'track_audio_vectors');
}

export function knnByAudioVector(vec: number[] | Float32Array, k: number): KnnHit[] {
  const buf = Buffer.from(
    vec instanceof Float32Array ? vec.buffer : new Float32Array(vec).buffer,
  );
  return knnByBuffer(buf, k, null, 'track_audio_vectors');
}

// `table` is always a hardcoded vec0 table name from our own code (never user
// input), so interpolating it is safe — the MATCH buffer is still bound.
function knnByBuffer(
  buf: Buffer,
  k: number,
  excludeId: string | null,
  table: 'track_vectors' | 'track_audio_vectors',
): KnnHit[] {
  const limit = excludeId ? k + 1 : k;
  const rows = requireDb()
    .prepare(
      `SELECT id, distance FROM ${table} WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
    )
    .all(buf, limit) as Array<{ id: string; distance: number }>;
  const hits: KnnHit[] = [];
  for (const r of rows) {
    if (excludeId && r.id === excludeId) continue;
    hits.push({ id: r.id, similarity: 1 - r.distance });
    if (hits.length === k) break;
  }
  return hits;
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


