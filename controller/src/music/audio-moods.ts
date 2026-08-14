// Zero-shot audio mood scoring — grounds the mood vocabulary in how each track
// actually SOUNDS, instead of what its title/artist suggest to an LLM.
//
// CLAP is trained contrastively on audio–text pairs, so its text tower and
// audio tower share one 512-d space: the cosine between a mood *description*
// embedded as text and a track's stored audio vector is a meaningful "does the
// track sound like this?" score. The audio vectors already exist (the analyze
// pass writes them), so scoring needs exactly one analyzer round-trip — embed
// the vocabulary prompts — and the rest is in-process dot products. Results
// land in tracks.audio_moods, which songsByMood blends with the LLM's
// metadata-derived tags at retrieval time.
//
// Everything degrades to a no-op: no vectors yet, no analysis backend, a lean
// backend without the text tower (no torch), or a mid-pass failure → log and
// skip. The station never depends on this pass having run.

import crypto from 'node:crypto';
import * as db from './library-db.js';
import * as analyzer from './analyzer.js';
import { moodVocab, moodPromptFor } from '../settings.js';
import { makeEventLogger } from './tagger-progress.js';
import {
  computeBaselines,
  moodPassAction,
  moodStateHashFor,
  prunedBaselines,
  selectAudioMoods,
  type MoodBaselines,
} from './audio-calibration.js';

const logEvent = makeEventLogger('audio-moods');

// Prompt for one mood — its operator-edited CLAP sound-description
// (settings.moods[].clapPrompt), or the bare word for a mood with no prompt.
// The descriptions are DESCRIPTIVE of sound on purpose — CLAP was trained on
// audio captions, so "how it sounds" phrasing scores far better than the bare
// word. Changing a prompt changes moodVocabHash(), which re-scores the whole
// library on the next pass.
export function moodPrompt(mood: string): string {
  return moodPromptFor(mood);
}

// Hash of the vocabulary + prompts the stored audio_moods were scored with.
// Stored in audio_embedding_meta.mood_vocab_hash; a mismatch re-scores every
// vector-carrying track (mirrors the tagger's promptVocabHash pattern).
export function moodVocabHash(vocab: readonly string[] = moodVocab()): string {
  const h = crypto.createHash('sha256');
  for (const m of vocab) h.update(`${m}=${moodPrompt(m)}|`);
  return h.digest('hex').slice(0, 16);
}

// Pick the top audio moods from a {mood: cosine} score map, on the RAW cosine
// axis — no per-mood calibration. Kept as the uncalibrated selection (a library
// with too few scored tracks to build baselines from still lands here, via
// selectAudioMoods' own fallback), and as the pre-#1362 behaviour the unit
// tests pin. Live passes go through selectAudioMoods with baselines.
// Pure — unit-pinned by scripts/audio-moods.test.ts.
export function topAudioMoods(
  scores: Record<string, number>,
  { max = 3, margin = 0.05 }: { max?: number; margin?: number } = {},
): string[] {
  return selectAudioMoods(scores, null, { max, margin });
}

function dot(a: Float32Array, b: number[]): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export interface AudioMoodStats {
  scored: number;
  scope: number;
  skipped: string | null; // reason when the pass didn't run (null = ran/empty)
  relabelled?: number;    // tracks whose labels were re-derived from stored cosines
  calibrated?: boolean;   // whether per-mood baselines were applied to selection
}

// Build the per-mood baselines from every score map on disk. Returns null when
// the library is too small to calibrate against, which callers pass straight
// through to selectAudioMoods (raw selection, pre-#1362 behaviour).
function loadBaselines(): MoodBaselines | null {
  const baselines = computeBaselines(
    (function* () {
      for (const row of db.iterateAudioMoodScores()) yield row.scores;
    })(),
  );
  // Pruned, not merely gated: a mood scored on too few tracks is dropped from
  // the set so it can't dominate selection on a degenerate sd, while the
  // library stays calibrated on the moods that do clear the floor.
  return prunedBaselines(baselines);
}

// Re-derive labels for every scored track from the cosines already on disk.
// No analyzer round-trip: a calibration change invalidates the LABELS, not the
// scores, and most installs do not run the CLAP text tower (ANALYZER_HEAVY is
// opt-in), so demanding one here would strand them on stale labels.
// PAGED, not streamed, and that is load-bearing: better-sqlite3 refuses a write
// while a read cursor is open on the same connection ("This database connection
// is busy executing a query"), and this loop writes as it walks. Streaming it
// worked for any library under one batch and threw on every library over it.
export function relabelFromStoredScores(baselines: MoodBaselines | null): number {
  const PAGE = 500;
  let done = 0;
  let cursor = '';
  for (;;) {
    const { items, lastId } = db.pageAudioMoodScores(cursor, PAGE);
    if (lastId == null) break;
    db.setTrackAudioMoodLabelsBulk(
      items.map(({ id, scores }) => ({ id, moods: selectAudioMoods(scores, baselines) })),
    );
    done += items.length;
    cursor = lastId;
  }
  return done;
}

// Score audio moods for every track that needs it. Incremental by default
// (vector present, audio_moods NULL); a vocabulary/prompt change re-scores the
// whole vector-carrying set. Called after the analysis pass from both bulk
// entry points — cheap when there's nothing to do.
export async function runAudioMoodPass(): Promise<AudioMoodStats> {
  if (db.audioVectorCount() === 0) {
    return { scored: 0, scope: 0, skipped: 'no audio vectors' };
  }

  const hash = moodVocabHash();
  const stored = db.getAudioMoodVocabHash();
  // Two independent reasons to redo work, and they cost very differently — a
  // vocabulary change invalidates the cosines (full CLAP re-score), a
  // calibration change invalidates only the labels (re-derive from disk).
  const action = moodPassAction(stored, hash);
  const vocabChanged = action === 'rescore';
  const ids = vocabChanged ? db.audioVectorIds() : db.idsNeedingAudioMoods();

  // Nothing new to score. A pending relabel still has to run — it is the whole
  // point of the calibration version, and it needs no analyzer.
  if (ids.length === 0) {
    if (action !== 'relabel') return { scored: 0, scope: 0, skipped: null };
    const baselines = loadBaselines();
    const relabelled = relabelFromStoredScores(baselines);
    db.setAudioMoodVocabHash(moodStateHashFor(hash, !!baselines));
    logEvent(
      'success',
      `Re-derived audio mood labels for ${relabelled.toLocaleString('en-GB')} tracks ` +
        `(per-mood calibration${baselines ? '' : ' unavailable — library too small, raw selection'})`,
    );
    return { scored: 0, scope: 0, skipped: null, relabelled, calibrated: !!baselines };
  }

  // One round-trip for the whole vocabulary. Generous timeout: the first call
  // after a cold boot may lazy-load (or download) the CLAP text tower. Snapshot
  // the live vocab once so prompts and the scoring loop stay index-aligned.
  const vocab = moodVocab();
  const prompts = vocab.map(moodPrompt);
  // coldRetry off: with a deadline this generous, a timeout means the backend
  // is broken, not cold — doubling it to 20 minutes would just stall the pass.
  const vecs = await analyzer.embedTexts(prompts, { timeoutMs: 10 * 60_000, coldRetry: false });
  if (!vecs || vecs.length !== vocab.length) {
    // A backend that ADVERTISES the text tower but failed the call is a runtime
    // fault (worker error, oversized-response 500 — #996), not a lean build;
    // "enable ANALYZER_HEAVY" would send the operator in the wrong direction.
    if (analyzer.textEmbeddingAvailable() === true) {
      logEvent(
        'warning',
        'Text embedding failed even though the backend reports a CLAP text tower — check the analyzer container logs; skipping audio moods',
      );
      return { scored: 0, scope: ids.length, skipped: 'text embedding failed' };
    }
    logEvent(
      'info',
      'Backend has no CLAP text tower — skipping audio moods (ANALYZER_HEAVY=1 enables it)',
    );
    return { scored: 0, scope: ids.length, skipped: 'no text tower' };
  }

  logEvent(
    'info',
    `Scoring audio moods for ${ids.length.toLocaleString('en-GB')} tracks` +
      (vocabChanged ? ' (vocabulary changed — full re-score)' : '') + '…',
  );

  // ── Phase 1: score ────────────────────────────────────────────────────────
  // Cosines only. Labels cannot be picked yet: selection is centred on per-mood
  // baselines drawn from the WHOLE library, and on a full re-score those
  // baselines are a property of the scores being written right now.
  // A full re-score relabels the whole library from disk in phase 3 (paged), so
  // holding this pass's own score maps would be a second copy of every row for
  // nothing. An incremental pass labels exactly what it scored, so keeping those
  // maps saves one SELECT per track re-reading what we just wrote — and its
  // scope is only the newly-analysed tracks, which is what bounds the memory.
  const relabelAll = vocabChanged || action === 'relabel';
  const scoredRows: Array<{ id: string; scores: Record<string, number> }> = [];
  let scored = 0;
  let batch: Array<{ id: string; scores: Record<string, number> }> = [];
  for (const id of ids) {
    const v = db.getAudioVector(id);
    if (!v) continue;
    const scores: Record<string, number> = {};
    for (let i = 0; i < vocab.length; i++) {
      // Both sides are L2-normalised, so the dot IS the cosine. 3 decimals is
      // plenty of precision and keeps the stored JSON small.
      scores[vocab[i]] = Math.round(dot(v, vecs[i]) * 1000) / 1000;
    }
    batch.push({ id, scores });
    if (!relabelAll) scoredRows.push({ id, scores });
    scored += 1;
    if (batch.length >= 500) {
      db.setTrackAudioMoodScoresBulk(batch);
      batch = [];
      console.log(`[audio-moods] ${scored}/${ids.length}`);
    }
  }
  db.setTrackAudioMoodScoresBulk(batch);

  // ── Phase 2: calibrate ────────────────────────────────────────────────────
  const baselines = loadBaselines();

  // ── Phase 3: label ────────────────────────────────────────────────────────
  // A full re-score relabels everything (every track's axis just moved); an
  // incremental pass labels only what it scored, since a handful of new tracks
  // cannot meaningfully shift a library-wide distribution.
  let relabelled = 0;
  if (relabelAll) {
    relabelled = relabelFromStoredScores(baselines);
  } else {
    let labels: Array<{ id: string; moods: string[] }> = [];
    for (const { id, scores } of scoredRows) {
      labels.push({ id, moods: selectAudioMoods(scores, baselines) });
      relabelled += 1;
      if (labels.length >= 500) {
        db.setTrackAudioMoodLabelsBulk(labels);
        labels = [];
      }
    }
    db.setTrackAudioMoodLabelsBulk(labels);
  }

  db.setAudioMoodVocabHash(moodStateHashFor(hash, !!baselines));
  logEvent(
    'success',
    `Audio moods scored — ${scored.toLocaleString('en-GB')} tracks` +
      (baselines ? ' (per-mood calibration applied)' : ' (uncalibrated — library too small)'),
  );
  return { scored, scope: ids.length, skipped: null, relabelled, calibrated: !!baselines };
}
