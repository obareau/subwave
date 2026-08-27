// Qualitative feel for the track a script is introducing (issue #1443).
//
// The script generators ask the model to "capture its feel" but hand it only a
// title and an artist, so it has to infer the sound from the words in the
// title. That is a coin flip: "Balaclava" reads wintry, and the DJ introduced a
// 143 BPM Arctic Monkeys track with "slow down and let a steady groove take
// over". The library knew better the whole time — that track carries
// audioMoods ["workout","festival","celebratory"].
//
// So: derive one adjective from what the AUDIO says and hand it over. No-op for
// un-analysed tracks — same posture as introBudgetPhrase, the post is a bonus
// when the data exists, never a precondition.
//
// Deliberately NOT derived from `moods`. That field is the tagger reading the
// metadata, and on the reported track it says ["reflective","night"] — the
// exact wrong steer. library.ts already draws this line: audioMoods is kept
// separate "so consumers can tell 'the LLM read the metadata' from 'the audio
// actually sounds like this'". This is a consumer that needs the second one.
//
// Deliberately NOT derived from bpm either, for now: #1417 has beat_track
// reading slow material an octave high (a 76 BPM ballad stores as 152), so a
// tempo band would be confidently wrong on exactly the slow tracks this is
// meant to protect. Once that lands, a tempo word is a natural second signal.

import * as library from '../../../music/library.js';
import { HIGH_ENERGY_MOODS, LOW_ENERGY_MOODS } from '../../../music/audio-calibration.js';

// Stored zero-shot audio moods for a track, from the track object or a library
// lookup. [] when un-analysed or un-scored.
function audioMoodsFor(track: any): string[] {
  const own = track?.audioMoods;
  if (Array.isArray(own)) return own;
  const rec = track?.id ? library.get(track.id) : null;
  return Array.isArray(rec?.audioMoods) ? rec.audioMoods : [];
}

/**
 * One-word feel for a track — 'high-energy' | 'low-key' | null.
 *
 * Counts stored audio moods against the same arousal split the calibration
 * layer uses, so a renamed or deleted mood degrades to null rather than
 * flipping the answer (moods are operator-editable). A tie is null: two ends
 * pulling equally is not a feel, and silence is always a safe output here.
 */
export function trackFeel(track: any): 'high-energy' | 'low-key' | null {
  const moods = audioMoodsFor(track).map((m) => String(m).toLowerCase());
  if (!moods.length) return null;
  const high = moods.filter((m) => (HIGH_ENERGY_MOODS as readonly string[]).includes(m)).length;
  const low = moods.filter((m) => (LOW_ENERGY_MOODS as readonly string[]).includes(m)).length;
  if (high > low) return 'high-energy';
  if (low > high) return 'low-key';
  return null;
}

/**
 * The feel as a prompt suffix — ' — high-energy' or '' when unknown.
 *
 * Returned pre-joined so a call site can append it to an existing "Now
 * playing:" line without a conditional, and an un-analysed track produces a
 * byte-identical prompt to before.
 */
export function trackFeelSuffix(track: any): string {
  const feel = trackFeel(track);
  return feel ? ` — ${feel}` : '';
}
