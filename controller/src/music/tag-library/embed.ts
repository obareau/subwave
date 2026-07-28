// Phase 1 - embedding. Turns each track's metadata and enrichment into the
// text vector the picker's similarity search runs over.
//
// Part of the tag-library/ split - see ../tag-library.ts for main().

import * as db from '../library-db.js';
import * as embeddings from '../embeddings.js';
import { reportProgress } from '../tagger-progress.js';
import { logEvent } from './log.js';


// ---------------------------------------------------------------------------
// Phase 1 — Embed
// ---------------------------------------------------------------------------

export async function phaseEmbed(
  targetIds: string[],
  batchSize: number,
  // The index's task-prefix mode (resolved once in run()) — every document
  // this phase writes must match the vectors already in the index.
  textMode: embeddings.IndexTextMode,
): Promise<void> {
  // Embed any track in scope that doesn't already have a vector. Includes
  // already-tagged tracks (legacy v1) so they can serve as KNN neighbours.
  const needsEmbed: string[] = [];
  for (const id of targetIds) {
    if (!db.hasVector(id)) needsEmbed.push(id);
  }
  // Also embed all already-tagged tracks that don't have vectors yet (legacy
  // v1 imports). Without this they can't anchor the KNN graph.
  for (const id of db.allTaggedIds()) {
    if (!db.hasVector(id)) needsEmbed.push(id);
  }
  // Dedup
  const unique = [...new Set(needsEmbed)];
  if (unique.length === 0) {
    console.log('[tag] phase-1 nothing to embed');
    return;
  }
  logEvent('info', `Building similarity vectors for ${unique.length.toLocaleString('en-GB')} tracks…`);
  reportProgress({ phase: 'embed', label: 'Embedding tracks', done: 0, total: unique.length });

  const embedBatchSize = Math.max(8, Math.min(64, batchSize * 2));
  for (let i = 0; i < unique.length; i += embedBatchSize) {
    const batch = unique.slice(i, i + embedBatchSize);
    const songs = batch.map(id => db.getTrack(id)).filter((t): t is db.TrackRecord => !!t);
    const texts = songs.map(t =>
      embeddings.formatTrackText(
        { title: t.title, artist: t.artist, album: t.album, year: t.year, genres: t.genres },
        { lastfmTags: t.lastfmTags, lyricExcerpt: t.lyricExcerpt },
      ),
    );
    let vecs: number[][];
    try {
      vecs = await embeddings.embedDocTexts(texts, textMode);
    } catch (err: any) {
      console.error(`[tag] embedding batch failed at offset ${i}: ${err.message}`);
      throw err;
    }
    for (let j = 0; j < songs.length; j++) {
      db.upsertTrackVector(songs[j].id, vecs[j]);
    }
    if ((i + batch.length) % 500 === 0 || i + batch.length === unique.length) {
      console.log(`[tag] embedded ${i + batch.length}/${unique.length}`);
      reportProgress({ phase: 'embed', label: 'Embedding tracks', done: i + batch.length, total: unique.length });
    }
  }
}

