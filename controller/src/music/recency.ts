export const DEFAULT_TRACK_RECENCY_HOURS = 12;
export const DEFAULT_ARTIST_RECENCY_HOURS = 2;
const DIVERSE_LIBRARY_ARTISTS = 48;
const MIN_TRACK_RECENCY_HOURS = 1;
const MIN_ARTIST_RECENCY_HOURS = 0.25;

// Count-based hard no-repeat guard tuning (effectiveNoRepeatWindow below).
// Never hard-block more than this fraction of the tagged library, so even a
// configured window larger than the catalogue can support still leaves a fresh
// pool to pick from. And below MIN_EFFECTIVE distinct tracks the guard is both
// too weak to matter and too likely to starve a tiny library — so it switches
// off entirely and the relaxable time-window guard carries on alone.
const NO_REPEAT_MAX_LIBRARY_FRACTION = 0.375;
const NO_REPEAT_MIN_EFFECTIVE = 15;

export interface RecencyWindows {
  trackHours: number;
  artistHours: number;
}

export interface CandidateLike {
  id?: string | null;
  title?: string | null;
  artist?: string | null;
  // Track length. Subsonic songs carry `duration`; library-db rows carry
  // `durationSec`. Both optional — unknown length is never grounds to drop.
  duration?: number | null;
  durationSec?: number | null;
}

interface CandidateFilterState {
  recentIds?: Set<string>;
  recentKeys?: Set<string>;
  recentArtists?: Set<string>;
  // Count-based hard no-repeat guard (live-repeats fix). Checked OUTSIDE the
  // relaxation cascade's mode loop — like maxDurationSec, a track in here is
  // never an acceptable pick, so it survives every starvation stage. This is
  // what guarantees the last N distinct plays can't re-air even when the
  // relaxable recentIds/recentKeys guard below is dropped to keep the pool from
  // emptying. Populated from queue.recentlyPlayedByCount(N); empty = guard off.
  hardRecentIds?: Set<string>;
  hardRecentKeys?: Set<string>;
  seenIds?: Set<string>;
  artistCounts?: Map<string, number>;
  maxPerArtist?: number;
  cap?: number;
  // Whether a starved result may relax the recent-ARTIST guard. Default true
  // preserves the pool picker's "never return empty" behaviour. Only the pool
  // picker (music/picker.ts) passes recentArtists today, so this flag only bites
  // there; the agent's per-tool collect() no longer filters by artist at all
  // (#618 — an artist strip gutted the similarity tools to ~1 survivor on niche
  // catalogues), which is why it defaults true and is inert on that path.
  // Back-to-back artist variety on the AGENT path is instead enforced at the
  // point of choice: dj-agent.pickViaAgent re-picks from other-artist
  // candidates when a pick would repeat the on-air artist (#1124), escalating
  // to a blockedArtists pool call when its own run surfaced none (#1187).
  allowArtistRelaxation?: boolean;
  // Artists that may NEVER be returned, whatever the starvation cascade does —
  // checked outside the mode loop like hardRecentIds. Distinct from
  // recentArtists, which is a preference the cascade drops rather than return
  // nothing. #1187: the agent path's artist guard asks the pool for a pick that
  // ISN'T the on-air artist; a pool that never-starves back to that same artist
  // would answer the question it was called to avoid. Empty on every pick that
  // doesn't go through that rescue, so the ordinary pool is untouched. Keys are
  // artistRootKey()-normalised (lowercased, trimmed, collapsed onto the lead
  // artist) and are matched against a candidate's raw AND lead key, so blocking
  // an artist also blocks the collaborations they front.
  blockedArtists?: Set<string>;
}

// Track length in seconds from whichever field the source carries, or null when
// unknown. Zero/negative/non-finite all read as unknown — we only ever act on a
// positive, trustworthy duration (the hour-long album mixes #447 targets report
// one reliably).
export function durationSeconds(song: CandidateLike): number | null {
  const d = song?.duration ?? song?.durationSec;
  return Number.isFinite(d) && (d as number) > 0 ? Number(d) : null;
}

export function artistKey(song: CandidateLike): string {
  return (song.artist || '').toLowerCase().trim();
}

// A "featuring" marker — always a credit on someone else's track, never part of
// an artist's own name. `(feat.` / `[ft` shapes included: Subsonic servers hand
// the credit back inside the artist string as often as bare.
const FEATURE_SPLIT = /\s*[([]?\s*\b(?:feat|ft|featuring)\b\.?\s+/i;
// A join between two credited acts. Deliberately NOT "with" or "x" — "Sleeping
// with Sirens" and "Chase x Status"-style names would lose their tail.
const JOIN_SPLIT = /\s+(?:&|\+|and)\s+/i;

// The LEAD artist of a credit — `artistKey` collapsed onto its primary act, so
// a collaboration shares a key with the artist who leads it (#1251):
//
//   "Marvin Gaye & Tammi Terrell"  → "marvin gaye"
//   "Kanye West (feat. Jay-Z)"     → "kanye west"
//   "Sly & the Family Stone"       → "sly & the family stone"   (unchanged)
//
// The `the …` exception on the join keeps band names whole: "X & the Y" is one
// act, not two credits, and stripping it would key half the Motown and soul
// bench onto a first name. Everything else after a join is a second credited act
// — imperfect on "Hall & Oates"-shaped duos (keyed "hall"), but a wrong key here
// can only over-match, and every caller reads an over-match as "pick someone
// else", never as a hard drop.
//
// Only the LEAD is normalised, so "Tammi Terrell" and "Marvin Gaye & Tammi
// Terrell" still key apart. Matching every credited act would need the same
// name-vs-credit judgement on the tail that the exception exists to dodge, and
// the guard's job is the artist a listener just heard fronting a track.
//
// NOT a replacement for `artistKey`, which is an IDENTITY key feeding
// `trackKey` and must stay byte-identical to the `title|artist` keys
// queue.recentlyPlayed builds from raw tag text. This is a MATCHING key.
export function artistRootKey(song: CandidateLike | string): string {
  const raw = typeof song === 'string' ? song : (song?.artist || '');
  const base = raw.toLowerCase().trim();
  if (!base) return '';

  let root = base;
  const featAt = root.search(FEATURE_SPLIT);
  if (featAt > 0) root = root.slice(0, featAt).trim();

  const join = JOIN_SPLIT.exec(root);
  if (join && join.index > 0) {
    const tail = root.slice(join.index + join[0].length).trim();
    if (tail && !/^the\b/.test(tail)) root = root.slice(0, join.index).trim();
  }

  return root || base;
}

export function trackKey(song: CandidateLike): string {
  return `${(song.title || '').toLowerCase().trim()}|${artistKey(song)}`;
}

// Large-library boost on the relaxable windows. The 12h/2h defaults were tuned
// for small-to-mid libraries; at radio pace (~300-400 plays/day) 12h blocks
// ~150-200 tracks, which on a 10k-50k catalogue is under 2% — far too little
// memory to push selection anywhere new. Keys on TRACK COUNT, never distinct
// artists (a 500-track library easily clears any artist threshold, and
// doubling its window would over-block it): stepped, so the window only grows
// where the catalogue can absorb it — even the largest step blocks under ~5%
// of the library at that pace. The count guard (noRepeatWindow) is the
// non-relaxable long-memory companion; this stays the relaxable short one.
function librarySizeBoost(totalTracks: number): number {
  if (totalTracks >= 20000) return 3;   // 36h track / 6h artist
  if (totalTracks >= 8000) return 2;    // 24h / 4h
  if (totalTracks >= 3000) return 1.5;  // 18h / 3h
  return 1;
}

export function recencyWindowsForLibrary(
  distinctArtists: number | null | undefined,
  totalTracks: number | null | undefined = 0,
): RecencyWindows {
  const boost = librarySizeBoost(Math.floor(Number(totalTracks) || 0));
  if (!distinctArtists || distinctArtists <= 0) {
    return {
      trackHours: DEFAULT_TRACK_RECENCY_HOURS * boost,
      artistHours: DEFAULT_ARTIST_RECENCY_HOURS * boost,
    };
  }

  const scale = Math.min(1, Math.max(distinctArtists / DIVERSE_LIBRARY_ARTISTS, 1 / 12)) * boost;
  const roundToQuarterHour = (hours: number) => Math.round(hours * 4) / 4;

  return {
    trackHours: Math.max(
      MIN_TRACK_RECENCY_HOURS,
      roundToQuarterHour(DEFAULT_TRACK_RECENCY_HOURS * scale),
    ),
    artistHours: Math.max(
      MIN_ARTIST_RECENCY_HOURS,
      roundToQuarterHour(DEFAULT_ARTIST_RECENCY_HOURS * scale),
    ),
  };
}

// Clamp a configured count-based no-repeat window to what the tagged library
// can safely support. Pure + unit-pinned (picker-recency-regression.test.ts).
//   - configuredN <= 0, or an unknown/empty library  → 0 (guard self-disables)
//   - never block more than NO_REPEAT_MAX_LIBRARY_FRACTION of the library
//   - if the result would be below NO_REPEAT_MIN_EFFECTIVE              → 0
// Examples: (100,1000)→100, (100,40)→15, (100,20)→0, (0,*)→0, (100,null)→0.
export function effectiveNoRepeatWindow(
  configuredN: number | null | undefined,
  libraryTotal: number | null | undefined,
): number {
  const n = Math.floor(Number(configuredN) || 0);
  const total = Math.floor(Number(libraryTotal) || 0);
  if (n <= 0 || total <= 0) return 0;
  const ceiling = Math.floor(total * NO_REPEAT_MAX_LIBRARY_FRACTION);
  const eff = Math.min(n, ceiling);
  return eff < NO_REPEAT_MIN_EFFECTIVE ? 0 : eff;
}

export function filterPickerCandidates<T extends CandidateLike>(
  list: T[],
  {
    recentIds = new Set<string>(),
    recentKeys = new Set<string>(),
    recentArtists = new Set<string>(),
    hardRecentIds = new Set<string>(),
    hardRecentKeys = new Set<string>(),
    seenIds = new Set<string>(),
    artistCounts = new Map<string, number>(),
    maxPerArtist = Infinity,
    cap = Infinity,
    allowArtistRelaxation = true,
    blockedArtists = new Set<string>(),
  }: CandidateFilterState = {},
): T[] {
  // Track length is NOT a selection criterion: max-track-length (issue #447) is
  // enforced as an on-air cue_out cut, so an over-length track stays eligible
  // and simply crossfades out at the cap. Filtering it here would only starve
  // the pool — e.g. a 60s cap leaving nothing but short skits/interludes.
  const pool = list || [];

  // Relaxation cascade: each mode drops a guard so a starved pool still yields
  // something rather than nothing. When artist relaxation is disabled the artist
  // guard stays ON in every mode — only the track guard may drop, and only for
  // fresh artists — so the agent is never handed an artist it just played.
  const modes = allowArtistRelaxation
    ? [
        { recentTracks: true, recentArtists: true },
        { recentTracks: true, recentArtists: false },
        { recentTracks: false, recentArtists: false },
      ]
    : [
        { recentTracks: true, recentArtists: true },
        { recentTracks: false, recentArtists: true },
      ];

  for (const mode of modes) {
    const nextSeen = new Set(seenIds);
    const nextArtistCounts = new Map(artistCounts);
    const out: T[] = [];

    for (const song of pool) {
      if (!song?.id || nextSeen.has(song.id)) continue;
      // Hard no-repeat guard — NO mode gate, so it holds through every
      // relaxation stage. A track in the last-N-distinct set never airs, even
      // when the cascade has dropped the relaxable track guard below to avoid an
      // empty pool. (effectiveNoRepeatWindow keeps this set well under the
      // library size so this can't starve the pool to nothing.)
      if (hardRecentIds.has(song.id)) continue;
      if (hardRecentKeys.has(trackKey(song))) continue;
      if (mode.recentTracks && recentIds.has(song.id)) continue;
      if (mode.recentTracks && recentKeys.has(trackKey(song))) continue;

      const key = artistKey(song);
      // Hard artist block — no mode gate, so it survives every relaxation stage
      // (#1187). An empty set (every caller but the artist-guard rescue) makes
      // this a no-op. Matched on BOTH the raw key and the lead-artist key
      // (#1251): the rescue is called to avoid the artist on air, and
      // "Marvin Gaye & Tammi Terrell" answering a block on "Marvin Gaye" is the
      // repeat it was called to prevent.
      if (key && (blockedArtists.has(key) || blockedArtists.has(artistRootKey(song)))) continue;
      if (mode.recentArtists && key && recentArtists.has(key)) continue;
      if (key) {
        const count = nextArtistCounts.get(key) || 0;
        if (count >= maxPerArtist) continue;
        nextArtistCounts.set(key, count + 1);
      }

      nextSeen.add(song.id);
      out.push(song);
      if (out.length >= cap) break;
    }

    if (out.length === 0) continue;

    for (const id of nextSeen) seenIds.add(id);
    artistCounts.clear();
    for (const [key, count] of nextArtistCounts) artistCounts.set(key, count);
    return out;
  }

  return [];
}
