// Calibration for the zero-shot audio moods (music/audio-moods.ts).
//
// CLAP scores a track's audio vector against each mood's text prompt, and the
// raw cosine is what lands in tracks.audio_mood_scores_json. Those cosines are
// NOT comparable across moods: every prompt sits at its own baseline in the
// shared 512-d space, so a mood whose wording happens to embed near the centre
// of the music manifold scores higher on EVERY track than one whose wording
// sits out at the edge. Picking "the top-scoring moods for this track" over raw
// cosines therefore ranks prompts, not tracks — on a real 11k library that came
// out as `energetic` firing on 61.7% of tracks and `rainy` on 43.5%, against
// `calm` on 0.9% and `spiritual` on 0.2% (issue #1362). That is a property of
// the vocabulary, not of the music.
//
// The fix is to judge each mood against ITS OWN library-wide distribution:
// z = (score - mean) / sd, computed per mood across every scored track. A
// track is then "calm" when it is calm *for this library*, which is the
// question the label was always meant to answer. Selection stays relative and
// top-K (the shape topAudioMoods always had) — only the axis changes.
//
// Everything here is pure and unit-pinned by scripts/audio-calibration.test.ts.

// Bumped whenever the derivation below changes in a way that makes stored
// labels stale. It rides the mood-state hash (composeMoodStateHash) BESIDE the
// vocabulary hash rather than inside it, which is what lets a calibration
// change re-derive labels from the cosines already on disk instead of forcing a
// full CLAP re-score — the analyzer's text tower need not even be reachable.
export const CALIBRATION_VERSION = 2;

// A mood's library-wide score distribution.
export interface MoodBaseline {
  mean: number;
  sd: number;
  n: number;
}

export type MoodBaselines = Record<string, MoodBaseline>;

// Below this many scored tracks a "library-wide distribution" is noise, and
// centering on it would be worse than not centering at all. Passes under the
// floor fall back to raw selection (see selectAudioMoods).
export const MIN_BASELINE_TRACKS = 200;

// Guards the z divide. A mood whose scores are near-identical on every track
// carries no information; without a floor its z would explode on float noise
// and that mood would win every track — the exact failure being fixed.
const MIN_SD = 1e-3;

// ---------------------------------------------------------------------------
// Baselines
// ---------------------------------------------------------------------------

// Per-mood mean/sd over a stream of stored score maps. Streaming (rather than
// taking an array) because the caller reads these straight off SQLite for the
// whole library — a 200k-row array of objects is a memory spike for a figure
// that only needs running sums.
//
// Uses a two-pass-free running variance (sum / sumSq). Cosines are small and
// bounded by [-1, 1], so the classic catastrophic-cancellation objection to
// sum-of-squares does not bite at library scale here.
export function computeBaselines(rows: Iterable<Record<string, number>>): MoodBaselines {
  const sum: Record<string, number> = Object.create(null);
  const sumSq: Record<string, number> = Object.create(null);
  const count: Record<string, number> = Object.create(null);

  for (const scores of rows) {
    if (!scores || typeof scores !== 'object') continue;
    for (const [mood, raw] of Object.entries(scores)) {
      if (!Number.isFinite(raw)) continue;
      sum[mood] = (sum[mood] ?? 0) + raw;
      sumSq[mood] = (sumSq[mood] ?? 0) + raw * raw;
      count[mood] = (count[mood] ?? 0) + 1;
    }
  }

  const out: MoodBaselines = {};
  for (const mood of Object.keys(count)) {
    const n = count[mood];
    const mean = sum[mood] / n;
    // Population variance, clamped at 0 — float error can drive an
    // all-identical mood a hair below zero.
    const variance = Math.max(0, sumSq[mood] / n - mean * mean);
    out[mood] = { mean, sd: Math.sqrt(variance), n };
  }
  return out;
}

// Drop moods whose OWN sample count falls short of the floor, returning null
// when nothing survives (the caller then falls back to raw selection).
//
// Per-mood n can lag the library's: a mood added to the vocabulary since the
// last full re-score is only scored on tracks analysed after it, so an
// established mood can sit at n=5000 beside a new one at n=12. A mood with a
// handful of samples has a near-degenerate sd that MIN_SD barely restrains, so
// its z explodes and it wins every track — the exact failure calibration exists
// to fix, one mood at a time. Gating on the MAXIMUM n let that straight
// through. Pruning per mood is the targeted answer: the library stays
// calibrated on its established moods, and the thin one is simply absent from
// the baselines, which centeredScores already drops rather than passing raw.
export function prunedBaselines(baselines: MoodBaselines | null): MoodBaselines | null {
  if (!baselines) return null;
  const out: MoodBaselines = {};
  for (const [mood, b] of Object.entries(baselines)) {
    if (b.n >= MIN_BASELINE_TRACKS) out[mood] = b;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// Is this baseline set usable? A set built from too few tracks, or one that
// somehow carries no moods, is refused so callers fall back to raw selection
// rather than centering on noise.
export function baselinesUsable(baselines: MoodBaselines | null): boolean {
  return prunedBaselines(baselines) !== null;
}

// A track's scores expressed as per-mood z-scores. Moods with no baseline (a
// vocabulary entry added since the baselines were built) are dropped rather
// than passed through raw — a raw cosine and a z-score are different units and
// mixing them in one ranking is how the original bug worked.
export function centeredScores(
  scores: Record<string, number>,
  baselines: MoodBaselines,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [mood, raw] of Object.entries(scores)) {
    if (!Number.isFinite(raw)) continue;
    const b = baselines[mood];
    if (!b) continue;
    out[mood] = (raw - b.mean) / Math.max(b.sd, MIN_SD);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Label selection
// ---------------------------------------------------------------------------

// Selection margin in STANDARD DEVIATIONS, the unit centered scores live in.
// The pre-calibration default was 0.05 raw cosine, which has no meaning on this
// axis. 0.5 sd keeps labels-per-track in a similar range: a mood joins the
// winner when it is within half a standard deviation of it.
//
// This figure is a defensible starting point, not a measured optimum — it wants
// a pass against a real library's label-distribution spread.
export const DEFAULT_MARGIN_SD = 0.5;

// The pre-calibration raw-cosine margin, kept for the uncentered fallback so a
// library below the baseline floor behaves exactly as it did before.
export const DEFAULT_MARGIN_RAW = 0.05;

export interface SelectOpts {
  max?: number;
  margin?: number;
}

// Pick the top moods from a raw {mood: cosine} map, centering per mood when
// usable baselines are supplied. Relative top-K, best first, capped — the same
// shape as before; the axis is what changed.
//
// `baselines` null/thin → raw selection on the original margin, byte-for-byte
// the pre-calibration behaviour. That is the honest degradation: a library
// with too few scored tracks has no distribution to center against.
export function selectAudioMoods(
  scores: Record<string, number>,
  baselines: MoodBaselines | null,
  { max = 3, margin }: SelectOpts = {},
): string[] {
  const centered = baselinesUsable(baselines) ? centeredScores(scores, baselines!) : null;
  const axis = centered ?? scores;
  const effectiveMargin = margin ?? (centered ? DEFAULT_MARGIN_SD : DEFAULT_MARGIN_RAW);

  const entries = Object.entries(axis).filter(([, v]) => Number.isFinite(v));
  if (entries.length === 0) return [];
  entries.sort((a, b) => b[1] - a[1]);
  const best = entries[0][1];
  return entries
    .filter(([, v]) => v >= best - effectiveMargin)
    .slice(0, Math.max(1, max))
    .map(([m]) => m);
}

// ---------------------------------------------------------------------------
// Audio-derived energy
// ---------------------------------------------------------------------------

// The mood vocabulary split into the two ends of an arousal axis. These are
// NAMES, which couples this to the shipped vocabulary (settings/vocab.ts
// MOOD_DEFAULTS) — and moods are operator-editable, so a renamed or deleted
// mood must not break the derivation. Hence the degradation in audioEnergy:
// whichever names are actually present are used, and a split too thin on
// either side yields null rather than a guess from one lopsided end.
export const HIGH_ENERGY_MOODS = [
  'energetic', 'workout', 'driving', 'celebratory', 'festival',
] as const;
export const LOW_ENERGY_MOODS = [
  'calm', 'reflective', 'spiritual', 'focus', 'night',
] as const;

// Minimum moods that must be present on EACH side for the axis to mean
// anything. Two of five is thin but still an average rather than a single
// prompt's idiosyncrasy.
const MIN_SIDE_MOODS = 2;

// How far the arousal diff must clear zero, in standard deviations, before the
// audio is allowed to overrule a propagated energy guess. Deliberately
// symmetric and deliberately NOT a three-way bucketing: see audioEnergy.
export const ENERGY_HIGH_Z = 0.35;
export const ENERGY_LOW_Z = -0.35;

// The raw arousal diff for a track: mean centered score of the high-energy
// moods minus mean centered score of the low-energy ones. Null when either
// side is too thin, or when the baselines can't support centering.
//
// Exported for the tuning/diagnostic surface — the bucketing below is what
// callers act on.
export function arousalDiff(
  scores: Record<string, number>,
  baselines: MoodBaselines | null,
): number | null {
  if (!baselinesUsable(baselines)) return null;
  const z = centeredScores(scores, baselines!);
  const side = (names: readonly string[]): number | null => {
    const vals = names.map((n) => z[n]).filter((v): v is number => Number.isFinite(v));
    if (vals.length < MIN_SIDE_MOODS) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  };
  const hi = side(HIGH_ENERGY_MOODS);
  const lo = side(LOW_ENERGY_MOODS);
  if (hi == null || lo == null) return null;
  return hi - lo;
}

// Audio-derived energy for a track, or null for "the audio does not say".
//
// Deliberately TWO-SIDED, not a three-way bucketing into low/medium/high. The
// caller (music/tag-library.ts) uses this to overrule an energy value that was
// itself propagated from neighbours — a guess. Bucketing the ambiguous middle
// into 'medium' would replace one guess with another guess and call the result
// evidence; returning null there leaves the existing value alone. So this only
// ever speaks when the audio is decisive, which also means a slightly
// mis-tuned threshold costs coverage rather than correctness.
export function audioEnergy(
  scores: Record<string, number>,
  baselines: MoodBaselines | null,
): 'low' | 'high' | null {
  const diff = arousalDiff(scores, baselines);
  if (diff == null) return null;
  if (diff >= ENERGY_HIGH_Z) return 'high';
  if (diff <= ENERGY_LOW_Z) return 'low';
  return null;
}

// ---------------------------------------------------------------------------
// Mood-state hash (vocabulary + calibration)
// ---------------------------------------------------------------------------

// audio_embedding_meta.mood_vocab_hash records what the stored labels were
// derived with. It now carries TWO independent things, joined by ':' —
// the vocabulary/prompt hash and the calibration version — because they
// invalidate different amounts of work:
//
//   vocabulary changed  → the cosines themselves are wrong  → full CLAP re-score
//   calibration changed → only the LABELS are stale         → re-derive from disk
//
// Folding the calibration version into the vocabulary hash instead would make
// every calibration change demand a working analyzer text tower, which most
// installs do not run (ANALYZER_HEAVY is opt-in). Composite string rather than
// a new column so this needs no schema migration.
export function composeMoodStateHash(vocabHash: string, version = CALIBRATION_VERSION): string {
  return `${vocabHash}:${version}`;
}

// The version a pass stamps when it could NOT calibrate — the library was under
// MIN_BASELINE_TRACKS and its labels came from the raw-cosine fallback.
//
// Deliberately 0, the same value a legacy bare hash parses as, because it means
// the same thing: these labels were picked on raw cosines and are due a
// re-derivation. Stamping the real CALIBRATION_VERSION here would tell the next
// pass the labels are current, so a station that started under the floor and
// then grew past it would keep its original tracks on raw selection forever —
// only tracks scored after the crossing would ever be calibrated.
export const UNCALIBRATED_VERSION = 0;

// The state hash to stamp for a pass, given whether it actually calibrated.
// The ONE place that decision is encoded — never call composeMoodStateHash
// directly from a pass, or the uncalibrated case silently stamps as done.
export function moodStateHashFor(vocabHash: string, calibrated: boolean): string {
  return composeMoodStateHash(
    vocabHash,
    calibrated ? CALIBRATION_VERSION : UNCALIBRATED_VERSION,
  );
}

export interface MoodState {
  vocabHash: string;
  version: number;
}

// Parse a stored mood-state hash. A legacy value (bare vocabulary hash, no
// ':') reads as version 0 — pre-calibration — which is exactly right: those
// labels were picked on raw cosines and are due a re-derivation.
export function parseMoodStateHash(stored: string | null): MoodState | null {
  if (!stored) return null;
  const idx = stored.lastIndexOf(':');
  if (idx === -1) return { vocabHash: stored, version: 0 };
  const version = Number(stored.slice(idx + 1));
  if (!Number.isInteger(version) || version < 0) return { vocabHash: stored, version: 0 };
  return { vocabHash: stored.slice(0, idx), version };
}

export type MoodPassAction = 'none' | 'relabel' | 'rescore';

// What a pass must do, given what is on disk and what the code now wants.
// Pure so the decision is testable without a database or an analyzer.
//
//   no stored state            → rescore (nothing has ever run)
//   vocabulary differs         → rescore (cosines are stale)
//   only the version differs   → relabel (cosines fine, labels stale)
//   both match                 → none (incremental scoring still runs above)
export function moodPassAction(stored: string | null, wantVocabHash: string): MoodPassAction {
  const prev = parseMoodStateHash(stored);
  if (!prev) return 'rescore';
  if (prev.vocabHash !== wantVocabHash) return 'rescore';
  if (prev.version !== CALIBRATION_VERSION) return 'relabel';
  return 'none';
}
