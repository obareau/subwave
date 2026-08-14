// Correct PROPAGATED energy values from the audio the analyzer actually heard.
//
// tracks.energy normally comes from the LLM tagger reading a track's TEXT
// metadata — genre, Last.fm tags, lyrics. When a track's metadata is too thin
// for a judgement, the tagger instead inherits a value from the track's
// embedding neighbours and stamps source = 'propagated' (music/tag-library.ts
// phase 3). On a real 11k library that is 41% of the catalogue, and those rows
// are guesses built on guesses: issue #1362's example is a big-beat dance track
// mislabelled genre "Soundtrack", propagated to energy 'low' + moods
// [calm, night], which then satisfied the strict energy lock on an overnight
// ambient show and aired there.
//
// Meanwhile the analyzer had already scored that same track against the mood
// vocabulary from its AUDIO — and got it right. That signal was sitting in
// tracks.audio_mood_scores_json, read by nothing on any playback path.
//
// This pass closes that gap for energy specifically, and only where the audio
// is DECISIVE (see audio-calibration.audioEnergy — it returns null for the
// ambiguous middle rather than bucketing it). Moods are deliberately NOT
// corrected the same way: the label list needed its own calibration first, and
// even calibrated, a mood is an editorial judgement in a way an arousal axis
// is not.

import * as db from './library-db.js';
import { audioEnergy, computeBaselines, prunedBaselines } from './audio-calibration.js';
import { makeEventLogger } from './tagger-progress.js';

const logEvent = makeEventLogger('audio-energy');

export interface PropagatedEnergyStats {
  scope: number;      // propagated tracks carrying audio scores
  corrected: number;  // rows whose energy the audio actually changed
  agreed: number;     // rows where the audio confirmed the propagated value
  undecided: number;  // rows where the audio had no decisive answer
  skipped: string | null;
}

// Re-derive energy for every propagated track the audio can speak to.
//
// Only `energy` is written — source stays 'propagated' and the moods stay as
// propagation left them, so the row keeps reporting honestly that its MOODS are
// inherited even once its energy is measured. Nothing here touches a row whose
// source is 'llm' / 'manual' / 'uncertain-llm': those are real per-track
// judgements about this track and are not this pass's business.
export function runPropagatedEnergyPass(): PropagatedEnergyStats {
  const empty = { scope: 0, corrected: 0, agreed: 0, undecided: 0 };

  const rows = db.propagatedTracksWithAudioScores();
  if (rows.length === 0) {
    return { ...empty, skipped: 'no propagated tracks with audio scores' };
  }

  // Baselines come from the WHOLE library, not just the propagated subset —
  // the question is "is this track high-arousal for this library", and a
  // distribution built only from the tracks the tagger found hardest to read
  // would be a biased yardstick.
  //
  // Pruned per mood before use: a mood scored on too few tracks carries a
  // near-degenerate sd, and one of those on either arousal list would swing the
  // whole axis on float noise. Dropping it costs a term; keeping it costs
  // correctness.
  const baselines = prunedBaselines(
    computeBaselines(
      (function* () {
        for (const row of db.iterateAudioMoodScores()) yield row.scores;
      })(),
    ),
  );
  if (!baselines) {
    return { ...empty, scope: rows.length, skipped: 'library too small to calibrate against' };
  }

  const updates: Array<{ id: string; energy: string }> = [];
  let agreed = 0;
  let undecided = 0;
  for (const row of rows) {
    const derived = audioEnergy(row.scores, baselines);
    if (derived == null) {
      undecided += 1;
      continue;
    }
    if (derived === row.energy) {
      agreed += 1;
      continue;
    }
    updates.push({ id: row.id, energy: derived });
  }

  db.setTrackEnergyBulk(updates);

  logEvent(
    'success',
    `Audio-derived energy over ${rows.length.toLocaleString('en-GB')} propagated tracks — ` +
      `${updates.length.toLocaleString('en-GB')} corrected, ${agreed.toLocaleString('en-GB')} confirmed, ` +
      `${undecided.toLocaleString('en-GB')} left as-is (audio not decisive)`,
  );

  return {
    scope: rows.length,
    corrected: updates.length,
    agreed,
    undecided,
    skipped: null,
  };
}
