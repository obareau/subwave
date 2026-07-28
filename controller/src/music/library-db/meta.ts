// Embedding-model metadata: which model produced the stored text vectors, at
// what dimension, and in which text mode. Read on open to decide whether the
// index is still valid for the configured model.

import { requireDb } from './handle.js';

// ---------------------------------------------------------------------------
// Embedding meta
// ---------------------------------------------------------------------------

// `textMode` records whether the vectors were embedded with the model's
// document prefix ('prefixed') or bare ('plain'); null = legacy row from
// before mode tracking (equivalent to 'plain' — see resolveIndexTextMode).
type EmbeddingTextMode = 'plain' | 'prefixed';

export function getEmbeddingMeta(): {
  model: string;
  dim: number;
  textMode: EmbeddingTextMode | null;
} | null {
  const row = requireDb()
    .prepare('SELECT model, dim, text_mode FROM embedding_meta WHERE pk = 1')
    .get() as { model: string; dim: number; text_mode: string | null } | undefined;
  if (!row) return null;
  return {
    model: row.model,
    dim: row.dim,
    textMode: row.text_mode === 'prefixed' || row.text_mode === 'plain' ? row.text_mode : null,
  };
}

export function setEmbeddingMeta(
  model: string,
  dim: number,
  textMode: EmbeddingTextMode | null = null,
): void {
  requireDb()
    .prepare(
      `INSERT INTO embedding_meta (pk, model, dim, set_at, text_mode) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(pk) DO UPDATE SET model = excluded.model, dim = excluded.dim,
         set_at = excluded.set_at, text_mode = excluded.text_mode`,
    )
    .run(model, dim, new Date().toISOString(), textMode);
}

// Audio-embedding provenance — which CLAP model wrote the current audio
// vectors. Distinct table from embedding_meta (text); the two spaces are
// independent. Null until the first audio vector is written.
export function setAudioEmbeddingMeta(model: string, dim: number): void {
  requireDb()
    .prepare(
      `INSERT INTO audio_embedding_meta (pk, model, dim, set_at) VALUES (1, ?, ?, ?)
       ON CONFLICT(pk) DO UPDATE SET model = excluded.model, dim = excluded.dim, set_at = excluded.set_at`,
    )
    .run(model, dim, new Date().toISOString());
}


